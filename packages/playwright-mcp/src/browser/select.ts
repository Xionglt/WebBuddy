import { toolFailure, toolSuccess } from '../errors.js'
import { resolveRef } from '../snapshot/ref-resolver.js'
import { sessionManager } from '../session/manager.js'

export async function browserSelect(input: {
  ref: string
  value: string
  sessionId?: string
  timeoutMs?: number
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
    const tagName = await locator.evaluate((el) => el.tagName.toLowerCase())
    if (tagName === 'select') {
      await locator.selectOption(input.value, { timeout })
    } else {
      await locator.click({ timeout })
      await locator.fill(input.value, { timeout })
    }

    return toolSuccess(`Selected value "${input.value}" on ref ${input.ref} (${stored.name || stored.tag})`, {
      ref: input.ref,
      value: input.value,
      risk: stored.risk,
    }, true)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return toolFailure('ELEMENT_NOT_FOUND', `Failed to select on ref ${input.ref}: ${message}`, {
      recoverable: true,
      suggestedNextActions: ['browser_snapshot'],
    })
  }
}
