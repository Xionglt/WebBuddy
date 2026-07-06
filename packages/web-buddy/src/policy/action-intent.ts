import type { RiskLevel } from '../sdk/trace.js'
import type { WorkflowPhase, WorkflowState } from '../workflow/workflow-state.js'

export type ActionIntent =
  | 'observe'
  | 'apply_entry'
  | 'application_confirm'
  | 'upload_resume'
  | 'save_draft'
  | 'final_submit'
  | 'login'
  | 'captcha'
  | 'unknown_high_risk'

export interface ActionIntentInput {
  toolName: string
  args?: Record<string, unknown>
  risk?: RiskLevel
  currentUrl?: string
  refLabel?: string
  contextText?: string
  workflowState?: Pick<WorkflowState, 'phase'>
  workflowPhase?: WorkflowPhase
}

const OBSERVE_TOOLS = new Set([
  'browser_snapshot',
  'browser_form_snapshot',
  'browser_form_audit',
  'browser_inspect_options',
  'browser_screenshot',
  'browser_wait',
  'agent_done',
])

const CLICK_TOOLS = new Set(['browser_click', 'browser_click_text'])

const ALIBABA_DETAIL_URL = /talent-holding\.alibaba\.com\/off-campus\/position-detail/i

const LOGIN_TEXT =
  /login|log in|sign in|signin|sso|auth|password|密码登录|短信登录|账号登录|统一认证|单点登录|请登录|登录后|登陆后|登入后|登录/i
const CAPTCHA_TEXT = /captcha|human verification|verify you are human|人机验证|验证码|安全验证|滑块验证/i
const UPLOAD_TEXT =
  /upload|attach|attachment|choose file|select file|file input|上传|重新上传|附件|附件简历|上传简历|简历解析|选择文件|选取文件|添加文件/i
const NON_UPLOAD_APPLICATION_TEXT =
  /^(投递|投递简历|立即投递|申请|申请职位|开始申请|提交|提交申请|确认投递|完成投递|apply|apply now|start application|submit|submit application)$/i
const FINAL_SUBMIT_TEXT =
  /确认投递|提交申请|完成投递|确认提交|递交申请|最终提交|final submit|submit application|complete application|finish application|confirm and submit|publish application|submit$/i
const REVIEW_SUBMIT_TEXT = /submit|提交|提交申请|确认提交|confirm|确认|pay|支付|publish|发布|send|递交/i
const APPLY_ENTRY_EXACT =
  /^(投递|投递简历|立即投递|申请职位|开始申请|apply|apply now|start application)$/i
const APPLY_ENTRY_TEXT = /投递简历|立即投递|申请职位|开始申请|apply now|start application/i
const SAVE_DRAFT_TEXT = /保存草稿|保存简历|保存申请|暂存|save draft|save resume|save application/i

export function inferActionIntent(input: ActionIntentInput): ActionIntent {
  const phase = workflowPhaseFor(input)
  const text = actionTextFor(input)
  const contextText = normalized([input.contextText, input.currentUrl].filter(Boolean).join(' '))
  const combinedText = normalized([text, contextText].filter(Boolean).join(' '))

  if (phase === 'login_required') return 'login'
  if (phase === 'captcha_required') return 'captcha'
  if (OBSERVE_TOOLS.has(input.toolName)) return 'observe'

  if (CAPTCHA_TEXT.test(combinedText)) return 'captcha'
  if (LOGIN_TEXT.test(combinedText) && !FINAL_SUBMIT_TEXT.test(text)) return 'login'

  if (input.toolName === 'browser_upload_file') {
    if (text && !isUploadText(text) && NON_UPLOAD_APPLICATION_TEXT.test(text)) return 'unknown_high_risk'
    return 'upload_resume'
  }

  if (CLICK_TOOLS.has(input.toolName) && isUploadText(text)) return 'upload_resume'
  if (isAlibabaDetailApplicationConfirm(input.currentUrl, text)) return 'application_confirm'
  if (isAlibabaDetailApplyEntry(input.currentUrl, text)) return 'apply_entry'

  if (phase === 'direct_submit_review' && (REVIEW_SUBMIT_TEXT.test(text) || isApplyEntryText(text))) {
    return 'final_submit'
  }
  if ((phase === 'reviewing' || phase === 'ready_for_final_submit') && REVIEW_SUBMIT_TEXT.test(text)) {
    return 'final_submit'
  }
  if (FINAL_SUBMIT_TEXT.test(text)) return 'final_submit'

  if (SAVE_DRAFT_TEXT.test(text)) return 'save_draft'

  if (
    isApplyEntryText(text) &&
    (!phase || phase === 'job_detail' || phase === 'entering_application' || phase === 'observing')
  ) {
    return 'apply_entry'
  }

  return isHighRisk(input.risk) ? 'unknown_high_risk' : 'observe'
}

function actionTextFor(input: ActionIntentInput): string {
  const args = input.args ?? {}
  const parts: string[] = []
  if (input.toolName === 'browser_click_text') parts.push(stringValue(args.text))
  if (input.toolName === 'browser_upload_file') {
    parts.push(stringValue(args.text))
    parts.push(stringValue(input.refLabel))
  }
  if (input.toolName === 'browser_click') parts.push(stringValue(input.refLabel))
  return normalized(parts.filter(Boolean).join(' '))
}

function isAlibabaDetailApplicationConfirm(currentUrl: string | undefined, text: string): boolean {
  if (!ALIBABA_DETAIL_URL.test(currentUrl ?? '')) return false
  return /^投递$/i.test(text)
}

function isAlibabaDetailApplyEntry(currentUrl: string | undefined, text: string): boolean {
  if (!ALIBABA_DETAIL_URL.test(currentUrl ?? '')) return false
  if (FINAL_SUBMIT_TEXT.test(text)) return false
  return APPLY_ENTRY_EXACT.test(text) || APPLY_ENTRY_TEXT.test(text)
}

function isApplyEntryText(text: string): boolean {
  return APPLY_ENTRY_EXACT.test(text) || APPLY_ENTRY_TEXT.test(text)
}

function isUploadText(text: string): boolean {
  if (!text) return false
  if (NON_UPLOAD_APPLICATION_TEXT.test(text) && !UPLOAD_TEXT.test(text)) return false
  return UPLOAD_TEXT.test(text)
}

function workflowPhaseFor(input: Pick<ActionIntentInput, 'workflowState' | 'workflowPhase'>): WorkflowPhase | undefined {
  return input.workflowPhase ?? input.workflowState?.phase
}

function isHighRisk(risk: RiskLevel | undefined): boolean {
  return risk === 'L3' || risk === 'L4'
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function normalized(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}
