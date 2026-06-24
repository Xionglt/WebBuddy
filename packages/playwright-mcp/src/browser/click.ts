import { toolFailure, toolSuccess } from '../errors.js'
import { resolveRef } from '../snapshot/ref-resolver.js'
import { sessionManager } from '../session/manager.js'
import { clearHighlight, visualizeBeforeAction } from '../sdk/highlight.js'

function isHeadful(): boolean {
  return process.env.PLAYWRIGHT_HEADLESS === 'false'
}

export async function browserClick(input: {
  ref: string
  sessionId?: string
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

  const resolved = await resolveRef(session.page, session.latestSnapshot, input.ref)
  if (!resolved.ok) return resolved.failure

  const { locator, stored } = resolved
  const timeout = input.timeoutMs ?? Number(process.env.PLAYWRIGHT_ACTION_TIMEOUT_MS || 10000)

  if (stored.risk === 'L3' && input.confirmed !== true) {
    return toolFailure('CONFIRMATION_REQUIRED', `Ref ${input.ref} (${stored.name || stored.text || stored.tag}) is high-risk and requires explicit user confirmation before clicking.`, {
      recoverable: true,
      suggestedNextActions: ['Ask the user to confirm this action, then retry browser_click with confirmed=true.'],
    })
  }

  if (input.highlight && isHeadful()) {
    const action = stored.risk === 'L3' || stored.risk === 'L4' ? 'click_risky' : 'click_safe'
    await visualizeBeforeAction(session.page, locator, action)
  }

  try {
    await locator.click({ timeout })
    if (input.highlight && isHeadful()) await clearHighlight(session.page)
    sessionManager.invalidateSnapshot(session.id)

    const riskNote = stored.risk === 'L3'
      ? ' High-risk submit-like element clicked. Confirm with user before proceeding.'
      : stored.risk === 'L4'
        ? ' Sensitive element clicked. Extra confirmation recommended.'
        : ''

    return toolSuccess(`Clicked ref ${input.ref} (${stored.name || stored.text || stored.tag}).${riskNote}`, {
      ref: input.ref,
      risk: stored.risk,
      url: session.page.url(),
    }, true)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (input.highlight && isHeadful()) await clearHighlight(session.page)
    return toolFailure('ELEMENT_NOT_FOUND', `Failed to click ref ${input.ref}: ${message}`, {
      recoverable: true,
      suggestedNextActions: ['browser_snapshot'],
    })
  }
}
