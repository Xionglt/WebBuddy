import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { SessionRecorder } from '../session/session-recorder.js'
import type { TranscriptEntry } from '../session/session-types.js'
import { readJsonLines } from '../session/transcript.js'
import type { AgentConfig } from '../sdk/config.js'
import type { TraceRecorder } from '../sdk/trace.js'
import type { ContextItem, TaskContract } from '../task/contracts.js'
import { FileToolResultStore, type ToolResultArtifactRef } from '../tools/tool-result-store.js'
import {
  CONTRACT_READ_ONLY_ARTIFACT_TOOL_NAMES,
  FileImmutableArtifactReader,
} from './agent-runner.js'
import type {
  ImmutableArtifactRef,
  JsonValue,
  ReadOnlyArtifactToolName,
  RunnerLimits,
  SanitizedTextProjectionV1,
  SensitiveDisclosureGrantRefV1,
} from './async-task-contracts.js'
import {
  AsyncTaskRuntime,
  type AsyncTaskContextEnvelopeRequest,
} from './async-task-runtime.js'
import {
  getBuiltInRoleRuntimeBinding,
  parseBuiltInRoleTaskMetadata,
  toBuiltInRoleEnvelopeBinding,
  type BuiltInAgentRoleId,
  type BuiltInRoleOutputArtifactKind,
} from './built-in-roles.js'
import {
  createContextCatalog,
  createRoleScopedContextCatalog,
  sha256Hex,
  type ContextCatalogItemInput,
  type ContextCatalogV1,
} from './context-catalog.js'
import { buildSubagentContextEnvelope } from './context-envelope.js'
import {
  ReadOnlyLlmSubagentRunner,
  type SubagentLlmClient,
} from './read-only-llm-runner.js'
import { RunnerRegistry } from './runner-registry.js'
import {
  SessionArtifactStore,
  type SessionArtifactRecord,
  type SessionArtifactSensitivity,
} from './session-artifact-store.js'
import { FileTaskGraphStore } from './task-graph-store.js'
import { TaskNotificationQueue } from './task-notification-queue.js'
import { AgentTaskScheduler } from './task-scheduler.js'

const DEFAULT_LOCAL_ROLES = ['researcher', 'comparison'] as const satisfies readonly BuiltInAgentRoleId[]
const LOCAL_ASYNC_TASK_KINDS = ['candidate_job_research', 'trace_summarization'] as const

export interface LocalAsyncRuntimeFactoryInput {
  session: SessionRecorder
  config: AgentConfig
  llm: SubagentLlmClient
  goal: string
  taskContract?: TaskContract
  contextItems?: readonly ContextItem[]
  trace?: TraceRecorder
  allowedBuiltInRoles?: readonly BuiltInAgentRoleId[]
}

/**
 * Production local assembly for the first read-only multi-Agent slice.
 * It intentionally exposes no browser or approval capability to Subagents.
 */
export async function createLocalAsyncTaskRuntime(
  input: LocalAsyncRuntimeFactoryInput,
): Promise<AsyncTaskRuntime> {
  if (input.session.durability !== 'durable') {
    throw new Error('Local async tasks require a durable SessionRecorder.')
  }
  const session = input.session.session
  const artifactStore = new SessionArtifactStore({
    rootDir: session.outputDir,
    runId: session.runId,
    sessionId: session.sessionId,
  })
  await artifactStore.initialize()
  await materializeSeedArtifacts(artifactStore, input)

  const taskStore = new FileTaskGraphStore({
    resolveSessionDir: () => join(session.outputDir, 'async-task-state'),
  })
  const notifications = new TaskNotificationQueue()
  const toolResultReader = input.trace
    ? new FileToolResultStore({
        rootDir: join(input.trace.agentTrace?.dir ?? input.trace.dir, 'artifacts', 'tool-results'),
      })
    : undefined
  const runner = new ReadOnlyLlmSubagentRunner({
    llm: input.llm,
    artifactReader: new FileImmutableArtifactReader(session.outputDir),
    sidechainOutputDir: session.outputDir,
    runnerId: 'local-read-only-subagent',
    runnerVersion: '1.0.0',
  })
  const registry = new RunnerRegistry([runner])
  const allowedRoles = new Set(input.allowedBuiltInRoles ?? DEFAULT_LOCAL_ROLES)
  const asyncConfig = input.config.agent.asyncTasks
  const runnerLimits: RunnerLimits = {
    maxTurns: asyncConfig?.maxTurns ?? 6,
    maxToolCalls: asyncConfig?.maxToolCalls ?? 16,
    maxInputTokens: asyncConfig?.maxInputTokens ?? 12_000,
    maxOutputTokens: asyncConfig?.maxOutputTokens ?? 4_000,
    perRequestTimeoutMs: asyncConfig?.perRequestTimeoutMs ?? 60_000,
    overallTimeoutMs: asyncConfig?.overallTimeoutMs ?? 180_000,
  }

  return new AsyncTaskRuntime({
    sessionId: session.sessionId,
    runId: session.runId,
    store: taskStore,
    notifications,
    allowedTaskKinds: LOCAL_ASYNC_TASK_KINDS,
    maxQueuedTasks: asyncConfig?.maxQueuedTasks ?? 32,
    maxWaitMs: asyncConfig?.notificationWaitMs ?? 15_000,
    defaultTimeoutMs: runnerLimits.overallTimeoutMs,
    defaultLeaseDurationMs: runnerLimits.overallTimeoutMs + 30_000,
    maxRepeatedNeverRetryFailures: asyncConfig?.maxRepeatedNeverRetryFailures ?? 2,
    runnerLimits,
    scheduler: (bindings) => new AgentTaskScheduler({
      store: taskStore,
      notifications,
      registry,
      ...bindings,
      maxConcurrentReadOnlyLlmTasks: asyncConfig?.maxConcurrentReadOnlyLlmTasks ?? 2,
      maxConcurrentDeterministicTasks: asyncConfig?.maxConcurrentDeterministicTasks ?? 4,
      materializeLlmResult: async (outcome, task) => {
        if (!outcome.result.roleOutput) {
          const ref = await artifactStore.writeJson({
            artifactKind: 'runner_result',
            value: toJsonValue(outcome.result),
            actionBinding: task.actionBinding,
            summary: outcome.result.summary,
            artifactIdPrefix: `runner-result-${task.id}-attempt-${task.attempt}`,
          })
          return {
            outputRefs: [ref, outcome.result.sidechainTranscriptRef],
            freshness: outcome.result.freshness,
          }
        }
        const ref = await artifactStore.writeJson({
          artifactKind: outcome.result.roleOutput.artifactKind as BuiltInRoleOutputArtifactKind,
          value: toJsonValue({
            ...outcome.result.roleOutput,
            taskId: task.id,
            summary: outcome.result.summary,
            recommendations: outcome.result.recommendations,
            evidenceRefs: outcome.result.evidenceRefs,
            uncertainties: outcome.result.uncertainties,
          }),
          actionBinding: task.actionBinding,
          summary: outcome.result.summary,
          artifactIdPrefix: `${outcome.result.roleOutput.roleId}-${task.id}-attempt-${task.attempt}`,
        })
        return {
          outputRefs: [ref, outcome.result.sidechainTranscriptRef],
          freshness: outcome.result.freshness,
        }
      },
    }),
    contextEnvelopeProvider: async (request) => {
      if (request.builtInRole && !allowedRoles.has(request.builtInRole.role.id as BuiltInAgentRoleId)) {
        throw policyError(
          `Local multi-Agent rollout only enables ${[...allowedRoles].join(', ')}; `
          + `${request.builtInRole.role.id} remains disabled.`,
        )
      }
      return createLocalContextEnvelope({
        request,
        artifactStore,
        fallbackGoal: input.goal,
        session: input.session,
        toolResultReader,
        runnerLimits,
      })
    },
    mainVerificationProvider: async (graph) => {
      // This marker proves the readiness check ran in the Main runtime at the
      // current action fence. The normal workflow/completion gate still decides
      // whether the user task is actually complete.
      const ref = await artifactStore.writeJson({
        artifactKind: 'runner_result',
        value: {
          schemaVersion: 'main-workflow-readiness-marker/v1',
          graphRevision: graph.revision,
          actionSeq: graph.actionClock.currentActionSeq,
          checkedBy: 'main_agent_runtime',
          authoritativeCompletionEvidence: false,
        },
        actionBinding: graph.actionClock.currentActionSeq === 0
          ? { kind: 'not_action_bound' }
          : { kind: 'browser_action', sourceActionSeq: graph.actionClock.currentActionSeq },
        summary: `Main runtime readiness marker at action ${graph.actionClock.currentActionSeq}.`,
        artifactIdPrefix: `main-readiness-r${graph.revision}`,
      })
      return {
        mainWorkflowEvidenceRefs: [ref],
        verifiedAgainstActionSeq: graph.actionClock.currentActionSeq,
      }
    },
    checkpointProvider: async ({ graph, lastEventSeq, unacknowledgedNotificationIds }) => {
      const ref = await artifactStore.writeJson({
        artifactKind: 'task_graph_checkpoint',
        value: toJsonValue(graph),
        actionBinding: graph.actionClock.currentActionSeq === 0
          ? { kind: 'not_action_bound' }
          : { kind: 'browser_action', sourceActionSeq: graph.actionClock.currentActionSeq },
        summary: `Task graph checkpoint revision ${graph.revision}.`,
        artifactIdPrefix: `task-graph-checkpoint-r${graph.revision}`,
      })
      return {
        schemaVersion: 'task-graph-checkpoint-ref/v1',
        graphRevision: graph.revision,
        graphSnapshotRef: ref,
        lastEventSeq,
        unacknowledgedNotificationIds: [...unacknowledgedNotificationIds],
      }
    },
    onBackgroundError: (error) => {
      const message = error instanceof Error ? error.message : String(error)
      input.trace?.record({
        phase: 'async_tasks',
        action: `Background scheduler error: ${message}`,
        status: 'error',
      })
      void input.session.event({
        type: 'agent_task_background_error',
        message,
        data: { capability: 'local_async_tasks' },
      }).catch(() => undefined)
    },
  })
}

async function materializeSeedArtifacts(
  store: SessionArtifactStore,
  input: LocalAsyncRuntimeFactoryInput,
): Promise<void> {
  await store.writeJson({
    artifactKind: 'runner_result',
    value: toJsonValue({
      schemaVersion: 'local-async-task-seed/v1',
      goal: input.goal,
      ...(input.taskContract ? { taskContract: input.taskContract } : {}),
    }),
    actionBinding: { kind: 'not_action_bound' },
    summary: `Main task goal and contract: ${input.goal}`,
    sensitivity: 'user',
    artifactIdPrefix: 'main-task-seed',
  })

  for (const item of input.contextItems ?? []) {
    if (!item.allowedUses.includes('subagent')) continue
    const sensitivity = artifactSensitivity(item)
    if (sensitivity === 'secret') continue
    await store.writeJson({
      artifactKind: 'runner_result',
      value: toJsonValue({
        schemaVersion: 'governed-context-artifact/v1',
        contextItem: item,
      }),
      actionBinding: item.freshness.actionSeq === undefined
        ? { kind: 'not_action_bound' }
        : { kind: 'browser_action', sourceActionSeq: item.freshness.actionSeq },
      summary: `Governed context ${item.id} (${item.kind}); origin=${item.origin}; trust=${item.trust}.`,
      sensitivity,
      artifactIdPrefix: `context-${item.id}`,
    })
  }
}

async function createLocalContextEnvelope(input: {
  request: AsyncTaskContextEnvelopeRequest
  artifactStore: SessionArtifactStore
  fallbackGoal: string
  session: SessionRecorder
  toolResultReader?: FileToolResultStore
  runnerLimits: RunnerLimits
}) {
  const { request, artifactStore } = input
  const metadata = taskRoleMetadata(request)
  const objectiveText = metadata?.goal ?? taskGoal(request) ?? input.fallbackGoal
  const observationBridge = await materializeRecentObservations(
    artifactStore,
    input.session,
    request.task.actionBinding,
    input.toolResultReader,
  )
  const allRecords = await artifactStore.listRecords()
  const rawRequestedIds = new Set(metadata?.requestedArtifactIds ?? [])
  const requestedIds = new Set([...rawRequestedIds].map((id) => observationBridge.sourceArtifactIds.get(id) ?? id))
  const retainedIds = requestedIds.size > 0
    ? requestedIds
    : new Set(observationBridge.observationArtifactIds.slice(-3))
  const records = rawRequestedIds.size === 0
    ? allRecords.filter(isContextReadableRecord)
    : allRecords.filter((record) => (
        record.ref.artifactId.startsWith('main-task-seed_')
        || requestedIds.has(record.ref.artifactId)
      ))
  const missingRequestedIds = [...rawRequestedIds].filter((id) => {
    const resolved = observationBridge.sourceArtifactIds.get(id) ?? id
    return !allRecords.some((record) => record.ref.artifactId === resolved)
  })
  if (missingRequestedIds.length > 0) {
    throw artifactNotReady(`Requested artifact(s) are not available: ${missingRequestedIds.join(', ')}`)
  }

  const outputSchemaRef = await artifactStore.writeJson({
    artifactKind: 'schema',
    value: outputSchemaFor(request),
    actionBinding: request.task.actionBinding,
    summary: `Output contract for task ${request.task.id}.`,
    sensitivity: 'public',
    artifactIdPrefix: `output-schema-${request.task.id}`,
  })
  const candidates = records.map((record) => catalogCandidate(
    record,
    request,
    retainedIds.has(record.ref.artifactId),
  ))
  const catalog = roleScopedCatalog(request, candidates)
  const createdAt = new Date().toISOString()
  const grants = sensitiveGrants(catalog, request.task.id, request.sessionId, createdAt)
  const envelope = buildSubagentContextEnvelope({
    envelopeId: `envelope_${request.task.id}_${request.graph.revision}_${shortDigest(objectiveText)}`,
    taskId: request.task.id,
    taskKind: request.task.kind,
    parentRunId: request.runId,
    parentSessionId: request.sessionId,
    createdAt,
    sourceGraphRevision: request.graph.revision,
    currentActionBinding: request.task.actionBinding,
    objective: projection(objectiveText, records.slice(0, 5).map((record) => record.ref)),
    outputSchemaRef,
    ...(request.builtInRole ? { builtInRole: toBuiltInRoleEnvelopeBinding(request.builtInRole) } : {}),
    allowedTools: allowedToolsFor(request),
    catalog,
    relevanceText: `${request.task.title} ${objectiveText}`,
    sensitiveDisclosureGrants: grants,
    tokenBudget: {
      maxInputTokens: input.runnerLimits.maxInputTokens,
      fixedEnvelopeTokens: 500,
      reservedOutputTokens: input.runnerLimits.maxOutputTokens,
    },
  })
  const artifactRef = await artifactStore.writeJson({
    artifactKind: 'context_envelope',
    value: toJsonValue(envelope),
    actionBinding: request.task.actionBinding,
    summary: `Isolated Context Envelope for task ${request.task.id}.`,
    sensitivity: grants.length > 0 ? 'sensitive' : 'user',
    artifactIdPrefix: `context-envelope-${request.task.id}-r${request.graph.revision}`,
  })
  return { envelope, artifactRef }
}

async function materializeRecentObservations(
  store: SessionArtifactStore,
  session: SessionRecorder,
  actionBinding: AsyncTaskContextEnvelopeRequest['task']['actionBinding'],
  toolResultReader?: FileToolResultStore,
): Promise<{
  sourceArtifactIds: Map<string, string>
  observationArtifactIds: string[]
}> {
  const entries = await readJsonLines<TranscriptEntry>(session.session.transcriptPath)
  const observations = entries
    .filter((entry): entry is Extract<TranscriptEntry, { type: 'tool_result' }> => (
      entry.type === 'tool_result'
      && entry.ok
      && READ_ONLY_OBSERVATION_TOOLS.has(entry.name)
    ))
    .slice(-8)

  const sourceArtifactIds = new Map<string, string>()
  const observationArtifactIds: string[] = []

  for (const entry of observations) {
    const importedArtifacts = await importToolResultArtifacts(entry, session, toolResultReader)
    const ref = await store.writeJson({
      artifactKind: 'runner_result',
      value: toJsonValue({
        schemaVersion: 'main-tool-observation-artifact/v1',
        toolCallId: entry.toolCallId,
        toolName: entry.name,
        capturedAt: entry.ts,
        capturedActionBinding: actionBinding,
        result: entry.result ?? null,
        artifacts: entry.artifacts ?? [],
        ...(importedArtifacts.length > 0 ? { importedArtifacts } : {}),
      }),
      actionBinding,
      summary: observationSummary(entry),
      sensitivity: 'sensitive',
      artifactIdPrefix: `observation-${entry.name}-${entry.toolCallId}`,
    })
    observationArtifactIds.push(ref.artifactId)
    for (const artifact of entry.artifacts ?? []) {
      if (isOwnedReadOnlyToolArtifact(artifact, entry, session)) {
        sourceArtifactIds.set(artifact.artifactId, ref.artifactId)
      }
    }
  }
  return { sourceArtifactIds, observationArtifactIds }
}

async function importToolResultArtifacts(
  entry: Extract<TranscriptEntry, { type: 'tool_result' }>,
  session: SessionRecorder,
  reader?: FileToolResultStore,
): Promise<JsonValue[]> {
  if (!reader) return []
  const imported: JsonValue[] = []
  for (const artifact of entry.artifacts ?? []) {
    if (!isOwnedReadOnlyToolArtifact(artifact, entry, session)) continue
    try {
      const envelope = await reader.read(artifact)
      imported.push(toJsonValue({
        sourceArtifactId: artifact.artifactId,
        kind: artifact.kind,
        mediaType: artifact.mediaType,
        summary: artifact.summary ?? observationSummary(entry),
        content: envelope.content,
        ...(envelope.metadata ? { metadata: envelope.metadata } : {}),
      }))
    } catch {
      // The compact transcript observation remains usable. A missing or corrupt
      // external artifact is never trusted or promoted into the Subagent store.
    }
  }
  return imported
}

function isOwnedReadOnlyToolArtifact(
  artifact: ToolResultArtifactRef,
  entry: Extract<TranscriptEntry, { type: 'tool_result' }>,
  session: SessionRecorder,
): boolean {
  return artifact.schemaVersion === 'tool-result-artifact-ref/v1'
    && artifact.runId === session.session.runId
    && artifact.sessionId === session.session.sessionId
    && artifact.toolCallId === entry.toolCallId
    && artifact.toolName === entry.name
    && artifact.sensitivity !== 'secret'
    && READ_ONLY_OBSERVATION_TOOLS.has(artifact.toolName)
}

function roleScopedCatalog(
  request: AsyncTaskContextEnvelopeRequest,
  candidates: ContextCatalogItemInput[],
): ContextCatalogV1 {
  if (!request.builtInRole) {
    return createContextCatalog({
      parentRunId: request.runId,
      parentSessionId: request.sessionId,
      catalogRevision: request.graph.revision,
      candidates,
    })
  }
  return createRoleScopedContextCatalog({
    role: request.builtInRole.role,
    runtimeTaskKind: request.builtInRole.runtimeTaskKind,
    parentRunId: request.runId,
    parentSessionId: request.sessionId,
    catalogRevision: request.graph.revision,
    candidates,
  }).catalog
}

function catalogCandidate(
  record: SessionArtifactRecord,
  request: AsyncTaskContextEnvelopeRequest,
  explicitlyRequested: boolean,
): ContextCatalogItemInput {
  const ref = record.ref
  return {
    provenance: {
      kind: 'workflow',
      workflowId: 'local-async-artifact-catalog',
      workflowRunId: request.runId,
      stateRevision: request.graph.revision,
      evidenceRefs: [ref],
      actionBinding: ref.actionBinding,
    },
    sensitivity: record.sensitivity,
    allowedTaskKinds: [request.task.kind],
    tokenEstimate: Math.max(1, Math.ceil(ref.byteLength / 4)),
    retention: explicitlyRequested || ref.artifactId.startsWith('main-task-seed_')
      ? 'task_input'
      : 'optional',
    actionBinding: ref.actionBinding,
    relevanceTerms: relevanceTerms(`${record.summary} ${ref.artifactKind} ${ref.artifactId}`),
    maxActionLag: 0,
    allowStale: false,
    content: {
      kind: 'context_unit',
      unit: {
        kind: 'artifact',
        artifactRef: ref,
        sanitizedSummary: projection(record.summary),
      },
    },
  }
}

function sensitiveGrants(
  catalog: ContextCatalogV1,
  taskId: string,
  sessionId: string,
  createdAt: string,
): SensitiveDisclosureGrantRefV1[] {
  const sensitiveIds = catalog.items
    .filter((item) => item.sensitivity === 'sensitive' && item.availability === 'selectable')
    .map((item) => item.id)
    .sort()
  if (sensitiveIds.length === 0) return []
  const grantBody = {
    sessionId,
    taskId,
    allowedContextItemIds: sensitiveIds,
    purpose: 'async_task_context',
    issuedBy: 'main_agent_runtime_policy',
    issuedAt: createdAt,
    expiresAt: new Date(Date.parse(createdAt) + 5 * 60_000).toISOString(),
  } as const
  return [{
    schemaVersion: 'sensitive-disclosure-grant/v1',
    grantId: `grant_${shortDigest(JSON.stringify(grantBody))}`,
    ...grantBody,
    grantDigest: sha256Hex(JSON.stringify(grantBody)),
  }]
}

function outputSchemaFor(request: AsyncTaskContextEnvelopeRequest): JsonValue {
  if (!request.builtInRole) {
    return {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      required: ['summary', 'recommendations', 'evidenceRefs', 'uncertainties'],
    }
  }
  const binding = getBuiltInRoleRuntimeBinding(request.builtInRole.role.id as BuiltInAgentRoleId)
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: `${binding.role.id} output`,
    type: 'object',
    required: ['summary', 'recommendations', 'evidenceRefs', 'uncertainties', 'roleOutput'],
    roleOutput: {
      artifactKind: binding.output.artifactKind,
      payloadSchemaVersion: binding.output.payloadSchemaVersion,
      requiredPayloadFields: [...binding.output.requiredFields],
    },
  }
}

function allowedToolsFor(request: AsyncTaskContextEnvelopeRequest): ReadOnlyArtifactToolName[] {
  return request.builtInRole
    ? [...request.builtInRole.role.allowedTools]
    : [...CONTRACT_READ_ONLY_ARTIFACT_TOOL_NAMES]
}

function taskRoleMetadata(request: AsyncTaskContextEnvelopeRequest) {
  return request.task.inputs
    .filter((item) => item.kind === 'goal')
    .map((item) => parseBuiltInRoleTaskMetadata(item.structuredValue))
    .find((item) => item !== undefined)
}

function taskGoal(request: AsyncTaskContextEnvelopeRequest): string | undefined {
  for (const item of request.task.inputs) {
    if (item.kind !== 'goal' || !item.structuredValue || typeof item.structuredValue !== 'object'
      || Array.isArray(item.structuredValue)) continue
    const goal = item.structuredValue.goal
    if (typeof goal === 'string' && goal.trim()) return goal.trim()
  }
  return undefined
}

function projection(
  text: string,
  sourceArtifactRefs: ImmutableArtifactRef[] = [],
): SanitizedTextProjectionV1 {
  const bounded = text.replace(/"role"\s*:\s*"(assistant|tool|user)"|tool_calls|chain.of.thought/gi, '[redacted]')
    .slice(0, 2_000)
  return {
    schemaVersion: 'sanitized-text-projection/v1',
    text: bounded,
    projectionPolicy: 'no_react_history/v1',
    sourceArtifactRefs,
    sourceItemCount: Math.min(sourceArtifactRefs.length, 5),
    maxChars: 2_000,
    contentDigest: sha256Hex(bounded),
  }
}

function relevanceTerms(value: string): string[] {
  return [...new Set(value.toLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter((term) => term.length >= 2))]
    .slice(0, 40)
}

function isContextReadableRecord(record: SessionArtifactRecord): boolean {
  return record.sensitivity !== 'secret'
    && record.ref.artifactKind !== 'context_envelope'
    && record.ref.artifactKind !== 'task_graph_checkpoint'
    && record.ref.artifactKind !== 'schema'
    && record.ref.artifactKind !== 'sidechain_transcript'
}

function artifactSensitivity(item: ContextItem): SessionArtifactSensitivity {
  if (item.sensitivity === 'public') return 'public'
  if (item.sensitivity === 'internal' || item.sensitivity === 'personal') return 'sensitive'
  return 'secret'
}

function observationSummary(entry: Extract<TranscriptEntry, { type: 'tool_result' }>): string {
  const result = entry.result && typeof entry.result === 'object' && !Array.isArray(entry.result)
    ? entry.result as Record<string, unknown>
    : undefined
  const observation = typeof result?.observation === 'string'
    ? result.observation.replace(/\s+/g, ' ').trim().slice(0, 400)
    : ''
  return [
    `Main Agent read-only observation from ${entry.name} (${entry.toolCallId}) at ${entry.ts}.`,
    observation,
  ].filter(Boolean).join(' ')
}

function toJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}

function shortDigest(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16)
}

function policyError(message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code: 'POLICY_VIOLATION' })
}

function artifactNotReady(message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code: 'ARTIFACT_NOT_READY' })
}

const READ_ONLY_OBSERVATION_TOOLS = new Set([
  'browser_open',
  'browser_snapshot',
  'browser_form_snapshot',
  'browser_form_audit',
  'browser_screenshot',
  'browser_inspect_options',
  'browser_wait',
])
