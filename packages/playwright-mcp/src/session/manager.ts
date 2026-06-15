import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import type { SnapshotRecord } from '../types.js'

export interface BrowserSession {
  id: string
  context: BrowserContext
  page: Page
  originHost?: string
  latestSnapshot: SnapshotRecord | null
}

let browser: Browser | null = null

async function getBrowser(): Promise<Browser> {
  if (!browser) {
    const headless = process.env.PLAYWRIGHT_HEADLESS !== 'false'
    browser = await chromium.launch({ headless })
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

  async getOrCreate(sessionId?: string): Promise<BrowserSession> {
    const id = this.resolveSessionId(sessionId)
    const existing = this.sessions.get(id)
    if (existing) return existing

    const b = await getBrowser()
    const context = await b.newContext({
      viewport: {
        width: Number(process.env.PLAYWRIGHT_VIEWPORT_WIDTH || 1280),
        height: Number(process.env.PLAYWRIGHT_VIEWPORT_HEIGHT || 800),
      },
      userAgent:
        process.env.PLAYWRIGHT_USER_AGENT ||
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    })
    const page = await context.newPage()
    const session: BrowserSession = {
      id,
      context,
      page,
      latestSnapshot: null,
    }
    this.sessions.set(id, session)
    return session
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
