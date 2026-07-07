import type { FillLedgerSummary } from '../fill/fill-ledger.js'
import type { FormCoverage, FormState } from '../observation/form-state.js'
import type { PageState, PageType } from '../observation/page-state.js'
import type { WebBuddyTaskType } from './completion-gate.js'
import type { EvidenceStoreSnapshot, WorkflowEvidence } from './workflow-evidence.js'

export interface TaskCompletionContext {
  taskType: WebBuddyTaskType
  page?: PageState
  form?: FormState
  formCoverage?: FormCoverage
  fillLedgerSummary?: FillLedgerSummary
  requiresCurrentResumeUpload?: boolean
  currentResumeUploaded?: boolean
  summary?: string
  evidenceSnapshot: EvidenceStoreSnapshot
}

export interface TaskCompletionVerdict {
  targetStateReached: boolean
  externalBlockerVisible: boolean
  missingEvidence: string[]
  reason: string
}

const EXPLORE_PAGE_TYPES = new Set<PageType>(['list', 'detail', 'form', 'confirmation'])

export function evaluateTaskCompletion(ctx: TaskCompletionContext): TaskCompletionVerdict {
  const base = evaluateByTaskType(ctx)
  const externalBlockerVisible = externalBlockerVisibleFor(ctx, ctx.taskType)
  const missingEvidence = uniqueShortPhrases([
    ...base.missingEvidence,
    ...(base.targetStateReached ? [] : externalBlockerMissingEvidence(ctx, externalBlockerVisible)),
  ])

  return {
    targetStateReached: base.targetStateReached,
    externalBlockerVisible,
    missingEvidence,
    reason: completionReason(ctx.taskType, base.targetStateReached, externalBlockerVisible, missingEvidence),
  }
}

function evaluateByTaskType(ctx: TaskCompletionContext): Pick<TaskCompletionVerdict, 'targetStateReached' | 'missingEvidence'> {
  if (ctx.taskType === 'explore') return evaluateExplore(ctx)
  if (ctx.taskType === 'apply_entry') return evaluateApplyEntry(ctx)
  if (ctx.taskType === 'fill_form') return evaluateFillForm(ctx)
  return evaluateFinalReview(ctx)
}

function evaluateExplore(ctx: TaskCompletionContext): Pick<TaskCompletionVerdict, 'targetStateReached' | 'missingEvidence'> {
  const pageEvidence = pageEvidenceFor(ctx)
  const pageType = ctx.page?.pageType ?? newestPageType(pageEvidence)
  const pageTypeMatches = pageType ? EXPLORE_PAGE_TYPES.has(pageType) : false
  const summaryHasResult = summaryHasCandidateOrDetail(ctx.summary)

  return {
    targetStateReached: pageEvidence.length > 0 && pageTypeMatches && summaryHasResult,
    missingEvidence: [
      ...(pageEvidence.length > 0 ? [] : ['Missing page evidence.']),
      ...(pageTypeMatches ? [] : ['Page evidence must show a list, detail, form, or confirmation page.']),
      ...(summaryHasResult ? [] : ['Summary must include candidate or detail information.']),
    ],
  }
}

function evaluateApplyEntry(ctx: TaskCompletionContext): Pick<TaskCompletionVerdict, 'targetStateReached' | 'missingEvidence'> {
  const pageEvidence = pageEvidenceFor(ctx)
  const page = ctx.page
  const targetStateReached =
    hasApplicationSurface(ctx) ||
    hasApplicationSuccessOrNextStep(ctx) ||
    pageEvidence.some((evidence) => evidenceTextShowsApplicationFlow(evidence.summary) || evidenceDataShowsApplicationFlow(evidence.data))

  return {
    targetStateReached,
    missingEvidence: targetStateReached
      ? []
      : [
          ...(pageEvidence.length > 0 || page ? [] : ['Missing page evidence.']),
          'Need evidence of an application form, upload/profile/account surface, success, or next-step state.',
        ],
  }
}

function evaluateFillForm(ctx: TaskCompletionContext): Pick<TaskCompletionVerdict, 'targetStateReached' | 'missingEvidence'> {
  const coverage = ctx.formCoverage ?? ctx.form?.formCoverage
  const ledger = ctx.fillLedgerSummary
  const visibleErrors = (ctx.form?.visibleErrors ?? []).filter((error) => /\S/.test(error))
  const missingEvidence = [
    ...(coverage?.scrolledBottom === true ? [] : ['Form coverage must show scrolledBottom=true.']),
    ...(ledger ? [] : ['Missing fill ledger summary.']),
    ...(ledger && ledger.pendingRequired !== 0 ? [`Fill ledger pendingRequired must be 0, currently ${ledger.pendingRequired}.`] : []),
    ...(ledger && ledger.failed !== 0 ? [`Fill ledger failed must be 0, currently ${ledger.failed}.`] : []),
    ...(ledger && ledger.needsUser !== 0 ? [`Fill ledger needsUser must be 0, currently ${ledger.needsUser}.`] : []),
    ...(visibleErrors.length === 0 ? [] : [`Visible form errors must be resolved: ${visibleErrors.slice(0, 3).join('; ')}.`]),
    ...(ctx.requiresCurrentResumeUpload && ctx.currentResumeUploaded !== true ? ['Current resume upload must be verified.'] : []),
  ]

  return {
    targetStateReached: missingEvidence.length === 0,
    missingEvidence,
  }
}

function evaluateFinalReview(ctx: TaskCompletionContext): Pick<TaskCompletionVerdict, 'targetStateReached' | 'missingEvidence'> {
  return {
    targetStateReached: false,
    missingEvidence: isFinalSubmitBoundary(ctx)
      ? ['Final submit boundary reached; human takeover is required.']
      : ['final_review never auto-completes; human review is required.'],
  }
}

function externalBlockerVisibleFor(ctx: TaskCompletionContext, taskType: WebBuddyTaskType): boolean {
  const text = blockerVisibleText(ctx)
  if (ctx.page?.pageType === 'login' || ctx.page?.pageType === 'captcha') return true
  if (taskType === 'fill_form') return containsLoginOrCaptcha(text)
  if (containsLoginCaptchaSsoOrPermissionWall(text)) return true
  if (taskType === 'apply_entry' && containsUnavailableTarget(text)) return true
  return false
}

function externalBlockerMissingEvidence(ctx: TaskCompletionContext, externalBlockerVisible: boolean): string[] {
  if (externalBlockerVisible) return []
  if (ctx.taskType !== 'explore' && ctx.taskType !== 'apply_entry' && ctx.taskType !== 'fill_form') return []
  if (ctx.taskType === 'fill_form') return ['No login or captcha blocker is visible.']
  return ['No login, captcha, SSO, permission wall, or unavailable-state blocker is visible.']
}

function hasApplicationSurface(ctx: TaskCompletionContext): boolean {
  const page = ctx.page
  const form = ctx.form
  const text = allVisibleText(ctx)
  if (page?.pageType === 'form') return true
  if ((page?.formCount ?? 0) > 0 || (page?.inputCount ?? 0) > 0) return true
  if ((form?.fields.length ?? 0) > 0) return true
  if ((form?.uploadHints ?? []).some((hint) => hint.visible !== false)) return true
  return /\b(application|apply|profile|account|resume|cv|upload|form)\b|申请|简历|上传|个人资料|账户|账号/i.test(text)
}

function hasApplicationSuccessOrNextStep(ctx: TaskCompletionContext): boolean {
  const text = allVisibleText(ctx)
  if (ctx.page?.pageType === 'confirmation' && containsSubmissionOrNextStep(text)) return true
  return containsSubmissionOrNextStep(text)
}

function evidenceTextShowsApplicationFlow(text: string): boolean {
  return /\b(application|apply|profile|account|resume|cv|upload|form|submitted|next step)\b|已提交|已申请|下一步|申请|简历|上传|个人资料|账户|账号/i.test(text)
}

function evidenceDataShowsApplicationFlow(data: Record<string, unknown> | undefined): boolean {
  if (!data) return false
  return evidenceTextShowsApplicationFlow(JSON.stringify(data))
}

function summaryHasCandidateOrDetail(summary: string | undefined): boolean {
  const text = normalize(summary)
  if (!text) return false
  if (/\b(candidate|result|item|listing|detail|title|role|position|company|location|requirement|description)\b|候选|结果|列表|详情|职位|岗位|公司|地点|要求|描述/i.test(text)) {
    return true
  }
  const structuredLines = text.split(/\n|[;；]/).filter((line) => /\S/.test(line))
  if (structuredLines.length >= 2 && structuredLines.some((line) => /[:：\-]|^\s*(?:[-*]|\d+[.)、])\s*/.test(line))) {
    return true
  }
  return false
}

function containsLoginCaptchaSsoOrPermissionWall(text: string): boolean {
  return /\b(login|log in|sign in|captcha|sso|single sign[-\s]?on|permission wall|access denied|forbidden|unauthorized|not authorized|verify your identity)\b|登录|登陆|验证码|单点登录|权限|无权|未授权|拒绝访问|身份验证/i.test(text)
}

function containsLoginOrCaptcha(text: string): boolean {
  return /\b(login|log in|sign in|captcha|verify your identity)\b|登录|登陆|验证码|身份验证/i.test(text)
}

function containsUnavailableTarget(text: string): boolean {
  return /\b(job unavailable|position unavailable|closed|no longer available|expired|not found|filled)\b|职位不可用|岗位不可用|已关闭|已下架|已过期|已招满|不存在/i.test(text)
}

function containsSubmissionOrNextStep(text: string): boolean {
  return /\b(submitted|submission received|applied|application received|next step|continue|success)\b|已提交|已申请|提交成功|申请成功|下一步|继续|成功/i.test(text)
}

function isFinalSubmitBoundary(ctx: TaskCompletionContext): boolean {
  const candidates = ctx.form?.submitCandidates ?? []
  if (candidates.some((candidate) => candidate.visible !== false && candidate.risk === 'L4')) return true
  const text = allVisibleText(ctx)
  return /\b(final submit|final submission|submit application|send application)\b|最终提交|确认提交|提交申请/i.test(text)
}

function allVisibleText(ctx: TaskCompletionContext): string {
  return normalize([
    ctx.summary,
    blockerVisibleText(ctx),
  ].join(' '))
}

function blockerVisibleText(ctx: TaskCompletionContext): string {
  return normalize([
    ctx.page?.title,
    ctx.page?.textSummary,
    ...(ctx.form?.visibleErrors ?? []),
    ...(ctx.form?.submitCandidates ?? []).map((candidate) => candidate.text),
    ...(ctx.form?.uploadHints ?? []).map((hint) => hint.text),
    ...pageEvidenceFor(ctx).map((evidence) => evidence.summary),
  ].join(' '))
}

function pageEvidenceFor(ctx: TaskCompletionContext): WorkflowEvidence[] {
  const byKind = ctx.evidenceSnapshot.byKind.page ?? []
  if (byKind.length > 0) return byKind
  return ctx.evidenceSnapshot.evidence.filter((evidence) => evidence.kind === 'page')
}

function newestPageType(evidence: WorkflowEvidence[]): PageType | undefined {
  for (const item of [...evidence].sort((a, b) => b.ts.localeCompare(a.ts))) {
    const type = item.data?.pageType
    if (isPageType(type)) return type
  }
  return undefined
}

function isPageType(value: unknown): value is PageType {
  return value === 'unknown' ||
    value === 'login' ||
    value === 'list' ||
    value === 'detail' ||
    value === 'form' ||
    value === 'confirmation' ||
    value === 'captcha'
}

function completionReason(
  taskType: WebBuddyTaskType,
  targetStateReached: boolean,
  externalBlockerVisible: boolean,
  missingEvidence: string[],
): string {
  if (targetStateReached) return `${taskType} target state reached.`
  if (externalBlockerVisible) return `${taskType} encountered an external blocker.`
  return `${taskType} is not complete: ${missingEvidence.join('; ')}`
}

function uniqueShortPhrases(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))]
}

function normalize(value: string | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim()
}
