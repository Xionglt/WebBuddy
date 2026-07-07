import type { Locator } from 'playwright'

export interface ModalInterception {
  present: boolean
  text?: string
  controls: string[]
  reason?: string
}

export async function detectModalInterception(locator: Locator): Promise<ModalInterception> {
  return locator.evaluate((target) => {
    const normalize = (value: string | null | undefined) => (value || '').replace(/\s+/g, ' ').trim()
    const isVisible = (el: Element) => {
      const style = window.getComputedStyle(el)
      const rect = el.getBoundingClientRect()
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0
    }
    const dialogSelector = [
      'dialog[open]',
      '[role="dialog"]',
      '[role="alertdialog"]',
      '[aria-modal="true"]',
      '[class*="dialog" i]',
      '[class*="modal" i]',
      '[class*="dlg" i]',
    ].join(',')
    const dialogs = Array.from(document.querySelectorAll(dialogSelector)).filter(isVisible)
    if (dialogs.length === 0) return { present: false, controls: [] }

    const targetInsideDialog = dialogs.some((dialog) => dialog.contains(target))
    if (targetInsideDialog) return { present: false, controls: [] }

    const dialog = dialogs[dialogs.length - 1]
    const controls = Array.from(dialog.querySelectorAll('button,a,[role="button"],input[type="button"],input[type="submit"]'))
      .filter(isVisible)
      .map((control) => {
        const input = control as HTMLInputElement
        return normalize(control.textContent || input.value || control.getAttribute('aria-label'))
      })
      .filter(Boolean)
      .slice(0, 8)
    return {
      present: true,
      text: normalize(dialog.textContent).slice(0, 260),
      controls,
      reason: 'A visible modal/dialog is currently blocking clicks outside the dialog.',
    }
  }).catch(() => ({ present: false, controls: [] }))
}

