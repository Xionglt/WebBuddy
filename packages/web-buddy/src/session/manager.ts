import { existsSync } from 'node:fs'
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
  type Request,
  type Route,
} from 'playwright'
import type { SnapshotRecord } from '../types.js'

export interface CreateSessionOptions {
  /** Path to a saved Playwright storageState (cookies + localStorage) for cookie login. */
  storageState?: string
  /** When a new tab/popup opens, make it the active page (default true). */
  adoptPopups?: boolean
  /** Record URL/title changes for trace + popup detection. */
  onPageChange?: (page: Page) => void
}

export interface BrowserSession {
  id: string
  context: BrowserContext
  /** The active page tools operate on. May be reassigned to a popup via adoptPage. */
  page: Page
  originHost?: string
  /** Exact scheme/host/port boundary committed by the last successful navigation. */
  origin?: string
  /** One explicit browser_open authorization, valid only for its exact origin. */
  pendingNavigationOrigin?: string
  pendingNavigationPage?: Page
  navigationActionSeq: number
  /** Pre-network denial waiting to be surfaced by the active tool call. */
  blockedNavigation?: BlockedNavigation
  latestSnapshot: SnapshotRecord | null
  /** All pages ever opened in this context (main + popups). */
  pages: Page[]
}

export interface BlockedNavigation {
  origin?: string
  reason: string
  actionSeq: number
}

let browser: Browser | null = null

async function getBrowser(): Promise<Browser> {
  if (!browser) {
    const headless = process.env.PLAYWRIGHT_HEADLESS !== 'false'
    const slowMo = Number(process.env.PLAYWRIGHT_SLOWMO_MS || 0)
    browser = await chromium.launch({ headless, ...(slowMo > 0 ? { slowMo } : {}) })
  }
  return browser
}

export class SessionManager {
  private sessions = new Map<string, BrowserSession>()
  private defaultSessionId = 'default'

  getDefaultSessionId() {
    return this.defaultSessionId
  }

  resolveSessionId(sessionId?: string) {
    return sessionId?.trim() || this.defaultSessionId
  }

  async getOrCreate(sessionId?: string, options: CreateSessionOptions = {}): Promise<BrowserSession> {
    const id = this.resolveSessionId(sessionId)
    const existing = this.sessions.get(id)
    if (existing) return existing

    const storageState =
      options.storageState ?? (process.env.PLAYWRIGHT_STORAGE_STATE || '')
    const adoptPopups = options.adoptPopups ?? true

    const b = await getBrowser()
    const contextOptions: Parameters<Browser['newContext']>[0] = {
      viewport: {
        width: Number(process.env.PLAYWRIGHT_VIEWPORT_WIDTH || 1280),
        height: Number(process.env.PLAYWRIGHT_VIEWPORT_HEIGHT || 840),
      },
      userAgent:
        process.env.PLAYWRIGHT_USER_AGENT ||
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      serviceWorkers: 'block',
    }
    if (storageState && existsSync(storageState)) {
      contextOptions.storageState = storageState
    }

    const context = await b.newContext(contextOptions)
    let session: BrowserSession | undefined
    await context.route('**/*', async (route) => {
      if (!session) {
        await route.continue()
        return
      }
      await enforceNavigationBoundary(session, route)
    })

    const page = await context.newPage()
    session = {
      id,
      context,
      page,
      latestSnapshot: null,
      pages: [page],
      navigationActionSeq: 0,
    }

    // Auto-adopt popups so the agent follows links that open new tabs/windows
    // (common for job-application flows). The main page stays in session.pages.
    const createdSession = session
    context.on('page', (newPage) => {
      createdSession.pages.push(newPage)
      observePageChanges(createdSession, newPage, options.onPageChange)
      if (adoptPopups) {
        newPage
          .waitForLoadState('domcontentloaded', { timeout: 30000 })
          .catch(() => {})
          .then(() => {
            const popupOrigin = exactOrigin(newPage.url())
            if (!popupOrigin || popupOrigin !== createdSession.origin) {
              void newPage.close().catch(() => {})
              return
            }
            createdSession.page = newPage
            this.invalidateSnapshot(id)
            options.onPageChange?.(newPage)
          })
      }
    })

    observePageChanges(createdSession, page, options.onPageChange)

    this.sessions.set(id, createdSession)
    return createdSession
  }

  /** Explicitly switch the active page (e.g. to a popup the scraper opened). */
  adoptPage(sessionId: string | undefined, page: Page) {
    const session = this.get(sessionId)
    if (!session) return
    const origin = exactOrigin(page.url())
    if (session.origin && origin !== session.origin) {
      session.latestSnapshot = null
      session.blockedNavigation = {
        ...(origin ? { origin } : {}),
        reason: 'Cross-origin page adoption was quarantined; use an explicit browser_open transition.',
        actionSeq: session.navigationActionSeq,
      }
      void page.close().catch(() => {})
      return
    }
    session.page = page
    if (!session.pages.includes(page)) session.pages.push(page)
    this.invalidateSnapshot(sessionId)
  }

  get(sessionId?: string): BrowserSession | null {
    const id = this.resolveSessionId(sessionId)
    return this.sessions.get(id) ?? null
  }

  setSnapshot(sessionId: string | undefined, snapshot: SnapshotRecord | null) {
    const session = this.get(sessionId)
    if (session) session.latestSnapshot = snapshot
  }

  invalidateSnapshot(sessionId?: string) {
    const session = this.get(sessionId)
    if (session) session.latestSnapshot = null
  }

  authorizeNavigation(sessionId: string | undefined, destinationOrigin: string): number {
    const session = this.get(sessionId)
    if (!session) throw new Error('Session not found; cannot authorize navigation.')
    session.navigationActionSeq += 1
    session.pendingNavigationOrigin = destinationOrigin
    session.pendingNavigationPage = session.page
    session.blockedNavigation = undefined
    return session.navigationActionSeq
  }

  commitNavigation(sessionId: string | undefined, url: string): void {
    const session = this.get(sessionId)
    if (!session) return
    const origin = exactOrigin(url)
    session.pendingNavigationOrigin = undefined
    session.pendingNavigationPage = undefined
    session.blockedNavigation = undefined
    if (!origin) return
    session.origin = origin
    session.originHost = new URL(url).hostname
  }

  cancelNavigation(sessionId: string | undefined): void {
    const session = this.get(sessionId)
    if (session) {
      session.pendingNavigationOrigin = undefined
      session.pendingNavigationPage = undefined
    }
  }

  beginNavigationAction(sessionId?: string): number {
    const session = this.get(sessionId)
    if (!session) return 0
    session.navigationActionSeq += 1
    session.blockedNavigation = undefined
    return session.navigationActionSeq
  }

  consumeBlockedNavigation(sessionId?: string, actionSeq?: number): BlockedNavigation | undefined {
    const session = this.get(sessionId)
    if (!session?.blockedNavigation) return undefined
    if (actionSeq !== undefined && session.blockedNavigation.actionSeq !== actionSeq) return undefined
    const blocked = session.blockedNavigation
    session.blockedNavigation = undefined
    return blocked
  }

  /** Persist cookies + localStorage so the next run skips login. */
  async saveAuth(sessionId: string | undefined, path: string): Promise<void> {
    const session = this.get(sessionId)
    if (!session) throw new Error('Session not found; cannot save auth.')
    await session.context.storageState({ path })
  }

  async close(sessionId?: string) {
    const id = this.resolveSessionId(sessionId)
    const session = this.sessions.get(id)
    if (!session) return
    await session.context.close()
    this.sessions.delete(id)
  }

  async closeAll() {
    for (const id of [...this.sessions.keys()]) {
      await this.close(id)
    }
    if (browser) {
      await browser.close()
      browser = null
    }
  }
}

export const sessionManager = new SessionManager()

async function enforceNavigationBoundary(session: BrowserSession, route: Route): Promise<void> {
  const request = route.request()
  const actionSeq = session.navigationActionSeq
  if (!isTopLevelNavigation(request)) {
    await route.continue()
    return
  }
  const origin = exactOrigin(request.url())
  if (!origin) {
    await blockNavigation(
      session,
      route,
      undefined,
      actionSeq,
      'A top-level navigation with an unsupported or opaque origin was blocked.',
    )
    return
  }
  const requestPage = pageForRequest(request)
  const explicitlyAuthorized = origin === session.pendingNavigationOrigin
    && requestPage !== undefined
    && requestPage === session.pendingNavigationPage
  if (explicitlyAuthorized || origin === session.origin) {
    await continueWithoutAutomaticRedirect(session, route, origin, actionSeq)
    return
  }
  await blockNavigation(
    session,
    route,
    origin,
    actionSeq,
    `Cross-origin navigation to ${origin} was blocked before the request left the browser.`,
  )
}

function isTopLevelNavigation(request: Request): boolean {
  if (!request.isNavigationRequest() || request.resourceType() !== 'document') return false
  try {
    const frame = request.frame()
    return frame === frame.page().mainFrame()
  } catch {
    // The initial request for a popup can precede creation of its Page/Frame.
    // Treat that narrow unknown case as top-level and fail closed by origin.
    return true
  }
}

function pageForRequest(request: Request): Page | undefined {
  try {
    return request.frame().page()
  } catch {
    return undefined
  }
}

function exactOrigin(url: string): string | undefined {
  try {
    const parsed = new URL(url)
    if (parsed.protocol === 'data:') return 'data:'
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined
    return parsed.origin
  } catch {
    return undefined
  }
}

async function continueWithoutAutomaticRedirect(
  session: BrowserSession,
  route: Route,
  approvedOrigin: string,
  actionSeq: number,
): Promise<void> {
  try {
    const response = await route.fetch({ maxRedirects: 0 })
    if (isRedirectStatus(response.status())) {
      const location = response.headers().location
      const redirectedOrigin = location
        ? exactOrigin(new URL(location, route.request().url()).toString())
        : undefined
      await blockNavigation(
        session,
        route,
        redirectedOrigin,
        actionSeq,
        `HTTP redirect from ${approvedOrigin} was stopped before following Location; authorize the next URL explicitly.`,
      )
      return
    }
    await route.fulfill({ response })
  } catch {
    await route.abort('failed')
  }
}

async function blockNavigation(
  session: BrowserSession,
  route: Route,
  origin: string | undefined,
  actionSeq: number,
  reason: string,
): Promise<void> {
  session.pendingNavigationOrigin = undefined
  session.pendingNavigationPage = undefined
  session.latestSnapshot = null
  session.blockedNavigation = {
    ...(origin ? { origin } : {}),
    reason,
    actionSeq,
  }
  await route.fulfill({
    status: 204,
    headers: {
      'cache-control': 'no-store',
      'x-web-buddy-navigation': 'blocked',
    },
  })
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308
}

function observePageChanges(
  session: BrowserSession,
  page: Page,
  onPageChange?: (page: Page) => void,
): void {
  page.on('framenavigated', (frame) => {
    if (frame !== page.mainFrame()) return
    const origin = exactOrigin(page.url())
    if (origin && (origin === session.origin || origin === session.pendingNavigationOrigin)) {
      session.origin = origin
      session.originHost = new URL(page.url()).hostname
    }
    onPageChange?.(page)
  })
}

process.on('SIGINT', () => {
  void sessionManager.closeAll().finally(() => process.exit(0))
})
process.on('SIGTERM', () => {
  void sessionManager.closeAll().finally(() => process.exit(0))
})
