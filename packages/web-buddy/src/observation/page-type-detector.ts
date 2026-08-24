import type { FormState } from './form-state.js'
import type { PageState, PageType } from './page-state.js'

export interface PageTypeSignal {
  url?: string
  title?: string
  textSummary?: string
  interactiveCount?: number
  formCount?: number
  linkCount?: number
  buttonCount?: number
  inputCount?: number
  formState?: FormState
}

export function detectPageType(input: PageTypeSignal): PageType {
  const hay = [input.url, input.title, input.textSummary].filter(Boolean).join(' ').toLowerCase()
  const pageIdentity = [input.url, input.title].filter(Boolean).join(' ').toLowerCase()
  const bodyText = (input.textSummary ?? '').toLowerCase()
  const formState = input.formState
  const inputCount = input.inputCount ?? formState?.fields.length ?? 0
  const linkCount = input.linkCount ?? 0
  const buttonCount = input.buttonCount ?? 0
  const formCount = input.formCount ?? 0

  const hasPasswordField = formState?.fields.some((field) => field.type?.toLowerCase() === 'password') === true
  const hasLoginForm = hasPasswordField || (formCount > 0 && inputCount >= 2)
  const captchaText = /captcha|security check|人机验证|安全验证|滑块|verify you are human|robot check/
  const loginText = /sign in|log in|login|password|密码登录|账号登录|短信登录|验证码登录|sms code|统一认证|单点登录|请登录|登录后|登陆后|登入后/

  if (captchaText.test(pageIdentity) || (captchaText.test(bodyText) && inputCount > 0)) return 'captcha'
  if (loginText.test(pageIdentity) || (loginText.test(bodyText) && hasLoginForm)) return 'login'
  if (/提交成功|投递成功|申请成功|已提交|thank you|submitted|successfully submitted|confirmation/.test(hay)) {
    return 'confirmation'
  }
  if (formCount > 0 || inputCount >= 2 || (formState && formState.fields.length > 0)) return 'form'
  if (linkCount >= 8 || /列表|搜索结果|results|jobs|职位|岗位|筛选|filter|pagination|下一页/.test(hay)) return 'list'
  if (buttonCount > 0 || /详情|detail|description|岗位职责|职位描述|requirements|responsibilities/.test(hay)) return 'detail'
  return 'unknown'
}

export function detectPageTypeFromPageState(state: Omit<PageState, 'pageType' | 'updatedAt' | 'schemaVersion'>, formState?: FormState): PageType {
  return detectPageType({ ...state, formState })
}
