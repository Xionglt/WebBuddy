import { randomUUID } from 'node:crypto'
import {
  answerPendingContinuation,
  createResumeCapsule,
  retargetResumeCapsule,
  validatePendingContinuation,
  type PendingContinuationV1,
} from '../continuation/contracts.js'
import type {
  ApprovalBinding,
  ArtifactRef,
  JsonObject,
  OwnerScope,
  RunLifecycleState,
  WebTaskInputSnapshot,
} from '../task/contracts.js'
import {
  APPROVAL_EVENT_SCHEMA_VERSION,
  APPROVAL_RECORD_SCHEMA_VERSION,
  ControlStoreError,
  RUN_EVENT_SCHEMA_VERSION,
  RUN_RECORD_SCHEMA_VERSION,
  controlRecordDigest,
  type ApprovalListQuery,
  type ApprovalStoreEvent,
  type ApprovalRecord,
  type ApprovalResolutionExpectation,
  type ApprovalStore,
  type OpaqueResourceRef,
  type RunListQuery,
  type RunRecord,
  type RunEventQuery,
  type RunStore,
  type RunStoreEvent,
  type SafeTurnBoundaryRef,
  type ScopedStoreQuery,
  type StoreCommit,
} from './store-contracts.js'

export class RunServiceError extends Error {
  constructor(
    readonly code: 'RUN_NOT_FOUND' | 'ILLEGAL_TRANSITION' | 'STALE_ATTEMPT' | 'INVALID_CONTROL',
    message: string,
  ) {
    super(message)
    this.name = 'RunServiceError'
  }
}

const LEGAL_TRANSITIONS: Readonly<Record<RunLifecycleState, readonly RunLifecycleState[]>> = {
  queued: ['running', 'cancelling', 'cancelled', 'failed'],
  running: ['pausing', 'blocked_on_human', 'cancelling', 'completed', 'failed', 'interrupted'],
  pausing: ['paused', 'cancelling', 'failed', 'interrupted'],
  paused: ['resuming', 'cancelling', 'cancelled'],
  blocked_on_human: ['resuming', 'cancelling', 'cancelled', 'failed'],
  resuming: ['running', 'cancelling', 'failed', 'interrupted'],
  cancelling: ['cancelled', 'failed'],
  cancelled: [],
  completed: [],
  failed: [],
  interrupted: ['recoverable', 'failed', 'cancelling'],
  recoverable: ['resuming', 'cancelling', 'cancelled', 'failed'],
}

export interface TransitionRunInput {
  to: RunLifecycleState
  reason?: string
  idempotencyKey: string
  expectedRecordRevision?: number
  expectedRunRevision?: number
  expectedAttempt?: number
  eventType?: RunStoreEvent['eventType']
  data?: JsonObject
  update?: (record: RunRecord) => Partial<RunRecord>
}

export interface LateResultInput {
  runId: string
  runRevision: number
  attempt: number
  terminalState: Extract<RunLifecycleState, 'completed' | 'failed' | 'cancelled'>
  reason?: string
  artifactRefs?: ArtifactRef[]
  resourceRefs?: OpaqueResourceRef[]
  idempotencyKey: string
  ownerScope?: OwnerScope
}

export interface LateResultDecision {
  accepted: boolean
  record: RunRecord
}

export interface ContinuationAnswerResult {
  record: RunRecord
  changed: boolean
}

export interface ControlEpochExpectation {
  expectedRecordRevision?: number
  expectedRunRevision?: number
  expectedAttempt?: number
}

export class RunService {
  constructor(readonly store: RunStore) {}

  async create(
    inputSnapshot: WebTaskInputSnapshot,
    options: { idempotencyKey: string; now?: string } ,
  ): Promise<StoreCommit<RunRecord, RunStoreEvent>> {
    const now = options.now ?? new Date().toISOString()
    const record: RunRecord = {
      schemaVersion: RUN_RECORD_SCHEMA_VERSION,
      runId: inputSnapshot.runId,
      recordRevision: 0,
      runRevision: inputSnapshot.revision,
      attempt: inputSnapshot.sessionRef?.attempt ?? 1,
      state: 'queued',
      inputSnapshot,
      inputDigest: inputSnapshot.sha256,
      ...(inputSnapshot.ownerScope ? { ownerScope: inputSnapshot.ownerScope } : {}),
      ...(inputSnapshot.sessionRef ? { sessionRef: inputSnapshot.sessionRef } : {}),
      artifactRefs: [],
      resourceRefs: [],
      pendingApprovalIds: [],
      nextEventSequence: 1,
      createdAt: now,
      updatedAt: now,
    }
    const event = createRunEvent(record, {
      eventType: 'run_created',
      eventSequence: 0,
      recordRevisionBefore: null,
      idempotencyKey: options.idempotencyKey,
      occurredAt: now,
    })
    return this.store.create({ record, event, options: { idempotencyKey: options.idempotencyKey } })
  }

  get(runId: string, scope?: ScopedStoreQuery): Promise<RunRecord | undefined> {
    return this.store.get(runId, scope)
  }

  list(query?: RunListQuery) {
    return this.store.list(query)
  }

  events(runId: string, query?: RunEventQuery) {
    return this.store.readEvents(runId, query)
  }

  async transition(runId: string, input: TransitionRunInput, scope?: ScopedStoreQuery): Promise<RunRecord> {
    const current = await this.require(runId, scope)
    if (input.expectedRecordRevision !== undefined && input.expectedRecordRevision !== current.recordRevision) {
      throw new ControlStoreError(
        'REVISION_CONFLICT',
        `Expected record revision ${input.expectedRecordRevision}, found ${current.recordRevision}.`,
        input.expectedRecordRevision,
        current.recordRevision,
      )
    }
    fence(current, input.expectedRunRevision, input.expectedAttempt)
    if (current.state === input.to) return current
    if (!LEGAL_TRANSITIONS[current.state].includes(input.to)) {
      throw new RunServiceError('ILLEGAL_TRANSITION', `Illegal run transition ${current.state} -> ${input.to}.`)
    }
    const now = new Date().toISOString()
    const patch = input.update?.(current) ?? {}
    const record: RunRecord = {
      ...current,
      ...patch,
      state: input.to,
      recordRevision: current.recordRevision + 1,
      nextEventSequence: current.nextEventSequence + 1,
      updatedAt: now,
      ...(input.reason ? { reason: input.reason } : {}),
    }
    if (record.reason === undefined) delete record.reason
    if (record.sessionRef === undefined) delete record.sessionRef
    if (record.checkpointRef === undefined) delete record.checkpointRef
    if (record.lastSafeBoundary === undefined) delete record.lastSafeBoundary
    if (record.pendingContinuation === undefined) delete record.pendingContinuation
    if (record.lastResumeCapsule === undefined) delete record.lastResumeCapsule
    const event = createRunEvent(record, {
      eventType: input.eventType ?? 'state_transitioned',
      eventSequence: current.nextEventSequence,
      recordRevisionBefore: current.recordRevision,
      idempotencyKey: input.idempotencyKey,
      occurredAt: now,
      data: {
        from: current.state,
        to: input.to,
        ...(input.reason ? { reason: input.reason } : {}),
        ...(input.data ?? {}),
      },
    })
    const committed = await this.store.transact(runId, {
      expectedRecordRevision: current.recordRevision,
      record,
      event,
      idempotencyKey: input.idempotencyKey,
    })
    return committed.record
  }

  start(runId: string, idempotencyKey: string, scope?: ScopedStoreQuery): Promise<RunRecord> {
    return this.transition(runId, { to: 'running', idempotencyKey }, scope)
  }

  async attachSession(
    runId: string,
    sessionRef: NonNullable<RunRecord['sessionRef']>,
    idempotencyKey: string,
    scope?: ScopedStoreQuery,
  ): Promise<RunRecord> {
    const current = await this.require(runId, scope)
    if (sessionRef.runId !== runId
      || sessionRef.attempt !== current.attempt
      || (current.sessionRef && current.sessionRef.id !== sessionRef.id)) {
      throw new RunServiceError('INVALID_CONTROL', 'Session reference does not match the current run attempt.')
    }
    if (current.sessionRef?.id === sessionRef.id) return current
    const now = new Date().toISOString()
    const record: RunRecord = {
      ...current,
      sessionRef,
      recordRevision: current.recordRevision + 1,
      nextEventSequence: current.nextEventSequence + 1,
      updatedAt: now,
    }
    const event = createRunEvent(record, {
      eventType: 'reference_attached',
      eventSequence: current.nextEventSequence,
      recordRevisionBefore: current.recordRevision,
      idempotencyKey,
      occurredAt: now,
      data: { referenceKind: 'session', provider: sessionRef.provider, sessionId: sessionRef.id },
    })
    const committed = await this.store.transact(runId, {
      expectedRecordRevision: current.recordRevision,
      record,
      event,
      idempotencyKey,
    })
    return committed.record
  }

  async setPendingApproval(
    runId: string,
    approvalId: string,
    pending: boolean,
    idempotencyKey: string,
    scope?: ScopedStoreQuery,
  ): Promise<RunRecord> {
    const current = await this.require(runId, scope)
    const ids = new Set(current.pendingApprovalIds)
    const changed = pending ? !ids.has(approvalId) : ids.delete(approvalId)
    if (pending) ids.add(approvalId)
    if (!changed) return current
    const now = new Date().toISOString()
    const record: RunRecord = {
      ...current,
      pendingApprovalIds: [...ids],
      recordRevision: current.recordRevision + 1,
      nextEventSequence: current.nextEventSequence + 1,
      updatedAt: now,
    }
    const event = createRunEvent(record, {
      eventType: 'reference_attached',
      eventSequence: current.nextEventSequence,
      recordRevisionBefore: current.recordRevision,
      idempotencyKey,
      occurredAt: now,
      data: { referenceKind: 'approval', approvalId, pending },
    })
    const committed = await this.store.transact(runId, {
      expectedRecordRevision: current.recordRevision,
      record,
      event,
      idempotencyKey,
    })
    return committed.record
  }

  async requestPause(
    runId: string,
    idempotencyKey: string,
    scope?: ScopedStoreQuery,
    expectation: ControlEpochExpectation = {},
  ): Promise<RunRecord> {
    const current = await this.require(runId, scope)
    assertControlExpectation(current, expectation)
    if (current.state === 'pausing' || current.state === 'paused') return current
    return this.transition(runId, {
      to: 'pausing',
      idempotencyKey,
      ...expectation,
      eventType: 'control_requested',
      data: { control: 'pause', semantics: 'acknowledge_at_safe_turn_boundary' },
    }, scope)
  }

  async acknowledgePause(
    runId: string,
    boundary: SafeTurnBoundaryRef,
    idempotencyKey: string,
    scope?: ScopedStoreQuery,
    references?: Pick<LateResultInput, 'artifactRefs' | 'resourceRefs'>,
  ): Promise<RunRecord> {
    if (boundary.runId !== runId) throw new RunServiceError('INVALID_CONTROL', 'Safe boundary is bound to another run.')
    return this.transition(runId, {
      to: 'paused',
      idempotencyKey,
      expectedRunRevision: boundary.runRevision,
      expectedAttempt: boundary.attempt,
      eventType: 'safe_boundary_reached',
      data: { turnId: boundary.turnId, actionSeq: boundary.actionSeq },
      update: (record) => ({
        lastSafeBoundary: boundary,
        ...(boundary.sessionRef ? { sessionRef: boundary.sessionRef } : {}),
        ...(boundary.checkpointRef ? { checkpointRef: boundary.checkpointRef } : {}),
        ...(references?.artifactRefs
          ? { artifactRefs: mergeById(record.artifactRefs, references.artifactRefs) }
          : {}),
        ...(references?.resourceRefs
          ? { resourceRefs: mergeById(record.resourceRefs, references.resourceRefs) }
          : {}),
      }),
    }, scope)
  }

  async resume(
    runId: string,
    idempotencyKey: string,
    scope?: ScopedStoreQuery,
    expectation: ControlEpochExpectation = {},
  ): Promise<RunRecord> {
    const current = await this.require(runId, scope)
    assertControlExpectation(current, expectation)
    if (current.state === 'resuming') return current
    return this.transition(runId, {
      to: 'resuming',
      idempotencyKey,
      ...expectation,
      update: (record) => ({
        runRevision: record.runRevision + 1,
        attempt: record.attempt + 1,
        pendingApprovalIds: [],
        sessionRef: undefined,
        checkpointRef: undefined,
        lastSafeBoundary: undefined,
        reason: undefined,
      }),
      data: { control: 'resume', priorAttempt: current.attempt },
    }, scope)
  }

  async requestContinuation(
    runId: string,
    continuation: PendingContinuationV1,
    idempotencyKey: string,
    scope?: ScopedStoreQuery,
  ): Promise<RunRecord> {
    const current = await this.require(runId, scope)
    validatePendingContinuation(continuation, {
      runId: current.runId,
      runRevision: current.runRevision,
      attempt: current.attempt,
    })
    if (current.pendingContinuation?.continuationId === continuation.continuationId) return current
    if (current.pendingContinuation) {
      throw new RunServiceError(
        'INVALID_CONTROL',
        `Run already waits on continuation ${current.pendingContinuation.continuationId}.`,
      )
    }
    if (!current.sessionRef
      || current.sessionRef.provider !== 'file-session-store'
      || current.sessionRef.id !== continuation.binding.sessionId
      || current.sessionRef.runId !== current.runId
      || current.sessionRef.attempt !== current.attempt) {
      throw new RunServiceError(
        'INVALID_CONTROL',
        'Continuation requires the exact durable file session for the current run attempt.',
      )
    }
    if (current.state !== 'running') {
      throw new RunServiceError('ILLEGAL_TRANSITION', 'A continuation can only be requested by a running attempt.')
    }
    return this.transition(runId, {
      to: 'blocked_on_human',
      reason: continuation.question.prompt,
      idempotencyKey,
      expectedRecordRevision: current.recordRevision,
      expectedRunRevision: current.runRevision,
      expectedAttempt: current.attempt,
      eventType: 'continuation_requested',
      data: {
        continuationId: continuation.continuationId,
        questionId: continuation.question.questionId,
        field: continuation.question.field,
      },
      update: () => ({ pendingContinuation: structuredClone(continuation) }),
    }, scope)
  }

  async answerContinuation(
    runId: string,
    input: {
      continuationId: string
      answer: string
      intentPatch?: string
      idempotencyKey: string
      expectedRecordRevision?: number
      expectedRunRevision: number
      expectedAttempt: number
    },
    scope?: ScopedStoreQuery,
  ): Promise<ContinuationAnswerResult> {
    const current = await this.require(runId, scope)
    assertControlExpectation(current, {
      expectedRecordRevision: input.expectedRecordRevision,
      expectedRunRevision: input.expectedRunRevision,
      expectedAttempt: input.expectedAttempt,
    })
    const pending = current.pendingContinuation
    if (!pending || pending.continuationId !== input.continuationId) {
      throw new RunServiceError('INVALID_CONTROL', 'Continuation is missing or no longer current.')
    }
    if (current.state !== 'blocked_on_human') {
      throw new RunServiceError('ILLEGAL_TRANSITION', 'Continuation answer requires blocked_on_human state.')
    }
    if (pending.status === 'answered') {
      const sameAnswer = pending.answer?.answer === input.answer.trim()
        && (pending.answer?.intentPatch ?? undefined) === normalizedOptional(input.intentPatch)
      if (!sameAnswer) {
        throw new RunServiceError('INVALID_CONTROL', 'Continuation was already answered with different content.')
      }
      return { record: current, changed: false }
    }

    const answered = answerPendingContinuation(pending, {
      answer: input.answer,
      ...(normalizedOptional(input.intentPatch)
        ? { intentPatch: normalizedOptional(input.intentPatch) }
        : {}),
    })
    const now = new Date().toISOString()
    const record: RunRecord = {
      ...current,
      pendingContinuation: answered,
      recordRevision: current.recordRevision + 1,
      nextEventSequence: current.nextEventSequence + 1,
      updatedAt: now,
    }
    const event = createRunEvent(record, {
      eventType: 'continuation_answered',
      eventSequence: current.nextEventSequence,
      recordRevisionBefore: current.recordRevision,
      idempotencyKey: input.idempotencyKey,
      occurredAt: now,
      data: {
        continuationId: answered.continuationId,
        questionId: answered.question.questionId,
        hasIntentPatch: Boolean(answered.answer?.intentPatch),
      },
    })
    const committed = await this.store.transact(runId, {
      expectedRecordRevision: current.recordRevision,
      record,
      event,
      idempotencyKey: input.idempotencyKey,
    })
    return { record: committed.record, changed: !committed.replayed }
  }

  async continueAnsweredContinuationLive(
    runId: string,
    continuationId: string,
    scope?: ScopedStoreQuery,
  ): Promise<RunRecord> {
    const current = await this.require(runId, scope)
    const continuation = requireAnsweredContinuation(current, continuationId)
    const capsule = createResumeCapsule(continuation, {
      runRevision: current.runRevision,
      attempt: current.attempt,
      sessionId: continuation.binding.sessionId,
    })
    const resuming = await this.transition(runId, {
      to: 'resuming',
      idempotencyKey: `continuation-live-resuming:${current.runRevision}:${current.attempt}:${continuationId}`,
      expectedRecordRevision: current.recordRevision,
      expectedRunRevision: current.runRevision,
      expectedAttempt: current.attempt,
      eventType: 'continuation_resumed',
      data: { continuationId, mode: 'live' },
      update: () => ({
        pendingContinuation: undefined,
        lastResumeCapsule: capsule,
        reason: undefined,
      }),
    }, scope)
    return this.transition(runId, {
      to: 'running',
      idempotencyKey: `continuation-live-running:${current.runRevision}:${current.attempt}:${continuationId}`,
      expectedRecordRevision: resuming.recordRevision,
      expectedRunRevision: current.runRevision,
      expectedAttempt: current.attempt,
      data: { continuationId, mode: 'live' },
    }, scope)
  }

  async resumeAnsweredContinuation(
    runId: string,
    continuationId: string,
    idempotencyKey: string,
    scope?: ScopedStoreQuery,
  ): Promise<RunRecord> {
    const current = await this.require(runId, scope)
    const continuation = requireAnsweredContinuation(current, continuationId)
    const nextRunRevision = current.runRevision + 1
    const nextAttempt = current.attempt + 1
    const capsule = createResumeCapsule(continuation, {
      runRevision: nextRunRevision,
      attempt: nextAttempt,
      sessionId: continuation.binding.sessionId,
    })
    return this.transition(runId, {
      to: 'resuming',
      idempotencyKey,
      expectedRecordRevision: current.recordRevision,
      expectedRunRevision: current.runRevision,
      expectedAttempt: current.attempt,
      eventType: 'continuation_resumed',
      data: {
        continuationId,
        mode: 'cold',
        priorAttempt: current.attempt,
      },
      update: () => ({
        runRevision: nextRunRevision,
        attempt: nextAttempt,
        pendingApprovalIds: [],
        pendingContinuation: undefined,
        lastResumeCapsule: capsule,
        sessionRef: current.sessionRef
          ? { ...current.sessionRef, attempt: nextAttempt }
          : undefined,
        checkpointRef: undefined,
        lastSafeBoundary: undefined,
        reason: undefined,
      }),
    }, scope)
  }

  async resumeFromContinuationCheckpoint(
    runId: string,
    idempotencyKey: string,
    scope?: ScopedStoreQuery,
    expectation: ControlEpochExpectation = {},
  ): Promise<RunRecord> {
    const current = await this.require(runId, scope)
    assertControlExpectation(current, expectation)
    const capsule = current.lastResumeCapsule
    if (!capsule
      || capsule.target.runId !== current.runId
      || capsule.target.runRevision !== current.runRevision
      || capsule.target.attempt !== current.attempt
      || capsule.target.sessionId !== current.sessionRef?.id) {
      throw new RunServiceError(
        'INVALID_CONTROL',
        'Run does not have an exact durable continuation checkpoint for the current epoch.',
      )
    }
    const nextRunRevision = current.runRevision + 1
    const nextAttempt = current.attempt + 1
    const retargeted = retargetResumeCapsule(capsule, {
      runRevision: nextRunRevision,
      attempt: nextAttempt,
      sessionId: current.sessionRef.id,
    })
    return this.transition(runId, {
      to: 'resuming',
      idempotencyKey,
      ...expectation,
      eventType: 'continuation_resumed',
      data: {
        continuationId: capsule.continuationId,
        mode: 'cold',
        source: 'continuation_checkpoint',
        priorAttempt: current.attempt,
      },
      update: () => ({
        runRevision: nextRunRevision,
        attempt: nextAttempt,
        pendingApprovalIds: [],
        pendingContinuation: undefined,
        lastResumeCapsule: retargeted,
        sessionRef: { ...current.sessionRef!, attempt: nextAttempt },
        checkpointRef: undefined,
        lastSafeBoundary: undefined,
        reason: undefined,
      }),
    }, scope)
  }

  async requestCancel(
    runId: string,
    idempotencyKey: string,
    scope?: ScopedStoreQuery,
    options: ControlEpochExpectation & { quiescent?: boolean } = {},
  ): Promise<RunRecord> {
    const current = await this.require(runId, scope)
    assertControlExpectation(current, options)
    if (current.state === 'cancelled' || current.state === 'cancelling') return current
    const quiescentTerminal = options.quiescent === true
      && (current.state === 'paused'
        || current.state === 'recoverable'
        || current.state === 'blocked_on_human')
    if (current.state === 'queued' || quiescentTerminal) {
      return this.transition(runId, {
        to: 'cancelled',
        idempotencyKey,
        expectedRecordRevision: options.expectedRecordRevision,
        expectedRunRevision: options.expectedRunRevision,
        expectedAttempt: options.expectedAttempt,
        eventType: 'control_requested',
        reason: current.state === 'queued'
          ? 'Cancelled before execution.'
          : 'Cancelled while no live execution owned the run.',
        data: { control: 'cancel', quiescent: true },
        update: () => ({ pendingApprovalIds: [], pendingContinuation: undefined }),
      }, scope)
    }
    return this.transition(runId, {
      to: 'cancelling',
      idempotencyKey,
      expectedRecordRevision: options.expectedRecordRevision,
      expectedRunRevision: options.expectedRunRevision,
      expectedAttempt: options.expectedAttempt,
      eventType: 'control_requested',
      data: { control: 'cancel' },
      update: () => ({ pendingApprovalIds: [], pendingContinuation: undefined }),
    }, scope)
  }

  async acceptResult(input: LateResultInput): Promise<LateResultDecision> {
    const scope = input.ownerScope ? { ownerScope: input.ownerScope } : undefined
    const current = await this.require(input.runId, scope)
    if (current.runRevision !== input.runRevision || current.attempt !== input.attempt) {
      const record = await this.recordLateResult(current, input)
      return { accepted: false, record }
    }
    if (current.state === 'cancelling' && input.terminalState === 'cancelled') {
      return {
        accepted: true,
        record: await this.transition(input.runId, {
          to: 'cancelled',
          reason: input.reason,
          idempotencyKey: input.idempotencyKey,
          expectedRunRevision: input.runRevision,
          expectedAttempt: input.attempt,
          update: (record) => mergeRefs(record, input),
        }, scope),
      }
    }
    return {
      accepted: true,
      record: await this.transition(input.runId, {
        to: input.terminalState,
        reason: input.reason,
        idempotencyKey: input.idempotencyKey,
        expectedRunRevision: input.runRevision,
        expectedAttempt: input.attempt,
        update: (record) => mergeRefs(record, input),
      }, scope),
    }
  }

  async classifyInterrupted(
    runId: string,
    recoverable: boolean,
    reason: string,
    idempotencyKey: string,
    scope?: ScopedStoreQuery,
  ): Promise<RunRecord> {
    const current = await this.require(runId, scope)
    const interrupted = current.state === 'interrupted'
      ? current
      : await this.transition(runId, { to: 'interrupted', reason, idempotencyKey: `${idempotencyKey}:interrupted` }, scope)
    return this.transition(runId, {
      to: recoverable ? 'recoverable' : 'failed',
      reason,
      idempotencyKey: `${idempotencyKey}:classified`,
      eventType: 'recovery_classified',
      data: { recoverable },
      expectedRecordRevision: interrupted.recordRevision,
    }, scope)
  }

  private async recordLateResult(current: RunRecord, input: LateResultInput): Promise<RunRecord> {
    const now = new Date().toISOString()
    const record: RunRecord = {
      ...current,
      recordRevision: current.recordRevision + 1,
      nextEventSequence: current.nextEventSequence + 1,
      updatedAt: now,
    }
    const event = createRunEvent(record, {
      eventType: 'late_result_rejected',
      eventSequence: current.nextEventSequence,
      recordRevisionBefore: current.recordRevision,
      idempotencyKey: input.idempotencyKey,
      occurredAt: now,
      data: {
        submittedRunRevision: input.runRevision,
        submittedAttempt: input.attempt,
        currentRunRevision: current.runRevision,
        currentAttempt: current.attempt,
        terminalState: input.terminalState,
      },
    })
    const committed = await this.store.transact(input.runId, {
      expectedRecordRevision: current.recordRevision,
      record,
      event,
      idempotencyKey: input.idempotencyKey,
    })
    return committed.record
  }

  private async require(runId: string, scope?: ScopedStoreQuery): Promise<RunRecord> {
    const record = await this.store.get(runId, scope)
    if (!record) throw new RunServiceError('RUN_NOT_FOUND', `Unknown run: ${runId}.`)
    return record
  }
}

function requireAnsweredContinuation(
  record: RunRecord,
  continuationId: string,
): PendingContinuationV1 {
  const continuation = record.pendingContinuation
  if (!continuation || continuation.continuationId !== continuationId) {
    throw new RunServiceError('INVALID_CONTROL', 'Continuation is missing or no longer current.')
  }
  if (record.state !== 'blocked_on_human') {
    throw new RunServiceError('ILLEGAL_TRANSITION', 'Continuation resume requires blocked_on_human state.')
  }
  if (continuation.status !== 'answered' || !continuation.answer) {
    throw new RunServiceError('INVALID_CONTROL', 'Continuation must be answered before resume.')
  }
  return structuredClone(continuation)
}

function normalizedOptional(value?: string): string | undefined {
  const normalized = value?.trim()
  return normalized ? normalized : undefined
}

export class ApprovalService {
  constructor(readonly store: ApprovalStore) {}

  list(query?: ApprovalListQuery) {
    return this.store.list(query)
  }

  get(approvalId: string, scope?: ScopedStoreQuery) {
    return this.store.get(approvalId, scope)
  }

  async resolve(input: {
    approvalId: string
    ownerScope?: OwnerScope
    expectedRecordRevision: number
    expectation: ApprovalResolutionExpectation
    decision: 'approved' | 'denied'
    idempotencyKey: string
    nonce: string
    expiresAt: string
    resolvedAt?: string
  }): Promise<ApprovalRecord> {
    const resolvedAt = input.resolvedAt ?? new Date().toISOString()
    const resolution: ApprovalBinding = {
      schemaVersion: 'approval-binding/v1',
      approvalId: input.approvalId,
      actionBindingSha256: input.expectation.actionBindingSha256,
      decision: input.decision,
      issuedAt: resolvedAt,
      expiresAt: input.expiresAt,
      nonce: input.nonce,
    }
    const committed = await this.store.resolveOnce({
      approvalId: input.approvalId,
      ...(input.ownerScope ? { ownerScope: input.ownerScope } : {}),
      expectedRecordRevision: input.expectedRecordRevision,
      expectation: input.expectation,
      resolution,
      idempotencyKey: input.idempotencyKey,
      resolvedAt,
    })
    return committed.record
  }

  async enqueue(record: Omit<ApprovalRecord, 'schemaVersion' | 'recordRevision' | 'nextEventSequence' | 'actionBindingSha256' | 'updatedAt'>, idempotencyKey: string) {
    const actionBindingSha256 = controlRecordDigest(record.actionBinding)
    const full: ApprovalRecord = {
      ...record,
      schemaVersion: APPROVAL_RECORD_SCHEMA_VERSION,
      recordRevision: 0,
      actionBindingSha256,
      nextEventSequence: 1,
      updatedAt: record.requestedAt,
    }
    return this.store.create({
      record: full,
      event: {
        schemaVersion: APPROVAL_EVENT_SCHEMA_VERSION,
        eventId: randomUUID(),
        eventSequence: 0,
        eventType: 'approval_enqueued',
        approvalId: full.approvalId,
        runId: full.runId,
        recordRevisionBefore: null,
        recordRevisionAfter: 0,
        runRevision: full.runRevision,
        attempt: full.attempt,
        actionId: full.actionBinding.actionId,
        occurredAt: full.requestedAt,
        idempotencyKey,
        ...(full.ownerScope ? { ownerScope: full.ownerScope } : {}),
      },
      options: { idempotencyKey },
    })
  }

  async cancelPendingForRun(
    runId: string,
    reason: string,
    idempotencyPrefix: string,
    scope?: ScopedStoreQuery,
    expectation?: Pick<ControlEpochExpectation, 'expectedRunRevision' | 'expectedAttempt'>,
  ): Promise<ApprovalRecord[]> {
    const pending = await this.store.list({
      runId,
      statuses: ['pending'],
      limit: 1000,
      ...(scope?.ownerScope ? { ownerScope: scope.ownerScope } : {}),
    })
    const cancelled: ApprovalRecord[] = []
    for (const current of pending.items.filter((approval) => (
      (expectation?.expectedRunRevision === undefined
        || approval.runRevision === expectation.expectedRunRevision)
      && (expectation?.expectedAttempt === undefined
        || approval.attempt === expectation.expectedAttempt)
    ))) {
      const occurredAt = new Date().toISOString()
      const idempotencyKey = `${idempotencyPrefix}:${current.approvalId}`
      const record: ApprovalRecord = {
        ...current,
        recordRevision: current.recordRevision + 1,
        status: 'cancelled',
        terminal: {
          status: 'cancelled',
          source: 'system',
          occurredAt,
          reason,
        },
        nextEventSequence: current.nextEventSequence + 1,
        updatedAt: occurredAt,
      }
      const event: ApprovalStoreEvent = {
        schemaVersion: APPROVAL_EVENT_SCHEMA_VERSION,
        eventId: randomUUID(),
        eventSequence: current.nextEventSequence,
        eventType: 'approval_cancelled',
        approvalId: current.approvalId,
        runId: current.runId,
        recordRevisionBefore: current.recordRevision,
        recordRevisionAfter: record.recordRevision,
        runRevision: current.runRevision,
        attempt: current.attempt,
        actionId: current.actionBinding.actionId,
        occurredAt,
        idempotencyKey,
        ...(current.ownerScope ? { ownerScope: current.ownerScope } : {}),
        data: { reason },
      }
      const committed = await this.store.transact(current.approvalId, {
        expectedRecordRevision: current.recordRevision,
        record,
        event,
        idempotencyKey,
      })
      cancelled.push(committed.record)
    }
    return cancelled
  }
}

function createRunEvent(
  record: RunRecord,
  input: {
    eventType: RunStoreEvent['eventType']
    eventSequence: number
    recordRevisionBefore: number | null
    idempotencyKey: string
    occurredAt: string
    data?: JsonObject
  },
): RunStoreEvent {
  return {
    schemaVersion: RUN_EVENT_SCHEMA_VERSION,
    eventId: randomUUID(),
    eventSequence: input.eventSequence,
    eventType: input.eventType,
    runId: record.runId,
    recordRevisionBefore: input.recordRevisionBefore,
    recordRevisionAfter: record.recordRevision,
    runRevision: record.runRevision,
    attempt: record.attempt,
    occurredAt: input.occurredAt,
    idempotencyKey: input.idempotencyKey,
    ...(record.ownerScope ? { ownerScope: record.ownerScope } : {}),
    ...(input.data ? { data: input.data } : {}),
  }
}

function fence(current: RunRecord, runRevision?: number, attempt?: number): void {
  if ((runRevision !== undefined && runRevision !== current.runRevision)
    || (attempt !== undefined && attempt !== current.attempt)) {
    throw new RunServiceError(
      'STALE_ATTEMPT',
      `Stale run attempt: expected ${runRevision ?? current.runRevision}/${attempt ?? current.attempt}, current ${current.runRevision}/${current.attempt}.`,
    )
  }
}

function assertControlExpectation(
  current: RunRecord,
  expectation: ControlEpochExpectation,
): void {
  if (expectation.expectedRecordRevision !== undefined
    && expectation.expectedRecordRevision !== current.recordRevision) {
    throw new ControlStoreError(
      'REVISION_CONFLICT',
      `Expected record revision ${expectation.expectedRecordRevision}, found ${current.recordRevision}.`,
      expectation.expectedRecordRevision,
      current.recordRevision,
    )
  }
  fence(current, expectation.expectedRunRevision, expectation.expectedAttempt)
}

function mergeRefs(record: RunRecord, input: LateResultInput): Partial<RunRecord> {
  return {
    artifactRefs: mergeById(record.artifactRefs, input.artifactRefs ?? []),
    resourceRefs: mergeById(record.resourceRefs, input.resourceRefs ?? []),
  }
}

function mergeById<T extends { id: string }>(current: T[], next: T[]): T[] {
  const merged = new Map(current.map((item) => [item.id, item]))
  for (const item of next) merged.set(item.id, item)
  return [...merged.values()]
}

export function legalRunTransitions(state: RunLifecycleState): readonly RunLifecycleState[] {
  return LEGAL_TRANSITIONS[state]
}
