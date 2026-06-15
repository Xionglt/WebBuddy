import type { Page } from 'playwright'
import { browserOpen } from '../browser/open.js'
import { sessionManager } from '../session/manager.js'
import type { HumanGate } from './human.js'
import type { JobPosting } from './matcher.js'
import { tokenize } from './matcher.js'
import type { TraceRecorder } from './trace.js'

/**
 * Alibaba (talent-holding) careers scraper built on top of the browser tools.
 *
 * IMPORTANT: this module only READS. It opens the position list and the
 * position-detail page and extracts structured data. It NEVER clicks the
 * 投递简历 (apply) button — entering the application flow is the orchestrator's
 * responsibility and is gated behind a human confirmation.
 */

const DEFAULT_LIST_URL = 'https://talent-holding.alibaba.com/off-campus/position-list?lang=zh'

export interface ScrapedJob extends JobPosting {
  detailUrl?: string
  positionId?: string
}

function extractLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

interface ParsedList {
  total: number
  jobs: Array<{ title: string; updated?: string; category?: string; location?: string }>
}

/** Parse the position-list body text into cards. Mirrors the proven probe logic. */
function parseList(lines: string[]): ParsedList {
  const jobs: ParsedList['jobs'] = []
  const totalLine = lines.find((line) => /在招职位.*共\d+个岗位/.test(line)) || ''
  const total = Number(totalLine.match(/共(\d+)个岗位/)?.[1] || 0)
  const start = lines.findIndex((line) => line.includes('在招职位'))

  for (let index = Math.max(start + 1, 0); index < lines.length - 3; index += 1) {
    const title = lines[index]
    const updated = lines[index + 1]
    if (title === '你可能有兴趣的职位' || /^\d+\/\d+$/.test(title)) break
    if (!updated?.startsWith('更新于')) continue

    jobs.push({
      title,
      updated,
      category: lines[index + 2] || '',
      location: lines[index + 3] || '',
    })
    index += 3
  }
  return { total, jobs }
}

async function readLines(page: Page): Promise<string[]> {
  return extractLines(await page.locator('body').innerText({ timeout: 15000 }))
}

/** Click a job card by walking the DOM to the nearest clickable ancestor. */
async function clickJobCard(page: Page, title: string): Promise<{ popup: Page | null }> {
  const popupPromise = page.waitForEvent('popup', { timeout: 10000 }).catch(() => null)
  await page.evaluate((jobTitle) => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT)
    let node: Element | null
    while ((node = walker.nextNode())) {
      if ((node.textContent || '').trim() !== jobTitle) continue
      let current: Element | null = node
      for (let depth = 0; current && depth < 6; depth += 1, current = current.parentElement) {
        const style = window.getComputedStyle(current)
        if ((current as HTMLElement).onclick || style.cursor === 'pointer') {
          ;(current as HTMLElement).click()
          return
        }
      }
    }
  }, title)
  const popup = await popupPromise
  return { popup }
}

export interface ScrapeListResult {
  total: number
  jobs: ScrapedJob[]
}

/** Open the position list and parse every visible card into a ScrapedJob. */
export async function scrapeJobList(
  sessionId: string,
  listUrl: string = DEFAULT_LIST_URL,
  trace?: TraceRecorder,
): Promise<ScrapeListResult> {
  const open = await browserOpen({ url: listUrl, sessionId, waitUntil: 'domcontentloaded' })
  if (!open.ok) {
    trace?.record({
      phase: 'scrape_list',
      action: `Open list failed: ${open.error.message}`,
      url: listUrl,
      status: 'error',
      observation: open.error.message,
    })
    throw new Error(`Failed to open Alibaba list: ${open.error.message}`)
  }

  const session = sessionManager.get(sessionId)!
  // Wait for the list to actually render before reading text.
  await session.page
    .waitForFunction(
      () => {
        const text = document.body?.innerText || ''
        return text.includes('在招职位') && text.includes('更新于')
      },
      null,
      { timeout: 25000 },
    )
    .catch(() => {})

  const lines = await readLines(session.page)
  const { total, jobs } = parseList(lines)

  const scraped: ScrapedJob[] = jobs.map((job, i) => ({
    id: `alibaba-${i + 1}`,
    title: job.title,
    category: job.category,
    location: job.location,
    updated: job.updated,
    searchText: [job.title, job.category, job.location].filter(Boolean).join(' '),
    tags: tokenize([job.title, job.category, job.location].filter(Boolean).join(' ')),
  }))

  trace?.record({
    phase: 'scrape_list',
    action: `Parsed ${scraped.length} jobs (site advertises ${total}).`,
    url: session.page.url(),
    status: scraped.length > 0 ? 'ok' : 'warn',
    screenshotPath: await trace?.screenshot(session.page, 'job-list'),
    observation: scraped.slice(0, 5).map((j) => `• ${j.title}`).join('\n'),
  })

  return { total, jobs: scraped }
}

export interface ScrapeDetailResult {
  job: ScrapedJob
  detailUrl: string
  searchText: string
  tags: string[]
}

/** Open one job's detail page and enrich it with requirement text/tags. */
export async function scrapeJobDetail(
  sessionId: string,
  job: ScrapedJob,
  trace?: TraceRecorder,
): Promise<ScrapeDetailResult> {
  const session = sessionManager.get(sessionId)
  if (!session) throw new Error('Session not found. Call scrapeJobList first.')

  const { popup } = await clickJobCard(session.page, job.title)
  const detailPage = popup || session.page
  await detailPage.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {})
  await detailPage
    .waitForFunction(() => document.body?.innerText.includes('投递简历'), null, { timeout: 20000 })
    .catch(() => {})

  const detailUrl = detailPage.url()
  const positionId = detailUrl.match(/positionId=([^&]+)/)?.[1] || undefined
  const detailText = await detailPage.locator('body').innerText().catch(() => '')
  const lines = extractLines(detailText)
  const searchText = [job.title, job.category, job.location, lines.slice(0, 60).join(' ')]
    .filter(Boolean)
    .join(' ')
  const tags = [...new Set([...job.tags, ...tokenize(searchText)])]

  const enriched: ScrapedJob = {
    ...job,
    detailUrl,
    positionId,
    searchText,
    tags,
  }

  trace?.record({
    phase: 'scrape_detail',
    action: `Opened detail for "${job.title}" (${positionId || 'no id'}).`,
    url: detailUrl,
    status: 'ok',
    screenshotPath: await trace?.screenshot(detailPage, `detail-${positionId || job.title}`),
    observation: lines.slice(0, 12).join(' | '),
  })

  return { job: enriched, detailUrl, searchText, tags }
}

export interface ApplyAttempt {
  reachedLogin: boolean
  reachedForm: boolean
  detailUrl: string
  /** The page the application form/login appeared on (popup or main). */
  page: Page
}

/**
 * Enter the Alibaba application flow for one job: open its detail page, then —
 * only after a human gate — click the 投递简历 (apply) button. Detects whether
 * the result is a login wall or an application form. NEVER submits.
 *
 * This is the literal "enter the application flow" step (requirement #5). The
 * draft-filling that follows is handled by the orchestrator's form-fill module,
 * and only proceeds past a login wall the human has cleared manually.
 */
export async function attemptApply(
  sessionId: string,
  job: ScrapedJob,
  gate: HumanGate,
  trace: TraceRecorder,
): Promise<ApplyAttempt> {
  const session = sessionManager.get(sessionId)
  if (!session) throw new Error('Session not found. Call scrapeJobList first.')

  const { popup } = await clickJobCard(session.page, job.title)
  const detailPage = popup || session.page
  await detailPage.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {})
  await detailPage
    .waitForFunction(() => document.body?.innerText.includes('投递简历'), null, { timeout: 20000 })
    .catch(() => {})

  const detailUrl = detailPage.url()
  trace.record({
    phase: 'apply',
    action: `Opened detail "${job.title}" to enter application flow.`,
    url: detailUrl,
    status: 'ok',
    screenshotPath: await trace.screenshot(detailPage, 'apply-detail'),
  })

  // The apply click is high-risk — require a human gate first.
  const decision = await gate.confirm('high_risk_action', `Click 投递简历 to enter Alibaba's application flow for "${job.title}"?`, {
    url: detailUrl,
    risk: 'L3',
    detail: 'This opens the application flow. Login/captcha will then require you.',
  })
  if (decision !== 'approve') {
    trace.record({
      phase: 'apply',
      action: `Apply click skipped by human gate (${decision}).`,
      url: detailUrl,
      risk: 'L3',
      status: 'blocked',
    })
    return { reachedLogin: false, reachedForm: false, detailUrl, page: detailPage }
  }

  // Agree to the notice checkbox if present, then click apply.
  const checkbox = detailPage.locator('input[type="checkbox"]')
  if ((await checkbox.count()) === 1) {
    await checkbox.check({ force: true, timeout: 10000 }).catch(() => {})
  }
  const applyBtn = detailPage.getByRole('button', { name: '投递简历' })
  if ((await applyBtn.count()) >= 1) {
    await applyBtn.click({ timeout: 10000 }).catch(() => {})
  }
  await detailPage.waitForTimeout(1500)

  const reachedLogin = await detectLoginWallOn(detailPage)
  const reachedForm =
    !reachedLogin &&
    (await detailPage
      .locator('input,textarea,select')
      .count()
      .catch(() => 0)) > 0

  trace.record({
    phase: 'apply',
    action: reachedLogin
      ? 'Login wall reached after apply click.'
      : reachedForm
        ? 'Application form reached after apply click.'
        : 'Apply clicked; state unclear.',
    url: detailPage.url(),
    risk: reachedLogin ? 'L4' : 'L3',
    status: reachedLogin ? 'blocked' : 'ok',
    screenshotPath: await trace.screenshot(detailPage, reachedLogin ? 'apply-login-wall' : 'apply-form'),
  })

  return { reachedLogin, reachedForm, detailUrl, page: detailPage }
}

async function detectLoginWallOn(page: Page): Promise<boolean> {
  try {
    const url = page.url()
    if (/login|ssoLogin/i.test(url)) return true
    return await page.evaluate(() => {
      const text = document.body?.innerText || ''
      return (
        text.includes('密码登录') ||
        text.includes('短信登录') ||
        Boolean(document.querySelector('input[type="password"]'))
      )
    })
  } catch {
    return false
  }
}

