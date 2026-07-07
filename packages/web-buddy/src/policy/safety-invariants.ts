import type { GateKind } from '../sdk/human.js'
import type { RiskLevel } from '../sdk/trace.js'

export type SafetyInvariant =
  | 'no_auto_login'
  | 'no_auto_captcha'
  | 'no_auto_upload_resume'
  | 'no_auto_save_profile'
  | 'no_final_submit'
  | 'stop_if_uncertain_final_submit'

export interface SafetyInvariantDecision {
  invariant: SafetyInvariant | null
  gateKind: GateKind
  reason: string
  action: 'allow' | 'gate' | 'block'
}

export interface SafetyInvariantInput {
  toolName: string
  args: Record<string, unknown>
  risk?: RiskLevel
  pageSignals?: {
    hasOnlySubmitLikeControls?: boolean
    formFieldsPresent?: boolean
  }
  refLabel?: string
  contextText?: string
  confirmed?: boolean
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

const LOGIN_TEXT =
  /login|log in|sign in|signin|sso|auth|password|密码登录|短信登录|账号登录|统一认证|单点登录|请登录|登录后|登陆后|登入后|登录/i
const CAPTCHA_TEXT = /captcha|human verification|verify you are human|人机验证|验证码|安全验证|滑块验证/i
const UPLOAD_TEXT =
  /upload|attach|attachment|choose file|select file|file input|上传|重新上传|附件|附件简历|上传简历|简历解析|选择文件|选取文件|添加文件/i
const SAVE_PROFILE_TEXT = /保存草稿|保存简历|保存申请|保存资料|更新资料|覆盖资料|save draft|save resume|save application|save profile|update profile/i
const FINAL_SUBMIT_TEXT =
  /确认投递|提交申请|完成投递|确认提交|递交申请|最终提交|final submit|submit application|complete application|finish application|confirm and submit|publish application|submit$/i
const QUOTA_FINAL_CONTEXT =
  /温馨提示|慎重选择|本月.{0,12}(能|可|还可|还能).{0,12}(申请|投递).{0,12}(职位|岗位)|每月.{0,12}(申请|投递)|申请名额|投递名额|申请次数|投递次数|application quota|application limit|submission quota|submission limit/i
const QUOTA_CONFIRM_ACTION = /^(投递|申请|确认|继续|submit|apply|confirm|continue)$/i
const SUBMIT_LIKE_TEXT = /submit|提交|确认|确认提交|确认投递|完成投递|pay|支付|publish|发布|send|递交|continue|继续/i

export function classifySafetyInvariant(input: SafetyInvariantInput): SafetyInvariantDecision {
  if (OBSERVE_TOOLS.has(input.toolName)) {
    return allow('Observation tools do not trigger a safety invariant.')
  }

  const text = actionTextFor(input)
  const highRisk = isHighRisk(input.risk)

  if (CAPTCHA_TEXT.test(text)) {
    return gate('no_auto_captcha', 'captcha', 'Captcha or human-verification actions require human takeover.')
  }

  if (LOGIN_TEXT.test(text) && !FINAL_SUBMIT_TEXT.test(text)) {
    return gate('no_auto_login', 'login', 'Login, SSO, or credential actions require human takeover.')
  }

  if (input.toolName === 'browser_upload_file' || UPLOAD_TEXT.test(text)) {
    return gate('no_auto_upload_resume', 'upload_resume', 'Uploading a resume or local file requires human approval.')
  }

  if (SAVE_PROFILE_TEXT.test(text)) {
    return gate('no_auto_save_profile', 'save_resume', 'Saving or overwriting profile/application data requires human approval.')
  }

  if (QUOTA_CONFIRM_ACTION.test(text) && QUOTA_FINAL_CONTEXT.test(normalized([text, input.contextText].filter(Boolean).join(' ')))) {
    return gate(
      'no_final_submit',
      'final_submit',
      'Quota or application-limit confirmation dialogs are treated as a final-submit boundary.',
    )
  }

  if (isSubmitLike(input, text)) {
    if (input.pageSignals?.hasOnlySubmitLikeControls && !input.pageSignals.formFieldsPresent) {
      return gate(
        'stop_if_uncertain_final_submit',
        'final_submit',
        'Submit-like action on a page with no remaining form fields is treated as a final-submit boundary.',
      )
    }
    if (FINAL_SUBMIT_TEXT.test(text)) {
      return gate('no_final_submit', 'final_submit', 'Final submit, publish, pay, or send actions require human takeover.')
    }
    if (highRisk && input.pageSignals?.formFieldsPresent) {
      return gate('stop_if_uncertain_final_submit', 'high_risk_action', 'Submit-like action may be an intermediate step; gate because it is high risk.')
    }
    if (highRisk && input.pageSignals?.hasOnlySubmitLikeControls === undefined) {
      return gate('stop_if_uncertain_final_submit', 'high_risk_action', 'Submit-like action is ambiguous without page signals; gate when uncertain.')
    }
  }

  if (highRisk) {
    return gate(null, 'high_risk_action', 'High-risk tool action requires a human gate.')
  }

  return allow('Tool risk does not require a human gate.')
}

function allow(reason: string): SafetyInvariantDecision {
  return { invariant: null, gateKind: 'high_risk_action', reason, action: 'allow' }
}

function gate(invariant: SafetyInvariant | null, gateKind: GateKind, reason: string): SafetyInvariantDecision {
  return { invariant, gateKind, reason, action: 'gate' }
}

function isSubmitLike(input: SafetyInvariantInput, text: string): boolean {
  if (input.toolName === 'browser_click_text' || input.toolName === 'browser_click') {
    return SUBMIT_LIKE_TEXT.test(text)
  }
  const type = stringValue(input.args.type).toLowerCase()
  const role = stringValue(input.args.role).toLowerCase()
  return type === 'submit' || (role === 'button' && SUBMIT_LIKE_TEXT.test(text))
}

function actionTextFor(input: SafetyInvariantInput): string {
  const parts: string[] = []
  if (input.toolName === 'browser_click_text') parts.push(stringValue(input.args.text))
  if (input.toolName === 'browser_upload_file') parts.push(stringValue(input.args.text))
  if (input.toolName === 'browser_click') parts.push(stringValue(input.refLabel))
  parts.push(stringValue(input.args.label))
  parts.push(stringValue(input.args.name))
  parts.push(stringValue(input.args.placeholder))
  return normalized(parts.filter(Boolean).join(' '))
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
