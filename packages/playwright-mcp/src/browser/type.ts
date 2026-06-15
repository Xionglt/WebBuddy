import { toolFailure, toolSuccess } from '../errors.js'
import { resolveRef } from '../snapshot/ref-resolver.js'
import { sessionManager } from '../session/manager.js'

export async function browserType(input: {
  ref: string
  text: string
  sessionId?: string
  clear?: boolean
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
    if (input.clear !== false) {
      await locator.fill('', { timeout })
    }
    await locator.fill(input.text, { timeout })

    const preview = input.text.length > 50 ? `${input.text.slice(0, 50)}...` : input.text
    return toolSuccess(`Typed into ref ${input.ref} (${stored.name || stored.tag}): "${preview}"`, {
      ref: input.ref,
      risk: stored.risk,
      chars: input.text.length,
    }, true)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return toolFailure('ELEMENT_NOT_FOUND', `Failed to type into ref ${input.ref}: ${message}`, {
      recoverable: true,
      suggestedNextActions: ['browser_snapshot'],
    })
  }
}
