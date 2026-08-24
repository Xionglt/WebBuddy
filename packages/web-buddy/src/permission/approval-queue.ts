import { GATE_LABELS, type GateDecision } from '../sdk/human.js'
import type {
  ApprovalEnqueueInput,
  ApprovalQueueEvent,
  ApprovalQueueSnapshot,
  ApprovalRequest,
  ApprovalResolution,
  ApprovalResolvedStatus,
  ApprovalResolveDecision,
  ApprovalResolvePatch,
  ApprovalResolveResult,
  ApprovalResolutionSource,
  ApprovalStatus,
} from './permission-types.js'

export type { ApprovalQueueEvent, ApprovalQueueSnapshot } from './permission-types.js'

export type ApprovalQueueErrorCode =
  | 'duplicate_approval'
  | 'unknown_approval'
  | 'approval_not_pending'
  | 'invalid_resolution'

export class ApprovalQueueError extends Error {
  constructor(
    readonly code: ApprovalQueueErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'ApprovalQueueError'
  }
}

export interface ApprovalQueueOptions {
  now?: () => Date
}

export class ApprovalQueue {
  private readonly approvals = new Map<string, ApprovalRequest>()
  private readonly listeners = new Set<(event: ApprovalQueueEvent) => void>()
  private sequence = 0

  constructor(private readonly options: ApprovalQueueOptions = {}) {}

  enqueue(request: ApprovalEnqueueInput | ApprovalRequest): ApprovalRequest {
    const id = request.approvalId ?? request.id ?? this.createApprovalId(request)
    const existing = this.approvals.get(id)
    if (existing) return cloneApproval(existing)

    const fullRequest = isApprovalRequest(request)
    const createdAt = request.createdAt ?? this.now()
    const approval: ApprovalRequest = {
      schemaVersion: 'approval-request/v1',
      id,
      approvalId: id,
      status: 'pending',
      runId: request.runId,
      sessionId: request.sessionId,
      ...(request.turnId ? { turnId: request.turnId } : {}),
      ...(request.toolCallId ? { toolCallId: request.toolCallId } : {}),
      ...(request.permissionRequestId ? { permissionRequestId: request.permissionRequestId } : {}),
      reason: request.reason,
      kind: (fullRequest ? request.kind : undefined) ?? request.gateKind,
      gateKind: request.gateKind,
      ...(request.risk ? { risk: request.risk } : {}),
      ...(request.riskLevel ? { riskLevel: request.riskLevel } : {}),
      title: request.title ?? `Approval required: ${GATE_LABELS[request.gateKind]}`,
      message: request.message ?? request.reason,
      ...(request.context ? { context: { ...request.context } } : {}),
      allowedDecisions: [...(request.allowedDecisions ?? ['approve', 'decline', 'takeover'])],
      createdAt,
      updatedAt: (fullRequest ? request.updatedAt : undefined) ?? createdAt,
      ...(request.expiresAt ? { expiresAt: request.expiresAt } : {}),
      ...(request.metadata ? { metadata: { ...request.metadata } } : {}),
    }

    this.approvals.set(id, approval)
    this.emit({ type: 'approval_enqueued', approval: cloneApproval(approval) })
    return cloneApproval(approval)
  }

  resolve(
    approvalId: string,
    result: ApprovalResolveResult | ApprovalResolveDecision,
    patch: Omit<ApprovalResolvePatch, 'status' | 'decision'> = {},
  ): ApprovalRequest {
    const current = this.mustGet(approvalId)
    if (current.status !== 'pending') {
      throw new ApprovalQueueError('approval_not_pending', `Approval is already ${current.status}: ${approvalId}`)
    }

    const resolutionPatch = { ...normalizeResolveResult(result), ...patch }
    const status = resolutionPatch.status ?? statusForDecision(resolutionPatch.decision)
    if (!status) {
      throw new ApprovalQueueError(
        'invalid_resolution',
        `Approval resolution requires a terminal status or gate decision: ${approvalId}`,
      )
    }

    const resolvedAt = resolutionPatch.resolvedAt ?? this.now()
    const decision = normalizeDecision(resolutionPatch.decision)
    const resolution: ApprovalResolution = {
      schemaVersion: 'approval-resolution/v1',
      id: approvalId,
      approvalId,
      ...(current.permissionRequestId ? { permissionRequestId: current.permissionRequestId } : {}),
      status,
      ...(decision ? { decision } : {}),
      source: resolutionPatch.source ?? defaultResolutionSource(status, decision),
      ...(resolutionPatch.reason ? { reason: resolutionPatch.reason } : {}),
      resolvedAt,
      decidedAt: resolvedAt,
      ...(resolutionPatch.data ? { data: { ...resolutionPatch.data } } : {}),
    }
    const resolved: ApprovalRequest = {
      ...current,
      status,
      updatedAt: resolvedAt,
      resolvedAt,
      resolution,
    }

    this.approvals.set(approvalId, resolved)
    this.emit({ type: 'approval_resolved', approval: cloneApproval(resolved), resolution: cloneResolution(resolution) })
    return cloneApproval(resolved)
  }

  cancel(approvalId: string, reason?: string): ApprovalRequest {
    const resolved = this.resolve(approvalId, { status: 'cancelled', source: 'system', reason })
    this.emit({ type: 'approval_cancelled', approval: cloneApproval(resolved), reason })
    return resolved
  }

  expire(approvalId: string, reason?: string): ApprovalRequest {
    return this.resolve(approvalId, { status: 'expired', source: 'timeout', reason })
  }

  get(approvalId: string): ApprovalRequest | undefined {
    const approval = this.approvals.get(approvalId)
    return approval ? cloneApproval(approval) : undefined
  }

  listPending(): ApprovalRequest[] {
    return this.listByStatus('pending')
  }

  listAll(): ApprovalRequest[] {
    return [...this.approvals.values()].map(cloneApproval)
  }

  snapshot(): ApprovalQueueSnapshot {
    const all = this.listAll()
    const pending = all.filter((approval) => approval.status === 'pending')
    const approved = all.filter((approval) => approval.status === 'approved')
    const denied = all.filter((approval) => approval.status === 'denied')
    const expired = all.filter((approval) => approval.status === 'expired')
    const cancelled = all.filter((approval) => approval.status === 'cancelled')

    return {
      version: 1,
      generatedAt: this.now(),
      pending,
      approved,
      denied,
      expired,
      cancelled,
      resolved: [...approved, ...denied, ...expired, ...cancelled],
      all,
    }
  }

  subscribe(listener: (event: ApprovalQueueEvent) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private mustGet(approvalId: string): ApprovalRequest {
    const approval = this.approvals.get(approvalId)
    if (!approval) throw new ApprovalQueueError('unknown_approval', `Approval not found: ${approvalId}`)
    return approval
  }

  private listByStatus(status: ApprovalStatus): ApprovalRequest[] {
    return [...this.approvals.values()]
      .filter((approval) => approval.status === status)
      .map(cloneApproval)
  }

  private now(): string {
    return (this.options.now?.() ?? new Date()).toISOString()
  }

  private createApprovalId(input: ApprovalEnqueueInput | ApprovalRequest): string {
    this.sequence += 1
    const hint = sanitizeId(input.toolCallId ?? input.turnId ?? input.sessionId)
    return `appr_${hint}_${String(this.sequence).padStart(4, '0')}`
  }

  private emit(event: ApprovalQueueEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(cloneEvent(event))
      } catch {
        // Approval state is authoritative; subscriber failures must not corrupt it.
      }
    }
  }
}

function isApprovalRequest(input: ApprovalEnqueueInput | ApprovalRequest): input is ApprovalRequest {
  return 'schemaVersion' in input && input.schemaVersion === 'approval-request/v1'
}

function normalizeResolveResult(result: ApprovalResolveResult | ApprovalResolveDecision): ApprovalResolvePatch {
  if (typeof result === 'string') {
    if (isResolvedStatus(result)) return { status: result }
    if (isDecision(result)) return { decision: normalizeDecision(result) }
  } else {
    return result
  }
  throw new ApprovalQueueError('invalid_resolution', `Unsupported approval resolution: ${String(result)}`)
}

function isResolvedStatus(value: string): value is ApprovalResolvedStatus {
  return value === 'approved' || value === 'denied' || value === 'expired' || value === 'cancelled'
}

function isDecision(value: string): value is ApprovalResolveDecision {
  return value === 'approve' || value === 'decline' || value === 'takeover' || value === 'deny'
}

function normalizeDecision(decision: ApprovalResolveDecision | undefined): GateDecision | undefined {
  if (decision === 'deny') return 'decline'
  return decision
}

function statusForDecision(decision: ApprovalResolveDecision | undefined): ApprovalResolvedStatus | undefined {
  if (decision === 'approve') return 'approved'
  if (decision === 'decline' || decision === 'deny') return 'denied'
  if (decision === 'takeover') return 'cancelled'
  return undefined
}

function defaultResolutionSource(status: ApprovalResolvedStatus, decision: GateDecision | undefined): ApprovalResolutionSource {
  if (decision) return 'human_gate'
  if (status === 'expired') return 'timeout'
  return 'system'
}

function sanitizeId(value: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '')
  return sanitized || 'approval'
}

function cloneEvent(event: ApprovalQueueEvent): ApprovalQueueEvent {
  if (event.type === 'approval_enqueued') {
    return { type: event.type, approval: cloneApproval(event.approval) }
  }
  if (event.type === 'approval_cancelled') {
    return { type: event.type, approval: cloneApproval(event.approval), ...(event.reason ? { reason: event.reason } : {}) }
  }
  return {
    type: event.type,
    approval: cloneApproval(event.approval),
    resolution: cloneResolution(event.resolution),
  }
}

function cloneApproval(approval: ApprovalRequest): ApprovalRequest {
  return {
    ...approval,
    ...(approval.context ? { context: { ...approval.context } } : {}),
    allowedDecisions: [...approval.allowedDecisions],
    ...(approval.resolution ? { resolution: cloneResolution(approval.resolution) } : {}),
    ...(approval.metadata ? { metadata: { ...approval.metadata } } : {}),
  }
}

function cloneResolution(resolution: ApprovalResolution): ApprovalResolution {
  return {
    ...resolution,
    ...(resolution.data ? { data: { ...resolution.data } } : {}),
  }
}
