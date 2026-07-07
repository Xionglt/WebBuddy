import type { FormState } from '../observation/form-state.js'
import type { PageState } from '../observation/page-state.js'

export interface ActionableDialogSignals {
  page: PageState | undefined
  form: FormState | undefined
}

export function actionableDialogPresent(
  signals: ActionableDialogSignals,
): { present: boolean; controls: string[]; reason: string } {
  const labels = controlLabels(signals.form)
  const pageText = normalize([signals.page?.title, signals.page?.textSummary].filter(Boolean).join(' '))
  const controls = unique([
    ...labels.filter((label) => CONFIRM_TEXT.test(label) || CANCEL_TEXT.test(label)),
    ...textControls(pageText),
  ])
  const hasConfirm = controls.some((label) => CONFIRM_TEXT.test(label))
  const hasCancel = controls.some((label) => CANCEL_TEXT.test(label))
  const looksDialogLike = signals.page?.pageType === 'confirmation' || (hasConfirm && hasCancel && controls.length >= 2)
  if (!looksDialogLike || !hasConfirm || !hasCancel) {
    return { present: false, controls, reason: 'No visible confirm/cancel dialog controls were detected.' }
  }
  return {
    present: true,
    controls,
    reason: `Visible actionable dialog controls remain: ${controls.slice(0, 6).join(', ')}`,
  }
}

const CONFIRM_TEXT = /确认|提交|投递|确定|继续|apply|submit|confirm|continue/i
const CANCEL_TEXT = /取消|关闭|返回|cancel|close|back|dismiss/i

function controlLabels(form: FormState | undefined): string[] {
  return (form?.submitCandidates ?? [])
    .filter((candidate) => candidate.visible !== false)
    .map((candidate) => normalize(candidate.text))
    .filter(Boolean)
}

function textControls(text: string): string[] {
  const controls: string[] = []
  for (const match of text.matchAll(/确认|提交|投递|确定|继续|取消|关闭|返回|apply|submit|confirm|continue|cancel|close|back|dismiss/gi)) {
    controls.push(match[0])
  }
  return controls
}

function normalize(value: string | null | undefined): string {
  return (value || '').replace(/\s+/g, ' ').trim()
}

function unique(values: string[]): string[] {
  return [...new Set(values)]
}
