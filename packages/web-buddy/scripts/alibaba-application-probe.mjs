import { chromium } from 'playwright'

const DEFAULT_URL = 'https://talent-holding.alibaba.com/off-campus/position-list?lang=zh'

const targetUrl = process.env.ALIBABA_CAREERS_URL || DEFAULT_URL
const targetPositionId =
  argValue('--target-position-id') ||
  process.env.ALIBABA_PROBE_POSITION_ID ||
  process.env.DELIVERY_TARGET_POSITION_ID ||
  ''
const targetJobTitle =
  argValue('--target-job-title') ||
  process.env.ALIBABA_PROBE_JOB_TITLE ||
  process.env.DELIVERY_TARGET_JOB_TITLE ||
  ''
const maxTargetPages = Math.max(1, Number(process.env.ALIBABA_PROBE_MAX_PAGES || 5))
const headless = process.env.PLAYWRIGHT_HEADLESS !== 'false'
const waitOnLogin = process.env.DELIVERY_WAIT_ON_LOGIN === 'true'

function argValue(name) {
  const index = process.argv.indexOf(name)
  return index === -1 ? '' : process.argv[index + 1] || ''
}

function extractLines(text) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

async function readPageLines(page) {
  return extractLines(await page.locator('body').innerText({ timeout: 15000 }))
}

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

function compactText(value) {
  return normalizeText(value).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
}

function normalizePositionId(value) {
  return normalizeText(value).replace(/^alibaba-/i, '')
}

function positionIdFromUrl(url) {
  if (!url) return ''
  try {
    return new URL(url).searchParams.get('positionId') || ''
  } catch {
    return url.match(/positionId=([^&]+)/)?.[1] || ''
  }
}

async function fetchApiJobs(page, pageIndex) {
  return page.evaluate(async ({ pageIndex }) => {
    const clean = (value) => String(value ?? '').replace(/\s+/g, ' ').trim()
    const absolute = (value) => {
      if (!value) return ''
      try { return new URL(value, location.href).toString() } catch { return '' }
    }
    const isoFromEpochMs = (value) => {
      const timestamp = Number(value || 0)
      if (!Number.isFinite(timestamp) || timestamp <= 0) return ''
      const date = new Date(timestamp)
      return Number.isNaN(date.getTime()) ? '' : date.toISOString()
    }
    const endpoint =
      absolute(
        performance
          .getEntriesByType('resource')
          .map((entry) => entry.name)
          .find((name) => name.includes('/position/search')),
      ) || absolute('/position/search')
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
      jobs: datas.map((item, index) => {
        const updatedAt = isoFromEpochMs(item?.modifyTime || item?.publishTime)
        const positionId = clean(item?.id)
        return {
          positionId,
          title: clean(item?.name),
          location: Array.isArray(item?.workLocations) ? item.workLocations.map(clean).filter(Boolean).join(' / ') : '',
          category: Array.isArray(item?.categories) ? item.categories.map(clean).filter(Boolean).join(' / ') : '',
          updated: updatedAt ? `更新于 ${updatedAt.slice(0, 10)}` : '',
          updatedAt,
          detailUrl: absolute(item?.positionUrl),
          sourcePageIndex: pageIndex,
          sourceCardIndex: index + 1,
          source: 'alibaba-api',
        }
      }).filter((job) => job.positionId && job.title && job.detailUrl),
    }
  }, { pageIndex }).catch(() => ({ total: 0, jobs: [] }))
}

async function extractDomCardJobs(page) {
  return page.evaluate(() => {
    const clean = (value) => (value || '').replace(/\s+/g, ' ').trim()
    const partsOf = (root) => {
      const parts = []
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      let node = walker.nextNode()
      while (node) {
        const text = clean(node.nodeValue)
        if (text) parts.push(text)
        node = walker.nextNode()
      }
      return parts
    }
    const updatedAtFromText = (value) => {
      const date = value?.match(/更新于\s*(\d{4}-\d{2}-\d{2})/)?.[1]
      return date ? `${date}T00:00:00.000Z` : ''
    }
    const looksLikeCategory = (value) =>
      Boolean(value && /类-|运营|风险管理|技术|产品|设计|数据|市场|销售|外贸|综合|客服|游戏|金融/.test(value))
    const looksLikeLocation = (value) =>
      Boolean(value && /北京|杭州|上海|深圳|广州|成都|重庆|南京|武汉|西安|苏州|中国香港|\/| /.test(value) && !looksLikeCategory(value))
    const compactCardFor = (el) => {
      let root
      let current = el
      for (let depth = 0; current && depth < 8; depth += 1, current = current.parentElement) {
        const text = clean(current.textContent)
        const updateCount = (text.match(/更新于\s*\d{4}-\d{2}-\d{2}/g) || []).length
        if (updateCount !== 1) continue
        if (/^更新于\s*\d{4}-\d{2}-\d{2}/.test(text) || text.length > 400) continue
        root = current
      }
      return root
    }
    const cards = []
    const seen = new Set()
    for (const el of Array.from(document.querySelectorAll('*'))) {
      const text = clean(el.textContent)
      if (!/更新于\s*\d{4}-\d{2}-\d{2}/.test(text)) continue
      const card = compactCardFor(el)
      if (!card || seen.has(card)) continue
      seen.add(card)
      cards.push(card)
    }
    const total = Number((clean(document.body?.innerText).match(/在招职位\s*共\s*(\d+)\s*个岗位/) || [])[1] || 0)
    return {
      total,
      jobs: cards.map((card, index) => {
        const parts = partsOf(card)
        const inlineUpdated = parts.find((part) => /^更新于\s*\d{4}-\d{2}-\d{2}/.test(part)) || ''
        const inlineUpdatedIndex = inlineUpdated ? parts.findIndex((part) => part === inlineUpdated) : -1
        const splitUpdatedIndex = inlineUpdated
          ? -1
          : parts.findIndex((part, partIndex) => part === '更新于' && /^\d{4}-\d{2}-\d{2}$/.test(parts[partIndex + 1] || ''))
        const updated = inlineUpdated || (splitUpdatedIndex >= 0 ? `更新于 ${parts[splitUpdatedIndex + 1]}` : '')
        const titleEndIndex = inlineUpdatedIndex >= 0 ? inlineUpdatedIndex : splitUpdatedIndex
        const metadataStartIndex = inlineUpdatedIndex >= 0 ? inlineUpdatedIndex + 1 : splitUpdatedIndex >= 0 ? splitUpdatedIndex + 2 : -1
        const title = titleEndIndex > 0 ? parts.slice(0, titleEndIndex).join(' ') : clean(card.textContent).split(/\s+更新于/)[0]
        const metadata = metadataStartIndex >= 0 ? parts.slice(metadataStartIndex).filter(Boolean) : []
        const category = metadata.find(looksLikeCategory) || ''
        const location = metadata.find((part) => part !== category && looksLikeLocation(part)) || ''
        return {
          title,
          updated,
          updatedAt: updatedAtFromText(updated),
          category,
          location,
          sourceCardIndex: index + 1,
          source: 'dom-card',
        }
      }).filter((job) => job.title && job.updatedAt && !/在招职位|筛选|职位类别|清除/.test(job.title)),
    }
  }).catch(() => ({ total: 0, jobs: [] }))
}

function jobMatchesTarget(job) {
  if (targetPositionId && normalizePositionId(job.positionId) === normalizePositionId(targetPositionId)) return true
  if (targetJobTitle && compactText(job.title) === compactText(targetJobTitle)) return true
  return false
}

function dedupeJobs(jobs) {
  const seen = new Set()
  const out = []
  for (const job of jobs) {
    const key = job.positionId ? `id:${normalizePositionId(job.positionId)}` : `title:${compactText(job.title)}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(job)
  }
  return out
}

async function extractJobs(page) {
  const dom = await extractDomCardJobs(page)
  const apiPages = []
  for (let pageIndex = 1; pageIndex <= maxTargetPages; pageIndex += 1) {
    const api = await fetchApiJobs(page, pageIndex)
    apiPages.push(api)
    if (api.jobs.some(jobMatchesTarget)) break
    if (!targetPositionId && !targetJobTitle) break
  }

  const apiJobs = dedupeJobs(apiPages.flatMap((pageResult) => pageResult.jobs))
  const firstPageApi = apiPages[0]?.jobs || []
  const firstPageJobs = firstPageApi.length > 0 ? firstPageApi : dom.jobs
  const jobs = apiJobs.length > 0 ? apiJobs : dom.jobs
  const firstPageDomByTitle = new Map(dom.jobs.map((job) => [compactText(job.title), job]))
  for (const job of jobs) {
    const domJob = firstPageDomByTitle.get(compactText(job.title))
    if (domJob) {
      job.domCard = domJob
      job.sourceCardIndex = domJob.sourceCardIndex
    }
  }

  return {
    total: Math.max(...apiPages.map((pageResult) => pageResult.total), dom.total, jobs.length, 0),
    jobs,
    sampledJobs: firstPageJobs.slice(0, 5),
    domCardCount: dom.jobs.length,
    apiPagesScanned: apiPages.length,
    source: apiJobs.length > 0 ? 'alibaba-api+dom-card' : 'dom-card',
  }
}

function chooseTargetJob(jobs) {
  return jobs.find(jobMatchesTarget)
}

function fieldAssertionsFor(job, detail) {
  const checks = []
  const add = (name, passed, observed = '') => checks.push({ name, passed: Boolean(passed), observed })

  add('target.positionIdOrTitle.explicit', Boolean(targetPositionId || targetJobTitle), targetPositionId || targetJobTitle)
  add('list.positionId.present', Boolean(job?.positionId), job?.positionId || '')
  add('list.title.present', Boolean(job?.title), job?.title || '')
  add('list.location.present', Boolean(job?.location), job?.location || '')
  add('list.category.present', Boolean(job?.category), job?.category || '')
  add('list.updatedAt.present', Boolean(job?.updatedAt), job?.updatedAt || '')
  add('list.detailUrl.present', Boolean(job?.detailUrl), job?.detailUrl || '')
  if (targetPositionId) {
    add(
      'target.positionId.matchesList',
      normalizePositionId(job?.positionId) === normalizePositionId(targetPositionId),
      job?.positionId || '',
    )
  }
  if (targetJobTitle) {
    add('target.title.matchesList', compactText(job?.title) === compactText(targetJobTitle), job?.title || '')
  }
  if (detail) {
    const detailUrlPositionId = positionIdFromUrl(detail.urlBeforeApply)
    add('detail.positionId.matchesList', normalizePositionId(detail.positionId) === normalizePositionId(job?.positionId), detail.positionId || '')
    add('detail.url.positionId.matchesList', normalizePositionId(detailUrlPositionId) === normalizePositionId(job?.positionId), detail.urlBeforeApply || '')
    add('detail.title.matchesList', compactText(detail.title) === compactText(job?.title), detail.title || '')
  }

  return {
    passed: checks.every((check) => check.passed),
    checks,
  }
}

async function clickJobCard(page, job) {
  const popupPromise = page.waitForEvent('popup', { timeout: 10000 }).catch(() => null)
  const clicked = await page.evaluate((target) => {
    const clean = (value) => (value || '').replace(/\s+/g, ' ').trim()
    const compact = (value) => clean(value).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
    const titleNeedle = compact(target.title)
    const idNeedle = compact(target.positionId)
    const isTarget = (el) => {
      const text = compact(el.textContent)
      const html = compact(el.outerHTML.slice(0, 3000))
      return Boolean((titleNeedle && text.includes(titleNeedle)) || (idNeedle && html.includes(idNeedle)))
    }
    const clickableFrom = (start) => {
      let current = start
      for (let depth = 0; current && depth < 8; depth += 1, current = current.parentElement) {
        const style = window.getComputedStyle(current)
        if (
          current instanceof HTMLAnchorElement ||
          current instanceof HTMLButtonElement ||
          current.getAttribute('role') === 'link' ||
          current.getAttribute('role') === 'button' ||
          current.onclick ||
          style.cursor === 'pointer'
        ) {
          current.scrollIntoView({ block: 'center', inline: 'center' })
          current.click()
          return {
            tag: current.tagName.toLowerCase(),
            className: String(current.className || ''),
            text: (current.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120),
          }
        }
      }
      return null
    }
    const elements = Array.from(document.querySelectorAll('*'))
      .filter(isTarget)
      .map((el) => {
        const rect = el.getBoundingClientRect()
        return { el, area: rect.width * rect.height, text: clean(el.textContent) }
      })
      .filter((entry) => entry.area > 0)
      .sort((a, b) => a.area - b.area)

    for (const entry of elements) {
      const clicked = clickableFrom(entry.el)
      if (clicked) return clicked
    }

    if (target.sourceCardIndex) {
      const cards = elements.filter((entry) => /更新于\s*\d{4}-\d{2}-\d{2}/.test(entry.text))
      const card = cards[target.sourceCardIndex - 1]
      const clicked = card ? clickableFrom(card.el) : null
      if (clicked) return clicked
    }
    return null
  }, {
    title: job.title,
    positionId: job.positionId,
    sourceCardIndex: job.sourceCardIndex,
  })

  const popup = await popupPromise
  return { clicked, popup }
}

async function visibleInputs(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('input, textarea, select')]
      .map((element) => {
        const rect = element.getBoundingClientRect()
        return {
          tag: element.tagName.toLowerCase(),
          type: element.getAttribute('type') || '',
          id: element.id || '',
          name: element.getAttribute('name') || '',
          placeholder: element.getAttribute('placeholder') || '',
          ariaLabel: element.getAttribute('aria-label') || '',
          visible: rect.width > 0 && rect.height > 0,
        }
      })
      .filter((item) => item.visible),
  )
}

function detectLogin(state, events) {
  const loginRequested = events.some((event) =>
    /moziSso\/login|mozi-login\.alibaba-inc\.com|ssoLogin/i.test(event.url),
  )
  const reachedLogin =
    /login|ssoLogin/i.test(state.url) ||
    state.lines.some((line) => ['密码登录', '短信登录', '立即注册'].includes(line))

  return { loginRequested, reachedLogin }
}

function detectApplicationForm(state, reachedLogin) {
  if (reachedLogin) return false
  return state.visibleInputs.some((input) =>
    /resume|简历|姓名|邮箱|手机|电话|学校|学历/i.test(
      `${input.id} ${input.name} ${input.placeholder} ${input.ariaLabel}`,
    ),
  )
}

async function capturePageState(page) {
  return {
    url: page.url(),
    title: await page.title(),
    lines: (await readPageLines(page)).slice(0, 80),
    visibleInputs: await visibleInputs(page),
  }
}

function waitForEnter() {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY && process.stdin.destroyed) {
      resolve()
      return
    }
    process.stdin.resume()
    process.stdin.once('data', () => {
      process.stdin.pause()
      resolve()
    })
  })
}

async function continueAfterManualLogin(page, applyButton) {
  console.error(
    'DELIVERY_LOGIN_HANDOFF: complete login/captcha in the browser, then press Enter here to continue the safe probe.',
  )
  await waitForEnter()
  await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {})
  await page
    .waitForFunction(
      () => {
        const text = document.body?.innerText || ''
        return (
          !/密码登录|短信登录|立即注册/.test(text) ||
          text.includes('上传简历') ||
          text.includes('教育经历') ||
          text.includes('工作经历') ||
          text.includes('基本资料') ||
          text.includes('投递简历')
        )
      },
      null,
      { timeout: 30000 },
    )
    .catch(() => {})

  const state = await capturePageState(page)
  const stillOnDetail = /position-detail/.test(state.url) && state.lines.includes('投递简历')
  if (stillOnDetail && (await applyButton.count()) === 1) {
    await Promise.allSettled([
      page.waitForLoadState('domcontentloaded', { timeout: 15000 }),
      applyButton.click({ timeout: 10000 }),
    ])
    await page
      .waitForFunction(
        () => {
          const text = document.body?.innerText || ''
          return (
            text.includes('上传简历') ||
            text.includes('教育经历') ||
            text.includes('工作经历') ||
            text.includes('基本资料') ||
            document.querySelector('input, textarea, select')
          )
        },
        null,
        { timeout: 15000 },
      )
      .catch(() => {})
  }

  return capturePageState(page)
}

async function main() {
  if (!targetPositionId && !targetJobTitle) {
    throw new Error('Alibaba application probe requires --target-position-id or --target-job-title; refusing to default to the live first job.')
  }

  const events = []
  const browser = await chromium.launch({ headless })
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    userAgent:
      process.env.PLAYWRIGHT_USER_AGENT ||
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  })

  const trackPage = (page) => {
    page.on('request', (request) => {
      const url = request.url()
      if (/login|apply|resume|deliver|user|getUser|position|passport|havana|mozi/i.test(url)) {
        events.push({ kind: 'request', method: request.method(), url: url.slice(0, 260) })
      }
    })
    page.on('response', (response) => {
      const url = response.url()
      if (/login|apply|resume|deliver|user|getUser|position|passport|havana|mozi/i.test(url)) {
        events.push({
          kind: 'response',
          status: response.status(),
          url: url.slice(0, 260),
          contentType: response.headers()['content-type'] || '',
        })
      }
    })
  }

  context.on('page', trackPage)

  try {
    const listPage = await context.newPage()
    trackPage(listPage)

    await listPage.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 45000 })
    await listPage.waitForFunction(
      () => {
        const text = document.body?.innerText || ''
        return text.includes('在招职位') && text.includes('更新于')
      },
      null,
      { timeout: 25000 },
    )
    await listPage.waitForTimeout(1000)

    const listResult = await extractJobs(listPage)
    const { total, jobs } = listResult
    const chosenJob = chooseTargetJob(jobs)

    if (!chosenJob?.title) {
      throw new Error(
        `Target job was not found in Alibaba list extraction (positionId=${targetPositionId || 'n/a'}, title=${targetJobTitle || 'n/a'}, pagesScanned=${listResult.apiPagesScanned}).`,
      )
    }

    const { clicked, popup } = chosenJob.sourcePageIndex === 1
      ? await clickJobCard(listPage, chosenJob)
      : { clicked: null, popup: null }
    const detailPage = popup || listPage
    let openedByDirectUrl = false
    if (!clicked && chosenJob.detailUrl) {
      await detailPage.goto(chosenJob.detailUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })
      openedByDirectUrl = true
    }
    await detailPage.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {})
    await detailPage.waitForFunction(() => document.body?.innerText.includes('投递简历'), null, {
      timeout: 20000,
    })

    const detailLines = await readPageLines(detailPage)
    const detailTitleBeforeApply = await detailPage.title()
    const detailUrlBeforeApply = detailPage.url()
    const positionId = detailUrlBeforeApply.match(/positionId=([^&]+)/)?.[1] || ''
    const detailForAssertions = {
      title: detailTitleBeforeApply,
      urlBeforeApply: detailUrlBeforeApply,
      positionId,
    }
    const fieldAssertions = fieldAssertionsFor(chosenJob, detailForAssertions)
    const targetDrift = !fieldAssertions.passed
    if (targetDrift) {
      const result = {
        ok: false,
        targetUrl,
        target: {
          positionId: targetPositionId || '',
          jobTitle: targetJobTitle || '',
          matchedBy: targetPositionId ? 'positionId' : 'jobTitle',
          drift: true,
        },
        list: {
          title: await listPage.title(),
          url: listPage.url(),
          advertisedTotal: total,
          sampledJobs: listResult.sampledJobs,
          domCardCount: listResult.domCardCount,
          apiPagesScanned: listResult.apiPagesScanned,
          extractorSource: listResult.source,
        },
        chosenJob,
        detail: {
          title: detailTitleBeforeApply,
          urlBeforeApply: detailUrlBeforeApply,
          openedByPopup: Boolean(popup),
          openedByDirectUrl,
          clicked,
          positionId,
          hasApplyButton: false,
          hasNoticeCheckbox: false,
          noticeGate: false,
          excerpt: detailLines.slice(0, 24),
        },
        fieldAssertions,
        afterApply: null,
        recentNetworkEvents: events.slice(-30),
        safety: {
          loggedIn: false,
          uploadedResume: false,
          submittedApplication: false,
          note: 'Probe stopped before apply click because target/list/detail field assertions failed.',
        },
      }
      console.log(JSON.stringify(result, null, 2))
      process.exitCode = 1
      return
    }
    const applyButton = detailPage.getByRole('button', { name: '投递简历' })
    const applyButtonCount = await applyButton.count()
    const checkboxCount = await detailPage.locator('input[type="checkbox"]').count()

    let noticeGate = false
    if (applyButtonCount === 1) {
      await applyButton.click({ timeout: 10000 })
      await detailPage.waitForTimeout(1200)
      noticeGate = (await readPageLines(detailPage)).some((line) =>
        line.includes('请先阅读并同意'),
      )
    }

    let afterApply = await capturePageState(detailPage)
    let manualLoginHandoff = false
    let manualLoginContinued = false

    if (checkboxCount === 1 && applyButtonCount === 1) {
      await detailPage.locator('input[type="checkbox"]').check({ force: true, timeout: 10000 })
      await Promise.allSettled([
        detailPage.waitForLoadState('domcontentloaded', { timeout: 15000 }),
        applyButton.click({ timeout: 10000 }),
      ])
      await detailPage
        .waitForFunction(
          () => {
            const text = document.body?.innerText || ''
            return (
              text.includes('密码登录') ||
              text.includes('短信登录') ||
              text.includes('立即注册') ||
              text.includes('上传简历') ||
              text.includes('教育经历') ||
              text.includes('工作经历') ||
              text.includes('基本资料') ||
              document.querySelector('input[type="password"]')
            )
          },
          null,
          { timeout: 10000 },
        )
        .catch(() => {})
      afterApply = await capturePageState(detailPage)
    }

    let { loginRequested, reachedLogin } = detectLogin(afterApply, events)
    if (waitOnLogin && reachedLogin) {
      manualLoginHandoff = true
      afterApply = await continueAfterManualLogin(detailPage, applyButton)
      manualLoginContinued = true
      ;({ loginRequested, reachedLogin } = detectLogin(afterApply, events))
    }
    const reachedApplicationForm = detectApplicationForm(afterApply, reachedLogin)

    const result = {
      ok:
        total > 0 &&
        jobs.length > 0 &&
        Boolean(clicked || openedByDirectUrl) &&
        fieldAssertions.passed &&
        /position-detail/.test(detailUrlBeforeApply) &&
        applyButtonCount === 1 &&
        noticeGate &&
        (reachedLogin || reachedApplicationForm),
      targetUrl,
      target: {
        positionId: targetPositionId || '',
        jobTitle: targetJobTitle || '',
        matchedBy: targetPositionId ? 'positionId' : 'jobTitle',
        drift: targetDrift,
      },
      list: {
        title: await listPage.title(),
        url: listPage.url(),
        advertisedTotal: total,
        sampledJobs: listResult.sampledJobs,
        domCardCount: listResult.domCardCount,
        apiPagesScanned: listResult.apiPagesScanned,
        extractorSource: listResult.source,
      },
      chosenJob,
      detail: {
        title: detailTitleBeforeApply,
        urlBeforeApply: detailUrlBeforeApply,
        openedByPopup: Boolean(popup),
        openedByDirectUrl,
        clicked,
        positionId,
        hasApplyButton: applyButtonCount === 1,
        hasNoticeCheckbox: checkboxCount === 1,
        noticeGate,
        excerpt: detailLines.slice(0, 24),
      },
      fieldAssertions,
      afterApply: {
        url: afterApply.url,
        title: afterApply.title,
        reachedLogin,
        loginRequested,
        reachedApplicationForm,
        manualLoginHandoff,
        manualLoginContinued,
        visibleInputs: afterApply.visibleInputs,
        excerpt: afterApply.lines.slice(0, 24),
      },
      recentNetworkEvents: events.slice(-30),
      safety: {
        loggedIn: false,
        uploadedResume: false,
        submittedApplication: false,
        note: waitOnLogin
          ? 'Probe may pause for manual login handoff, then stops at application-form detection and never submits personal data.'
          : 'Probe stops at login or application-form detection and never submits personal data.',
      },
    }

    console.log(JSON.stringify(result, null, 2))
    if (!result.ok) process.exitCode = 1
  } finally {
    await context.close().catch(() => {})
    await browser.close().catch(() => {})
  }
}

main().catch((error) => {
  console.error('alibaba application probe failed:', error)
  process.exit(1)
})
