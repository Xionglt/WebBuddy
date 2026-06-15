import { existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { browserOpen } from '../browser/open.js'
import { sessionManager, type CreateSessionOptions } from '../session/manager.js'
import type { HumanGate } from '../sdk/human.js'
import type { TraceRecorder } from '../sdk/trace.js'

/** Default storage-state path for a site, e.g. output/auth/talent-holding.alibaba.com.json */
export function defaultAuthPath(url: string, outDir: string): string {
  let host = 'site'
  try {
    host = new URL(url).hostname
  } catch {
    host = url.replace(/[^a-z0-9.-]+/gi, '-').slice(0, 60) || 'site'
  }
  return `${outDir}/auth/${host}.json`
}

/** Heuristic: does the current page look like a login wall? */
async function looksLikeLogin(page: import('playwright').Page): Promise<boolean> {
  try {
    const url = page.url()
    if (/(^|[/?])login|\/sso|signin|passport/i.test(url)) return true
    return await page.evaluate(() => {
      const text = document.body?.innerText || ''
      const hasPwd = Boolean(document.querySelector('input[type="password"]'))
      const wantsLogin = /密码登录|短信登录|sign in|log in|登录|扫码登录/.test(text)
      return hasPwd || wantsLogin
    })
  } catch {
    return false
  }
}

export interface EnsureLoginOptions {
  sessionId: string
  url: string
  /** storageState file path. If it exists, cookies are reused. */
  storageStatePath: string
  gate: HumanGate
  trace: TraceRecorder
  /** Browser context options (viewport, ua, ...). */
  contextOptions?: CreateSessionOptions
  /** When true and no saved cookies, open the page and wait for a human to log in. */
  interactive: boolean
}

export interface EnsureLoginResult {
  loggedIn: boolean
  usedSavedCookies: boolean
}

/**
 * Establish a logged-in browser session for a site, preferring saved cookies
 * (storageState) so repeat runs need no manual login. If no cookies are saved
 * and interactive=true, open the page and hand off to the human to log in,
 * then persist the cookies for next time.
 */
export async function ensureLogin(opts: EnsureLoginOptions): Promise<EnsureLoginResult> {
  const { sessionId, url, storageStatePath, gate, trace } = opts
  const hasSavedCookies = existsSync(storageStatePath)

  // Try the saved-cookie path first.
  const session = await sessionManager.getOrCreate(sessionId, {
    ...opts.contextOptions,
    ...(hasSavedCookies ? { storageState: storageStatePath } : {}),
  })

  const open = await browserOpen({ url, sessionId, waitUntil: 'domcontentloaded' })
  if (!open.ok) {
    trace.record({ phase: 'login', action: `Open failed: ${open.error.message}`, url, status: 'error' })
    return { loggedIn: false, usedSavedCookies: hasSavedCookies }
  }

  await session.page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {})
  const looksLogin = await looksLikeLogin(session.page)

  if (hasSavedCookies && !looksLogin) {
    trace.record({
      phase: 'login',
      action: `Logged in via saved cookies (${storageStatePath}).`,
      url: session.page.url(),
      status: 'ok',
    })
    return { loggedIn: true, usedSavedCookies: true }
  }

  if (!opts.interactive) {
    trace.record({
      phase: 'login',
      action: hasSavedCookies ? 'Saved cookies expired / still on login wall.' : 'No saved cookies; not interactive.',
      url: session.page.url(),
      status: looksLogin ? 'blocked' : 'ok',
    })
    return { loggedIn: !looksLogin, usedSavedCookies: hasSavedCookies }
  }

  // Interactive hand-off: the human logs in in the visible window.
  const decision = await gate.confirm(
    'login',
    looksLogin
      ? 'A login wall is showing. Please LOG IN (and solve any captcha) in the browser window, then approve.'
      : 'Please confirm you are logged in to this site in the browser window.',
    { url: session.page.url(), risk: 'L4' },
  )
  trace.record({
    phase: 'login',
    action: `Interactive login hand-off → ${decision}.`,
    url: session.page.url(),
    risk: 'L4',
    status: decision === 'approve' ? 'ok' : 'blocked',
  })

  if (decision !== 'approve') {
    return { loggedIn: false, usedSavedCookies: hasSavedCookies }
  }

  // Persist cookies so the next run skips the manual login.
  try {
    mkdirSync(dirname(storageStatePath), { recursive: true })
    await sessionManager.saveAuth(sessionId, storageStatePath)
    trace.record({ phase: 'login', action: `Saved cookies to ${storageStatePath}.`, status: 'ok' })
  } catch (error) {
    trace.record({ phase: 'login', action: `Failed to save cookies: ${(error as Error).message}`, status: 'warn' })
  }

  const stillLogin = await looksLikeLogin(session.page)
  return { loggedIn: !stillLogin, usedSavedCookies: false }
}
