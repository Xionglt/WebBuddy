import { AutoHumanGate, CliHumanGate, type HumanGate } from './human.js'
import { LlmGateway } from './llm.js'
import { loadConfig, hasModelKey, type AgentConfig } from './config.js'
import { TraceRecorder } from './trace.js'
import { browserOpen } from '../browser/open.js'
import { sessionManager } from '../session/manager.js'
import { runAgentLoop } from '../runtime/local/agent-loop.js'
import { ToolRegistry } from '../runtime/local/tool-registry.js'
import { createLocalTools } from '../tools/local-adapter.js'
import { listLocalToolDefs } from '../tools/catalog.js'
import { emptyRunMetrics } from '../metrics/schema.js'
import { generateAndWriteMetrics } from '../metrics/writer.js'
import type { AgentRunController } from '../kernel/run-controller.js'
import {
  FileSessionRecorder,
  FileSessionStore,
  restoreSessionState,
  sanitizeRestoredMessagesForResume,
  type AgentSession,
  type RestoredSessionState,
  type SessionRecorder,
} from '../session/index.js'
import { evaluateCompletionContract } from '../task/completion-contract.js'
import { classifyContentSecurity, toContextSecurityFields } from '../security/content-trust.js'
import {
  WebTaskContractError,
  digestCanonicalJson,
  isContextItemEligible,
  snapshotWebTaskInput,
  validateArtifactRef,
  validateCheckpointRef,
  validateContextItem,
  validateEvidenceRef,
  validateRunExecutionContext,
  validateSessionRef,
  type ContextItem,
  type RunExecutionContext,
  type RunSnapshot,
  type WebTaskEvent,
  type WebTaskInput,
  type WebTaskResult,
  type WebTaskRuntimeDriver,
  type WebTaskRuntimeOutcome,
} from '../task/contracts.js'
import { join } from 'node:path'
import { ActionLedger, type ActionLedgerEntry } from '../task/action-ledger.js'
import {
  assembleRuntimeProfile,
  type RuntimeAssembly,
} from '../runtime/local/runtime-assembler.js'
import type { AsyncTaskRuntime } from '../agents/async-task-runtime.js'
import { PermissionEngine } from '../permission/permission-engine.js'
import { loadPersistentPermissionRules } from '../permission/persistent-rules.js'
import { FileToolResultStore, type ToolResultStore } from '../tools/tool-result-store.js'

export type {
  ActionBinding,
  AgentRole,
  ApprovalBinding,
  ArtifactRef,
  CompletionCriterion,
  ContextItem,
  ContextProvider,
  EvidenceRef,
  EvidenceRequirement,
  OwnerScope,
  RunSnapshot,
  RuntimeOptions,
  RunExecutionContext,
  SensitiveActionRule,
  SessionRef,
  TaskContract,
  TaskGoal,
  TaskPolicy,
  WebTaskEvent,
  WebTaskInput,
  WebTaskInputSnapshot,
  WebTaskResult,
  WebTaskRuntimeDriver,
  WebTaskRuntimeOutcome,
} from '../task/contracts.js'

export { WebTaskContractError, snapshotWebTaskInput } from '../task/contracts.js'

export interface WebTaskExecutionHost {
  config?: AgentConfig
  gate?: HumanGate
  controller?: Pick<AgentRunController, 'signal' | 'pauseRequested'>
  sessionId?: string
  durableSession?: boolean
  restoredSession?: RestoredSessionState
  readOnlyAuthority?: boolean
  onSessionReady?: (session: AgentSession) => void | Promise<void>
  persistenceSanitizer?: (value: unknown) => unknown
  memoryContextProvider?: (input: WebTaskMemoryContextRequest) => Promise<ContextItem[]>
  asyncTaskRuntimeFactory?: (input: WebTaskAsyncRuntimeFactoryInput) => AsyncTaskRuntime | Promise<AsyncTaskRuntime>
}

export interface WebTaskMemoryContextRequest {
  input: Parameters<WebTaskRuntimeDriver['execute']>[0]['input']
  sessionId: string
  runId: string
  revision: number
}

export interface WebTaskAsyncRuntimeFactoryInput {
  input: Parameters<WebTaskRuntimeDriver['execute']>[0]['input']
  session: SessionRecorder
  config: AgentConfig
  llm: LlmGateway
  trace: TraceRecorder
  assembly: RuntimeAssembly
}

export async function runWebTask(input: WebTaskInput): Promise<WebTaskResult> {
  const snapshot = snapshotWebTaskInput(input)
  const runId = snapshot.runId
  const taskRevision = snapshot.revision
  const executionContext = resolveExecutionContext(input.runtime?.executionContext, snapshot)
  const runRevision = executionContext.runRevision
  const attempt = executionContext.attempt
  const executionSessionRef = executionContext.sessionRef ?? snapshot.sessionRef
  let sequence = 0
  const emit = (event: Omit<WebTaskEvent, 'schemaVersion' | 'sequence' | 'timestamp'>) => {
    const value: WebTaskEvent = {
      schemaVersion: 'web-task-event/v1',
      sequence: ++sequence,
      timestamp: new Date().toISOString(),
      ...event,
    }
    input.onEvent?.(value)
  }
  const lifecycle = (state: RunSnapshot['state'], reason?: string): RunSnapshot => ({
    schemaVersion: 'run-snapshot/v1',
    runId,
    ...(executionSessionRef ? { sessionRef: executionSessionRef } : {}),
    revision: runRevision,
    attempt,
    state,
    updatedAt: new Date().toISOString(),
    ...(reason ? { reason } : {}),
  })

  emit({ type: 'run_queued', runId, revision: runRevision, snapshot: lifecycle('queued') })

  let contextItems: ContextItem[]
  try {
    contextItems = await resolveContextItems(input, runId, taskRevision, executionSessionRef)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const code = error instanceof WebTaskContractError ? error.code : 'PROVIDER_FAILED'
    emit({ type: 'run_failed', runId, revision: runRevision, snapshot: lifecycle('failed', message), data: { code } })
    return failedResult(input, runId, taskRevision, message, executionSessionRef)
  }

  const driver = input.runtime?.driver ?? defaultWebTaskRuntimeDriver
  emit({ type: 'run_started', runId, revision: runRevision, snapshot: lifecycle('running') })

  let outcome: WebTaskRuntimeOutcome
  try {
    outcome = await driver.execute({
      schemaVersion: 'web-task-runtime-request/v1',
      input: snapshot,
      contextItems,
      runtime: {
        maxSteps: input.runtime?.maxSteps,
        traceOutDir: input.runtime?.traceOutDir,
        headless: input.runtime?.headless,
        executionContext,
      },
      emit: (event) => emit({ ...event, runId, revision: runRevision }),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    emit({ type: 'run_failed', runId, revision: runRevision, snapshot: lifecycle('failed', message) })
    return failedResult(input, runId, taskRevision, message, executionSessionRef)
  }

  try {
    outcome.evidence.forEach((item) => validateEvidenceRef(item, runId, taskRevision))
    outcome.artifacts.forEach((item) => validateArtifactRef(item, runId, taskRevision))
    assertUniqueResultIds(outcome.evidence, 'evidence')
    assertUniqueResultIds(outcome.artifacts, 'artifact')
    if (outcome.sessionRef) {
      validateSessionRef(outcome.sessionRef, runId, attempt)
      if (executionSessionRef
        && digestSessionRef(outcome.sessionRef) !== digestSessionRef(executionSessionRef)) {
        throw new WebTaskContractError('BINDING_MISMATCH', 'Runtime SessionRef does not match the current execution session.')
      }
    }
    const resultSession = outcome.sessionRef ?? executionSessionRef
    if (executionContext.recoveryMode) {
      if (!resultSession) {
        throw new WebTaskContractError('BINDING_MISMATCH', 'Recovery result has no current execution session.')
      }
      for (const ref of [...outcome.evidence, ...outcome.artifacts]) {
        if (!ref.binding.sessionRef
          || digestSessionRef(ref.binding.sessionRef) !== digestSessionRef(resultSession)) {
          throw new WebTaskContractError(
            'BINDING_MISMATCH',
            `${ref.id} is not bound to the current execution session.`,
          )
        }
      }
    }
    if (outcome.checkpointRef) {
      validateCheckpointRef(outcome.checkpointRef)
      if (!resultSession) {
        throw new WebTaskContractError('BINDING_MISMATCH', 'Runtime checkpoint has no bound SessionRef.')
      }
      if (resultSession.checkpointRef
        && (resultSession.checkpointRef.provider !== outcome.checkpointRef.provider
          || resultSession.checkpointRef.id !== outcome.checkpointRef.id)) {
        throw new WebTaskContractError('BINDING_MISMATCH', 'Runtime checkpoint does not match its SessionRef.')
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    emit({ type: 'run_failed', runId, revision: runRevision, snapshot: lifecycle('failed', message), data: { code: 'BINDING_MISMATCH' } })
    return failedResult(input, runId, taskRevision, message, executionSessionRef)
  }

  const completion = evaluateCompletionContract({
    contract: input.contract,
    runId,
    revision: taskRevision,
    evidence: outcome.evidence,
    artifacts: outcome.artifacts,
    formState: outcome.formState,
    actions: outcome.actions,
  })
  const status = outcome.status === 'failed' || outcome.status === 'cancelled' || outcome.status === 'blocked'
    ? outcome.status
    : completion.completed
      ? 'completed'
      : 'blocked'
  const summary = outcome.status !== 'completed' || completion.completed
    ? outcome.summary
    : `${outcome.summary} Missing completion criteria: ${completion.missingCriteria.join(', ')}.`
  const state = status === 'completed' ? 'completed' : status === 'cancelled' ? 'cancelled' : status === 'failed' ? 'failed' : 'blocked_on_human'
  emit({
    type: `run_${status}`,
    runId,
    revision: runRevision,
    snapshot: lifecycle(state, status === 'completed' ? undefined : summary),
    data: { missingCriteria: completion.missingCriteria },
  })
  return {
    schemaVersion: 'web-task-result/v1',
    runId,
    revision: taskRevision,
    status,
    summary,
    evidence: outcome.evidence,
    artifacts: outcome.artifacts,
    ...(outcome.formState ? { formState: outcome.formState } : {}),
    ...(outcome.actions ? { actions: outcome.actions } : {}),
    metrics: outcome.metrics,
    ...(outcome.sessionRef ?? executionSessionRef ? { sessionRef: outcome.sessionRef ?? executionSessionRef } : {}),
    ...(outcome.checkpointRef ? { checkpointRef: outcome.checkpointRef } : {}),
    ...(snapshot.ownerScope ? { ownerScope: snapshot.ownerScope } : {}),
  }
}

function resolveExecutionContext(
  candidate: RunExecutionContext | undefined,
  snapshot: ReturnType<typeof snapshotWebTaskInput>,
): RunExecutionContext {
  const context: RunExecutionContext = candidate ?? {
    schemaVersion: 'run-execution-context/v1',
    runRevision: snapshot.revision,
    attempt: snapshot.sessionRef?.attempt ?? 1,
    ...(snapshot.sessionRef ? { sessionRef: snapshot.sessionRef } : {}),
  }
  validateRunExecutionContext(context, snapshot.runId, snapshot.revision)
  if (snapshot.sessionRef
    && (!context.sessionRef
      || digestSessionRef(snapshot.sessionRef) !== digestSessionRef(context.sessionRef))) {
    throw new WebTaskContractError(
      'BINDING_MISMATCH',
      'Frozen and execution SessionRef values must match.',
    )
  }
  return structuredClone(context)
}

function digestSessionRef(ref: NonNullable<RunExecutionContext['sessionRef']>): string {
  return digestCanonicalJson(ref)
}

function assertUniqueResultIds(
  refs: readonly { id: string }[],
  kind: 'evidence' | 'artifact',
): void {
  if (new Set(refs.map((item) => item.id)).size !== refs.length) {
    throw new WebTaskContractError('BINDING_MISMATCH', `Duplicate ${kind} reference IDs are not allowed.`)
  }
}

async function resolveContextItems(
  input: WebTaskInput,
  runId: string,
  revision: number,
  sessionRef?: NonNullable<RunExecutionContext['sessionRef']>,
): Promise<ContextItem[]> {
  const resolved = [...(input.contextItems ?? [])]
  for (const provider of input.contextProviders ?? []) {
    let items: ContextItem[]
    try {
      items = await provider.provide({
        schemaVersion: 'context-provider-request/v1',
        goal: input.goal,
        runId,
        revision,
        ...(sessionRef ? { sessionRef } : {}),
        ...(input.ownerScope ? { ownerScope: input.ownerScope } : {}),
      })
    } catch (error) {
      throw new WebTaskContractError('PROVIDER_FAILED', `Context provider ${provider.id} failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (!Array.isArray(items)) throw new WebTaskContractError('PROVIDER_FAILED', `Context provider ${provider.id} did not return an array.`)
    resolved.push(...items)
  }
  const ids = resolved.map((item) => item.id)
  if (new Set(ids).size !== ids.length) throw new WebTaskContractError('INVALID_CONTRACT', 'Context item IDs must be unique after provider resolution.')
  return resolved.map(secureContextItem).filter((item) => isContextItemEligible(item))
}

function secureContextItem(item: ContextItem): ContextItem {
  if (!item || typeof item !== 'object') {
    throw new WebTaskContractError('INVALID_CONTRACT', 'Context providers must return ContextItem objects.')
  }
  const metadata = classifyContentSecurity({
    contentId: item.id,
    origin: item.origin,
    trust: item.trust,
    sensitivity: item.sensitivity,
    provenance: item.provenance,
  })
  if (metadata.origin === 'system' || metadata.trust === 'trusted_runtime') {
    throw new WebTaskContractError(
      'INVALID_CONTRACT',
      `Context ${item.id}: external WebTask inputs and providers cannot supply trusted system context.`,
    )
  }
  if (metadata.classification.status === 'fail_closed') {
    throw new WebTaskContractError(
      'INVALID_CONTRACT',
      `Context ${item.id} failed security classification: ${metadata.classification.reasons.join(', ')}.`,
    )
  }
  const secured: ContextItem = { ...item, ...toContextSecurityFields(metadata) }
  validateContextItem(secured)
  return secured
}

export function createWebTaskRuntimeDriver(
  host: WebTaskExecutionHost = {},
): WebTaskRuntimeDriver {
  return {
    execute: (request) => executeGenericWebTask(request, host),
  }
}

const defaultWebTaskRuntimeDriver: WebTaskRuntimeDriver = createWebTaskRuntimeDriver()

export function listGenericWebTaskToolDefs(readOnlyAuthority = false) {
  const generic = listLocalToolDefs()
    .filter((tool) => !['resume_query', 'job_match_candidates', 'plan_form_fill'].includes(tool.name))
  return readOnlyAuthority
    ? generic.filter((tool) => tool.execution.readOnly || tool.name === 'agent_done')
    : generic
}

async function executeGenericWebTask(
  request: Parameters<WebTaskRuntimeDriver['execute']>[0],
  host: WebTaskExecutionHost,
): Promise<WebTaskRuntimeOutcome> {
    const config = host.config ?? loadConfig()
    const runtimeAssembly = assembleRuntimeProfile({
      task: request.input,
      config,
      durableSession: host.durableSession,
      hasLifecycleMemoryProvider: Boolean(host.memoryContextProvider),
      hasAsyncRuntimeFactory: Boolean(host.asyncTaskRuntimeFactory),
    })
    applyGenericBrowserEnv(config, request.runtime, request.input.runId)
    const trace = new TraceRecorder(request.runtime?.traceOutDir ?? config.trace.outDir, {
      runId: request.input.runId,
      source: 'sdk',
      scenario: request.input.goal.scenario ?? 'generic-web-task',
      profile: runtimeAssembly.profileId,
      goal: request.input.goal.instruction,
      sanitize: host.persistenceSanitizer,
    })
    const artifactStore = new FileToolResultStore({
      rootDir: join(trace.agentTrace?.dir ?? trace.dir, 'artifacts', 'tool-results'),
      sanitize: host.persistenceSanitizer,
    })
    const executionContext = request.runtime?.executionContext
    const sessionId = host.sessionId
      ?? executionContext?.sessionRef?.id
      ?? request.input.sessionRef?.id
      ?? `web-task-${request.input.runId}`
    const llm = new LlmGateway(config.model)
    let session: SessionRecorder | undefined
    let sessionRef = executionContext?.sessionRef ?? request.input.sessionRef
    let restoredMessages: ReturnType<typeof sanitizeRestoredMessagesForResume> | undefined
    const actionLedger = new ActionLedger()
    const monitoredActionKinds = request.input.contract.criteria.flatMap((criterion) => (
      criterion.kind === 'action_boundary' ? criterion.actionKinds : []
    ))
    try {
      const recoveryRequested = executionContext?.recoveryMode !== undefined
      if (recoveryRequested
        && (executionContext.recoveryMode !== 'read_only_reobserve/v1'
          || runtimeAssembly.durableSession !== true
          || !host.restoredSession
          || host.readOnlyAuthority !== true)) {
        throw new Error(
          'Generic recovery requires a durable restored session and explicit read-only authority.',
        )
      }
      if (host.restoredSession && !recoveryRequested) {
        throw new Error('A restored generic session requires an explicit recovery mode.')
      }
      if (runtimeAssembly.durableSession) {
        const store = new FileSessionStore({
          rootDir: join(config.trace.outDir, 'sessions'),
          sanitize: host.persistenceSanitizer,
        })
        if (host.restoredSession) {
          if (executionContext?.recoveryMode !== 'read_only_reobserve/v1'
            || host.readOnlyAuthority !== true) {
            throw new Error('Generic session recovery requires explicit read-only authority.')
          }
          const expectedRef = executionContext.sessionRef
          if (!expectedRef
            || expectedRef.provider !== 'file-session-store'
            || expectedRef.id !== sessionId
            || expectedRef.runId !== request.input.runId) {
            throw new Error('Generic recovery SessionRef does not match the current run.')
          }
          const current = await store.get(sessionId)
          if (!current
            || current.sessionId !== host.restoredSession.session.sessionId
            || current.runId !== host.restoredSession.session.runId
            || current.runId !== request.input.runId) {
            throw new Error('Generic recovery session is missing or changed.')
          }
          const restored = await restoreSessionState({ session: current })
          restoredMessages = sanitizeRestoredMessagesForResume(restored.restoredMessages)
          const reopened = await store.update(sessionId, {
            status: 'created',
            completedAt: undefined,
            blockedReason: undefined,
            error: undefined,
          })
          session = new FileSessionRecorder(store, reopened)
          sessionRef = expectedRef
          await host.onSessionReady?.(reopened)
        } else {
          const created = await store.create({
            sessionId,
            runId: request.input.runId,
            source: 'web',
            goal: request.input.goal.instruction,
            mode: 'generic-web-task',
            traceRunId: request.input.runId,
          })
          session = new FileSessionRecorder(store, created)
          sessionRef = {
            schemaVersion: 'session-ref/v1',
            provider: 'file-session-store',
            id: created.sessionId,
            runId: request.input.runId,
            attempt: executionContext?.attempt ?? request.input.sessionRef?.attempt ?? 1,
          }
          await host.onSessionReady?.(created)
        }
      }
      const recordBootstrapAction = async (entry: ActionLedgerEntry) => {
        trace.agentTrace?.recordEvent('action_ledger_updated', { entry })
        await session?.event({
          type: 'action_ledger_updated',
          toolCallId: entry.actionId,
          message: `${entry.actionKind}: ${entry.status}`,
          data: { entry },
        })
      }
      let runtimeContextItems = [...request.contextItems]
      if (host.memoryContextProvider) {
        const memoryItems = await host.memoryContextProvider({
          input: request.input,
          sessionId,
          runId: request.input.runId,
          revision: request.input.revision,
        })
        for (const item of memoryItems) validateContextItem(item)
        runtimeContextItems = [...runtimeContextItems, ...memoryItems].filter((item) => isContextItemEligible(item))
        const ids = runtimeContextItems.map((item) => item.id)
        if (new Set(ids).size !== ids.length) {
          throw new Error('Runtime memory context produced duplicate ContextItem ids.')
        }
        trace.agentTrace?.recordEvent('memory_retrieved', {
          source: 'memory_lifecycle',
          itemCount: memoryItems.length,
        })
      }
      if (request.input.startUrl) {
        const actionId = `runtime-bootstrap:navigate:${request.input.runId}`
        await recordBootstrapAction(actionLedger.propose({
          actionId,
          actionKind: 'navigate',
          toolName: 'browser_open',
        }))
        await recordBootstrapAction(actionLedger.authorize(actionId, 'User supplied startUrl.'))
        const opened = await browserOpen({ url: request.input.startUrl, sessionId, waitUntil: 'domcontentloaded' })
        if (!opened.ok) {
          await recordBootstrapAction(actionLedger.fail(actionId, opened.error.message))
          throw new Error(opened.error.message)
        }
        await recordBootstrapAction(actionLedger.perform(actionId, 'Initial navigation succeeded.'))
      }
      if (!hasModelKey(config)) {
        const summary = 'Generic runtime is blocked because no model key is configured.'
        trace.record({ phase: 'boot', action: summary, status: 'blocked' })
        await session?.updateStatus('blocked', {
          blockedReason: summary,
          error: undefined,
        })
        return finishGenericRuntimeOutcome({
          trace,
          config,
          request,
          artifactStore,
          sessionId,
          status: 'blocked',
          summary,
          evidence: [],
          artifacts: [],
          actions: actionLedger.outcomes(monitoredActionKinds),
          sessionRef,
        })
      }
      const genericDefs = listGenericWebTaskToolDefs(host.readOnlyAuthority === true)
      const persistentPermissionRules = runtimeAssembly.memory.mode === 'legacy_local'
        ? await loadPersistentPermissionRules(config.memory.permissionRulesPath)
        : []
      const asyncTaskRuntime = runtimeAssembly.asyncTasks.eligible
        && host.asyncTaskRuntimeFactory
        && session
        ? await host.asyncTaskRuntimeFactory({
            input: request.input,
            session,
            config,
            llm,
            trace,
            assembly: runtimeAssembly,
          })
        : undefined
      if (runtimeAssembly.asyncTasks.eligible && !asyncTaskRuntime) {
        trace.agentTrace?.recordEvent('runtime_capability_degraded', {
          capability: 'async_tasks',
          reason: host.asyncTaskRuntimeFactory
            ? 'A durable session was unavailable.'
            : 'No trusted asyncTaskRuntimeFactory was supplied.',
        })
      }
      const loop = await runAgentLoop({
        goal: request.input.goal.instruction,
        contextItems: runtimeContextItems,
        taskContract: request.input.contract,
        taskPolicy: request.input.policy,
        llm,
        registry: new ToolRegistry(createLocalTools(genericDefs)),
        ctx: {
          sessionId,
          highlight: config.browser.visualHighlight,
          trace,
          ...(asyncTaskRuntime ? { asyncTaskRuntime } : {}),
        },
        gate: host.gate ?? (config.human.mode === 'auto' ? new AutoHumanGate() : new CliHumanGate()),
        maxSteps: request.runtime?.maxSteps ?? config.agent.maxSteps,
        safetyMode: 'guarded',
        permissionMode: config.human.permissionMode,
        permissionEngine: new PermissionEngine({
          permissionMode: config.human.permissionMode,
          allowFinalSubmit: false,
          persistentRules: persistentPermissionRules,
        }),
        allowFinalSubmit: false,
        taskType: runtimeAssembly.taskType,
        toolOrchestration: runtimeAssembly.toolOrchestration,
        actionLedger,
        toolResultStore: artifactStore,
        ...(runtimeAssembly.memory.mode === 'legacy_local' ? {
          persistentAnswerStore: { path: config.memory.answerStorePath },
          persistentPermissionRules: { path: config.memory.permissionRulesPath },
          memdir: { path: config.memory.memdirPath },
        } : {}),
        session,
        restoredMessages,
        restoredAsyncTaskPromptAttachments: host.restoredSession?.asyncTaskPromptAttachments,
        abortSignal: host.controller?.signal,
        shouldPause: () => host.controller?.pauseRequested ?? false,
        persistenceSanitizer: host.persistenceSanitizer,
        onEvent: (event) => request.emit({
          type: 'runtime_event',
          runId: request.input.runId,
          revision: request.input.revision,
          data: { step: event.step, level: event.level, message: event.message },
        }),
      })
      const evidence = (loop.evidence ?? []).map((item) => ({
        ...item,
        binding: {
          ...item.binding,
          ...(sessionRef ? { sessionRef } : {}),
        },
      }))
      const artifacts = (loop.artifacts ?? []).map((item) => ({
        ...item,
        binding: {
          ...item.binding,
          ...(sessionRef ? { sessionRef } : {}),
        },
      }))
      return finishGenericRuntimeOutcome({
        trace,
        config,
        request,
        artifactStore,
        sessionId,
        status: host.controller?.signal.aborted
          ? 'cancelled'
          : loop.paused || loop.blocked
            ? 'blocked'
            : loop.done
              ? 'completed'
              : 'failed',
        summary: loop.summary,
        evidence,
        artifacts,
        ...(loop.formState ? { formState: loop.formState } : {}),
        actions: loop.actions ?? actionLedger.outcomes(monitoredActionKinds),
        sessionRef,
      })
    } catch (error) {
      const summary = error instanceof Error ? error.message : String(error)
      trace.record({ phase: 'runtime', action: summary, status: 'error' })
      await session?.updateStatus('failed', {
        error: summary,
        blockedReason: undefined,
      }).catch(() => {})
      return finishGenericRuntimeOutcome({
        trace,
        config,
        request,
        artifactStore,
        sessionId,
        status: 'failed',
        summary,
        evidence: [],
        artifacts: [],
        actions: actionLedger.outcomes(monitoredActionKinds),
        sessionRef,
      })
    } finally {
      await sessionManager.close(sessionId).catch(() => {})
    }
}

async function finishGenericRuntimeOutcome(input: {
  trace: TraceRecorder
  config: AgentConfig
  request: Parameters<WebTaskRuntimeDriver['execute']>[0]
  artifactStore: ToolResultStore
  sessionId: string
  status: WebTaskRuntimeOutcome['status']
  summary: string
  evidence: WebTaskRuntimeOutcome['evidence']
  artifacts: WebTaskRuntimeOutcome['artifacts']
  formState?: WebTaskRuntimeOutcome['formState']
  actions: NonNullable<WebTaskRuntimeOutcome['actions']>
  sessionRef?: NonNullable<WebTaskRuntimeOutcome['sessionRef']>
}): Promise<WebTaskRuntimeOutcome> {
  const { trace, config, request, status, summary, evidence, formState, actions, sessionRef } = input
  const artifacts = [...input.artifacts]
  const payload = {
    schemaVersion: 'generic-runtime-outcome/v1',
    runId: request.input.runId,
    revision: request.input.revision,
    status,
    summary,
    actions,
    ...(sessionRef ? { sessionRef } : {}),
  }
  try {
    const stored = await input.artifactStore.write({
      runId: request.input.runId,
      sessionId: input.sessionId,
      toolCallId: `runtime-outcome:${sessionRef?.attempt ?? 1}`,
      toolName: 'generic_runtime',
      kind: 'generic_json',
      content: payload,
      mediaType: 'application/json',
      sensitivity: request.input.ownerScope ? 'personal' : 'internal',
      retention: { scope: 'run', deleteWithSession: true },
      summary,
    })
    const artifact = {
      schemaVersion: 'artifact-ref/v1' as const,
      id: stored.artifactId,
      kind: 'runtime_outcome',
      payloadSchemaVersion: 'generic-runtime-outcome/v1',
      mediaType: stored.mediaType,
      byteLength: stored.bytes,
      sha256: stored.sha256,
      createdAt: stored.createdAt,
      immutable: true as const,
      locator: `artifact:${stored.artifactId}`,
      producer: { id: 'generic-runtime', version: '1' },
      parentEvidenceIds: evidence.map((item) => item.id),
      parentArtifactIds: artifacts.map((item) => item.id),
      origin: 'artifact' as const,
      trust: 'non_authoritative' as const,
      sensitivity: stored.sensitivity,
      retention: { scope: 'run' as const, deleteWithSession: true },
      ...(request.input.ownerScope ? { ownerScope: structuredClone(request.input.ownerScope) } : {}),
      binding: {
        runId: request.input.runId,
        revision: request.input.revision,
        ...(sessionRef ? { sessionRef: structuredClone(sessionRef) } : {}),
      },
      requiresMainWorkflowVerification: true,
      authoritativeCompletionEvidence: false,
      redaction: {
        status: stored.redaction?.status === 'redacted'
          ? 'redacted' as const
          : stored.redaction?.status === 'contains_sensitive'
            ? 'rejected' as const
            : 'not_required' as const,
        policyId: 'runtime-persistence-boundary/v1',
      },
      scanner: { status: 'not_scanned' as const, scannerId: 'not-configured' },
    }
    validateArtifactRef(artifact, request.input.runId, request.input.revision)
    artifacts.push(artifact)
    trace.agentTrace?.recordEvent('runtime_outcome_artifact_created', { artifact })
  } catch (error) {
    trace.agentTrace?.recordEvent('runtime_outcome_artifact_failed', {
      message: error instanceof Error ? error.message : String(error),
    })
  }
  const traceSummary = trace.finish()
  return {
    status,
    summary,
    evidence,
    artifacts,
    ...(formState ? { formState } : {}),
    metrics: metricsFor(trace, config, traceSummary.tracePath),
    actions,
    ...(sessionRef ? { sessionRef } : {}),
  }
}

function metricsFor(trace: TraceRecorder, config: AgentConfig, _tracePath: string) {
  if (trace.agentTrace) {
    try {
      return generateAndWriteMetrics({
        runId: trace.runId,
        sessionId: trace.agentTrace.sessionId,
        source: trace.source,
        scenario: trace.scenario,
        profile: trace.profile,
        traceDir: trace.agentTrace.dir,
        runDir: trace.dir,
        outputDir: config.trace.outDir,
      }).metrics
    } catch {
      // Metrics remain diagnostic and cannot change the task result.
    }
  }
  return emptyRunMetrics({ runId: trace.runId, source: 'sdk', scenario: trace.scenario, profile: trace.profile, warnings: ['Metrics aggregation failed.'] })
}

function failedResult(
  input: WebTaskInput,
  runId: string,
  revision: number,
  summary: string,
  sessionRef?: NonNullable<RunExecutionContext['sessionRef']>,
): WebTaskResult {
  return {
    schemaVersion: 'web-task-result/v1',
    runId,
    revision,
    status: 'failed',
    summary,
    evidence: [],
    artifacts: [],
    metrics: emptyRunMetrics({ runId, source: 'sdk', scenario: input.goal.scenario, profile: 'generic', warnings: [summary] }),
    ...(sessionRef ?? input.sessionRef ? { sessionRef: sessionRef ?? input.sessionRef } : {}),
    ...(input.ownerScope ? { ownerScope: input.ownerScope } : {}),
  }
}

function applyGenericBrowserEnv(config: AgentConfig, runtime: { headless?: boolean } | undefined, runId: string): void {
  if (runtime?.headless !== undefined) process.env.PLAYWRIGHT_HEADLESS = runtime.headless ? 'true' : 'false'
  else if (process.env.PLAYWRIGHT_HEADLESS === undefined) process.env.PLAYWRIGHT_HEADLESS = config.browser.headless ? 'true' : 'false'
  if (config.browser.blockLocalhost === false) process.env.PLAYWRIGHT_BLOCK_LOCALHOST = 'false'
  if (config.browser.allowedDomains.length && !process.env.PLAYWRIGHT_ALLOWED_DOMAINS) process.env.PLAYWRIGHT_ALLOWED_DOMAINS = config.browser.allowedDomains.join(',')
  process.env.AGENT_RUN_ID = runId
}
