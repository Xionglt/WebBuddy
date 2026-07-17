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
  digestCanonicalJson,
  type ActionBinding,
  type TaskContract,
} from '../task/contracts.js'
import type { ApprovalService, RunService } from './run-service.js'

interface PendingGate {
  resolve: (decision: GateDecision) => void
  removeAbortListener: () => void
}

export interface DurableHumanGateOptions {
  runs: RunService
  approvals: ApprovalService
  runId: string
  runRevision: number
  attempt: number
  taskContract: TaskContract
  sessionId: string
  abortSignal: AbortSignal
  approvalTtlMs?: number
}

/**
 * Bridges AgentLoop human gates to the durable ApprovalStore. API resolution
 * resumes the live turn only after exact durable binding validation succeeds.
 */
export class DurableHumanGate implements HumanGate {
  private readonly pending = new Map<string, PendingGate>()

  constructor(readonly options: DurableHumanGateOptions) {}

  async confirm(): Promise<GateDecision> {
    return 'takeover'
  }

  async requestInfo(_request: HumanInfoRequest): Promise<HumanInfoResponse> {
    return { answer: '' }
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
    const current = await this.options.runs.get(this.options.runId)
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
    )
    await this.options.runs.transition(this.options.runId, {
      to: 'blocked_on_human',
      reason: permission.approval.message,
      idempotencyKey: `run-blocked-approval:${this.options.runRevision}:${this.options.attempt}:${permission.approval.approvalId}`,
      expectedRunRevision: this.options.runRevision,
      expectedAttempt: this.options.attempt,
      data: { approvalId: permission.approval.approvalId },
    })

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
    const current = await this.options.runs.get(this.options.runId)
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
    )
    const resuming = await this.options.runs.transition(this.options.runId, {
      to: 'resuming',
      idempotencyKey: `approval-resuming:${this.options.runRevision}:${this.options.attempt}:${approvalId}`,
      expectedRunRevision: this.options.runRevision,
      expectedAttempt: this.options.attempt,
      data: { approvalId, decision },
    })
    await this.options.runs.transition(this.options.runId, {
      to: 'running',
      idempotencyKey: `approval-running:${this.options.runRevision}:${this.options.attempt}:${approvalId}`,
      expectedRecordRevision: resuming.recordRevision,
      expectedRunRevision: this.options.runRevision,
      expectedAttempt: this.options.attempt,
      data: { approvalId, decision },
    })
    this.pending.delete(approvalId)
    pending.removeAbortListener()
    pending.resolve(decision === 'approved' ? 'approve' : 'decline')
    return true
  }
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
