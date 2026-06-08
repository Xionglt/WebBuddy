import { toolFailure, toolSuccess } from '../errors.js'
import { sessionManager } from '../session/manager.js'

export async function browserWait(input: {
  sessionId?: string
  for?: 'load' | 'domcontentloaded' | 'networkidle' | 'url' | 'text' | 'ms'
  value?: string
  ms?: number
  timeoutMs?: number
}) {
  const session = sessionManager.get(input.sessionId)
  if (!session) {
    return toolFailure('SESSION_NOT_FOUND', 'No browser session found. Call browser_open first.', {
      suggestedNextActions: ['browser_open'],
    })
  }

  const mode = input.for ?? 'ms'
  const timeout = input.timeoutMs ?? Number(process.env.PLAYWRIGHT_ACTION_TIMEOUT_MS || 10000)

  try {
    switch (mode) {
      case 'load':
      case 'domcontentloaded':
      case 'networkidle':
        await session.page.waitForLoadState(mode, { timeout })
        break
      case 'url':
        if (!input.value) {
          return toolFailure('INVALID_ARGUMENT', 'browser_wait with for=url requires value.', { recoverable: true })
        }
        await session.page.waitForURL(input.value, { timeout })
        sessionManager.invalidateSnapshot(session.id)
        break
      case 'text':
        if (!input.value) {
          return toolFailure('INVALID_ARGUMENT', 'browser_wait with for=text requires value.', { recoverable: true })
        }
        await session.page.getByText(input.value, { exact: false }).first().waitFor({ timeout })
        break
      case 'ms':
      default:
        await session.page.waitForTimeout(input.ms ?? 1000)
        break
    }

    return toolSuccess(`Wait completed (${mode})`, {
      for: mode,
      url: session.page.url(),
      value: input.value,
      ms: input.ms,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return toolFailure('TIMEOUT', `Wait failed (${mode}): ${message}`, {
      recoverable: true,
      suggestedNextActions: ['browser_snapshot', 'browser_wait'],
    })
  }
}
