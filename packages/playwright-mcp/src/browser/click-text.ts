import { toolFailure, toolSuccess } from '../errors.js'
import { sessionManager } from '../session/manager.js'
import { clearHighlight, visualizeBeforeAction } from '../sdk/highlight.js'

const HIGH_RISK_TEXT = [
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

function isHeadful(): boolean {
  return process.env.PLAYWRIGHT_HEADLESS === 'false'
}

function textRisk(text: string): 'L1' | 'L3' {
  return HIGH_RISK_TEXT.some((pattern) => pattern.test(text)) ? 'L3' : 'L1'
}

export async function browserClickText(input: {
  text: string
  sessionId?: string
  exact?: boolean
  nth?: number
  timeoutMs?: number
  confirmed?: boolean
  /** When true and the browser is headful, flash an outline + move the mouse first. */
  highlight?: boolean
}) {
  const session = sessionManager.get(input.sessionId)
  if (!session) {
    return toolFailure('SESSION_NOT_FOUND', 'No browser session found. Call browser_open first.', {
      suggestedNextActions: ['browser_open'],
    })
  }

  const text = input.text.trim()
  if (!text) {
    return toolFailure('INVALID_ARGUMENT', 'browser_click_text requires non-empty text.', {
      recoverable: true,
      suggestedNextActions: ['browser_snapshot', 'browser_click_text'],
    })
  }

  const risk = textRisk(text)
  if (risk === 'L3' && input.confirmed !== true) {
    return toolFailure('CONFIRMATION_REQUIRED', `Visible text "${text}" looks submit-like and requires confirmed=true before clicking.`, {
      recoverable: true,
      suggestedNextActions: ['Ask the user to confirm this action, then retry browser_click_text with confirmed=true.'],
    })
  }

  const marker = `mfa-click-text-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const nth = input.nth ?? 0
  const exact = input.exact ?? false
  const timeout = input.timeoutMs ?? Number(process.env.PLAYWRIGHT_ACTION_TIMEOUT_MS || 10000)

  try {
    const match = await session.page.evaluate(
      ({ marker: markerValue, text: targetText, exact: exactMatch, nth: targetIndex }) => {
        const normalize = (value: string) => value.replace(/\s+/g, ' ').trim()
        const target = normalize(targetText)
        const isVisible = (el: Element) => {
          const style = window.getComputedStyle(el)
          const rect = el.getBoundingClientRect()
          return (
            style.visibility !== 'hidden' &&
            style.display !== 'none' &&
            rect.width > 0 &&
            rect.height > 0
          )
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
          return (
            tag === 'a' ||
            tag === 'button' ||
            role === 'button' ||
            role === 'link' ||
            (el as HTMLElement).onclick !== null ||
            style.cursor === 'pointer' ||
            (el as HTMLElement).tabIndex >= 0
          )
        }
        const nearestClickable = (el: Element) => {
          let current: Element | null = el
          while (current && current !== document.body && current !== document.documentElement) {
            if (isVisible(current) && isClickable(current)) return current
            current = current.parentElement
          }
          return el
        }

        const matched = Array.from(document.querySelectorAll('body *'))
          .filter((el) => isVisible(el) && matches(el))
          .sort((a, b) => {
            const aText = normalize(a.textContent || '')
            const bText = normalize(b.textContent || '')
            return aText.length - bText.length
          })

        const uniqueTargets: Element[] = []
        for (const el of matched) {
          const targetEl = nearestClickable(el)
          if (!uniqueTargets.includes(targetEl)) uniqueTargets.push(targetEl)
        }

        const selected = uniqueTargets[targetIndex]
        if (!selected) {
          return null
        }

        selected.setAttribute('data-mfa-click-text-target', markerValue)
        const rect = selected.getBoundingClientRect()
        return {
          tag: selected.tagName.toLowerCase(),
          role: selected.getAttribute('role') || undefined,
          text: normalize(selected.textContent || '').slice(0, 180),
          href: (selected as HTMLAnchorElement).href || undefined,
          rect: {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
          },
          totalMatches: uniqueTargets.length,
        }
      },
      { marker, text, exact, nth },
    )

    if (!match) {
      return toolFailure('ELEMENT_NOT_FOUND', `No visible text matched "${text}".`, {
        recoverable: true,
        suggestedNextActions: ['browser_snapshot', 'browser_wait', 'browser_click_text'],
      })
    }

    const locator = session.page.locator(`[data-mfa-click-text-target="${marker}"]`).first()
    if (input.highlight && isHeadful()) {
      await visualizeBeforeAction(session.page, locator, risk === 'L3' ? 'click_risky' : 'click_safe')
    }

    await locator.click({ timeout })
    if (input.highlight && isHeadful()) await clearHighlight(session.page)
    sessionManager.invalidateSnapshot(session.id)

    return toolSuccess(`Clicked visible text "${text}" (${match.tag}${match.role ? ` role=${match.role}` : ''}).`, {
      text,
      exact,
      nth,
      risk,
      matchedText: match.text,
      totalMatches: match.totalMatches,
      url: session.page.url(),
    }, true)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (input.highlight && isHeadful()) await clearHighlight(session.page)
    return toolFailure('ELEMENT_NOT_FOUND', `Failed to click visible text "${text}": ${message}`, {
      recoverable: true,
      suggestedNextActions: ['browser_snapshot', 'browser_click_text'],
    })
  } finally {
    await session.page
      .locator(`[data-mfa-click-text-target="${marker}"]`)
      .evaluateAll((nodes) => nodes.forEach((node) => node.removeAttribute('data-mfa-click-text-target')))
      .catch(() => {})
  }
}
