import type { GateContext, GateDecision, GateKind } from '../sdk/human.js'
import type { RiskLevel } from '../sdk/trace.js'
import type { PolicyEngineDecision, PolicyRiskLevel } from '../policy/agent-policy.js'
import type { ToolCall } from '../tools/tool-contract.js'
import type { ToolCategory } from '../tools/types.js'
import type { WorkflowPhase, WorkflowState } from '../workflow/workflow-state.js'

export type PermissionAction = 'allow' | 'ask' | 'deny'
export const PERMISSION_MODES = ['safe', 'review', 'trusted', 'autopilot'] as const
export type PermissionMode = (typeof PERMISSION_MODES)[number]

export interface PermissionModeConfig {
  mode: PermissionMode
  allowFinalSubmit: boolean
}

export type PermissionDecisionSource =
  | 'policy'
  | 'default_rule'
  | 'runtime_rule'
  | 'session_rule'
  | 'config_rule'
  | 'user'

export type PermissionRememberScope = 'once' | 'session' | 'always'

export interface PermissionRememberPolicy {
  supportedScopes: PermissionRememberScope[]
  defaultScope: PermissionRememberScope
}

export type PermissionSubject =
  | {
      kind: 'tool_call'
      toolCallId: string
      toolName: string
      args: Record<string, unknown>
      argBrief?: string
      toolCategory?: ToolCategory | string
    }
  | {
      kind: 'workflow_handoff'
      handoffKind: Extract<GateKind, 'login' | 'captcha'>
      reason: string
    }

export interface PermissionRequestPolicy {
  schemaVersion: PolicyEngineDecision['schemaVersion']
  action: PolicyEngineDecision['action']
  policyCode: string
  ruleId: string
  reason: string
  auditTags: string[]
  requiresFreshContext?: boolean
}

export interface PermissionRequest {
  schemaVersion: 'permission-request/v1'
  requestId: string
  runId: string
  sessionId: string
  turnId?: string
  step: number
  requestedAt: string
  subject: PermissionSubject
  risk?: RiskLevel
  riskLevel: PolicyRiskLevel
  currentUrl?: string
  workflowPhase?: WorkflowPhase
  gateKind?: GateKind
  policy: PermissionRequestPolicy
  context?: {
    refLabel?: string
    freshness?: unknown
  }
}

export interface PermissionDecision {
  schemaVersion: 'permission-decision/v1'
  requestId: string
  action: PermissionAction
  source: PermissionDecisionSource
  ruleId: string
  policyCode?: string
  policyRuleId?: string
  risk?: RiskLevel
  riskLevel: PolicyRiskLevel
  permissionMode: PermissionMode
  reason: string
  decidedAt: string
  gateKind?: GateKind
  requiresFreshContext?: boolean
  rememberable: boolean
  remember: PermissionRememberPolicy
  auditTags: string[]
}

export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired' | 'cancelled'
export type ApprovalRequestStatus = ApprovalStatus
export type ApprovalResolvedStatus = Exclude<ApprovalStatus, 'pending'>
export type ApprovalResolveDecision = GateDecision | 'deny'

export type ApprovalResolutionSource =
  | 'user'
  | 'human_gate'
  | 'auto_gate'
  | 'scripted_gate'
  | 'system'
  | 'timeout'

export interface ApprovalRequestContext extends GateContext {
  toolName?: string
  argBrief?: string
  policyCode?: string
  ruleId?: string
  workflowPhase?: string
  permissionReason?: string
  [key: string]: unknown
}

export interface ApprovalResolution {
  schemaVersion: 'approval-resolution/v1'
  id: string
  approvalId: string
  permissionRequestId?: string
  status: ApprovalResolvedStatus
  decision?: GateDecision
  source: ApprovalResolutionSource
  reason?: string
  resolvedAt: string
  decidedAt?: string
  data?: Record<string, unknown>
}

export interface ApprovalRequest {
  schemaVersion: 'approval-request/v1'
  id: string
  approvalId: string
  permissionRequestId?: string
  runId: string
  sessionId: string
  turnId?: string
  toolCallId?: string
  status: ApprovalStatus
  kind?: GateKind
  gateKind: GateKind
  risk?: RiskLevel
  riskLevel?: PolicyRiskLevel
  title: string
  message: string
  reason: string
  context?: ApprovalRequestContext
  allowedDecisions: GateDecision[]
  createdAt: string
  updatedAt: string
  resolvedAt?: string
  expiresAt?: string
  resolution?: ApprovalResolution
  metadata?: Record<string, unknown>
}

export interface ApprovalEnqueueInput {
  id?: string
  approvalId?: string
  runId: string
  sessionId: string
  turnId?: string
  toolCallId?: string
  permissionRequestId?: string
  reason: string
  gateKind: GateKind
  risk?: RiskLevel
  riskLevel?: PolicyRiskLevel
  title?: string
  message?: string
  context?: ApprovalRequestContext
  allowedDecisions?: GateDecision[]
  createdAt?: string
  expiresAt?: string
  metadata?: Record<string, unknown>
}

export interface ApprovalResolvePatch {
  status?: ApprovalResolvedStatus
  decision?: GateDecision
  source?: ApprovalResolutionSource
  reason?: string
  resolvedAt?: string
  data?: Record<string, unknown>
}

export type ApprovalResolveResult = ApprovalResolvedStatus | GateDecision | ApprovalResolvePatch

export interface ApprovalQueueSnapshot {
  version: 1
  generatedAt: string
  pending: ApprovalRequest[]
  approved: ApprovalRequest[]
  denied: ApprovalRequest[]
  expired: ApprovalRequest[]
  cancelled: ApprovalRequest[]
  resolved: ApprovalRequest[]
  all: ApprovalRequest[]
}

export type ApprovalQueueEvent =
  | { type: 'approval_enqueued'; approval: ApprovalRequest }
  | { type: 'approval_resolved'; approval: ApprovalRequest; resolution: ApprovalResolution }
  | { type: 'approval_cancelled'; approval: ApprovalRequest; reason?: string }

export interface CreateToolPermissionRequestInput {
  call: ToolCall
  policyDecision: PolicyEngineDecision
  risk?: RiskLevel
  currentUrl?: string
  workflowState?: WorkflowState
  workflowPhase?: WorkflowPhase
  runId: string
  sessionId: string
  turnId?: string
  step: number
  argBrief?: string
  toolCategory?: ToolCategory | string
  refLabel?: string
  freshness?: unknown
  requestId?: string
  now?: () => Date
}

export interface CreateWorkflowHandoffPermissionRequestInput {
  handoffKind: Extract<GateKind, 'login' | 'captcha'>
  reason: string
  runId: string
  sessionId: string
  turnId?: string
  step: number
  workflowState: WorkflowState
  currentUrl?: string
  requestId?: string
  now?: () => Date
}

export function isPermissionMode(value: unknown): value is PermissionMode {
  return typeof value === 'string' && (PERMISSION_MODES as readonly string[]).includes(value)
}

export function createToolPermissionRequest(input: CreateToolPermissionRequestInput): PermissionRequest {
  const workflowPhase = input.workflowPhase ?? input.policyDecision.workflowPhase ?? input.workflowState?.phase
  return {
    schemaVersion: 'permission-request/v1',
    requestId: input.requestId ?? permissionRequestIdFor(input.turnId, input.call.id),
    runId: input.runId,
    sessionId: input.sessionId,
    ...(input.turnId ? { turnId: input.turnId } : {}),
    step: input.step,
    requestedAt: isoNow(input.now),
    subject: {
      kind: 'tool_call',
      toolCallId: input.call.id,
      toolName: input.call.name,
      args: input.call.arguments,
      ...(input.argBrief ? { argBrief: input.argBrief } : {}),
      ...(input.toolCategory ? { toolCategory: input.toolCategory } : {}),
    },
    ...(input.risk ? { risk: input.risk } : {}),
    riskLevel: input.policyDecision.riskLevel,
    ...(input.currentUrl ? { currentUrl: input.currentUrl } : {}),
    ...(workflowPhase ? { workflowPhase } : {}),
    ...(input.policyDecision.gateKind ? { gateKind: input.policyDecision.gateKind } : {}),
    policy: {
      schemaVersion: input.policyDecision.schemaVersion,
      action: input.policyDecision.action,
      policyCode: input.policyDecision.policyCode,
      ruleId: input.policyDecision.ruleId,
      reason: input.policyDecision.reason,
      auditTags: input.policyDecision.auditTags,
      ...(input.policyDecision.requiresFreshContext ? { requiresFreshContext: true } : {}),
    },
    ...(input.refLabel !== undefined || input.freshness !== undefined
      ? {
          context: {
            ...(input.refLabel !== undefined ? { refLabel: input.refLabel } : {}),
            ...(input.freshness !== undefined ? { freshness: input.freshness } : {}),
          },
        }
      : {}),
  }
}

export function createWorkflowHandoffPermissionRequest(
  input: CreateWorkflowHandoffPermissionRequestInput,
): PermissionRequest {
  const policyCode = `policy.workflow.${input.handoffKind}_required`
  const ruleId = `${policyCode}.v1`
  return {
    schemaVersion: 'permission-request/v1',
    requestId: input.requestId ?? permissionRequestIdFor(input.turnId, `workflow_${input.handoffKind}`),
    runId: input.runId,
    sessionId: input.sessionId,
    ...(input.turnId ? { turnId: input.turnId } : {}),
    step: input.step,
    requestedAt: isoNow(input.now),
    subject: {
      kind: 'workflow_handoff',
      handoffKind: input.handoffKind,
      reason: input.reason,
    },
    riskLevel: 'high',
    ...(input.currentUrl ? { currentUrl: input.currentUrl } : {}),
    workflowPhase: input.workflowState.phase,
    gateKind: input.handoffKind,
    policy: {
      schemaVersion: 'policy-decision/v1',
      action: 'gate',
      policyCode,
      ruleId,
      reason: input.reason,
      auditTags: [
        'action:gate',
        'risk:high',
        'workflow',
        `${input.handoffKind}_required`,
        'human_handoff',
        `gate:${input.handoffKind}`,
      ],
    },
  }
}

function permissionRequestIdFor(turnId: string | undefined, suffix: string): string {
  return `perm_${safeIdPart(turnId ?? 'unknown_turn')}_${safeIdPart(suffix)}`
}

function safeIdPart(value: string): string {
  const normalized = value.replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '')
  return normalized || 'unknown'
}

function isoNow(now: (() => Date) | undefined): string {
  return (now?.() ?? new Date()).toISOString()
}
