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
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { extname, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig, type AgentConfig, type ModelConfig } from '../sdk/config.js'
import { runJobApplicationAgent, type AgentEvent, type AgentRunResult } from '../sdk/orchestrator.js'
import { sessionManager } from '../session/manager.js'
import { defaultAuthPath } from '../runtime/local/login.js'
import { RISK_DECISIONS_ARTIFACT } from '../policy/risk-decisions.js'
import type { WebBuddyTaskType } from '../workflow/completion-gate.js'
import INDEX_HTML from './public/index.html'
import VENUE_BOOKING_HTML from './public/venue-booking.html'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..')
function outputDir(): string {
  return resolve(loadConfig().trace.outDir)
}

interface RunState {
  id: string
  mode: string
  events: AgentEvent[]
  subscribers: Set<ServerResponse>
  result: AgentRunResult | null
  done: boolean
}
const runs = new Map<string, RunState>()

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

function parseTaskType(value: unknown): WebBuddyTaskType | undefined {
  if (value === 'explore' || value === 'apply_entry' || value === 'fill_form' || value === 'final_review') {
    return value
  }
  return undefined
}

function parseWebBuddyMode(value: unknown): AgentRunResult['mode'] | undefined {
  if (
    value === 'raw' ||
    value === 'fill' ||
    value === 'match' ||
    value === 'alibaba-apply' ||
    value === 'demo-form' ||
    value === 'demo-research' ||
    value === 'auto-apply'
  ) {
    return value
  }
  return undefined
}

function normalizeRequiredUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined
  try {
    return new URL(value.trim()).toString()
  } catch {
    return undefined
  }
}

/** Push an event to a run's buffer + all live SSE subscribers. */
function emitRun(run: RunState, event: AgentEvent) {
  run.events.push(event)
  for (const sub of run.subscribers) {
    sub.write(`data: ${JSON.stringify(event)}\n\n`)
  }
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

async function startRun(opts: { mode: string; startUrl?: string; resumePath?: string; headless?: boolean; taskPrompt?: string; taskType?: WebBuddyTaskType; requiresCurrentResumeUpload?: boolean }) {
  const id = `web-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`
  const run: RunState = { id, mode: opts.mode, events: [], subscribers: new Set(), result: null, done: false }
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
    taskPrompt: opts.taskPrompt,
    taskType: opts.taskType,
    requiresCurrentResumeUpload: opts.requiresCurrentResumeUpload,
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
  if (req.method === 'GET' && (p === '/fixtures/venue-booking' || p === '/fixtures/venue-booking/')) {
    res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-store' })
    res.end(VENUE_BOOKING_HTML)
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

  // --- run --------------------------------------------------------------
  if (p === '/api/run' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}')
    const mode = parseWebBuddyMode(body.mode)
    const startUrl = normalizeRequiredUrl(body.startUrl)
    if (!mode) {
      return send(res, 400, { error: 'valid mode is required' })
    }
    if (!startUrl) {
      return send(res, 400, { error: 'valid startUrl is required' })
    }
    const id = await startRun({
      mode,
      startUrl,
      resumePath: body.resumePath,
      headless: body.headless,
      taskPrompt: typeof body.taskPrompt === 'string' ? body.taskPrompt : typeof body.prompt === 'string' ? body.prompt : undefined,
      taskType: parseTaskType(body.taskType),
      requiresCurrentResumeUpload: body.requiresCurrentResumeUpload === true,
    })
    send(res, 200, { runId: id, runtime: 'web-buddy', mode })
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
      res.write(`data: ${JSON.stringify({ _end: true, runtime: 'web-buddy', mode: run.mode, finalState: run.result?.finalState, message: run.result?.message, summary: run.result?.summary })}\n\n`)
      return res.end()
    }
    run.subscribers.add(res)
    req.on('close', () => run.subscribers.delete(res))
    return
  }

  // --- trace ------------------------------------------------------------
  if (p === '/api/trace' && req.method === 'GET') {
    const id = q('id')
    const run = id ? runs.get(id) : undefined
    const dir = id ? join(outputDir(), id) : ''
    const traceFile = join(dir, 'trace.jsonl')
    const summaryFile = join(dir, 'summary.json')
    const traceDir = id ? join(outputDir(), 'traces', `run_${id}`) : ''
    const spansFile = traceDir ? join(traceDir, 'spans.jsonl') : ''
    const eventsFile = traceDir ? join(traceDir, 'events.jsonl') : ''
    const metricsFile = traceDir ? join(traceDir, 'metrics.json') : ''
    const agentStateFile = traceDir ? join(traceDir, 'agent-state.json') : ''
    const riskDecisionsFile = traceDir ? join(traceDir, 'artifacts', RISK_DECISIONS_ARTIFACT) : ''
    if (!id || !existsSync(traceFile)) {
      return send(res, 200, {
        id,
        runtime: 'web-buddy',
        mode: run?.mode,
        done: run?.done ?? false,
        finalState: run?.result?.finalState,
        runDir: existsSync(dir) ? dir : undefined,
        traceDir: existsSync(traceDir) ? traceDir : undefined,
        steps: [],
        summary: null,
        spans: spansFile && existsSync(spansFile) ? readJsonl(spansFile, 300) : [],
        events: eventsFile && existsSync(eventsFile) ? readJsonl(eventsFile, 100) : [],
        metrics: readJsonFile(metricsFile),
        riskDecisions: readJsonFile(riskDecisionsFile),
        agentState: readJsonFile(agentStateFile),
      })
    }
    const steps = readFileSync(traceFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    const summary = readJsonFile(summaryFile)
    send(res, 200, {
      id,
      runtime: 'web-buddy',
      mode: run?.mode,
      done: run?.done ?? false,
      finalState: run?.result?.finalState,
      runDir: dir,
      traceDir: existsSync(traceDir) ? traceDir : undefined,
      steps,
      summary,
      spans: spansFile && existsSync(spansFile) ? readJsonl(spansFile, 300) : [],
      events: eventsFile && existsSync(eventsFile) ? readJsonl(eventsFile, 100) : [],
      metrics: readJsonFile(metricsFile),
      riskDecisions: readJsonFile(riskDecisionsFile),
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
    send(res, 200, [...runs.values()].map((r) => ({ id: r.id, mode: r.mode, done: r.done, events: r.events.length, finalState: r.result?.finalState })))
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
