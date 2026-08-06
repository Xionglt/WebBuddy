import type {
  ApprovalRequest,
  PermissionDecision,
  PermissionRequest,
} from '../permission/permission-types.js'
import type {
  GateContext,
  GateDecision,
  GateKind,
  HumanGate,
  HumanInfoRequest,
  HumanInfoResponse,
} from '../sdk/human.js'
import {
  createPendingContinuation,
} from '../continuation/contracts.js'
import {
  digestCanonicalJson,
  type ActionBinding,
  type OwnerScope,
  type TaskContract,
} from '../task/contracts.js'
import type { ApprovalService, RunService } from './run-service.js'

interface PendingGate {
  resolve: (decision: GateDecision) => void
  removeAbortListener: () => void
}

interface PendingInformation {
  resolve: (response: HumanInfoResponse) => void
  removeAbortListener: () => void
}

export interface DurableHumanGateOptions {
  runs: RunService
  approvals: ApprovalService
  runId: string
  runRevision: number
  attempt: number
  taskContract: TaskContract
  goal: string
  sessionId: string
  abortSignal: AbortSignal
  ownerScope?: OwnerScope
  approvalTtlMs?: number
}

/**
 * Bridges AgentLoop human gates to the durable ApprovalStore. API resolution
 * resumes the live turn only after exact durable binding validation succeeds.
 */
export class DurableHumanGate implements HumanGate {
  private readonly pending = new Map<string, PendingGate>()
  private readonly pendingInformation = new Map<string, PendingInformation>()

  constructor(readonly options: DurableHumanGateOptions) {}

  async confirm(): Promise<GateDecision> {
    return 'takeover'
  }

  async requestInfo(request: HumanInfoRequest): Promise<HumanInfoResponse> {
    const scope = scoped(this.options.ownerScope)
    const current = await this.options.runs.get(this.options.runId, scope)
    if (!current
      || current.runRevision !== this.options.runRevision
      || current.attempt !== this.options.attempt
      || current.state !== 'running') {
      return { answer: '' }
    }
    const continuation = createPendingContinuation({
      runId: this.options.runId,
      runRevision: this.options.runRevision,
      attempt: this.options.attempt,
      sessionId: this.options.sessionId,
      goal: this.options.goal,
      goalRevision: this.options.taskContract.revision,
      contract: this.options.taskContract,
      field: request.field,
      question: request.question,
      ...(request.options?.length ? { options: request.options } : {}),
      ...(request.currentUrl ? { currentUrl: request.currentUrl } : {}),
    })
    let resolveInformation!: (response: HumanInfoResponse) => void
    const response = new Promise<HumanInfoResponse>((resolve) => {
      resolveInformation = resolve
    })
    const onAbort = () => {
      this.pendingInformation.delete(continuation.continuationId)
      resolveInformation({ answer: '' })
    }
    request.abortSignal?.addEventListener('abort', onAbort, { once: true })
    this.options.abortSignal.addEventListener('abort', onAbort, { once: true })
    this.pendingInformation.set(continuation.continuationId, {
      resolve: resolveInformation,
      removeAbortListener: () => {
        request.abortSignal?.removeEventListener('abort', onAbort)
        this.options.abortSignal.removeEventListener('abort', onAbort)
      },
    })
    try {
      await this.options.runs.requestContinuation(
        this.options.runId,
        continuation,
        `runtime-continuation:${this.options.runRevision}:${this.options.attempt}:${continuation.continuationId}`,
        scope,
      )
    } catch (error) {
      const pending = this.pendingInformation.get(continuation.continuationId)
      this.pendingInformation.delete(continuation.continuationId)
      pending?.removeAbortListener()
      throw error
    }
    if (request.abortSignal?.aborted || this.options.abortSignal.aborted) onAbort()
    return response
  }

  async confirmPermission(
    _kind: GateKind,
    _message: string,
    _context: GateContext | undefined,
    permission: {
      request: PermissionRequest
      decision: PermissionDecision
      approval: ApprovalRequest
      actionBinding?: ActionBinding
    },
  ): Promise<GateDecision> {
    const scope = scoped(this.options.ownerScope)
    const current = await this.options.runs.get(this.options.runId, scope)
    if (!current
      || current.runRevision !== this.options.runRevision
      || current.attempt !== this.options.attempt
      || current.state !== 'running') {
      return 'takeover'
    }
    const expiresAt = permission.actionBinding?.expiresAt
      ?? new Date(Date.now() + (this.options.approvalTtlMs ?? 15 * 60_000)).toISOString()
    const actionBinding = permission.actionBinding ?? fallbackActionBinding(
      this.options,
      permission.request,
      expiresAt,
    )
    const requestedAt = new Date().toISOString()
    await this.options.approvals.enqueue({
      approvalId: permission.approval.approvalId,
      runId: this.options.runId,
      runRevision: this.options.runRevision,
      attempt: this.options.attempt,
      status: 'pending',
      actionBinding,
      allowedDecisions: ['approved', 'denied'],
      ...(this.options.ownerScope ? { ownerScope: this.options.ownerScope } : {}),
      sessionRef: {
        schemaVersion: 'session-ref/v1',
        provider: 'file-session-store',
        id: this.options.sessionId,
        runId: this.options.runId,
        attempt: this.options.attempt,
      },
      requestedAt,
      expiresAt,
    }, `runtime-approval:${this.options.runRevision}:${this.options.attempt}:${permission.approval.approvalId}`)
    await this.options.runs.setPendingApproval(
      this.options.runId,
      permission.approval.approvalId,
      true,
      `run-pending-approval:${this.options.runRevision}:${this.options.attempt}:${permission.approval.approvalId}`,
      scope,
    )
    await this.options.runs.transition(this.options.runId, {
      to: 'blocked_on_human',
      reason: permission.approval.message,
      idempotencyKey: `run-blocked-approval:${this.options.runRevision}:${this.options.attempt}:${permission.approval.approvalId}`,
      expectedRunRevision: this.options.runRevision,
      expectedAttempt: this.options.attempt,
      data: { approvalId: permission.approval.approvalId },
    }, scope)

    return new Promise<GateDecision>((resolve) => {
      const onAbort = () => {
        this.pending.delete(permission.approval.approvalId)
        resolve('takeover')
      }
      this.options.abortSignal.addEventListener('abort', onAbort, { once: true })
      this.pending.set(permission.approval.approvalId, {
        resolve,
        removeAbortListener: () => this.options.abortSignal.removeEventListener('abort', onAbort),
      })
      if (this.options.abortSignal.aborted) onAbort()
    })
  }

  async resolveLive(approvalId: string, decision: 'approved' | 'denied'): Promise<boolean> {
    const pending = this.pending.get(approvalId)
    if (!pending) return false
    const scope = scoped(this.options.ownerScope)
    const current = await this.options.runs.get(this.options.runId, scope)
    if (!current
      || current.state !== 'blocked_on_human'
      || current.runRevision !== this.options.runRevision
      || current.attempt !== this.options.attempt) {
      return false
    }
    await this.options.runs.setPendingApproval(
      this.options.runId,
      approvalId,
      false,
      `run-clear-approval:${this.options.runRevision}:${this.options.attempt}:${approvalId}`,
      scope,
    )
    const resuming = await this.options.runs.transition(this.options.runId, {
      to: 'resuming',
      idempotencyKey: `approval-resuming:${this.options.runRevision}:${this.options.attempt}:${approvalId}`,
      expectedRunRevision: this.options.runRevision,
      expectedAttempt: this.options.attempt,
      data: { approvalId, decision },
    }, scope)
    await this.options.runs.transition(this.options.runId, {
      to: 'running',
      idempotencyKey: `approval-running:${this.options.runRevision}:${this.options.attempt}:${approvalId}`,
      expectedRecordRevision: resuming.recordRevision,
      expectedRunRevision: this.options.runRevision,
      expectedAttempt: this.options.attempt,
      data: { approvalId, decision },
    }, scope)
    this.pending.delete(approvalId)
    pending.removeAbortListener()
    pending.resolve(decision === 'approved' ? 'approve' : 'decline')
    return true
  }

  async resolveInformationLive(continuationId: string): Promise<boolean> {
    const pending = this.pendingInformation.get(continuationId)
    if (!pending) return false
    const scope = scoped(this.options.ownerScope)
    const current = await this.options.runs.get(this.options.runId, scope)
    const continuation = current?.pendingContinuation
    if (!current
      || current.state !== 'blocked_on_human'
      || current.runRevision !== this.options.runRevision
      || current.attempt !== this.options.attempt
      || !continuation
      || continuation.continuationId !== continuationId
      || continuation.status !== 'answered'
      || !continuation.answer) {
      return false
    }
    await this.options.runs.continueAnsweredContinuationLive(
      this.options.runId,
      continuationId,
      scope,
    )
    this.pendingInformation.delete(continuationId)
    pending.removeAbortListener()
    pending.resolve({
      answer: continuation.answer.answer,
      ...(continuation.answer.intentPatch
        ? { intentPatch: continuation.answer.intentPatch }
        : {}),
    })
    return true
  }
}

function scoped(ownerScope?: OwnerScope): { ownerScope: OwnerScope } | undefined {
  return ownerScope ? { ownerScope } : undefined
}

function fallbackActionBinding(
  options: DurableHumanGateOptions,
  request: PermissionRequest,
  expiresAt: string,
): ActionBinding {
  const toolName = request.subject.kind === 'tool_call'
    ? request.subject.toolName
    : `workflow_${request.subject.handoffKind}`
  const actionId = request.subject.kind === 'tool_call'
    ? request.subject.toolCallId
    : request.requestId
  const origin = urlOrigin(request.currentUrl)
  return {
    schemaVersion: 'action-binding/v1',
    contractId: options.taskContract.contractId,
    contractRevision: options.taskContract.revision,
    runId: options.runId,
    sessionRef: {
      schemaVersion: 'session-ref/v1',
      provider: 'file-session-store',
      id: options.sessionId,
      runId: options.runId,
      attempt: options.attempt,
    },
    actionId,
    toolName,
    argsSha256: digestCanonicalJson(request.subject.kind === 'tool_call' ? request.subject.args : {}),
    sourceContentIds: [],
    sourceSensitiveClasses: [],
    ...(origin ? { sourceOrigin: origin, destinationOrigin: origin } : {}),
    actionSeq: request.step,
    expiresAt,
  }
}

function urlOrigin(value?: string): string | undefined {
  if (!value) return undefined
  try { return new URL(value).origin } catch { return undefined }
}
