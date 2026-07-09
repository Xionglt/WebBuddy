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
  /** ISO timestamp/date derived from Alibaba modifyTime/publishTime or card updated text. */
  updatedAt?: string
  /** Original list URL supplied to the crawler; used to replay SPA pagination from page 1. */
  sourceRootListUrl?: string
  /** List page/batch URL where this card was observed; used as a safe click fallback when detailUrl is absent. */
  sourceListUrl?: string
  /** 1-based list page/batch index where this card was observed. */
  sourcePageIndex?: number
  /** 1-based card index within the observed page/batch. */
  sourceCardIndex?: number
  /** Original title text observed on the list card. */
  sourceTitle?: string
  /** Lightweight diagnostic key for list replay artifacts/traces. */
  sourceListSnapshotKey?: string
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

/** Click a job card by walking the DOM to the nearest clickable ancestor/card root. */
async function clickJobCard(page: Page, job: Pick<ScrapedJob, 'title' | 'sourceTitle' | 'sourceCardIndex' | 'positionId'>): Promise<{ popup: Page | null; clicked: boolean }> {
  const popupPromise = page.waitForEvent('popup', { timeout: 2500 }).catch(() => null)
  const target = {
    title: job.title,
    sourceTitle: job.sourceTitle,
    sourceCardIndex: job.sourceCardIndex,
    positionId: job.positionId,
  }
  const clickPoint = await page.evaluate((target) => {
    const clean = (value: string | null | undefined): string => (value || '').replace(/\s+/g, ' ').trim()
    const compact = (value: string | null | undefined): string => clean(value).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
    const jobTitle = clean(target.sourceTitle || target.title)
    const titleNeedle = compact(jobTitle)
    const idNeedle = compact(target.positionId)
    const cardSelector = [
      '[data-job-card]',
      '[data-position-id]',
      '[data-job-id]',
      'article.job-card',
      '.job-card',
      '.position-card',
      '.position-item',
      '.job-list-item',
      '.job-item',
      'article',
    ].join(',')
    const titleMatches = (value: string | null | undefined): boolean => {
      const text = clean(value)
      const haystack = compact(text)
      if (!haystack || !titleNeedle) return false
      if (haystack === titleNeedle || haystack.includes(titleNeedle)) return true
      return titleNeedle.includes(haystack) && haystack.length >= Math.min(6, titleNeedle.length)
    }
    const idMatches = (el: Element): boolean => Boolean(idNeedle && compact(el.outerHTML.slice(0, 4000)).includes(idNeedle))
    const isLikelyTarget = (el: Element): boolean => titleMatches(el.textContent) || idMatches(el)
    const clickableDescendant = (el: Element): HTMLElement | null => {
      for (const selector of [
        'a[href*="position-detail"]',
        'a[href*="positionId"]',
        'a[href]',
        'button',
        '[role="link"]',
        '[role="button"]',
      ]) {
        const candidate = el.querySelector<HTMLElement>(selector)
        if (candidate) return candidate
      }
      return null
    }
    const resolveClickElement = (start: Element): HTMLElement | null => {
      let current: Element | null = start
      for (let depth = 0; current && depth < 10; depth += 1, current = current.parentElement) {
        const style = window.getComputedStyle(current)
        if (
          current instanceof HTMLAnchorElement ||
          current instanceof HTMLButtonElement ||
          current.getAttribute('role') === 'link' ||
          current.getAttribute('role') === 'button' ||
          (current as HTMLElement).onclick ||
          style.cursor === 'pointer' ||
          current.matches(cardSelector)
        ) {
          return current as HTMLElement
        }
      }
      return clickableDescendant(start) || (start instanceof HTMLElement ? start : null)
    }
    const pointFor = (start: Element): { x: number; y: number } | null => {
      const targetEl = resolveClickElement(start)
      if (!targetEl) return null
      targetEl.scrollIntoView({ block: 'center', inline: 'center' })
      const rect = targetEl.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) return null
      const x = Math.min(Math.max(rect.left + Math.min(rect.width / 2, Math.max(8, rect.width - 4)), 1), window.innerWidth - 1)
      const y = Math.min(Math.max(rect.top + rect.height / 2, 1), window.innerHeight - 1)
      return { x, y }
    }
    const tryElement = (el: Element | null | undefined): { x: number; y: number } | null => {
      if (!el || !isLikelyTarget(el)) return null
      return pointFor(el)
    }

    const textWalker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    let textNode: Node | null
    while ((textNode = textWalker.nextNode())) {
      if (!titleMatches(textNode.nodeValue)) continue
      const point = pointFor(textNode.parentElement!)
      if (point) return point
    }

    const preferredSelectors = [
      '[data-job-title]',
      '.job-title',
      '.position-title',
      '[class*="title"]',
      'h1',
      'h2',
      'h3',
      'h4',
      'a',
      'button',
      '[role="link"]',
      '[role="button"]',
      '[data-job-card]',
      '.job-card',
      'article',
    ]
    for (const selector of preferredSelectors) {
      for (const node of Array.from(document.querySelectorAll(selector))) {
        const point = tryElement(node)
        if (point) return point
      }
    }

    const cards = Array.from(document.querySelectorAll(cardSelector))
    for (const card of cards) {
      const point = tryElement(card)
      if (point) return point
    }

    if (target.sourceCardIndex && target.sourceCardIndex > 0) {
      const indexed = cards[target.sourceCardIndex - 1]
      const point = indexed ? pointFor(indexed) : null
      if (point) return point
    }

    return null
  }, target)
  if (clickPoint) {
    await page.mouse.click(clickPoint.x, clickPoint.y)
    const popup = await popupPromise
    return { popup, clicked: true }
  }

  const clicked = await page.evaluate((target) => {
    const clean = (value: string | null | undefined): string => (value || '').replace(/\s+/g, ' ').trim()
    const compact = (value: string | null | undefined): string => clean(value).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
    const jobTitle = clean(target.sourceTitle || target.title)
    const titleNeedle = compact(jobTitle)
    const idNeedle = compact(target.positionId)
    const cardSelector = [
      '[data-job-card]',
      '[data-position-id]',
      '[data-job-id]',
      'article.job-card',
      '.job-card',
      '.position-card',
      '.position-item',
      '.job-list-item',
      '.job-item',
      'article',
    ].join(',')
    const titleMatches = (value: string | null | undefined): boolean => {
      const text = clean(value)
      const haystack = compact(text)
      if (!haystack || !titleNeedle) return false
      if (haystack === titleNeedle || haystack.includes(titleNeedle)) return true
      return titleNeedle.includes(haystack) && haystack.length >= Math.min(6, titleNeedle.length)
    }
    const idMatches = (el: Element): boolean => Boolean(idNeedle && compact(el.outerHTML.slice(0, 4000)).includes(idNeedle))
    const isLikelyTarget = (el: Element): boolean => titleMatches(el.textContent) || idMatches(el)
    const nearestCard = (el: Element): Element => el.closest(cardSelector) || el
    const clickableDescendant = (el: Element): HTMLElement | null => {
      for (const selector of [
        'a[href*="position-detail"]',
        'a[href*="positionId"]',
        'a[href]',
        'button',
        '[role="link"]',
        '[role="button"]',
      ]) {
        const candidate = el.querySelector<HTMLElement>(selector)
        if (candidate) return candidate
      }
      return null
    }
    const clickCandidate = (start: Element): boolean => {
      const roots = [start, nearestCard(start)]
      for (const root of roots) {
        const child = clickableDescendant(root)
        if (child) {
          child.scrollIntoView({ block: 'center', inline: 'center' })
          child.click()
          return true
        }
      }

      let current: Element | null = start
      for (let depth = 0; current && depth < 10; depth += 1, current = current.parentElement) {
        const style = window.getComputedStyle(current)
        if (
          current instanceof HTMLAnchorElement ||
          current instanceof HTMLButtonElement ||
          current.getAttribute('role') === 'link' ||
          current.getAttribute('role') === 'button' ||
          (current as HTMLElement).onclick ||
          style.cursor === 'pointer' ||
          current.matches(cardSelector)
        ) {
          current.scrollIntoView({ block: 'center', inline: 'center' })
          ;(current as HTMLElement).click()
          return true
        }
      }
      return false
    }
    const preferredSelectors = [
      '[data-job-title]',
      '.job-title',
      '.position-title',
      '[class*="title"]',
      'h1',
      'h2',
      'h3',
      'h4',
      'a',
      'button',
      '[role="link"]',
      '[role="button"]',
      '[data-job-card]',
      '.job-card',
      'article',
    ]
    for (const selector of preferredSelectors) {
      for (const node of Array.from(document.querySelectorAll(selector))) {
        if (isLikelyTarget(node) && clickCandidate(node)) return true
      }
    }

    const cards = Array.from(document.querySelectorAll(cardSelector))
      .filter((node) => isLikelyTarget(node))
    for (const card of cards) {
      if (clickCandidate(card)) return true
    }

    if (target.sourceCardIndex && target.sourceCardIndex > 0) {
      const indexed = Array.from(document.querySelectorAll(cardSelector))[target.sourceCardIndex - 1]
      if (indexed && clickCandidate(indexed)) return true
    }

    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT)
    let node = walker.nextNode()
    while (node) {
      if (node instanceof Element && isLikelyTarget(node) && clickCandidate(node)) return true
      node = walker.nextNode()
    }
    return false
  }, target)
  const popup = clicked ? await popupPromise : null
  return { popup, clicked }
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

interface StructuredListJob {
  title: string
  updated?: string
  updatedAt?: string
  category?: string
  location?: string
  positionId?: string
  detailUrl?: string
  description?: string
  requirement?: string
  tags?: string[]
}

async function extractAlibabaApiJobs(page: Page, pageIndex: number): Promise<{ total: number; jobs: StructuredListJob[] }> {
  return page.evaluate(async ({ pageIndex }) => {
    const isAlibabaList =
      /(^|\.)alibaba\.com$/i.test(location.hostname) &&
      /\/off-campus\/position-list/i.test(location.pathname)
    if (!isAlibabaList) return { total: 0, jobs: [] }

    const absolute = (value: string | null | undefined): string | undefined => {
      if (!value) return undefined
      try { return new URL(value, location.href).toString() } catch { return undefined }
    }
    const clean = (value: unknown): string | undefined => {
      const text = String(value ?? '').replace(/\s+/g, ' ').trim()
      return text || undefined
    }
    const isoFromEpochMs = (value: unknown): string | undefined => {
      const timestamp = Number(value || 0)
      if (!Number.isFinite(timestamp) || timestamp <= 0) return undefined
      const date = new Date(timestamp)
      return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
    }
    const updatedLabelFromIso = (value: string | undefined): string | undefined =>
      value ? `更新于 ${value.slice(0, 10)}` : undefined
    const resourceUrl = performance
      .getEntriesByType('resource')
      .map((entry) => entry.name)
      .find((name) => name.includes('/position/search'))
    const endpoint = absolute(resourceUrl || '/position/search')
    if (!endpoint) return { total: 0, jobs: [] }

    const response = await fetch(endpoint, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        channel: 'group_official_site',
        language: new URLSearchParams(location.search).get('lang') || 'zh',
        batchId: '',
        categories: '',
        deptCodes: [],
        key: '',
        pageIndex,
        pageSize: 10,
        regions: '',
        subCategories: '',
        shareType: '',
        shareId: '',
        myReferralShareCode: '',
      }),
    }).catch(() => undefined)
    if (!response?.ok) return { total: 0, jobs: [] }

    const json = await response.json().catch(() => undefined)
    const datas = Array.isArray(json?.content?.datas) ? json.content.datas : []
    const total = Number(json?.content?.total || json?.content?.totalCount || datas.length || 0)
    return {
      total,
      jobs: datas.map((item: Record<string, unknown>) => {
        const id = clean(item.id)
        const positionUrl = clean(item.positionUrl)
        const categories = Array.isArray(item.categories) ? item.categories.map(clean).filter(Boolean) : []
        const locations = Array.isArray(item.workLocations) ? item.workLocations.map(clean).filter(Boolean) : []
        const tags = Array.isArray(item.tags) ? item.tags.map(clean).filter(Boolean) : []
        const updatedAt = isoFromEpochMs(item.modifyTime || item.publishTime)
        const updated = updatedLabelFromIso(updatedAt)
        return {
          title: clean(item.name) || `job-${id || ''}`,
          updated,
          updatedAt,
          category: categories.join(' / ') || undefined,
          location: locations.join(' / ') || undefined,
          positionId: id,
          detailUrl: absolute(positionUrl),
          description: clean(item.description),
          requirement: clean(item.requirement),
          tags: [...categories, ...locations, ...tags].filter(Boolean),
        }
      }).filter((job: StructuredListJob) => job.title && job.detailUrl),
    }
  }, { pageIndex }).catch(() => ({ total: 0, jobs: [] }))
}

async function extractStructuredJobs(page: Page): Promise<{ total: number; jobs: StructuredListJob[] }> {
  return page.evaluate(() => {
    const clean = (value: string | null | undefined): string | undefined => {
      const text = (value || '').replace(/\s+/g, ' ').trim()
      return text || undefined
    }
    const textParts = (root: Element): string[] => {
      const parts: string[] = []
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      let node = walker.nextNode()
      while (node) {
        const value = clean(node.nodeValue)
        if (value) parts.push(value)
        node = walker.nextNode()
      }
      return parts
    }
    const updatedAtFromText = (value: string | undefined): string | undefined => {
      const date = value?.match(/更新于\s*(\d{4}-\d{2}-\d{2})/)?.[1]
      return date ? `${date}T00:00:00.000Z` : undefined
    }
    const safeDecode = (value: string): string => {
      try { return decodeURIComponent(value) } catch { return value }
    }
    const absolute = (value: string | null | undefined): string | undefined => {
      if (!value) return undefined
      try { return new URL(value, location.href).toString() } catch { return undefined }
    }
    const textOf = (root: Element, selector: string): string | undefined =>
      clean(root.querySelector(selector)?.textContent)
    const attr = (root: Element, name: string): string | undefined => clean(root.getAttribute(name))
    const isAlibaba = /(^|\.)alibaba\.com$/i.test(location.hostname)
    const usefulDetailUrl = (url: string | undefined): string | undefined => {
      if (!url || /^javascript:/i.test(url) || /position-list/i.test(url)) return undefined
      if (isAlibaba && !/(position-detail|positionId|\/detail\/)/i.test(url)) return undefined
      return url
    }
    const attrNames = (root: Element): string[] => {
      try { return root.getAttributeNames() } catch { return [] }
    }
    const scopedValues = (root: Element): string[] => {
      const values: string[] = []
      let current: Element | null = root
      for (let depth = 0; current && depth < 4; depth += 1, current = current.parentElement) {
        for (const name of attrNames(current)) {
          const value = current.getAttribute(name)
          if (value) values.push(`${name}=${value}`)
        }
      }
      values.push(root.outerHTML.slice(0, 6000))
      return values
    }
    const findPositionId = (values: string[]): string | undefined => {
      for (const raw of values) {
        const value = safeDecode(raw)
        const match =
          value.match(/[?&#]positionId=([^&#"'<>\s]+)/i) ||
          value.match(/\bpositionId["'\s:=]+([^"',\s}<>]+)/i) ||
          value.match(/\bposition_id["'\s:=]+([^"',\s}<>]+)/i)
        const id = clean(match?.[1])
        if (id) return id
      }
      return undefined
    }
    const findDetailUrl = (values: string[]): string | undefined => {
      for (const raw of values) {
        const value = safeDecode(raw)
        const match =
          value.match(/https?:\/\/[^\s"'<>]*(?:position-detail|positionId)[^\s"'<>]*/i) ||
          value.match(/(?:\/|\.\/|\.\.\/)[^\s"'<>]*(?:position-detail|positionId)[^\s"'<>]*/i)
        const url = absolute(match?.[0])
        if (url) return url
      }
      return undefined
    }
    const explicitPositionId = (root: Element): string | undefined => {
      for (const name of ['data-position-id', 'data-positionid', 'data-job-id', 'data-jobid', 'position-id', 'positionid']) {
        const value = attr(root, name)
        if (value) return value
      }
      return undefined
    }
    const directUrl = (root: Element): string | undefined => {
      for (const name of ['data-detail-url', 'data-url', 'href', 'to', 'action']) {
        const value = usefulDetailUrl(absolute(attr(root, name)))
        if (value) return value
      }
      return undefined
    }
    const synthesizeAlibabaDetailUrl = (positionId?: string): string | undefined => {
      if (!positionId || !isAlibaba) return undefined
      const lang = new URLSearchParams(location.search).get('lang') || 'zh'
      const url = new URL('/off-campus/position-detail', location.origin)
      url.searchParams.set('positionId', positionId)
      url.searchParams.set('lang', lang)
      return url.toString()
    }
    const looksLikeCategory = (value: string | undefined): boolean =>
      Boolean(value && /类-|运营|风险管理|技术|产品|设计|数据|市场|销售|外贸|综合|客服|游戏|金融/.test(value))
    const looksLikeLocation = (value: string | undefined): boolean =>
      Boolean(value && /北京|杭州|上海|深圳|广州|成都|重庆|南京|武汉|西安|苏州|中国香港|\/| /.test(value) && !looksLikeCategory(value))
    const cardSelector = [
      '[data-job-card]',
      '[data-position-id]',
      '[data-job-id]',
      'article.job-card',
      '.job-card',
      '.position-card',
      '.position-item',
      '.job-list-item',
      '.job-item',
      'article',
    ].join(',')
    const promoteRoot = (el: Element): Element => {
      let root = el.closest(cardSelector) || el
      for (let depth = 0; depth < 4 && root.parentElement; depth += 1) {
        if (root.matches('[data-job-card],article.job-card,.job-card,.position-card,.position-item,.job-list-item,.job-item,[data-position-id]')) break
        const parent = root.parentElement
        if (parent.tagName === 'BODY' || parent.tagName === 'MAIN') break
        const parentText = clean(parent.textContent) || ''
        const rootText = clean(root.textContent) || ''
        if (
          parent.matches(cardSelector) ||
          (parentText.includes(rootText) && parentText.length < 1200 && parent.children.length <= 12)
        ) {
          root = parent
        }
      }
      return root
    }
    const candidates = new Set<Element>()
    for (const selector of [
      '[data-job-card]',
      '[data-position-id]',
      '[data-job-id]',
      '[data-positionid]',
      '[data-job-title]',
      'article.job-card',
      '.job-card',
      '.position-card',
      '.position-item',
      '.job-list-item',
      '.job-item',
      '.job-title',
      '.position-title',
      'a[href*="position-detail"]',
      'a[href*="positionId"]',
      'h2',
      'h3',
      'h4',
    ]) {
      for (const el of Array.from(document.querySelectorAll(selector))) {
        candidates.add(promoteRoot(el))
      }
    }
    const compactCardFor = (el: Element): Element | undefined => {
      let root: Element | undefined
      let current: Element | null = el
      for (let depth = 0; current && depth < 8; depth += 1, current = current.parentElement) {
        const text = clean(current.textContent) || ''
        const updateCount = text.match(/更新于\s*\d{4}-\d{2}-\d{2}/g)?.length || 0
        if (updateCount !== 1) continue
        if (/^更新于\s*\d{4}-\d{2}-\d{2}/.test(text) || text.length > 400) continue
        root = current
      }
      return root
    }
    for (const el of Array.from(document.querySelectorAll('*'))) {
      const text = clean(el.textContent) || ''
      if (!/更新于\s*\d{4}-\d{2}-\d{2}/.test(text)) continue
      const root = compactCardFor(el)
      if (root) candidates.add(root)
    }

    const bodyText = clean(document.body?.innerText) || ''
    const total = Number(bodyText.match(/在招职位\s*共\s*(\d+)\s*个岗位/)?.[1] || 0)
    const jobs = Array.from(candidates).map((card, index) => {
      const scoped = scopedValues(card)
      const link =
        card.querySelector<HTMLAnchorElement>('a[href*="position-detail"],a[href*="positionId"],a[href]') ||
        (card instanceof HTMLAnchorElement ? card : null)
      const linkUrl = usefulDetailUrl(absolute(link?.getAttribute('href')))
      const parts = textParts(card)
      const inlineUpdated = parts.find((part) => /^更新于\s*\d{4}-\d{2}-\d{2}/.test(part)) || textOf(card, '[data-updated]')
      const inlineUpdatedIndex = inlineUpdated ? parts.findIndex((part) => part === inlineUpdated) : -1
      const splitUpdatedIndex = inlineUpdated
        ? -1
        : parts.findIndex((part, partIndex) => part === '更新于' && /^\d{4}-\d{2}-\d{2}$/.test(parts[partIndex + 1] || ''))
      const updated = inlineUpdated || (splitUpdatedIndex >= 0 ? `更新于 ${parts[splitUpdatedIndex + 1]}` : undefined)
      const titleEndIndex = inlineUpdatedIndex >= 0 ? inlineUpdatedIndex : splitUpdatedIndex
      const metadataStartIndex = inlineUpdatedIndex >= 0 ? inlineUpdatedIndex + 1 : splitUpdatedIndex >= 0 ? splitUpdatedIndex + 2 : -1
      const rawPositionId =
        explicitPositionId(card) ||
        (linkUrl ? new URL(linkUrl).searchParams.get('positionId') || undefined : undefined) ||
        findPositionId(scoped)
      const title =
        attr(card, 'data-title') ||
        textOf(card, '[data-job-title]') ||
        textOf(card, '.job-title,.position-title') ||
        textOf(card, 'h1,h2,h3') ||
        clean(link?.textContent) ||
        (titleEndIndex > 0 ? parts.slice(0, titleEndIndex).join(' ') : undefined) ||
        clean(card.textContent)?.split(/\s+更新于|Updated/i)[0] ||
        `job-${index + 1}`
      const detailUrl =
        directUrl(card) ||
        linkUrl ||
        findDetailUrl(scoped) ||
        synthesizeAlibabaDetailUrl(rawPositionId) ||
        undefined
      let positionId = rawPositionId
      if (!positionId && detailUrl) {
        try { positionId = new URL(detailUrl).searchParams.get('positionId') || undefined } catch {}
      }
      const rawTags =
        attr(card, 'data-tags') ||
        attr(card, 'data-job-tags') ||
        textOf(card, '[data-job-tags],[data-tags]') ||
        ''
      const metadata = metadataStartIndex >= 0 ? parts.slice(metadataStartIndex).filter(Boolean) : []
      const category = attr(card, 'data-category') || textOf(card, '[data-category],.category') || metadata.find(looksLikeCategory)
      const location = attr(card, 'data-location') || textOf(card, '[data-location],.location') || metadata.find((part) => part !== category && looksLikeLocation(part))
      return {
        title,
        updated,
        updatedAt: updatedAtFromText(updated),
        category,
        location,
        positionId,
        detailUrl,
        tags: rawTags.split(/[,\s，、]+/).map((tag) => tag.trim()).filter(Boolean),
      }
    }).filter((job) => {
      const title = clean(job.title)
      if (!title || /在招职位|筛选|职位类别|清除/.test(title)) return false
      if (isAlibaba) return Boolean(job.positionId && job.detailUrl && job.updatedAt)
      return Boolean(job.detailUrl || job.positionId || job.updatedAt || job.category || job.location || job.tags.length > 0)
    })
    return { total, jobs }
  })
}

async function extractJobsOnCurrentPage(page: Page, pageIndex: number, offset: number): Promise<{ total: number; jobs: ScrapedJob[]; source: 'alibaba-api' | 'dom' }> {
  const api = await extractAlibabaApiJobs(page, pageIndex)
  const dom = api.jobs.length > 0 ? { total: 0, jobs: [] } : await extractStructuredJobs(page).catch(() => ({ total: 0, jobs: [] }))
  const structured = api.jobs.length > 0 ? api.jobs : dom.jobs
  if (structured.length > 0) {
    const jobs = structured.map((job, index): ScrapedJob => {
      const positionId = job.positionId || positionIdFromUrl(job.detailUrl)
      const searchText = [job.title, job.category, job.location, job.updatedAt || job.updated, job.description, job.requirement, ...(job.tags || [])]
        .filter(Boolean)
        .join(' ')
      return {
        id: positionId ? `alibaba-${positionId}` : `alibaba-${pageIndex}-${offset + index + 1}`,
        title: job.title,
        category: job.category,
        location: job.location,
        updated: job.updated,
        updatedAt: job.updatedAt,
        detailUrl: job.detailUrl,
        positionId,
        sourcePageIndex: pageIndex,
        sourceCardIndex: index + 1,
        sourceTitle: job.title,
        sourceListSnapshotKey: `page-${pageIndex}-card-${index + 1}`,
        searchText,
        tags: [...new Set([...(job.tags || []), ...tokenize(searchText)])],
      }
    })
    return { total: api.total || dom.total || jobs.length, jobs, source: api.jobs.length > 0 ? 'alibaba-api' : 'dom' }
  }
  return { total: api.total || dom.total || 0, jobs: [], source: 'dom' }
}

async function waitForListRender(page: Page): Promise<void> {
  await page
    .waitForFunction(
      () => {
        const text = document.body?.innerText || ''
        return (
          document.querySelector('[data-job-card],[data-position-id],.job-card,.position-card,.position-item,.job-item,[data-job-title],a[href*="positionId"]') ||
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
  const beforeSignature = await page.evaluate(() => ({
    url: location.href,
    text: (document.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 2500),
  })).catch(() => ({ url: beforeUrl, text: '' }))
  for (const selector of [
    '[data-next-page]',
    '.ant-pagination-next',
    '.ant-pagination-next button',
    'a[rel="next"]',
    'button[aria-label*="下一"]',
    'button[aria-label*="next" i]',
    'a:has-text("下一页")',
    'button:has-text("下一页")',
    'a:has-text("下一")',
    'button:has-text("下一")',
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
    await page.waitForFunction(
      (before) => {
        const text = (document.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 2500)
        return location.href !== before.url || text !== before.text
      },
      beforeSignature,
      { timeout: 4000 },
    ).catch(() => {})
    await waitForListRender(page)
    return true
  }

  try {
    const url = new URL(page.url())
    const key = ['page', 'pageNo', 'pageNum', 'currentPage'].find((name) => url.searchParams.has(name))
    if (!key) return false
    url.searchParams.set(key, String(nextPageIndex))
    if (url.toString() === beforeUrl) return false
    await page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: 20000 })
    await waitForListRender(page)
    return true
  } catch {
    return false
  }
}

async function openSourceListPageForJob(
  sessionId: string,
  job: ScrapedJob,
  trace?: TraceRecorder,
): Promise<Page> {
  const sourceUrl = job.sourceRootListUrl || job.sourceListUrl || DEFAULT_LIST_URL
  const targetPageIndex = Math.max(1, Math.floor(job.sourcePageIndex ?? 1))
  const open = await browserOpen({ url: sourceUrl, sessionId, waitUntil: 'domcontentloaded' })
  if (!open.ok) throw new Error(`Failed to return to source list page: ${open.error.message}`)

  const session = sessionManager.get(sessionId)
  if (!session) throw new Error('Session not found after returning to source list page.')
  await waitForListRender(session.page)

  for (let currentPageIndex = 1; currentPageIndex < targetPageIndex; currentPageIndex += 1) {
    const moved = await goToNextListPage(session.page, currentPageIndex + 1)
    if (!moved) {
      const message = `Detail navigation failed for "${job.title}": could not replay list pagination to page ${targetPageIndex}.`
      trace?.record({
        phase: 'scrape_detail',
        action: message,
        url: session.page.url(),
        status: 'warn',
        observation: `sourceRootListUrl=${job.sourceRootListUrl || ''}\nsourceListUrl=${job.sourceListUrl || ''}\nsourcePageIndex=${job.sourcePageIndex || ''}`,
      })
      throw new Error(message)
    }
    await waitForListRender(session.page)
  }

  return session.page
}

function detailTitleMatches(expected: string, observed: string, detailText: string): boolean {
  const normalize = (value: string) => normalizeDedupeKey(value).replace(/[^\p{L}\p{N}]+/gu, '')
  const a = normalize(expected)
  const b = normalize(observed)
  if (!a || !b) return true
  return a.includes(b) || b.includes(a) || normalize(detailText).includes(a)
}

async function waitForPotentialDetailRender(page: Page): Promise<void> {
  await page
    .waitForFunction(
      () =>
        /position-detail|\/detail\//i.test(location.href) ||
        Boolean(document.querySelector('[data-position-id]')) ||
        (document.body?.innerText || '').includes('投递简历'),
      null,
      { timeout: 3000 },
    )
    .catch(() => {})
}

function isLikelyAlibabaListPage(url: string, text: string): boolean {
  return /position-list/i.test(url) || (text.includes('筛选') && text.includes('职位类别') && text.includes('清除'))
}

function detailNavigationFailure(
  job: ScrapedJob,
  detailUrl: string,
  detailText: string,
  identity: { positionId?: string; title?: string },
): string | undefined {
  const normalize = (value: string) => normalizeDedupeKey(value).replace(/[^\p{L}\p{N}]+/gu, '')
  const hasPositionId = Boolean(identity.positionId)
  const hasDetailUrl = /position-detail|\/detail\//i.test(detailUrl)
  const hasApplyButton = detailText.includes('投递简历')
  const titleNeedle = normalize(job.title)
  const hasExpectedTitle = Boolean(titleNeedle && normalize(detailText).includes(titleNeedle))
  const hasDetailMarker = hasPositionId || hasDetailUrl || hasApplyButton

  if (hasDetailMarker && (hasExpectedTitle || hasPositionId || hasApplyButton)) return undefined
  if (isLikelyAlibabaListPage(detailUrl, detailText)) {
    return `Detail navigation failed for "${job.title}": still on the job list page.`
  }
  return `Detail navigation failed for "${job.title}": page does not expose detail markers.`
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
      job.sourceRootListUrl = listUrl
      job.sourceListUrl = sourceListUrl
      job.sourcePageIndex = job.sourcePageIndex || pageIndex
      job.sourceTitle = job.sourceTitle || job.title
      const idKey = job.positionId ? normalizeDedupeKey(job.positionId) : ''
      const titleKey = normalizeDedupeKey(job.title)
      if ((idKey && seenIds.has(idKey)) || seenTitles.has(titleKey)) continue
      if (idKey) seenIds.add(idKey)
      seenTitles.add(titleKey)
      scraped.push(job)
      if (scraped.length >= maxJobs) break
    }

    if (pageIndex >= maxPages || scraped.length >= maxJobs) break
    const moved = pageResult.source === 'alibaba-api'
      ? true
      : await goToNextListPage(session.page, pageIndex + 1)
    if (!moved) break
  }

  trace?.record({
    phase: 'scrape_list',
    action: `Fast list crawl parsed ${scraped.length} unique jobs from ${rawCount} raw cards across ${pagesScanned} page(s).`,
    url: session.page.url(),
    status: scraped.length > 0 ? 'ok' : 'warn',
    screenshotPath: await trace?.screenshot(session.page, 'job-list'),
    observation: scraped.slice(0, 8).map((j) => `• p${j.sourcePageIndex || '?'}#${j.sourceCardIndex || '?'} ${j.title}${j.positionId ? ` [${j.positionId}]` : ''}`).join('\n'),
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
    const listPage = await openSourceListPageForJob(sessionId, job, trace)
    const { popup, clicked } = await clickJobCard(listPage, job)
    if (!clicked) {
      const message = `Detail navigation failed for "${job.title}": no clickable job card found.`
      trace?.record({ phase: 'scrape_detail', action: message, url: listPage.url(), status: 'warn' })
      throw new Error(message)
    }
    detailPage = popup || listPage
    sessionManager.adoptPage(sessionId, detailPage)
  }
  await detailPage.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {})
  await waitForPotentialDetailRender(detailPage)

  const detailUrl = detailPage.url()
  const detailText = await detailPage.locator('body').innerText().catch(() => '')
  const identity = await extractDetailIdentity(detailPage)
  const positionId = identity.positionId
  const navigationFailure = detailNavigationFailure(job, detailUrl, detailText, identity)
  if (navigationFailure) {
    trace?.record({ phase: 'scrape_detail', action: navigationFailure, url: detailUrl, status: 'warn', observation: detailText.slice(0, 500) })
    throw new Error(navigationFailure)
  }
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

const ALIBABA_APPLICATION_NOTICE_TEXT =
  /申请此职位|申请工作[需须]知|投递[需须]知|阅读.{0,30}同意|同意.{0,40}(阿里巴巴|关联公司|申请工作|投递|协议|条款|声明|[需须]知)/i

export interface AlibabaNoticeAcceptResult {
  found: boolean
  checked: boolean
  alreadyChecked?: boolean
  text?: string
}

/**
 * Alibaba's detail page has a small "申请此职位表明..." agreement checkbox next
 * to the entry button. It is a precondition for opening the application flow,
 * not the true final-submit boundary. Keep this scoped to the detail page so a
 * later application-form agreement remains protected by the normal final gate.
 */
export async function ensureAlibabaApplicationNoticeAccepted(
  page: Page,
  trace?: TraceRecorder,
): Promise<AlibabaNoticeAcceptResult> {
  const isAlibabaDetail = await page.evaluate(() =>
    /(^|\.)alibaba\.com$/i.test(location.hostname) &&
    /\/off-campus\/position-detail/i.test(location.pathname),
  ).catch(() => false)
  if (!isAlibabaDetail) return { found: false, checked: false }

  const bodyHasEntryNotice = await page.evaluate(() =>
    /申请此职位|申请工作[需须]知|投递[需须]知|阅读.{0,30}同意|同意.{0,40}(阿里巴巴|关联公司|申请工作|投递|协议|条款|声明|[需须]知)/i.test(document.body?.innerText || ''),
  ).catch(() => false)
  const candidates = page.locator('input[type="checkbox"], [role="checkbox"]')
  const count = await candidates.count().catch(() => 0)

  for (let index = 0; index < count; index += 1) {
    const candidate = candidates.nth(index)
    const info = await candidate.evaluate((el, fallbackNotice) => {
      const normalize = (value: string | null | undefined) => (value || '').replace(/\s+/g, ' ').trim()
      const isVisible = (node: Element) => {
        const style = window.getComputedStyle(node)
        const rect = node.getBoundingClientRect()
        return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0
      }
      const pieces: string[] = []
      const closestLabel = el.closest('label')
      if (closestLabel) pieces.push(normalize(closestLabel.textContent))
      let current: Element | null = el
      for (let depth = 0; current && depth < 5; depth += 1, current = current.parentElement) {
        pieces.push(normalize(current.textContent))
      }
      const text = pieces.find(Boolean) || normalize(document.body?.innerText).slice(0, 300)
      const input = el as HTMLInputElement
      const checked = el instanceof HTMLInputElement
        ? input.checked
        : el.getAttribute('aria-checked') === 'true'
      const disabled = el instanceof HTMLInputElement
        ? input.disabled
        : el.getAttribute('aria-disabled') === 'true'
      const matchesNotice =
        /申请此职位|申请工作[需须]知|投递[需须]知|阅读.{0,30}同意|同意.{0,40}(阿里巴巴|关联公司|申请工作|投递|协议|条款|声明|[需须]知)/i.test(text) ||
        Boolean(fallbackNotice)
      return {
        checked,
        disabled,
        matchesNotice,
        text: text.slice(0, 220),
        visible: isVisible(el),
      }
    }, bodyHasEntryNotice && count === 1).catch(() => undefined)

    if (!info?.matchesNotice || info.disabled) continue
    if (info.checked) {
      trace?.record({
        phase: 'apply',
        action: 'Alibaba application notice checkbox already accepted before apply click.',
        url: page.url(),
        risk: 'L2',
        status: 'ok',
        observation: info.text,
      })
      return { found: true, checked: true, alreadyChecked: true, text: info.text }
    }

    if (info.visible) {
      await candidate.check({ force: true, timeout: 10000 }).catch(async () => {
        await candidate.click({ force: true, timeout: 10000 })
      })
    } else {
      await candidate.check({ force: true, timeout: 10000 }).catch(async () => {
        await candidate.evaluate((el) => (el as HTMLElement).click())
      })
    }
    await page.waitForTimeout(300)
    const checked = await candidate.evaluate((el) =>
      el instanceof HTMLInputElement ? el.checked : el.getAttribute('aria-checked') === 'true',
    ).catch(() => false)

    trace?.record({
      phase: 'apply',
      action: checked
        ? 'Accepted Alibaba application notice checkbox before apply click.'
        : 'Tried to accept Alibaba application notice checkbox before apply click.',
      url: page.url(),
      risk: 'L2',
      status: checked ? 'ok' : 'warn',
      observation: info.text,
    })
    return { found: true, checked, text: info.text }
  }

  if (bodyHasEntryNotice) {
    trace?.record({
      phase: 'apply',
      action: 'Alibaba application notice text detected, but no clickable checkbox was found.',
      url: page.url(),
      risk: 'L2',
      status: 'warn',
    })
  }
  return { found: bodyHasEntryNotice, checked: false }
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
    const listPage = await openSourceListPageForJob(sessionId, job, trace)
    const { popup, clicked } = await clickJobCard(listPage, job)
    if (!clicked) throw new Error(`Detail navigation failed for "${job.title}": no clickable job card found.`)
    detailPage = popup || listPage
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
    detail: 'This opens the application flow. If Alibaba shows the detail-page read-and-agree checkbox, it will be checked first. Login/captcha will then require you.',
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

  await ensureAlibabaApplicationNoticeAccepted(detailPage, trace)

  // Click only the apply-entry button after the detail-page notice precondition
  // is satisfied. True final-submit agreement checkboxes remain protected by
  // direct-submit review detection and the final-submit gate.
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
