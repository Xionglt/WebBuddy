import { chromium } from 'playwright'

const DEFAULT_URL = 'https://talent-holding.alibaba.com/off-campus/position-list?lang=zh'

const targetUrl = process.env.ALIBABA_CAREERS_URL || DEFAULT_URL
const targetJobTitle = process.env.ALIBABA_PROBE_JOB_TITLE || ''
const headless = process.env.PLAYWRIGHT_HEADLESS !== 'false'

function extractLines(text) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

function extractJobs(lines) {
  const jobs = []
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

async function readPageLines(page) {
  return extractLines(await page.locator('body').innerText({ timeout: 15000 }))
}

async function clickJobCard(page, title) {
  const popupPromise = page.waitForEvent('popup', { timeout: 10000 }).catch(() => null)
  const clicked = await page.evaluate((jobTitle) => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT)
    let node

    while ((node = walker.nextNode())) {
      if ((node.textContent || '').trim() !== jobTitle) continue

      let current = node
      for (let depth = 0; current && depth < 6; depth += 1, current = current.parentElement) {
        const style = window.getComputedStyle(current)
        if (current.onclick || style.cursor === 'pointer') {
          current.click()
          return {
            tag: current.tagName.toLowerCase(),
            className: String(current.className || ''),
            text: (current.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120),
          }
        }
      }
    }

    return null
  }, title)

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

async function main() {
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

    const listLines = await readPageLines(listPage)
    const { total, jobs } = extractJobs(listLines)
    const chosenJob = targetJobTitle
      ? jobs.find((job) => job.title === targetJobTitle) || { title: targetJobTitle }
      : jobs[0]

    if (!chosenJob?.title) {
      throw new Error('No jobs were detected on the Alibaba position list.')
    }

    const { clicked, popup } = await clickJobCard(listPage, chosenJob.title)
    const detailPage = popup || listPage
    await detailPage.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {})
    await detailPage.waitForFunction(() => document.body?.innerText.includes('投递简历'), null, {
      timeout: 20000,
    })

    const detailLines = await readPageLines(detailPage)
    const detailTitleBeforeApply = await detailPage.title()
    const detailUrlBeforeApply = detailPage.url()
    const positionId = detailUrlBeforeApply.match(/positionId=([^&]+)/)?.[1] || ''
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

    let afterApply = {
      url: detailPage.url(),
      title: await detailPage.title(),
      lines: await readPageLines(detailPage),
      visibleInputs: await visibleInputs(detailPage),
    }

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
      afterApply = {
        url: detailPage.url(),
        title: await detailPage.title(),
        lines: (await readPageLines(detailPage)).slice(0, 80),
        visibleInputs: await visibleInputs(detailPage),
      }
    }

    const loginRequested = events.some((event) =>
      /moziSso\/login|mozi-login\.alibaba-inc\.com|ssoLogin/i.test(event.url),
    )
    const reachedLogin =
      /login|ssoLogin/i.test(afterApply.url) ||
      afterApply.lines.some((line) => ['密码登录', '短信登录', '立即注册'].includes(line)) ||
      loginRequested
    const reachedApplicationForm =
      !reachedLogin &&
      afterApply.visibleInputs.some((input) =>
        /resume|简历|姓名|邮箱|手机|电话|学校|学历/i.test(
          `${input.id} ${input.name} ${input.placeholder} ${input.ariaLabel}`,
        ),
      )

    const result = {
      ok:
        total > 0 &&
        jobs.length > 0 &&
        Boolean(clicked) &&
        /position-detail/.test(detailUrlBeforeApply) &&
        applyButtonCount === 1 &&
        noticeGate &&
        (reachedLogin || reachedApplicationForm),
      targetUrl,
      list: {
        title: await listPage.title(),
        url: listPage.url(),
        advertisedTotal: total,
        sampledJobs: jobs.slice(0, 5),
      },
      chosenJob,
      detail: {
        title: detailTitleBeforeApply,
        urlBeforeApply: detailUrlBeforeApply,
        openedByPopup: Boolean(popup),
        clicked,
        positionId,
        hasApplyButton: applyButtonCount === 1,
        hasNoticeCheckbox: checkboxCount === 1,
        noticeGate,
        excerpt: detailLines.slice(0, 24),
      },
      afterApply: {
        url: afterApply.url,
        title: afterApply.title,
        reachedLogin,
        loginRequested,
        reachedApplicationForm,
        visibleInputs: afterApply.visibleInputs,
        excerpt: afterApply.lines.slice(0, 24),
      },
      recentNetworkEvents: events.slice(-30),
      safety: {
        loggedIn: false,
        uploadedResume: false,
        submittedApplication: false,
        note: 'Probe stops at login or application-form detection and never submits personal data.',
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
