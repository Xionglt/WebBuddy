import type { ModelConfig } from './config.js'

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
  /** Hard timeout for the HTTP call. */
  timeoutMs?: number
  /** Tools available for the model to call. */
  tools?: ToolSchema[]
  /** 'auto' | 'none' | {type:'function',...}; default 'auto' when tools given. */
  toolChoice?: 'auto' | 'none'
  /** Cap the number of output tokens. */
  maxTokens?: number
}

export interface ChatCompletion {
  content: string
  toolCalls: ToolCall[]
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
  constructor(private readonly model: ModelConfig) {}

  get hasKey(): boolean {
    return Boolean(this.model.apiKey?.trim())
  }

  get label(): string {
    return `${this.model.name} @ ${this.model.baseUrl}`
  }

  /** Shared request — returns the raw assistant message payload. */
  private async request(messages: ChatMessage[], options: ChatOptions): Promise<{
    content: string | null
    toolCalls: ToolCall[]
  }> {
    if (!this.hasKey) throw new LlmError('No MODEL_API_KEY configured.', 'NO_KEY')

    const url = `${this.model.baseUrl.replace(/\/$/, '')}/chat/completions`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 45000)

    const body: Record<string, unknown> = {
      model: this.model.name,
      messages,
      temperature: options.temperature ?? 0.2,
    }
    if (options.jsonMode) body.response_format = { type: 'json_object' }
    if (options.tools?.length) {
      body.tools = options.tools
      body.tool_choice = options.toolChoice ?? 'auto'
    }
    if (options.maxTokens) body.max_tokens = options.maxTokens

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
        throw new LlmError(`HTTP ${res.status} from ${this.model.name}: ${text.slice(0, 300)}`, 'HTTP')
      }

      const json = (await res.json()) as {
        choices?: Array<{
          message?: {
            content?: string | null
            tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>
          }
        }>
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
      return { content, toolCalls }
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
    const { content, toolCalls } = await this.request(messages, options)
    return { content: content ?? '', toolCalls }
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
