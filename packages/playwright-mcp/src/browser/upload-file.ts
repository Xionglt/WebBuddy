import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { toolFailure, toolSuccess } from '../errors.js'
import { resolveRef } from '../snapshot/ref-resolver.js'
import { sessionManager } from '../session/manager.js'
import { clearHighlight, visualizeBeforeAction } from '../sdk/highlight.js'

function isHeadful(): boolean {
  return process.env.PLAYWRIGHT_HEADLESS === 'false'
}

async function markVisibleText(page: import('playwright').Page, text: string, exact: boolean, nth: number, marker: string) {
  return page.evaluate(
    ({ text: targetText, exact: exactMatch, nth: targetIndex, marker: markerValue }) => {
      const normalize = (value: string) => value.replace(/\s+/g, ' ').trim()
      const target = normalize(targetText)
      const isVisible = (el: Element) => {
        const style = window.getComputedStyle(el)
        const rect = el.getBoundingClientRect()
        return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0
      }
      const matches = (el: Element) => {
        const textContent = normalize(el.textContent || '')
        if (!textContent || textContent.length > 800) return false
        return exactMatch ? textContent === target : textContent.includes(target)
      }
      const isClickable = (el: Element) => {
        const tag = el.tagName.toLowerCase()
        const role = el.getAttribute('role') || ''
        const style = window.getComputedStyle(el)
        return tag === 'a' || tag === 'button' || role === 'button' || (el as HTMLElement).onclick !== null || style.cursor === 'pointer'
      }
      const nearestClickable = (el: Element) => {
        let current: Element | null = el
        while (current && current !== document.body && current !== document.documentElement) {
          if (isVisible(current) && isClickable(current)) return current
          current = current.parentElement
        }
        return el
      }

      const matchesList = Array.from(document.querySelectorAll('body *'))
        .filter((el) => isVisible(el) && matches(el))
        .sort((a, b) => normalize(a.textContent || '').length - normalize(b.textContent || '').length)

      const targets: Element[] = []
      for (const el of matchesList) {
        const targetEl = nearestClickable(el)
        if (!targets.includes(targetEl)) targets.push(targetEl)
      }

      const selected = targets[targetIndex]
      if (!selected) return null
      selected.setAttribute('data-mfa-upload-target', markerValue)
      return {
        tag: selected.tagName.toLowerCase(),
        role: selected.getAttribute('role') || undefined,
        text: normalize(selected.textContent || '').slice(0, 180),
        totalMatches: targets.length,
      }
    },
    { text, exact, nth, marker },
  )
}

export async function browserUploadFile(input: {
  filePath: string
  sessionId?: string
  ref?: string
  text?: string
  selector?: string
  exact?: boolean
  nth?: number
  timeoutMs?: number
  confirmed?: boolean
  highlight?: boolean
}) {
  const session = sessionManager.get(input.sessionId)
  if (!session) {
    return toolFailure('SESSION_NOT_FOUND', 'No browser session found. Call browser_open first.', {
      suggestedNextActions: ['browser_open'],
    })
  }

  if (input.confirmed !== true) {
    return toolFailure('CONFIRMATION_REQUIRED', 'Uploading a resume or local file requires confirmed=true.', {
      recoverable: true,
      suggestedNextActions: ['Confirm the file upload is intended, then retry browser_upload_file with confirmed=true.'],
    })
  }

  const filePath = resolve(input.filePath)
  if (!existsSync(filePath)) {
    return toolFailure('INVALID_ARGUMENT', `File does not exist: ${filePath}`, {
      recoverable: true,
      suggestedNextActions: ['Check filePath and retry browser_upload_file.'],
    })
  }

  const timeout = input.timeoutMs ?? Number(process.env.PLAYWRIGHT_ACTION_TIMEOUT_MS || 10000)

  try {
    if (input.ref) {
      const resolved = await resolveRef(session.page, session.latestSnapshot, input.ref)
      if (!resolved.ok) return resolved.failure
      const { locator } = resolved
      const tagName = await locator.evaluate((el) => el.tagName.toLowerCase()).catch(() => '')
      const typeAttr = await locator.getAttribute('type').catch(() => '')
      if (tagName === 'input' && typeAttr === 'file') {
        await locator.setInputFiles(filePath, { timeout })
      } else {
        if (input.highlight && isHeadful()) await visualizeBeforeAction(session.page, locator, 'click_risky')
        const fileChooserPromise = session.page.waitForEvent('filechooser', { timeout })
        await locator.click({ timeout })
        const fileChooser = await fileChooserPromise
        await fileChooser.setFiles(filePath)
      }
      if (input.highlight && isHeadful()) await clearHighlight(session.page)
      sessionManager.invalidateSnapshot(session.id)
      return toolSuccess(`Uploaded file to ref ${input.ref}.`, { filePath, ref: input.ref, url: session.page.url() }, true)
    }

    if (input.selector) {
      const locator = session.page.locator(input.selector).first()
      const count = await locator.count()
      if (count === 0) {
        return toolFailure('ELEMENT_NOT_FOUND', `No element matched selector: ${input.selector}`, {
          recoverable: true,
          suggestedNextActions: ['browser_form_snapshot', 'browser_upload_file'],
        })
      }
      const tagName = await locator.evaluate((el) => el.tagName.toLowerCase()).catch(() => '')
      const typeAttr = await locator.getAttribute('type').catch(() => '')
      if (tagName === 'input' && typeAttr === 'file') {
        await locator.setInputFiles(filePath, { timeout })
      } else {
        const fileChooserPromise = session.page.waitForEvent('filechooser', { timeout })
        await locator.click({ timeout })
        const fileChooser = await fileChooserPromise
        await fileChooser.setFiles(filePath)
      }
      sessionManager.invalidateSnapshot(session.id)
      return toolSuccess(`Uploaded file via selector ${input.selector}.`, { filePath, selector: input.selector, url: session.page.url() }, true)
    }

    if (input.text) {
      const marker = `mfa-upload-${Date.now()}-${Math.random().toString(36).slice(2)}`
      const match = await markVisibleText(session.page, input.text, input.exact ?? false, input.nth ?? 0, marker)
      if (!match) {
        return toolFailure('ELEMENT_NOT_FOUND', `No visible upload trigger matched text "${input.text}".`, {
          recoverable: true,
          suggestedNextActions: ['browser_form_snapshot', 'browser_upload_file'],
        })
      }
      const locator = session.page.locator(`[data-mfa-upload-target="${marker}"]`).first()
      if (input.highlight && isHeadful()) await visualizeBeforeAction(session.page, locator, 'click_risky')
      const fileChooserPromise = session.page.waitForEvent('filechooser', { timeout })
      await locator.click({ timeout })
      const fileChooser = await fileChooserPromise
      await fileChooser.setFiles(filePath)
      if (input.highlight && isHeadful()) await clearHighlight(session.page)
      await locator.evaluate((el) => el.removeAttribute('data-mfa-upload-target')).catch(() => {})
      sessionManager.invalidateSnapshot(session.id)
      return toolSuccess(`Uploaded file via visible text "${input.text}".`, {
        filePath,
        text: input.text,
        matchedText: match.text,
        totalMatches: match.totalMatches,
        url: session.page.url(),
      }, true)
    }

    const fileInput = session.page.locator('input[type="file"]').first()
    if ((await fileInput.count()) > 0) {
      await fileInput.setInputFiles(filePath, { timeout })
      sessionManager.invalidateSnapshot(session.id)
      return toolSuccess('Uploaded file via first input[type=file].', {
        filePath,
        url: session.page.url(),
      }, true)
    }

    return toolFailure('ELEMENT_NOT_FOUND', 'No upload target was found. Provide ref, text, or selector after browser_form_snapshot.', {
      recoverable: true,
      suggestedNextActions: ['browser_form_snapshot', 'browser_upload_file'],
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (input.highlight && isHeadful()) await clearHighlight(session.page)
    return toolFailure('ELEMENT_NOT_FOUND', `Failed to upload file: ${message}`, {
      recoverable: true,
      suggestedNextActions: ['browser_form_snapshot', 'browser_upload_file'],
    })
  }
}
