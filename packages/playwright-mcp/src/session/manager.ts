import { existsSync } from 'node:fs'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
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
  latestSnapshot: SnapshotRecord | null
  /** All pages ever opened in this context (main + popups). */
  pages: Page[]
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
    }
    if (storageState && existsSync(storageState)) {
      contextOptions.storageState = storageState
    }

    const context = await b.newContext(contextOptions)
    const page = await context.newPage()
    const session: BrowserSession = {
      id,
      context,
      page,
      latestSnapshot: null,
      pages: [page],
    }

    // Auto-adopt popups so the agent follows links that open new tabs/windows
    // (common for job-application flows). The main page stays in session.pages.
    context.on('page', (newPage) => {
      session.pages.push(newPage)
      if (adoptPopups) {
        newPage
          .waitForLoadState('domcontentloaded', { timeout: 30000 })
          .catch(() => {})
          .then(() => {
            session.page = newPage
            this.invalidateSnapshot(id)
            options.onPageChange?.(newPage)
          })
      }
    })

    page.on('framenavigated', () => options.onPageChange?.(page))

    this.sessions.set(id, session)
    return session
  }

  /** Explicitly switch the active page (e.g. to a popup the scraper opened). */
  adoptPage(sessionId: string | undefined, page: Page) {
    const session = this.get(sessionId)
    if (!session) return
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

process.on('SIGINT', () => {
  void sessionManager.closeAll().finally(() => process.exit(0))
})
process.on('SIGTERM', () => {
  void sessionManager.closeAll().finally(() => process.exit(0))
})
