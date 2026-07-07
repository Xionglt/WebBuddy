import type { RiskLevel } from '../sdk/trace.js'

export type ActionIntent =
  | 'observe'
  | 'safety_sensitive'
  | 'state_change'
  | 'unknown_high_risk'

export interface ActionIntentInput {
  toolName: string
  args?: Record<string, unknown>
  risk?: RiskLevel
  refLabel?: string
  contextText?: string
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
const STATE_CHANGE_TOOLS = new Set([
  'browser_click',
  'browser_click_text',
  'browser_set_field',
  'browser_type',
  'browser_select',
  'browser_select_by_text',
  'browser_fill_by_label',
])

const LOGIN_TEXT =
  /login|log in|sign in|signin|sso|auth|password|密码登录|短信登录|账号登录|统一认证|单点登录|请登录|登录后|登陆后|登入后|登录/i
const CAPTCHA_TEXT = /captcha|human verification|verify you are human|人机验证|验证码|安全验证|滑块验证/i
const UPLOAD_TEXT =
  /upload|attach|attachment|choose file|select file|file input|上传|重新上传|附件|附件简历|上传简历|简历解析|选择文件|选取文件|添加文件/i
const FINAL_SUBMIT_TEXT =
  /确认投递|提交申请|完成投递|确认提交|递交申请|最终提交|final submit|submit application|complete application|finish application|confirm and submit|publish application|submit$/i
const QUOTA_FINAL_CONTEXT =
  /温馨提示|慎重选择|本月.{0,12}(能|可|还可|还能).{0,12}(申请|投递).{0,12}(职位|岗位)|每月.{0,12}(申请|投递)|申请名额|投递名额|申请次数|投递次数|application quota|application limit|submission quota|submission limit/i
const QUOTA_CONFIRM_ACTION = /^(投递|申请|确认|继续|submit|apply|confirm|continue)$/i
const SAVE_DRAFT_TEXT = /保存草稿|保存简历|保存申请|暂存|save draft|save resume|save application/i

export function inferActionIntent(input: ActionIntentInput): ActionIntent {
  const text = actionTextFor(input)
  const combinedText = normalized([text, input.contextText].filter(Boolean).join(' '))

  if (OBSERVE_TOOLS.has(input.toolName)) return 'observe'

  if (CAPTCHA_TEXT.test(text)) return 'safety_sensitive'
  if (LOGIN_TEXT.test(text) && !FINAL_SUBMIT_TEXT.test(text)) return 'safety_sensitive'
  if (input.toolName === 'browser_upload_file') return 'safety_sensitive'
  if (CLICK_TOOLS.has(input.toolName) && UPLOAD_TEXT.test(text)) return 'safety_sensitive'
  if (CLICK_TOOLS.has(input.toolName) && QUOTA_CONFIRM_ACTION.test(text) && QUOTA_FINAL_CONTEXT.test(combinedText)) return 'safety_sensitive'
  if (FINAL_SUBMIT_TEXT.test(text)) return 'safety_sensitive'
  if (SAVE_DRAFT_TEXT.test(text)) return 'safety_sensitive'
  if (STATE_CHANGE_TOOLS.has(input.toolName)) return isHighRisk(input.risk) ? 'unknown_high_risk' : 'state_change'

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
  parts.push(stringValue(args.label))
  parts.push(stringValue(args.name))
  parts.push(stringValue(args.placeholder))
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
