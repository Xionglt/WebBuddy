import { AutoHumanGate, CliHumanGate } from './human.js'
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
import { evaluateCompletionContract } from '../task/completion-contract.js'
import {
  WebTaskContractError,
  isContextItemEligible,
  snapshotWebTaskInput,
  validateArtifactRef,
  validateContextItem,
  validateEvidenceRef,
  type ContextItem,
  type RunSnapshot,
  type WebTaskEvent,
  type WebTaskInput,
  type WebTaskResult,
  type WebTaskRuntimeDriver,
  type WebTaskRuntimeOutcome,
} from '../task/contracts.js'

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

export async function runWebTask(input: WebTaskInput): Promise<WebTaskResult> {
  const snapshot = snapshotWebTaskInput(input)
  const runId = snapshot.runId
  const revision = snapshot.revision
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
    ...(snapshot.sessionRef ? { sessionRef: snapshot.sessionRef } : {}),
    revision,
    attempt: snapshot.sessionRef?.attempt ?? 1,
    state,
    updatedAt: new Date().toISOString(),
    ...(reason ? { reason } : {}),
  })

  emit({ type: 'run_queued', runId, revision, snapshot: lifecycle('queued') })

  let contextItems: ContextItem[]
  try {
    contextItems = await resolveContextItems(input, runId, revision)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    emit({ type: 'run_failed', runId, revision, snapshot: lifecycle('failed', message), data: { code: 'PROVIDER_FAILED' } })
    return failedResult(input, runId, revision, message)
  }

  const driver = input.runtime?.driver ?? defaultWebTaskRuntimeDriver
  emit({ type: 'run_started', runId, revision, snapshot: lifecycle('running') })

  let outcome: WebTaskRuntimeOutcome
  try {
    outcome = await driver.execute({
      schemaVersion: 'web-task-runtime-request/v1',
      input: { ...snapshot, contextItems },
      contextItems,
      ...(input.runtime ? { runtime: { maxSteps: input.runtime.maxSteps, traceOutDir: input.runtime.traceOutDir, headless: input.runtime.headless } } : {}),
      emit: (event) => emit(event),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    emit({ type: 'run_failed', runId, revision, snapshot: lifecycle('failed', message) })
    return failedResult(input, runId, revision, message)
  }

  try {
    outcome.evidence.forEach((item) => validateEvidenceRef(item, runId, revision))
    outcome.artifacts.forEach((item) => validateArtifactRef(item, runId, revision))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    emit({ type: 'run_failed', runId, revision, snapshot: lifecycle('failed', message), data: { code: 'BINDING_MISMATCH' } })
    return failedResult(input, runId, revision, message)
  }

  const completion = evaluateCompletionContract({
    contract: input.contract,
    runId,
    revision,
    evidence: outcome.evidence,
    artifacts: outcome.artifacts,
    formState: outcome.formState,
    actions: outcome.actions,
  })
  const status = outcome.status === 'failed' || outcome.status === 'cancelled'
    ? outcome.status
    : completion.completed
      ? 'completed'
      : 'blocked'
  const summary = completion.completed || outcome.status === 'failed' || outcome.status === 'cancelled'
    ? outcome.summary
    : `${outcome.summary} Missing completion criteria: ${completion.missingCriteria.join(', ')}.`
  const state = status === 'completed' ? 'completed' : status === 'cancelled' ? 'cancelled' : status === 'failed' ? 'failed' : 'blocked_on_human'
  emit({
    type: `run_${status}`,
    runId,
    revision,
    snapshot: lifecycle(state, status === 'completed' ? undefined : summary),
    data: { missingCriteria: completion.missingCriteria },
  })
  return {
    schemaVersion: 'web-task-result/v1',
    runId,
    revision,
    status,
    summary,
    evidence: outcome.evidence,
    artifacts: outcome.artifacts,
    metrics: outcome.metrics,
    ...(outcome.sessionRef ?? snapshot.sessionRef ? { sessionRef: outcome.sessionRef ?? snapshot.sessionRef } : {}),
    ...(outcome.checkpointRef ? { checkpointRef: outcome.checkpointRef } : {}),
    ...(snapshot.ownerScope ? { ownerScope: snapshot.ownerScope } : {}),
  }
}

async function resolveContextItems(input: WebTaskInput, runId: string, revision: number): Promise<ContextItem[]> {
  const resolved = [...(input.contextItems ?? [])]
  for (const provider of input.contextProviders ?? []) {
    let items: ContextItem[]
    try {
      items = await provider.provide({
        schemaVersion: 'context-provider-request/v1',
        goal: input.goal,
        runId,
        revision,
        ...(input.sessionRef ? { sessionRef: input.sessionRef } : {}),
        ...(input.ownerScope ? { ownerScope: input.ownerScope } : {}),
      })
    } catch (error) {
      throw new WebTaskContractError('PROVIDER_FAILED', `Context provider ${provider.id} failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (!Array.isArray(items)) throw new WebTaskContractError('PROVIDER_FAILED', `Context provider ${provider.id} did not return an array.`)
    for (const item of items) validateContextItem(item)
    resolved.push(...items)
  }
  const ids = resolved.map((item) => item.id)
  if (new Set(ids).size !== ids.length) throw new WebTaskContractError('INVALID_CONTRACT', 'Context item IDs must be unique after provider resolution.')
  return resolved.filter((item) => isContextItemEligible(item))
}

const defaultWebTaskRuntimeDriver: WebTaskRuntimeDriver = {
  async execute(request): Promise<WebTaskRuntimeOutcome> {
    const config = loadConfig()
    applyGenericBrowserEnv(config, request.runtime, request.input.runId)
    const trace = new TraceRecorder(request.runtime?.traceOutDir ?? config.trace.outDir, {
      runId: request.input.runId,
      source: 'sdk',
      scenario: request.input.goal.scenario ?? 'generic-web-task',
      profile: 'generic',
      goal: request.input.goal.instruction,
    })
    const sessionId = request.input.sessionRef?.id ?? `web-task-${request.input.runId}`
    const llm = new LlmGateway(config.model)
    try {
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
        }
      }
      const genericDefs = listLocalToolDefs().filter((tool) => !['resume_query', 'job_match_candidates', 'plan_form_fill'].includes(tool.name))
      const loop = await runAgentLoop({
        goal: request.input.goal.instruction,
        contextItems: request.contextItems,
        taskContract: request.input.contract,
        llm,
        registry: new ToolRegistry(createLocalTools(genericDefs)),
        ctx: { sessionId, highlight: config.browser.visualHighlight, trace },
        gate: config.human.mode === 'auto' ? new AutoHumanGate() : new CliHumanGate(),
        maxSteps: request.runtime?.maxSteps ?? config.agent.maxSteps,
        safetyMode: 'guarded',
        permissionMode: config.human.permissionMode,
        allowFinalSubmit: false,
        onEvent: (event) => request.emit({
          type: 'runtime_event',
          runId: request.input.runId,
          revision: request.input.revision,
          data: { step: event.step, level: event.level, message: event.message },
        }),
      })
      const traceSummary = trace.finish()
      return {
        status: loop.blocked ? 'blocked' : loop.done ? 'completed' : 'failed',
        summary: loop.summary,
        evidence: loop.evidence ?? [],
        artifacts: [],
        metrics: metricsFor(trace, config, traceSummary.tracePath),
        actions: [{ actionKind: 'submit', outcome: 'not_performed' }],
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
      }
    } finally {
      await sessionManager.close(sessionId).catch(() => {})
    }
  },
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

function failedResult(input: WebTaskInput, runId: string, revision: number, summary: string): WebTaskResult {
  return {
    schemaVersion: 'web-task-result/v1',
    runId,
    revision,
    status: 'failed',
    summary,
    evidence: [],
    artifacts: [],
    metrics: emptyRunMetrics({ runId, source: 'sdk', scenario: input.goal.scenario, profile: 'generic', warnings: [summary] }),
    ...(input.sessionRef ? { sessionRef: input.sessionRef } : {}),
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
