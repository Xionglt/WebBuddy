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
  type AgentSession,
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
  onSessionReady?: (session: AgentSession) => void | Promise<void>
  persistenceSanitizer?: (value: unknown) => unknown
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

async function executeGenericWebTask(
  request: Parameters<WebTaskRuntimeDriver['execute']>[0],
  host: WebTaskExecutionHost,
): Promise<WebTaskRuntimeOutcome> {
    const config = host.config ?? loadConfig()
    applyGenericBrowserEnv(config, request.runtime, request.input.runId)
    const trace = new TraceRecorder(request.runtime?.traceOutDir ?? config.trace.outDir, {
      runId: request.input.runId,
      source: 'sdk',
      scenario: request.input.goal.scenario ?? 'generic-web-task',
      profile: 'generic',
      goal: request.input.goal.instruction,
      sanitize: host.persistenceSanitizer,
    })
    const sessionId = host.sessionId ?? request.input.sessionRef?.id ?? `web-task-${request.input.runId}`
    const llm = new LlmGateway(config.model)
    let session: SessionRecorder | undefined
    let sessionRef = request.input.sessionRef
    try {
      if (host.durableSession) {
        const store = new FileSessionStore({
          rootDir: join(config.trace.outDir, 'sessions'),
          sanitize: host.persistenceSanitizer,
        })
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
          attempt: request.input.sessionRef?.attempt ?? 1,
        }
        await host.onSessionReady?.(created)
      }
      if (request.input.startUrl) {
        const opened = await browserOpen({ url: request.input.startUrl, sessionId, waitUntil: 'domcontentloaded' })
        if (!opened.ok) throw new Error(opened.error.message)
      }
      if (!hasModelKey(config)) {
        const summary = 'Generic runtime is blocked because no model key is configured.'
        trace.record({ phase: 'boot', action: summary, status: 'blocked' })
        const traceSummary = trace.finish()
        return {
          status: 'blocked',
          summary,
          evidence: [],
          artifacts: [],
          metrics: metricsFor(trace, config, traceSummary.tracePath),
          actions: [{ actionKind: 'submit', outcome: 'not_performed' }],
          ...(sessionRef ? { sessionRef } : {}),
        }
      }
      const genericDefs = listLocalToolDefs().filter((tool) => !['resume_query', 'job_match_candidates', 'plan_form_fill'].includes(tool.name))
      const loop = await runAgentLoop({
        goal: request.input.goal.instruction,
        contextItems: request.contextItems,
        taskContract: request.input.contract,
        taskPolicy: request.input.policy,
        llm,
        registry: new ToolRegistry(createLocalTools(genericDefs)),
        ctx: { sessionId, highlight: config.browser.visualHighlight, trace },
        gate: host.gate ?? (config.human.mode === 'auto' ? new AutoHumanGate() : new CliHumanGate()),
        maxSteps: request.runtime?.maxSteps ?? config.agent.maxSteps,
        safetyMode: 'guarded',
        permissionMode: config.human.permissionMode,
        allowFinalSubmit: false,
        session,
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
      const traceSummary = trace.finish()
      return {
        status: host.controller?.signal.aborted
          ? 'cancelled'
          : loop.paused || loop.blocked
            ? 'blocked'
            : loop.done
              ? 'completed'
              : 'failed',
        summary: loop.summary,
        evidence: loop.evidence ?? [],
        artifacts: [],
        metrics: metricsFor(trace, config, traceSummary.tracePath),
        actions: [{ actionKind: 'submit', outcome: 'not_performed' }],
        ...(sessionRef ? { sessionRef } : {}),
      }
    } catch (error) {
      const summary = error instanceof Error ? error.message : String(error)
      trace.record({ phase: 'runtime', action: summary, status: 'error' })
      const traceSummary = trace.finish()
      return {
        status: 'failed',
        summary,
        evidence: [],
        artifacts: [],
        metrics: metricsFor(trace, config, traceSummary.tracePath),
        actions: [{ actionKind: 'submit', outcome: 'not_performed' }],
        ...(sessionRef ? { sessionRef } : {}),
      }
    } finally {
      await sessionManager.close(sessionId).catch(() => {})
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
