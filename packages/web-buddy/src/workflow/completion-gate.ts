import type { FormFieldState, FormState, UploadHint } from '../observation/form-state.js'
import type { PageState } from '../observation/page-state.js'
import type { FillLedgerSummary } from '../fill/fill-ledger.js'
import type { FormCoverage } from '../observation/form-state.js'
import type {
  WorkflowBlocker,
  WorkflowCriterionMissing,
  WorkflowEngineEvaluation,
} from './workflow-engine.js'
import type { EvidenceKind } from './workflow-evidence.js'
import type { WorkflowPhase, WorkflowState } from './workflow-state.js'

export type CompletionGateAction = 'allow' | 'block' | 'ignore' | 'reject'
export type CompletionGateRecommendedStatus = 'completed' | 'blocked' | 'unchanged'

export interface CompletionGateInput {
  done: boolean
  blocked: boolean
  summary?: string
  workflowState?: WorkflowState
  workflowEvaluation?: WorkflowEngineEvaluation
  page?: PageState
  form?: FormState
  formCoverage?: FormCoverage
  fillLedgerSummary?: FillLedgerSummary
  requiresCurrentResumeUpload?: boolean
  currentResumeUploaded?: boolean
  source?: 'agent_done' | 'finalize' | 'manual' | (string & {})
}

export interface CompletionGateDecision {
  schemaVersion: 'completion-gate-decision/v1'
  action: CompletionGateAction
  recommendedStatus: CompletionGateRecommendedStatus
  reason: string
  missingCriteria: WorkflowCriterionMissing[]
  blockers: WorkflowBlocker[]
  workflowPhase?: WorkflowPhase | string
  evidenceIds: string[]
}

const CRITICAL_MISSING_EVIDENCE_KINDS = new Set<EvidenceKind>([
  'tool_result',
  'policy',
  'permission',
  'approval',
  'user_confirm',
  'workflow_state',
])

export class CompletionGate {
  static evaluate(input: CompletionGateInput): CompletionGateDecision {
    return completionGate.evaluate(input)
  }

  evaluate(input: CompletionGateInput): CompletionGateDecision {
    const evaluation = input.workflowEvaluation
    const workflowPhase = evaluation?.state.phase ?? input.workflowState?.phase
    const missingCriteria = copyMissingCriteria(evaluation?.missingCriteria ?? [])
    const blockers = copyBlockers(evaluation?.blockers ?? [])
    const evidenceIds = evidenceIdsFor(evaluation, missingCriteria, blockers)

    if (!input.done) {
      return decision({
        action: 'ignore',
        recommendedStatus: 'unchanged',
        reason: completionReason('Completion gate ignored because runtime has not received a done signal.', input),
        missingCriteria,
        blockers,
        workflowPhase,
        evidenceIds,
      })
    }

    const fillCompletenessMissing = fillCompletenessCriteria(input, workflowPhase)
    if (fillCompletenessMissing.length > 0) {
      missingCriteria.push(...fillCompletenessMissing)
      return decision({
        action: 'reject',
        recommendedStatus: 'unchanged',
        reason: completionReason(
          `Completion gate rejected premature agent_done because fill-completeness criteria are not satisfied: ${fillCompletenessGapSummary(fillCompletenessMissing)}. Continue with the suggested next actions instead of ending the run.`,
          input,
        ),
        missingCriteria,
        blockers,
        workflowPhase,
        evidenceIds,
      })
    }

    if (input.blocked) {
      const prematureBlockedDoneReason = actionableBlockedDoneReason(input, workflowPhase, blockers)
      if (prematureBlockedDoneReason) {
        return decision({
          action: 'reject',
          recommendedStatus: 'unchanged',
          reason: completionReason(prematureBlockedDoneReason, input),
          missingCriteria,
          blockers,
          workflowPhase,
          evidenceIds,
        })
      }

      return decision({
        action: 'block',
        recommendedStatus: 'blocked',
        reason: completionReason('Completion gate blocked completion because runtime already marked the attempt as blocked.', input),
        missingCriteria,
        blockers,
        workflowPhase,
        evidenceIds,
      })
    }

    if (!evaluation) {
      return decision({
        action: 'ignore',
        recommendedStatus: 'unchanged',
        reason: completionReason('Completion gate ignored the done signal because no workflow evaluation is available.', input),
        missingCriteria,
        blockers,
        workflowPhase,
        evidenceIds,
      })
    }

    if (workflowPhase === 'direct_submit_review') {
      return decision({
        action: 'block',
        recommendedStatus: 'blocked',
        reason: completionReason(
          'Completion gate blocked completion because the workflow is in direct-submit review: the site uses an online resume/direct-submit mode, no fillable fields are available, and the next step is final submit.',
          input,
        ),
        missingCriteria,
        blockers,
        workflowPhase,
        evidenceIds,
      })
    }

    if (workflowPhase === 'ready_for_final_submit') {
      return decision({
        action: 'block',
        recommendedStatus: 'blocked',
        reason: completionReason(
          'Completion gate blocked completion because the workflow is ready for final submit and requires human takeover before completion.',
          input,
        ),
        missingCriteria,
        blockers,
        workflowPhase,
        evidenceIds,
      })
    }

    if (workflowPhase === 'blocked') {
      return decision({
        action: 'block',
        recommendedStatus: 'blocked',
        reason: completionReason('Completion gate blocked completion because the workflow phase is blocked.', input),
        missingCriteria,
        blockers,
        workflowPhase,
        evidenceIds,
      })
    }

    const finalSubmitBlocker = blockers.find((blocker) => blocker.gateKind === 'final_submit')
    if (finalSubmitBlocker) {
      return decision({
        action: 'block',
        recommendedStatus: 'blocked',
        reason: completionReason(
          `Completion gate blocked completion because a final-submit blocker is present: ${finalSubmitBlocker.message}`,
          input,
        ),
        missingCriteria,
        blockers,
        workflowPhase,
        evidenceIds,
      })
    }

    const blockingMissingCriteria = missingCriteria.filter(isRequiredOrCriticalMissingCriterion)
    if (blockingMissingCriteria.length > 0) {
      return decision({
        action: 'block',
        recommendedStatus: 'blocked',
        reason: completionReason(
          `Completion gate blocked completion because required workflow evidence is missing: ${missingCriterionSummary(blockingMissingCriteria)}.`,
          input,
        ),
        missingCriteria,
        blockers,
        workflowPhase,
        evidenceIds,
      })
    }

    if (missingCriteria.length > 0) {
      return decision({
        action: 'block',
        recommendedStatus: 'blocked',
        reason: completionReason(
          `Completion gate blocked completion because workflow criteria are still missing: ${missingCriterionSummary(missingCriteria)}.`,
          input,
        ),
        missingCriteria,
        blockers,
        workflowPhase,
        evidenceIds,
      })
    }

    if (workflowPhase === 'done' && missingCriteria.length === 0) {
      return decision({
        action: 'allow',
        recommendedStatus: 'completed',
        reason: completionReason('Completion gate allowed completion because workflow phase is done and no criteria are missing.', input),
        missingCriteria,
        blockers,
        workflowPhase,
        evidenceIds,
      })
    }

    return decision({
      action: 'block',
      recommendedStatus: 'blocked',
      reason: completionReason(
        `Completion gate blocked completion because workflow phase ${workflowPhase ?? 'unknown'} is not done.`,
        input,
      ),
      missingCriteria,
      blockers,
      workflowPhase,
      evidenceIds,
    })
  }
}

export const completionGate = new CompletionGate()

function decision(input: Omit<CompletionGateDecision, 'schemaVersion'>): CompletionGateDecision {
  return {
    schemaVersion: 'completion-gate-decision/v1',
    ...input,
  }
}

function completionReason(reason: string, input: CompletionGateInput): string {
  const source = input.source ? ` Source: ${input.source}.` : ''
  const summary = input.summary ? ` Agent summary: ${input.summary}` : ''
  return `${reason}${source}${summary}`
}

function actionableBlockedDoneReason(
  input: CompletionGateInput,
  workflowPhase: WorkflowPhase | string | undefined,
  blockers: WorkflowBlocker[],
): string | undefined {
  if (!input.done || !input.blocked) return undefined
  if (isFinalSubmitBoundary(workflowPhase, blockers)) return undefined

  const facts = actionablePageFacts(input, workflowPhase)
  if (facts.length === 0) return undefined

  if (facts.some((fact) => fact.code === 'ALIBABA_APPLICATION_CONFIRMATION_STILL_OPEN')) {
    return [
      'ALIBABA_APPLICATION_CONFIRMATION_STILL_OPEN.',
      'Completion gate rejected premature agent_done(blocked=true) because the Alibaba quota confirmation dialog is still open on the position-detail page.',
      'The page text says the user has not applied yet, this month has a limited number of applications, and the user should choose carefully; visible controls include "投递" and "取消".',
      'Continue through the normal gate by choosing "投递", or click "取消" / ask for human takeover; do not end the run while this dialog remains actionable.',
    ].join(' ')
  }

  return [
    'PREMATURE_AGENT_DONE_REJECTED.',
    `Completion gate rejected agent_done(blocked=true) because the page still has actionable work: ${facts.map((fact) => fact.message).join('; ')}.`,
    'Return this reason to the model and continue operating instead of finalizing the run as blocked.',
  ].join(' ')
}

interface ActionablePageFact {
  code:
    | 'ALIBABA_APPLICATION_CONFIRMATION_STILL_OPEN'
    | 'DELIVER_CANCEL_CONTROLS_PRESENT'
    | 'UPLOAD_ENTRY_PRESENT'
    | 'MISSING_REQUIRED_FIELDS_PRESENT'
    | 'HANDOFF_COMPLETED_BUSINESS_FLOW'
  message: string
}

function actionablePageFacts(
  input: Pick<CompletionGateInput, 'page' | 'form' | 'workflowEvaluation' | 'workflowState'>,
  workflowPhase: WorkflowPhase | string | undefined,
): ActionablePageFact[] {
  const facts: ActionablePageFact[] = []

  if (isAlibabaConfirmationStillOpen(input.page, input.form)) {
    facts.push({
      code: 'ALIBABA_APPLICATION_CONFIRMATION_STILL_OPEN',
      message: 'Alibaba confirmation dialog is still open with 投递 and 取消 controls',
    })
  } else if (hasDeliverAndCancelControls(input.form, input.page)) {
    facts.push({
      code: 'DELIVER_CANCEL_CONTROLS_PRESENT',
      message: 'visible 投递 and 取消 controls are still available',
    })
  }

  const uploadHints = realUploadHints(input.form)
  if (uploadHints.length > 0) {
    facts.push({
      code: 'UPLOAD_ENTRY_PRESENT',
      message: `real upload entry still exists (${uploadHints.map((hint) => hint.text || hint.type || hint.tag).slice(0, 3).join(', ')})`,
    })
  }

  const missingFields = actionableMissingRequiredFields(input.form)
  if (missingFields.length > 0) {
    facts.push({
      code: 'MISSING_REQUIRED_FIELDS_PRESENT',
      message: `required form field(s) remain unfinished (${missingFields.map((field) => field.label).slice(0, 4).join(', ')})`,
    })
  }

  if (handoffJustReturnedToBusinessFlow(input.workflowEvaluation?.state ?? input.workflowState, input.page, input.form, workflowPhase)) {
    facts.push({
      code: 'HANDOFF_COMPLETED_BUSINESS_FLOW',
      message: 'login/captcha handoff has cleared and the page is back in the business workflow',
    })
  }

  return uniqueFacts(facts)
}

function isFinalSubmitBoundary(
  workflowPhase: WorkflowPhase | string | undefined,
  blockers: WorkflowBlocker[],
): boolean {
  if (workflowPhase === 'direct_submit_review' || workflowPhase === 'ready_for_final_submit') return true
  return blockers.some((blocker) => (
    blocker.gateKind === 'final_submit' ||
    /final[-\s]?submit|final submission|manual takeover/i.test(blocker.message)
  ))
}

function isAlibabaConfirmationStillOpen(page: PageState | undefined, form: FormState | undefined): boolean {
  if (!page || !isAlibabaPositionDetailUrl(page.url)) return false
  const text = normalizedPageText(page)
  const hasQuotaDialog =
    /你暂未申请职位/.test(text) &&
    /本月能申请\s*\d+\s*个职位/.test(text) &&
    /请慎重选择/.test(text)
  return hasQuotaDialog && hasDeliverAndCancelControls(form, page)
}

function isAlibabaPositionDetailUrl(value: string | undefined): boolean {
  if (!value) return false
  try {
    const url = new URL(value)
    return /(^|\.)talent-holding\.alibaba\.com$/i.test(url.hostname) &&
      /\/off-campus\/position-detail/i.test(url.pathname)
  } catch {
    return /talent-holding\.alibaba\.com\/off-campus\/position-detail/i.test(value)
  }
}

function hasDeliverAndCancelControls(form: FormState | undefined, page: PageState | undefined): boolean {
  const labels = controlLabels(form)
  const pageText = normalizedPageText(page)
  const hasDeliver =
    labels.some((label) => /^投递$/.test(label)) ||
    /(?:^|\s)投递(?:\s|$|[，。！!])/.test(pageText)
  const hasCancel =
    labels.some((label) => /^取消$/.test(label)) ||
    /(?:^|\s)取消(?:\s|$|[，。！!])/.test(pageText)
  return hasDeliver && hasCancel
}

function controlLabels(form: FormState | undefined): string[] {
  return (form?.submitCandidates ?? [])
    .filter((candidate) => candidate.visible !== false)
    .map((candidate) => normalize(candidate.text))
    .filter(Boolean)
}

function realUploadHints(form: FormState | undefined): UploadHint[] {
  return (form?.uploadHints ?? []).filter((hint) => {
    if (hint.visible === false) return false
    if (hint.type === 'file') return true
    const hay = normalize([hint.text, hint.accept, hint.tag].filter(Boolean).join(' '))
    return /上传|重新上传|选择.{0,8}(?:文件|简历)|选取.{0,8}(?:文件|简历)|附件简历|附件上传|upload|choose|select|browse/i.test(hay)
  })
}

function actionableMissingRequiredFields(form: FormState | undefined): FormFieldState[] {
  return (form?.missingRequired ?? []).filter((field) => (
    field.required &&
    !field.filled &&
    !field.disabled &&
    !field.readonly
  ))
}

function handoffJustReturnedToBusinessFlow(
  workflowState: WorkflowState | undefined,
  page: PageState | undefined,
  form: FormState | undefined,
  workflowPhase: WorkflowPhase | string | undefined,
): boolean {
  const from = workflowState?.lastTransition?.from
  if (from !== 'login_required' && from !== 'captcha_required') return false
  if (workflowPhase === 'login_required' || workflowPhase === 'captcha_required' || workflowPhase === 'blocked') return false
  if (page?.pageType === 'login' || page?.pageType === 'captcha' || page?.pageType === 'confirmation') return false

  const businessPhase =
    workflowPhase === 'entering_application' ||
    workflowPhase === 'job_detail' ||
    workflowPhase === 'filling_application' ||
    workflowPhase === 'reviewing'
  const hasBusinessSurface =
    (form?.fields.length ?? 0) > 0 ||
    (form?.submitCandidates.some((candidate) => candidate.visible !== false) ?? false) ||
    (form?.uploadHints?.some((hint) => hint.visible !== false) ?? false) ||
    (page?.interactiveCount ?? 0) > 0
  return businessPhase && hasBusinessSurface
}

function normalizedPageText(page: PageState | undefined): string {
  return normalize([page?.url, page?.title, page?.textSummary].filter(Boolean).join(' '))
}

function normalize(value: string | null | undefined): string {
  return (value || '').replace(/\s+/g, ' ').trim()
}

function uniqueFacts(facts: ActionablePageFact[]): ActionablePageFact[] {
  const seen = new Set<string>()
  const result: ActionablePageFact[] = []
  for (const fact of facts) {
    if (seen.has(fact.code)) continue
    seen.add(fact.code)
    result.push(fact)
  }
  return result
}

function fillCompletenessCriteria(
  input: CompletionGateInput,
  workflowPhase: WorkflowPhase | string | undefined,
): WorkflowCriterionMissing[] {
  if (isFinalSubmitBoundary(workflowPhase, input.workflowEvaluation?.blockers ?? [])) return []
  const criteria: WorkflowCriterionMissing[] = []
  const formCoverage = input.formCoverage ?? input.form?.formCoverage ?? input.workflowState?.formCoverage
  const ledger = input.fillLedgerSummary ?? input.workflowState?.fillLedgerSummary
  const hasPlannedFillWork = (ledger?.total ?? 0) > 0
  const shouldRequireAudit = hasPlannedFillWork

  if (shouldRequireAudit && formCoverage?.scrolledBottom !== true) {
    criteria.push(fillCriterion(
      'fill_form_coverage_scrolled_bottom',
      'Form coverage audit must reach the bottom of the form before completion.',
      formCoverage
        ? 'Run browser_form_audit or scroll/audit again until formCoverage.scrolledBottom is true.'
        : 'Run browser_form_audit so formCoverage evidence proves the whole form was scanned.',
    ))
  }

  if (hasPlannedFillWork && ledger && ledger.pendingRequired > 0) {
    criteria.push(fillCriterion(
      'fill_pending_required_zero',
      'FillLedger pendingRequired must be 0 before completion.',
      `Fill or explicitly resolve ${ledger.pendingRequired} required field(s) still pending in FillLedger.`,
    ))
  }

  if (hasPlannedFillWork && ledger && ledger.failed > 0) {
    criteria.push(fillCriterion(
      'fill_failed_zero',
      'FillLedger failed must be 0 before completion.',
      `Retry, inspect options, or mark a safe alternative for ${ledger.failed} failed field(s).`,
    ))
  }

  if (hasPlannedFillWork && ledger && ledger.needsUser > 0) {
    criteria.push(fillCriterion(
      'fill_needs_user_zero',
      'FillLedger needsUser must be 0 before completion.',
      `Call ask_user for ${ledger.needsUser} field(s) that need user input, then fill the answers.`,
    ))
  }

  if (input.requiresCurrentResumeUpload && input.currentResumeUploaded !== true && input.workflowState?.currentResumeUploaded !== true) {
    criteria.push(fillCriterion(
      'fill_current_resume_uploaded',
      'The current task resume file must be uploaded before completion.',
      'Use browser_upload_file for the current resumePath, then refresh form/page state.',
    ))
  }

  return criteria
}

function fillCriterion(id: string, description: string, reason: string): WorkflowCriterionMissing {
  return {
    id,
    kind: 'evidence_required',
    description,
    evidenceKinds: [],
    missingEvidenceKinds: [],
    evidenceIds: [],
    reason,
  }
}

function fillCompletenessGapSummary(criteria: WorkflowCriterionMissing[]): string {
  return criteria.map((criterion) => `${criterion.id}: ${criterion.reason}`).join('; ')
}

function isRequiredOrCriticalMissingCriterion(criterion: WorkflowCriterionMissing): boolean {
  if (criterion.kind === 'phase_required_evidence') return criterion.missingEvidenceKinds.length > 0
  if (criterion.kind === 'evidence_required') return true
  if (criterion.kind === 'human_handoff' || criterion.kind === 'blocked') return true
  return criterion.missingEvidenceKinds.some((kind) => CRITICAL_MISSING_EVIDENCE_KINDS.has(kind))
}

function missingCriterionSummary(criteria: WorkflowCriterionMissing[]): string {
  return criteria
    .map((criterion) => {
      const missingKinds =
        criterion.missingEvidenceKinds.length > 0 ? ` missing ${criterion.missingEvidenceKinds.join(', ')}` : ''
      return `${criterion.id}${missingKinds}`
    })
    .join('; ')
}

function evidenceIdsFor(
  evaluation: WorkflowEngineEvaluation | undefined,
  missingCriteria: WorkflowCriterionMissing[],
  blockers: WorkflowBlocker[],
): string[] {
  return unique([
    ...(evaluation?.evidenceIds ?? []),
    ...missingCriteria.flatMap((criterion) => criterion.evidenceIds),
    ...blockers.flatMap((blocker) => blocker.evidenceIds ?? []),
  ])
}

function copyMissingCriteria(criteria: WorkflowCriterionMissing[]): WorkflowCriterionMissing[] {
  return criteria.map((criterion) => ({
    ...criterion,
    evidenceKinds: [...criterion.evidenceKinds],
    missingEvidenceKinds: [...criterion.missingEvidenceKinds],
    evidenceIds: [...criterion.evidenceIds],
  }))
}

function copyBlockers(blockers: WorkflowBlocker[]): WorkflowBlocker[] {
  return blockers.map((blocker) => ({
    ...blocker,
    ...(blocker.missingEvidenceKinds ? { missingEvidenceKinds: [...blocker.missingEvidenceKinds] } : {}),
    ...(blocker.evidenceIds ? { evidenceIds: [...blocker.evidenceIds] } : {}),
  }))
}

function unique(values: string[]): string[] {
  return [...new Set(values)]
}
