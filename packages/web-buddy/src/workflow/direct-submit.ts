import type { Page } from 'playwright'
import type { FormFieldState, FormState, SubmitCandidate } from '../observation/form-state.js'
import type { PageState } from '../observation/page-state.js'

export interface DirectSubmitControl {
  tag: string
  type?: string
  role?: string
  label?: string
  name?: string
  id?: string
  placeholder?: string
  text?: string
  disabled?: boolean
  readonly?: boolean
  visible?: boolean
  contentEditable?: boolean
}

export interface DirectSubmitCandidate {
  tag: string
  type?: string
  role?: string
  text: string
  visible?: boolean
  disabled?: boolean
}

export interface DirectSubmitSignals {
  loginWall: boolean
  realFillableFieldCount: number
  agreementCheckboxCount: number
  nonAgreementChoiceCount: number
  noticeTextPresent: boolean
  submitApplyButtonCount: number
  fieldCount: number
  submitCandidates: DirectSubmitCandidate[]
}

export interface DirectSubmitReview {
  schemaVersion: 'direct-submit-review/v1'
  phase: 'direct_submit_review'
  detected: true
  url?: string
  title?: string
  reason: string
  userMessage: string
  nextStep: 'final_submit'
  signals: DirectSubmitSignals
}

export interface DirectSubmitInspection {
  schemaVersion: 'direct-submit-inspection/v1'
  detected: boolean
  url?: string
  title?: string
  reason: string
  userMessage?: string
  nextStep?: 'final_submit'
  signals: DirectSubmitSignals
}

interface DirectSubmitInspectionInput {
  url?: string
  title?: string
  pageText?: string
  fields: DirectSubmitControl[]
  submitCandidates: DirectSubmitCandidate[]
}

const AGREEMENT_TEXT =
  /同意|已阅读|阅读并同意|协议|条款|须知|需知|隐私|声明|承诺|授权|agreement|agree|terms|notice|privacy|consent/i
const APPLICATION_NOTICE_TEXT =
  /申请工作需知|申请工作须知|投递须知|投递需知|申请须知|应聘须知|同意.*(协议|条款|声明|须知|需知)|已阅读.*(协议|条款|声明|须知|需知)|application notice|job application notice|terms and conditions/i
const SUBMIT_APPLY_TEXT =
  /投递简历|立即投递|确认投递|提交申请|申请职位|递交申请|submit application|apply now|start application|apply|submit/i
const LOGIN_WALL_TEXT =
  /login|log in|sign in|signin|sso|auth|password|登录|登陆|登入|账号登录|密码登录|短信登录|统一认证|单点登录/i
const NON_FILLABLE_INPUT_TYPES = new Set(['hidden', 'button', 'submit', 'reset', 'image'])
const CHOICE_INPUT_TYPES = new Set(['checkbox', 'radio'])

export async function inspectDirectSubmitReviewPage(page: Page): Promise<DirectSubmitInspection> {
  const dom = await page.evaluate(() => {
    const normalize = (value: string | null | undefined) => (value || '').replace(/\s+/g, ' ').trim()
    const isVisible = (el: Element) => {
      const style = window.getComputedStyle(el)
      const rect = el.getBoundingClientRect()
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0
    }
    const labelFor = (el: Element) => {
      const id = el.getAttribute('id')
      if (!id) return ''
      return normalize(document.querySelector(`label[for="${CSS.escape(id)}"]`)?.textContent)
    }
    const closestLabel = (el: Element) => normalize(el.closest('label')?.textContent)
    const nearbyText = (el: Element) => {
      const parent =
        el.closest('label,[class*="form"],[class*="field"],[class*="item"],[class*="row"],[class*="notice"],[class*="agree"]') ||
        el.parentElement
      return normalize(parent?.textContent).slice(0, 260)
    }
    const controlText = (el: Element) => {
      const input = el as HTMLInputElement
      return normalize(
        el.getAttribute('aria-label') ||
          labelFor(el) ||
          closestLabel(el) ||
          input.placeholder ||
          el.getAttribute('name') ||
          el.getAttribute('id') ||
          nearbyText(el),
      )
    }
    const fields = Array.from(document.querySelectorAll('input,textarea,select,[contenteditable="true"],[role="textbox"],[role="combobox"],[role="searchbox"]'))
      .filter(isVisible)
      .map((el) => {
        const input = el as HTMLInputElement
        return {
          tag: el.tagName.toLowerCase(),
          type: (input.type || el.getAttribute('type') || '').toLowerCase() || undefined,
          role: el.getAttribute('role') || undefined,
          label: controlText(el),
          name: normalize(el.getAttribute('name')) || undefined,
          id: normalize(el.getAttribute('id')) || undefined,
          placeholder: normalize(input.placeholder) || undefined,
          text: nearbyText(el),
          disabled: input.disabled || el.getAttribute('aria-disabled') === 'true',
          readonly: input.readOnly || el.getAttribute('aria-readonly') === 'true',
          visible: true,
          contentEditable: el.getAttribute('contenteditable') === 'true' || (el as HTMLElement).isContentEditable,
        }
      })

    const submitCandidates = Array.from(document.querySelectorAll('button,input[type="submit"],input[type="button"],a,[role="button"]'))
      .filter(isVisible)
      .map((el) => {
        const input = el as HTMLInputElement
        return {
          tag: el.tagName.toLowerCase(),
          type: (input.type || el.getAttribute('type') || '').toLowerCase() || undefined,
          role: el.getAttribute('role') || undefined,
          text: normalize(el.textContent || input.value || el.getAttribute('aria-label')).slice(0, 180),
          visible: true,
          disabled: input.disabled || el.getAttribute('aria-disabled') === 'true',
        }
      })
      .filter((candidate) => candidate.text)

    return {
      url: location.href,
      title: document.title,
      pageText: document.body?.innerText || '',
      fields,
      submitCandidates,
    }
  })
  return inspectDirectSubmitReview(dom)
}

export async function detectDirectSubmitReview(page: Page): Promise<DirectSubmitReview | undefined> {
  const inspection = await inspectDirectSubmitReviewPage(page)
  return inspection.detected ? toDirectSubmitReview(inspection) : undefined
}

export function inspectDirectSubmitWorkflowState(input: {
  form?: FormState
  page?: PageState
  currentUrl?: string
}): DirectSubmitInspection | undefined {
  if (!input.form) return undefined
  const fields = input.form.fields.map(fieldControl)
  const submitCandidates = input.form.submitCandidates.map(submitControl)
  return inspectDirectSubmitReview({
    url: input.currentUrl ?? input.form.url ?? input.page?.url,
    title: input.page?.title,
    pageText: [input.currentUrl, input.page?.url, input.page?.title, input.page?.textSummary]
      .filter(Boolean)
      .join('\n'),
    fields,
    submitCandidates,
  })
}

export function inspectDirectSubmitReview(input: DirectSubmitInspectionInput): DirectSubmitInspection {
  const pageText = [input.url, input.title, input.pageText].filter(Boolean).join('\n')
  const visibleEnabledFields = input.fields.filter((field) => field.visible !== false && !field.disabled && !field.readonly)
  const agreementCheckboxes = visibleEnabledFields.filter(isAgreementCheckbox)
  const nonAgreementChoices = visibleEnabledFields.filter((field) => isChoiceField(field) && !isAgreementCheckbox(field))
  const realFillableFields = visibleEnabledFields.filter(isRealFillableField)
  const submitCandidates = input.submitCandidates
    .filter((candidate) => candidate.visible !== false && !candidate.disabled)
    .filter((candidate) => SUBMIT_APPLY_TEXT.test(candidate.text))

  const signals: DirectSubmitSignals = {
    loginWall: isLoginWall(pageText),
    realFillableFieldCount: realFillableFields.length,
    agreementCheckboxCount: agreementCheckboxes.length,
    nonAgreementChoiceCount: nonAgreementChoices.length,
    noticeTextPresent: APPLICATION_NOTICE_TEXT.test(pageText),
    submitApplyButtonCount: submitCandidates.length,
    fieldCount: visibleEnabledFields.length,
    submitCandidates,
  }

  const hasAgreementOrNotice = signals.agreementCheckboxCount > 0 || signals.noticeTextPresent
  const detected =
    !signals.loginWall &&
    signals.realFillableFieldCount === 0 &&
    signals.nonAgreementChoiceCount === 0 &&
    hasAgreementOrNotice &&
    signals.submitApplyButtonCount > 0

  if (detected) {
    return {
      schemaVersion: 'direct-submit-inspection/v1',
      detected: true,
      url: input.url,
      title: input.title,
      reason: 'No real fillable application fields were found; only agreement/notice controls and an apply/submit button are visible.',
      userMessage: directSubmitUserMessage(),
      nextStep: 'final_submit',
      signals,
    }
  }

  return {
    schemaVersion: 'direct-submit-inspection/v1',
    detected: false,
    url: input.url,
    title: input.title,
    reason: directSubmitNegativeReason(signals),
    signals,
  }
}

export function toDirectSubmitReview(inspection: DirectSubmitInspection): DirectSubmitReview | undefined {
  if (!inspection.detected) return undefined
  return {
    schemaVersion: 'direct-submit-review/v1',
    phase: 'direct_submit_review',
    detected: true,
    url: inspection.url,
    title: inspection.title,
    reason: inspection.reason,
    userMessage: inspection.userMessage ?? directSubmitUserMessage(),
    nextStep: 'final_submit',
    signals: inspection.signals,
  }
}

export function isDirectSubmitButtonText(text: string): boolean {
  return SUBMIT_APPLY_TEXT.test(text)
}

export function isLoginWallText(text: string): boolean {
  return isLoginWall(text)
}

function isLoginWall(text: string): boolean {
  return LOGIN_WALL_TEXT.test(text)
}

function isAgreementCheckbox(field: DirectSubmitControl): boolean {
  return normalizedType(field) === 'checkbox' && AGREEMENT_TEXT.test(controlText(field))
}

function isChoiceField(field: DirectSubmitControl): boolean {
  return CHOICE_INPUT_TYPES.has(normalizedType(field))
}

function isRealFillableField(field: DirectSubmitControl): boolean {
  const tag = field.tag.toLowerCase()
  const type = normalizedType(field)
  if (NON_FILLABLE_INPUT_TYPES.has(type)) return false
  if (tag === 'input' && isAgreementCheckbox(field)) return false
  if (tag === 'input' && isChoiceField(field)) return true
  if (tag === 'input') return true
  if (tag === 'textarea' || tag === 'select') return true
  if (field.role === 'textbox' || field.role === 'combobox' || field.role === 'searchbox') return true
  return field.contentEditable === true
}

function normalizedType(field: DirectSubmitControl): string {
  return (field.type || (field.tag.toLowerCase() === 'input' ? 'text' : '')).toLowerCase()
}

function controlText(field: DirectSubmitControl): string {
  return [field.label, field.placeholder, field.name, field.id, field.text].filter(Boolean).join(' ')
}

function fieldControl(field: FormFieldState): DirectSubmitControl {
  const extra = field as FormFieldState & { nearbyText?: string }
  return {
    tag: field.tag ?? 'input',
    type: field.type,
    role: field.role,
    label: field.label,
    name: field.name,
    id: field.id,
    placeholder: field.placeholder,
    text: [field.label, field.placeholder, field.name, field.id, extra.nearbyText].filter(Boolean).join(' '),
    disabled: field.disabled,
    readonly: field.readonly,
    visible: true,
    contentEditable: field.tag === 'div' && field.role === 'textbox',
  }
}

function submitControl(candidate: SubmitCandidate): DirectSubmitCandidate {
  return {
    tag: candidate.tag,
    type: candidate.type,
    role: candidate.role,
    text: candidate.text,
    visible: candidate.visible,
  }
}

function directSubmitUserMessage(): string {
  return '该站点使用在线简历/直接投递模式：页面没有可填写的申请字段，仅检测到协议/申请工作需知和投递按钮。下一步是最终提交边界，默认已停在 final_submit 前等待人工确认。'
}

function directSubmitNegativeReason(signals: DirectSubmitSignals): string {
  if (signals.loginWall) return 'Page still appears to be a login wall.'
  if (signals.realFillableFieldCount > 0) return 'Page has real fillable application fields.'
  if (signals.nonAgreementChoiceCount > 0) return 'Page has non-agreement checkbox/radio choices.'
  if (signals.agreementCheckboxCount === 0 && !signals.noticeTextPresent) return 'No agreement checkbox or application notice was detected.'
  if (signals.submitApplyButtonCount === 0) return 'No submit/apply button was detected.'
  return 'Direct-submit signals were incomplete.'
}
