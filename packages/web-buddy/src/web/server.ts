/**
 * Durable Web Buddy control-plane server.
 *
 * Run lifecycle, revisions, approvals and references are stored in RunStore /
 * ApprovalStore. The process keeps only live transport subscribers and active
 * controllers; neither is a source of truth.
 */
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, existsSync, readFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ApprovalService,
  ControlStoreError,
  DurableHumanGate,
  FileApprovalStore,
  FileRunStore,
  RecoveryService,
  RunService,
  RunServiceError,
  type ApprovalRecord,
  type RunRecord,
  type RunStoreEvent,
} from '../control/index.js'
import { createAgentRunController, type AgentRunController } from '../kernel/run-controller.js'
import {
  createFileMemoryLifecycle,
  type MemoryLifecycleRecord,
  type MemoryLifecycleService,
} from '../memory/index.js'
import { RISK_DECISIONS_ARTIFACT } from '../policy/risk-decisions.js'
import {
  PUBLIC_ARTIFACT_LIST_SCHEMA_VERSION,
  PUBLIC_APPROVAL_LIST_SCHEMA_VERSION,
  PUBLIC_APPROVAL_SCHEMA_VERSION,
  PUBLIC_RUN_EVENTS_SCHEMA_VERSION,
  PUBLIC_RUN_LIST_SCHEMA_VERSION,
  PUBLIC_RUN_SCHEMA_VERSION,
} from '../public/clients.js'
import { serviceScopeKey, type ServiceScope } from '../public/service-contracts.js'
import { loadConfig, type AgentConfig } from '../sdk/config.js'
import { runJobApplicationAgent, type AgentEvent, type AgentRunResult, type RunOptions } from '../sdk/orchestrator.js'
import {
  createWebTaskRuntimeDriver,
  runWebTask,
} from '../sdk/web-task.js'
import { sessionManager } from '../session/manager.js'
import { FileSessionStore } from '../session/index.js'
import {
  digestCanonicalJson,
  snapshotWebTaskInput,
  validateArtifactRef,
  type ArtifactRef,
  type JsonObject,
  type OwnerScope,
  type WebTaskInput,
  type WebTaskInputSnapshot,
  type WebTaskResult,
  type WebTaskRuntimeDriver,
} from '../task/contracts.js'
import type { WebBuddyTaskType } from '../workflow/completion-gate.js'
import INDEX_HTML from './public/index.html'
import VENUE_BOOKING_HTML from './public/venue-booking.html'
import {
  WebServiceSecurityBoundary,
  type ServicePrincipal,
  type WebServiceSecurityOptions,
} from './service-security.js'

const SOURCE_FILE = fileURLToPath(import.meta.url)
const __dirname = fileURLToPath(new URL('.', import.meta.url))
const TERMINAL_STATES = new Set(['completed', 'failed', 'cancelled'])
const MAX_LIVE_EVENTS_PER_RUN = 1000

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
  gate: DurableHumanGate
  runRevision: number
  attempt: number
  settled?: Promise<void>
}

export interface WebControlServerOptions {
  controlStoreDir?: string
  memoryDir?: string
  disableExecution?: boolean
  serviceSecurity?: WebServiceSecurityOptions
  /** Test/embedding seam for runtime outcomes; runWebTask still owns validation and completion. */
  webTaskRuntimeDriver?: WebTaskRuntimeDriver
}

export function createWebControlServer(options: WebControlServerOptions = {}) {
  const controlStoreDir = options.controlStoreDir
    ? resolve(options.controlStoreDir)
    : resolve(process.env.WEB_BUDDY_CONTROL_STORE_DIR || join(outputDir(), 'control-plane'))
  const runStore = new FileRunStore({ rootDir: controlStoreDir })
  const runService = new RunService(runStore)
  const approvalService = new ApprovalService(new FileApprovalStore({ rootDir: controlStoreDir }))
  const security = new WebServiceSecurityBoundary({
    rootDir: controlStoreDir,
    options: options.serviceSecurity,
  })
  const memoryRoot = resolve(
    options.memoryDir
      ?? process.env.WEB_BUDDY_MEMORY_DIR
      ?? join(controlStoreDir, 'memory'),
  )
  const sessionStore = new FileSessionStore({
    rootDir: join(outputDir(), 'sessions'),
    sanitize: (value) => security.sanitize(value),
  })
  const recoveryService = new RecoveryService(runService, approvalService, {
    canRestoreSession: async (record) => {
      if (!record.sessionRef) return false
      const session = await sessionStore.get(record.sessionRef.id)
      return Boolean(
        session
        && session.sessionId === record.sessionRef.id
        && session.runId === record.runId,
      )
    },
  })
  const channels = new Map<string, LiveChannel>()
  const executions = new Map<string, LiveExecution>()
  const memories = new Map<string, MemoryLifecycleService>()

  const mergeConfig = (base: AgentConfig): AgentConfig => ({
    ...base,
    model: {
      ...base.model,
      apiKey: null,
      authToken: null,
    },
  })

  const runtimeConfig = async (): Promise<AgentConfig> => {
    const config = mergeConfig(loadConfig())
    await security.secretProvider.injectModelCredential(config)
    return config
  }

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
    const sanitized = security.sanitize(event)
    channel.events.push(sanitized)
    if (channel.events.length > MAX_LIVE_EVENTS_PER_RUN) {
      channel.events.splice(0, channel.events.length - MAX_LIVE_EVENTS_PER_RUN)
    }
    for (const subscriber of channel.subscribers) {
      subscriber.write(`data: ${JSON.stringify(sanitized)}\n\n`)
    }
  }

  const endRun = (record: RunRecord, result?: AgentRunResult, error?: string) => {
    const channel = channelFor(record.runId)
    const terminal = JSON.stringify(security.sanitize({
      _end: true,
      state: record.state,
      error,
      finalState: result?.finalState,
      message: result?.message,
      summary: result?.summary,
    }))
    for (const subscriber of channel.subscribers) {
      subscriber.write(`data: ${terminal}\n\n`)
      subscriber.end()
    }
    channel.subscribers.clear()
    channels.delete(record.runId)
  }

  const endWebTaskRun = (record: RunRecord, result?: WebTaskResult, error?: string) => {
    const channel = channelFor(record.runId)
    const terminal = JSON.stringify(security.sanitize({
      _end: true,
      state: record.state,
      error,
      status: result?.status,
      summary: result?.summary,
    }))
    for (const subscriber of channel.subscribers) {
      subscriber.write(`data: ${terminal}\n\n`)
      subscriber.end()
    }
    channel.subscribers.clear()
    channels.delete(record.runId)
  }

  async function launch(record: RunRecord, launchOptions = launchOptionsFromRecord(record)): Promise<void> {
    if (options.disableExecution) return
    if (executionAdapterFor(record) !== 'recruiting_compat') {
      throw new HttpError(409, 'Stored run is not bound to the recruiting compatibility adapter.')
    }
    const scope = scoped(record.ownerScope)
    const controller = createAgentRunController()
    const running = await runService.transition(record.runId, {
      to: 'running',
      idempotencyKey: `launch:${record.runRevision}:${record.attempt}`,
      expectedRunRevision: record.runRevision,
      expectedAttempt: record.attempt,
    }, scope)
    const sessionId = launchOptions.restoredSessionId ?? `control-${running.runId}-a${running.attempt}`
    const gate = new DurableHumanGate({
      runs: runService,
      approvals: approvalService,
      runId: running.runId,
      runRevision: running.runRevision,
      attempt: running.attempt,
      taskContract: running.inputSnapshot.contract,
      sessionId,
      abortSignal: controller.signal,
      ...(running.ownerScope ? { ownerScope: running.ownerScope } : {}),
    })
    executions.set(record.runId, {
      controller,
      gate,
      runRevision: running.runRevision,
      attempt: running.attempt,
    })

    const config = await runtimeConfig()
    config.human.mode = 'auto'
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
      gate,
      sessionId,
      persistenceSanitizer: (value) => security.sanitize(value),
      ...(launchOptions.restoredSessionId ? { restoredSessionId: launchOptions.restoredSessionId } : {}),
      onSessionReady: async (session) => {
        await runService.attachSession(running.runId, {
          schemaVersion: 'session-ref/v1',
          provider: 'file-session-store',
          id: session.sessionId,
          runId: running.runId,
          attempt: running.attempt,
        }, `session:${running.runRevision}:${running.attempt}:${session.sessionId}`, scope)
      },
      onEvent: (event) => emitRun(running.runId, event),
    }

    const settled = runJobApplicationAgent(runtimeOptions)
      .then((result) => settleExecution(running, controller, result))
      .catch((error) => settleExecution(running, controller, undefined, String(error)))
      .finally(() => {
        const active = executions.get(running.runId)
        if (active?.runRevision === running.runRevision && active.attempt === running.attempt) {
          executions.delete(running.runId)
        }
      })
    const active = executions.get(running.runId)
    if (active) active.settled = settled
    void settled
  }

  async function launchWebTask(record: RunRecord): Promise<void> {
    if (options.disableExecution) return
    if (executionAdapterFor(record) !== 'generic_web_task') {
      throw new HttpError(409, 'Stored run is not bound to the generic WebTask adapter.')
    }
    assertStoredInputDigest(record)
    const scope = scoped(record.ownerScope)
    const controller = createAgentRunController()
    const running = await runService.transition(record.runId, {
      to: 'running',
      idempotencyKey: `launch-web-task:${record.runRevision}:${record.attempt}`,
      expectedRunRevision: record.runRevision,
      expectedAttempt: record.attempt,
    }, scope)
    const sessionId = `control-${running.runId}-a${running.attempt}`
    const gate = new DurableHumanGate({
      runs: runService,
      approvals: approvalService,
      runId: running.runId,
      runRevision: running.runRevision,
      attempt: running.attempt,
      taskContract: running.inputSnapshot.contract,
      sessionId,
      abortSignal: controller.signal,
      ...(running.ownerScope ? { ownerScope: running.ownerScope } : {}),
    })
    executions.set(running.runId, {
      controller,
      gate,
      runRevision: running.runRevision,
      attempt: running.attempt,
    })
    const config = await runtimeConfig()
    config.human.mode = 'auto'
    const driver = options.webTaskRuntimeDriver ?? createWebTaskRuntimeDriver({
      config,
      gate,
      controller,
      sessionId,
      durableSession: true,
      persistenceSanitizer: (value) => security.sanitize(value),
      onSessionReady: async (session) => {
        await runService.attachSession(running.runId, {
          schemaVersion: 'session-ref/v1',
          provider: 'file-session-store',
          id: session.sessionId,
          runId: running.runId,
          attempt: running.attempt,
        }, `web-task-session:${running.runRevision}:${running.attempt}:${session.sessionId}`, scope)
      },
    })
    const input = webTaskInputFromRecord(running, driver, (event) => {
      emitRun(running.runId, {
        phase: event.type,
        level: event.type === 'run_failed' ? 'error'
          : event.type === 'run_completed' ? 'done'
            : event.type === 'run_blocked' ? 'gate'
              : 'info',
        message: event.snapshot?.reason ?? event.type,
      })
    })
    const settled = runWebTask(input)
      .then((result) => settleWebTaskExecution(running, controller, result))
      .catch((error) => settleWebTaskExecution(running, controller, undefined, String(error)))
      .finally(() => {
        const active = executions.get(running.runId)
        if (active?.runRevision === running.runRevision && active.attempt === running.attempt) {
          executions.delete(running.runId)
        }
      })
    const active = executions.get(running.runId)
    if (active) active.settled = settled
    void settled
  }

  async function settleExecution(
    launched: RunRecord,
    controller: AgentRunController,
    result?: AgentRunResult,
    error?: string,
  ): Promise<void> {
    await security.redactTraceFiles([
      join(outputDir(), launched.runId),
      join(outputDir(), 'traces', `run_${launched.runId}`),
    ])
    const safeError = error === undefined ? undefined : String(security.sanitize(error))
    const safeMessage = result?.message === undefined
      ? undefined
      : String(security.sanitize(result.message))
    const scope = scoped(launched.ownerScope)
    let current = await runService.get(launched.runId, scope)
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
        terminalState: safeError ? 'failed' : 'completed',
        reason: safeError ?? safeMessage,
        resourceRefs: [traceRef],
        idempotencyKey: `late-result:${launched.runRevision}:${launched.attempt}`,
        ...(launched.ownerScope ? { ownerScope: launched.ownerScope } : {}),
      })
      endRun(rejected.record, result, safeError)
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
      }, `pause-ack:${launched.runRevision}:${launched.attempt}`, scope)
      endRun(current, result, safeError)
      return
    }

    if (current.state === 'cancelling' || controller.signal.aborted) {
      const decision = await runService.acceptResult({
        runId: launched.runId,
        runRevision: launched.runRevision,
        attempt: launched.attempt,
        terminalState: 'cancelled',
        reason: String(security.sanitize(controller.reason ?? 'Cancelled by user.')),
        resourceRefs: [traceRef],
        idempotencyKey: `cancelled:${launched.runRevision}:${launched.attempt}`,
        ...(launched.ownerScope ? { ownerScope: launched.ownerScope } : {}),
      })
      endRun(decision.record, result, safeError)
      return
    }

    if (!error && result && isHumanBlocked(result.finalState)) {
      current = await runService.transition(launched.runId, {
        to: 'blocked_on_human',
        reason: safeMessage,
        idempotencyKey: `blocked:${launched.runRevision}:${launched.attempt}`,
        expectedRunRevision: launched.runRevision,
        expectedAttempt: launched.attempt,
        update: (record) => ({
          resourceRefs: mergeResourceRefs(record.resourceRefs, [traceRef]),
        }),
      }, scope)
      endRun(current, result)
      return
    }

    const decision = await runService.acceptResult({
      runId: launched.runId,
      runRevision: launched.runRevision,
      attempt: launched.attempt,
      terminalState: error || result?.finalState === 'error' ? 'failed' : 'completed',
      reason: safeError ?? safeMessage,
      resourceRefs: [traceRef],
      idempotencyKey: `result:${launched.runRevision}:${launched.attempt}`,
      ...(launched.ownerScope ? { ownerScope: launched.ownerScope } : {}),
    })
    endRun(decision.record, result, safeError)
  }

  async function settleWebTaskExecution(
    launched: RunRecord,
    controller: AgentRunController,
    result?: WebTaskResult,
    error?: string,
  ): Promise<void> {
    let safeError = error === undefined ? undefined : String(security.sanitize(error))
    let artifactRefs: ArtifactRef[] = []
    if (!safeError && result) {
      try {
        validateWebTaskServiceResult(result, launched, security)
        artifactRefs = result.artifacts.map((artifact) => structuredClone(artifact))
      } catch (validationError) {
        safeError = String(security.sanitize(
          validationError instanceof Error ? validationError.message : String(validationError),
        ))
      }
    }
    const safeSummary = result?.summary === undefined
      ? undefined
      : String(security.sanitize(result.summary))
    const scope = scoped(launched.ownerScope)
    let current = await runService.get(launched.runId, scope)
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
        terminalState: safeError || result?.status === 'failed' ? 'failed'
          : result?.status === 'cancelled' ? 'cancelled'
            : 'completed',
        reason: safeError ?? safeSummary,
        idempotencyKey: `late-web-task-result:${launched.runRevision}:${launched.attempt}`,
        ...(launched.ownerScope ? { ownerScope: launched.ownerScope } : {}),
      })
      endWebTaskRun(rejected.record, result, safeError)
      return
    }

    if (current.state === 'pausing' || controller.pauseRequested) {
      current = await runService.acknowledgePause(launched.runId, {
        schemaVersion: 'safe-turn-boundary-ref/v1',
        runId: launched.runId,
        runRevision: launched.runRevision,
        attempt: launched.attempt,
        turnId: `web-task-attempt-${launched.attempt}-settled`,
        actionSeq: channelFor(launched.runId).events.length,
        observedAt: new Date().toISOString(),
        ...(result?.sessionRef ? { sessionRef: result.sessionRef } : {}),
        ...(result?.checkpointRef ? { checkpointRef: result.checkpointRef } : {}),
      }, `web-task-pause-ack:${launched.runRevision}:${launched.attempt}`, scope, {
        artifactRefs,
        resourceRefs: [traceRef],
      })
      endWebTaskRun(current, result, safeError)
      return
    }

    if (current.state === 'cancelling' || controller.signal.aborted || result?.status === 'cancelled') {
      const decision = await runService.acceptResult({
        runId: launched.runId,
        runRevision: launched.runRevision,
        attempt: launched.attempt,
        terminalState: 'cancelled',
        reason: String(security.sanitize(controller.reason ?? safeSummary ?? 'Cancelled by user.')),
        artifactRefs,
        resourceRefs: [traceRef],
        idempotencyKey: `web-task-cancelled:${launched.runRevision}:${launched.attempt}`,
        ...(launched.ownerScope ? { ownerScope: launched.ownerScope } : {}),
      })
      endWebTaskRun(decision.record, result, safeError)
      return
    }

    if (!safeError && result?.status === 'blocked') {
      current = await runService.transition(launched.runId, {
        to: 'blocked_on_human',
        reason: safeSummary,
        idempotencyKey: `web-task-blocked:${launched.runRevision}:${launched.attempt}`,
        expectedRunRevision: launched.runRevision,
        expectedAttempt: launched.attempt,
        update: (record) => ({
          artifactRefs: mergeResourceRefs(record.artifactRefs, artifactRefs),
          resourceRefs: mergeResourceRefs(record.resourceRefs, [traceRef]),
        }),
      }, scope)
      endWebTaskRun(current, result)
      return
    }

    const decision = await runService.acceptResult({
      runId: launched.runId,
      runRevision: launched.runRevision,
      attempt: launched.attempt,
      terminalState: safeError || result?.status !== 'completed' ? 'failed' : 'completed',
      reason: safeError ?? safeSummary,
      artifactRefs,
      resourceRefs: [traceRef],
      idempotencyKey: `web-task-result:${launched.runRevision}:${launched.attempt}`,
      ...(launched.ownerScope ? { ownerScope: launched.ownerScope } : {}),
    })
    endWebTaskRun(decision.record, result, safeError)
  }

  async function createRun(
    body: Record<string, unknown>,
    idempotencyKey: string,
    principal: ServicePrincipal,
    requestId: string,
  ): Promise<RunRecord> {
    rejectInlineSecrets(body, security)
    const ownerScope = security.ownerScope(principal)
    const scope = scoped(ownerScope)
    const runId = `web-${createHash('sha256')
      .update(`${serviceScopeKey(principal.scope)}\u0000${idempotencyKey}`)
      .digest('hex')
      .slice(0, 24)}`
    const prepared = prepareRunInput(
      body,
      runId,
      ownerScope,
      process.env.WEB_BUDDY_ALLOW_PRIVATE_NETWORK_FOR_TESTING === 'true',
    )
    const quota = await security.reserveRun(principal, {
      idempotencyKey,
      requestDigest: digestCanonicalJson({
        scope: principal.scope,
        body,
      }),
    })
    if (quota.decision === 'deny') {
      await security.audit({
        principal,
        requestId,
        action: 'quota.deny',
        target: { kind: 'quota' },
        result: 'denied',
        reasonCode: quota.reasonCode,
      })
      throw new HttpError(
        quota.reasonCode === 'idempotency_conflict' ? 409 : 429,
        quota.reasonCode,
      )
    }
    if (prepared.kind === 'snapshot') {
      const existing = await runService.get(runId, scope)
      if (existing) {
        if (existing.inputDigest !== prepared.snapshot.sha256) {
          throw new ControlStoreError('IDEMPOTENCY_CONFLICT', 'Create idempotency key was reused with different run input.')
        }
        return existing
      }
      const created = await runService.create(prepared.snapshot, { idempotencyKey })
      channelFor(runId)
      if (!created.replayed) await launchWebTask(created.record)
      return (await runService.get(runId, scope)) ?? created.record
    }
    const launchOptions = prepared.launchOptions
    const metadata: JsonObject = {
      executionAdapter: 'recruiting_compat',
      mode: launchOptions.mode,
      headless: launchOptions.headless ?? false,
      restartSafe: launchOptions.restartSafe,
      requiresCurrentResumeUpload: launchOptions.requiresCurrentResumeUpload ?? false,
      ...(launchOptions.taskType ? { taskType: launchOptions.taskType } : {}),
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
      ...(ownerScope ? { ownerScope } : {}),
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
    const existing = await runService.get(runId, scope)
    if (existing) {
      if (existing.inputDigest !== snapshot.sha256) {
        throw new ControlStoreError('IDEMPOTENCY_CONFLICT', 'Create idempotency key was reused with different run input.')
      }
      return existing
    }
    const created = await runService.create(snapshot, { idempotencyKey })
    channelFor(runId)
    if (!created.replayed) await launch(created.record, launchOptions)
    return (await runService.get(runId, scope)) ?? created.record
  }

  const memoryFor = (principal: ServicePrincipal): MemoryLifecycleService | undefined => {
    if (principal.scope.kind !== 'tenant') return undefined
    const key = serviceScopeKey(principal.scope)
    let service = memories.get(key)
    if (!service) {
      service = createFileMemoryLifecycle({
        root: memoryRoot,
        actorScope: {
          tenantId: principal.scope.tenantId,
          userId: principal.scope.userId,
          runId: `service-${createHash('sha256').update(key).digest('hex').slice(0, 24)}`,
        },
      }).service
      memories.set(key, service)
    }
    return service
  }

  async function recoverStartupRuns(): Promise<void> {
    await recoveryService.recoverStartupRuns()
    for (const ownerScope of await runStore.listOwnerScopes()) {
      await recoveryService.recoverStartupRuns({ ownerScope })
    }
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

    if (!path.startsWith('/api/')) {
      send(res, 404, { error: 'not_found' })
      return
    }

    const principal = await security.authenticate(req, path)
    if (!principal) {
      send(res, 401, { error: 'unauthorized' })
      return
    }
    assertRequestedScope(url, principal)
    const ownerScope = security.ownerScope(principal)
    const storeScope = scoped(ownerScope)
    const requestId = requestIdentifier(req)
    const respond = (status: number, body: unknown) => send(
      res,
      status,
      security.sanitize(body),
    )
    const denyResource = async (target: {
      kind: 'run' | 'approval' | 'artifact' | 'trace' | 'memory' | 'api'
      id?: string
    }) => {
      await security.audit({
        principal,
        requestId,
        action: 'auth.deny',
        target,
        result: 'denied',
        reasonCode: 'resource_not_visible',
      })
      respond(404, { error: 'resource_not_visible' })
    }

    if (path === '/api/config' && req.method === 'GET') {
      const config = mergeConfig(loadConfig())
      respond(200, {
        provider: config.model.provider,
        baseUrl: config.model.baseUrl,
        name: config.model.name,
        credentialConfigured: security.secretProvider.credentialConfigured(),
        alibabaCareersUrl: config.alibabaCareersUrl,
      })
      return
    }
    if (path === '/api/config' && req.method === 'POST') {
      respond(403, {
        error: 'server_config_required',
        message: 'Model endpoints and credentials are controlled by server-side configuration.',
      })
      return
    }

    if ((path === '/api/run' || path === '/api/runs') && req.method === 'POST') {
      const body = await readJsonBody(req)
      assertBodyScope(body, principal)
      if (path === '/api/run' && body.schemaVersion === 'run-client-create/v1') {
        return respond(400, {
          error: 'generic_web_task_requires_api_runs',
          message: 'Use POST /api/runs for run-client-create/v1; /api/run is the deprecated recruiting compatibility route.',
        })
      }
      const externalKey = path === '/api/runs'
        ? requireIdempotencyKey(req, body)
        : requestIdempotencyKey(req, body, `create:${randomUUID()}`)
      const idempotencyKey = security.bindIdempotencyKey(principal, externalKey)
      const run = await createRun(body, idempotencyKey, principal, requestId)
      await security.audit({
        principal,
        requestId,
        action: 'run.create',
        target: { kind: 'run', id: run.runId },
        result: 'succeeded',
      })
      respond(201, projectPublicRun(run, principal.scope))
      return
    }

    if (path === '/api/runs' && req.method === 'GET') {
      const page = await runService.list({
        ...(ownerScope ? { ownerScope } : {}),
        limit: numberQuery(query('limit'), 100),
      })
      respond(200, {
        schemaVersion: PUBLIC_RUN_LIST_SCHEMA_VERSION,
        items: page.items.map((run) => projectPublicRun(run, principal.scope)),
        ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
      })
      return
    }

    const runMatch = path.match(/^\/api\/runs\/([^/]+)$/)
    if (runMatch && req.method === 'GET') {
      const runId = decodeURIComponent(runMatch[1])
      const run = await runService.get(runId, storeScope)
      if (!run) return denyResource({ kind: 'run' })
      respond(200, projectPublicRun(run, principal.scope))
      return
    }

    const runEventsMatch = path.match(/^\/api\/runs\/([^/]+)\/events$/)
    if (runEventsMatch && req.method === 'GET') {
      const runId = decodeURIComponent(runEventsMatch[1])
      const run = await runService.get(runId, storeScope)
      if (!run) return denyResource({ kind: 'run' })
      const events = await runService.events(runId, {
        ...(ownerScope ? { ownerScope } : {}),
        ...(query('afterSequence') ? { afterSequence: numberQuery(query('afterSequence'), 0) } : {}),
      })
      respond(200, {
        schemaVersion: PUBLIC_RUN_EVENTS_SCHEMA_VERSION,
        scope: principal.scope,
        runId,
        items: events.items.map(projectRunEvent),
      })
      return
    }

    const controlMatch = path.match(/^\/api\/runs\/([^/]+)\/(pause|resume|cancel)$/)
    if (controlMatch && req.method === 'POST') {
      const runId = decodeURIComponent(controlMatch[1])
      const control = controlMatch[2]
      const body = await readJsonBody(req)
      assertBodyScope(body, principal)
      const visible = await runService.get(runId, storeScope)
      if (!visible) return denyResource({ kind: 'run' })
      const expectedRevision = requireExpectedRevision(body)
      if (expectedRevision !== visible.runRevision) {
        throw new ControlStoreError(
          'REVISION_CONFLICT',
          'Run revision does not match the requested control revision.',
          expectedRevision,
          visible.runRevision,
        )
      }
      const idempotencyKey = security.bindIdempotencyKey(
        principal,
        requireIdempotencyKey(req, body),
      )
      if (control === 'pause') {
        const run = await runService.requestPause(runId, idempotencyKey, storeScope)
        executions.get(runId)?.controller.requestPause('Pause requested from control plane.')
        await security.audit({
          principal,
          requestId,
          action: 'run.pause',
          target: { kind: 'run', id: runId },
          result: 'succeeded',
        })
        respond(202, projectPublicRun(run, principal.scope))
        return
      }
      if (control === 'cancel') {
        const run = await runService.requestCancel(runId, idempotencyKey, storeScope)
        executions.get(runId)?.controller.abort('Cancel requested from control plane.')
        await approvalService.cancelPendingForRun(
          runId,
          'Run was cancelled while awaiting approval.',
          `cancel-approval-fence:${run.runRevision}:${run.attempt}`,
          storeScope,
        )
        await security.audit({
          principal,
          requestId,
          action: 'run.cancel',
          target: { kind: 'run', id: runId },
          result: 'succeeded',
        })
        respond(202, projectPublicRun(run, principal.scope))
        return
      }
      const current = visible
      const restartSafe = current.inputSnapshot.goal.metadata?.restartSafe === true
      const restoredSessionId = current.sessionRef?.id ?? current.lastSafeBoundary?.sessionRef?.id
      if (!restartSafe || !restoredSessionId) {
        return respond(409, {
          error: 'resume_requires_safe_session',
          message: 'Resume requires a durable session plus an explicit read-only restart contract; the server will not replay a prior write action.',
        })
      }
      await approvalService.cancelPendingForRun(
        runId,
        'Approval invalidated when resume created a new run revision.',
        `resume-approval-fence:${current.runRevision}:${current.attempt}`,
        storeScope,
      )
      const resuming = await runService.resume(runId, idempotencyKey, storeScope)
      if (executionAdapterFor(resuming) !== 'recruiting_compat') {
        return respond(409, {
          error: 'generic_resume_not_supported',
          message: 'Generic service runs are not restartable until a durable generic checkpoint adapter is available.',
        })
      }
      await launch(resuming, { ...launchOptionsFromRecord(resuming), restoredSessionId })
      const resumed = (await runService.get(runId, storeScope)) ?? resuming
      await security.audit({
        principal,
        requestId,
        action: 'run.resume',
        target: { kind: 'run', id: runId },
        result: 'succeeded',
      })
      respond(202, projectPublicRun(resumed, principal.scope))
      return
    }

    if (path === '/api/stop' && req.method === 'POST') {
      const runId = query('id')
      if (!runId) return respond(400, { error: 'runId is required' })
      if (!await runService.get(runId, storeScope)) return denyResource({ kind: 'run' })
      const run = await runService.requestCancel(
        runId,
        `legacy-stop:${runId}:${randomUUID()}`,
        storeScope,
      )
      executions.get(runId)?.controller.abort('Cancel requested from legacy stop endpoint.')
      await approvalService.cancelPendingForRun(
        runId,
        'Run was cancelled from the legacy stop endpoint.',
        `legacy-cancel-approval-fence:${run.runRevision}:${run.attempt}`,
        storeScope,
      )
      await security.audit({
        principal,
        requestId,
        action: 'run.cancel',
        target: { kind: 'run', id: runId },
        result: 'succeeded',
      })
      respond(202, { ok: true, run: projectPublicRun(run, principal.scope) })
      return
    }

    if (path === '/api/events' && req.method === 'GET') {
      const runId = query('id')
      const run = runId ? await runService.get(runId, storeScope) : undefined
      if (!runId || !run) return denyResource({ kind: 'run' })
      const channel = channels.get(runId) ?? { events: [], subscribers: new Set<ServerResponse>() }
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
      channels.set(runId, channel)
      channel.subscribers.add(res)
      req.on('close', () => channel.subscribers.delete(res))
      return
    }

    if ((path === '/api/trace' || path.match(/^\/api\/runs\/[^/]+\/trace$/)) && req.method === 'GET') {
      const runId = path === '/api/trace' ? query('id') : decodeURIComponent(path.split('/')[3])
      if (!runId) return respond(400, { error: 'runId is required' })
      const run = await runService.get(runId, storeScope)
      if (!run) return denyResource({ kind: 'trace' })
      await security.audit({
        principal,
        requestId,
        action: 'trace.read',
        target: { kind: 'trace', id: runId },
        result: 'succeeded',
      })
      respond(200, projectTrace(run, principal.scope))
      return
    }

    const artifactMatch = path.match(/^\/api\/runs\/([^/]+)\/artifacts$/)
    if (artifactMatch && req.method === 'GET') {
      const runId = decodeURIComponent(artifactMatch[1])
      const run = await runService.get(runId, storeScope)
      if (!run) return denyResource({ kind: 'artifact' })
      await security.audit({
        principal,
        requestId,
        action: 'artifact.read',
        target: { kind: 'artifact', id: runId },
        result: 'succeeded',
      })
      respond(200, {
        schemaVersion: PUBLIC_ARTIFACT_LIST_SCHEMA_VERSION,
        scope: principal.scope,
        runId: run.runId,
        items: run.artifactRefs.map((artifact) => security.sanitize({
          ...artifact,
          locator: `artifact:${encodeURIComponent(artifact.id)}`,
        })),
      })
      return
    }

    if (path === '/api/approvals' && req.method === 'GET') {
      const page = await approvalService.list({
        ...(ownerScope ? { ownerScope } : {}),
        ...(query('runId') ? { runId: query('runId') } : {}),
        statuses: ['pending'],
        limit: numberQuery(query('limit'), 100),
      })
      respond(200, {
        schemaVersion: PUBLIC_APPROVAL_LIST_SCHEMA_VERSION,
        items: page.items.map((approval) => projectPublicApproval(approval, principal.scope)),
        ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
      })
      return
    }

    const approvalMatch = path.match(/^\/api\/approvals\/([^/]+)\/resolve$/)
    if (approvalMatch && req.method === 'POST') {
      const approvalId = decodeURIComponent(approvalMatch[1])
      const body = await readJsonBody(req)
      assertBodyScope(body, principal)
      const approval = await approvalService.get(approvalId, storeScope)
      if (!approval) {
        await security.audit({
          principal,
          requestId,
          action: 'approval.resolve',
          target: { kind: 'approval', id: approvalId },
          result: 'denied',
          reasonCode: 'resource_not_visible',
        })
        return denyResource({ kind: 'approval' })
      }
      const approvalRun = await runService.get(approval.runId, storeScope)
      if (!approvalRun
        || approvalRun.runRevision !== approval.runRevision
        || approvalRun.attempt !== approval.attempt) {
        throw new ControlStoreError(
          'BINDING_MISMATCH',
          'Approval belongs to a stale run revision/attempt and cannot be resolved.',
        )
      }
      const expectedRevision = requireExpectedRevision(body)
      if (expectedRevision !== approval.runRevision) {
        throw new ControlStoreError(
          'REVISION_CONFLICT',
          'Approval run revision does not match the requested revision.',
          expectedRevision,
          approval.runRevision,
        )
      }
      const decision = body.decision === 'approved' || body.decision === 'denied' ? body.decision : undefined
      if (!decision) return respond(400, { error: 'decision must be approved or denied' })
      const idempotencyKey = security.bindIdempotencyKey(
        principal,
        requireIdempotencyKey(req, body),
      )
      const record = await approvalService.resolve({
        approvalId,
        ...(ownerScope ? { ownerScope } : {}),
        expectedRecordRevision: typeof body.expectedRecordRevision === 'number'
          ? body.expectedRecordRevision
          : approval.status === 'pending'
            ? approval.recordRevision
            : Math.max(0, approval.recordRevision - 1),
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
        idempotencyKey,
        nonce: `approval-nonce:${createHash('sha256').update(idempotencyKey).digest('hex')}`,
        expiresAt: approval.expiresAt,
      })
      const resumedLive = await executions.get(approval.runId)?.gate.resolveLive(approvalId, decision) ?? false
      await security.audit({
        principal,
        requestId,
        action: 'approval.resolve',
        target: { kind: 'approval', id: approvalId },
        result: 'succeeded',
        metadata: { resumedLive },
      })
      respond(200, projectPublicApproval(record, principal.scope))
      return
    }

    if (path === '/api/memories' && req.method === 'GET') {
      const service = memoryFor(principal)
      const items = service && principal.scope.kind === 'tenant'
        ? await service.list({
            schemaVersion: 'memory-lifecycle-list/v2',
            scope: {
              kind: 'user',
              tenantId: principal.scope.tenantId,
              userId: principal.scope.userId,
            },
          })
        : []
      await security.audit({
        principal,
        requestId,
        action: 'memory.read',
        target: { kind: 'memory' },
        result: 'succeeded',
      })
      respond(200, {
        schemaVersion: 'public-memory-list/v1',
        scope: principal.scope,
        items: items.map(projectMemory),
      })
      return
    }

    const memoryMatch = path.match(/^\/api\/memories\/([^/]+)$/)
    if (memoryMatch && req.method === 'GET') {
      const service = memoryFor(principal)
      const entryId = decodeURIComponent(memoryMatch[1])
      const record = service && principal.scope.kind === 'tenant'
        ? await service.get({
            schemaVersion: 'memory-lifecycle-get/v2',
            entryId,
            scope: {
              kind: 'user',
              tenantId: principal.scope.tenantId,
              userId: principal.scope.userId,
            },
          })
        : undefined
      if (!record) return denyResource({ kind: 'memory' })
      await security.audit({
        principal,
        requestId,
        action: 'memory.read',
        target: { kind: 'memory', id: entryId },
        result: 'succeeded',
      })
      respond(200, projectMemory(record))
      return
    }

    if (path === '/api/shot' && req.method === 'GET') {
      const runId = query('id')
      const name = normalize(query('name') || '')
      if (!runId || name.includes('..') || name.includes('/') || name.includes('\\')) {
        return respond(400, { error: 'bad shot name' })
      }
      if (!await runService.get(runId, storeScope)) return denyResource({ kind: 'artifact' })
      const root = outputDir()
      const file = join(root, runId, name)
      if (!file.startsWith(root) || !existsSync(file)) return respond(404, { error: 'not found' })
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' })
      createReadStream(file).pipe(res)
      return
    }

    if (path === '/api/resume' && req.method === 'POST') {
      respond(410, {
        error: 'secret_provider_required',
        message: 'Sensitive profile material must be supplied through a dedicated server-side provider.',
      })
      return
    }

    respond(404, { error: 'not_found' })
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((error) => sendControlError(res, error, security))
  })

  return {
    server,
    runService,
    approvalService,
    recoveryService,
    serviceSecurity: security,
    controlStoreDir,
    recoverStartupRuns,
    async close() {
      const active = [...executions.values()]
      for (const execution of active) execution.controller.abort('Web control server is shutting down.')
      await Promise.allSettled(
        active
          .map((execution) => execution.settled)
          .filter((settled): settled is Promise<void> => Boolean(settled)),
      )
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

type PreparedRunInput =
  | { kind: 'legacy'; launchOptions: LegacyLaunchOptions }
  | { kind: 'snapshot'; snapshot: WebTaskInputSnapshot }

function prepareRunInput(
  body: Record<string, unknown>,
  runId: string,
  ownerScope?: OwnerScope,
  allowPrivateNetwork = false,
): PreparedRunInput {
  if (body.schemaVersion !== 'run-client-create/v1') {
    return { kind: 'legacy', launchOptions: parseLaunchOptions(body, allowPrivateNetwork) }
  }
  const input = plainRecord(body.input, 'input')
  if (input.schemaVersion !== 'web-task-input-snapshot/v1') {
    throw new HttpError(400, 'input must be web-task-input-snapshot/v1')
  }
  if (input.sessionRef !== undefined) {
    throw new HttpError(400, 'service create does not accept a pre-bound SessionRef')
  }
  if (Array.isArray(input.contextProviders) && input.contextProviders.length > 0) {
    throw new HttpError(400, 'service create requires server-registered Context Providers')
  }
  if (input.ownerScope !== undefined
    && digestCanonicalJson(input.ownerScope) !== digestCanonicalJson(ownerScope ?? null)) {
    throw new HttpError(403, 'scope_mismatch')
  }
  const startUrl = input.startUrl === undefined
    ? undefined
    : normalizeRequiredUrl(input.startUrl, allowPrivateNetwork)
  if (input.startUrl !== undefined && !startUrl) {
    throw new HttpError(400, 'startUrl must use HTTP(S) and must not target a private network')
  }
  const goal = plainRecord(input.goal, 'input.goal')
  const callerMetadata = goal.metadata === undefined
    ? {}
    : plainRecord(goal.metadata, 'input.goal.metadata')
  const candidate: WebTaskInput = {
    schemaVersion: 'web-task-input/v1',
    goal: {
      instruction: typeof goal.instruction === 'string' ? goal.instruction : '',
      ...(typeof goal.scenario === 'string' ? { scenario: goal.scenario } : {}),
      metadata: {
        ...callerMetadata,
        executionAdapter: 'generic_web_task',
        restartSafe: false,
      } as JsonObject,
    },
    contract: input.contract as WebTaskInput['contract'],
    ...(startUrl ? { startUrl } : {}),
    ...(Array.isArray(input.contextItems)
      ? { contextItems: input.contextItems as WebTaskInput['contextItems'] }
      : {}),
    ...(input.policy ? { policy: input.policy as WebTaskInput['policy'] } : {}),
    runId,
    revision: typeof input.revision === 'number' ? input.revision : 0,
    ...(ownerScope ? { ownerScope } : {}),
  }
  return {
    kind: 'snapshot',
    snapshot: snapshotWebTaskInput(candidate, runId),
  }
}

function rejectInlineSecrets(
  body: Record<string, unknown>,
  security: WebServiceSecurityBoundary,
): void {
  if ('resumePath' in body) {
    throw new HttpError(400, 'sensitive_profile_requires_provider')
  }
  const sanitized = security.sanitize(body)
  if (digestCanonicalJson(body) !== digestCanonicalJson(sanitized)) {
    throw new HttpError(400, 'secret_material_not_allowed')
  }
  if (body.schemaVersion === 'run-client-create/v1') {
    const input = body.input
    const contextItems = input && typeof input === 'object' && !Array.isArray(input)
      ? (input as Record<string, unknown>).contextItems
      : undefined
    if (Array.isArray(contextItems) && contextItems.some((item) => (
      item && typeof item === 'object' && !Array.isArray(item)
      && ((item as Record<string, unknown>).sensitivity === 'auth'
        || (item as Record<string, unknown>).sensitivity === 'secret')
    ))) {
      throw new HttpError(400, 'secret_context_requires_provider')
    }
  }
}

function assertRequestedScope(url: URL, principal: ServicePrincipal): void {
  const tenantId = url.searchParams.get('tenantId')
  const userId = url.searchParams.get('userId')
  if (!tenantId && !userId) return
  if (principal.scope.kind !== 'tenant'
    || (tenantId && tenantId !== principal.scope.tenantId)
    || (userId && userId !== principal.scope.userId)) {
    throw new HttpError(403, 'scope_mismatch')
  }
}

function assertBodyScope(body: Record<string, unknown>, principal: ServicePrincipal): void {
  const tenantId = typeof body.tenantId === 'string' ? body.tenantId : undefined
  const userId = typeof body.userId === 'string' ? body.userId : undefined
  if (tenantId || userId) {
    if (principal.scope.kind !== 'tenant'
      || (tenantId && tenantId !== principal.scope.tenantId)
      || (userId && userId !== principal.scope.userId)) {
      throw new HttpError(403, 'scope_mismatch')
    }
  }
  if (body.scope && typeof body.scope === 'object' && !Array.isArray(body.scope)) {
    if (digestCanonicalJson(body.scope) !== digestCanonicalJson(principal.scope)) {
      throw new HttpError(403, 'scope_mismatch')
    }
  }
}

function projectPublicRun(run: RunRecord, scope: ServiceScope) {
  return {
    schemaVersion: PUBLIC_RUN_SCHEMA_VERSION,
    runId: run.runId,
    revision: run.runRevision,
    attempt: run.attempt,
    state: run.state,
    scope,
    updatedAt: run.updatedAt,
    ...(run.reason ? { reason: run.reason } : {}),
  }
}

function projectPublicApproval(approval: ApprovalRecord, scope: ServiceScope) {
  return {
    schemaVersion: PUBLIC_APPROVAL_SCHEMA_VERSION,
    approvalId: approval.approvalId,
    runId: approval.runId,
    revision: approval.runRevision,
    attempt: approval.attempt,
    status: approval.status,
    scope,
    action: {
      actionId: approval.actionBinding.actionId,
      kind: approval.actionBinding.toolName,
      ...(approval.actionBinding.sourceOrigin
        ? { sourceOrigin: approval.actionBinding.sourceOrigin }
        : {}),
      ...(approval.actionBinding.destinationOrigin
        ? { destinationOrigin: approval.actionBinding.destinationOrigin }
        : {}),
    },
    requestedAt: approval.requestedAt,
    expiresAt: approval.expiresAt,
  }
}

function projectRunEvent(event: RunStoreEvent) {
  return {
    schemaVersion: 'web-task-event/v1' as const,
    sequence: event.eventSequence,
    type: event.eventType,
    timestamp: event.occurredAt,
    runId: event.runId,
    revision: event.runRevision,
    ...(event.data ? { data: event.data } : {}),
  }
}

function projectTrace(run: RunRecord, scope: ServiceScope) {
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
    schemaVersion: 'public-trace/v1',
    scope,
    runId: run.runId,
    revision: run.runRevision,
    attempt: run.attempt,
    state: run.state,
    done: TERMINAL_STATES.has(run.state),
    steps: existsSync(traceFile) ? readJsonl(traceFile, 1000) : [],
    summary: readJsonFile(summaryFile),
    spans: existsSync(spansFile) ? readJsonl(spansFile, 300) : [],
    events: existsSync(eventsFile) ? readJsonl(eventsFile, 100) : [],
    metrics: readJsonFile(metricsFile),
    riskDecisions: readJsonFile(riskDecisionsFile),
    agentState: readJsonFile(agentStateFile),
  }
}

function projectMemory(record: Readonly<MemoryLifecycleRecord>) {
  return {
    schemaVersion: 'public-memory/v1',
    memoryId: record.entryId,
    revision: record.revision,
    state: record.state,
    content: record.content,
    scope: record.scope,
    trust: record.trust,
    sensitivity: record.sensitivity,
    confidence: record.confidence,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.expiresAt ? { expiresAt: record.expiresAt } : {}),
  }
}

function scoped(ownerScope?: OwnerScope): { ownerScope: OwnerScope } | undefined {
  return ownerScope ? { ownerScope } : undefined
}

function plainRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, `${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function parseLaunchOptions(
  body: Record<string, unknown>,
  allowPrivateNetwork = false,
): LegacyLaunchOptions {
  const mode = parseWebBuddyMode(body.mode)
  const startUrl = normalizeRequiredUrl(body.startUrl, allowPrivateNetwork)
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

function executionAdapterFor(record: RunRecord): 'generic_web_task' | 'recruiting_compat' | 'unknown' {
  const marker = record.inputSnapshot.goal.metadata?.executionAdapter
  if (marker === 'generic_web_task' || marker === 'recruiting_compat') return marker
  return record.inputSnapshot.contract.contractId === 'web-control-plane-legacy-adapter'
    ? 'recruiting_compat'
    : 'unknown'
}

function webTaskInputFromRecord(
  record: RunRecord,
  driver: WebTaskRuntimeDriver,
  onEvent: NonNullable<WebTaskInput['onEvent']>,
): WebTaskInput {
  const snapshot = record.inputSnapshot
  if (snapshot.contextProviders.length > 0) {
    throw new HttpError(409, 'Stored generic run references unavailable Context Providers.')
  }
  return {
    schemaVersion: 'web-task-input/v1',
    goal: structuredClone(snapshot.goal),
    contract: structuredClone(snapshot.contract),
    ...(snapshot.startUrl ? { startUrl: snapshot.startUrl } : {}),
    contextItems: structuredClone(snapshot.contextItems),
    ...(snapshot.policy ? { policy: structuredClone(snapshot.policy) } : {}),
    runId: snapshot.runId,
    revision: snapshot.revision,
    ...(snapshot.ownerScope ? { ownerScope: structuredClone(snapshot.ownerScope) } : {}),
    runtime: {
      driver,
      ...(typeof snapshot.goal.metadata?.headless === 'boolean'
        ? { headless: snapshot.goal.metadata.headless }
        : {}),
    },
    onEvent,
  }
}

function assertStoredInputDigest(record: RunRecord): void {
  const snapshot = record.inputSnapshot
  const input = webTaskInputFromRecord(snapshotRecord(record), {
    async execute() {
      throw new Error('Digest-only runtime driver must not execute.')
    },
  }, () => {})
  const rebuilt = snapshotWebTaskInput(input, snapshot.runId)
  if (snapshot.sha256 !== record.inputDigest || rebuilt.sha256 !== record.inputDigest) {
    throw new ControlStoreError('INVALID_RECORD', 'Stored WebTask input digest does not match its frozen snapshot.')
  }
}

function snapshotRecord(record: RunRecord): RunRecord {
  return {
    ...record,
    inputSnapshot: structuredClone(record.inputSnapshot),
  }
}

function validateWebTaskServiceResult(
  result: WebTaskResult,
  launched: RunRecord,
  security: WebServiceSecurityBoundary,
): void {
  if (result.schemaVersion !== 'web-task-result/v1') {
    throw new Error(`Unsupported WebTaskResult schema: ${String(result.schemaVersion)}`)
  }
  if (result.runId !== launched.runId || result.revision !== launched.runRevision) {
    throw new Error('WebTaskResult does not match the launched run/revision.')
  }
  if (digestCanonicalJson(result.ownerScope ?? null) !== digestCanonicalJson(launched.ownerScope ?? null)) {
    throw new Error('WebTaskResult owner scope does not match the launched Run.')
  }
  for (const artifact of result.artifacts) {
    validateArtifactRef(artifact, launched.runId, launched.runRevision)
    if (artifact.sensitivity === 'secret') {
      throw new Error(`Artifact ${artifact.id} cannot use ordinary storage for secret content.`)
    }
    if (artifact.ownerScope
      && digestCanonicalJson(artifact.ownerScope) !== digestCanonicalJson(launched.ownerScope ?? null)) {
      throw new Error(`Artifact ${artifact.id} owner scope does not match the launched Run.`)
    }
    if (digestCanonicalJson(artifact) !== digestCanonicalJson(security.sanitize(artifact))) {
      throw new Error(`Artifact ${artifact.id} contains material rejected by the service secret boundary.`)
    }
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

function normalizeRequiredUrl(
  value: unknown,
  allowPrivateNetwork = false,
): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined
  try {
    const url = new URL(value.trim())
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    if (!allowPrivateNetwork && isPrivateNetworkHost(url.hostname)) return undefined
    return url.toString()
  } catch {
    return undefined
  }
}

function isPrivateNetworkHost(value: string): boolean {
  const host = value.toLowerCase().replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true
  if (host === '::1' || host === '::' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe8')) {
    return true
  }
  const octets = host.split('.').map(Number)
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false
  }
  const [first, second] = octets
  return first === 0
    || first === 10
    || first === 127
    || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168)
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

function requireIdempotencyKey(req: IncomingMessage, body: Record<string, unknown>): string {
  const value = requestIdempotencyKey(req, body, '')
  if (!value) throw new HttpError(400, 'idempotencyKey is required')
  return value
}

function requireExpectedRevision(body: Record<string, unknown>): number {
  if (!Number.isSafeInteger(body.expectedRevision) || Number(body.expectedRevision) < 0) {
    throw new HttpError(400, 'expectedRevision must be a non-negative safe integer')
  }
  return Number(body.expectedRevision)
}

function requestIdentifier(req: IncomingMessage): string {
  const header = Array.isArray(req.headers['x-request-id'])
    ? req.headers['x-request-id'][0]
    : req.headers['x-request-id']
  const value = header?.trim() || randomUUID()
  return `request:${createHash('sha256').update(value).digest('hex')}`
}

function send(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) {
    if (!res.writableEnded) res.end()
    return
  }
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

function sendControlError(
  res: ServerResponse,
  error: unknown,
  security: WebServiceSecurityBoundary,
): void {
  const sanitized = (value: unknown) => security.sanitize(value)
  if (error instanceof HttpError) return send(res, error.status, sanitized({ error: error.message }))
  if (error instanceof RunServiceError) {
    return send(
      res,
      error.code === 'RUN_NOT_FOUND' ? 404 : 409,
      sanitized({ error: error.code, message: error.message }),
    )
  }
  if (error instanceof ControlStoreError) {
    const status = error.code.endsWith('_NOT_FOUND') ? 404
      : error.code === 'INVALID_RECORD' ? 400
        : 409
    return send(res, status, sanitized({ error: error.code, message: error.message }))
  }
  send(res, 500, sanitized({ error: error instanceof Error ? error.message : String(error) }))
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

function readBody(req: IncomingMessage, maxBytes = 1024 * 1024): Promise<Buffer> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let settled = false
    const onData = (chunk: Buffer) => {
      if (settled) return
      size += chunk.length
      if (size > maxBytes) {
        settled = true
        req.off('data', onData)
        req.off('end', onEnd)
        req.resume()
        reject(new HttpError(413, 'request body exceeds the 1 MiB service limit'))
        return
      }
      chunks.push(chunk)
    }
    const onEnd = () => {
      if (settled) return
      settled = true
      resolveBody(Buffer.concat(chunks))
    }
    req.on('data', onData)
    req.on('end', onEnd)
    req.on('error', (error) => {
      if (settled) return
      settled = true
      reject(error)
    })
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

if (process.env.WEB_BUDDY_COMPAT_WRAPPER !== '1'
  && process.argv[1]
  && resolve(process.argv[1]) === resolve(SOURCE_FILE)) {
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
