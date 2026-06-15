import { validateNavigationUrl } from '../policy/navigation-guard.js'
import { toolFailure, toolSuccess } from '../errors.js'
import { sessionManager } from '../session/manager.js'

export async function browserOpen(input: {
  url: string
  sessionId?: string
  waitUntil?: 'load' | 'domcontentloaded' | 'networkidle'
}) {
  const session = await sessionManager.getOrCreate(input.sessionId)
  const guard = validateNavigationUrl(input.url, session.originHost)
  if (!guard.ok) {
    return toolFailure('NAVIGATION_BLOCKED', guard.reason, { recoverable: false })
  }

  try {
    await session.page.goto(guard.url.toString(), {
      waitUntil: input.waitUntil ?? 'domcontentloaded',
      timeout: Number(process.env.PLAYWRIGHT_NAVIGATION_TIMEOUT_MS || 30000),
    })
    session.originHost = guard.url.hostname
    sessionManager.invalidateSnapshot(session.id)

    const title = await session.page.title()
    return toolSuccess(`Opened ${guard.url.toString()} (${title})`, {
      sessionId: session.id,
      url: session.page.url(),
      title,
      originHost: session.originHost,
    }, true)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return toolFailure('TIMEOUT', `Failed to open page: ${message}`, {
      recoverable: true,
      suggestedNextActions: ['browser_wait', 'browser_open'],
    })
  }
}
