import type {
  ApprovalRequest,
  PermissionDecision,
  PermissionRequest,
} from '../permission/permission-types.js'
import type { FormFieldState } from '../observation/form-state.js'
import type { ChatMessage } from '../sdk/llm.js'
import type { EvidenceStoreSnapshot, WorkflowEvidence } from '../workflow/workflow-evidence.js'
import type { WorkflowState } from '../workflow/workflow-state.js'
import { oneLine, truncateText } from './budget.js'
import type { ContextRecentAction, ContextSnapshot } from './types.js'
import {
  COMPACTED_RUN_CONTEXT_PREFIX,
  type CompactApprovalSummary,
  type CompactCompletionCriterionSummary,
  type CompactCompletionSummary,
  type CompactEvidenceSummary,
  type CompactFormSummary,
  type CompactPageSummary,
  type CompactPermissionSummary,
  type CompactRecentActionSummary,
  type CompactRunSummary,
  type CompactSubmitCandidateSummary,
  type CompactUploadHintSummary,
  type CompactWorkflowSummary,
  type ContextCompactionResult,
} from './run-summary.js'

export type ContextCompactionEvidenceInput = WorkflowEvidence[] | EvidenceStoreSnapshot

export type ContextCompactionCriterionInput = string | {
  id?: string
  description?: string
  criterion?: string
  reason?: string
  status?: string
  required?: boolean
  evidenceKinds?: string[]
}

export interface ContextCompactionWorkflowEvaluation {
  finalSubmitBlocker?: string
  blocker?: string
  missingCriteria?: ContextCompactionCriterionInput[]
  missingCompletionCriteria?: ContextCompactionCriterionInput[]
  humanHandoffReason?: string
  handoffReason?: string
  completionCriteria?: ContextCompactionCriterionInput[]
  satisfiedCriteria?: ContextCompactionCriterionInput[]
  blocked?: boolean
  done?: boolean
  reason?: string
  evaluatedAt?: string
}

export interface ContextCompactionInput {
  sessionId: string
  runId: string
  turnId?: string
  step: number
  goal?: string
  messages?: ChatMessage[]
  latestContext?: ContextSnapshot
  workflowState?: WorkflowState
  recentActions?: ContextRecentAction[]
  blockers?: string[]
  permissionRequests?: PermissionRequest[]
  permissionDecisions?: PermissionDecision[]
  permissions?: PermissionDecision[]
  approvals?: ApprovalRequest[]
  evidence?: ContextCompactionEvidenceInput
  workflowEvaluation?: ContextCompactionWorkflowEvaluation
  safetyNotes?: string[]
  nextActionHints?: string[]
  summaryId?: string
  createdAt?: string
}

export interface ContextCompactorOptions {
  maxRecentActions?: number
  maxPermissions?: number
  maxApprovals?: number
  maxEvidenceItems?: number
  maxCompletionCriteria?: number
  maxBlockers?: number
  maxSafetyNotes?: number
  maxNextActionHints?: number
  maxPageTextSummaryChars?: number
  maxActionObservationChars?: number
  maxReasonChars?: number
  now?: () => Date
}

const DEFAULT_MAX_RECENT_ACTIONS = 12
const DEFAULT_MAX_PERMISSIONS = 12
const DEFAULT_MAX_APPROVALS = 12
const DEFAULT_MAX_EVIDENCE_ITEMS = 8
const DEFAULT_MAX_COMPLETION_CRITERIA = 12
const DEFAULT_MAX_BLOCKERS = 12
const DEFAULT_MAX_SAFETY_NOTES = 12
const DEFAULT_MAX_NEXT_ACTION_HINTS = 8
const DEFAULT_MAX_PAGE_TEXT_SUMMARY_CHARS = 700
const DEFAULT_MAX_ACTION_OBSERVATION_CHARS = 260
const DEFAULT_MAX_REASON_CHARS = 260

export class ContextCompactor {
  constructor(private readonly options: ContextCompactorOptions = {}) {}

  compact(input: ContextCompactionInput): ContextCompactionResult {
    const latestContext = input.latestContext
    const createdAt = input.createdAt ?? this.now().toISOString()
    const workflowState = input.workflowState ?? latestContext?.workflowState
    const workflow = summarizeWorkflow(workflowState, this.reasonMaxChars)
    const page = summarizePage(latestContext, this.options.maxPageTextSummaryChars ?? DEFAULT_MAX_PAGE_TEXT_SUMMARY_CHARS)
    const form = summarizeForm(latestContext)
    const evidence = summarizeEvidence(input.evidence, this.maxEvidenceItems, this.reasonMaxChars)
    const completion = summarizeCompletion(input.workflowEvaluation, this.maxCompletionCriteria, this.reasonMaxChars)
    const blockers = trimStringList(uniqueStrings([
      ...(input.blockers ?? []),
      completion?.finalSubmitBlocker,
      completion?.humanHandoffReason,
      workflow?.blocker,
      ...(latestContext?.blockers ?? []),
      ...(latestContext?.taskState?.knownBlockers ?? []),
    ]), this.maxBlockers, this.reasonMaxChars)
    const safetyNotes = trimStringList(uniqueStrings([
      ...(input.safetyNotes ?? []),
      ...(latestContext?.safetyNotes ?? []),
    ]), this.maxSafetyNotes, this.reasonMaxChars)
    const recentActions = summarizeRecentActions(
      input.recentActions ?? latestContext?.recentActions ?? [],
      this.maxRecentActions,
      this.options.maxActionObservationChars ?? DEFAULT_MAX_ACTION_OBSERVATION_CHARS,
    )
    const permissions = summarizePermissions(
      input.permissionRequests ?? [],
      uniquePermissionDecisions([...(input.permissionDecisions ?? []), ...(input.permissions ?? [])]),
      this.maxPermissions,
      this.reasonMaxChars,
    )
    const approvals = summarizeApprovals(input.approvals ?? [], this.maxApprovals, this.reasonMaxChars)
    const nextActionHints = trimStringList(uniqueStrings([
      ...buildDefaultNextActionHints({ workflow, page, form, blockers, latestContext }),
      ...buildCompletionNextActionHints(completion),
      ...(input.nextActionHints ?? []),
    ]), this.maxNextActionHints, this.reasonMaxChars)

    const summary: CompactRunSummary = {
      schemaVersion: 'compact-run-summary/v1',
      summaryId: input.summaryId ?? createSummaryId({
        sessionId: input.sessionId,
        runId: input.runId,
        turnId: input.turnId,
        step: input.step,
        createdAt,
      }),
      sessionId: input.sessionId,
      runId: input.runId,
      ...(input.turnId ? { turnId: input.turnId } : {}),
      step: input.step,
      createdAt,
      goal: input.goal ?? latestContext?.goal ?? '',
      ...(workflow ? { workflow } : {}),
      ...(page ? { page } : {}),
      ...(form ? { form } : {}),
      ...(evidence ? { evidence } : {}),
      ...(completion ? { completion } : {}),
      recentActions,
      blockers,
      permissions,
      approvals,
      safetyNotes,
      nextActionHints,
      source: {
        inputMessageCount: input.messages?.length ?? 0,
        ...(latestContext?.updatedAt ? { latestContextUpdatedAt: latestContext.updatedAt } : {}),
        ...(latestContext?.page?.updatedAt ? { pageStateUpdatedAt: latestContext.page.updatedAt } : {}),
        ...(latestContext?.form?.updatedAt ? { formStateUpdatedAt: latestContext.form.updatedAt } : {}),
      },
    }

    const compactedMessage: ChatMessage = {
      role: 'user',
      content: renderCompactedRunContext(summary),
    }
    const estimatedInputTokensBefore = estimateMessagesTokens(input.messages ?? [])
    const estimatedInputTokensAfter = estimateTokens(compactedMessage.content)

    return {
      schemaVersion: 'context-compaction-result/v1',
      summary,
      compactedMessage,
      stats: {
        inputMessageCount: input.messages?.length ?? 0,
        compactedMessageChars: compactedMessage.content.length,
        estimatedInputTokensBefore,
        estimatedInputTokensAfter,
        retainedRecentActionCount: recentActions.length,
        retainedPermissionCount: permissions.length,
        retainedApprovalCount: approvals.length,
      },
    }
  }

  private get maxRecentActions(): number {
    return normalizeMax(this.options.maxRecentActions, DEFAULT_MAX_RECENT_ACTIONS)
  }

  private get maxPermissions(): number {
    return normalizeMax(this.options.maxPermissions, DEFAULT_MAX_PERMISSIONS)
  }

  private get maxApprovals(): number {
    return normalizeMax(this.options.maxApprovals, DEFAULT_MAX_APPROVALS)
  }

  private get maxEvidenceItems(): number {
    return normalizeMax(this.options.maxEvidenceItems, DEFAULT_MAX_EVIDENCE_ITEMS)
  }

  private get maxCompletionCriteria(): number {
    return normalizeMax(this.options.maxCompletionCriteria, DEFAULT_MAX_COMPLETION_CRITERIA)
  }

  private get maxBlockers(): number {
    return normalizeMax(this.options.maxBlockers, DEFAULT_MAX_BLOCKERS)
  }

  private get maxSafetyNotes(): number {
    return normalizeMax(this.options.maxSafetyNotes, DEFAULT_MAX_SAFETY_NOTES)
  }

  private get maxNextActionHints(): number {
    return normalizeMax(this.options.maxNextActionHints, DEFAULT_MAX_NEXT_ACTION_HINTS)
  }

  private get reasonMaxChars(): number {
    return normalizeMax(this.options.maxReasonChars, DEFAULT_MAX_REASON_CHARS)
  }

  private now(): Date {
    return this.options.now?.() ?? new Date()
  }
}

export const contextCompactor = new ContextCompactor()

export function compactRunContext(
  input: ContextCompactionInput,
  options?: ContextCompactorOptions,
): ContextCompactionResult {
  return new ContextCompactor(options).compact(input)
}

export function renderCompactedRunContext(summary: CompactRunSummary): string {
  return [
    COMPACTED_RUN_CONTEXT_PREFIX,
    'Use this deterministic compact run summary as the current working set. Older messages may have been omitted; do not infer missing approvals or permissions beyond the recorded entries.',
    JSON.stringify(summary, null, 2),
  ].join('\n')
}

function summarizeWorkflow(
  workflowState: WorkflowState | undefined,
  maxReasonChars: number,
): CompactWorkflowSummary | undefined {
  if (!workflowState) return undefined
  return {
    phase: workflowState.phase,
    confidence: workflowState.confidence,
    reason: oneLine(workflowState.reason, maxReasonChars),
    ...(workflowState.blocker ? { blocker: oneLine(workflowState.blocker, maxReasonChars) } : {}),
    ...(workflowState.humanHandoffRequired !== undefined
      ? { humanHandoffRequired: workflowState.humanHandoffRequired }
      : {}),
    updatedAt: workflowState.updatedAt,
  }
}

function summarizePage(
  latestContext: ContextSnapshot | undefined,
  maxTextSummaryChars: number,
): CompactPageSummary | undefined {
  const page = latestContext?.page
  if (!page) return undefined
  return {
    ...(page.url ? { url: page.url } : {}),
    ...(page.title ? { title: oneLine(page.title, 180) } : {}),
    pageType: page.pageType,
    ...(page.textSummary ? { textSummary: truncateText(page.textSummary, maxTextSummaryChars) } : {}),
    interactiveCount: page.interactiveCount,
    formCount: page.formCount,
    linkCount: page.linkCount,
    buttonCount: page.buttonCount,
    inputCount: page.inputCount,
    updatedAt: page.updatedAt,
  }
}

function summarizeForm(latestContext: ContextSnapshot | undefined): CompactFormSummary | undefined {
  const form = latestContext?.form
  if (!form) return undefined
  return {
    fieldCount: form.fields.length,
    missingRequiredCount: form.missingRequired.length,
    filledFieldCount: form.filledFields.length,
    submitCandidateCount: form.submitCandidates.length,
    uploadHintCount: form.uploadHints?.length ?? 0,
    missingRequiredLabels: summarizeFieldLabels(form.missingRequired, 16),
    filledFieldLabels: summarizeFieldLabels(form.filledFields, 16),
    submitCandidates: form.submitCandidates.slice(0, 12).map<CompactSubmitCandidateSummary>((candidate) => ({
      text: oneLine(candidate.text || '(submit candidate)', 160),
      ...(candidate.tag ? { tag: candidate.tag } : {}),
      ...(candidate.type ? { type: candidate.type } : {}),
      ...(candidate.role ? { role: candidate.role } : {}),
      ...(candidate.risk ? { risk: candidate.risk } : {}),
      ...(candidate.visible !== undefined ? { visible: candidate.visible } : {}),
    })),
    uploadHints: (form.uploadHints ?? []).slice(0, 12).map<CompactUploadHintSummary>((hint) => ({
      text: oneLine(hint.text || '(upload hint)', 160),
      ...(hint.tag ? { tag: hint.tag } : {}),
      ...(hint.type ? { type: hint.type } : {}),
      ...(hint.accept ? { accept: hint.accept } : {}),
      ...(hint.visible !== undefined ? { visible: hint.visible } : {}),
    })),
    visibleErrors: trimStringList(form.visibleErrors ?? [], 12, 180),
    updatedAt: form.updatedAt,
  }
}

function summarizeEvidence(
  input: ContextCompactionEvidenceInput | undefined,
  maxEvidenceItems: number,
  maxReasonChars: number,
): CompactEvidenceSummary | undefined {
  const evidence = normalizeEvidenceInput(input)
  if (evidence.length === 0) return undefined

  const countsByKind: Record<string, number> = {}
  for (const item of evidence) {
    countsByKind[item.kind] = (countsByKind[item.kind] ?? 0) + 1
  }

  return {
    total: evidence.length,
    countsByKind,
    recentKeyEvidence: selectRecentKeyEvidence(evidence, maxEvidenceItems).map((item) => ({
      id: oneLine(item.id, 160),
      kind: item.kind,
      summary: oneLine(item.summary, maxReasonChars),
      source: oneLine(item.source, 160),
      confidence: item.confidence,
      ...(item.phase ? { phase: item.phase } : {}),
      ts: item.ts,
      ...(item.runId ? { runId: item.runId } : {}),
      ...(item.turnId ? { turnId: item.turnId } : {}),
      ...(item.toolCallId ? { toolCallId: item.toolCallId } : {}),
    })),
  }
}

function summarizeCompletion(
  evaluation: ContextCompactionWorkflowEvaluation | undefined,
  maxCriteria: number,
  maxReasonChars: number,
): CompactCompletionSummary | undefined {
  if (!evaluation) return undefined

  const finalSubmitBlocker = oneLine(evaluation.finalSubmitBlocker ?? evaluation.blocker, maxReasonChars)
  const humanHandoffReason = oneLine(evaluation.humanHandoffReason ?? evaluation.handoffReason, maxReasonChars)
  const missingCriteria = summarizeCompletionCriteria([
    ...(evaluation.missingCriteria ?? []),
    ...(evaluation.missingCompletionCriteria ?? []),
  ], maxCriteria, maxReasonChars)
  const completionCriteria = summarizeCompletionCriteria(evaluation.completionCriteria ?? [], maxCriteria, maxReasonChars)
  const satisfiedCriteria = summarizeCompletionCriteria(evaluation.satisfiedCriteria ?? [], maxCriteria, maxReasonChars)
  const reason = oneLine(evaluation.reason, maxReasonChars)

  const hasCompletionSummary = Boolean(
    finalSubmitBlocker ||
    humanHandoffReason ||
    missingCriteria.length ||
    completionCriteria.length ||
    satisfiedCriteria.length ||
    reason ||
    evaluation.blocked !== undefined ||
    evaluation.done !== undefined ||
    evaluation.evaluatedAt,
  )
  if (!hasCompletionSummary) return undefined

  return {
    ...(finalSubmitBlocker ? { finalSubmitBlocker } : {}),
    missingCriteria,
    ...(humanHandoffReason ? { humanHandoffReason } : {}),
    ...(completionCriteria.length ? { completionCriteria } : {}),
    ...(satisfiedCriteria.length ? { satisfiedCriteria } : {}),
    ...(evaluation.blocked !== undefined ? { blocked: evaluation.blocked } : {}),
    ...(evaluation.done !== undefined ? { done: evaluation.done } : {}),
    ...(reason ? { reason } : {}),
    ...(evaluation.evaluatedAt ? { evaluatedAt: evaluation.evaluatedAt } : {}),
  }
}

function summarizeRecentActions(
  actions: ContextRecentAction[],
  maxActions: number,
  maxObservationChars: number,
): CompactRecentActionSummary[] {
  return tail(actions, maxActions).map((action) => ({
    step: action.step,
    toolName: action.toolName,
    argumentsSummary: oneLine(action.argumentsSummary, 220),
    status: action.status,
    ...(action.risk ? { risk: action.risk } : {}),
    ...(action.observation ? { observation: oneLine(action.observation, maxObservationChars) } : {}),
    at: action.at,
  }))
}

function summarizePermissions(
  requests: PermissionRequest[],
  decisions: PermissionDecision[],
  maxPermissions: number,
  maxReasonChars: number,
): CompactPermissionSummary[] {
  const requestById = new Map(requests.map((request) => [request.requestId, request]))
  const summaries: CompactPermissionSummary[] = []
  const seen = new Set<string>()

  for (const decision of decisions) {
    const request = requestById.get(decision.requestId)
    summaries.push(summarizePermission(request, decision, maxReasonChars))
    seen.add(decision.requestId)
  }

  for (const request of requests) {
    if (seen.has(request.requestId)) continue
    summaries.push(summarizePermission(request, undefined, maxReasonChars))
  }

  return tail(summaries, maxPermissions)
}

function summarizePermission(
  request: PermissionRequest | undefined,
  decision: PermissionDecision | undefined,
  maxReasonChars: number,
): CompactPermissionSummary {
  const subject = request?.subject
  const toolSubject = subject?.kind === 'tool_call' ? subject : undefined
  const handoffSubject = subject?.kind === 'workflow_handoff' ? subject : undefined
  return {
    ...(decision?.requestId || request?.requestId ? { requestId: decision?.requestId ?? request?.requestId } : {}),
    ...(toolSubject?.toolCallId ? { toolCallId: toolSubject.toolCallId } : {}),
    ...(toolSubject?.toolName ? { toolName: toolSubject.toolName } : {}),
    ...(subject?.kind ? { subjectKind: subject.kind } : {}),
    ...(handoffSubject?.handoffKind ? { handoffKind: handoffSubject.handoffKind } : {}),
    ...(toolSubject?.args ? { argumentsSummary: oneLine(stringifyUnknown(toolSubject.args), 220) } : {}),
    ...(decision?.action ? { action: decision.action } : {}),
    ...(decision?.source ? { source: decision.source } : {}),
    ...(request?.policy.action ? { policyAction: request.policy.action } : {}),
    ...(decision?.risk ?? request?.risk ? { risk: decision?.risk ?? request?.risk } : {}),
    ...(decision?.riskLevel ?? request?.riskLevel ? { riskLevel: decision?.riskLevel ?? request?.riskLevel } : {}),
    ...(decision?.gateKind ?? request?.gateKind ? { gateKind: decision?.gateKind ?? request?.gateKind } : {}),
    ...(request?.workflowPhase ? { workflowPhase: request.workflowPhase } : {}),
    ...(decision?.policyCode ?? request?.policy.policyCode
      ? { policyCode: decision?.policyCode ?? request?.policy.policyCode }
      : {}),
    ...(decision?.ruleId ?? request?.policy.ruleId ? { ruleId: decision?.ruleId ?? request?.policy.ruleId } : {}),
    ...(decision?.policyRuleId ? { policyRuleId: decision.policyRuleId } : {}),
    ...(decision?.reason ?? request?.policy.reason
      ? { reason: oneLine(decision?.reason ?? request?.policy.reason, maxReasonChars) }
      : {}),
    ...(request?.requestedAt ? { requestedAt: request.requestedAt } : {}),
    ...(decision?.decidedAt ? { decidedAt: decision.decidedAt } : {}),
    ...(decision?.requiresFreshContext ?? request?.policy.requiresFreshContext
      ? { requiresFreshContext: decision?.requiresFreshContext ?? request?.policy.requiresFreshContext }
      : {}),
    ...(decision?.rememberable !== undefined ? { rememberable: decision.rememberable } : {}),
    ...(decision?.remember.defaultScope ? { rememberDefaultScope: decision.remember.defaultScope } : {}),
    auditTags: uniqueStrings([...(request?.policy.auditTags ?? []), ...(decision?.auditTags ?? [])]).slice(0, 16),
  }
}

function summarizeApprovals(
  approvals: ApprovalRequest[],
  maxApprovals: number,
  maxReasonChars: number,
): CompactApprovalSummary[] {
  return tail(approvals, maxApprovals).map((approval) => ({
    approvalId: approval.approvalId,
    ...(approval.permissionRequestId ? { permissionRequestId: approval.permissionRequestId } : {}),
    ...(approval.toolCallId ? { toolCallId: approval.toolCallId } : {}),
    status: approval.status,
    ...(approval.gateKind ? { gateKind: approval.gateKind } : {}),
    ...(approval.risk ? { risk: approval.risk } : {}),
    ...(approval.riskLevel ? { riskLevel: approval.riskLevel } : {}),
    ...(approval.title ? { title: oneLine(approval.title, 180) } : {}),
    ...(approval.reason ? { reason: oneLine(approval.reason, maxReasonChars) } : {}),
    ...(approval.resolution?.decision ? { decision: approval.resolution.decision } : {}),
    ...(approval.resolution?.source ? { resolutionSource: approval.resolution.source } : {}),
    ...(approval.resolution?.reason ? { resolutionReason: oneLine(approval.resolution.reason, maxReasonChars) } : {}),
    createdAt: approval.createdAt,
    ...(approval.updatedAt ? { updatedAt: approval.updatedAt } : {}),
    ...(approval.resolvedAt ?? approval.resolution?.resolvedAt
      ? { resolvedAt: approval.resolvedAt ?? approval.resolution?.resolvedAt }
      : {}),
  }))
}

function buildDefaultNextActionHints(input: {
  workflow: CompactWorkflowSummary | undefined
  page: CompactPageSummary | undefined
  form: CompactFormSummary | undefined
  blockers: string[]
  latestContext: ContextSnapshot | undefined
}): string[] {
  const hints: string[] = []
  if (input.blockers.length > 0) {
    hints.push(`Resolve or report the current blocker before continuing: ${input.blockers[0]}`)
  }
  if (input.workflow?.humanHandoffRequired || input.workflow?.phase === 'login_required' || input.workflow?.phase === 'captcha_required') {
    hints.push('Continue only after the human handoff or blocker is resolved; do not invent credential, login, or captcha results.')
  }
  if (!input.page || input.latestContext?.freshness.pageStateStale) {
    hints.push('Refresh page state before relying on old or missing element refs.')
  }
  if (input.form?.missingRequiredCount) {
    hints.push(`Address ${input.form.missingRequiredCount} missing required form field(s) before any submit-like action.`)
  }
  if (input.form?.uploadHintCount) {
    hints.push('Treat resume upload as safety-sensitive and rely only on recorded permission and approval state.')
  }
  if (input.form?.submitCandidateCount) {
    hints.push('Review submit candidates carefully; final submission remains safety-sensitive.')
  }
  if (hints.length === 0) {
    hints.push('Choose one next tool call from the latest context, or call agent_done if the task is complete or blocked.')
  }
  return hints
}

function buildCompletionNextActionHints(completion: CompactCompletionSummary | undefined): string[] {
  if (!completion) return []
  const hints: string[] = []
  if (completion.finalSubmitBlocker) {
    hints.push(`Do not perform final submission until this blocker is resolved: ${completion.finalSubmitBlocker}`)
  }
  if (completion.humanHandoffReason) {
    hints.push(`Preserve human handoff requirement: ${completion.humanHandoffReason}`)
  }
  if (completion.missingCriteria.length > 0) {
    hints.push(`Do not mark completion until missing criteria are resolved: ${completion.missingCriteria.map((criterion) => criterion.description).join('; ')}`)
  }
  return hints
}

function normalizeEvidenceInput(input: ContextCompactionEvidenceInput | undefined): WorkflowEvidence[] {
  if (!input) return []
  if (Array.isArray(input)) return input.slice()
  if (Array.isArray(input.evidence) && input.evidence.length > 0) return input.evidence.slice()
  if (Array.isArray(input.all) && input.all.length > 0) return input.all.slice()
  return Object.values(input.byKind ?? {}).flat()
}

function selectRecentKeyEvidence(evidence: WorkflowEvidence[], maxItems: number): WorkflowEvidence[] {
  const indexed = evidence.map((item, index) => ({ item, index }))
  const keyEvidence = indexed.filter(({ item }) => isKeyEvidence(item))
  const candidates = keyEvidence.length > 0 ? keyEvidence : indexed
  return candidates
    .sort(compareEvidenceByTime)
    .slice(Math.max(0, candidates.length - maxItems))
    .map(({ item }) => item)
}

function isKeyEvidence(evidence: WorkflowEvidence): boolean {
  const keyKinds = new Set([
    'form',
    'tool_result',
    'policy',
    'permission',
    'approval',
    'user_confirm',
    'workflow_state',
    'context_summary',
  ])
  if (keyKinds.has(evidence.kind)) return true
  if (evidence.phase === 'ready_for_final_submit' || evidence.phase === 'done' || evidence.phase === 'blocked') {
    return true
  }
  return /approval|blocked|criteria|final[-\s]?submit|gate|handoff|human|missing|permission/i.test(
    `${evidence.summary} ${evidence.source}`,
  )
}

function compareEvidenceByTime(
  left: { item: WorkflowEvidence; index: number },
  right: { item: WorkflowEvidence; index: number },
): number {
  const leftTime = Date.parse(left.item.ts)
  const rightTime = Date.parse(right.item.ts)
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
    return leftTime - rightTime
  }
  if (Number.isFinite(leftTime) && !Number.isFinite(rightTime)) return 1
  if (!Number.isFinite(leftTime) && Number.isFinite(rightTime)) return -1
  return left.index - right.index
}

function summarizeCompletionCriteria(
  criteria: ContextCompactionCriterionInput[],
  maxItems: number,
  maxReasonChars: number,
): CompactCompletionCriterionSummary[] {
  if (maxItems <= 0) return []
  const result: CompactCompletionCriterionSummary[] = []
  const seen = new Set<string>()
  for (const criterion of criteria) {
    const summary = summarizeCompletionCriterion(criterion, maxReasonChars)
    if (!summary) continue
    const key = [summary.id, summary.description, summary.reason].join('|')
    if (seen.has(key)) continue
    seen.add(key)
    result.push(summary)
    if (result.length >= maxItems) break
  }
  return result
}

function summarizeCompletionCriterion(
  criterion: ContextCompactionCriterionInput,
  maxReasonChars: number,
): CompactCompletionCriterionSummary | undefined {
  if (typeof criterion === 'string') {
    const description = oneLine(criterion, maxReasonChars)
    return description ? { description } : undefined
  }

  const id = oneLine(criterion.id, 160)
  const description = oneLine(
    criterion.description ?? criterion.criterion ?? criterion.reason ?? criterion.id,
    maxReasonChars,
  )
  if (!description) return undefined

  const reason = oneLine(criterion.reason, maxReasonChars)
  const status = oneLine(criterion.status, 80)
  const evidenceKinds = trimStringList(criterion.evidenceKinds ?? [], 8, 80)

  return {
    ...(id ? { id } : {}),
    description,
    ...(reason && reason !== description ? { reason } : {}),
    ...(status ? { status } : {}),
    ...(criterion.required !== undefined ? { required: criterion.required } : {}),
    ...(evidenceKinds.length ? { evidenceKinds } : {}),
  }
}

function summarizeFieldLabels(fields: FormFieldState[], maxFields: number): string[] {
  return trimStringList(fields.map((field) => (
    field.label || field.name || field.id || field.placeholder || `field #${field.index}`
  )), maxFields, 120)
}

function uniquePermissionDecisions(decisions: PermissionDecision[]): PermissionDecision[] {
  const seen = new Set<string>()
  const unique: PermissionDecision[] = []
  for (const decision of decisions) {
    const key = [
      decision.requestId,
      decision.action,
      decision.source,
      decision.decidedAt,
      decision.reason,
    ].join('|')
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(decision)
  }
  return unique
}

function uniqueStrings(values: Array<string | undefined | null | false>): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values) {
    const text = String(value ?? '').replace(/\s+/g, ' ').trim()
    if (!text || seen.has(text)) continue
    seen.add(text)
    result.push(text)
  }
  return result
}

function trimStringList(values: string[], maxItems: number, maxChars: number): string[] {
  return tail(uniqueStrings(values), normalizeMax(maxItems, values.length)).map((value) => oneLine(value, maxChars))
}

function tail<T>(values: T[], maxItems: number): T[] {
  const max = normalizeMax(maxItems, values.length)
  if (max === 0) return []
  return values.slice(Math.max(0, values.length - max))
}

function normalizeMax(value: number | undefined, fallback: number): number {
  if (value === undefined) return Math.max(0, fallback)
  if (!Number.isFinite(value)) return Math.max(0, fallback)
  return Math.max(0, Math.floor(value))
}

function createSummaryId(input: {
  sessionId: string
  runId: string
  turnId?: string
  step: number
  createdAt: string
}): string {
  const turnOrStep = input.turnId ? safeIdPart(input.turnId) : `step_${input.step}`
  const timestamp = safeIdPart(input.createdAt).slice(0, 32)
  return ['compact', safeIdPart(input.sessionId), safeIdPart(input.runId), turnOrStep, timestamp].join('_')
}

function safeIdPart(value: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '')
  return sanitized || 'unknown'
}

function estimateMessagesTokens(messages: ChatMessage[]): number {
  return messages.reduce((total, message) => total + estimateTokens(renderMessageForEstimate(message)), 0)
}

function renderMessageForEstimate(message: ChatMessage): string {
  return JSON.stringify({
    role: message.role,
    content: message.content,
    tool_calls: message.tool_calls,
    tool_call_id: message.tool_call_id,
    name: message.name,
  })
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

function stringifyUnknown(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}
