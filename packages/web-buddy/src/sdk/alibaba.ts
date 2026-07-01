import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from 'playwright'
import { browserOpen } from '../browser/open.js'
import { sessionManager } from '../session/manager.js'
import type { GateDecision, HumanGate } from './human.js'
import type { JobPosting } from './matcher.js'
import { tokenize } from './matcher.js'
import type { TraceRecorder } from './trace.js'
import { detectDirectSubmitReview, type DirectSubmitReview } from '../workflow/direct-submit.js'

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
  /** List page/batch URL where this card was observed; used as a safe click fallback when detailUrl is absent. */
  sourceListUrl?: string
}

export interface ScrapeJobListOptions {
  /** Maximum list pages/batches to scan. Defaults to one page for backwards compatibility. */
  maxPages?: number
  /** Maximum unique jobs to return across all pages. */
  maxJobs?: number
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

function normalizeDedupeKey(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ')
}

function positionIdFromUrl(url?: string): string | undefined {
  if (!url) return undefined
  try {
    return new URL(url).searchParams.get('positionId') || undefined
  } catch {
    return url.match(/positionId=([^&]+)/)?.[1]
  }
}

async function extractStructuredJobs(page: Page): Promise<Array<{
  title: string
  updated?: string
  category?: string
  location?: string
  positionId?: string
  detailUrl?: string
  tags?: string[]
}>> {
  return page.evaluate(() => {
    const clean = (value: string | null | undefined): string | undefined => {
      const text = (value || '').replace(/\s+/g, ' ').trim()
      return text || undefined
    }
    const absolute = (value: string | null | undefined): string | undefined => {
      if (!value) return undefined
      try { return new URL(value, location.href).toString() } catch { return undefined }
    }
    const textOf = (root: Element, selector: string): string | undefined =>
      clean(root.querySelector(selector)?.textContent)
    const attr = (root: Element, name: string): string | undefined => clean(root.getAttribute(name))
    const candidates = new Set<Element>()
    for (const selector of [
      '[data-job-card]',
      '[data-position-id]',
      '[data-job-id]',
      'article.job-card',
      '.job-card',
      'a[href*="position-detail"]',
      'a[href*="positionId"]',
    ]) {
      for (const el of Array.from(document.querySelectorAll(selector))) {
        let root: Element = el
        for (let depth = 0; depth < 4 && root.parentElement; depth += 1) {
          if (root.matches('[data-job-card],article.job-card,.job-card,[data-position-id]')) break
          const parent = root.parentElement
          if (parent.tagName === 'BODY' || parent.tagName === 'MAIN') break
          const parentText = clean(parent.textContent) || ''
          const rootText = clean(root.textContent) || ''
          if (
            parent.matches('[data-job-card],article,.job-card,[data-position-id]') ||
            (parentText.includes(rootText) && parentText.length < 600 && parent.children.length <= 8)
          ) {
            root = parent
          }
        }
        candidates.add(root)
      }
    }

    return Array.from(candidates).map((card, index) => {
      const link =
        card.querySelector<HTMLAnchorElement>('a[href*="position-detail"],a[href*="positionId"],a[href]') ||
        (card instanceof HTMLAnchorElement ? card : null)
      const title =
        attr(card, 'data-title') ||
        textOf(card, '[data-job-title]') ||
        textOf(card, '.job-title,.position-title') ||
        textOf(card, 'h1,h2,h3') ||
        clean(link?.textContent) ||
        clean(card.textContent)?.split(' 更新于')[0] ||
        `job-${index + 1}`
      const detailUrl =
        absolute(attr(card, 'data-detail-url')) ||
        absolute(attr(card, 'data-url')) ||
        absolute(link?.getAttribute('href')) ||
        undefined
      const positionId =
        attr(card, 'data-position-id') ||
        attr(card, 'data-job-id') ||
        (detailUrl ? new URL(detailUrl).searchParams.get('positionId') || undefined : undefined)
      const rawTags =
        attr(card, 'data-tags') ||
        attr(card, 'data-job-tags') ||
        textOf(card, '[data-job-tags],[data-tags]') ||
        ''
      return {
        title,
        updated: attr(card, 'data-updated') || textOf(card, '[data-updated]'),
        category: attr(card, 'data-category') || textOf(card, '[data-category],.category'),
        location: attr(card, 'data-location') || textOf(card, '[data-location],.location'),
        positionId,
        detailUrl,
        tags: rawTags.split(/[,\s，、]+/).map((tag) => tag.trim()).filter(Boolean),
      }
    }).filter((job) => clean(job.title))
  })
}

async function extractJobsOnCurrentPage(page: Page, pageIndex: number, offset: number): Promise<{ total: number; jobs: ScrapedJob[] }> {
  const structured = await extractStructuredJobs(page).catch(() => [])
  if (structured.length > 0) {
    const jobs = structured.map((job, index): ScrapedJob => {
      const positionId = job.positionId || positionIdFromUrl(job.detailUrl)
      const searchText = [job.title, job.category, job.location, job.updated, ...(job.tags || [])]
        .filter(Boolean)
        .join(' ')
      return {
        id: positionId ? `alibaba-${positionId}` : `alibaba-${pageIndex}-${offset + index + 1}`,
        title: job.title,
        category: job.category,
        location: job.location,
        updated: job.updated,
        detailUrl: job.detailUrl,
        positionId,
        searchText,
        tags: [...new Set([...(job.tags || []), ...tokenize(searchText)])],
      }
    })
    return { total: jobs.length, jobs }
  }

  const lines = await readLines(page)
  const { total, jobs } = parseList(lines)
  return {
    total,
    jobs: jobs.map((job, index) => {
      const searchText = [job.title, job.category, job.location, job.updated].filter(Boolean).join(' ')
      return {
        id: `alibaba-${pageIndex}-${offset + index + 1}`,
        title: job.title,
        category: job.category,
        location: job.location,
        updated: job.updated,
        searchText,
        tags: tokenize(searchText),
      }
    }),
  }
}

async function waitForListRender(page: Page): Promise<void> {
  await page
    .waitForFunction(
      () => {
        const text = document.body?.innerText || ''
        return (
          document.querySelector('[data-job-card],[data-position-id],.job-card,a[href*="positionId"]') ||
          (text.includes('在招职位') && text.includes('更新于'))
        )
      },
      null,
      { timeout: 25000 },
    )
    .catch(() => {})
}

async function goToNextListPage(page: Page, nextPageIndex: number): Promise<boolean> {
  const beforeUrl = page.url()
  for (const selector of [
    '[data-next-page]',
    'a[rel="next"]',
    'button[aria-label*="下一"]',
    'a:has-text("下一页")',
    'button:has-text("下一页")',
    'a:has-text("Next")',
    'button:has-text("Next")',
  ]) {
    const next = page.locator(selector).first()
    if ((await next.count().catch(() => 0)) === 0) continue
    const disabled = await next
      .evaluate((el) =>
        el.hasAttribute('disabled') ||
        el.getAttribute('aria-disabled') === 'true' ||
        /\bdisabled\b/i.test(el.className || ''),
      )
      .catch(() => false)
    if (disabled) continue

    const clicked = await next.click({ timeout: 10000 }).then(() => true).catch(() => false)
    if (!clicked) continue
    await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {})
    await page.waitForTimeout(300).catch(() => {})
    return true
  }

  try {
    const url = new URL(page.url())
    const key = ['page', 'pageNo', 'pageNum', 'currentPage'].find((name) => url.searchParams.has(name))
    if (!key) return false
    url.searchParams.set(key, String(nextPageIndex))
    if (url.toString() === beforeUrl) return false
    await page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: 20000 })
    return true
  } catch {
    return false
  }
}

function detailTitleMatches(expected: string, observed: string, detailText: string): boolean {
  const normalize = (value: string) => normalizeDedupeKey(value).replace(/[^\p{L}\p{N}]+/gu, '')
  const a = normalize(expected)
  const b = normalize(observed)
  if (!a || !b) return true
  return a.includes(b) || b.includes(a) || normalize(detailText).includes(a)
}

async function extractDetailIdentity(page: Page): Promise<{ positionId?: string; title?: string; titleSource?: string }> {
  const fromUrl = positionIdFromUrl(page.url())
  const dom = await page.evaluate(() => {
    const clean = (value: string | null | undefined): string | undefined => {
      const text = (value || '').replace(/\s+/g, ' ').trim()
      return text || undefined
    }
    const explicit =
      clean(document.querySelector('[data-job-title],.job-title,.position-title')?.textContent) ||
      clean(document.querySelector('h1,h2')?.textContent)
    const explicitNode = document.querySelector('[data-job-title],.job-title,.position-title')
    return {
      positionId:
        clean(document.querySelector('[data-position-id]')?.getAttribute('data-position-id')) ||
        clean(document.body?.getAttribute('data-position-id')) ||
        undefined,
      title: explicit,
      titleSource: explicitNode ? 'structured' : explicit ? 'heading' : undefined,
    }
  }).catch(() => ({ positionId: undefined, title: undefined, titleSource: undefined }))
  return {
    positionId: dom.positionId || fromUrl,
    title: dom.title,
    titleSource: dom.titleSource,
  }
}

export interface ScrapeListResult {
  total: number
  jobs: ScrapedJob[]
  pagesScanned?: number
  rawCount?: number
}

/** Open the position list and parse visible/multi-page cards into ScrapedJob list items. */
export async function scrapeJobList(
  sessionId: string,
  listUrl: string = DEFAULT_LIST_URL,
  trace?: TraceRecorder,
  options: ScrapeJobListOptions = {},
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
  const maxPages = Math.max(1, Math.floor(options.maxPages ?? 1))
  const maxJobs = Math.max(1, Math.floor(options.maxJobs ?? Number.MAX_SAFE_INTEGER))
  const scraped: ScrapedJob[] = []
  const seenIds = new Set<string>()
  const seenTitles = new Set<string>()
  let advertisedTotal = 0
  let rawCount = 0
  let pagesScanned = 0

  for (let pageIndex = 1; pageIndex <= maxPages && scraped.length < maxJobs; pageIndex += 1) {
    await waitForListRender(session.page)
    const pageResult = await extractJobsOnCurrentPage(session.page, pageIndex, scraped.length)
    const sourceListUrl = session.page.url()
    if (pageResult.total > advertisedTotal) advertisedTotal = pageResult.total
    rawCount += pageResult.jobs.length
    pagesScanned = pageIndex

    for (const job of pageResult.jobs) {
      job.sourceListUrl = sourceListUrl
      const idKey = job.positionId ? normalizeDedupeKey(job.positionId) : ''
      const titleKey = normalizeDedupeKey(job.title)
      if ((idKey && seenIds.has(idKey)) || seenTitles.has(titleKey)) continue
      if (idKey) seenIds.add(idKey)
      seenTitles.add(titleKey)
      scraped.push(job)
      if (scraped.length >= maxJobs) break
    }

    if (pageIndex >= maxPages || scraped.length >= maxJobs) break
    const moved = await goToNextListPage(session.page, pageIndex + 1)
    if (!moved) break
  }

  trace?.record({
    phase: 'scrape_list',
    action: `Fast list crawl parsed ${scraped.length} unique jobs from ${rawCount} raw cards across ${pagesScanned} page(s).`,
    url: session.page.url(),
    status: scraped.length > 0 ? 'ok' : 'warn',
    screenshotPath: await trace?.screenshot(session.page, 'job-list'),
    observation: scraped.slice(0, 8).map((j) => `• ${j.title}${j.positionId ? ` [${j.positionId}]` : ''}`).join('\n'),
  })

  return { total: advertisedTotal || scraped.length, jobs: scraped, pagesScanned, rawCount }
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

  let detailPage = session.page
  if (job.detailUrl) {
    const open = await browserOpen({ url: job.detailUrl, sessionId, waitUntil: 'domcontentloaded' })
    if (!open.ok) throw new Error(`Failed to open Alibaba detail page: ${open.error.message}`)
    detailPage = sessionManager.get(sessionId)?.page ?? detailPage
  } else {
    if (job.sourceListUrl && session.page.url() !== job.sourceListUrl) {
      const open = await browserOpen({ url: job.sourceListUrl, sessionId, waitUntil: 'domcontentloaded' })
      if (!open.ok) throw new Error(`Failed to return to source list page: ${open.error.message}`)
    }
    const { popup } = await clickJobCard(session.page, job.title)
    detailPage = popup || session.page
    sessionManager.adoptPage(sessionId, detailPage)
  }
  await detailPage.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {})
  await detailPage
    .waitForFunction(() => document.body?.innerText.includes('投递简历'), null, { timeout: 20000 })
    .catch(() => {})

  const detailUrl = detailPage.url()
  const detailText = await detailPage.locator('body').innerText().catch(() => '')
  const identity = await extractDetailIdentity(detailPage)
  const positionId = identity.positionId
  if (job.positionId && positionId && normalizeDedupeKey(job.positionId) !== normalizeDedupeKey(positionId)) {
    const message = `Detail identity mismatch for "${job.title}": list positionId=${job.positionId}, detail positionId=${positionId}.`
    trace?.record({ phase: 'scrape_detail', action: message, url: detailUrl, status: 'warn', observation: detailText.slice(0, 500) })
    throw new Error(message)
  }
  if (identity.title && !detailTitleMatches(job.title, identity.title, detailText)) {
    const message = `Detail title mismatch: expected "${job.title}", detail shows "${identity.title}".`
    trace?.record({ phase: 'scrape_detail', action: message, url: detailUrl, status: 'warn', observation: detailText.slice(0, 500) })
    throw new Error(message)
  }
  const lines = extractLines(detailText)
  const searchText = [job.title, job.category, job.location, lines.slice(0, 60).join(' ')]
    .filter(Boolean)
    .join(' ')
  const tags = [...new Set([...job.tags, ...tokenize(searchText)])]

  const enriched: ScrapedJob = {
    ...job,
    detailUrl,
    positionId: positionId || job.positionId,
    searchText,
    tags,
  }

  trace?.record({
    phase: 'scrape_detail',
    action: `Opened detail for "${job.title}" (${enriched.positionId || 'no id'}).`,
    url: detailUrl,
    status: 'ok',
    screenshotPath: await trace?.screenshot(detailPage, `detail-${enriched.positionId || job.title}`),
    observation: lines.slice(0, 12).join(' | '),
  })

  return { job: enriched, detailUrl, searchText, tags }
}

export interface ApplyAttempt {
  reachedLogin: boolean
  reachedForm: boolean
  directSubmitReview?: DirectSubmitReview
  detailUrl: string
  /** The page the application form/login appeared on (popup or main). */
  page: Page
  /** Human decision for entering the application flow. */
  gateDecision: GateDecision
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

  let detailPage = session.page
  if (job.detailUrl) {
    const open = await browserOpen({ url: job.detailUrl, sessionId, waitUntil: 'domcontentloaded' })
    if (!open.ok) throw new Error(`Failed to open Alibaba detail page: ${open.error.message}`)
    detailPage = sessionManager.get(sessionId)?.page ?? detailPage
  } else {
    if (job.sourceListUrl && session.page.url() !== job.sourceListUrl) {
      const open = await browserOpen({ url: job.sourceListUrl, sessionId, waitUntil: 'domcontentloaded' })
      if (!open.ok) throw new Error(`Failed to return to source list page: ${open.error.message}`)
    }
    const { popup } = await clickJobCard(session.page, job.title)
    detailPage = popup || session.page
    sessionManager.adoptPage(sessionId, detailPage)
  }
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

  const directBeforeApply = await detectAndRecordDirectSubmitReview(trace, detailPage)
  if (directBeforeApply) {
    sessionManager.adoptPage(sessionId, detailPage)
    return {
      reachedLogin: false,
      reachedForm: false,
      directSubmitReview: directBeforeApply,
      detailUrl,
      page: detailPage,
      gateDecision: 'takeover',
    }
  }

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
    return { reachedLogin: false, reachedForm: false, detailUrl, page: detailPage, gateDecision: decision }
  }

  // Click only the apply-entry button. Agreement checkboxes belong to the
  // final-submit boundary and are handled by direct-submit review detection.
  const applyBtn = detailPage.getByRole('button', { name: '投递简历' })
  if ((await applyBtn.count()) >= 1) {
    await applyBtn.click({ timeout: 10000 }).catch(() => {})
  }
  await detailPage.waitForTimeout(1500)

  const reachedLogin = await detectAlibabaLoginWall(detailPage)
  const directSubmitReview = reachedLogin ? undefined : await detectAndRecordDirectSubmitReview(trace, detailPage)
  const reachedForm =
    !reachedLogin &&
    !directSubmitReview &&
    (await countRealFillableControls(detailPage)) > 0

  trace.record({
    phase: 'apply',
    action: reachedLogin
      ? 'Login wall reached after apply click.'
      : directSubmitReview
        ? 'Direct-submit review reached after apply click.'
      : reachedForm
        ? 'Application form reached after apply click.'
        : 'Apply clicked; state unclear.',
    url: detailPage.url(),
    risk: reachedLogin ? 'L4' : 'L3',
    status: reachedLogin ? 'blocked' : 'ok',
    screenshotPath: await trace.screenshot(
      detailPage,
      reachedLogin ? 'apply-login-wall' : directSubmitReview ? 'apply-direct-submit-review' : 'apply-form',
    ),
  })

  sessionManager.adoptPage(sessionId, detailPage)
  return { reachedLogin, reachedForm, ...(directSubmitReview ? { directSubmitReview } : {}), detailUrl, page: detailPage, gateDecision: decision }
}

async function detectAndRecordDirectSubmitReview(
  trace: TraceRecorder,
  page: Page,
): Promise<DirectSubmitReview | undefined> {
  const review = await detectDirectSubmitReview(page).catch(() => undefined)
  if (!review) return undefined

  const artifactPath = writeDirectSubmitReviewArtifact(trace, review)
  trace.record({
    phase: 'apply',
    action: 'Detected direct-submit review boundary.',
    url: page.url(),
    risk: 'L4',
    status: 'ok',
    screenshotPath: await trace.screenshot(page, 'direct-submit-review'),
    observation: [
      review.userMessage,
      `signals=${JSON.stringify({
        realFillableFieldCount: review.signals.realFillableFieldCount,
        agreementCheckboxCount: review.signals.agreementCheckboxCount,
        noticeTextPresent: review.signals.noticeTextPresent,
        submitApplyButtonCount: review.signals.submitApplyButtonCount,
      })}`,
      artifactPath ? `artifact=${artifactPath}` : '',
    ].filter(Boolean).join('\n'),
  })
  return review
}

function writeDirectSubmitReviewArtifact(trace: TraceRecorder, review: DirectSubmitReview): string | undefined {
  const content = `${JSON.stringify(review, null, 2)}\n`
  let path = trace.agentTrace?.writeArtifact('direct-submit-review.json', content)
  const legacyPath = join(trace.dir, 'direct-submit-review.json')
  try {
    writeFileSync(legacyPath, content)
    path = path || legacyPath
  } catch {
    // Artifact writing is diagnostic; the run should still finish.
  }
  trace.agentTrace?.recordEvent('direct_submit_review', { path, legacyPath, review })
  return path
}

async function countRealFillableControls(page: Page): Promise<number> {
  return page.evaluate(() => {
    const visible = (el: Element) => {
      const input = el as HTMLInputElement
      if (input.disabled || input.readOnly || el.getAttribute('aria-disabled') === 'true') return false
      const style = window.getComputedStyle(el)
      const rect = el.getBoundingClientRect()
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0
    }
    const controls = Array.from(document.querySelectorAll('input,textarea,select,[contenteditable="true"],[role="textbox"],[role="combobox"],[role="searchbox"]'))
    return controls.filter((el) => {
      if (!visible(el)) return false
      const input = el as HTMLInputElement
      const tag = el.tagName.toLowerCase()
      const type = (input.type || el.getAttribute('type') || (tag === 'input' ? 'text' : '')).toLowerCase()
      if (['hidden', 'button', 'submit', 'reset', 'image', 'checkbox', 'radio'].includes(type)) return false
      return tag === 'input' || tag === 'textarea' || tag === 'select' || Boolean(el.getAttribute('role')) || el.getAttribute('contenteditable') === 'true'
    }).length
  }).catch(() => 0)
}

export async function detectAlibabaLoginWall(page: Page): Promise<boolean> {
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

export async function waitForAlibabaLoginClear(page: Page, timeoutMs = 30000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!(await detectAlibabaLoginWall(page))) return true
    await page.waitForTimeout(1000).catch(() => {})
  }
  return !(await detectAlibabaLoginWall(page))
}
