import type { Locator, Page } from 'playwright'

export type PostconditionOutcome =
  | 'navigation'
  | 'dialog_opened'
  | 'dialog_closed'
  | 'state_changed'
  | 'no_op'
  | 'uncertain'

export interface PostconditionSnapshot {
  url: string
  bodyTextHash: string
  interactiveCount: number
  dialogOpen: boolean
  focusedSelector: string | null
  targetChecked: boolean | null
  targetDisabled: boolean | null
  targetValue: string | null
  captureError?: string
}

export interface PostconditionResult {
  outcome: PostconditionOutcome
  before: PostconditionSnapshot
  after: PostconditionSnapshot
  changedSignals: string[]
}

export async function capturePostconditionSnapshot(
  page: Page,
  options: { targetLocator?: Locator; captureTargetState?: boolean } = {},
): Promise<PostconditionSnapshot> {
  const pageState = await page.evaluate(() => {
    const visibleText = (document.body?.innerText || '').replace(/\s+/g, ' ').trim()
    const isVisible = (el: Element) => {
      const style = window.getComputedStyle(el)
      const rect = el.getBoundingClientRect()
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0
    }
    const interactiveSelector = [
      'a[href]',
      'button',
      'input',
      'select',
      'textarea',
      '[role="button"]',
      '[role="link"]',
      '[contenteditable="true"]',
    ].join(',')
    const dialogSelector = [
      'dialog[open]',
      '[role="dialog"]',
      '[role="alertdialog"]',
      '[aria-modal="true"]',
      '.modal',
      '.dialog',
    ].join(',')
    const active = document.activeElement
    const focusedSelector = active && active !== document.body
      ? [
          active.tagName.toLowerCase(),
          active.id ? `#${active.id}` : '',
          active.getAttribute('name') ? `[name="${active.getAttribute('name')}"]` : '',
        ].join('')
      : null
    return {
      bodyTextHash: hashString(visibleText),
      interactiveCount: Array.from(document.querySelectorAll(interactiveSelector)).filter(isVisible).length,
      dialogOpen: Array.from(document.querySelectorAll(dialogSelector)).some(isVisible),
      focusedSelector,
    }

    function hashString(value: string): string {
      let hash = 0
      for (let index = 0; index < value.length; index += 1) {
        hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0
      }
      return String(hash >>> 0)
    }
  }).catch((error) => ({
    bodyTextHash: '',
    interactiveCount: -1,
    dialogOpen: false,
    focusedSelector: null,
    captureError: error instanceof Error ? error.message : String(error),
  }))

  const targetState = options.targetLocator && options.captureTargetState
    ? await readTargetState(options.targetLocator)
    : { targetChecked: null, targetDisabled: null, targetValue: null }

  return {
    url: page.url(),
    ...pageState,
    ...targetState,
  }
}

export function diffPostcondition(
  before: PostconditionSnapshot,
  after: PostconditionSnapshot,
): PostconditionResult {
  const changedSignals: string[] = []
  if (before.url !== after.url) changedSignals.push('url')
  if (before.captureError || after.captureError) changedSignals.push('captureError')
  if (before.dialogOpen !== after.dialogOpen) changedSignals.push('dialogOpen')
  if (before.targetChecked !== after.targetChecked) changedSignals.push('targetChecked')
  if (before.targetDisabled !== after.targetDisabled) changedSignals.push('targetDisabled')
  if (before.targetValue !== after.targetValue) changedSignals.push('targetValue')
  if (before.interactiveCount !== after.interactiveCount) changedSignals.push('interactiveCount')
  if (before.bodyTextHash !== after.bodyTextHash) changedSignals.push('bodyTextHash')
  if (before.focusedSelector !== after.focusedSelector) changedSignals.push('focusedSelector')

  const materialStateSignals = changedSignals.filter((signal) =>
    signal !== 'focusedSelector' && signal !== 'captureError'
  )
  let outcome: PostconditionOutcome = 'no_op'
  if (before.url !== after.url) {
    outcome = 'navigation'
  } else if (before.captureError || after.captureError) {
    outcome = 'uncertain'
  } else if (!before.dialogOpen && after.dialogOpen) {
    outcome = 'dialog_opened'
  } else if (before.dialogOpen && !after.dialogOpen) {
    outcome = 'dialog_closed'
  } else if (materialStateSignals.length > 0) {
    outcome = 'state_changed'
  } else if (changedSignals.length > 0) {
    outcome = 'uncertain'
  }

  return { outcome, before, after, changedSignals }
}

async function readTargetState(locator: Locator): Promise<Pick<PostconditionSnapshot, 'targetChecked' | 'targetDisabled' | 'targetValue'>> {
  try {
    return await locator.evaluate((el) => {
      const input = el as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
      const tag = el.tagName.toLowerCase()
      const type = (el.getAttribute('type') || '').toLowerCase()
      const checked = tag === 'input' && (type === 'checkbox' || type === 'radio')
        ? (input as HTMLInputElement).checked
        : null
      const disabled = 'disabled' in input ? Boolean(input.disabled) : el.getAttribute('aria-disabled') === 'true'
      const value = 'value' in input ? String(input.value ?? '') : null
      return {
        targetChecked: checked,
        targetDisabled: disabled,
        targetValue: value,
      }
    })
  } catch {
    return {
      targetChecked: null,
      targetDisabled: null,
      targetValue: null,
    }
  }
}
