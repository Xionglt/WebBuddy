import type { ModelConfig } from './config.js'
import { getActiveTrace } from '../agent-trace/index.js'
import {
  accumulatePromptCacheSnapshot,
  anthropicCacheControl,
  applyOpenAiPromptCacheFields,
  emptyPromptCacheSnapshot,
  normalizeAnthropicPromptCacheUsage,
  normalizeOpenAiPromptCacheUsage,
  resolvePromptCacheCapability,
  type AnthropicUsagePayload,
  type OpenAiUsagePayload,
  type PromptCacheCapability,
  type PromptCacheSnapshot,
  type PromptCacheUsage,
} from './prompt-cache.js'

/**
 * Thin OpenAI-compatible chat client. Works with any endpoint that implements
 * `POST {baseUrl}/chat/completions` (OpenAI, Azure OpenAI, many local routers,
 * Venus/GLM, Ollama's openai shim, etc.). The user supplies the base URL +
 * model name + key via MODEL_BASE_URL / MODEL_NAME / MODEL_API_KEY.
 *
 * Supports both plain chat and function/tool-calling — the tool-calling path
 * is what powers the generic agent loop (LLM picks browser tools itself).
 */

export interface ToolCall {
  id: string
  /** Tool/function name. */
  name: string
  /** Parsed arguments object. */
  arguments: Record<string, unknown>
}

/** OpenAI-style message; assistant messages may carry tool_calls, tool messages carry tool_call_id. */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  /** Internal cache boundary metadata. Stripped from provider wire payloads. */
  cacheBoundary?: 'compaction_checkpoint'
  /** Present on assistant messages that requested tool calls. */
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>
  /** Present on tool-role messages (the result of a tool call). */
  tool_call_id?: string
  name?: string
}

export interface ToolSchema {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

export interface ChatOptions {
  /** Request JSON output (response_format=json_object). */
  jsonMode?: boolean
  temperature?: number
  /** Redact messages and model text in trace spans for sensitive inputs. */
  redactTrace?: boolean
  /** Hard timeout for the HTTP call. */
  timeoutMs?: number
  /** Tools available for the model to call. */
  tools?: ToolSchema[]
  /** 'auto' | 'none' | {type:'function',...}; default 'auto' when tools given. */
  toolChoice?: 'auto' | 'none'
  /** Cap the number of output tokens. */
  maxTokens?: number
  /** Stream provider deltas so time-to-first-token can be measured. */
  stream?: boolean
  /** Disable request-side prompt caching for one-off calls such as semantic compaction. */
  promptCache?: boolean
  /** Independent cache metrics bucket. */
  promptCacheNamespace?: string
  /** Stable, privacy-safe routing key for providers that support it. */
  promptCacheKey?: string
}

export interface ChatCompletion {
  content: string
  toolCalls: ToolCall[]
  usage?: PromptCacheUsage
}

export class LlmError extends Error {
  constructor(
    message: string,
    readonly code: 'NO_KEY' | 'HTTP' | 'PARSE' | 'EMPTY',
  ) {
    super(message)
    this.name = 'LlmError'
  }
}

export class LlmGateway {
  private readonly promptCacheCapability: PromptCacheCapability
  private readonly promptCacheSnapshots = new Map<string, PromptCacheSnapshot>()

  constructor(private readonly model: ModelConfig) {
    this.promptCacheCapability = resolvePromptCacheCapability(model)
  }

  get hasKey(): boolean {
    return Boolean(this.model.apiKey?.trim() || this.model.authToken?.trim())
  }

  get label(): string {
    return `${this.model.name} @ ${this.model.baseUrl} (${this.model.provider})`
  }

  getPromptCacheSnapshot(namespace = 'default'): PromptCacheSnapshot {
    return this.promptCacheSnapshots.get(namespace)
      ?? emptyPromptCacheSnapshot(this.promptCacheCapability, namespace)
  }

  /** Shared request — routes to the OpenAI or Anthropic wire format. */
  private async request(messages: ChatMessage[], options: ChatOptions): Promise<{
    content: string | null
    toolCalls: ToolCall[]
    usage: PromptCacheUsage
  }> {
    const trace = getActiveTrace()
    const span = trace?.startSpan({
      spanType: 'llm_call',
      name: 'llm.chat',
      input: {
        messages: options.redactTrace ? redactChatMessages(messages) : messages,
        options: traceChatOptions(options),
      },
      metadata: {
        provider: this.model.provider,
        model: this.model.name,
        baseUrl: this.model.baseUrl,
      },
    })
    try {
      if (!this.hasKey) throw new LlmError('No model key configured.', 'NO_KEY')
      const result = this.model.provider === 'anthropic'
        ? await this.requestAnthropic(messages, options)
        : await this.requestOpenai(messages, options)
      const namespace = options.promptCacheNamespace ?? 'default'
      this.promptCacheSnapshots.set(
        namespace,
        accumulatePromptCacheSnapshot(
          this.promptCacheSnapshots.get(namespace),
          effectivePromptCacheCapability(this.promptCacheCapability, options),
          result.usage,
        ),
      )
      span?.end({
        status: 'success',
        output: {
          content: options.redactTrace ? '[redacted sensitive model output]' : result.content,
          toolCalls: options.redactTrace ? redactToolCalls(result.toolCalls) : result.toolCalls,
          usage: result.usage,
        },
      })
      return result
    } catch (error) {
      span?.end({
        status: 'failed',
        errorCode: error instanceof LlmError ? error.code : 'UNKNOWN',
        errorMessage: error instanceof Error ? error.message : String(error),
      })
      throw error
    }
  }

  /** OpenAI-compatible /chat/completions. */
  private async requestOpenai(messages: ChatMessage[], options: ChatOptions): Promise<{
    content: string | null
    toolCalls: ToolCall[]
    usage: PromptCacheUsage
  }> {
    const url = `${this.model.baseUrl.replace(/\/$/, '')}/chat/completions`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 45000)

    const body: Record<string, unknown> = {
      model: this.model.name,
      messages: messages.map(stripInternalMessageMetadata),
      temperature: options.temperature ?? 0.2,
      ...(this.model.extraBody ?? {}),
    }
    if (options.jsonMode) body.response_format = { type: 'json_object' }
    if (options.tools?.length) {
      body.tools = options.tools
      body.tool_choice = options.toolChoice ?? 'auto'
    }
    if (options.maxTokens) body.max_tokens = options.maxTokens
    if (options.stream) {
      body.stream = true
      body.stream_options = { include_usage: true }
    }
    const capability = effectivePromptCacheCapability(this.promptCacheCapability, options)
    applyOpenAiPromptCacheFields(body, {
      capability,
      ...(options.promptCacheKey ? { promptCacheKey: options.promptCacheKey } : {}),
    })
    const requestStartedAt = new Date()

    try {
      const res = await fetch(url, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.model.apiKey}`,
        },
        body: JSON.stringify(body),
      })

      if (!res.ok) {
        const text = await res.text().catch(() => '')
        if (options.stream && canRetryWithoutStreaming(res.status)) {
          return await this.requestOpenai(messages, { ...options, stream: false })
        }
        throw new LlmError(`HTTP ${res.status} from ${this.model.name}: ${text.slice(0, 300)}`, 'HTTP')
      }

      if (options.stream && isEventStreamResponse(res)) {
        return await readOpenAiStream({
          response: res,
          capability,
          namespace: options.promptCacheNamespace ?? 'default',
          requestStartedAt,
        })
      }

      const json = (await res.json()) as {
        choices?: Array<{
          message?: {
            content?: string | null
            tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>
          }
        }>
        usage?: OpenAiUsagePayload
      }
      const msg = json.choices?.[0]?.message
      const content = msg?.content ?? null
      const toolCalls: ToolCall[] = []
      for (const tc of msg?.tool_calls ?? []) {
        let args: Record<string, unknown> = {}
        try {
          args = tc.function.arguments ? JSON.parse(tc.function.arguments) : {}
        } catch {
          args = { _raw: tc.function.arguments }
        }
        toolCalls.push({ id: tc.id, name: tc.function.name, arguments: args })
      }
      return {
        content,
        toolCalls,
        usage: normalizeOpenAiPromptCacheUsage({
          usage: json.usage,
          capability,
          namespace: options.promptCacheNamespace ?? 'default',
          requestStartedAt,
          completedAt: new Date(),
        }),
      }
    } catch (error) {
      if (error instanceof LlmError) throw error
      throw new LlmError(`Request failed: ${(error as Error).message}`, 'HTTP')
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Anthropic Messages API (/v1/messages). Translates our OpenAI-style
   * ChatMessage[] + ToolSchema[] to/from Anthropic's format. Used by Zhipu GLM
   * (open.bigmodel.cn/api/anthropic) and real Anthropic.
   */
  private async requestAnthropic(messages: ChatMessage[], options: ChatOptions): Promise<{
    content: string | null
    toolCalls: ToolCall[]
    usage: PromptCacheUsage
  }> {
    const url = `${this.model.baseUrl.replace(/\/$/, '')}/v1/messages`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 45000)

    const system = messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .filter(Boolean)
      .join('\n\n')
    const capability = effectivePromptCacheCapability(this.promptCacheCapability, options)
    const cacheControl = anthropicCacheControl(capability)

    // Convert to Anthropic messages. Tool results (role:'tool') must be wrapped
    // in a user message as {type:'tool_result'}. Consecutive tool results are
    // grouped into one user message.
    const converted: Array<Record<string, unknown>> = []
    let compactionCheckpointIndex: number | undefined
    let i = 0
    while (i < messages.length) {
      const m = messages[i]
      if (m.role === 'system') { i += 1; continue }
      if (m.role === 'tool') {
        const results: unknown[] = []
        while (i < messages.length && messages[i].role === 'tool') {
          results.push({
            type: 'tool_result',
            tool_use_id: messages[i].tool_call_id,
            content: messages[i].content,
          })
          i += 1
        }
        converted.push({ role: 'user', content: results })
        continue
      }
      if (m.role === 'assistant' && m.tool_calls?.length) {
        const blocks: unknown[] = []
        if (m.content) blocks.push({ type: 'text', text: m.content })
        for (const tc of m.tool_calls) {
          let input: unknown = {}
          try { input = tc.function.arguments ? JSON.parse(tc.function.arguments) : {} } catch { input = {} }
          blocks.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input })
        }
        converted.push({ role: 'assistant', content: blocks })
      } else {
        converted.push({ role: m.role, content: m.content })
      }
      if (m.cacheBoundary === 'compaction_checkpoint') {
        compactionCheckpointIndex = converted.length - 1
      }
      i += 1
    }

    const body: Record<string, unknown> = {
      model: this.model.name,
      max_tokens: options.maxTokens ?? 1024,
      messages: converted,
      temperature: options.temperature ?? 0.2,
    }
    if (system) {
      body.system = cacheControl
        ? [{ type: 'text', text: system, cache_control: cacheControl }]
        : system
    }
    if (options.tools?.length) {
      body.tools = options.tools.map((t) => ({
        name: t.function.name,
        description: t.function.description,
        input_schema: t.function.parameters,
      }))
      if (cacheControl) {
        const tools = body.tools as Array<Record<string, unknown>>
        tools[tools.length - 1] = { ...tools[tools.length - 1], cache_control: cacheControl }
      }
      body.tool_choice = options.toolChoice === 'none' ? { type: 'none' } : { type: 'auto' }
    }
    if (cacheControl) {
      if (compactionCheckpointIndex !== undefined) {
        markAnthropicMessageCacheableAt(converted, compactionCheckpointIndex, cacheControl)
      }
      markLastAnthropicMessageCacheable(converted, cacheControl)
    }
    if (options.stream) body.stream = true
    const requestStartedAt = new Date()

    try {
      const res = await fetch(url, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.model.authToken || this.model.apiKey || '',
          'anthropic-version': this.model.anthropicVersion || '2023-06-01',
        },
        body: JSON.stringify(body),
      })

      if (!res.ok) {
        const text = await res.text().catch(() => '')
        if (options.stream && canRetryWithoutStreaming(res.status)) {
          return await this.requestAnthropic(messages, { ...options, stream: false })
        }
        throw new LlmError(`HTTP ${res.status} from ${this.model.name}: ${text.slice(0, 300)}`, 'HTTP')
      }

      if (options.stream && isEventStreamResponse(res)) {
        return await readAnthropicStream({
          response: res,
          capability,
          namespace: options.promptCacheNamespace ?? 'default',
          requestStartedAt,
        })
      }

      const json = (await res.json()) as {
        content?: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>
        stop_reason?: string
        usage?: AnthropicUsagePayload
      }
      let text = ''
      const toolCalls: ToolCall[] = []
      for (const block of json.content ?? []) {
        if (block.type === 'text' && block.text) text += block.text
        if (block.type === 'tool_use' && block.name) {
          toolCalls.push({
            id: block.id || `call_${toolCalls.length}`,
            name: block.name,
            arguments: (block.input as Record<string, unknown>) ?? {},
          })
        }
      }
      return {
        content: text || null,
        toolCalls,
        usage: normalizeAnthropicPromptCacheUsage({
          usage: json.usage,
          capability,
          namespace: options.promptCacheNamespace ?? 'default',
          requestStartedAt,
          completedAt: new Date(),
        }),
      }
    } catch (error) {
      if (error instanceof LlmError) throw error
      throw new LlmError(`Request failed: ${(error as Error).message}`, 'HTTP')
    } finally {
      clearTimeout(timer)
    }
  }

  /** Plain chat completion. Returns the assistant text. */
  async chat(messages: ChatMessage[], options: ChatOptions = {}): Promise<string> {
    const { content } = await this.request(messages, options)
    if (!content) throw new LlmError('Empty completion (no content).', 'EMPTY')
    return content
  }

  /** Chat with tools. Returns content + any tool calls the model requested. */
  async chatWithTools(messages: ChatMessage[], options: ChatOptions = {}): Promise<ChatCompletion> {
    const { content, toolCalls, usage } = await this.request(messages, options)
    return { content: content ?? '', toolCalls, usage }
  }

  /**
   * Ask the model for a JSON object. Uses json_mode when the endpoint supports
   * it, and otherwise extracts the first {...} block from the reply. Returns
   * null (never throws) so callers can fall back to heuristics.
   */
  async generateJson<T = unknown>(
    system: string,
    user: string,
    options: ChatOptions = {},
  ): Promise<T | null> {
    let content: string
    try {
      content = await this.chat(
        [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        { jsonMode: true, temperature: 0, ...options },
      )
    } catch (error) {
      if (error instanceof LlmError && error.code === 'NO_KEY') throw error
      return null
    }

    try {
      return JSON.parse(content) as T
    } catch {
      const match = content.match(/\{[\s\S]*\}/)
      if (!match) return null
      try {
        return JSON.parse(match[0]) as T
      } catch {
        return null
      }
    }
  }

  /** Free-form short answer. Returns '' on failure. */
  async ask(system: string, user: string, options: ChatOptions = {}): Promise<string> {
    try {
      return await this.chat(
        [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        { temperature: 0.2, ...options },
      )
    } catch {
      return ''
    }
  }
}

function traceChatOptions(options: ChatOptions): Record<string, unknown> {
  return {
    jsonMode: options.jsonMode,
    temperature: options.temperature,
    timeoutMs: options.timeoutMs,
    toolChoice: options.toolChoice,
    maxTokens: options.maxTokens,
    stream: options.stream,
    promptCache: options.promptCache,
    promptCacheNamespace: options.promptCacheNamespace,
    promptCacheKeyConfigured: Boolean(options.promptCacheKey),
    redactTrace: options.redactTrace,
    tools: options.tools?.map((tool) => ({
      name: tool.function.name,
      description: tool.function.description,
      parameters: tool.function.parameters,
    })),
  }
}

async function readOpenAiStream(input: {
  response: Response
  capability: PromptCacheCapability
  namespace: string
  requestStartedAt: Date
}): Promise<{ content: string | null; toolCalls: ToolCall[]; usage: PromptCacheUsage }> {
  let content = ''
  let firstTokenAt: Date | undefined
  let usagePayload: OpenAiUsagePayload | undefined
  const toolCallsByIndex = new Map<number, {
    id: string
    name: string
    arguments: string
  }>()

  await forEachSseData(input.response, (data) => {
    if (data === '[DONE]') return
    const event = parseJsonRecord(data)
    if (!event) return
    if (isRecord(event.error)) {
      throw new LlmError(streamErrorMessage(event.error), 'HTTP')
    }
    if (isRecord(event.usage)) usagePayload = event.usage as OpenAiUsagePayload
    const choices = Array.isArray(event.choices) ? event.choices : []
    for (const choice of choices) {
      if (!isRecord(choice) || !isRecord(choice.delta)) continue
      const delta = choice.delta
      if (typeof delta.content === 'string' && delta.content) {
        firstTokenAt ??= new Date()
        content += delta.content
      }
      const toolDeltas = Array.isArray(delta.tool_calls) ? delta.tool_calls : []
      for (const rawToolDelta of toolDeltas) {
        if (!isRecord(rawToolDelta)) continue
        const index = nonNegativeInteger(rawToolDelta.index, toolCallsByIndex.size)
        const current = toolCallsByIndex.get(index) ?? {
          id: '',
          name: '',
          arguments: '',
        }
        if (typeof rawToolDelta.id === 'string' && rawToolDelta.id) current.id = rawToolDelta.id
        if (isRecord(rawToolDelta.function)) {
          if (typeof rawToolDelta.function.name === 'string') current.name += rawToolDelta.function.name
          if (typeof rawToolDelta.function.arguments === 'string') {
            current.arguments += rawToolDelta.function.arguments
          }
        }
        if (current.id || current.name || current.arguments) firstTokenAt ??= new Date()
        toolCallsByIndex.set(index, current)
      }
    }
  })

  const completedAt = new Date()
  const toolCalls = [...toolCallsByIndex.entries()]
    .sort(([left], [right]) => left - right)
    .map(([index, toolCall]) => ({
      id: toolCall.id || `call_${index}`,
      name: toolCall.name,
      arguments: parseToolArguments(toolCall.arguments),
    }))

  return {
    content: content || null,
    toolCalls,
    usage: normalizeOpenAiPromptCacheUsage({
      usage: usagePayload,
      capability: input.capability,
      namespace: input.namespace,
      requestStartedAt: input.requestStartedAt,
      firstTokenAt,
      completedAt,
    }),
  }
}

async function readAnthropicStream(input: {
  response: Response
  capability: PromptCacheCapability
  namespace: string
  requestStartedAt: Date
}): Promise<{ content: string | null; toolCalls: ToolCall[]; usage: PromptCacheUsage }> {
  let firstTokenAt: Date | undefined
  let usagePayload: AnthropicUsagePayload = {}
  const blocks = new Map<number, {
    type: string
    text: string
    id: string
    name: string
    partialJson: string
    input?: Record<string, unknown>
  }>()

  await forEachSseData(input.response, (data) => {
    const event = parseJsonRecord(data)
    if (!event) return
    if (event.type === 'error' && isRecord(event.error)) {
      throw new LlmError(streamErrorMessage(event.error), 'HTTP')
    }

    if (event.type === 'message_start' && isRecord(event.message) && isRecord(event.message.usage)) {
      usagePayload = mergeAnthropicUsage(usagePayload, event.message.usage)
      return
    }
    if (event.type === 'message_delta' && isRecord(event.usage)) {
      usagePayload = mergeAnthropicUsage(usagePayload, event.usage)
      return
    }

    const index = nonNegativeInteger(event.index, -1)
    if (index < 0) return
    if (event.type === 'content_block_start' && isRecord(event.content_block)) {
      const contentBlock = event.content_block
      const block = {
        type: typeof contentBlock.type === 'string' ? contentBlock.type : 'unknown',
        text: typeof contentBlock.text === 'string' ? contentBlock.text : '',
        id: typeof contentBlock.id === 'string' ? contentBlock.id : '',
        name: typeof contentBlock.name === 'string' ? contentBlock.name : '',
        partialJson: '',
        ...(isRecord(contentBlock.input)
          ? { input: contentBlock.input as Record<string, unknown> }
          : {}),
      }
      if (block.text || block.id || block.name) firstTokenAt ??= new Date()
      blocks.set(index, block)
      return
    }
    if (event.type !== 'content_block_delta' || !isRecord(event.delta)) return
    const block = blocks.get(index) ?? {
      type: 'unknown',
      text: '',
      id: '',
      name: '',
      partialJson: '',
    }
    if (typeof event.delta.text === 'string' && event.delta.text) {
      block.text += event.delta.text
      firstTokenAt ??= new Date()
    }
    if (typeof event.delta.partial_json === 'string' && event.delta.partial_json) {
      block.partialJson += event.delta.partial_json
      firstTokenAt ??= new Date()
    }
    blocks.set(index, block)
  })

  const orderedBlocks = [...blocks.entries()].sort(([left], [right]) => left - right)
  const content = orderedBlocks
    .filter(([, block]) => block.type === 'text')
    .map(([, block]) => block.text)
    .join('')
  const toolCalls = orderedBlocks
    .filter(([, block]) => block.type === 'tool_use')
    .map(([index, block]) => ({
      id: block.id || `call_${index}`,
      name: block.name,
      arguments: block.partialJson ? parseToolArguments(block.partialJson) : (block.input ?? {}),
    }))
  const completedAt = new Date()

  return {
    content: content || null,
    toolCalls,
    usage: normalizeAnthropicPromptCacheUsage({
      usage: usagePayload,
      capability: input.capability,
      namespace: input.namespace,
      requestStartedAt: input.requestStartedAt,
      firstTokenAt,
      completedAt,
    }),
  }
}

async function forEachSseData(
  response: Response,
  visit: (data: string) => void,
): Promise<void> {
  if (!response.body) throw new LlmError('Streaming response had no body.', 'PARSE')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    buffer = consumeSseEvents(buffer, visit)
  }
  buffer += decoder.decode()
  consumeSseEvents(`${buffer}\n\n`, visit)
}

function consumeSseEvents(buffer: string, visit: (data: string) => void): string {
  let remaining = buffer
  while (true) {
    const boundary = /\r?\n\r?\n/.exec(remaining)
    if (!boundary || boundary.index === undefined) return remaining
    const rawEvent = remaining.slice(0, boundary.index)
    remaining = remaining.slice(boundary.index + boundary[0].length)
    const data = rawEvent
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n')
    if (data) visit(data)
  }
}

function isEventStreamResponse(response: Response): boolean {
  return response.headers.get('content-type')?.toLowerCase().includes('text/event-stream') ?? false
}

function canRetryWithoutStreaming(status: number): boolean {
  return status === 400 || status === 404 || status === 415 || status === 422
}

function parseJsonRecord(value: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(value)
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function parseToolArguments(value: string): Record<string, unknown> {
  if (!value) return {}
  try {
    const parsed = JSON.parse(value)
    return isRecord(parsed) ? parsed : { _value: parsed }
  } catch {
    return { _raw: value }
  }
}

function streamErrorMessage(error: Record<string, unknown>): string {
  return typeof error.message === 'string' && error.message
    ? `Streaming provider error: ${error.message}`
    : 'Streaming provider returned an error event.'
}

function mergeAnthropicUsage(
  current: AnthropicUsagePayload,
  next: Record<string, unknown>,
): AnthropicUsagePayload {
  return {
    input_tokens: numericValue(next.input_tokens, current.input_tokens),
    output_tokens: numericValue(next.output_tokens, current.output_tokens),
    cache_read_input_tokens: numericValue(
      next.cache_read_input_tokens,
      current.cache_read_input_tokens,
    ),
    cache_creation_input_tokens: numericValue(
      next.cache_creation_input_tokens,
      current.cache_creation_input_tokens,
    ),
  }
}

function numericValue(value: unknown, fallback: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function nonNegativeInteger(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : fallback
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function effectivePromptCacheCapability(
  capability: PromptCacheCapability,
  options: ChatOptions,
): PromptCacheCapability {
  if (options.promptCache !== false) return capability
  return {
    ...capability,
    requestMode: 'disabled',
    requestEnabled: false,
    ttlSource: 'unknown',
  }
}

function markLastAnthropicMessageCacheable(
  messages: Array<Record<string, unknown>>,
  cacheControl: Record<string, unknown>,
): void {
  markAnthropicMessageCacheableAt(messages, messages.length - 1, cacheControl)
}

function markAnthropicMessageCacheableAt(
  messages: Array<Record<string, unknown>>,
  index: number,
  cacheControl: Record<string, unknown>,
): void {
  const message = messages[index]
  if (!message) return
  const content = message.content
  if (typeof content === 'string') {
    message.content = [{ type: 'text', text: content, cache_control: cacheControl }]
    return
  }
  if (!Array.isArray(content) || content.length === 0) return
  const lastIndex = content.length - 1
  const last = content[lastIndex]
  if (!last || typeof last !== 'object' || Array.isArray(last)) return
  content[lastIndex] = {
    ...(last as Record<string, unknown>),
    cache_control: cacheControl,
  }
}

function stripInternalMessageMetadata(message: ChatMessage): Omit<ChatMessage, 'cacheBoundary'> {
  const { cacheBoundary: _, ...wireMessage } = message
  return wireMessage
}

function redactChatMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((message) => ({
    ...message,
    content: message.content ? '[redacted sensitive message]' : message.content,
    tool_calls: message.tool_calls?.map((call) => ({
      ...call,
      function: {
        ...call.function,
        arguments: call.function.arguments ? '[redacted sensitive tool arguments]' : call.function.arguments,
      },
    })),
  }))
}

function redactToolCalls(toolCalls: ToolCall[]): ToolCall[] {
  return toolCalls.map((call) => ({
    id: call.id,
    name: call.name,
    arguments: call.arguments && Object.keys(call.arguments).length
      ? { _redacted: true }
      : {},
  }))
}
