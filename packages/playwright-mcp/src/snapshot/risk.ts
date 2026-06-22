import type { ElementRef } from '../types.js'

const SUBMIT_PATTERNS = [
  /submit/i,
  /apply/i,
  /application/i,
  /提交/,
  /投递/,
  /申请/,
  /递交/,
  /报名/,
  /send/i,
  /发送/,
  /confirm/i,
  /确认/,
  /pay/i,
  /支付/,
]

export function detectElementRisk(input: {
  tag: string
  role?: string
  name?: string
  text?: string
  typeAttr?: string | null
}): ElementRef['risk'] {
  const label = [input.name, input.text].filter(Boolean).join(' ')
  const isSubmitButton =
    input.tag === 'button' &&
    (input.typeAttr === 'submit' || SUBMIT_PATTERNS.some((p) => p.test(label)))
  const isSubmitInput = input.tag === 'input' && input.typeAttr === 'submit'

  if (isSubmitButton || isSubmitInput) return 'L3'

  if (input.tag === 'input') {
    const type = (input.typeAttr || 'text').toLowerCase()
    if (['password', 'file'].includes(type)) return 'L4'
    if (['email', 'tel', 'search', 'text', 'number', 'date'].includes(type)) return 'L2'
  }

  if (input.tag === 'select' || input.tag === 'textarea') return 'L2'

  if (input.role === 'textbox' || input.role === 'combobox' || input.role === 'searchbox') {
    return 'L2'
  }

  if (input.role === 'button' || input.tag === 'button' || input.tag === 'a') return 'L1'

  return 'L0'
}
