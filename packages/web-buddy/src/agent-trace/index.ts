import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

export type AgentTraceStatus = 'running' | 'success' | 'failed' | 'cancelled'
export type AgentSpanStatus = 'success' | 'failed' | 'skipped'
export type AgentRedactionMode = 'redacted' | 'full' | 'off'

export type AgentSpanType =
  | 'llm_call'
  | 'tool_call'
  | 'mcp_tool_call'
  | 'skill_call'
  | 'agent_step'
  | 'runtime_event'
  | 'screenshot'
  | 'gate'

export interface TracePayload {
  kind: 'undefined' | 'null' | 'text' | 'json'
  value?: unknown
  truncated?: boolean
  originalBytes?: number
  sha256?: string
}

export interface AgentTraceSessionOptions {
  sessionId?: string
  runId?: string
  outDir?: string
  source: string
  scenario?: string
  profile?: string
  cwd?: string
  branch?: string
  commit?: string
  model?: string
  provider?: string
  userPrompt?: unknown
  finalAnswer?: unknown
  redactionMode?: AgentRedactionMode
  metadata?: Record<string, unknown>
  appendOnly?: boolean
}

export interface StartSpanInput {
  spanType: AgentSpanType
  name: string
  parentSpanId?: string
  toolName?: string
  skillName?: string
  agentName?: string
  toolCategory?: string
  operation?: string
  input?: unknown
  metadata?: Record<string, unknown>
}

export interface EndSpanInput {
  status: AgentSpanStatus
  output?: unknown
  errorCode?: string
  errorMessage?: string
  metadata?: Record<string, unknown>
}

interface TraceSessionFile {
  schemaVersion: 'agent-trace/v1'
  sessionId: string
  runId?: string
  source: string
  scenario?: string
  profile?: string
  cwd: string
  branch?: string
  commit?: string
  model?: string
  provider?: string
  status: AgentTraceStatus
  startedAt: string
  endedAt?: string
  userPrompt?: TracePayload
  finalAnswer?: TracePayload
  redactionMode: AgentRedactionMode
  metadata?: TracePayload
  totals: {
    spans: number
    llmCalls: number
    toolCalls: number
    mcpToolCalls: number
    skillCalls: number
    screenshots: number
  }
}

interface TraceSpanFile {
  schemaVersion: 'agent-trace/v1'
  sessionId: string
  spanId: string
  parentSpanId?: string
  spanType: AgentSpanType
  name: string
  toolName?: string
  skillName?: string
  agentName?: string
  toolCategory?: string
  operation?: string
  input?: TracePayload
  output?: TracePayload
  metadata?: TracePayload
  status: AgentSpanStatus
  errorCode?: string
  errorMessage?: string
  startedAt: string
  endedAt: string
  latencyMs: number
}

interface ActiveTraceContext {
  trace: AgentTraceSession
  spanStack: string[]
}

const DEFAULT_PAYLOAD_BYTES = 64 * 1024
const DEFAULT_STRING_BYTES = 16 * 1024
const MAX_DEPTH = 8
const MAX_ARRAY_ITEMS = 80
const SECRET_KEY_RE = /(api[_-]?key|auth|authorization|bearer|cookie|password|secret|token|storage[_-]?state)/i
const PATH_KEY_RE = /(file|path|resume|storageStatePath)$/i

const context = new AsyncLocalStorage<ActiveTraceContext>()
let globalTrace: AgentTraceSession | undefined
let processTrace: AgentTraceSession | undefined

export class AgentTraceSession {
  readonly sessionId: string
  readonly runId?: string
  readonly dir: string
  readonly redactionMode: AgentRedactionMode

  private readonly sessionFile: string
  private readonly spansFile: string
  private readonly eventsFile: string
  private readonly artifactsDir: string
  private readonly startedAt = new Date().toISOString()
  private finalized = false
  private readonly appendOnly: boolean
  private spanCount = 0
  private llmCalls = 0
  private toolCalls = 0
  private mcpToolCalls = 0
  private skillCalls = 0
  private screenshots = 0
  private session: TraceSessionFile

  constructor(options: AgentTraceSessionOptions) {
    this.sessionId = sanitizeId(options.sessionId || `sess_${randomUUID()}`)
    this.runId = options.runId
    this.redactionMode = options.redactionMode ?? readRedactionMode()
    const outDir = resolve(options.outDir || process.env.AGENT_TRACE_OUT_DIR || join(process.cwd(), 'output', 'traces'))
    this.dir = join(outDir, this.sessionId)
    this.sessionFile = join(this.dir, 'session.json')
    this.spansFile = join(this.dir, 'spans.jsonl')
    this.eventsFile = join(this.dir, 'events.jsonl')
    this.artifactsDir = join(this.dir, 'artifacts')
    this.appendOnly = Boolean(options.appendOnly)

    mkdirSync(this.artifactsDir, { recursive: true })
    this.session = {
      schemaVersion: 'agent-trace/v1',
      sessionId: this.sessionId,
      runId: this.runId,
      source: options.source,
      scenario: options.scenario,
      profile: options.profile,
      cwd: options.cwd || process.cwd(),
      branch: options.branch,
      commit: options.commit,
      model: options.model,
      provider: options.provider,
      status: 'running',
      startedAt: this.startedAt,
      userPrompt: payload(options.userPrompt, this.redactionMode),
      finalAnswer: payload(options.finalAnswer, this.redactionMode),
      redactionMode: this.redactionMode,
      metadata: payload(options.metadata, this.redactionMode),
      totals: {
        spans: 0,
        llmCalls: 0,
        toolCalls: 0,
        mcpToolCalls: 0,
        skillCalls: 0,
        screenshots: 0,
      },
    }
    if (!this.appendOnly) this.writeSession()
    this.recordEvent(this.appendOnly ? 'session_attach' : 'session_start', {
      source: options.source,
      runId: this.runId,
      dir: this.dir,
    })
  }

  startSpan(input: StartSpanInput): TraceSpanHandle {
    const spanType = input.spanType
    if (spanType === 'llm_call') this.llmCalls += 1
    if (spanType === 'tool_call') this.toolCalls += 1
    if (spanType === 'mcp_tool_call') this.mcpToolCalls += 1
    if (spanType === 'skill_call') this.skillCalls += 1
    if (spanType === 'screenshot') this.screenshots += 1

    return new TraceSpanHandle(this, {
      schemaVersion: 'agent-trace/v1',
      sessionId: this.sessionId,
      spanId: `span_${randomUUID()}`,
      parentSpanId: input.parentSpanId || currentSpanId(),
      spanType,
      name: input.name,
      toolName: input.toolName,
      skillName: input.skillName,
      agentName: input.agentName,
      toolCategory: input.toolCategory,
      operation: input.operation,
      input: payload(input.input, this.redactionMode),
      metadata: payload(input.metadata, this.redactionMode),
      status: 'success',
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      latencyMs: 0,
    })
  }

  withSpan<T>(span: TraceSpanHandle, fn: () => T): T {
    const current = context.getStore()
    const next: ActiveTraceContext = {
      trace: this,
      spanStack: [...(current?.spanStack ?? []), span.spanId],
    }
    return context.run(next, fn)
  }

  recordEvent(event: string, data?: unknown): void {
    safe(() => {
      appendFileSync(
        this.eventsFile,
        `${JSON.stringify({
          schemaVersion: 'agent-trace/v1',
          sessionId: this.sessionId,
          ts: new Date().toISOString(),
          event,
          data: payload(data, this.redactionMode),
        })}\n`,
      )
    })
  }

  writeArtifact(name: string, content: string | Buffer): string {
    const safeName = name.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-|-$/g, '') || 'artifact'
    const file = join(this.artifactsDir, safeName)
    safe(() => writeFileSync(file, content))
    return file
  }

  finalize(input: { status: AgentTraceStatus; finalAnswer?: unknown; metadata?: Record<string, unknown> }): void {
    if (this.finalized) return
    this.finalized = true
    this.session.status = input.status
    this.session.endedAt = new Date().toISOString()
    if (input.finalAnswer !== undefined) this.session.finalAnswer = payload(input.finalAnswer, this.redactionMode)
    if (input.metadata) {
      this.session.metadata = payload({ existing: this.session.metadata, final: input.metadata }, this.redactionMode)
    }
    this.syncTotals()
    this.writeSession()
    this.recordEvent('session_end', { status: input.status, metadata: input.metadata })
    safe(() => {
      const fd = openSync(join(this.dir, 'DONE'), 'w')
      closeSync(fd)
    })
  }

  appendSpan(span: TraceSpanFile): void {
    this.spanCount += 1
    this.syncTotals()
    safe(() => appendFileSync(this.spansFile, `${JSON.stringify(span)}\n`))
    if (!this.appendOnly) this.writeSession()
  }

  private syncTotals(): void {
    this.session.totals = {
      spans: this.spanCount,
      llmCalls: this.llmCalls,
      toolCalls: this.toolCalls,
      mcpToolCalls: this.mcpToolCalls,
      skillCalls: this.skillCalls,
      screenshots: this.screenshots,
    }
  }

  private writeSession(): void {
    if (this.appendOnly) return
    safe(() => writeFileSync(this.sessionFile, JSON.stringify(this.session, null, 2)))
  }
}

export class TraceSpanHandle {
  readonly spanId: string
  private ended = false
  private readonly startedAtMs = Date.now()

  constructor(
    private readonly trace: AgentTraceSession,
    private readonly span: TraceSpanFile,
  ) {
    this.spanId = span.spanId
  }

  end(input: EndSpanInput): void {
    if (this.ended) return
    this.ended = true
    const endedAt = new Date().toISOString()
    const finalSpan: TraceSpanFile = {
      ...this.span,
      output: payload(input.output, this.trace.redactionMode),
      metadata: input.metadata ? payload({ start: this.span.metadata, end: input.metadata }, this.trace.redactionMode) : this.span.metadata,
      status: input.status,
      errorCode: input.errorCode,
      errorMessage: input.errorMessage,
      endedAt,
      latencyMs: Date.now() - this.startedAtMs,
    }
    this.trace.appendSpan(finalSpan)
  }
}

export function createAgentTraceSession(options: AgentTraceSessionOptions): AgentTraceSession | undefined {
  if ((options.redactionMode ?? readRedactionMode()) === 'off') return undefined
  try {
    const trace = new AgentTraceSession(options)
    setActiveTrace(trace)
    return trace
  } catch {
    return undefined
  }
}

export function setActiveTrace(trace: AgentTraceSession | undefined): void {
  globalTrace = trace
}

export function getActiveTrace(): AgentTraceSession | undefined {
  return context.getStore()?.trace ?? globalTrace
}

export function getOrCreateProcessTrace(source: string): AgentTraceSession | undefined {
  if (processTrace) return processTrace
  if (readRedactionMode() === 'off') return undefined
  if (!process.env.AGENT_TRACE_SESSION_ID && process.env.AGENT_TRACE_ENABLED !== '1') return undefined
  const outDir = process.env.AGENT_TRACE_OUT_DIR || join(process.cwd(), 'output', 'traces')
  const sessionId = sanitizeId(process.env.AGENT_TRACE_SESSION_ID || `sess_${randomUUID()}`)
  const appendOnly = existsSync(join(resolve(outDir), sessionId, 'session.json'))
  processTrace = createAgentTraceSession({
    sessionId,
    runId: process.env.AGENT_TRACE_RUN_ID,
    outDir,
    source,
    scenario: process.env.AGENT_TRACE_SCENARIO,
    profile: process.env.AGENT_TRACE_PROFILE,
    model: process.env.AGENT_TRACE_MODEL,
    provider: process.env.AGENT_TRACE_PROVIDER,
    metadata: {
      pid: process.pid,
      argv: process.argv,
    },
    appendOnly,
  })
  return processTrace
}

function currentSpanId(): string | undefined {
  const stack = context.getStore()?.spanStack
  return stack?.[stack.length - 1]
}

function payload(value: unknown, mode: AgentRedactionMode): TracePayload | undefined {
  if (value === undefined) return undefined
  if (mode === 'off') return undefined
  if (value === null) return { kind: 'null', value: null }
  const redacted = mode === 'full' ? value : redactValue(value, 0, new WeakSet<object>())
  const kind = typeof redacted === 'string' ? 'text' : 'json'
  const serialized: string = kind === 'text' ? String(redacted) : safeJson(redacted)
  const bytes = Buffer.byteLength(serialized)
  const hash = createHash('sha256').update(serialized).digest('hex')
  if (bytes <= DEFAULT_PAYLOAD_BYTES) return { kind, value: redacted, originalBytes: bytes, sha256: hash }
  return {
    kind: 'text',
    value: truncateBytes(serialized, DEFAULT_PAYLOAD_BYTES),
    truncated: true,
    originalBytes: bytes,
    sha256: hash,
  }
}

function redactValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined) return value
  if (typeof value === 'string') return truncateString(redactText(value))
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'bigint') return String(value)
  if (typeof value === 'function') return '[function]'
  if (typeof value !== 'object') return String(value)
  if (seen.has(value)) return '[circular]'
  if (depth >= MAX_DEPTH) return '[max-depth]'
  seen.add(value)

  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY_ITEMS).map((item) => redactValue(item, depth + 1, seen))
    if (value.length > MAX_ARRAY_ITEMS) items.push(`[+${value.length - MAX_ARRAY_ITEMS} items]`)
    return items
  }

  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEY_RE.test(key)) {
      out[key] = '[redacted]'
      continue
    }
    if (PATH_KEY_RE.test(key) && typeof item === 'string') {
      out[key] = `[path:redacted]/${basename(item)}`
      continue
    }
    out[key] = redactValue(item, depth + 1, seen)
  }
  return out
}

function redactText(text: string): string {
  return text
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/([A-Za-z0-9._%+-]+)@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g, '[email:redacted]')
    .replace(/\b1[3-9]\d{9}\b/g, '[phone:redacted]')
    .replace(/(api[_-]?key|token|authorization|password|secret)(["':=\s]+)([^"'\s,}]+)/gi, '$1$2[redacted]')
}

function truncateString(text: string): string {
  return Buffer.byteLength(text) <= DEFAULT_STRING_BYTES ? text : truncateBytes(text, DEFAULT_STRING_BYTES)
}

function truncateBytes(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text)
  if (bytes.length <= maxBytes) return text
  const marker = `...<truncated ${bytes.length - maxBytes} bytes>`
  const keep = Math.max(0, maxBytes - Buffer.byteLength(marker))
  return `${bytes.subarray(0, keep).toString('utf8')}${marker}`
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return JSON.stringify(String(value))
  }
}

function sanitizeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120) || `sess_${randomUUID()}`
}

function readRedactionMode(): AgentRedactionMode {
  const raw = (process.env.AGENT_TRACE_MODE || 'redacted').toLowerCase()
  if (raw === 'full' || raw === 'off') return raw
  return 'redacted'
}

function safe(fn: () => void): void {
  try {
    fn()
  } catch {
    // Trace must never break the agent path.
  }
}
