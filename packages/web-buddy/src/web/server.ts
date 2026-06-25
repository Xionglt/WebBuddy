/**
 * job-agent web UI server. A small dependency-free HTTP server that wraps the
 * agent orchestrator and streams live events to a browser dashboard over SSE.
 *
 *   GET  /                      → dashboard (index.html)
 *   GET  /api/config            → current model config (key masked)
 *   POST /api/config            → set provider/base/model/key at runtime
 *   POST /api/run               → {mode, startUrl, resumePath?, headless?} → {runId}
 *   GET  /api/events?id=runId   → SSE stream of AgentEvent + final result
 *   GET  /api/trace?id=runId    → {steps:[...], summary}
 *   GET  /api/shot?id=runId&n=N → serve screenshot N as PNG
 *   POST /api/resume            → upload a resume (octet-stream) → {path}
 *   POST /api/stop?id=runId     → best-effort stop (closes the browser)
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { spawn, type ChildProcess } from 'node:child_process'
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, extname, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig, type AgentConfig, type ModelConfig } from '../sdk/config.js'
import { runJobApplicationAgent, type AgentEvent, type AgentRunResult } from '../sdk/orchestrator.js'
import { sessionManager } from '../session/manager.js'
import { defaultAuthPath } from '../runtime/local/login.js'
import INDEX_HTML from './public/index.html'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..')
const PACKAGE_ROOT = join(REPO_ROOT, 'packages', 'web-buddy')
function outputDir(): string {
  return resolve(loadConfig().trace.outDir)
}

interface RunState {
  id: string
  events: AgentEvent[]
  subscribers: Set<ServerResponse>
  result: AgentRunResult | null
  done: boolean
}
const runs = new Map<string, RunState>()

interface RuntimeEvent {
  ts: string
  level: 'info' | 'think' | 'act' | 'observe' | 'gate' | 'warn' | 'error' | 'done'
  phase: string
  message: string
  data?: unknown
}

interface RuntimeRunState {
  id: string
  events: RuntimeEvent[]
  subscribers: Set<ServerResponse>
  child: ChildProcess | null
  done: boolean
  exitCode?: number | null
  signal?: NodeJS.Signals | null
  runDir?: string
  traceDir?: string
  continueFile: string
  handoffWaiting: boolean
  stdoutBuffer: string
  stderrBuffer: string
}
const runtimeRuns = new Map<string, RuntimeRunState>()

// Runtime model override applied on top of loadConfig() for each run.
let modelOverride: Partial<ModelConfig> = {}

function mergeConfig(base: AgentConfig): AgentConfig {
  return { ...base, model: { ...base.model, ...modelOverride } as ModelConfig }
}

function allowStartUrl(config: AgentConfig, startUrl?: string): void {
  if (!startUrl) return
  try {
    const host = new URL(startUrl).hostname.toLowerCase()
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1') {
      config.browser.blockLocalhost = false
    }
    if (host && !config.browser.allowedDomains.includes(host)) {
      config.browser.allowedDomains = [...config.browser.allowedDomains, host]
    }
  } catch {
    // The orchestrator will report the invalid URL later.
  }
}

function resumeExtension(req: IncomingMessage): '.pdf' | '.json' | '.txt' {
  const header = Array.isArray(req.headers['x-file-name'])
    ? req.headers['x-file-name'][0]
    : req.headers['x-file-name']
  const ext = extname(header || '').toLowerCase()
  return ext === '.json' || ext === '.txt' || ext === '.pdf' ? ext : '.pdf'
}

function send(res: ServerResponse, status: number, body: unknown) {
  const json = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(json)
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolveFn, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => resolveFn(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function readJsonl(file: string, limit: number): unknown[] {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .slice(-limit)
    .map((line) => {
      try { return JSON.parse(line) } catch { return null }
    })
    .filter((item) => item !== null)
}

function readJsonFile(file: string): unknown | null {
  if (!file || !existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/** Push an event to a run's buffer + all live SSE subscribers. */
function emitRun(run: RunState, event: AgentEvent) {
  run.events.push(event)
  for (const sub of run.subscribers) {
    sub.write(`data: ${JSON.stringify(event)}\n\n`)
  }
}

function emitRuntime(run: RuntimeRunState, event: Omit<RuntimeEvent, 'ts'>) {
  const full = { ts: new Date().toISOString(), ...event }
  run.events.push(full)
  for (const sub of run.subscribers) {
    sub.write(`data: ${JSON.stringify(full)}\n\n`)
  }
}

function endRuntime(run: RuntimeRunState, exitCode?: number | null, signal?: NodeJS.Signals | null) {
  run.done = true
  run.exitCode = exitCode
  run.signal = signal
  const terminal = {
    _end: true,
    exitCode,
    signal,
    runDir: run.runDir,
    traceDir: run.traceDir,
    status: exitCode === 0 ? 'done' : 'failed',
  }
  for (const sub of run.subscribers) {
    sub.write(`data: ${JSON.stringify(terminal)}\n\n`)
    sub.end()
  }
  run.subscribers.clear()
}

function endRun(run: RunState, result: AgentRunResult | null, error?: string) {
  run.result = result
  run.done = true
  const terminal = JSON.stringify({ _end: true, error, finalState: result?.finalState, message: result?.message, summary: result?.summary })
  for (const sub of run.subscribers) {
    sub.write(`data: ${terminal}\n\n`)
    sub.end()
  }
  run.subscribers.clear()
}

async function startRun(opts: { mode: string; startUrl?: string; resumePath?: string; headless?: boolean }) {
  const id = `web-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`
  const run: RunState = { id, events: [], subscribers: new Set(), result: null, done: false }
  runs.set(id, run)

  const base = loadConfig()
  const config = mergeConfig(base)
  config.human.mode = 'auto' // web runs use the auto gate (UI shows hand-offs)
  allowStartUrl(config, opts.startUrl)
  if (opts.headless !== undefined) {
    config.browser.headless = opts.headless
    config.browser.visualHighlight = !opts.headless
  }
  if (opts.resumePath) config.resumePath = opts.resumePath

  // Don't await — stream events as they come.
  runJobApplicationAgent({
    config,
    mode: opts.mode as AgentRunResult['mode'],
    startUrl: opts.startUrl,
    runId: id,
    source: 'web-ui',
    profile: 'debug',
    onEvent: (e) => emitRun(run, e),
  })
    .then((result) => endRun(run, result))
    .catch((error) => endRun(run, null, String(error)))
    .finally(() => sessionManager.closeAll().catch(() => {}))

  return id
}

async function startRuntimeRun(opts: {
  preset?: string
  url: string
  prompt: string
  resumePath?: string
  headless?: boolean
  maxTurns?: string
  maxPasses?: string
  allowedDomains?: string
  profile?: string
}) {
  const id = `runtime-${new Date().toISOString().replace(/[:.]/g, '-')}`
  const controlDir = join(outputDir(), 'web-runtime', id)
  mkdirSync(controlDir, { recursive: true })
  const continueFile = join(controlDir, 'continue.signal')
  const run: RuntimeRunState = {
    id,
    events: [],
    subscribers: new Set(),
    child: null,
    done: false,
    continueFile,
    handoffWaiting: false,
    stdoutBuffer: '',
    stderrBuffer: '',
  }
  runtimeRuns.set(id, run)

  const preset = opts.preset || 'generic'
  const script = join(PACKAGE_ROOT, 'scripts', 'adapters', 'claude-code', 'alibaba-apply.mjs')
  const args = [
    script,
    '--stream-json',
    '--preset', preset,
    '--url', opts.url,
    '--prompt', opts.prompt,
    '--run-id', id,
    '--profile', opts.profile || 'debug',
    '--handoff-mode', 'file',
    '--continue-file', continueFile,
    '--max-blocked-handoffs', '3',
  ]
  if (opts.resumePath) args.push('--resume', opts.resumePath)
  else args.push('--no-resume')
  if (opts.headless) args.push('--headless')
  else args.push('--headful')
  if (opts.maxTurns) args.push('--max-turns', opts.maxTurns)
  if (opts.maxPasses) args.push('--max-passes', opts.maxPasses)
  if (opts.allowedDomains) args.push('--allowed-domains', opts.allowedDomains)

  const cfg = mergeConfig(loadConfig())
  const env = { ...process.env }
  if (cfg.model.name) env.ANTHROPIC_MODEL = cfg.model.name
  if (cfg.model.baseUrl) env.ANTHROPIC_BASE_URL = cfg.model.baseUrl
  const key = cfg.model.authToken || cfg.model.apiKey
  if (key) {
    env.ANTHROPIC_AUTH_TOKEN = key
    env.ANTHROPIC_API_KEY = key
  }

  emitRuntime(run, {
    level: 'info',
    phase: 'boot',
    message: `Starting ${preset} web agent for ${opts.url}`,
    data: { args: args.map((arg) => (arg === key ? '[redacted]' : arg)) },
  })

  const child = spawn(process.execPath, args, {
    cwd: REPO_ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  })
  run.child = child

  child.stdout.on('data', (chunk) => {
    run.stdoutBuffer = consumeRuntimeLines(run, `${run.stdoutBuffer}${chunk.toString('utf8')}`, 'stdout')
  })
  child.stderr.on('data', (chunk) => {
    run.stderrBuffer = consumeRuntimeLines(run, `${run.stderrBuffer}${chunk.toString('utf8')}`, 'stderr')
  })
  child.on('error', (error) => {
    emitRuntime(run, { level: 'error', phase: 'spawn', message: error.message })
  })
  child.on('close', (code, signal) => {
    if (run.stdoutBuffer.trim()) handleRuntimeLine(run, run.stdoutBuffer.trim(), 'stdout')
    if (run.stderrBuffer.trim()) handleRuntimeLine(run, run.stderrBuffer.trim(), 'stderr')
    emitRuntime(run, {
      level: code === 0 ? 'done' : 'error',
      phase: 'exit',
      message: signal ? `Runtime stopped by ${signal}` : `Runtime exited with code ${code ?? 0}`,
      data: { code, signal },
    })
    endRuntime(run, code, signal)
  })

  return id
}

function consumeRuntimeLines(run: RuntimeRunState, text: string, stream: 'stdout' | 'stderr'): string {
  const lines = text.split(/\r?\n/)
  const rest = lines.pop() ?? ''
  for (const line of lines) handleRuntimeLine(run, line, stream)
  return rest
}

function handleRuntimeLine(run: RuntimeRunState, line: string, stream: 'stdout' | 'stderr') {
  const trimmed = line.trim()
  if (!trimmed) return

  if (trimmed.startsWith('Claude runtime run directory:')) {
    run.runDir = trimmed.replace('Claude runtime run directory:', '').trim()
  } else if (trimmed.startsWith('Agent trace:')) {
    run.traceDir = trimmed.replace('Agent trace:', '').trim()
  } else if (trimmed.startsWith('WEB_HANDOFF_WAITING ')) {
    run.handoffWaiting = true
    const json = trimmed.slice('WEB_HANDOFF_WAITING '.length)
    emitRuntime(run, {
      level: 'gate',
      phase: 'handoff',
      message: 'Human action required. Complete login/captcha in the opened browser, then click Continue.',
      data: safeJson(json),
    })
    return
  }

  const parsed = safeJson(trimmed)
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const event = runtimeEventFromStreamJson(parsed as Record<string, unknown>)
    if (event) emitRuntime(run, event)
    return
  }

  emitRuntime(run, {
    level: stream === 'stderr' ? 'warn' : 'info',
    phase: stream,
    message: trimmed,
  })
}

function runtimeEventFromStreamJson(event: Record<string, unknown>): Omit<RuntimeEvent, 'ts'> | null {
  const type = typeof event.type === 'string' ? event.type : ''
  if (type === 'assistant') {
    const message = recordField(event, 'message')
    const blocks = Array.isArray(message?.content) ? message.content : []
    const text = blocks.map(blockText).filter(Boolean).join('\n')
    const tools = blocks.map(recordFromUnknown).filter((b) => b?.type === 'tool_use')
    if (tools.length) {
      const names = tools.map((tool) => String(tool?.name || 'tool')).join(', ')
      return { level: 'act', phase: 'tool_use', message: names, data: { tools } }
    }
    if (text) return { level: 'think', phase: 'assistant', message: text.slice(0, 1200), data: event }
    return null
  }
  if (type === 'user') {
    const message = recordField(event, 'message')
    const blocks = Array.isArray(message?.content) ? message.content : []
    const toolResults = blocks.map(recordFromUnknown).filter((b) => b?.type === 'tool_result')
    if (toolResults.length) {
      return {
        level: 'observe',
        phase: 'tool_result',
        message: toolResults.map((r) => `tool_result ${String(r?.tool_use_id || '')}`).join(', '),
        data: { toolResults },
      }
    }
    return null
  }
  if (type === 'result') {
    const subtype = typeof event.subtype === 'string' ? event.subtype : 'result'
    const result = typeof event.result === 'string' ? event.result : subtype
    return {
      level: subtype === 'success' ? 'done' : 'error',
      phase: 'result',
      message: result.slice(0, 1200),
      data: event,
    }
  }
  if (type === 'system') {
    const subtype = typeof event.subtype === 'string' ? event.subtype : 'system'
    if (subtype === 'init') {
      return {
        level: 'info',
        phase: 'init',
        message: `model=${String(event.model || '')} tools=${Array.isArray(event.tools) ? event.tools.length : 0}`,
        data: event,
      }
    }
    if (subtype === 'task_progress') {
      return { level: 'info', phase: 'progress', message: String(event.description || 'task progress'), data: event }
    }
    return { level: 'info', phase: subtype, message: subtype, data: event }
  }
  if (type === 'tool_progress') {
    return { level: 'info', phase: 'tool_progress', message: String(event.tool_name || 'tool running'), data: event }
  }
  return null
}

function safeJson(text: string): unknown | null {
  try { return JSON.parse(text) } catch { return null }
}

function recordFromUnknown(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function recordField(record: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  return recordFromUnknown(record[key])
}

function blockText(block: unknown): string {
  const item = recordFromUnknown(block)
  if (!item) return ''
  if (item.type === 'text' && typeof item.text === 'string') return item.text
  if (item.type === 'thinking' && typeof item.thinking === 'string') return item.thinking
  return ''
}

function stopRuntime(run: RuntimeRunState): void {
  if (!run.child || run.done) return
  try {
    if (run.child.pid) process.kill(-run.child.pid, 'SIGTERM')
    else run.child.kill('SIGTERM')
  } catch {
    try { run.child.kill('SIGTERM') } catch { /* ignore */ }
  }
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url || '/', `http://${req.headers.host}`)
  const p = url.pathname
  const q = (k: string) => url.searchParams.get(k) || undefined

  // --- static dashboard -------------------------------------------------
  if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
    res.writeHead(200, { 'content-type': MIME['.html'] })
    res.end(INDEX_HTML)
    return
  }

  // --- config -----------------------------------------------------------
  if (p === '/api/config' && req.method === 'GET') {
    const cfg = mergeConfig(loadConfig())
    send(res, 200, {
      provider: cfg.model.provider,
      baseUrl: cfg.model.baseUrl,
      name: cfg.model.name,
      hasKey: Boolean(cfg.model.apiKey || cfg.model.authToken),
      keyPreview: cfg.model.apiKey ? `${cfg.model.apiKey.slice(0, 6)}…` : cfg.model.authToken ? `${cfg.model.authToken.slice(0, 6)}…` : '',
      resumePath: cfg.resumePath,
      alibabaCareersUrl: cfg.alibabaCareersUrl,
    })
    return
  }
  if (p === '/api/config' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}')
    const key = typeof body.key === 'string' ? body.key.trim() : ''
    modelOverride = {
      ...modelOverride,
      ...(body.provider ? { provider: body.provider } : {}),
      ...(body.baseUrl ? { baseUrl: body.baseUrl } : {}),
      ...(body.name ? { name: body.name } : {}),
      ...(key ? { apiKey: key, authToken: key } : {}),
    }
    send(res, 200, { ok: true })
    return
  }

  // --- runtime web agent -----------------------------------------------
  if (p === '/api/runtime/run' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}')
    if (typeof body.url !== 'string' || !body.url.trim() || typeof body.prompt !== 'string' || !body.prompt.trim()) {
      return send(res, 400, { error: 'url and prompt are required' })
    }
    const id = await startRuntimeRun({
      preset: typeof body.preset === 'string' ? body.preset : 'generic',
      url: body.url.trim(),
      prompt: body.prompt.trim(),
      resumePath: typeof body.resumePath === 'string' && body.resumePath.trim() ? body.resumePath.trim() : undefined,
      headless: Boolean(body.headless),
      maxTurns: typeof body.maxTurns === 'string' && body.maxTurns.trim() ? body.maxTurns.trim() : undefined,
      maxPasses: typeof body.maxPasses === 'string' && body.maxPasses.trim() ? body.maxPasses.trim() : undefined,
      allowedDomains: typeof body.allowedDomains === 'string' && body.allowedDomains.trim() ? body.allowedDomains.trim() : undefined,
      profile: typeof body.profile === 'string' && body.profile.trim() ? body.profile.trim() : undefined,
    })
    send(res, 200, { runId: id })
    return
  }
  if (p === '/api/runtime/events' && req.method === 'GET') {
    const id = q('id')
    const run = id ? runtimeRuns.get(id) : undefined
    if (!run) return send(res, 404, { error: 'unknown runtime runId' })
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    res.write('retry: 2000\n\n')
    for (const e of run.events) res.write(`data: ${JSON.stringify(e)}\n\n`)
    if (run.done) {
      res.write(`data: ${JSON.stringify({ _end: true, exitCode: run.exitCode, signal: run.signal, runDir: run.runDir, traceDir: run.traceDir })}\n\n`)
      return res.end()
    }
    run.subscribers.add(res)
    req.on('close', () => run.subscribers.delete(res))
    return
  }
  if (p === '/api/runtime/continue' && req.method === 'POST') {
    const id = q('id')
    const run = id ? runtimeRuns.get(id) : undefined
    if (!run) return send(res, 404, { error: 'unknown runtime runId' })
    mkdirSync(dirname(run.continueFile), { recursive: true })
    writeFileSync(run.continueFile, new Date().toISOString())
    run.handoffWaiting = false
    emitRuntime(run, { level: 'info', phase: 'handoff', message: 'Continue signal sent.' })
    send(res, 200, { ok: true })
    return
  }
  if (p === '/api/runtime/stop' && req.method === 'POST') {
    const id = q('id')
    const run = id ? runtimeRuns.get(id) : undefined
    if (!run) return send(res, 404, { error: 'unknown runtime runId' })
    stopRuntime(run)
    emitRuntime(run, { level: 'warn', phase: 'stop', message: 'Stop requested.' })
    send(res, 200, { ok: true })
    return
  }
  if (p === '/api/runtime/trace' && req.method === 'GET') {
    const id = q('id')
    const run = id ? runtimeRuns.get(id) : undefined
    if (!run) return send(res, 404, { error: 'unknown runtime runId' })
    const traceDir = run.traceDir || join(outputDir(), 'traces', `claude_${run.id}`)
    const sessionFile = join(traceDir, 'session.json')
    const spansFile = join(traceDir, 'spans.jsonl')
    const eventsFile = join(traceDir, 'events.jsonl')
    const metricsFile = join(traceDir, 'metrics.json')
    const agentStateFile = join(traceDir, 'agent-state.json')
    send(res, 200, {
      id: run.id,
      done: run.done,
      exitCode: run.exitCode,
      signal: run.signal,
      runDir: run.runDir,
      traceDir: existsSync(traceDir) ? traceDir : run.traceDir,
      handoffWaiting: run.handoffWaiting,
      continueFile: run.continueFile,
      session: readJsonFile(sessionFile),
      spans: spansFile && existsSync(spansFile) ? readJsonl(spansFile, 300) : [],
      events: eventsFile && existsSync(eventsFile) ? readJsonl(eventsFile, 100) : [],
      metrics: readJsonFile(metricsFile),
      agentState: readJsonFile(agentStateFile),
    })
    return
  }
  if (p === '/api/runtime/runs' && req.method === 'GET') {
    send(res, 200, [...runtimeRuns.values()].map((r) => ({
      id: r.id,
      done: r.done,
      events: r.events.length,
      exitCode: r.exitCode,
      runDir: r.runDir,
      traceDir: r.traceDir,
      handoffWaiting: r.handoffWaiting,
    })))
    return
  }

  // --- run --------------------------------------------------------------
  if (p === '/api/run' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}')
    const id = await startRun({
      mode: body.mode || 'demo-form',
      startUrl: body.startUrl,
      resumePath: body.resumePath,
      headless: body.headless,
    })
    send(res, 200, { runId: id })
    return
  }
  if (p === '/api/stop' && req.method === 'POST') {
    await sessionManager.closeAll().catch(() => {})
    send(res, 200, { ok: true })
    return
  }

  // --- SSE events -------------------------------------------------------
  if (p === '/api/events' && req.method === 'GET') {
    const id = q('id')
    const run = id ? runs.get(id) : undefined
    if (!run) return send(res, 404, { error: 'unknown runId' })
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    res.write('retry: 2000\n\n')
    for (const e of run.events) res.write(`data: ${JSON.stringify(e)}\n\n`)
    if (run.done) {
      res.write(`data: ${JSON.stringify({ _end: true, finalState: run.result?.finalState, message: run.result?.message, summary: run.result?.summary })}\n\n`)
      return res.end()
    }
    run.subscribers.add(res)
    req.on('close', () => run.subscribers.delete(res))
    return
  }

  // --- trace ------------------------------------------------------------
  if (p === '/api/trace' && req.method === 'GET') {
    const id = q('id')
    const dir = id ? join(outputDir(), id) : ''
    const traceFile = join(dir, 'trace.jsonl')
    const summaryFile = join(dir, 'summary.json')
    const traceDir = id ? join(outputDir(), 'traces', `run_${id}`) : ''
    const metricsFile = traceDir ? join(traceDir, 'metrics.json') : ''
    const agentStateFile = traceDir ? join(traceDir, 'agent-state.json') : ''
    if (!id || !existsSync(traceFile)) {
      return send(res, 200, {
        steps: [],
        summary: null,
        metrics: readJsonFile(metricsFile),
        agentState: readJsonFile(agentStateFile),
      })
    }
    const steps = readFileSync(traceFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    const summary = readJsonFile(summaryFile)
    send(res, 200, {
      steps,
      summary,
      metrics: readJsonFile(metricsFile),
      agentState: readJsonFile(agentStateFile),
    })
    return
  }

  // --- screenshot -------------------------------------------------------
  if (p === '/api/shot' && req.method === 'GET') {
    const id = q('id')
    const name = normalize(q('name') || '')
    if (!id || name.includes('..') || name.includes('/') || name.includes('\\')) {
      return send(res, 400, { error: 'bad shot name' })
    }
    const outDir = outputDir()
    const file = join(outDir, id, name)
    if (!file.startsWith(outDir) || !existsSync(file)) return send(res, 404, { error: 'not found' })
    res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' })
    createReadStream(file).pipe(res)
    return
  }

  // --- resume upload ----------------------------------------------------
  if (p === '/api/resume' && req.method === 'POST') {
    const buf = await readBody(req)
    const dir = join(REPO_ROOT, 'tmp', 'pdfs')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `resume-${Date.now()}${resumeExtension(req)}`)
    writeFileSync(file, buf)
    send(res, 200, { path: file })
    return
  }

  // --- runs list (debug) ------------------------------------------------
  if (p === '/api/runs' && req.method === 'GET') {
    send(res, 200, [...runs.values()].map((r) => ({ id: r.id, done: r.done, events: r.events.length, finalState: r.result?.finalState })))
    return
  }

  send(res, 404, { error: `not found: ${req.method} ${p}` })
}

const explicitPort = Boolean(process.env.PORT)
const initialPort = Number(process.env.PORT || 5178)
let server: ReturnType<typeof createServer> | null = null

function listen(port: number, retries: number): void {
  server = createServer((req, res) => {
    handle(req, res).catch((error) => {
      try { send(res, 500, { error: String(error) }) } catch { /* ignore */ }
    })
  })
  server.once('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EADDRINUSE' && !explicitPort && retries > 0) {
      listen(port + 1, retries - 1)
      return
    }
    throw error
  })
  server.listen(port, () => {
    const cfg = mergeConfig(loadConfig())
    // eslint-disable-next-line no-console
    console.log(`\n  job-agent web UI → http://localhost:${port}\n  provider: ${cfg.model.provider} | model: ${cfg.model.name} | key: ${cfg.model.apiKey || cfg.model.authToken ? 'set' : 'NOT SET'}\n`)
  })
}

listen(initialPort, 20)

process.on('SIGINT', () => { server?.close(); void sessionManager.closeAll().finally(() => process.exit(0)) })
process.on('SIGTERM', () => { server?.close(); void sessionManager.closeAll().finally(() => process.exit(0)) })

// keep import referenced
void defaultAuthPath
