import type { FormState, SubmitCandidate } from '../observation/form-state.js'
import type { PageState } from '../observation/page-state.js'
import type { GateKind } from '../sdk/human.js'
import { actionableDialogPresent } from './actionable-dialog.js'
import type { TaskCompletionVerdict } from './task-completion.js'

export type ObservationPhase =
  | 'in_target_flow'
  | 'external_blocker'
  | 'final_submit_boundary'
  | 'done'
  | 'blocked'

export interface ObservationPhaseInput {
  page?: PageState
  form?: FormState
  blockers?: ObservationPhaseBlocker[]
  taskCompletionVerdict?: Pick<TaskCompletionVerdict, 'targetStateReached' | 'externalBlockerVisible'>
  policyFacts?: ObservationPolicyFact[]
  permissionFacts?: ObservationPermissionFact[]
  externalBlockerVisible?: boolean
  summary?: string
}

export interface ObservationPhaseBlocker {
  id?: string
  kind?: string
  message?: string
  phase?: string
  gateKind?: GateKind | string
  recoverable?: boolean
  unresolved?: boolean
}

export type ObservationPolicyFact = {
  action?: string
  gateKind?: GateKind | string
  policyCode?: string
  reason?: string
  invariant?: string | null
}

export type ObservationPermissionFact = {
  action?: string
  decision?: string
  status?: string
  gateKind?: GateKind | string
  reason?: string
  workflowPhase?: string
  subject?: unknown
  policy?: { action?: string; gateKind?: GateKind | string; policyCode?: string; reason?: string }
}

const FINAL_SUBMIT_TEXT =
  /确认投递|提交申请|完成投递|确认提交|递交申请|最终提交|final submit|submit application|complete application|finish application|confirm and submit|publish application|submit$/i
const APPLY_ENTRY_TEXT =
  /^(投递简历|立即投递|申请职位|开始申请|start application|apply now|apply)$/i
const FINAL_SUBMIT_DIALOG_TEXT =
  /温馨提示|你已申请.{0,12}职位|已申请.{0,12}职位|本月.{0,18}(?:还能|可|可以).{0,18}(?:申请|投递)|申请名额|投递名额|请慎重选择|final submit|submit application/i
const BLOCKED_TEXT =
  /unrecoverable|cannot continue|can't continue|cannot proceed|permanently blocked|navigation blocked|access denied|forbidden|quota exceeded|无法继续|不能继续|不可恢复|无法恢复|已截止|名额已满|无权限/i

export function classifyObservationPhase(input: ObservationPhaseInput): ObservationPhase {
  if (input.taskCompletionVerdict?.targetStateReached === true) return 'done'

  if (hasExternalBlocker(input)) return 'external_blocker'

  if (hasFinalSubmitBoundary(input)) return 'final_submit_boundary'

  if (hasUnrecoverableBlocker(input)) return 'blocked'

  return 'in_target_flow'
}

function hasExternalBlocker(input: ObservationPhaseInput): boolean {
  if (input.taskCompletionVerdict?.externalBlockerVisible === true) return true
  if (input.externalBlockerVisible === true) return true
  if (input.page?.pageType === 'login' || input.page?.pageType === 'captcha') return true

  const dialog = input.page?.facts?.visibleBlockingDialog
  if (dialog?.present && (dialog.kind === 'login' || dialog.kind === 'captcha')) return true

  return [...(input.blockers ?? []), ...factsAsBlockers(input.policyFacts)].some((blocker) =>
    blocker.kind === 'external_blocker' ||
    blocker.gateKind === 'login' ||
    blocker.gateKind === 'captcha' ||
    blocker.phase === 'login_required' ||
    blocker.phase === 'captcha_required',
  )
}

function hasFinalSubmitBoundary(input: ObservationPhaseInput): boolean {
  if (hasVisibleFinalSubmitDialog(input)) return true
  if (actionableDialogPresent({ page: input.page, form: input.form }).present) return false
  if (input.blockers?.some(isFinalSubmitBlocker)) return true
  if (factsAsBlockers(input.policyFacts).some(isFinalSubmitBlocker)) return true
  if (factsAsBlockers(input.permissionFacts).some(isFinalSubmitBlocker)) return true

  if ((input.form?.missingRequired.length ?? 0) > 0) return false
  if (input.form && hasUnfilledRealFields(input.form)) return false

  if ((input.form?.submitCandidates ?? []).some(isFinalSubmitCandidate)) return true
  if ((input.page?.facts?.likelyFinalSubmitButtons ?? []).some((button) => button.visible !== false && FINAL_SUBMIT_TEXT.test(button.text))) {
    return true
  }

  const hasOnlySubmitLikeControls =
    (input.form?.fields.length ?? 0) === 0 &&
    (input.form?.missingRequired.length ?? 0) === 0 &&
    input.form?.facts?.hasRealUploadInput !== true &&
    (input.form?.facts?.uploadCandidateCount ?? 0) === 0 &&
    input.page?.facts?.hasRealUploadInput !== true &&
    (input.page?.facts?.uploadCandidateCount ?? 0) === 0 &&
    (input.form?.submitCandidates.some((candidate) => candidate.visible !== false) ?? false)
  if (hasOnlySubmitLikeControls) return true

  return (
    (input.page?.inputCount ?? 0) === 0 &&
    (input.page?.formCount ?? 0) === 0 &&
    (input.page?.facts?.submitLikeButtons.some((button) => button.visible !== false) ?? false) &&
    (input.page?.facts?.likelyApplyEntryButtons.length ?? 0) === 0
  )
}

function hasVisibleFinalSubmitDialog(input: ObservationPhaseInput): boolean {
  const dialog = input.page?.facts?.visibleBlockingDialog
  if (!dialog?.present) return false
  const text = [dialog.text, input.page?.textSummary, input.form?.visibleErrors?.join(' ')].filter(Boolean).join(' ')
  if (BLOCKED_TEXT.test(text)) return false
  if (dialog.kind === 'quota') return true
  return FINAL_SUBMIT_DIALOG_TEXT.test(text) && /投递|确认|提交|submit|apply|confirm/i.test(text)
}

function hasUnrecoverableBlocker(input: ObservationPhaseInput): boolean {
  if (input.blockers?.some(isUnrecoverableBlocker)) return true

  const dialog = input.page?.facts?.visibleBlockingDialog
  if (dialog?.present && dialog.kind === 'quota') return true
  if (input.page?.facts?.hasApplicationQuotaDialog) return true

  const text = [input.summary, input.page?.textSummary, input.form?.visibleErrors?.join(' ')].filter(Boolean).join(' ')
  return BLOCKED_TEXT.test(text)
}

function isFinalSubmitBlocker(blocker: ObservationPhaseBlocker): boolean {
  return (
    blocker.gateKind === 'final_submit' ||
    blocker.phase === 'ready_for_final_submit' ||
    blocker.phase === 'direct_submit_review' ||
    FINAL_SUBMIT_TEXT.test(blocker.message ?? '')
  )
}

function isUnrecoverableBlocker(blocker: ObservationPhaseBlocker): boolean {
  if (blocker.recoverable === false) return true
  if (blocker.phase === 'blocked') return true
  if (blocker.kind === 'workflow_blocked') return true
  return BLOCKED_TEXT.test(blocker.message ?? '')
}

function isFinalSubmitCandidate(candidate: SubmitCandidate): boolean {
  if (candidate.visible === false) return false
  if (APPLY_ENTRY_TEXT.test(candidate.text)) return false
  if (candidate.risk === 'L3' || candidate.risk === 'L4') return true
  return candidate.type === 'submit' && FINAL_SUBMIT_TEXT.test(candidate.text)
}

function hasUnfilledRealFields(form: FormState): boolean {
  return form.fields.some((field) => {
    if (field.disabled || field.readonly || field.filled) return false
    const tag = (field.tag ?? '').toLowerCase()
    const type = (field.type ?? '').toLowerCase()
    if (tag === 'textarea' || tag === 'select') return true
    if (tag !== 'input') return field.role === 'textbox' || field.role === 'combobox' || field.role === 'searchbox'
    return !['hidden', 'button', 'submit', 'reset', 'image', 'checkbox', 'radio', 'file'].includes(type)
  })
}

function factsAsBlockers(facts: (ObservationPolicyFact | ObservationPermissionFact)[] | undefined): ObservationPhaseBlocker[] {
  return (facts ?? []).map((fact) => {
    const record = fact as ObservationPermissionFact
    return {
      gateKind: fact.gateKind ?? record.policy?.gateKind,
      message: [fact.reason, record.policy?.reason, record.policy?.policyCode].filter(Boolean).join(' '),
      phase: record.workflowPhase,
    }
  })
}
