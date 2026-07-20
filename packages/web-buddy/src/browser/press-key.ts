import type { Keyboard } from 'playwright'
import { toolFailure, toolSuccess } from '../errors.js'
import { resolveRefWithSnapshotRetry } from '../snapshot/ref-resolver.js'
import { sessionManager } from '../session/manager.js'
import { clearHighlight, visualizeBeforeAction } from '../sdk/highlight.js'

const ALLOWED_KEYS = new Set([
  'Enter',
  'Escape',
  'Tab',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'PageUp',
  'PageDown',
  'Home',
  'End',
  'Backspace',
  'Delete',
  'Space',
] satisfies Keyboard['press']['arguments'])

function isHeadful(): boolean {
  return process.env.PLAYWRIGHT_HEADLESS === 'false'
}

export async function browserPressKey(input: {
  key: string
  ref?: string
  sessionId?: string
  timeoutMs?: number
  highlight?: boolean
}) {
  const session = sessionManager.get(input.sessionId)
  if (!session) {
    return toolFailure('SESSION_NOT_FOUND', 'No browser session found. Call browser_open first.', {
      suggestedNextActions: ['browser_open'],
    })
  }

  if (typeof input.key !== 'string') {
    return toolFailure('INVALID_ARGUMENT', 'Key must be a string from the supported key allowlist.', {
      recoverable: false,
      suggestedNextActions: ['Use browser_press_key with one exact supported key string.'],
    })
  }
  const key = normalizeKey(input.key)
  if (!ALLOWED_KEYS.has(key)) {
    return toolFailure('INVALID_ARGUMENT', `Unsupported key "${input.key}". Allowed keys: ${[...ALLOWED_KEYS].join(', ')}.`, {
      recoverable: true,
      suggestedNextActions: ['Use browser_type for text input.', 'Use browser_press_key only for navigation/action keys.'],
    })
  }

  const timeout = input.timeoutMs ?? Number(process.env.PLAYWRIGHT_ACTION_TIMEOUT_MS || 10000)

  try {
    let targetLabel = 'active element'
    if (input.ref) {
      const resolved = await resolveRefWithSnapshotRetry(session.page, session.latestSnapshot, input.ref, session.id)
      if (!resolved.ok) return resolved.failure
      const { locator, stored } = resolved
      targetLabel = `ref ${input.ref} (${stored.name || stored.text || stored.tag})`
      if (input.highlight && isHeadful()) await visualizeBeforeAction(session.page, locator, 'type')
      await locator.focus({ timeout })
    }

    await session.page.keyboard.press(key, { delay: key === 'Enter' ? 40 : 10 })
    await session.page.waitForTimeout(120).catch(() => {})
    if (input.highlight && isHeadful()) await clearHighlight(session.page)
    sessionManager.invalidateSnapshot(session.id)

    return toolSuccess(`Pressed ${key} on ${targetLabel}.`, {
      key,
      ref: input.ref,
      url: session.page.url(),
    }, true)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (input.highlight && isHeadful()) await clearHighlight(session.page)
    return toolFailure('ELEMENT_NOT_FOUND', `Failed to press ${key}: ${message}`, {
      recoverable: true,
      suggestedNextActions: ['browser_snapshot'],
    })
  }
}

function normalizeKey(raw: string): string {
  const value = raw.trim()
  const lower = value.toLowerCase()
  if (lower === 'esc') return 'Escape'
  if (lower === 'spacebar' || lower === ' ') return 'Space'
  if (lower === 'uparrow') return 'ArrowUp'
  if (lower === 'downarrow') return 'ArrowDown'
  if (lower === 'leftarrow') return 'ArrowLeft'
  if (lower === 'rightarrow') return 'ArrowRight'
  if (lower === 'pageup') return 'PageUp'
  if (lower === 'pagedown') return 'PageDown'
  return value.length ? value[0].toUpperCase() + value.slice(1) : value
}
