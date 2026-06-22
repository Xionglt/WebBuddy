import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { toolFailure, toolSuccess } from '../errors.js'
import { sessionManager } from '../session/manager.js'

export async function browserScreenshot(input: {
  sessionId?: string
  label?: string
  outDir?: string
  fullPage?: boolean
}) {
  const session = sessionManager.get(input.sessionId)
  if (!session) {
    return toolFailure('SESSION_NOT_FOUND', 'No browser session found. Call browser_open first.', {
      suggestedNextActions: ['browser_open'],
    })
  }

  const outDir = resolve(input.outDir || join(process.cwd(), 'output', 'screenshots'))
  mkdirSync(outDir, { recursive: true })
  const slug =
    (input.label || 'screenshot')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 48) || 'screenshot'
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const file = join(outDir, `${slug}-${stamp}.png`)

  try {
    await session.page.screenshot({ path: file, fullPage: input.fullPage ?? false })
    return toolSuccess(`Screenshot saved: ${file}`, {
      path: file,
      url: session.page.url(),
      fullPage: input.fullPage ?? false,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return toolFailure('PAGE_CRASHED', `Failed to capture screenshot: ${message}`, {
      recoverable: true,
      suggestedNextActions: ['browser_open', 'browser_wait'],
    })
  }
}
