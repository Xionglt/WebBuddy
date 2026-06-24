import { toolFailure, toolSuccess } from '../errors.js'
import { resolveRef } from '../snapshot/ref-resolver.js'
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
        const root = el.closest('label,[class*="form"],[class*="field"],[class*="item"],[class*="row"],[class*="select"],[class*="picker"]') || el.parentElement
        return normalize(root?.textContent).slice(0, 360)
      }
      const labelText = (el: Element) => [
        el.getAttribute('aria-label'),
        labelFor(el),
        (el as HTMLInputElement).placeholder,
        el.getAttribute('name'),
        el.getAttribute('id'),
        nearbyText(el),
      ]
        .map(normalize)
        .filter(Boolean)
        .join(' ')
      const matches = (value: string) => {
        const normalized = normalize(value).toLowerCase()
        return exactMatch ? normalized === target : normalized.includes(target)
      }
      const selector = [
        'select',
        '[role="combobox"]',
        '[role="button"]',
        '[aria-haspopup]',
        '[class*="select"]',
        '[class*="Select"]',
        '[class*="picker"]',
        '[class*="Picker"]',
        'input:not([type="hidden"]):not([type="file"])',
      ].join(',')
      const candidates = Array.from(document.querySelectorAll(selector)).filter(isVisible)
      const scored = candidates
        .map((el) => {
          const fullLabel = labelText(el)
          const matched = matches(fullLabel)
          const tag = el.tagName.toLowerCase()
          const role = el.getAttribute('role') || ''
          const direct = tag === 'select' || role === 'combobox' || el.getAttribute('aria-haspopup')
          return { el, fullLabel, matched, score: direct ? 0 : 1 }
        })
        .filter((item) => item.matched)
        .sort((a, b) => a.score - b.score || a.fullLabel.length - b.fullLabel.length)

      const selected = scored[targetIndex]?.el
      if (!selected) return null
      selected.setAttribute('data-mfa-select-label-target', markerValue)
      return {
        tag: selected.tagName.toLowerCase(),
        role: selected.getAttribute('role') || undefined,
        label: scored[targetIndex]?.fullLabel.slice(0, 220),
        totalMatches: scored.length,
      }
    },
    { label, exact, nth, marker },
  )
}

export async function browserSelectByText(input: {
  option: string
  sessionId?: string
  label?: string
  ref?: string
  exact?: boolean
  nth?: number
  optionNth?: number
  timeoutMs?: number
}) {
  const session = sessionManager.get(input.sessionId)
  if (!session) {
    return toolFailure('SESSION_NOT_FOUND', 'No browser session found. Call browser_open first.', {
      suggestedNextActions: ['browser_open'],
    })
  }

  const option = input.option.trim()
  if (!option) {
    return toolFailure('INVALID_ARGUMENT', 'browser_select_by_text requires non-empty option.', {
      recoverable: true,
      suggestedNextActions: ['browser_form_snapshot', 'browser_select_by_text'],
    })
  }

  const timeout = input.timeoutMs ?? Number(process.env.PLAYWRIGHT_ACTION_TIMEOUT_MS || 10000)
  const exact = input.exact ?? false
  let matchedLabel: string | undefined

  try {
    if (input.ref) {
      const resolved = await resolveRef(session.page, session.latestSnapshot, input.ref)
      if (!resolved.ok) return resolved.failure
      const { locator } = resolved
      const tagName = await locator.evaluate((el) => el.tagName.toLowerCase()).catch(() => '')
      if (tagName === 'select') {
        await locator.selectOption({ label: option }, { timeout }).catch(() => locator.selectOption(option, { timeout }))
        sessionManager.invalidateSnapshot(session.id)
        return toolSuccess(`Selected "${option}" on ref ${input.ref}.`, { option, ref: input.ref }, true)
      }
      await locator.click({ timeout })
    } else if (input.label) {
      const marker = `mfa-select-${Date.now()}-${Math.random().toString(36).slice(2)}`
      const match = await markControlByLabel(session.page, input.label, exact, input.nth ?? 0, marker)
      if (!match) {
        return toolFailure('ELEMENT_NOT_FOUND', `No selectable control matched label "${input.label}".`, {
          recoverable: true,
          suggestedNextActions: ['browser_form_snapshot', 'browser_select_by_text'],
        })
      }
      matchedLabel = match.label
      const locator = session.page.locator(`[data-mfa-select-label-target="${marker}"]`).first()
      if (match.tag === 'select') {
        await locator.selectOption({ label: option }, { timeout }).catch(() => locator.selectOption(option, { timeout }))
        await locator.evaluate((el) => el.removeAttribute('data-mfa-select-label-target')).catch(() => {})
        sessionManager.invalidateSnapshot(session.id)
        return toolSuccess(`Selected "${option}" for "${input.label}".`, { option, label: input.label, matchedLabel }, true)
      }
      await locator.click({ timeout })
      await locator.evaluate((el) => el.removeAttribute('data-mfa-select-label-target')).catch(() => {})
    }

    await session.page.waitForTimeout(250)
    const optionLocator = session.page.getByText(option, { exact }).nth(input.optionNth ?? 0)
    await optionLocator.waitFor({ timeout })
    await optionLocator.click({ timeout })
    sessionManager.invalidateSnapshot(session.id)

    return toolSuccess(`Selected visible option "${option}".`, {
      label: input.label,
      matchedLabel,
      option,
      optionNth: input.optionNth ?? 0,
      url: session.page.url(),
    }, true)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return toolFailure('ELEMENT_NOT_FOUND', `Failed to select visible option "${option}": ${message}`, {
      recoverable: true,
      suggestedNextActions: ['browser_form_snapshot', 'browser_select_by_text', 'browser_click_text'],
    })
  }
}
