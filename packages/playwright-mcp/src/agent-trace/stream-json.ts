import type { AgentSpanType, AgentTraceSession, TraceSpanHandle } from './index.js'

export interface StreamJsonTraceSummary {
  lines: number
  jsonEvents: number
  skippedLines: number
  assistantMessages: number
  userMessages: number
  toolUses: number
  toolResults: number
  orphanToolResults: number
  resultMessages: number
  systemEvents: number
  pendingToolUses: number
  parseErrors: number
}

interface StreamTraceOptions {
  passIndex: number
  parentSpanId?: string
}

interface PendingToolSpan {
  span: TraceSpanHandle
  toolName: string
}

const SUMMARY_EVENT_TYPES = new Set([
  'system',
  'result',
  'tool_progress',
  'tool_use_summary',
  'auth_status',
  'rate_limit_event',
])

export function recordStreamJsonTrace(
  trace: AgentTraceSession | undefined,
  stdout: string,
  options: StreamTraceOptions,
): StreamJsonTraceSummary {
  const summary: StreamJsonTraceSummary = {
    lines: 0,
    jsonEvents: 0,
    skippedLines: 0,
    assistantMessages: 0,
    userMessages: 0,
    toolUses: 0,
    toolResults: 0,
    orphanToolResults: 0,
    resultMessages: 0,
    systemEvents: 0,
    pendingToolUses: 0,
    parseErrors: 0,
  }

  const pending = new Map<string, PendingToolSpan>()
  const lines = stdout.split(/\r?\n/)
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim()
    if (!line) continue
    summary.lines += 1
    const event = parseJsonObject(line)
    if (!event) {
      summary.skippedLines += 1
      continue
    }
    summary.jsonEvents += 1
    try {
      recordEvent(trace, event, {
        ...options,
        lineNumber: i + 1,
        pending,
        summary,
      })
    } catch (error) {
      summary.parseErrors += 1
      trace?.recordEvent('stream_json_parse_error', {
        passIndex: options.passIndex,
        lineNumber: i + 1,
        message: error instanceof Error ? error.message : String(error),
        event,
      })
    }
  }

  for (const [toolUseId, pendingSpan] of pending) {
    pendingSpan.span.end({
      status: 'skipped',
      errorCode: 'MISSING_TOOL_RESULT',
      errorMessage: `No matching tool_result found for ${toolUseId}.`,
    })
  }
  summary.pendingToolUses = pending.size
  return summary
}

function recordEvent(
  trace: AgentTraceSession | undefined,
  event: Record<string, unknown>,
  ctx: StreamTraceOptions & {
    lineNumber: number
    pending: Map<string, PendingToolSpan>
    summary: StreamJsonTraceSummary
  },
): void {
  const eventType = stringField(event, 'type')
  if (!eventType) return

  if (eventType === 'assistant') {
    recordAssistant(trace, event, ctx)
    return
  }
  if (eventType === 'user') {
    recordUser(trace, event, ctx)
    return
  }
  if (eventType === 'result') {
    ctx.summary.resultMessages += 1
    recordRuntimeSpan(trace, 'stream.result', event, ctx)
    return
  }

  if (SUMMARY_EVENT_TYPES.has(eventType)) {
    if (eventType === 'system') ctx.summary.systemEvents += 1
    recordRuntimeSpan(trace, `stream.${eventType}`, event, ctx)
  }
}

function recordAssistant(
  trace: AgentTraceSession | undefined,
  event: Record<string, unknown>,
  ctx: StreamTraceOptions & {
    lineNumber: number
    pending: Map<string, PendingToolSpan>
    summary: StreamJsonTraceSummary
  },
): void {
  ctx.summary.assistantMessages += 1
  const message = recordField(event, 'message')
  const blocks = contentBlocks(message)
  const text = textFromBlocks(blocks)
  const toolUseBlocks = blocks
    .map((block) => recordFromUnknown(block))
    .filter((block): block is Record<string, unknown> => stringField(block, 'type') === 'tool_use')

  const llmSpan = trace?.startSpan({
    spanType: 'llm_call',
    name: 'stream.assistant',
    parentSpanId: ctx.parentSpanId,
    input: undefined,
    metadata: {
      passIndex: ctx.passIndex,
      lineNumber: ctx.lineNumber,
      uuid: stringField(event, 'uuid'),
      sessionId: stringField(event, 'session_id'),
      parentToolUseId: nullableStringField(event, 'parent_tool_use_id'),
      stopReason: stringField(message, 'stop_reason'),
      model: stringField(message, 'model'),
      usage: recordField(message, 'usage'),
      error: stringField(event, 'error'),
    },
  })
  llmSpan?.end({
    status: stringField(event, 'error') ? 'failed' : 'success',
    output: {
      text,
      toolUses: toolUseBlocks.map((block) => ({
        id: stringField(block, 'id'),
        name: stringField(block, 'name'),
        input: block.input,
      })),
      message: jsonClone(message),
    },
  })

  for (const block of toolUseBlocks) {
    const toolUseId = stringField(block, 'id')
    const toolName = stringField(block, 'name') || 'unknown_tool'
    if (!toolUseId) continue
    const input = block.input
    const spanType = classifyToolSpan(toolName)
    const span = trace?.startSpan({
      spanType,
      name: toolName,
      toolName,
      skillName: spanType === 'skill_call' ? inferSkillName(input) : undefined,
      parentSpanId: ctx.parentSpanId,
      input,
      metadata: {
        passIndex: ctx.passIndex,
        lineNumber: ctx.lineNumber,
        toolUseId,
        assistantUuid: stringField(event, 'uuid'),
        parentToolUseId: nullableStringField(event, 'parent_tool_use_id'),
      },
    })
    ctx.summary.toolUses += 1
    if (span) ctx.pending.set(toolUseId, { span, toolName })
  }
}

function recordUser(
  trace: AgentTraceSession | undefined,
  event: Record<string, unknown>,
  ctx: StreamTraceOptions & {
    lineNumber: number
    pending: Map<string, PendingToolSpan>
    summary: StreamJsonTraceSummary
  },
): void {
  ctx.summary.userMessages += 1
  const message = recordField(event, 'message')
  const blocks = contentBlocks(message)
  for (const block of blocks) {
    const item = recordFromUnknown(block)
    if (!item || stringField(item, 'type') !== 'tool_result') continue
    const toolUseId = stringField(item, 'tool_use_id')
    if (!toolUseId) continue
    ctx.summary.toolResults += 1
    const status = item.is_error === true ? 'failed' : 'success'
    const output = {
      content: item.content,
      isError: item.is_error,
      toolUseResult: event.tool_use_result,
      userMessageUuid: stringField(event, 'uuid'),
      parentToolUseId: nullableStringField(event, 'parent_tool_use_id'),
    }
    const pending = ctx.pending.get(toolUseId)
    if (pending) {
      pending.span.end({
        status,
        output,
        errorMessage: status === 'failed' ? contentToString(item.content) : undefined,
      })
      ctx.pending.delete(toolUseId)
    } else {
      ctx.summary.orphanToolResults += 1
      const orphan = trace?.startSpan({
        spanType: 'tool_call',
        name: 'stream.orphan_tool_result',
        parentSpanId: ctx.parentSpanId,
        input: { toolUseId },
        metadata: {
          passIndex: ctx.passIndex,
          lineNumber: ctx.lineNumber,
          userMessageUuid: stringField(event, 'uuid'),
        },
      })
      orphan?.end({ status, output })
    }
  }
}

function recordRuntimeSpan(
  trace: AgentTraceSession | undefined,
  name: string,
  event: Record<string, unknown>,
  ctx: StreamTraceOptions & { lineNumber: number },
): void {
  const span = trace?.startSpan({
    spanType: 'runtime_event',
    name,
    parentSpanId: ctx.parentSpanId,
    input: {
      type: stringField(event, 'type'),
      subtype: stringField(event, 'subtype'),
    },
    metadata: {
      passIndex: ctx.passIndex,
      lineNumber: ctx.lineNumber,
      uuid: stringField(event, 'uuid'),
      sessionId: stringField(event, 'session_id'),
    },
  })
  span?.end({
    status: event.is_error === true ? 'failed' : 'success',
    output: event,
  })
}

function parseJsonObject(line: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(line)
    return recordFromUnknown(parsed)
  } catch {
    return undefined
  }
}

function recordFromUnknown(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function recordField(record: Record<string, unknown> | undefined, key: string): Record<string, unknown> | undefined {
  return recordFromUnknown(record?.[key])
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key]
  return typeof value === 'string' ? value : undefined
}

function nullableStringField(record: Record<string, unknown> | undefined, key: string): string | null | undefined {
  const value = record?.[key]
  if (value === null) return null
  return typeof value === 'string' ? value : undefined
}

function contentBlocks(message: Record<string, unknown> | undefined): unknown[] {
  const content = message?.content
  return Array.isArray(content) ? content : []
}

function textFromBlocks(blocks: unknown[]): string {
  const parts: string[] = []
  for (const block of blocks) {
    const item = recordFromUnknown(block)
    if (!item) continue
    if (item.type === 'text' && typeof item.text === 'string') parts.push(item.text)
    if (item.type === 'thinking' && typeof item.thinking === 'string') parts.push(item.thinking)
  }
  return parts.join('\n')
}

function contentToString(content: unknown): string {
  if (typeof content === 'string') return content
  try {
    return JSON.stringify(content)
  } catch {
    return String(content)
  }
}

function jsonClone(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value))
  } catch {
    return value
  }
}

function classifyToolSpan(toolName: string): AgentSpanType {
  const lower = toolName.toLowerCase()
  if (lower === 'skill' || lower.includes('use_skill') || lower.includes('skill')) return 'skill_call'
  if (lower.startsWith('mcp__')) return 'mcp_tool_call'
  return 'tool_call'
}

function inferSkillName(input: unknown): string | undefined {
  const record = recordFromUnknown(input)
  if (!record) return undefined
  return (
    stringField(record, 'skillName') ||
    stringField(record, 'skill_name') ||
    stringField(record, 'skill') ||
    stringField(record, 'name')
  )
}
