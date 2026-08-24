import { createHash, randomUUID } from 'node:crypto'
import type {
  ActionBinding,
  AgentTask,
  AgentTaskCompactFactV1,
  AgentTaskEvent,
  AgentTaskGraphV2,
  AgentTaskInput,
  AgentTaskRunRequestV1,
  AgentTaskRunnerV1,
  AgentTaskStatus,
  AgentTaskResumeAttachmentV1,
  BackgroundAgentTaskKind,
  BrowserActionClockV1,
  BrowserActionSourceV1,
  ImmutableArtifactRef,
  MainCompletionReadinessV1,
  ReadOnlyLlmTaskKind,
  ResultFreshnessVerdict,
  RunnerLimits,
  RunningBackgroundAgentTask,
  SubagentContextEnvelopeV1,
  TaskCompletionRequirement,
  TaskContractError,
  TaskGraphCheckpointRefV1,
  TaskLeaseRecoveryDecisionV1,
  TaskNotificationAcknowledgementV1,
  TaskNotificationDelivery,
  TaskNotificationPromptAttachmentV1,
  TaskNotificationV1,
  TaskRunIdentity,
  TaskSpawnResolutionV1,
  IsoUtcTimestamp,
} from './async-task-contracts.js'
import {
  addAgentTaskV2,
  createAgentTaskGraphV2,
  createAgentTaskV2,
  finalizeAgentTaskGraphMutationV2,
  resolveAgentTaskSpawnV2,
} from './task-graph.js'
import type { TaskGraphStore } from './task-graph-store.js'
import { AgentTaskScheduler, type TaskRunRequestFactory } from './task-scheduler.js'
import { TaskNotificationQueue } from './task-notification-queue.js'
import { buildAgentTaskCompactFacts } from './async-task-resume.js'
import {
  createBuiltInRoleTaskMetadata,
  getBuiltInRoleRuntimeBinding,
  parseBuiltInRoleTaskMetadata,
  toBuiltInRoleEnvelopeBinding,
  type BuiltInAgentRoleId,
  type BuiltInRoleRuntimeBinding,
} from './built-in-roles.js'

export const ASYNC_TASK_BACKGROUND_KINDS = [
  'candidate_job_research',
  'trace_summarization',
  'memory_retrieval',
  'workflow_evaluation',
  'delivery_probe',
] as const satisfies readonly BackgroundAgentTaskKind[]

const READ_ONLY_LLM_KINDS = [
  'candidate_job_research',
  'trace_summarization',
] as const satisfies readonly ReadOnlyLlmTaskKind[]

export interface AsyncTaskContextEnvelopeBinding {
  envelope: SubagentContextEnvelopeV1
  artifactRef: ImmutableArtifactRef<'context_envelope'>
}

export interface AsyncTaskContextEnvelopeRequest {
  mode: 'spawn' | 'restore'
  sessionId: string
  runId: string
  graph: AgentTaskGraphV2
  task: Extract<AgentTask, { kind: ReadOnlyLlmTaskKind }>
  builtInRole?: BuiltInRoleRuntimeBinding
  existingEnvelopeRef?: ImmutableArtifactRef<'context_envelope'>
}

export type AsyncTaskContextEnvelopeProvider = (
  request: AsyncTaskContextEnvelopeRequest,
) => AsyncTaskContextEnvelopeBinding | Promise<AsyncTaskContextEnvelopeBinding>

export interface AsyncTaskMainVerification {
  mainWorkflowEvidenceRefs: [ImmutableArtifactRef, ...ImmutableArtifactRef[]]
  verifiedAgainstActionSeq: number
}

export interface AsyncTaskCheckpointRequest {
  graph: AgentTaskGraphV2
  lastEventSeq: number
  unacknowledgedNotificationIds: string[]
}

export type AsyncTaskCheckpointProvider = (
  request: AsyncTaskCheckpointRequest,
) => TaskGraphCheckpointRefV1 | Promise<TaskGraphCheckpointRefV1>

export interface AsyncTaskSchedulerBindings {
  resolveContextEnvelopeRef(task: AgentTask, graph: AgentTaskGraphV2): ImmutableArtifactRef<'context_envelope'>
  requestFactory: TaskRunRequestFactory
}

export type AsyncTaskSchedulerInjection =
  | AgentTaskScheduler
  | ((bindings: AsyncTaskSchedulerBindings) => AgentTaskScheduler)

export interface AsyncTaskRuntimeOptions {
  sessionId: string
  runId: string
  store: TaskGraphStore
  scheduler: AsyncTaskSchedulerInjection
  notifications: TaskNotificationQueue
  contextEnvelopeProvider?: AsyncTaskContextEnvelopeProvider
  mainVerificationProvider?: (
    graph: AgentTaskGraphV2,
  ) => AsyncTaskMainVerification | Promise<AsyncTaskMainVerification>
  checkpointProvider?: AsyncTaskCheckpointProvider
  persistPromptAttachment?: (attachment: TaskNotificationPromptAttachmentV1) => Promise<void>
  allowedTaskKinds?: readonly BackgroundAgentTaskKind[]
  maxQueuedTasks?: number
  defaultMaxAttempts?: number
  defaultTimeoutMs?: number
  defaultLeaseDurationMs?: number
  maxWaitMs?: number
  runnerLimits?: Partial<RunnerLimits>
  initialActionSeq?: number
  now?: () => Date
  onBackgroundError?: (error: unknown) => void
}

export interface AsyncTaskInitializeInput {
  persistedPromptAttachments?: readonly TaskNotificationPromptAttachmentV1[]
}

export interface AsyncTaskRestoreInput extends AsyncTaskInitializeInput {}

export interface AsyncTaskRestoreResult {
  graph: AgentTaskGraphV2
  reconciledPromptAttachments: number
  leaseRecoveryDecisions: TaskLeaseRecoveryDecisionV1[]
}

export interface AsyncTaskCompletionRequirementInput {
  requiredForCompletion: boolean
  terminalPolicy: 'must_complete_successfully' | 'terminal_is_sufficient' | 'does_not_block'
}

export interface AsyncTaskSpawnInput {
  taskId?: string
  kind: BackgroundAgentTaskKind | 'main_browser_step'
  title: string
  inputs?: readonly AgentTaskInput[]
  blockedBy?: readonly string[]
  blocks?: readonly string[]
  priority?: number
  idempotencyKey: string
  completionRequirement?: TaskCompletionRequirement | AsyncTaskCompletionRequirementInput
  actionBinding?: ActionBinding
}

export interface AsyncTaskSpawnBuiltInRoleInput {
  taskId?: string
  roleId: BuiltInAgentRoleId
  title: string
  goal: string
  requestedArtifactIds?: readonly string[]
  blockedBy?: readonly string[]
  blocks?: readonly string[]
  priority?: number
  idempotencyKey: string
  completionRequirement?: TaskCompletionRequirement | AsyncTaskCompletionRequirementInput
  actionBinding?: ActionBinding
}

export interface AsyncTaskProjection {
  taskId: string
  kind: AgentTask['kind']
  roleId?: BuiltInAgentRoleId
  title: string
  status: AgentTaskStatus
  graphRevision: number
  attempt: number
  completionRequirement: TaskCompletionRequirement
  outputRefs: ImmutableArtifactRef[]
  freshness?: ResultFreshnessVerdict
  lastError?: TaskContractError
  requiresMainWorkflowVerification: true
  authoritativeCompletionEvidence: false
}

export interface AsyncTaskListInput {
  statuses?: readonly AgentTaskStatus[]
  kinds?: readonly BackgroundAgentTaskKind[]
}

export interface AsyncTaskWaitResult {
  waitOutcome: 'terminal' | 'changed' | 'timeout' | 'aborted'
  task: AsyncTaskProjection
}

export interface AsyncTaskResult {
  taskId: string
  roleId?: BuiltInAgentRoleId
  status: AgentTaskStatus
  available: boolean
  outputs: AgentTask['outputs']
  outputRefs: ImmutableArtifactRef[]
  freshness?: ResultFreshnessVerdict
  lastError?: TaskContractError
  requiresMainWorkflowVerification: true
  authoritativeCompletionEvidence: false
}

export interface AsyncTaskCancelResult {
  changed: boolean
  task: AsyncTaskProjection
}

export interface AsyncTaskNotificationClaimInput {
  claimantId: string
  claimLeaseMs?: number
  sessionId?: string
}

export type ClaimedTaskNotification = {
  notification: TaskNotificationV1
  delivery: Extract<TaskNotificationDelivery, { state: 'claimed' }>
}

export interface AsyncTaskResumeAttachmentInput {
  checkpoint?: TaskGraphCheckpointRefV1
  persistedPromptAttachments?: readonly TaskNotificationPromptAttachmentV1[]
  resumedAt?: string
}

export interface RecordBrowserActionInput {
  actionId: string
  source: BrowserActionSourceV1
  occurredAt?: IsoUtcTimestamp
}

interface HydrationResult {
  graph: AgentTaskGraphV2
  reconciledPromptAttachments: number
  leaseRecoveryDecisions: TaskLeaseRecoveryDecisionV1[]
}

class SpawnResolutionSignal {
  constructor(readonly resolution: Exclude<TaskSpawnResolutionV1, { outcome: 'created' }>) {}
}

/**
 * Session-scoped facade over the durable graph, scheduler, and notification queue.
 * It deliberately owns no parent chat messages; S004 envelopes arrive only through
 * the injected provider and are cached as immutable runner inputs.
 */
export class AsyncTaskRuntime {
  readonly sessionId: string
  readonly runId: string

  private readonly store: TaskGraphStore
  private readonly notifications: TaskNotificationQueue
  private readonly scheduler: AgentTaskScheduler
  private readonly contextEnvelopeProvider?: AsyncTaskContextEnvelopeProvider
  private readonly mainVerificationProvider?: AsyncTaskRuntimeOptions['mainVerificationProvider']
  private readonly checkpointProvider?: AsyncTaskCheckpointProvider
  private readonly persistPromptAttachmentCallback?: AsyncTaskRuntimeOptions['persistPromptAttachment']
  private readonly allowedTaskKinds: ReadonlySet<BackgroundAgentTaskKind>
  private readonly maxQueuedTasks: number
  private readonly defaultMaxAttempts: number
  private readonly defaultTimeoutMs: number
  private readonly defaultLeaseDurationMs: number
  private readonly maxWaitMs: number
  private readonly runnerLimits: RunnerLimits
  private readonly initialActionSeq: number
  private readonly now: () => Date
  private readonly onBackgroundError?: (error: unknown) => void
  private readonly envelopeBindings = new Map<string, AsyncTaskContextEnvelopeBinding>()
  private initialized = false
  private aborted = false
  private lifecycleChain: Promise<void> = Promise.resolve()
  private wakePromise?: Promise<void>

  constructor(options: AsyncTaskRuntimeOptions) {
    if (!options.sessionId.trim() || !options.runId.trim()) {
      throw new Error('AsyncTaskRuntime requires non-empty sessionId and runId.')
    }
    this.sessionId = options.sessionId
    this.runId = options.runId
    this.store = options.store
    this.notifications = options.notifications
    this.contextEnvelopeProvider = options.contextEnvelopeProvider
    this.mainVerificationProvider = options.mainVerificationProvider
    this.checkpointProvider = options.checkpointProvider
    this.persistPromptAttachmentCallback = options.persistPromptAttachment
    this.allowedTaskKinds = validateAllowedKinds(options.allowedTaskKinds ?? ASYNC_TASK_BACKGROUND_KINDS)
    this.maxQueuedTasks = positiveInteger(options.maxQueuedTasks ?? 32, 'maxQueuedTasks')
    this.defaultMaxAttempts = positiveInteger(options.defaultMaxAttempts ?? 2, 'defaultMaxAttempts')
    this.defaultTimeoutMs = positiveInteger(options.defaultTimeoutMs ?? 120_000, 'defaultTimeoutMs')
    this.defaultLeaseDurationMs = positiveInteger(options.defaultLeaseDurationMs ?? 150_000, 'defaultLeaseDurationMs')
    this.maxWaitMs = nonNegativeInteger(options.maxWaitMs ?? 15_000, 'maxWaitMs')
    this.initialActionSeq = nonNegativeInteger(options.initialActionSeq ?? 0, 'initialActionSeq')
    this.now = options.now ?? (() => new Date())
    this.onBackgroundError = options.onBackgroundError
    this.runnerLimits = normalizeRunnerLimits(options.runnerLimits, this.defaultTimeoutMs)

    const bindings: AsyncTaskSchedulerBindings = {
      resolveContextEnvelopeRef: (task) => this.requireContextEnvelopeBinding(task.id).artifactRef,
      requestFactory: (task, graph, runner, identity) => this.createRunRequest(task, graph, runner, identity),
    }
    this.scheduler = typeof options.scheduler === 'function'
      ? options.scheduler(bindings)
      : options.scheduler
  }

  async initialize(input: AsyncTaskInitializeInput = {}): Promise<AgentTaskGraphV2> {
    return this.serializedLifecycle(async () => {
      let graph = await this.store.load(this.sessionId)
      if (!graph) {
        const created = createAgentTaskGraphV2({
          sessionId: this.sessionId,
          runId: this.runId,
          currentActionSeq: this.initialActionSeq,
          now: this.iso(),
        })
        try {
          await this.store.create(created)
          graph = created
        } catch (error) {
          if (errorCode(error) !== 'GRAPH_ALREADY_EXISTS') throw error
          graph = await this.store.load(this.sessionId)
        }
      }
      if (!graph) throw runtimeError('GRAPH_NOT_FOUND', `Task graph was not created for session ${this.sessionId}.`)
      const hydrated = await this.hydrate(graph, input.persistedPromptAttachments ?? [])
      this.initialized = true
      return hydrated.graph
    })
  }

  async restore(input: AsyncTaskRestoreInput = {}): Promise<AsyncTaskRestoreResult> {
    return this.serializedLifecycle(async () => {
      const graph = await this.store.load(this.sessionId)
      if (!graph) throw runtimeError('GRAPH_NOT_FOUND', `Task graph not found for session ${this.sessionId}.`)
      const hydrated = await this.hydrate(graph, input.persistedPromptAttachments ?? [])
      this.initialized = true
      return hydrated
    })
  }

  async spawn(input: AsyncTaskSpawnInput): Promise<TaskSpawnResolutionV1> {
    await this.ensureInitialized()
    return this.serializedLifecycle(async () => {
      if (this.aborted) throw runtimeError('SESSION_ABORTED', `Session ${this.sessionId} has been aborted.`)
      const kind = this.requireBackgroundKind(input.kind)
      const graph = await this.requireGraph()
      const normalized = normalizeSpawnInput(input, kind, graph, this)
      const task = createAgentTaskV2({
      id: input.taskId,
      kind,
      title: normalized.title,
      priority: normalized.priority,
      blockedBy: normalized.blockedBy,
      blocks: normalized.blocks,
      inputs: normalized.inputs,
      actionBinding: normalized.actionBinding,
      idempotency: normalized.idempotency,
      completionRequirement: normalized.completionRequirement,
      maxAttempts: this.defaultMaxAttempts,
      timeoutMs: this.defaultTimeoutMs,
      leaseDurationMs: this.defaultLeaseDurationMs,
      now: normalized.now,
      })

      const preflight = resolveAgentTaskSpawnV2(graph, task)
      if (preflight.outcome !== 'created') return preflight

      let binding: AsyncTaskContextEnvelopeBinding | undefined
      if (isReadOnlyLlmKind(kind)) {
        binding = await this.provideContextEnvelope('spawn', graph, task as Extract<AgentTask, { kind: ReadOnlyLlmTaskKind }>)
      }

      try {
        const committed = await this.store.transact(this.sessionId, (current) => {
          this.assertGraphIdentity(current)
          const resolution = resolveAgentTaskSpawnV2(current, task)
          if (resolution.outcome !== 'created') throw new SpawnResolutionSignal(resolution)
          const queued = current.tasks.filter((candidate) => !isTerminal(candidate)).length
          if (queued >= this.maxQueuedTasks) {
            throw runtimeError('QUEUE_CAPACITY_EXCEEDED', `Session ${this.sessionId} already has ${queued} nonterminal task(s).`)
          }
          const draft = addAgentTaskV2(current, task)
          const event = createdEvent(current, task, normalized.now)
          return finalizeAgentTaskGraphMutationV2(current, draft, event, normalized.now)
        })
        if (binding) this.envelopeBindings.set(task.id, clone(binding))
        void this.wake()
        const created = committed.graph.tasks.find((candidate) => candidate.id === task.id)
        if (!created) throw runtimeError('TASK_NOT_FOUND', `Committed task ${task.id} is missing from its graph.`)
        return { schemaVersion: 'task-spawn-resolution/v1', outcome: 'created', task: clone(created) }
      } catch (error) {
        if (error instanceof SpawnResolutionSignal) return error.resolution
        throw error
      }
    })
  }

  /**
   * Role-aware compatibility entrypoint for the single Agent Loop. The durable
   * graph keeps its accepted v2 task kinds while the immutable goal input binds
   * the exact built-in role, output contract, and read-only runner kind.
   */
  async spawnBuiltInRole(input: AsyncTaskSpawnBuiltInRoleInput): Promise<TaskSpawnResolutionV1> {
    const metadata = createBuiltInRoleTaskMetadata({
      roleId: input.roleId,
      goal: input.goal,
      requestedArtifactIds: input.requestedArtifactIds,
    })
    return this.spawn({
      ...(input.taskId ? { taskId: input.taskId } : {}),
      kind: metadata.runtimeTaskKind,
      title: input.title,
      inputs: [{ kind: 'goal', structuredValue: metadata }],
      ...(input.blockedBy ? { blockedBy: input.blockedBy } : {}),
      ...(input.blocks ? { blocks: input.blocks } : {}),
      ...(input.priority !== undefined ? { priority: input.priority } : {}),
      idempotencyKey: input.idempotencyKey,
      ...(input.completionRequirement ? { completionRequirement: input.completionRequirement } : {}),
      ...(input.actionBinding ? { actionBinding: input.actionBinding } : {}),
    })
  }

  async status(taskId: string): Promise<AsyncTaskProjection> {
    await this.ensureInitialized()
    const graph = await this.requireGraph()
    return projectTask(requireTask(graph, taskId), graph.revision)
  }

  async list(input: AsyncTaskListInput = {}): Promise<AsyncTaskProjection[]> {
    await this.ensureInitialized()
    const graph = await this.requireGraph()
    const statuses = input.statuses ? new Set(input.statuses) : undefined
    const kinds = input.kinds ? new Set(input.kinds) : undefined
    return graph.tasks
      .filter((task) => (!statuses || statuses.has(task.status)) && (!kinds || kinds.has(task.kind as BackgroundAgentTaskKind)))
      .map((task) => projectTask(task, graph.revision))
  }

  async snapshot(): Promise<AgentTaskGraphV2> {
    await this.ensureInitialized()
    return clone(await this.requireGraph())
  }

  async recordBrowserAction(input: RecordBrowserActionInput): Promise<BrowserActionClockV1> {
    await this.ensureInitialized()
    if (this.aborted) throw runtimeError('SESSION_ABORTED', `Session ${this.sessionId} has been aborted.`)
    return this.serializedLifecycle(async () => {
      const actionId = requireNonEmpty(input.actionId, 'actionId')
      const events = await this.store.readEvents(this.sessionId)
      const existing = events.find((event) => (
        event.eventType === 'browser_action_advanced' && event.payload.actionId === actionId
      ))
      if (existing?.eventType === 'browser_action_advanced') {
        if (canonicalJson(existing.payload.source) !== canonicalJson(input.source)) {
          throw runtimeError('IDEMPOTENCY_CONFLICT', `Browser action ${actionId} was replayed with a different source.`)
        }
        return clone((await this.requireGraph()).actionClock)
      }

      const occurredAt = input.occurredAt ?? this.iso()
      const committed = await this.store.transact(this.sessionId, (current) => {
        this.assertGraphIdentity(current)
        const previousActionSeq = current.actionClock.currentActionSeq
        const currentActionSeq = previousActionSeq + 1
        const draft = clone(current)
        draft.actionClock = {
          ...draft.actionClock,
          currentActionSeq,
          updatedAt: occurredAt,
        }
        const event: Extract<AgentTaskEvent, { eventType: 'browser_action_advanced' }> = {
          schemaVersion: 'agent-task-event/v1',
          eventId: `event_${randomUUID()}`,
          eventSeq: current.nextEventSeq,
          eventType: 'browser_action_advanced',
          scope: 'graph',
          sessionId: current.sessionId,
          graphId: current.graphId,
          occurredAt,
          revisionBefore: current.revision,
          revisionAfter: current.revision + 1,
          actionBinding: { kind: 'browser_action', sourceActionSeq: currentActionSeq },
          correlationId: `browser_action_${actionId}`,
          payload: {
            actionId,
            previousActionSeq,
            currentActionSeq,
            source: clone(input.source),
          },
          authoritativeTaskState: true,
          authoritativeCompletionEvidence: false,
        }
        return finalizeAgentTaskGraphMutationV2(current, draft, event, occurredAt)
      })
      return clone(committed.graph.actionClock)
    })
  }

  async wait(taskId: string, timeoutMs = this.maxWaitMs, signal: AbortSignal = new AbortController().signal): Promise<AsyncTaskWaitResult> {
    await this.ensureInitialized()
    const before = await this.status(taskId)
    if (isTerminalStatus(before.status)) return { waitOutcome: 'terminal', task: before }
    await this.wake()
    const afterWake = await this.status(taskId)
    if (isTerminalStatus(afterWake.status)) return { waitOutcome: 'terminal', task: afterWake }
    if (afterWake.graphRevision !== before.graphRevision || afterWake.status !== before.status) {
      return { waitOutcome: 'changed', task: afterWake }
    }
    const outcome = await this.notifications.waitForChange(
      this.sessionId,
      signal,
      Math.min(nonNegativeInteger(timeoutMs, 'timeoutMs'), this.maxWaitMs),
    )
    const task = await this.status(taskId)
    return {
      waitOutcome: isTerminalStatus(task.status) ? 'terminal' : outcome,
      task,
    }
  }

  async result(taskId: string): Promise<AsyncTaskResult> {
    await this.ensureInitialized()
    const graph = await this.requireGraph()
    const task = requireTask(graph, taskId)
    const builtInRole = builtInRoleBindingForTask(task)
    const available = task.status === 'completed'
    const outputs = available ? clone(task.outputs) : []
    return {
      taskId,
      ...(builtInRole ? { roleId: builtInRole.role.id as BuiltInAgentRoleId } : {}),
      status: task.status,
      available,
      outputs,
      outputRefs: outputs.map((output) => clone(output.artifactRef)),
      ...(outputs.at(-1)?.freshness ? { freshness: clone(outputs.at(-1)!.freshness) } : {}),
      ...(task.lastError ? { lastError: clone(task.lastError) } : {}),
      requiresMainWorkflowVerification: true,
      authoritativeCompletionEvidence: false,
    }
  }

  async resultRefs(taskId: string): Promise<ImmutableArtifactRef[]> {
    return (await this.result(taskId)).outputRefs
  }

  async cancel(taskId: string, reason: 'user' | 'superseded' = 'user'): Promise<AsyncTaskCancelResult> {
    await this.ensureInitialized()
    return this.serializedLifecycle(async () => {
      requireTask(await this.requireGraph(), taskId)
      const changed = await this.scheduler.cancelTask(this.sessionId, taskId, reason)
      return { changed, task: await this.status(taskId) }
    })
  }

  async tick(): Promise<void> {
    await this.ensureInitialized()
    await this.serializedLifecycle(async () => {
      if (!this.aborted) await this.scheduler.tick(this.sessionId)
    })
  }

  wake(): Promise<void> {
    if (this.wakePromise) return this.wakePromise
    const pending = Promise.resolve()
      .then(() => this.ensureInitialized())
      .then(() => this.serializedLifecycle(async () => {
        if (!this.aborted) await this.scheduler.tick(this.sessionId)
      }))
      .finally(() => {
        if (this.wakePromise === pending) this.wakePromise = undefined
      })
    pending.catch((error) => this.onBackgroundError?.(error))
    this.wakePromise = pending
    return pending
  }

  /** Claim-only drain. Every returned delivery remains claimed until explicit ack. */
  async drainNotifications(input: AsyncTaskNotificationClaimInput): Promise<ClaimedTaskNotification[]> {
    await this.ensureInitialized()
    this.assertOptionalSessionId(input.sessionId)
    await this.reconcileOutbox(await this.requireGraph())
    await this.notifications.releaseExpiredClaims(this.iso())
    return this.notifications.claimAvailable(
      this.sessionId,
      requireNonEmpty(input.claimantId, 'claimantId'),
      positiveInteger(input.claimLeaseMs ?? 30_000, 'claimLeaseMs'),
    )
  }

  async acknowledgeNotification(acknowledgement: TaskNotificationAcknowledgementV1): Promise<void> {
    await this.ensureInitialized()
    await this.scheduler.acknowledgeNotification(this.sessionId, clone(acknowledgement))
  }

  async claimPromptUpdates(input: AsyncTaskNotificationClaimInput): Promise<ClaimedTaskNotification[]> {
    return this.drainNotifications(input)
  }

  async acknowledgePromptUpdate(input: {
    sessionId?: string
    acknowledgement: TaskNotificationAcknowledgementV1
  }): Promise<void> {
    this.assertOptionalSessionId(input.sessionId)
    await this.acknowledgeNotification(input.acknowledgement)
  }

  async persistPromptAttachment(attachment: TaskNotificationPromptAttachmentV1): Promise<void> {
    this.assertOptionalSessionId(attachment.sessionId)
    if (!this.persistPromptAttachmentCallback) {
      throw runtimeError('ARTIFACT_NOT_READY', 'No durable prompt-attachment persistence callback was injected.')
    }
    await this.persistPromptAttachmentCallback(clone(attachment))
  }

  async waitForChange(
    sessionId: string,
    signal: AbortSignal,
    timeoutMs: number,
  ): Promise<'changed' | 'timeout' | 'aborted'> {
    this.assertOptionalSessionId(sessionId)
    await this.ensureInitialized()
    return this.notifications.waitForChange(
      this.sessionId,
      signal,
      Math.min(nonNegativeInteger(timeoutMs, 'timeoutMs'), this.maxWaitMs),
    )
  }

  async completionReadiness(verification?: AsyncTaskMainVerification): Promise<MainCompletionReadinessV1> {
    await this.ensureInitialized()
    const graph = await this.requireGraph()
    const pendingOrRunningTaskIds: string[] = []
    const failedOrKilledTaskIds: string[] = []
    for (const task of graph.tasks) {
      if (!task.requiredForCompletion) continue
      if (task.status === 'pending' || task.status === 'blocked' || task.status === 'running') {
        pendingOrRunningTaskIds.push(task.id)
      } else if ((task.status === 'failed' || task.status === 'killed')
        && task.terminalPolicy === 'must_complete_successfully') {
        failedOrKilledTaskIds.push(task.id)
      }
    }
    if (pendingOrRunningTaskIds.length > 0 || failedOrKilledTaskIds.length > 0) {
      return {
        schemaVersion: 'main-completion-readiness/v1',
        state: 'blocked_required_tasks',
        pendingOrRunningTaskIds,
        failedOrKilledTaskIds,
      }
    }

    const mainVerification = verification ?? await this.mainVerificationProvider?.(clone(graph))
    if (!mainVerification || mainVerification.mainWorkflowEvidenceRefs.length === 0) {
      throw runtimeError(
        'POLICY_VIOLATION',
        'Eligible completion readiness requires injected Main workflow evidence; task outputs are never substituted.',
      )
    }
    if (mainVerification.verifiedAgainstActionSeq !== graph.actionClock.currentActionSeq) {
      throw runtimeError(
        'POLICY_VIOLATION',
        `Main workflow evidence was verified at action ${mainVerification.verifiedAgainstActionSeq}, expected ${graph.actionClock.currentActionSeq}.`,
      )
    }
    for (const ref of mainVerification.mainWorkflowEvidenceRefs) this.assertOwnedArtifactRef(ref)
    return {
      schemaVersion: 'main-completion-readiness/v1',
      state: 'eligible_for_main_verification',
      mainWorkflowEvidenceRefs: clone(mainVerification.mainWorkflowEvidenceRefs),
      verifiedAgainstActionSeq: mainVerification.verifiedAgainstActionSeq,
    }
  }

  async compactFacts(): Promise<AgentTaskCompactFactV1[]> {
    await this.ensureInitialized()
    const graph = await this.requireGraph()
    return buildAgentTaskCompactFacts(graph)
  }

  async resumeAttachment(input: AsyncTaskResumeAttachmentInput = {}): Promise<AgentTaskResumeAttachmentV1> {
    await this.ensureInitialized()
    const graph = await this.requireGraph()
    const events = await this.store.readEvents(this.sessionId)
    const lastEventSeq = graph.nextEventSeq - 1
    const unacknowledgedNotificationIds = graph.notificationOutbox
      .filter((entry) => entry.state === 'pending_delivery')
      .map((entry) => entry.notification.notificationId)
    const checkpoint = input.checkpoint ?? await this.checkpointProvider?.({
      graph: clone(graph),
      lastEventSeq,
      unacknowledgedNotificationIds: [...unacknowledgedNotificationIds],
    })
    if (!checkpoint) {
      throw runtimeError('ARTIFACT_NOT_READY', 'resumeAttachment requires an injected or caller-supplied graph checkpoint ref.')
    }
    validateCheckpoint(checkpoint, graph, lastEventSeq, unacknowledgedNotificationIds)
    const attachments = [...(input.persistedPromptAttachments ?? [])].map((attachment) => {
      this.assertOptionalSessionId(attachment.sessionId)
      return clone(attachment)
    })
    const leaseRecoveryDecisions = events.flatMap((event) => (
      event.eventType === 'task_lease_expired' ? [clone(event.payload.recovery)] : []
    ))
    return {
      schemaVersion: 'agent-task-resume-attachment/v1',
      sessionId: this.sessionId,
      runId: this.runId,
      resumedAt: input.resumedAt ?? this.iso(),
      checkpoint: clone(checkpoint),
      actionClock: clone(graph.actionClock),
      taskFacts: await this.compactFacts(),
      leaseRecoveryDecisions,
      notificationReplayIds: [...unacknowledgedNotificationIds],
      persistedPromptAttachments: attachments,
      sidechainHistoryMergedIntoParent: false,
    }
  }

  async abortSession(): Promise<number> {
    await this.ensureInitialized()
    return this.serializedLifecycle(async () => {
      if (this.aborted) return 0
      this.aborted = true
      return this.scheduler.abortSession(this.sessionId)
    })
  }

  getContextEnvelopeBinding(taskId: string): AsyncTaskContextEnvelopeBinding | undefined {
    const binding = this.envelopeBindings.get(taskId)
    return binding ? clone(binding) : undefined
  }

  private async hydrate(
    graph: AgentTaskGraphV2,
    attachments: readonly TaskNotificationPromptAttachmentV1[],
  ): Promise<HydrationResult> {
    this.assertGraphIdentity(graph)
    const priorEvents = await this.store.readEvents(this.sessionId)
    await this.reconcileOutbox(graph)
    const reconciledPromptAttachments = await this.reconcilePromptAttachments(attachments)
    const current = await this.requireGraph()
    for (const task of current.tasks) {
      if (!isReadOnlyLlmTask(task) || isTerminal(task)) continue
      const binding = await this.provideContextEnvelope('restore', current, task)
      this.envelopeBindings.set(task.id, clone(binding))
    }
    await this.scheduler.tick(this.sessionId)
    const restored = await this.requireGraph()
    const events = await this.store.readEvents(this.sessionId)
    return {
      graph: restored,
      reconciledPromptAttachments,
      leaseRecoveryDecisions: events.slice(priorEvents.length).flatMap((event) => (
        event.eventType === 'task_lease_expired' ? [clone(event.payload.recovery)] : []
      )),
    }
  }

  private async reconcilePromptAttachments(
    attachments: readonly TaskNotificationPromptAttachmentV1[],
  ): Promise<number> {
    if (attachments.length === 0) return 0
    for (const attachment of attachments) this.assertOptionalSessionId(attachment.sessionId)
    const notificationIds = new Set(attachments.flatMap((attachment) => attachment.notificationIds))
    const reconciled = await this.notifications.reconcilePersistedPromptAttachments(attachments)
    for (const record of this.notifications.snapshot(this.sessionId)) {
      if (!notificationIds.has(record.notification.notificationId) || record.delivery.state !== 'acknowledged') continue
      await this.scheduler.acknowledgeNotification(this.sessionId, record.delivery.acknowledgement)
    }
    return reconciled
  }

  private async reconcileOutbox(graph: AgentTaskGraphV2): Promise<void> {
    this.assertGraphIdentity(graph)
    for (const entry of graph.notificationOutbox) {
      if (entry.state === 'pending_delivery') this.notifications.enqueue(entry.notification)
    }
  }

  private async provideContextEnvelope(
    mode: AsyncTaskContextEnvelopeRequest['mode'],
    graph: AgentTaskGraphV2,
    task: Extract<AgentTask, { kind: ReadOnlyLlmTaskKind }>,
  ): Promise<AsyncTaskContextEnvelopeBinding> {
    if (!this.contextEnvelopeProvider) {
      throw runtimeError('CONTEXT_POLICY_VIOLATION', `Task ${task.id} requires an injected S004 Context Envelope provider.`)
    }
    const builtInRole = builtInRoleBindingForTask(task)
    const latestAttempt = [...task.attempts].reverse().find((attempt) => attempt.runnerKind === 'read_only_llm')
    const binding = await this.contextEnvelopeProvider({
      mode,
      sessionId: this.sessionId,
      runId: this.runId,
      graph: clone(graph),
      task: clone(task),
      ...(builtInRole ? { builtInRole: clone(builtInRole) } : {}),
      ...(latestAttempt?.runnerKind === 'read_only_llm' ? { existingEnvelopeRef: clone(latestAttempt.envelopeRef) } : {}),
    })
    validateEnvelopeBinding(binding, task, graph, builtInRole)
    return clone(binding)
  }

  private createRunRequest(
    task: RunningBackgroundAgentTask,
    graph: AgentTaskGraphV2,
    runner: AgentTaskRunnerV1,
    runIdentity: TaskRunIdentity,
  ): AgentTaskRunRequestV1 {
    const limits = {
      ...this.runnerLimits,
      perRequestTimeoutMs: Math.min(this.runnerLimits.perRequestTimeoutMs, task.timeoutMs),
      overallTimeoutMs: Math.min(this.runnerLimits.overallTimeoutMs, task.timeoutMs),
    }
    if (runner.runnerKind === 'read_only_llm') {
      if (!isReadOnlyLlmTask(task)) {
        throw runtimeError('RUNNER_KIND_CONFLICT', `Runner ${runner.runnerId} cannot execute ${task.kind}.`)
      }
      const binding = this.requireContextEnvelopeBinding(task.id)
      return {
        schemaVersion: 'agent-task-run-input/v1',
        runnerKind: 'read_only_llm',
        runIdentity,
        runnerId: runner.runnerId,
        runnerVersion: runner.runnerVersion,
        graphRevision: graph.revision,
        task,
        limits,
        contextEnvelope: clone(binding.envelope),
      }
    }
    if (isReadOnlyLlmTask(task)) {
      throw runtimeError('RUNNER_KIND_CONFLICT', `Deterministic runner ${runner.runnerId} cannot execute ${task.kind}.`)
    }
    return {
      schemaVersion: 'agent-task-run-input/v1',
      runnerKind: 'deterministic',
      runIdentity,
      runnerId: runner.runnerId,
      runnerVersion: runner.runnerVersion,
      graphRevision: graph.revision,
      task,
      limits,
      inputArtifactRefs: task.inputs.flatMap((taskInput) => taskInput.artifactRef ? [clone(taskInput.artifactRef)] : []),
    }
  }

  private requireContextEnvelopeBinding(taskId: string): AsyncTaskContextEnvelopeBinding {
    const binding = this.envelopeBindings.get(taskId)
    if (!binding) throw runtimeError('CONTEXT_POLICY_VIOLATION', `No Context Envelope binding is available for task ${taskId}.`)
    return binding
  }

  private requireBackgroundKind(kind: AsyncTaskSpawnInput['kind']): BackgroundAgentTaskKind {
    if (kind === 'main_browser_step') {
      throw runtimeError('POLICY_VIOLATION', 'main_browser_step is owned by the Main Agent and cannot be spawned in the background.')
    }
    if (!ASYNC_TASK_BACKGROUND_KINDS.includes(kind as BackgroundAgentTaskKind) || !this.allowedTaskKinds.has(kind)) {
      throw runtimeError('POLICY_VIOLATION', `Background task kind ${String(kind)} is not enabled for this runtime.`)
    }
    return kind
  }

  private assertOwnedArtifactRef(ref: ImmutableArtifactRef): void {
    if (ref.schemaVersion !== 'immutable-artifact-ref/v1' || ref.immutable !== true
      || ref.sessionId !== this.sessionId || ref.runId !== this.runId
      || ref.storage.store !== 'session_artifacts') {
      throw runtimeError('CONTEXT_POLICY_VIOLATION', `Artifact ${ref.artifactId} is not an immutable ref owned by this session/run.`)
    }
  }

  private assertGraphIdentity(graph: AgentTaskGraphV2): void {
    if (graph.schemaVersion !== 'agent-task-graph/v2') {
      throw runtimeError('UNSUPPORTED_SCHEMA_VERSION', `Expected agent-task-graph/v2 for session ${this.sessionId}.`)
    }
    if (graph.sessionId !== this.sessionId || graph.runId !== this.runId) {
      throw runtimeError('REVISION_CONFLICT', 'Task graph session/run identity does not match this runtime.')
    }
  }

  private assertOptionalSessionId(sessionId: string | undefined): void {
    if (sessionId !== undefined && sessionId !== this.sessionId) {
      throw runtimeError('POLICY_VIOLATION', `Cross-session async task access was denied for ${sessionId}.`)
    }
  }

  private async requireGraph(): Promise<AgentTaskGraphV2> {
    const graph = await this.store.load(this.sessionId)
    if (!graph) throw runtimeError('GRAPH_NOT_FOUND', `Task graph not found for session ${this.sessionId}.`)
    this.assertGraphIdentity(graph)
    return graph
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) await this.initialize()
  }

  private serializedLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.lifecycleChain.catch(() => undefined).then(operation)
    this.lifecycleChain = result.then(() => undefined, () => undefined)
    return result
  }

  private iso(): string { return this.now().toISOString() }

  /** @internal Used by spawn normalization without exporting mutable runtime state. */
  _assertOwnedArtifactRef(ref: ImmutableArtifactRef): void { this.assertOwnedArtifactRef(ref) }
}

function normalizeSpawnInput(
  input: AsyncTaskSpawnInput,
  kind: BackgroundAgentTaskKind,
  graph: AgentTaskGraphV2,
  runtime: AsyncTaskRuntime,
) {
  const now = new Date().toISOString()
  const title = requireNonEmpty(input.title, 'title')
  const key = requireNonEmpty(input.idempotencyKey, 'idempotencyKey')
  const inputs = clone([...(input.inputs ?? [])])
  const blockedBy = uniqueIds(input.blockedBy ?? [], input.taskId)
  const blocks = uniqueIds(input.blocks ?? [], input.taskId)
  const priority = Number.isInteger(input.priority ?? 0) ? input.priority ?? 0 : NaN
  if (!Number.isInteger(priority)) throw runtimeError('POLICY_VIOLATION', 'Task priority must be an integer.')
  const completionRequirement = normalizeCompletionRequirement(input.completionRequirement)
  const actionBinding = resolveActionBinding(input.actionBinding, inputs, graph, runtime)
  const digestInput = {
    schemaVersion: 'async-task-spawn-digest-input/v1',
    kind,
    title,
    priority,
    blockedBy,
    blocks,
    inputs,
    actionBinding,
    completionRequirement,
  }
  return {
    now,
    title,
    priority,
    blockedBy,
    blocks,
    inputs,
    actionBinding,
    completionRequirement,
    idempotency: {
      schemaVersion: 'agent-task-idempotency/v1' as const,
      scope: 'session' as const,
      key,
      canonicalization: 'web-buddy-task-input-jcs/v1' as const,
      digestAlgorithm: 'sha256' as const,
      inputDigest: createHash('sha256').update(canonicalJson(digestInput)).digest('hex'),
    },
  }
}

function resolveActionBinding(
  supplied: ActionBinding | undefined,
  inputs: readonly AgentTaskInput[],
  graph: AgentTaskGraphV2,
  runtime: AsyncTaskRuntime,
): ActionBinding {
  const actionSeqs = new Set<number>()
  for (const input of inputs) {
    if (!input.artifactRef) continue
    runtime._assertOwnedArtifactRef(input.artifactRef)
    if (input.artifactRef.actionBinding.kind === 'browser_action') {
      actionSeqs.add(input.artifactRef.actionBinding.sourceActionSeq)
    }
  }
  if (actionSeqs.size > 1) {
    throw runtimeError('CONTEXT_POLICY_VIOLATION', 'A task cannot combine artifacts from different browser action bindings.')
  }
  const derivedSeq = [...actionSeqs][0]
  const binding = supplied ?? (derivedSeq === undefined
    ? { kind: 'not_action_bound' as const }
    : { kind: 'browser_action' as const, sourceActionSeq: derivedSeq })
  if (binding.kind === 'browser_action') {
    if (!Number.isSafeInteger(binding.sourceActionSeq) || binding.sourceActionSeq < 0
      || binding.sourceActionSeq > graph.actionClock.currentActionSeq) {
      throw runtimeError('CONTEXT_POLICY_VIOLATION', 'Task sourceActionSeq is outside the current Main Agent action clock.')
    }
    if (derivedSeq !== undefined && derivedSeq !== binding.sourceActionSeq) {
      throw runtimeError('CONTEXT_POLICY_VIOLATION', 'Explicit action binding does not match the immutable input artifacts.')
    }
  } else if (derivedSeq !== undefined) {
    throw runtimeError('CONTEXT_POLICY_VIOLATION', 'Browser-derived artifacts require an explicit browser action binding.')
  }
  return clone(binding)
}

function normalizeCompletionRequirement(
  value: TaskCompletionRequirement | AsyncTaskCompletionRequirementInput | undefined,
): TaskCompletionRequirement {
  if (!value) return { requiredForCompletion: false, terminalPolicy: 'does_not_block' }
  if (value.requiredForCompletion) {
    if (value.terminalPolicy !== 'must_complete_successfully' && value.terminalPolicy !== 'terminal_is_sufficient') {
      throw runtimeError('POLICY_VIOLATION', 'A required task needs a required-task terminal policy.')
    }
    return { requiredForCompletion: true, terminalPolicy: value.terminalPolicy }
  }
  if (value.terminalPolicy !== 'does_not_block') {
    throw runtimeError('POLICY_VIOLATION', 'An optional task must use terminalPolicy=does_not_block.')
  }
  return { requiredForCompletion: false, terminalPolicy: 'does_not_block' }
}

function createdEvent(graph: AgentTaskGraphV2, task: AgentTask, now: string): Extract<AgentTaskEvent, { eventType: 'task_created' }> {
  return {
    schemaVersion: 'agent-task-event/v1',
    eventId: `event_${randomUUID()}`,
    eventSeq: graph.nextEventSeq,
    eventType: 'task_created',
    sessionId: graph.sessionId,
    graphId: graph.graphId,
    taskId: task.id,
    occurredAt: now,
    revisionBefore: graph.revision,
    revisionAfter: graph.revision + 1,
    actionBinding: clone(task.actionBinding),
    correlationId: `task_${task.id}`,
    payload: { idempotency: clone(task.idempotency) },
    authoritativeTaskState: true,
    authoritativeCompletionEvidence: false,
  }
}

function projectTask(task: AgentTask, graphRevision: number): AsyncTaskProjection {
  const latest = task.outputs.at(-1)
  const builtInRole = builtInRoleBindingForTask(task)
  return {
    taskId: task.id,
    kind: task.kind,
    ...(builtInRole ? { roleId: builtInRole.role.id as BuiltInAgentRoleId } : {}),
    title: task.title,
    status: task.status,
    graphRevision,
    attempt: task.attempt,
    completionRequirement: completionRequirementOf(task),
    outputRefs: task.outputs.map((output) => clone(output.artifactRef)),
    ...(latest ? { freshness: clone(latest.freshness) } : {}),
    ...(task.lastError ? { lastError: clone(task.lastError) } : {}),
    requiresMainWorkflowVerification: true,
    authoritativeCompletionEvidence: false,
  }
}

function completionRequirementOf(task: AgentTask): TaskCompletionRequirement {
  return task.requiredForCompletion
    ? { requiredForCompletion: true, terminalPolicy: task.terminalPolicy }
    : { requiredForCompletion: false, terminalPolicy: 'does_not_block' }
}

function requireTask(graph: AgentTaskGraphV2, taskId: string): AgentTask {
  const task = graph.tasks.find((candidate) => candidate.id === taskId)
  if (!task) throw runtimeError('TASK_NOT_FOUND', `Task not found: ${taskId}`)
  return task
}

function builtInRoleBindingForTask(task: AgentTask): BuiltInRoleRuntimeBinding | undefined {
  let metadata: ReturnType<typeof parseBuiltInRoleTaskMetadata>
  try {
    for (const input of task.inputs) {
      if (input.kind !== 'goal') continue
      const candidate = parseBuiltInRoleTaskMetadata(input.structuredValue)
      if (!candidate) continue
      if (metadata) {
        throw new Error(`Task ${task.id} contains multiple built-in role bindings.`)
      }
      metadata = candidate
    }
  } catch (error) {
    throw runtimeError(
      'CONTEXT_POLICY_VIOLATION',
      `Task ${task.id} has an invalid built-in role binding: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (!metadata) return undefined
  const binding = getBuiltInRoleRuntimeBinding(metadata.roleId)
  if (binding.runtimeTaskKind !== task.kind || binding.roleDigest !== metadata.roleDigest) {
    throw runtimeError('CONTEXT_POLICY_VIOLATION', `Task ${task.id} role binding does not match its runtime task kind.`)
  }
  return binding
}

function validateEnvelopeBinding(
  binding: AsyncTaskContextEnvelopeBinding,
  task: Extract<AgentTask, { kind: ReadOnlyLlmTaskKind }>,
  graph: AgentTaskGraphV2,
  builtInRole?: BuiltInRoleRuntimeBinding,
): void {
  const { envelope, artifactRef } = binding
  if (envelope.schemaVersion !== 'subagent-context-envelope/v1'
    || envelope.taskId !== task.id || envelope.taskKind !== task.kind
    || envelope.parentSessionId !== graph.sessionId || envelope.parentRunId !== graph.runId
    || canonicalJson(envelope.currentActionBinding) !== canonicalJson(task.actionBinding)
    || envelope.parentHistoryIncluded !== false) {
    throw runtimeError('CONTEXT_POLICY_VIOLATION', `Context Envelope for ${task.id} violates its session/task authority boundary.`)
  }
  if (envelope.authorityBoundary.browserWrite !== false
    || envelope.authorityBoundary.livePageAccess !== false
    || envelope.authorityBoundary.authoritativeCompletionEvidence !== false
    || envelope.authorityBoundary.requiresMainWorkflowVerification !== true
    || Object.values(envelope.authorityBoundary.gates).some((value) => value !== false)) {
    throw runtimeError('CONTEXT_POLICY_VIOLATION', `Context Envelope for ${task.id} expands Main Agent authority.`)
  }
  if (builtInRole) {
    const expectedEnvelopeRole = toBuiltInRoleEnvelopeBinding(builtInRole)
    if (!envelope.builtInRole
      || canonicalJson(envelope.builtInRole) !== canonicalJson(expectedEnvelopeRole)
      || builtInRole.runtimeTaskKind !== task.kind
      || builtInRole.role.browserWrite !== false
      || builtInRole.role.livePageAccess !== false
      || builtInRole.role.canResolveApproval !== false
      || builtInRole.role.canWriteMemory !== false
      || builtInRole.role.authoritativeCompletionEvidence !== false
      || builtInRole.role.requiresMainWorkflowVerification !== true
      || envelope.allowedTools.some((tool) => !builtInRole.role.allowedTools.includes(tool))) {
      throw runtimeError('CONTEXT_POLICY_VIOLATION', `Built-in role binding for ${task.id} exceeds its registered read-only envelope.`)
    }
  } else if (envelope.builtInRole !== undefined) {
    throw runtimeError('CONTEXT_POLICY_VIOLATION', `Legacy task ${task.id} cannot inject an unbound built-in role.`)
  }
  if (artifactRef.schemaVersion !== 'immutable-artifact-ref/v1'
    || artifactRef.artifactKind !== 'context_envelope' || artifactRef.immutable !== true
    || artifactRef.sessionId !== graph.sessionId || artifactRef.runId !== graph.runId
    || artifactRef.storage.store !== 'session_artifacts') {
    throw runtimeError('CONTEXT_POLICY_VIOLATION', `Context Envelope ref for ${task.id} is not immutable and session-owned.`)
  }
}

function validateCheckpoint(
  checkpoint: TaskGraphCheckpointRefV1,
  graph: AgentTaskGraphV2,
  lastEventSeq: number,
  notificationIds: string[],
): void {
  const ref = checkpoint.graphSnapshotRef
  if (checkpoint.schemaVersion !== 'task-graph-checkpoint-ref/v1'
    || checkpoint.graphRevision !== graph.revision
    || checkpoint.lastEventSeq !== lastEventSeq
    || canonicalJson([...checkpoint.unacknowledgedNotificationIds].sort()) !== canonicalJson([...notificationIds].sort())
    || ref.artifactKind !== 'task_graph_checkpoint' || ref.immutable !== true
    || ref.sessionId !== graph.sessionId || ref.runId !== graph.runId) {
    throw runtimeError('ARTIFACT_INTEGRITY_FAILED', 'Task graph checkpoint does not match the current durable graph cursor.')
  }
}

function validateAllowedKinds(kinds: readonly BackgroundAgentTaskKind[]): ReadonlySet<BackgroundAgentTaskKind> {
  const result = new Set<BackgroundAgentTaskKind>()
  for (const kind of kinds) {
    if (!ASYNC_TASK_BACKGROUND_KINDS.includes(kind)) {
      throw runtimeError('POLICY_VIOLATION', `Unsupported background task kind: ${String(kind)}`)
    }
    result.add(kind)
  }
  return result
}

function normalizeRunnerLimits(value: Partial<RunnerLimits> | undefined, defaultTimeoutMs: number): RunnerLimits {
  return {
    maxTurns: positiveInteger(value?.maxTurns ?? 6, 'runnerLimits.maxTurns'),
    maxToolCalls: positiveInteger(value?.maxToolCalls ?? 16, 'runnerLimits.maxToolCalls'),
    maxInputTokens: positiveInteger(value?.maxInputTokens ?? 8_000, 'runnerLimits.maxInputTokens'),
    maxOutputTokens: positiveInteger(value?.maxOutputTokens ?? 2_000, 'runnerLimits.maxOutputTokens'),
    perRequestTimeoutMs: positiveInteger(value?.perRequestTimeoutMs ?? Math.min(30_000, defaultTimeoutMs), 'runnerLimits.perRequestTimeoutMs'),
    overallTimeoutMs: positiveInteger(value?.overallTimeoutMs ?? defaultTimeoutMs, 'runnerLimits.overallTimeoutMs'),
  }
}

function isReadOnlyLlmKind(kind: BackgroundAgentTaskKind): kind is ReadOnlyLlmTaskKind {
  return READ_ONLY_LLM_KINDS.includes(kind as ReadOnlyLlmTaskKind)
}

function isReadOnlyLlmTask(task: AgentTask): task is Extract<AgentTask, { kind: ReadOnlyLlmTaskKind }> {
  return isReadOnlyLlmKind(task.kind as BackgroundAgentTaskKind)
}

function isTerminal(task: AgentTask): boolean { return isTerminalStatus(task.status) }
function isTerminalStatus(status: AgentTaskStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'killed'
}

function uniqueIds(values: readonly string[], selfId?: string): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value && value !== selfId))]
}

function requireNonEmpty(value: string, name: string): string {
  const trimmed = value.trim()
  if (!trimmed) throw runtimeError('POLICY_VIOLATION', `${name} must be non-empty.`)
  return trimmed
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer.`)
  return value
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer.`)
  return value
}

function runtimeError(code: TaskContractError['code'], message: string): Error & { code: TaskContractError['code']; contractError: TaskContractError } {
  const category: TaskContractError['category'] = code === 'SESSION_ABORTED' || code === 'CANCELLED'
    ? 'cancelled'
    : code === 'POLICY_VIOLATION' || code === 'CONTEXT_POLICY_VIOLATION'
      ? 'policy'
      : code === 'QUEUE_CAPACITY_EXCEEDED' || code === 'ARTIFACT_NOT_READY'
        ? 'transient'
        : 'conflict'
  const retryDisposition: TaskContractError['retryDisposition'] = code === 'QUEUE_CAPACITY_EXCEEDED' || code === 'ARTIFACT_NOT_READY'
    ? 'retry_same_task'
    : code === 'IDEMPOTENCY_CONFLICT'
      ? 'new_task_required'
      : 'never_retry'
  const contractError: TaskContractError = {
    schemaVersion: 'async-task-contract-error/v1',
    code,
    category,
    retryDisposition,
    message,
    occurredAt: new Date().toISOString(),
  }
  return Object.assign(new Error(message), { code, contractError })
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : undefined
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, nested]) => nested !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`)
    .join(',')}}`
}

function clone<T>(value: T): T { return structuredClone(value) }

export { AsyncTaskRuntime as AgentTaskOrchestrator }
