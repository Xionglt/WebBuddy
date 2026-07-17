/**
 * Durable Web Buddy control-plane server.
 *
 * Run lifecycle, revisions, approvals and references are stored in RunStore /
 * ApprovalStore. The process keeps only live transport subscribers and active
 * controllers; neither is a source of truth.
 */
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { extname, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ApprovalService,
  ControlStoreError,
  FileApprovalStore,
  FileRunStore,
  RecoveryService,
  RunService,
  RunServiceError,
  type RunRecord,
} from '../control/index.js'
import { createAgentRunController, type AgentRunController } from '../kernel/run-controller.js'
import { RISK_DECISIONS_ARTIFACT } from '../policy/risk-decisions.js'
import { loadConfig, type AgentConfig, type ModelConfig } from '../sdk/config.js'
import { runJobApplicationAgent, type AgentEvent, type AgentRunResult, type RunOptions } from '../sdk/orchestrator.js'
import { sessionManager } from '../session/manager.js'
import { FileSessionStore } from '../session/index.js'
import { snapshotWebTaskInput, type JsonObject } from '../task/contracts.js'
import type { WebBuddyTaskType } from '../workflow/completion-gate.js'
import INDEX_HTML from './public/index.html'
import VENUE_BOOKING_HTML from './public/venue-booking.html'

const SOURCE_FILE = fileURLToPath(import.meta.url)
const __dirname = fileURLToPath(new URL('.', import.meta.url))
const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..')
const TERMINAL_STATES = new Set(['completed', 'failed', 'cancelled'])

function outputDir(): string {
  return resolve(loadConfig().trace.outDir)
}

interface LegacyLaunchOptions {
  mode: AgentRunResult['mode']
  startUrl: string
  resumePath?: string
  headless?: boolean
  taskPrompt?: string
  taskType?: WebBuddyTaskType
  requiresCurrentResumeUpload?: boolean
  restartSafe: boolean
  restoredSessionId?: string
}

interface LiveChannel {
  events: AgentEvent[]
  subscribers: Set<ServerResponse>
}

interface LiveExecution {
  controller: AgentRunController
  runRevision: number
  attempt: number
}

export interface WebControlServerOptions {
  controlStoreDir?: string
  disableExecution?: boolean
}

export function createWebControlServer(options: WebControlServerOptions = {}) {
  const controlStoreDir = options.controlStoreDir
    ? resolve(options.controlStoreDir)
    : resolve(process.env.WEB_BUDDY_CONTROL_STORE_DIR || join(outputDir(), 'control-plane'))
  const runService = new RunService(new FileRunStore({ rootDir: controlStoreDir }))
  const approvalService = new ApprovalService(new FileApprovalStore({ rootDir: controlStoreDir }))
  const sessionStore = new FileSessionStore({ rootDir: join(outputDir(), 'sessions') })
  const recoveryService = new RecoveryService(runService, approvalService, {
    canRestoreSession: async (record) => Boolean(record.sessionRef && await sessionStore.get(record.sessionRef.id)),
  })
  const channels = new Map<string, LiveChannel>()
  const executions = new Map<string, LiveExecution>()
  let modelOverride: Partial<ModelConfig> = {}

  const mergeConfig = (base: AgentConfig): AgentConfig => ({
    ...base,
    model: { ...base.model, ...modelOverride } as ModelConfig,
  })

  const channelFor = (runId: string): LiveChannel => {
    let channel = channels.get(runId)
    if (!channel) {
      channel = { events: [], subscribers: new Set() }
      channels.set(runId, channel)
    }
    return channel
  }

  const emitRun = (runId: string, event: AgentEvent) => {
    const channel = channelFor(runId)
    channel.events.push(event)
    for (const subscriber of channel.subscribers) {
      subscriber.write(`data: ${JSON.stringify(event)}\n\n`)
    }
  }

  const endRun = (record: RunRecord, result?: AgentRunResult, error?: string) => {
    const channel = channelFor(record.runId)
    const terminal = JSON.stringify({
      _end: true,
      state: record.state,
      error,
      finalState: result?.finalState,
      message: result?.message,
      summary: result?.summary,
    })
    for (const subscriber of channel.subscribers) {
      subscriber.write(`data: ${terminal}\n\n`)
      subscriber.end()
    }
    channel.subscribers.clear()
  }

  async function launch(record: RunRecord, launchOptions = launchOptionsFromRecord(record)): Promise<void> {
    if (options.disableExecution) return
    const controller = createAgentRunController()
    const running = await runService.transition(record.runId, {
      to: 'running',
      idempotencyKey: `launch:${record.runRevision}:${record.attempt}`,
      expectedRunRevision: record.runRevision,
      expectedAttempt: record.attempt,
    })
    executions.set(record.runId, {
      controller,
      runRevision: running.runRevision,
      attempt: running.attempt,
    })

    const config = mergeConfig(loadConfig())
    config.human.mode = 'auto'
    allowStartUrl(config, launchOptions.startUrl)
    if (launchOptions.headless !== undefined) {
      config.browser.headless = launchOptions.headless
      config.browser.visualHighlight = !launchOptions.headless
    }
    if (launchOptions.resumePath) config.resumePath = launchOptions.resumePath

    const runtimeOptions: RunOptions = {
      config,
      mode: launchOptions.mode,
      startUrl: launchOptions.startUrl,
      taskPrompt: launchOptions.taskPrompt,
      taskType: launchOptions.taskType,
      requiresCurrentResumeUpload: launchOptions.requiresCurrentResumeUpload,
      runId: running.runId,
      source: 'web-ui',
      profile: 'debug',
      controller,
      ...(launchOptions.restoredSessionId ? { restoredSessionId: launchOptions.restoredSessionId } : {}),
      onSessionReady: async (session) => {
        await runService.attachSession(running.runId, {
          schemaVersion: 'session-ref/v1',
          provider: 'file-session-store',
          id: session.sessionId,
          runId: running.runId,
          attempt: running.attempt,
        }, `session:${running.runRevision}:${running.attempt}:${session.sessionId}`)
      },
      onEvent: (event) => emitRun(running.runId, event),
    }

    void runJobApplicationAgent(runtimeOptions)
      .then((result) => settleExecution(running, controller, result))
      .catch((error) => settleExecution(running, controller, undefined, String(error)))
      .finally(() => {
        const active = executions.get(running.runId)
        if (active?.runRevision === running.runRevision && active.attempt === running.attempt) {
          executions.delete(running.runId)
        }
      })
  }

  async function settleExecution(
    launched: RunRecord,
    controller: AgentRunController,
    result?: AgentRunResult,
    error?: string,
  ): Promise<void> {
    let current = await runService.get(launched.runId)
    if (!current) return
    const traceRef = {
      schemaVersion: 'control-resource-ref/v1' as const,
      id: `trace:${launched.runId}:${launched.attempt}`,
      kind: 'trace' as const,
      locator: `traces/run_${launched.runId}`,
    }

    if (current.runRevision !== launched.runRevision || current.attempt !== launched.attempt) {
      const rejected = await runService.acceptResult({
        runId: launched.runId,
        runRevision: launched.runRevision,
        attempt: launched.attempt,
        terminalState: error ? 'failed' : 'completed',
        reason: error ?? result?.message,
        resourceRefs: [traceRef],
        idempotencyKey: `late-result:${launched.runRevision}:${launched.attempt}`,
      })
      endRun(rejected.record, result, error)
      return
    }

    if (current.state === 'pausing' || controller.pauseRequested) {
      current = await runService.acknowledgePause(launched.runId, {
        schemaVersion: 'safe-turn-boundary-ref/v1',
        runId: launched.runId,
        runRevision: launched.runRevision,
        attempt: launched.attempt,
        turnId: `attempt-${launched.attempt}-settled`,
        actionSeq: channelFor(launched.runId).events.length,
        observedAt: new Date().toISOString(),
        ...(result?.session ? {
          sessionRef: {
            schemaVersion: 'session-ref/v1',
            provider: 'legacy-agent-session',
            id: result.session.sessionId,
            runId: launched.runId,
            attempt: launched.attempt,
          },
        } : {}),
      }, `pause-ack:${launched.runRevision}:${launched.attempt}`)
      endRun(current, result, error)
      return
    }

    if (current.state === 'cancelling' || controller.signal.aborted) {
      const decision = await runService.acceptResult({
        runId: launched.runId,
        runRevision: launched.runRevision,
        attempt: launched.attempt,
        terminalState: 'cancelled',
        reason: controller.reason ?? 'Cancelled by user.',
        resourceRefs: [traceRef],
        idempotencyKey: `cancelled:${launched.runRevision}:${launched.attempt}`,
      })
      endRun(decision.record, result, error)
      return
    }

    if (!error && result && isHumanBlocked(result.finalState)) {
      current = await runService.transition(launched.runId, {
        to: 'blocked_on_human',
        reason: result.message,
        idempotencyKey: `blocked:${launched.runRevision}:${launched.attempt}`,
        expectedRunRevision: launched.runRevision,
        expectedAttempt: launched.attempt,
        update: (record) => ({
          resourceRefs: mergeResourceRefs(record.resourceRefs, [traceRef]),
        }),
      })
      endRun(current, result)
      return
    }

    const decision = await runService.acceptResult({
      runId: launched.runId,
      runRevision: launched.runRevision,
      attempt: launched.attempt,
      terminalState: error || result?.finalState === 'error' ? 'failed' : 'completed',
      reason: error ?? result?.message,
      resourceRefs: [traceRef],
      idempotencyKey: `result:${launched.runRevision}:${launched.attempt}`,
    })
    endRun(decision.record, result, error)
  }

  async function createRun(body: Record<string, unknown>, idempotencyKey: string): Promise<RunRecord> {
    const launchOptions = parseLaunchOptions(body)
    const runId = `web-${createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 24)}`
    const metadata: JsonObject = {
      mode: launchOptions.mode,
      headless: launchOptions.headless ?? false,
      restartSafe: launchOptions.restartSafe,
      requiresCurrentResumeUpload: launchOptions.requiresCurrentResumeUpload ?? false,
      ...(launchOptions.taskType ? { taskType: launchOptions.taskType } : {}),
      ...(launchOptions.resumePath ? { resumePath: launchOptions.resumePath } : {}),
    }
    const snapshot = snapshotWebTaskInput({
      schemaVersion: 'web-task-input/v1',
      runId,
      revision: 0,
      goal: {
        instruction: launchOptions.taskPrompt ?? 'Complete the requested web task.',
        scenario: 'web-control-plane',
        metadata,
      },
      startUrl: launchOptions.startUrl,
      contract: {
        schemaVersion: 'web-task-contract/v1',
        contractId: 'web-control-plane-legacy-adapter',
        revision: 0,
        criteria: [{
          id: 'runtime-terminal-evidence',
          kind: 'evidence_present',
          description: 'The main runtime must produce a verified terminal result.',
          evidenceKinds: ['legacy_recruiting_result'],
          minCount: 1,
          allowedAuthorities: ['main_runtime'],
        }],
      },
    })
    const existing = await runService.get(runId)
    if (existing) {
      if (existing.inputDigest !== snapshot.sha256) {
        throw new ControlStoreError('IDEMPOTENCY_CONFLICT', 'Create idempotency key was reused with different run input.')
      }
      return existing
    }
    const created = await runService.create(snapshot, { idempotencyKey })
    channelFor(runId)
    if (!created.replayed) await launch(created.record, launchOptions)
    return (await runService.get(runId)) ?? created.record
  }

  async function recoverStartupRuns(): Promise<void> {
    await recoveryService.recoverStartupRuns()
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
    const path = url.pathname
    const query = (key: string) => url.searchParams.get(key) || undefined

    if (req.method === 'GET' && (path === '/' || path === '/index.html')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(INDEX_HTML)
      return
    }
    if (req.method === 'GET' && (path === '/fixtures/venue-booking' || path === '/fixtures/venue-booking/')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(VENUE_BOOKING_HTML)
      return
    }

    if (path === '/api/config' && req.method === 'GET') {
      const config = mergeConfig(loadConfig())
      send(res, 200, {
        provider: config.model.provider,
        baseUrl: config.model.baseUrl,
        name: config.model.name,
        hasKey: Boolean(config.model.apiKey || config.model.authToken),
        keyPreview: config.model.apiKey
          ? `${config.model.apiKey.slice(0, 6)}…`
          : config.model.authToken ? `${config.model.authToken.slice(0, 6)}…` : '',
        resumePath: config.resumePath,
        alibabaCareersUrl: config.alibabaCareersUrl,
      })
      return
    }
    if (path === '/api/config' && req.method === 'POST') {
      const body = await readJsonBody(req)
      const key = typeof body.key === 'string' ? body.key.trim() : ''
      const provider = body.provider === 'openai' || body.provider === 'anthropic' ? body.provider : undefined
      modelOverride = {
        ...modelOverride,
        ...(provider ? { provider } : {}),
        ...(body.baseUrl ? { baseUrl: String(body.baseUrl) } : {}),
        ...(body.name ? { name: String(body.name) } : {}),
        ...(key ? { apiKey: key, authToken: key } : {}),
      }
      send(res, 200, { ok: true })
      return
    }

    if ((path === '/api/run' || path === '/api/runs') && req.method === 'POST') {
      const body = await readJsonBody(req)
      const idempotencyKey = requestIdempotencyKey(req, body, `create:${randomUUID()}`)
      const run = await createRun(body, idempotencyKey)
      send(res, 201, { runId: run.runId, runtime: 'web-buddy', mode: run.inputSnapshot.goal.metadata?.mode, state: run.state })
      return
    }

    if (path === '/api/runs' && req.method === 'GET') {
      const page = await runService.list({ limit: numberQuery(query('limit'), 100) })
      send(res, 200, { items: page.items, nextCursor: page.nextCursor })
      return
    }

    const runMatch = path.match(/^\/api\/runs\/([^/]+)$/)
    if (runMatch && req.method === 'GET') {
      const run = await runService.get(decodeURIComponent(runMatch[1]))
      if (!run) return send(res, 404, { error: 'unknown runId' })
      const events = await runService.events(run.runId)
      send(res, 200, { run, events: events.items })
      return
    }

    const controlMatch = path.match(/^\/api\/runs\/([^/]+)\/(pause|resume|cancel)$/)
    if (controlMatch && req.method === 'POST') {
      const runId = decodeURIComponent(controlMatch[1])
      const control = controlMatch[2]
      const body = await readJsonBody(req)
      const idempotencyKey = requestIdempotencyKey(req, body, `${control}:${runId}:${randomUUID()}`)
      if (control === 'pause') {
        const run = await runService.requestPause(runId, idempotencyKey)
        executions.get(runId)?.controller.requestPause('Pause requested from control plane.')
        send(res, 202, { run })
        return
      }
      if (control === 'cancel') {
        const run = await runService.requestCancel(runId, idempotencyKey)
        executions.get(runId)?.controller.abort('Cancel requested from control plane.')
        send(res, 202, { run })
        return
      }
      const current = await runService.get(runId)
      if (!current) return send(res, 404, { error: 'unknown runId' })
      const restartSafe = current.inputSnapshot.goal.metadata?.restartSafe === true
      const restoredSessionId = current.sessionRef?.id ?? current.lastSafeBoundary?.sessionRef?.id
      if (!restartSafe || !restoredSessionId) {
        return send(res, 409, {
          error: 'resume_requires_safe_session',
          message: 'Resume requires a durable session plus an explicit read-only restart contract; the server will not replay a prior write action.',
        })
      }
      await approvalService.cancelPendingForRun(
        runId,
        'Approval invalidated when resume created a new run revision.',
        `resume-approval-fence:${current.runRevision}:${current.attempt}`,
      )
      const resuming = await runService.resume(runId, idempotencyKey)
      await launch(resuming, { ...launchOptionsFromRecord(resuming), restoredSessionId })
      send(res, 202, { run: (await runService.get(runId)) ?? resuming })
      return
    }

    if (path === '/api/stop' && req.method === 'POST') {
      const runId = query('id')
      if (!runId) return send(res, 400, { error: 'runId is required' })
      const run = await runService.requestCancel(runId, `legacy-stop:${runId}:${randomUUID()}`)
      executions.get(runId)?.controller.abort('Cancel requested from legacy stop endpoint.')
      send(res, 202, { ok: true, run })
      return
    }

    if (path === '/api/events' && req.method === 'GET') {
      const runId = query('id')
      const run = runId ? await runService.get(runId) : undefined
      if (!runId || !run) return send(res, 404, { error: 'unknown runId' })
      const channel = channelFor(runId)
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      })
      res.write('retry: 2000\n\n')
      for (const event of channel.events) res.write(`data: ${JSON.stringify(event)}\n\n`)
      if (TERMINAL_STATES.has(run.state) || run.state === 'paused' || run.state === 'blocked_on_human' || run.state === 'recoverable') {
        res.write(`data: ${JSON.stringify({ _end: true, state: run.state, message: run.reason })}\n\n`)
        res.end()
        return
      }
      channel.subscribers.add(res)
      req.on('close', () => channel.subscribers.delete(res))
      return
    }

    if ((path === '/api/trace' || path.match(/^\/api\/runs\/[^/]+\/trace$/)) && req.method === 'GET') {
      const runId = path === '/api/trace' ? query('id') : decodeURIComponent(path.split('/')[3])
      if (!runId) return send(res, 400, { error: 'runId is required' })
      const run = await runService.get(runId)
      if (!run) return send(res, 404, { error: 'unknown runId' })
      send(res, 200, tracePayload(run))
      return
    }

    const artifactMatch = path.match(/^\/api\/runs\/([^/]+)\/artifacts$/)
    if (artifactMatch && req.method === 'GET') {
      const run = await runService.get(decodeURIComponent(artifactMatch[1]))
      if (!run) return send(res, 404, { error: 'unknown runId' })
      send(res, 200, {
        runId: run.runId,
        artifacts: run.artifactRefs,
        resources: run.resourceRefs,
        discovered: discoverTraceArtifacts(run.runId),
      })
      return
    }

    if (path === '/api/approvals' && req.method === 'GET') {
      const page = await approvalService.list({
        ...(query('runId') ? { runId: query('runId') } : {}),
        statuses: ['pending'],
        limit: numberQuery(query('limit'), 100),
      })
      send(res, 200, { items: page.items, nextCursor: page.nextCursor })
      return
    }

    const approvalMatch = path.match(/^\/api\/approvals\/([^/]+)\/resolve$/)
    if (approvalMatch && req.method === 'POST') {
      const approvalId = decodeURIComponent(approvalMatch[1])
      const body = await readJsonBody(req)
      const approval = await approvalService.get(approvalId)
      if (!approval) return send(res, 404, { error: 'unknown approvalId' })
      const approvalRun = await runService.get(approval.runId)
      if (!approvalRun
        || approvalRun.runRevision !== approval.runRevision
        || approvalRun.attempt !== approval.attempt) {
        throw new ControlStoreError(
          'BINDING_MISMATCH',
          'Approval belongs to a stale run revision/attempt and cannot be resolved.',
        )
      }
      const decision = body.decision === 'approved' || body.decision === 'denied' ? body.decision : undefined
      if (!decision) return send(res, 400, { error: 'decision must be approved or denied' })
      const record = await approvalService.resolve({
        approvalId,
        expectedRecordRevision: typeof body.expectedRecordRevision === 'number'
          ? body.expectedRecordRevision
          : approval.recordRevision,
        expectation: {
          runId: approval.runId,
          runRevision: approval.runRevision,
          attempt: approval.attempt,
          ...(approval.sessionRef ? { sessionId: approval.sessionRef.id } : {}),
          actionId: approval.actionBinding.actionId,
          actionBindingSha256: approval.actionBindingSha256,
          ...(approval.actionBinding.sourceOrigin ? { sourceOrigin: approval.actionBinding.sourceOrigin } : {}),
          ...(approval.actionBinding.destinationOrigin ? { destinationOrigin: approval.actionBinding.destinationOrigin } : {}),
        },
        decision,
        idempotencyKey: requestIdempotencyKey(req, body, `resolve:${approvalId}:${randomUUID()}`),
        nonce: randomUUID(),
        expiresAt: approval.expiresAt,
      })
      send(res, 200, { approval: record })
      return
    }

    if (path === '/api/shot' && req.method === 'GET') {
      const runId = query('id')
      const name = normalize(query('name') || '')
      if (!runId || name.includes('..') || name.includes('/') || name.includes('\\')) {
        return send(res, 400, { error: 'bad shot name' })
      }
      const root = outputDir()
      const file = join(root, runId, name)
      if (!file.startsWith(root) || !existsSync(file)) return send(res, 404, { error: 'not found' })
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' })
      createReadStream(file).pipe(res)
      return
    }

    if (path === '/api/resume' && req.method === 'POST') {
      const buffer = await readBody(req)
      const dir = join(REPO_ROOT, 'tmp', 'pdfs')
      mkdirSync(dir, { recursive: true })
      const file = join(dir, `resume-${Date.now()}${resumeExtension(req)}`)
      writeFileSync(file, buffer)
      send(res, 200, { path: file })
      return
    }

    send(res, 404, { error: `not found: ${req.method} ${path}` })
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((error) => sendControlError(res, error))
  })

  return {
    server,
    runService,
    approvalService,
    recoveryService,
    controlStoreDir,
    recoverStartupRuns,
    async close() {
      for (const execution of executions.values()) execution.controller.abort('Web control server is shutting down.')
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
      await sessionManager.closeAll().catch(() => {})
    },
  }
}

export async function startWebControlServer(port: number, retries = 0): Promise<ReturnType<typeof createWebControlServer>> {
  const control = createWebControlServer()
  await control.recoverStartupRuns()
  let selectedPort = port
  for (;;) {
    try {
      await listen(control.server, selectedPort)
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE' && retries > 0) {
        selectedPort += 1
        retries -= 1
        continue
      }
      throw error
    }
  }
  const config = loadConfig()
  console.log(`\n  job-agent web UI → http://localhost:${selectedPort}\n  provider: ${config.model.provider} | model: ${config.model.name} | key: ${config.model.apiKey || config.model.authToken ? 'set' : 'NOT SET'}\n`)
  return control
}

function parseLaunchOptions(body: Record<string, unknown>): LegacyLaunchOptions {
  const mode = parseWebBuddyMode(body.mode)
  const startUrl = normalizeRequiredUrl(body.startUrl)
  if (!mode) throw new HttpError(400, 'valid mode is required')
  if (!startUrl) throw new HttpError(400, 'valid startUrl is required')
  return {
    mode,
    startUrl,
    ...(typeof body.resumePath === 'string' && body.resumePath.trim() ? { resumePath: body.resumePath.trim() } : {}),
    ...(typeof body.headless === 'boolean' ? { headless: body.headless } : {}),
    ...(typeof body.taskPrompt === 'string' ? { taskPrompt: body.taskPrompt }
      : typeof body.prompt === 'string' ? { taskPrompt: body.prompt } : {}),
    ...(parseTaskType(body.taskType) ? { taskType: parseTaskType(body.taskType) } : {}),
    ...(body.requiresCurrentResumeUpload === true ? { requiresCurrentResumeUpload: true } : {}),
    restartSafe: mode === 'demo-research' || body.restartSafe === true,
  }
}

function launchOptionsFromRecord(record: RunRecord): LegacyLaunchOptions {
  const metadata = record.inputSnapshot.goal.metadata ?? {}
  return {
    mode: parseWebBuddyMode(metadata.mode) ?? 'raw',
    startUrl: record.inputSnapshot.startUrl ?? (() => { throw new HttpError(409, 'Stored run has no start URL.') })(),
    ...(typeof metadata.resumePath === 'string' ? { resumePath: metadata.resumePath } : {}),
    ...(typeof metadata.headless === 'boolean' ? { headless: metadata.headless } : {}),
    taskPrompt: record.inputSnapshot.goal.instruction,
    ...(parseTaskType(metadata.taskType) ? { taskType: parseTaskType(metadata.taskType) } : {}),
    requiresCurrentResumeUpload: metadata.requiresCurrentResumeUpload === true,
    restartSafe: metadata.restartSafe === true,
  }
}

function tracePayload(run: RunRecord) {
  const dir = join(outputDir(), run.runId)
  const traceFile = join(dir, 'trace.jsonl')
  const summaryFile = join(dir, 'summary.json')
  const traceDir = join(outputDir(), 'traces', `run_${run.runId}`)
  const spansFile = join(traceDir, 'spans.jsonl')
  const eventsFile = join(traceDir, 'events.jsonl')
  const metricsFile = join(traceDir, 'metrics.json')
  const agentStateFile = join(traceDir, 'agent-state.json')
  const riskDecisionsFile = join(traceDir, 'artifacts', RISK_DECISIONS_ARTIFACT)
  return {
    id: run.runId,
    runtime: 'web-buddy',
    mode: run.inputSnapshot.goal.metadata?.mode,
    state: run.state,
    done: TERMINAL_STATES.has(run.state),
    runRevision: run.runRevision,
    attempt: run.attempt,
    runDir: existsSync(dir) ? dir : undefined,
    traceDir: existsSync(traceDir) ? traceDir : undefined,
    steps: existsSync(traceFile) ? readJsonl(traceFile, 1000) : [],
    summary: readJsonFile(summaryFile),
    spans: existsSync(spansFile) ? readJsonl(spansFile, 300) : [],
    events: existsSync(eventsFile) ? readJsonl(eventsFile, 100) : [],
    metrics: readJsonFile(metricsFile),
    riskDecisions: readJsonFile(riskDecisionsFile),
    agentState: readJsonFile(agentStateFile),
    resources: run.resourceRefs,
  }
}

function discoverTraceArtifacts(runId: string) {
  const traceDir = join(outputDir(), 'traces', `run_${runId}`)
  return [
    ['risk_decisions', join(traceDir, 'artifacts', RISK_DECISIONS_ARTIFACT)],
    ['metrics', join(traceDir, 'metrics.json')],
    ['summary', join(outputDir(), runId, 'summary.json')],
  ].filter(([, file]) => existsSync(file)).map(([kind, file]) => ({ kind, locator: file }))
}

function allowStartUrl(config: AgentConfig, startUrl?: string): void {
  if (!startUrl) return
  try {
    const host = new URL(startUrl).hostname.toLowerCase()
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1') config.browser.blockLocalhost = false
    if (host && !config.browser.allowedDomains.includes(host)) {
      config.browser.allowedDomains = [...config.browser.allowedDomains, host]
    }
  } catch {
    // Runtime reports invalid URLs.
  }
}

function parseTaskType(value: unknown): WebBuddyTaskType | undefined {
  return value === 'explore' || value === 'apply_entry' || value === 'fill_form' || value === 'final_review'
    ? value
    : undefined
}

function parseWebBuddyMode(value: unknown): AgentRunResult['mode'] | undefined {
  return value === 'raw' || value === 'fill' || value === 'match' || value === 'alibaba-apply'
    || value === 'demo-form' || value === 'demo-research' || value === 'auto-apply'
    ? value
    : undefined
}

function normalizeRequiredUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined
  try { return new URL(value.trim()).toString() } catch { return undefined }
}

function isHumanBlocked(state: AgentRunResult['finalState']): boolean {
  return state === 'blocked' || state === 'login_required' || state === 'direct_submit_review' || state === 'stopped_at_submit'
}

function mergeResourceRefs<T extends { id: string }>(current: T[], additions: T[]): T[] {
  const result = new Map(current.map((item) => [item.id, item]))
  for (const item of additions) result.set(item.id, item)
  return [...result.values()]
}

function requestIdempotencyKey(req: IncomingMessage, body: Record<string, unknown>, fallback: string): string {
  const header = Array.isArray(req.headers['idempotency-key'])
    ? req.headers['idempotency-key'][0]
    : req.headers['idempotency-key']
  return header?.trim() || (typeof body.idempotencyKey === 'string' && body.idempotencyKey.trim()) || fallback
}

function resumeExtension(req: IncomingMessage): '.pdf' | '.json' | '.txt' {
  const header = Array.isArray(req.headers['x-file-name']) ? req.headers['x-file-name'][0] : req.headers['x-file-name']
  const ext = extname(header || '').toLowerCase()
  return ext === '.json' || ext === '.txt' || ext === '.pdf' ? ext : '.pdf'
}

function send(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) {
    if (!res.writableEnded) res.end()
    return
  }
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

function sendControlError(res: ServerResponse, error: unknown): void {
  if (error instanceof HttpError) return send(res, error.status, { error: error.message })
  if (error instanceof RunServiceError) {
    return send(res, error.code === 'RUN_NOT_FOUND' ? 404 : 409, { error: error.code, message: error.message })
  }
  if (error instanceof ControlStoreError) {
    const status = error.code.endsWith('_NOT_FOUND') ? 404
      : error.code === 'INVALID_RECORD' ? 400
        : 409
    return send(res, status, { error: error.code, message: error.message })
  }
  send(res, 500, { error: error instanceof Error ? error.message : String(error) })
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => resolveBody(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = (await readBody(req)).toString('utf8')
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('object required')
    return parsed
  } catch {
    throw new HttpError(400, 'request body must be a JSON object')
  }
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
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return null }
}

function numberQuery(value: string | undefined, fallback: number): number {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, 1000) : fallback
}

function listen(server: ReturnType<typeof createServer>, port: number): Promise<void> {
  return new Promise((resolveListen, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = () => {
      server.off('error', onError)
      resolveListen()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port)
  })
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(SOURCE_FILE)) {
  const explicitPort = Boolean(process.env.PORT)
  const initialPort = Number(process.env.PORT || 5178)
  let control: Awaited<ReturnType<typeof startWebControlServer>> | undefined
  void startWebControlServer(initialPort, explicitPort ? 0 : 20).then((started) => {
    control = started
  })
  const shutdown = () => {
    if (!control) return process.exit(0)
    void control.close().finally(() => process.exit(0))
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}
