import { toolFailure, toolSuccess } from '../errors.js'
import { sessionManager } from '../session/manager.js'

async function markControlByLabel(
  page: import('playwright').Page,
  label: string,
  exact: boolean,
  nth: number,
  marker: string,
) {
  return page.evaluate(
    ({ label: targetLabel, exact: exactMatch, nth: targetIndex, marker: markerValue }) => {
      const normalize = (value: string | null | undefined) => (value || '').replace(/\s+/g, ' ').trim()
      const target = normalize(targetLabel).toLowerCase()
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
      const nearbyText = (el: Element) => {
        const root = el.closest('label,[class*="form"],[class*="field"],[class*="item"],[class*="row"]') || el.parentElement
        return normalize(root?.textContent).slice(0, 360)
      }
      const labelText = (el: Element) => {
        const labelledBy = normalize(
          (el.getAttribute('aria-labelledby') || '')
            .split(/\s+/)
            .map((id) => document.getElementById(id)?.textContent || '')
            .join(' '),
        )
        return [
          el.getAttribute('aria-label'),
          labelledBy,
          labelFor(el),
          el.closest('label')?.textContent,
          (el as HTMLInputElement).placeholder,
          el.getAttribute('name'),
          el.getAttribute('id'),
          nearbyText(el),
        ]
          .map(normalize)
          .filter(Boolean)
          .join(' ')
      }
      const matches = (value: string) => {
        const normalized = normalize(value).toLowerCase()
        return exactMatch ? normalized === target : normalized.includes(target)
      }

      const controls = Array.from(
        document.querySelectorAll('input:not([type="hidden"]):not([type="file"]),textarea,[contenteditable="true"],[role="textbox"],[role="searchbox"],[role="combobox"]'),
      ).filter(isVisible)

      const scored = controls
        .map((el) => {
          const fullLabel = labelText(el)
          const direct = [
            el.getAttribute('aria-label'),
            labelFor(el),
            (el as HTMLInputElement).placeholder,
            el.getAttribute('name'),
            el.getAttribute('id'),
          ]
            .map(normalize)
            .some((value) => value && matches(value))
          const matched = matches(fullLabel)
          return {
            el,
            fullLabel,
            matched,
            score: direct ? 0 : matched ? 1 : 9,
          }
        })
        .filter((item) => item.matched)
        .sort((a, b) => a.score - b.score || a.fullLabel.length - b.fullLabel.length)

      const selected = scored[targetIndex]?.el
      if (!selected) return null
      selected.setAttribute('data-mfa-fill-label-target', markerValue)
      return {
        tag: selected.tagName.toLowerCase(),
        type: (selected as HTMLInputElement).type || selected.getAttribute('type') || undefined,
        role: selected.getAttribute('role') || undefined,
        label: scored[targetIndex]?.fullLabel.slice(0, 220),
        currentValue: 'value' in (selected as HTMLInputElement) ? String((selected as HTMLInputElement).value ?? '') : normalize(selected.textContent),
        totalMatches: scored.length,
      }
    },
    { label, exact, nth, marker },
  )
}

export async function browserFillByLabel(input: {
  label: string
  text: string
  sessionId?: string
  exact?: boolean
  nth?: number
  clear?: boolean
  timeoutMs?: number
}) {
  const session = sessionManager.get(input.sessionId)
  if (!session) {
    return toolFailure('SESSION_NOT_FOUND', 'No browser session found. Call browser_open first.', {
      suggestedNextActions: ['browser_open'],
    })
  }

  const label = input.label.trim()
  if (!label) {
    return toolFailure('INVALID_ARGUMENT', 'browser_fill_by_label requires non-empty label.', {
      recoverable: true,
      suggestedNextActions: ['browser_form_snapshot', 'browser_fill_by_label'],
    })
  }

  const marker = `mfa-fill-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const timeout = input.timeoutMs ?? Number(process.env.PLAYWRIGHT_ACTION_TIMEOUT_MS || 10000)

  try {
    const match = await markControlByLabel(session.page, label, input.exact ?? false, input.nth ?? 0, marker)
    if (!match) {
      return toolFailure('ELEMENT_NOT_FOUND', `No fillable control matched label "${label}".`, {
        recoverable: true,
        suggestedNextActions: ['browser_form_snapshot', 'browser_fill_by_label'],
      })
    }

    const locator = session.page.locator(`[data-mfa-fill-label-target="${marker}"]`).first()
    if (input.clear !== false) {
      await locator.fill('', { timeout }).catch(async () => {
        await locator.click({ timeout })
        await session.page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A')
        await session.page.keyboard.press('Backspace')
      })
    }
    await locator.fill(input.text, { timeout }).catch(async () => {
      await locator.click({ timeout })
      await session.page.keyboard.insertText(input.text)
    })
    await locator.evaluate((el) => el.removeAttribute('data-mfa-fill-label-target')).catch(() => {})
    sessionManager.invalidateSnapshot(session.id)

    const preview = input.text.length > 50 ? `${input.text.slice(0, 50)}...` : input.text
    return toolSuccess(`Filled "${label}" with "${preview}".`, {
      label,
      matchedLabel: match.label,
      totalMatches: match.totalMatches,
      chars: input.text.length,
      tag: match.tag,
      type: match.type,
      role: match.role,
    }, true)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return toolFailure('ELEMENT_NOT_FOUND', `Failed to fill "${label}": ${message}`, {
      recoverable: true,
      suggestedNextActions: ['browser_form_snapshot', 'browser_fill_by_label'],
    })
  }
}
