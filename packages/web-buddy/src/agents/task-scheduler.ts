import { randomUUID } from 'node:crypto'
import type {
  AgentTask,
  AgentTaskEvent,
  AgentTaskGraphV2,
  AgentTaskOutput,
  AgentTaskRunOutcome,
  AgentTaskRunRequestV1,
  AgentTaskRunnerV1,
  BackgroundAgentTaskKind,
  BrowserActionClockV1,
  ImmutableArtifactRef,
  ResultFreshnessVerdict,
  RunnerError,
  RunningBackgroundAgentTask,
  TaskContractError,
  TaskNotificationOutboxEntryV1,
  TaskNotificationAcknowledgementV1,
  TaskNotificationV1,
  TaskRunIdentity,
} from './async-task-contracts.js'
import { finalizeAgentTaskGraphMutationV2, getRunnableAgentTasksV2 } from './task-graph.js'
import type { TaskGraphMutation, TaskGraphStore } from './task-graph-store.js'
import { TaskNotificationQueue } from './task-notification-queue.js'
import { RunnerRegistry } from './runner-registry.js'
import { assessAsyncTaskResultFreshness } from './async-task-safety.js'
import {
  parseBuiltInRoleTaskMetadata,
  validateBuiltInRoleOutputPayload,
} from './built-in-roles.js'

export interface AgentTaskSchedulerOptions {
  store: TaskGraphStore
  registry: RunnerRegistry
  notifications: TaskNotificationQueue
  schedulerId?: string
  maxConcurrentReadOnlyLlmTasks?: number
  maxConcurrentDeterministicTasks?: number
  retryDelayMs?: number
  now?: () => Date
  requestFactory?: TaskRunRequestFactory
  resolveContextEnvelopeRef?: (task: AgentTask, graph: AgentTaskGraphV2) => ImmutableArtifactRef<'context_envelope'>
  materializeLlmResult?: (
    outcome: Extract<AgentTaskRunOutcome, { outcome: 'succeeded' }>,
    task: RunningBackgroundAgentTask,
  ) => { outputRefs: [ImmutableArtifactRef, ...ImmutableArtifactRef[]]; freshness: ResultFreshnessVerdict }
}

export type TaskRunRequestFactory = (
  task: RunningBackgroundAgentTask,
  graph: AgentTaskGraphV2,
  runner: AgentTaskRunnerV1,
  runIdentity: TaskRunIdentity,
) => AgentTaskRunRequestV1

interface RunningExecution {
  controller: AbortController
  runIdentity: TaskRunIdentity
  promise: Promise<void>
}

export class AgentTaskScheduler {
  readonly schedulerId: string
  private readonly store: TaskGraphStore
  private readonly registry: RunnerRegistry
  private readonly notifications: TaskNotificationQueue
  private readonly maxReadOnly: number
  private readonly maxDeterministic: number
  private readonly retryDelayMs: number
  private readonly now: () => Date
  private readonly requestFactory: TaskRunRequestFactory
  private readonly resolveContextEnvelopeRef?: AgentTaskSchedulerOptions['resolveContextEnvelopeRef']
  private readonly materializeLlmResult?: AgentTaskSchedulerOptions['materializeLlmResult']
  private readonly running = new Map<string, RunningExecution>()
  private readonly abortedSessions = new Set<string>()

  constructor(options: AgentTaskSchedulerOptions) {
    this.store = options.store
    this.registry = options.registry
    this.notifications = options.notifications
    this.schedulerId = options.schedulerId ?? `scheduler_${randomUUID()}`
    this.maxReadOnly = positiveInteger(options.maxConcurrentReadOnlyLlmTasks ?? 2, 'maxConcurrentReadOnlyLlmTasks')
    this.maxDeterministic = positiveInteger(options.maxConcurrentDeterministicTasks ?? 4, 'maxConcurrentDeterministicTasks')
    this.retryDelayMs = Math.max(0, options.retryDelayMs ?? 250)
    this.now = options.now ?? (() => new Date())
    this.requestFactory = options.requestFactory ?? defaultRequestFactory
    this.resolveContextEnvelopeRef = options.resolveContextEnvelopeRef
    this.materializeLlmResult = options.materializeLlmResult
  }

  async tick(sessionId: string): Promise<void> {
    if (this.abortedSessions.has(sessionId)) return
    await this.notifications.releaseExpiredClaims(this.iso())
    await this.recoverExpiredLeases(sessionId)
    let graph = await this.store.load(sessionId)
    if (!graph) return
    this.reconcileOutbox(graph)

    for (const candidate of getRunnableAgentTasksV2(graph, this.iso())) {
      if (candidate.kind === 'main_browser_step') continue
      if (!this.hasCapacity(graph, candidate.capacityClass)) continue
      const claimed = await this.claim(sessionId, candidate.id)
      if (!claimed) continue
      graph = claimed.graph
      const task = claimed.graph.tasks.find((item) => item.id === candidate.id)
      if (!task || task.status !== 'running' || task.kind === 'main_browser_step') continue
      const execution = this.execute(sessionId, claimed.graph, task)
      this.running.set(runKey(sessionId, task.id), execution)
    }
  }

  async cancelTask(
    sessionId: string,
    taskId: string,
    reason: 'user' | 'session_abort' | 'superseded' = 'user',
  ): Promise<boolean> {
    const graph = await this.store.load(sessionId)
    const task = graph?.tasks.find((candidate) => candidate.id === taskId)
    if (!task || isTerminal(task)) return false
    const requestId = `cancel_${randomUUID()}`
    const now = this.iso()
    if (task.status === 'pending' || task.status === 'blocked') {
      const committed = await this.store.transact(sessionId, (current) => {
        const currentTask = requireTask(current, taskId)
        if (isTerminal(currentTask) || currentTask.status === 'running') {
          throw schedulerError('INVALID_TRANSITION', `Task ${taskId} changed while cancellation was requested.`)
        }
        const error = contractError(
          reason === 'session_abort' ? 'SESSION_ABORTED' : 'CANCELLED',
          `Task ${taskId} was cancelled before it started.`,
          taskId,
          now,
        )
        const terminal = {
          ...currentTask,
          status: 'killed' as const,
          cancellation: { requestId, requestedAt: now, reason },
          terminalAt: now,
          updatedAt: now,
          lastError: error,
        } as AgentTask
        const event = controlEvent(current, terminal, 'task_cancelled_before_run', {
          requestId,
          reason,
        }, now)
        const notification = failedNotification(current, terminal, event, error, {
          kind: 'before_run', cancellationRequestId: requestId,
        }, now)
        const draft = replaceTask(current, terminal)
        const outbox = outboxEntry(notification, event)
        draft.notificationOutbox.push(outbox)
        return finalizeAgentTaskGraphMutationV2(current, draft, event, now)
      })
      this.reconcileOutbox(committed.graph)
      return true
    }

    await this.store.transact(sessionId, (current) => {
      const running = requireRunningTask(current, taskId)
      const event = runEvent(current, running, 'task_cancel_requested', {
        requestId,
        requestedAt: now,
        reason,
      }, now)
      const updated = { ...running, cancellation: { requestId, requestedAt: now, reason }, updatedAt: now } as AgentTask
      return finalizeAgentTaskGraphMutationV2(current, replaceTask(current, updated), event, now)
    })
    this.running.get(runKey(sessionId, taskId))?.controller.abort(reason)
    return true
  }

  async abortSession(sessionId: string): Promise<number> {
    this.abortedSessions.add(sessionId)
    const graph = await this.store.load(sessionId)
    if (!graph) return 0
    let cancelled = 0
    for (const task of graph.tasks) {
      if (isTerminal(task)) continue
      if (await this.cancelTask(sessionId, task.id, 'session_abort')) cancelled += 1
    }
    await this.waitForIdle(sessionId)
    return cancelled
  }

  async acknowledgeNotification(
    sessionId: string,
    acknowledgement: TaskNotificationAcknowledgementV1,
  ): Promise<void> {
    const graph = await this.store.load(sessionId)
    if (!graph) throw schedulerError('GRAPH_NOT_FOUND', `Task graph not found for session ${sessionId}.`)
    const existing = graph.notificationOutbox.find((entry) => entry.notification.notificationId === acknowledgement.notificationId)
    if (!existing) throw schedulerError('NOTIFICATION_ACK_CONFLICT', `Notification ${acknowledgement.notificationId} is not in the graph outbox.`)
    if (existing.state === 'acknowledged') {
      if (JSON.stringify(existing.acknowledgedReceipt) !== JSON.stringify(acknowledgement)) {
        throw schedulerError('NOTIFICATION_ACK_CONFLICT', `Notification ${acknowledgement.notificationId} has a conflicting graph acknowledgement.`)
      }
      return
    }
    // Queue acknowledgement is process-local. If the following durable commit fails,
    // restart reconstructs the pending outbox and prompt-message dedupe prevents a
    // duplicate effect. The inverse ordering could durably suppress an invalid claim.
    await this.notifications.acknowledge(acknowledgement)
    await this.store.transact(sessionId, (current) => {
      const entry = current.notificationOutbox.find((candidate) => candidate.notification.notificationId === acknowledgement.notificationId)
      if (!entry || entry.state !== 'pending_delivery') {
        throw schedulerError('NOTIFICATION_ACK_CONFLICT', `Notification ${acknowledgement.notificationId} is not pending acknowledgement.`)
      }
      const task = requireTask(current, entry.notification.taskId)
      const now = acknowledgement.acknowledgedAt
      const event = controlEvent(current, task, 'task_notification_acknowledged', {
        notificationId: acknowledgement.notificationId,
        acknowledgement,
      }, now)
      const draft = structuredClone(current)
      draft.notificationOutbox = draft.notificationOutbox.map((candidate): TaskNotificationOutboxEntryV1 => (
        candidate.notification.notificationId === acknowledgement.notificationId
          ? {
              schemaVersion: 'agent-task-notification-outbox-entry/v1',
              sourceEventId: candidate.sourceEventId,
              sourceEventSeq: candidate.sourceEventSeq,
              notification: candidate.notification,
              state: 'acknowledged',
              acknowledgedReceipt: acknowledgement,
            }
          : candidate
      ))
      return finalizeAgentTaskGraphMutationV2(current, draft, event, now)
    })
  }

  async waitForIdle(sessionId?: string): Promise<void> {
    const promises = [...this.running.entries()]
      .filter(([key]) => !sessionId || key.startsWith(`${sessionId}\u0000`))
      .map(([, execution]) => execution.promise)
    await Promise.allSettled(promises)
  }

  activeCount(sessionId?: string): number {
    return [...this.running.keys()].filter((key) => !sessionId || key.startsWith(`${sessionId}\u0000`)).length
  }

  private async claim(sessionId: string, taskId: string): Promise<TaskGraphMutation | undefined> {
    if (this.abortedSessions.has(sessionId)) return undefined
    try {
      return await this.store.transact(sessionId, (current) => {
        if (this.abortedSessions.has(sessionId)) {
          throw schedulerError('SESSION_ABORTED', `Session ${sessionId} cannot claim task ${taskId} after abort.`)
        }
        const task = requireTask(current, taskId)
        if (task.status !== 'pending') throw schedulerError('INVALID_TRANSITION', `Task ${taskId} is not pending.`)
        if (task.kind === 'main_browser_step') {
          throw schedulerError('POLICY_VIOLATION', `Background scheduler cannot claim browser-write task ${taskId}.`)
        }
        const unresolved = task.blockedBy.filter((id) => current.tasks.find((candidate) => candidate.id === id)?.status !== 'completed')
        if (unresolved.length) throw schedulerError('DEPENDENCY_UNRESOLVED', `Task ${taskId} has unresolved dependencies.`)
        if (task.nextAttemptAt && task.nextAttemptAt > this.iso()) throw schedulerError('INVALID_TRANSITION', `Task ${taskId} retry is not due.`)
        if (task.attempt >= task.maxAttempts) throw schedulerError('MAX_ATTEMPTS_EXCEEDED', `Task ${taskId} exhausted attempts.`)
        if (!this.hasCapacity(current, task.capacityClass)) throw schedulerError('QUEUE_CAPACITY_EXCEEDED', `No ${task.capacityClass} capacity.`)

        const now = this.iso()
        const attempt = task.attempt + 1
        const leaseId = `lease_${randomUUID()}`
        const runIdentity: TaskRunIdentity = { taskId, attempt, leaseId, leaseOwnerId: this.schedulerId }
        const lease = {
          schemaVersion: 'agent-task-lease/v1' as const,
          leaseId,
          ownerId: this.schedulerId,
          acquiredAt: now,
          expiresAt: new Date(Date.parse(now) + task.leaseDurationMs).toISOString(),
          attempt,
          claimedAtGraphRevision: current.revision + 1,
        }
        const runner = this.registry.require(task.kind as BackgroundAgentTaskKind)
        const execution = runner.runnerKind === 'read_only_llm'
          ? {
              runnerKind: 'read_only_llm' as const,
              envelopeRef: this.resolveContextEnvelopeRef?.(task, current)
                ?? (() => { throw schedulerError('CONTEXT_POLICY_VIOLATION', `Read-only LLM task ${task.id} has no S004 envelope resolver.`) })(),
            }
          : { runnerKind: 'deterministic' as const }
        const running = {
          ...task,
          status: 'running' as const,
          attempt,
          lease,
          firstStartedAt: task.firstStartedAt ?? now,
          lastStartedAt: now,
          updatedAt: now,
          attempts: [...task.attempts, {
            schemaVersion: 'agent-task-attempt-record/v1' as const,
            runIdentity,
            startedAt: now,
            ...execution,
            outcome: 'running' as const,
          }],
        } as RunningBackgroundAgentTask
        const event = runEvent(current, running, 'task_claimed', { lease }, now)
        return finalizeAgentTaskGraphMutationV2(current, replaceTask(current, running), event, now)
      })
    } catch (error) {
      if (isExpectedClaimConflict(error)) return undefined
      throw error
    }
  }

  private execute(sessionId: string, graph: AgentTaskGraphV2, task: RunningBackgroundAgentTask): RunningExecution {
    const controller = new AbortController()
    const runIdentity = identityOf(task)
    const promise = this.runAttempt(sessionId, graph, task, controller)
      .catch(async (error) => {
        await this.commitUnexpectedFailure(sessionId, runIdentity, error).catch(() => undefined)
      })
      .finally(() => this.running.delete(runKey(sessionId, task.id)))
    return { controller, runIdentity, promise }
  }

  private async runAttempt(
    sessionId: string,
    graph: AgentTaskGraphV2,
    task: RunningBackgroundAgentTask,
    controller: AbortController,
  ): Promise<void> {
    const runner = this.registry.require(task.kind)
    const request = this.requestFactory(task, graph, runner, identityOf(task))
    const timeout = setTimeout(() => controller.abort('timeout'), task.timeoutMs)
    let outcome: AgentTaskRunOutcome
    try {
      const runPromise = runner.run(request as never, {
        abortSignal: controller.signal,
        reportProgress: (progress) => this.commitProgress(sessionId, progress),
      })
      outcome = await Promise.race([
        runPromise,
        abortedOutcome(controller.signal),
      ])
    } catch (error) {
      outcome = {
        schemaVersion: 'agent-task-run-outcome/v1',
        outcome: 'failed',
        error: runnerErrorFromThrown(error),
      }
    } finally {
      clearTimeout(timeout)
    }
    await this.commitOutcome(sessionId, identityOf(task), outcome, controller.signal.reason)
  }

  private async commitProgress(
    sessionId: string,
    progress: Parameters<Parameters<AgentTaskRunnerV1['run']>[1]['reportProgress']>[0],
  ): Promise<void> {
    await this.store.transact(sessionId, (current) => {
      const task = requireFencedTask(current, progress.runIdentity)
      const event = runEvent(current, task, 'task_progressed', {
        progressSeq: progress.progressSeq,
        phase: progress.phase,
        summary: progress.summary,
      }, progress.occurredAt)
      return finalizeAgentTaskGraphMutationV2(current, replaceTask(current, { ...task, updatedAt: progress.occurredAt }), event, progress.occurredAt)
    })
  }

  private async commitOutcome(
    sessionId: string,
    identity: TaskRunIdentity,
    outcome: AgentTaskRunOutcome,
    abortReason: unknown,
  ): Promise<void> {
    if (outcome.outcome === 'succeeded' || outcome.outcome === 'succeeded_deterministic') {
      await this.commitSuccess(sessionId, identity, outcome)
      return
    }
    if (outcome.outcome === 'aborted') {
      if (String(abortReason ?? outcome.reason) === 'timeout') {
        await this.commitFailure(sessionId, identity, {
          schemaVersion: 'agent-task-runner-error/v1',
          code: 'LLM_TIMEOUT',
          category: 'transient',
          retryDisposition: 'retry_same_task',
          message: `Task ${identity.taskId} exceeded its attempt timeout.`,
        })
        return
      }
      await this.commitAborted(sessionId, identity, String(abortReason ?? outcome.reason))
      return
    }
    await this.commitFailure(sessionId, identity, outcome.error)
  }

  private async commitSuccess(
    sessionId: string,
    identity: TaskRunIdentity,
    outcome: Extract<AgentTaskRunOutcome, { outcome: 'succeeded' | 'succeeded_deterministic' }>,
  ): Promise<void> {
    const committed = await this.store.transact(sessionId, (current) => {
      const task = requireFencedTask(current, identity)
      const now = this.iso()
      const materialized = materializeSuccess(outcome, task, this.materializeLlmResult)
      const freshness = assessAsyncTaskResultFreshness(task.actionBinding, current.actionClock)
      const outputs = materialized.outputRefs.map((artifactRef, index): AgentTaskOutput => ({
        schemaVersion: 'agent-task-output/v1',
        outputId: `output_${task.id}_${identity.attempt}_${index + 1}`,
        kind: artifactRef.artifactKind === 'sidechain_transcript' ? 'transcript_ref' : 'artifact_ref',
        artifactRef,
        attempt: identity.attempt,
        leaseId: identity.leaseId,
        freshness,
        appendToMainTranscript: false,
        requiresMainWorkflowVerification: true,
        authoritativeCompletionEvidence: false,
      }))
      const completed = finishAttempt({
        ...task,
        status: 'completed',
        lease: undefined,
        terminalAt: now,
        updatedAt: now,
        outputs: [...task.outputs, ...outputs],
      } as unknown as AgentTask, identity, 'succeeded', now)
      const event = runEvent(current, task, 'task_completed', {
        outputRefs: materialized.outputRefs,
        freshness,
      }, now)
      const notification = completedNotification(current, completed, event, materialized.outputRefs, freshness, now)
      const draft = refreshDependencyBlocks(replaceTask(current, completed), now)
      draft.notificationOutbox.push(outboxEntry(notification, event))
      return finalizeAgentTaskGraphMutationV2(current, draft, event, now)
    })
    this.reconcileOutbox(committed.graph)
    refreshDependentsSoon(this, sessionId)
  }

  private async commitFailure(sessionId: string, identity: TaskRunIdentity, error: RunnerError): Promise<void> {
    const committed = await this.store.transact(sessionId, (current) => {
      const task = requireFencedTask(current, identity)
      const now = this.iso()
      const mapped = contractErrorFromRunner(error, task, now)
      if (error.retryDisposition === 'retry_same_task' && task.attempt < task.maxAttempts) {
        const pending = finishAttempt({
          ...task,
          status: 'pending',
          lease: undefined,
          updatedAt: now,
          nextAttemptAt: new Date(Date.parse(now) + this.retryDelayMs).toISOString(),
          lastError: mapped,
        } as unknown as AgentTask, identity, 'failed', now, mapped)
        const event = runEvent(current, task, 'task_retry_scheduled', {
          nextAttemptAt: (pending as Extract<AgentTask, { status: 'pending' }>).nextAttemptAt!,
          error: mapped,
        }, now)
        return finalizeAgentTaskGraphMutationV2(current, replaceTask(current, pending), event, now)
      }
      const failed = finishAttempt({
        ...task,
        status: 'failed',
        lease: undefined,
        terminalAt: now,
        updatedAt: now,
        lastError: mapped,
      } as unknown as AgentTask, identity, 'failed', now, mapped)
      const event = runEvent(current, task, 'task_failed', { error: mapped }, now)
      const notification = failedNotification(current, failed, event, mapped, { kind: 'run', runIdentity: identity }, now)
      const draft = replaceTask(current, failed)
      draft.notificationOutbox.push(outboxEntry(notification, event))
      return finalizeAgentTaskGraphMutationV2(current, draft, event, now)
    })
    this.reconcileOutbox(committed.graph)
    const task = committed.graph.tasks.find((candidate) => candidate.id === identity.taskId)
    if (task?.status === 'pending') setTimeout(() => void this.tick(sessionId), this.retryDelayMs)
  }

  private async commitAborted(sessionId: string, identity: TaskRunIdentity, reason: string): Promise<void> {
    await this.store.transact(sessionId, (current) => {
      const task = requireFencedTask(current, identity)
      const now = this.iso()
      const sessionAbort = task.cancellation?.reason === 'session_abort'
      const error = contractError(sessionAbort ? 'SESSION_ABORTED' : 'CANCELLED', `Task ${task.id} aborted: ${reason}`, task.id, now, identity)
      const killed = finishAttempt({
        ...task,
        status: 'killed',
        lease: undefined,
        terminalAt: now,
        updatedAt: now,
        lastError: error,
      } as unknown as AgentTask, identity, 'aborted', now, error)
      const event = runEvent(current, task, 'task_killed', { error }, now)
      // S003: an aborted runner outcome has no result refs and emits no completion notification.
      return finalizeAgentTaskGraphMutationV2(current, replaceTask(current, killed), event, now)
    })
  }

  private async commitUnexpectedFailure(sessionId: string, identity: TaskRunIdentity, error: unknown): Promise<void> {
    await this.commitFailure(sessionId, identity, runnerErrorFromThrown(error))
  }

  private async recoverExpiredLeases(sessionId: string): Promise<void> {
    let graph = await this.store.load(sessionId)
    if (!graph) return
    for (const task of graph.tasks) {
      if (task.status !== 'running' || task.lease.expiresAt > this.iso()) continue
      const identity = identityOf(task)
      const now = this.iso()
      const committed = await this.store.transact(sessionId, (current) => {
        const running = requireRunningTask(current, identity.taskId)
        if (!sameIdentity(running, identity)) throw schedulerError('STALE_LEASE', `Run identity is stale for task ${task.id}.`)
        if (running.lease.expiresAt > now) throw schedulerError('INVALID_TRANSITION', `Lease for ${task.id} is no longer expired.`)
        const browserWrite = running.kind === 'main_browser_step'
        const maxed = !browserWrite && running.attempt >= running.maxAttempts
        const error = contractError(
          browserWrite ? 'POLICY_VIOLATION' : maxed ? 'MAX_ATTEMPTS_EXCEEDED' : 'LEASE_EXPIRED',
          browserWrite
            ? `Expired browser-write task ${task.id} cannot be replayed by the background scheduler.`
            : maxed ? `Task ${task.id} exhausted attempts after lease expiry.` : `Lease expired for task ${task.id}.`,
          task.id,
          now,
          identity,
        )
        const recovered = finishAttempt({
          ...running,
          status: browserWrite || maxed ? 'failed' : 'pending',
          lease: undefined,
          ...(browserWrite || maxed ? { terminalAt: now } : {}),
          updatedAt: now,
          lastError: error,
        } as unknown as AgentTask, identity, 'lease_expired', now, error)
        const event = runEvent(current, running, 'task_lease_expired', {
          expiredLeaseId: identity.leaseId,
          recovery: browserWrite
            ? {
                schemaVersion: 'task-lease-recovery-decision/v1',
                disposition: 'fail_browser_write',
                expiredRunIdentity: identity,
                releasedLockIds: releaseActiveLockIds(current, task.id),
                error,
              }
            : maxed
            ? {
                schemaVersion: 'task-lease-recovery-decision/v1',
                disposition: 'fail_max_attempts',
                expiredRunIdentity: identity,
                releasedLockIds: releaseActiveLockIds(current, task.id),
                error,
              }
            : {
                schemaVersion: 'task-lease-recovery-decision/v1',
                disposition: 'requeue_read_only',
                expiredRunIdentity: identity,
                releasedLockIds: releaseActiveLockIds(current, task.id),
              },
        }, now)
        const draft = releaseTaskLocks(replaceTask(current, recovered), task.id, now)
        if (browserWrite || maxed) {
          const notification = failedNotification(current, recovered, event, error, { kind: 'run', runIdentity: identity }, now)
          draft.notificationOutbox.push(outboxEntry(notification, event))
        }
        return finalizeAgentTaskGraphMutationV2(current, draft, event, now)
      })
      graph = committed.graph
      this.running.get(runKey(sessionId, task.id))?.controller.abort('lease_lost')
      this.reconcileOutbox(graph)
    }
  }

  private reconcileOutbox(graph: AgentTaskGraphV2): void {
    for (const entry of graph.notificationOutbox) {
      if (entry.state === 'pending_delivery') this.notifications.enqueue(entry.notification)
    }
  }

  private hasCapacity(graph: AgentTaskGraphV2, capacityClass: 'read_only_llm' | 'deterministic'): boolean {
    const active = graph.tasks.filter((task) => task.status === 'running' && task.capacityClass === capacityClass).length
    return active < (capacityClass === 'read_only_llm' ? this.maxReadOnly : this.maxDeterministic)
  }

  private iso(): string { return this.now().toISOString() }
}

function defaultRequestFactory(
  task: RunningBackgroundAgentTask,
  graph: AgentTaskGraphV2,
  runner: AgentTaskRunnerV1,
  runIdentity: TaskRunIdentity,
): AgentTaskRunRequestV1 {
  const limits = {
    maxTurns: 6,
    maxToolCalls: 16,
    maxInputTokens: 8_000,
    maxOutputTokens: 2_000,
    perRequestTimeoutMs: Math.min(30_000, task.timeoutMs),
    overallTimeoutMs: task.timeoutMs,
  }
  if (runner.runnerKind === 'read_only_llm') {
    throw schedulerError('CONTEXT_POLICY_VIOLATION', `Task ${task.id} requires an injected S004 request factory.`)
  }
  return {
    schemaVersion: 'agent-task-run-input/v1',
    runnerKind: 'deterministic',
    runIdentity,
    runnerId: runner.runnerId,
    runnerVersion: runner.runnerVersion,
    graphRevision: graph.revision,
    task: task as Extract<RunningBackgroundAgentTask, { kind: 'memory_retrieval' | 'workflow_evaluation' | 'delivery_probe' }>,
    limits,
    inputArtifactRefs: task.inputs.flatMap((input) => input.artifactRef ? [input.artifactRef] : []),
  }
}

function baseEvent(
  graph: AgentTaskGraphV2,
  task: AgentTask,
  eventType: AgentTaskEvent['eventType'],
  payload: AgentTaskEvent['payload'],
  now: string,
): Omit<AgentTaskEvent, 'runIdentity'> {
  return {
    schemaVersion: 'agent-task-event/v1',
    eventId: `event_${randomUUID()}`,
    eventSeq: graph.nextEventSeq,
    eventType,
    sessionId: graph.sessionId,
    graphId: graph.graphId,
    taskId: task.id,
    occurredAt: now,
    revisionBefore: graph.revision,
    revisionAfter: graph.revision + 1,
    actionBinding: task.actionBinding,
    correlationId: `task_${task.id}`,
    payload,
    authoritativeTaskState: true,
    authoritativeCompletionEvidence: false,
  } as Omit<AgentTaskEvent, 'runIdentity'>
}

function runEvent<T extends AgentTaskEvent['eventType']>(
  graph: AgentTaskGraphV2,
  task: Extract<AgentTask, { status: 'running' }>,
  eventType: T,
  payload: Extract<AgentTaskEvent, { eventType: T }>['payload'],
  now: string,
): Extract<AgentTaskEvent, { eventType: T }> {
  return { ...baseEvent(graph, task, eventType, payload, now), runIdentity: identityOf(task) } as Extract<AgentTaskEvent, { eventType: T }>
}

function controlEvent<T extends AgentTaskEvent['eventType']>(
  graph: AgentTaskGraphV2,
  task: AgentTask,
  eventType: T,
  payload: Extract<AgentTaskEvent, { eventType: T }>['payload'],
  now: string,
): Extract<AgentTaskEvent, { eventType: T }> {
  return baseEvent(graph, task, eventType, payload, now) as Extract<AgentTaskEvent, { eventType: T }>
}

function replaceTask(graph: AgentTaskGraphV2, task: AgentTask): AgentTaskGraphV2 {
  return { ...structuredClone(graph), tasks: graph.tasks.map((candidate) => candidate.id === task.id ? structuredClone(task) : structuredClone(candidate)) }
}

function requireTask(graph: AgentTaskGraphV2, taskId: string): AgentTask {
  const task = graph.tasks.find((candidate) => candidate.id === taskId)
  if (!task) throw schedulerError('TASK_NOT_FOUND', `Task not found: ${taskId}`)
  return task
}

function requireRunningTask(graph: AgentTaskGraphV2, taskId: string): Extract<AgentTask, { status: 'running' }> {
  const task = requireTask(graph, taskId)
  if (task.status !== 'running') throw schedulerError('INVALID_TRANSITION', `Task ${taskId} is not running.`)
  return task
}

function requireFencedTask(graph: AgentTaskGraphV2, identity: TaskRunIdentity): RunningBackgroundAgentTask {
  const task = requireRunningTask(graph, identity.taskId)
  if (task.kind === 'main_browser_step') {
    throw schedulerError('POLICY_VIOLATION', `Background scheduler cannot fence browser task ${task.id}.`)
  }
  if (task.attempt !== identity.attempt || task.lease.leaseId !== identity.leaseId
    || task.lease.ownerId !== identity.leaseOwnerId) {
    throw schedulerError('STALE_LEASE', `Run identity is stale for task ${task.id}.`)
  }
  return task
}

function identityOf(task: Extract<AgentTask, { status: 'running' }>): TaskRunIdentity {
  return { taskId: task.id, attempt: task.attempt, leaseId: task.lease.leaseId, leaseOwnerId: task.lease.ownerId }
}

function finishAttempt(
  task: AgentTask,
  identity: TaskRunIdentity,
  outcome: 'succeeded' | 'failed' | 'aborted' | 'lease_expired',
  finishedAt: string,
  error?: TaskContractError,
): AgentTask {
  return {
    ...task,
    attempts: task.attempts.map((attempt) => attempt.runIdentity.leaseId === identity.leaseId
      ? { ...attempt, outcome, finishedAt, ...(error ? { error } : {}) }
      : attempt) as AgentTask['attempts'],
  }
}

function materializeSuccess(
  outcome: Extract<AgentTaskRunOutcome, { outcome: 'succeeded' | 'succeeded_deterministic' }>,
  task: RunningBackgroundAgentTask,
  materializeLlmResult: AgentTaskSchedulerOptions['materializeLlmResult'],
): {
  outputRefs: [ImmutableArtifactRef, ...ImmutableArtifactRef[]]
  freshness: ResultFreshnessVerdict
} {
  if (outcome.outcome === 'succeeded_deterministic') return outcome.result
  const roleMetadata = task.inputs
    .filter((input) => input.kind === 'goal')
    .map((input) => parseBuiltInRoleTaskMetadata(input.structuredValue))
    .find((value) => value !== undefined)
  if (roleMetadata) {
    const roleOutput = outcome.result.roleOutput
    if (!roleOutput
      || roleOutput.roleId !== roleMetadata.roleId
      || roleOutput.roleVersion !== roleMetadata.roleVersion
      || roleOutput.roleDigest !== roleMetadata.roleDigest
      || roleOutput.artifactKind !== roleMetadata.outputArtifactKind
      || roleOutput.payloadSchemaVersion !== roleMetadata.outputPayloadSchemaVersion
      || roleOutput.requiresMainWorkflowVerification !== true
      || roleOutput.authoritativeCompletionEvidence !== false) {
      throw schedulerError('RESULT_SCHEMA_INVALID', `Built-in role result for ${task.id} does not match its durable role binding.`)
    }
    try {
      validateBuiltInRoleOutputPayload(roleMetadata.roleId, roleOutput.payload)
    } catch (error) {
      throw schedulerError(
        'RESULT_SCHEMA_INVALID',
        `Built-in role result for ${task.id} failed its output schema: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  if (!materializeLlmResult) {
    throw schedulerError(
      'RESULT_SCHEMA_INVALID',
      `Read-only LLM result for ${task.id} must be persisted as an immutable attempt result before commit.`,
    )
  }
  const materialized = materializeLlmResult(outcome, task)
  if (roleMetadata && !materialized.outputRefs.some((ref) => ref.artifactKind === roleMetadata.outputArtifactKind)) {
    throw schedulerError(
      'RESULT_SCHEMA_INVALID',
      `Built-in role result for ${task.id} was not materialized as ${roleMetadata.outputArtifactKind}.`,
    )
  }
  return materialized
}

function completedNotification(
  graph: AgentTaskGraphV2,
  task: AgentTask,
  event: Extract<AgentTaskEvent, { eventType: 'task_completed' }>,
  outputRefs: [ImmutableArtifactRef, ...ImmutableArtifactRef[]],
  freshness: ResultFreshnessVerdict,
  now: string,
): Extract<TaskNotificationV1, { terminalStatus: 'completed' }> {
  return {
    ...notificationBase(graph, task, event, now),
    terminalStatus: 'completed',
    terminalIdentity: { kind: 'run', runIdentity: event.runIdentity },
    outputRefs,
    freshness,
  }
}

function failedNotification(
  graph: AgentTaskGraphV2,
  task: AgentTask,
  event: AgentTaskEvent,
  error: TaskContractError,
  terminalIdentity: Extract<TaskNotificationV1, { terminalStatus: 'failed' | 'killed' }>['terminalIdentity'],
  now: string,
): Extract<TaskNotificationV1, { terminalStatus: 'failed' | 'killed' }> {
  return {
    ...notificationBase(graph, task, event, now),
    terminalStatus: task.status === 'killed' ? 'killed' : 'failed',
    terminalIdentity,
    outputRefs: [],
    error,
  }
}

function notificationBase(graph: AgentTaskGraphV2, task: AgentTask, event: AgentTaskEvent, now: string) {
  return {
    schemaVersion: 'agent-task-notification/v1' as const,
    notificationId: `notification_${event.eventId}`,
    sourceEventId: event.eventId,
    dedupeKey: `${event.eventId}:task-notification/v1`,
    sessionId: graph.sessionId,
    graphId: graph.graphId,
    graphRevision: graph.revision + 1,
    sourceEventSeq: event.eventSeq,
    taskId: task.id,
    taskKind: task.kind,
    summary: task.status === 'completed' ? `Task ${task.id} completed.` : `Task ${task.id} ${task.status}.`,
    createdAt: now,
    requiresMainWorkflowVerification: true as const,
    authoritativeCompletionEvidence: false as const,
  }
}

function outboxEntry(notification: TaskNotificationV1, event: AgentTaskEvent): TaskNotificationOutboxEntryV1 {
  return {
    schemaVersion: 'agent-task-notification-outbox-entry/v1',
    sourceEventId: event.eventId,
    sourceEventSeq: event.eventSeq,
    notification,
    state: 'pending_delivery',
  }
}

function contractErrorFromRunner(error: RunnerError, task: AgentTask, now: string): TaskContractError {
  const code = error.code === 'ARTIFACT_NOT_READY' ? 'ARTIFACT_NOT_READY'
    : error.code === 'ARTIFACT_INTEGRITY_FAILED' ? 'ARTIFACT_INTEGRITY_FAILED'
      : error.code === 'OUTPUT_SCHEMA_INVALID' ? 'RESULT_SCHEMA_INVALID'
        : error.code === 'SESSION_ABORTED' ? 'SESSION_ABORTED'
          : error.code === 'POLICY_VIOLATION' || error.code === 'TOOL_DENIED' ? 'POLICY_VIOLATION'
            : 'INVALID_TRANSITION'
  return {
    schemaVersion: 'async-task-contract-error/v1',
    code,
    category: error.category === 'cancelled' ? 'cancelled' : error.category === 'transient' ? 'transient' : error.category,
    retryDisposition: error.retryDisposition === 'retry_same_task' ? 'retry_same_task' : 'never_retry',
    message: error.message,
    occurredAt: now,
    taskId: task.id,
    attempt: task.attempt,
    ...(task.status === 'running' ? { leaseId: task.lease.leaseId } : {}),
    ...(error.safeDetails ? { safeDetails: error.safeDetails } : {}),
    ...(error.causeArtifactRef ? { causeArtifactRef: error.causeArtifactRef } : {}),
  }
}

function contractError(
  code: 'CANCELLED' | 'SESSION_ABORTED' | 'LEASE_EXPIRED' | 'MAX_ATTEMPTS_EXCEEDED' | 'POLICY_VIOLATION',
  message: string,
  taskId: string,
  now: string,
  identity?: TaskRunIdentity,
): TaskContractError {
  return {
    schemaVersion: 'async-task-contract-error/v1',
    code,
    category: code === 'CANCELLED' || code === 'SESSION_ABORTED' ? 'cancelled'
      : code === 'POLICY_VIOLATION' ? 'policy' : 'conflict',
    retryDisposition: code === 'LEASE_EXPIRED' ? 'retry_same_task' : 'never_retry',
    message,
    occurredAt: now,
    taskId,
    ...(identity ? { attempt: identity.attempt, leaseId: identity.leaseId } : {}),
  }
}

function sameIdentity(task: Extract<AgentTask, { status: 'running' }>, identity: TaskRunIdentity): boolean {
  return task.id === identity.taskId && task.attempt === identity.attempt
    && task.lease.leaseId === identity.leaseId && task.lease.ownerId === identity.leaseOwnerId
}

function releaseActiveLockIds(graph: AgentTaskGraphV2, taskId: string): string[] {
  return graph.locks.filter((lock) => lock.ownerTaskId === taskId && !lock.releasedAt).map((lock) => lock.id)
}

function releaseTaskLocks(graph: AgentTaskGraphV2, taskId: string, now: string): AgentTaskGraphV2 {
  return {
    ...graph,
    locks: graph.locks.map((lock) => lock.ownerTaskId === taskId && !lock.releasedAt ? { ...lock, releasedAt: now } : lock),
    safety: graph.safety.browserWriteOwnership.activeTaskId === taskId
      ? { ...graph.safety, browserWriteOwnership: { owner: 'main_agent_runtime' } }
      : graph.safety,
  }
}

function runnerErrorFromThrown(error: unknown): RunnerError {
  return {
    schemaVersion: 'agent-task-runner-error/v1',
    code: 'INTERNAL',
    category: 'internal',
    retryDisposition: 'never_retry',
    message: error instanceof Error ? error.message : String(error),
  }
}

function isTerminal(task: AgentTask): boolean {
  return task.status === 'completed' || task.status === 'failed' || task.status === 'killed'
}

function isExpectedClaimConflict(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && ['INVALID_TRANSITION', 'DEPENDENCY_UNRESOLVED', 'QUEUE_CAPACITY_EXCEEDED', 'MAX_ATTEMPTS_EXCEEDED', 'SESSION_ABORTED'].includes(String(error.code))
}

function schedulerError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code })
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer.`)
  return value
}

function runKey(sessionId: string, taskId: string): string { return `${sessionId}\u0000${taskId}` }

function refreshDependentsSoon(scheduler: AgentTaskScheduler, sessionId: string): void {
  queueMicrotask(() => void scheduler.tick(sessionId))
}

function abortedOutcome(signal: AbortSignal): Promise<Extract<AgentTaskRunOutcome, { outcome: 'aborted' }>> {
  return new Promise((resolve) => {
    const finish = (): void => resolve({
      schemaVersion: 'agent-task-run-outcome/v1',
      outcome: 'aborted',
      reason: signal.reason === 'timeout' ? 'timeout' : signal.reason === 'session_abort' ? 'session_abort' : 'signal',
    })
    if (signal.aborted) finish()
    else signal.addEventListener('abort', finish, { once: true })
  })
}

function refreshDependencyBlocks(graph: AgentTaskGraphV2, now: string): AgentTaskGraphV2 {
  return {
    ...graph,
    tasks: graph.tasks.map((task) => {
      if (task.status !== 'blocked' || task.blockReason.kind !== 'dependency_wait') return task
      const unresolvedTaskIds = task.blockedBy.filter((id) => graph.tasks.find((candidate) => candidate.id === id)?.status !== 'completed')
      if (unresolvedTaskIds.length > 0) {
        return { ...task, blockReason: { kind: 'dependency_wait', unresolvedTaskIds } }
      }
      return { ...task, status: 'pending', blockReason: undefined, updatedAt: now } as AgentTask
    }),
  }
}
