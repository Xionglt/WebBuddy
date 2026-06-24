import { toolFailure, toolSuccess } from '../errors.js'
import { resolveRef } from '../snapshot/ref-resolver.js'
import { sessionManager } from '../session/manager.js'
import { clearHighlight, visualizeBeforeAction } from '../sdk/highlight.js'

function isHeadful(): boolean {
  return process.env.PLAYWRIGHT_HEADLESS === 'false'
}

export async function browserType(input: {
  ref: string
  text: string
  sessionId?: string
  clear?: boolean
  timeoutMs?: number
  /** When true and headful, flash the field + type char-by-char so the fill is visible. */
  highlight?: boolean
  /** Per-character delay (ms) when highlight is on. */
  typeDelayMs?: number
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

  try {
    if (input.highlight && isHeadful()) {
      await visualizeBeforeAction(session.page, locator, 'type')
    }
    if (input.clear !== false) {
      await locator.fill('', { timeout })
    }
    if (input.highlight && isHeadful() && input.text.length > 0) {
      const delay = input.typeDelayMs ?? Number(process.env.PLAYWRIGHT_TYPE_DELAY_MS || 12)
      await locator.pressSequentially(input.text, { delay, timeout })
    } else {
      await locator.fill(input.text, { timeout })
    }
    if (input.highlight && isHeadful()) await clearHighlight(session.page)

    const preview = input.text.length > 50 ? `${input.text.slice(0, 50)}...` : input.text
    return toolSuccess(`Typed into ref ${input.ref} (${stored.name || stored.tag}): "${preview}"`, {
      ref: input.ref,
      risk: stored.risk,
      chars: input.text.length,
    }, true)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (input.highlight && isHeadful()) await clearHighlight(session.page)
    return toolFailure('ELEMENT_NOT_FOUND', `Failed to type into ref ${input.ref}: ${message}`, {
      recoverable: true,
      suggestedNextActions: ['browser_snapshot'],
    })
  }
}
