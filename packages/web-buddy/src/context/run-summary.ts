import type {
  ApprovalResolutionSource,
  ApprovalStatus,
  PermissionAction,
  PermissionDecisionSource,
  PermissionRememberScope,
} from '../permission/permission-types.js'
import type { ChatMessage } from '../sdk/llm.js'
import type { GateDecision, GateKind } from '../sdk/human.js'
import type { RiskLevel } from '../sdk/trace.js'
import type { EvidenceKind } from '../workflow/workflow-evidence.js'
import type { WorkflowConfidence, WorkflowPhase } from '../workflow/workflow-state.js'
import type { PageFacts } from '../observation/page-facts.js'
import type { PageType } from '../observation/page-state.js'
import type { RecentActionStatus } from './types.js'

export const COMPACTED_RUN_CONTEXT_PREFIX = 'COMPACTED_RUN_CONTEXT'

export type CompactTrigger =
  | 'token_threshold'
  | 'tool_result_pressure'
  | 'phase_transition'
  | 'failure_repetition'
  | 'resume'

export type CompactMode =
  | 'structured'
  | 'structured_semantic'

export interface CompactRunSummary {
  schemaVersion: 'compact-run-summary/v1'
  summaryId: string
  sessionId: string
  runId: string
  turnId?: string
  step: number
  createdAt: string

  goal: string
  trigger?: CompactTrigger
  compactMode?: CompactMode
  workflow?: CompactWorkflowSummary
  page?: CompactPageSummary
  form?: CompactFormSummary
  evidence?: CompactEvidenceSummary
  completion?: CompactCompletionSummary
  permissionContract?: CompactPermissionContract
  answerMemory?: CompactAnswerMemorySummary
  failurePatterns?: CompactFailurePattern[]
  staleRefs?: CompactStaleRefSummary
  semanticSummary?: SemanticCompactSummary
  recentActions: CompactRecentActionSummary[]
  blockers: string[]
  permissions: CompactPermissionSummary[]
  approvals: CompactApprovalSummary[]
  safetyNotes: string[]
  nextActionHints: string[]
  source: CompactRunSummarySource
}

export interface SemanticCompactSummary {
  schemaVersion: 'semantic-compact-summary/v1'
  userIntent: string
  importantDecisions: string[]
  attemptedPaths: CompactAttemptedPath[]
  unresolvedQuestions: string[]
  nextStrategy: string[]
  riskNotes: string[]
  generatedAt: string
  sourceMessageCount: number
  fallback?: boolean
  error?: string
}

export interface CompactAttemptedPath {
  action: string
  result: string
  reason?: string
  shouldAvoidRetry?: boolean
}

export interface CompactPermissionContract {
  rule: 'structured_permissions_are_source_of_truth'
  finalSubmitRequiresExplicitApproval: boolean
  approvalsRetained: number
  permissionsRetained: number
  notes: string[]
}

export interface CompactAnswerMemorySummary {
  source: 'answer_store_summary'
  summary: string
}

export interface CompactFailurePattern {
  toolName: string
  status: string
  observation: string
  count: number
  lastStep: number
  shouldAvoidRetry: boolean
}

export interface CompactStaleRefSummary {
  rule: 'old_browser_refs_are_not_actionable'
  latestPageStateUpdatedAt?: string
  latestFormStateUpdatedAt?: string
  notes: string[]
}

export interface CompactWorkflowSummary {
  phase: WorkflowPhase | string
  confidence?: WorkflowConfidence | string
  reason?: string
  blocker?: string
  humanHandoffRequired?: boolean
  updatedAt?: string
}

export interface CompactEvidenceSummary {
  total: number
  countsByKind: Record<string, number>
  recentKeyEvidence: CompactWorkflowEvidenceSummary[]
}

export interface CompactWorkflowEvidenceSummary {
  id: string
  kind: EvidenceKind | string
  summary: string
  source: string
  confidence: WorkflowConfidence | string
  phase?: WorkflowPhase | string
  ts: string
  runId?: string
  turnId?: string
  toolCallId?: string
}

export interface CompactCompletionSummary {
  finalSubmitBlocker?: string
  missingCriteria: CompactCompletionCriterionSummary[]
  humanHandoffReason?: string
  completionCriteria?: CompactCompletionCriterionSummary[]
  satisfiedCriteria?: CompactCompletionCriterionSummary[]
  blocked?: boolean
  done?: boolean
  reason?: string
  evaluatedAt?: string
}

export interface CompactCompletionCriterionSummary {
  id?: string
  description: string
  reason?: string
  status?: string
  required?: boolean
  evidenceKinds?: string[]
}

export interface CompactPageSummary {
  url?: string
  title?: string
  pageType?: PageType | string
  textSummary?: string
  interactiveCount?: number
  formCount?: number
  linkCount?: number
  buttonCount?: number
  inputCount?: number
  facts?: PageFacts
  updatedAt?: string
}

export interface CompactFormSummary {
  fieldCount: number
  missingRequiredCount: number
  filledFieldCount: number
  submitCandidateCount: number
  uploadHintCount: number
  missingRequiredLabels: string[]
  filledFieldLabels: string[]
  submitCandidates: CompactSubmitCandidateSummary[]
  uploadHints: CompactUploadHintSummary[]
  visibleErrors: string[]
  facts?: PageFacts
  updatedAt?: string
}

export interface CompactSubmitCandidateSummary {
  text: string
  tag?: string
  type?: string
  role?: string
  risk?: RiskLevel
  visible?: boolean
}

export interface CompactUploadHintSummary {
  text: string
  tag?: string
  type?: string
  accept?: string
  visible?: boolean
}

export interface CompactRecentActionSummary {
  step: number
  toolName: string
  argumentsSummary: string
  status: RecentActionStatus | string
  risk?: RiskLevel
  observation?: string
  at: string
}

export interface CompactPermissionSummary {
  requestId?: string
  toolCallId?: string
  toolName?: string
  subjectKind?: string
  handoffKind?: Extract<GateKind, 'login' | 'captcha'> | string
  argumentsSummary?: string
  action?: PermissionAction
  source?: PermissionDecisionSource
  policyAction?: string
  risk?: RiskLevel
  riskLevel?: string
  gateKind?: GateKind | string
  workflowPhase?: WorkflowPhase | string
  policyCode?: string
  ruleId?: string
  policyRuleId?: string
  reason?: string
  requestedAt?: string
  decidedAt?: string
  requiresFreshContext?: boolean
  rememberable?: boolean
  rememberDefaultScope?: PermissionRememberScope
  auditTags: string[]
}

export interface CompactApprovalSummary {
  approvalId: string
  permissionRequestId?: string
  toolCallId?: string
  status: ApprovalStatus
  gateKind?: GateKind | string
  risk?: RiskLevel
  riskLevel?: string
  title?: string
  reason?: string
  decision?: GateDecision
  resolutionSource?: ApprovalResolutionSource
  resolutionReason?: string
  createdAt: string
  updatedAt?: string
  resolvedAt?: string
}

export interface CompactRunSummarySource {
  inputMessageCount: number
  latestContextUpdatedAt?: string
  pageStateUpdatedAt?: string
  formStateUpdatedAt?: string
}

export interface ContextCompactionStats {
  inputMessageCount: number
  compactedMessageChars: number
  estimatedInputTokensBefore: number
  estimatedInputTokensAfter: number
  retainedRecentActionCount: number
  retainedPermissionCount: number
  retainedApprovalCount: number
  semanticSummaryChars?: number
  semanticFallback?: boolean
}

export interface ContextCompactionResult {
  schemaVersion: 'context-compaction-result/v1'
  summary: CompactRunSummary
  compactedMessage: ChatMessage
  stats: ContextCompactionStats
}
