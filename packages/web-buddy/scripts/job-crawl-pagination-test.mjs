/**
 * Job crawl pagination test:
 *   local paginated job board -> fast list crawl -> coarse ranking ->
 *   Top N detail enrichment with positionId/title mismatch protection.
 */
import assert from 'node:assert'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scrapeJobDetail, scrapeJobList } from '../dist/sdk/alibaba.js'
import { runJobApplicationAgent } from '../dist/sdk/orchestrator.js'
import { loadConfig } from '../dist/sdk/config.js'
import { AutoHumanGate } from '../dist/sdk/human.js'
import { sessionManager } from '../dist/session/manager.js'

process.env.PLAYWRIGHT_BLOCK_LOCALHOST = 'false'
process.env.PLAYWRIGHT_HEADLESS = 'true'
process.env.PLAYWRIGHT_ALLOWED_DOMAINS = ''

const tmp = mkdtempSync(join(tmpdir(), 'mfa-job-crawl-'))
const resumePath = join(tmp, 'resume.json')
writeFileSync(resumePath, JSON.stringify({
  name: 'Zhang San',
  email: 'zhangsan@example.com',
  phone: '13800001234',
  location: 'Hangzhou',
  summary: 'Frontend platform engineer focused on TypeScript, React, Node, and Playwright automation.',
  targetRoles: ['Frontend Engineer', '前端工程师'],
  skills: ['typescript', 'react', 'node', 'playwright'],
  experience: [{ company: 'Example Cloud', title: 'Frontend Engineer', period: '2021-2025' }],
  education: [],
  keywords: ['frontend', '前端', 'typescript', 'react', 'playwright'],
  source: 'json',
}, null, 2))

const detailHits = new Map()
const spaDetailHits = new Map()

function html(body) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Mock Alibaba Jobs</title></head><body>${body}</body></html>`
}

function card(job) {
  return `
    <article data-job-card data-position-id="${job.id}" data-title="${job.title}"
      data-category="${job.category}" data-location="${job.location}" data-updated="${job.updated}"
      data-tags="${job.tags}" data-detail-url="${job.detail}">
      <h2 data-job-title>${job.title}</h2>
      <p>${job.description}</p>
      <a href="${job.detail}">详情</a>
    </article>`
}

const pages = {
  1: [
    {
      id: 'p-frontend-mismatch',
      title: 'Frontend Platform Engineer',
      category: 'Engineering-Frontend',
      location: 'Hangzhou',
      updated: '更新于 2026-06-28',
      tags: 'typescript,react,node,frontend',
      detail: '/detail/mismatch?positionId=p-frontend-mismatch',
      description: 'Build React and Node platform foundations.',
    },
    {
      id: 'p-finance',
      title: 'Finance Operations Analyst',
      category: 'Finance',
      location: 'Shanghai',
      updated: '更新于 2026-06-27',
      tags: 'excel,accounting,forecasting',
      detail: '/detail/finance?positionId=p-finance',
      description: 'Own accounting close and reporting.',
    },
    {
      id: 'p-backend',
      title: 'Backend Infra Engineer',
      category: 'Engineering-Backend',
      location: 'Beijing',
      updated: '更新于 2026-06-26',
      tags: 'go,kubernetes,linux',
      detail: '/detail/backend?positionId=p-backend',
      description: 'Build backend infrastructure.',
    },
  ],
  2: [
    {
      id: 'p-frontend-good',
      title: 'Frontend Automation Engineer',
      category: 'Engineering-Frontend',
      location: 'Hangzhou',
      updated: '更新于 2026-06-25',
      tags: 'typescript,react,node,playwright,frontend',
      detail: '/detail/frontend?positionId=p-frontend-good',
      description: 'Build TypeScript React automation for browser agents.',
    },
    {
      id: 'p-finance-duplicate-title',
      title: 'Finance Operations Analyst',
      category: 'Finance',
      location: 'Hangzhou',
      updated: '更新于 2026-06-24',
      tags: 'excel,finance',
      detail: '/detail/finance-duplicate?positionId=p-finance-duplicate-title',
      description: 'Duplicate title should be deduped.',
    },
    {
      id: 'p-backend-duplicate-title',
      title: 'Backend Infra Engineer',
      category: 'Engineering-Backend',
      location: 'Hangzhou',
      updated: '更新于 2026-06-23',
      tags: 'go,kubernetes',
      detail: '/detail/backend-duplicate?positionId=p-backend-duplicate-title',
      description: 'Duplicate title should be deduped.',
    },
  ],
  3: [
    {
      id: 'p-search',
      title: 'Search Quality Engineer',
      category: 'Engineering-Search',
      location: 'Hangzhou',
      updated: '更新于 2026-06-22',
      tags: 'python,search,ranking',
      detail: '/detail/search?positionId=p-search',
      description: 'Work on search quality metrics.',
    },
  ],
}

const spaPages = {
  1: [
    {
      id: 'spa-finance',
      title: 'Finance Planning Analyst',
      category: 'Finance',
      location: 'Shanghai',
      updated: '更新于 2026-07-01',
      tags: 'excel,forecasting',
      description: 'Budget planning and forecast reporting.',
    },
    {
      id: 'spa-backend',
      title: 'Backend Service Engineer',
      category: 'Engineering-Backend',
      location: 'Beijing',
      updated: '更新于 2026-07-01',
      tags: 'go,linux,kubernetes',
      description: 'Build service infrastructure.',
    },
  ],
  2: [
    {
      id: 'spa-good',
      title: 'Frontend Automation Engineer',
      category: 'Engineering-Frontend',
      location: 'Hangzhou',
      updated: '更新于 2026-07-01',
      tags: 'typescript,react,node,playwright,frontend',
      description: 'Build TypeScript React Playwright automation for browser agents.',
    },
    {
      id: 'spa-ops',
      title: 'Operations Specialist',
      category: 'Operations',
      location: 'Hangzhou',
      updated: '更新于 2026-06-30',
      tags: 'process,coordination',
      description: 'Coordinate internal operations.',
    },
  ],
  3: [
    {
      id: 'spa-search',
      title: 'Search Metrics Analyst',
      category: 'Data',
      location: 'Hangzhou',
      updated: '更新于 2026-06-29',
      tags: 'sql,metrics',
      description: 'Track search quality metrics.',
    },
  ],
}

function findSpaJob(id) {
  return Object.values(spaPages).flat().find((job) => job.id === id)
}

const server = createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://localhost')
  if (req.method === 'GET' && url.pathname === '/jobs') {
    const page = Number(url.searchParams.get('page') || '1')
    const next = page < 3 ? `<a data-next-page href="/jobs?page=${page + 1}">下一页</a>` : ''
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(html(`
      <h1>在招职位 共7个岗位</h1>
      ${(pages[page] || []).map(card).join('\n')}
      ${next}
    `))
    return
  }

  if (req.method === 'GET' && url.pathname === '/jobs-bad-detail') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(html(`
      <h1>在招职位 共1个岗位</h1>
      <nav>筛选 清除 职位类别 技术类 产品类</nav>
      <article data-job-card data-title="Broken Detail Engineer" data-category="Engineering"
        data-location="Hangzhou" data-updated="更新于 2026-07-01" data-tags="agent,typescript"
        onclick="window.__clickedBrokenDetail = true" style="cursor:pointer">
        <h2 data-job-title>Broken Detail Engineer</h2>
        <p>Looks clickable but intentionally stays on the list page.</p>
      </article>
    `))
    return
  }

  if (req.method === 'GET' && url.pathname === '/spa-jobs') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(html(`
      <h1>SPA Mock Jobs</h1>
      <div id="app"></div>
      <script>
        const pages = ${JSON.stringify(spaPages).replace(/</g, '\\u003c')};
        let pageIndex = 1;
        function escapeHtml(value) {
          return String(value).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
        }
        function openSpaDetail(id) {
          window.location.href = '/spa-detail?positionId=' + encodeURIComponent(id);
        }
        function renderList() {
          const jobs = pages[pageIndex] || [];
          document.querySelector('#app').innerHTML = [
            '<h2>在招职位 共5个岗位</h2>',
            jobs.map((job) => [
              '<article data-job-card data-title="' + escapeHtml(job.title) + '"',
              ' data-category="' + escapeHtml(job.category) + '"',
              ' data-location="' + escapeHtml(job.location) + '"',
              ' data-updated="' + escapeHtml(job.updated) + '"',
              ' data-tags="' + escapeHtml(job.tags) + '"',
              ' onclick="openSpaDetail(\\'' + escapeHtml(job.id) + '\\')" style="cursor:pointer">',
              '<h2 data-job-title>' + escapeHtml(job.title) + '</h2>',
              '<p>' + escapeHtml(job.description) + '</p>',
              '</article>'
            ].join('')).join(''),
            pageIndex < 3 ? '<button data-next-page type="button" onclick="pageIndex += 1; renderList()">下一页</button>' : ''
          ].join('');
        }
        renderList();
      </script>
    `))
    return
  }

  if (req.method === 'GET' && url.pathname === '/spa-detail') {
    const id = url.searchParams.get('positionId')
    const job = findSpaJob(id)
    spaDetailHits.set(id, (spaDetailHits.get(id) || 0) + 1)
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(html(`
      <main data-position-id="${id || ''}">
        <h1 data-job-title>${job?.title || 'Unknown Job'}</h1>
        <p>Requirements: ${job?.tags || ''}. ${job?.description || ''}</p>
        <button>投递简历</button>
      </main>
    `))
    return
  }

  if (req.method === 'GET' && url.pathname.startsWith('/detail/')) {
    const key = url.pathname.split('/').pop()
    detailHits.set(key, (detailHits.get(key) || 0) + 1)
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    if (key === 'frontend') {
      res.end(html(`
        <main data-position-id="p-frontend-good">
          <h1 data-job-title>Frontend Automation Engineer</h1>
          <p>Requirements: TypeScript, React, Node, Playwright, browser automation, product quality.</p>
          <button>投递简历</button>
        </main>
      `))
      return
    }
    if (key === 'mismatch') {
      res.end(html(`
        <main data-position-id="p-unrelated-detail">
          <h1 data-job-title>Backend Data Engineer</h1>
          <p>This intentionally mismatches the list card position id.</p>
          <button>投递简历</button>
        </main>
      `))
      return
    }
    res.end(html(`
      <main data-position-id="${url.searchParams.get('positionId') || key}">
        <h1 data-job-title>${key}</h1>
        <p>Other role detail.</p>
        <button>投递简历</button>
      </main>
    `))
    return
  }

  res.writeHead(404, { 'content-type': 'text/plain' })
  res.end('not found')
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const { port } = server.address()
const jobsUrl = `http://127.0.0.1:${port}/jobs?page=1`
const spaJobsUrl = `http://127.0.0.1:${port}/spa-jobs`

try {
  const crawl = await scrapeJobList('pagination-direct', jobsUrl, undefined, { maxPages: 3, maxJobs: 20 })
  assert.strictEqual(crawl.pagesScanned, 3, 'fast crawl should scan all three pages')
  assert.strictEqual(crawl.rawCount, 7, 'raw crawl count should include duplicate cards')
  assert.strictEqual(crawl.jobs.length, 5, 'positionId/title dedupe should keep five unique jobs')
  assert.strictEqual(crawl.jobs.filter((job) => job.title === 'Finance Operations Analyst').length, 1)
  assert(crawl.jobs.every((job) => job.detailUrl?.startsWith(`http://127.0.0.1:${port}/detail/`)), 'detail URLs should be absolute')

  await sessionManager.closeAll()

  const badCrawl = await scrapeJobList('bad-detail-direct', `http://127.0.0.1:${port}/jobs-bad-detail`, undefined, { maxPages: 1, maxJobs: 5 })
  assert.strictEqual(badCrawl.jobs.length, 1, 'bad detail fixture should expose one list card')
  assert.equal(badCrawl.jobs[0].detailUrl, undefined, 'bad detail fixture should force click fallback')
  await assert.rejects(
    () => scrapeJobDetail('bad-detail-direct', badCrawl.jobs[0]),
    /still on the job list page|page does not expose detail markers/,
    'click fallback must not treat the list page as a verified detail page',
  )

  await sessionManager.closeAll()
  spaDetailHits.clear()

  const spaCrawl = await scrapeJobList('spa-direct', spaJobsUrl, undefined, { maxPages: 3, maxJobs: 20 })
  assert.strictEqual(spaCrawl.pagesScanned, 3, 'SPA crawl should scan all three batches even when URL does not change')
  assert.strictEqual(spaCrawl.jobs.length, 5, 'SPA crawl should keep all unique cards')
  assert(spaCrawl.jobs.every((job) => Number.isInteger(job.sourcePageIndex)), 'SPA jobs should record sourcePageIndex')
  const spaTarget = spaCrawl.jobs.find((job) => job.title === 'Frontend Automation Engineer')
  assert(spaTarget, 'SPA fixture should include the page-2 frontend target')
  assert.strictEqual(spaTarget.sourcePageIndex, 2, 'SPA frontend target should remember that it came from page 2')
  assert.strictEqual(spaTarget.detailUrl, undefined, 'SPA fixture should force click fallback without a detailUrl')
  const spaDetail = await scrapeJobDetail('spa-direct', spaTarget)
  assert(spaDetail.detailUrl.includes('/spa-detail?positionId=spa-good'), 'SPA fallback click should reach the real detail URL')
  assert(!spaDetail.detailUrl.includes('/spa-jobs'), 'SPA fallback must not verify the list page as detail')
  assert.strictEqual(spaDetail.job.sourcePageIndex, 2)
  assert.strictEqual(spaDetailHits.get('spa-good'), 1, 'SPA page-2 target detail should be opened exactly once')

  await sessionManager.closeAll()
  spaDetailHits.clear()

  const spaConfig = loadConfig()
  spaConfig.resumePath = resumePath
  spaConfig.trace.outDir = join(tmp, 'output')
  spaConfig.browser.headless = true
  spaConfig.browser.visualHighlight = false
  spaConfig.browser.blockLocalhost = false
  spaConfig.browser.allowedDomains = []
  spaConfig.human.mode = 'auto'
  spaConfig.model.apiKey = null
  spaConfig.maxJobPagesToCrawl = 3
  spaConfig.maxJobsToCrawl = 20
  spaConfig.maxJobsToDetail = 1
  spaConfig.matchThreshold = 0.45

  const spaResult = await runJobApplicationAgent({
    config: spaConfig,
    mode: 'match',
    startUrl: spaJobsUrl,
    gate: new AutoHumanGate(),
    runId: 'job-crawl-spa-fallback',
  })
  assert.strictEqual(spaResult.finalState, 'external_blocker', 'SPA match should stop at human handoff after verified detail')
  assert.strictEqual(spaResult.chosenJob?.title, 'Frontend Automation Engineer')
  assert.strictEqual(spaDetailHits.get('spa-good'), 1, 'orchestrator should open the SPA target detail once')
  const spaFinal = JSON.parse(readFileSync(join(spaConfig.trace.outDir, 'job-crawl-spa-fallback', 'job-candidates-final.json'), 'utf8'))
  assert.strictEqual(spaFinal.detailsAttempted, 1)
  assert.strictEqual(spaFinal.detailsOpened, 1)
  assert.strictEqual(spaFinal.detailsVerified, 1)
  assert.strictEqual(spaFinal.detailsFailed, 0)
  assert.strictEqual(spaFinal.candidates[0].sourcePageIndex, 2)

  await sessionManager.closeAll()
  detailHits.clear()

  const config = loadConfig()
  config.resumePath = resumePath
  config.trace.outDir = join(tmp, 'output')
  config.browser.headless = true
  config.browser.visualHighlight = false
  config.browser.blockLocalhost = false
  config.browser.allowedDomains = []
  config.human.mode = 'auto'
  config.model.apiKey = null
  config.maxJobPagesToCrawl = 3
  config.maxJobsToCrawl = 20
  config.maxJobsToDetail = 2
  config.matchThreshold = 0.45

  const result = await runJobApplicationAgent({
    config,
    mode: 'match',
    startUrl: jobsUrl,
    gate: new AutoHumanGate(),
    runId: 'job-crawl-pagination',
  })

  assert.strictEqual(result.finalState, 'external_blocker', 'match mode should stop at human handoff after selecting a good job')
  assert.strictEqual(result.chosenJob?.title, 'Frontend Automation Engineer')
  assert.strictEqual(detailHits.get('frontend'), 1, 'best Top N detail should be opened once')
  assert.strictEqual(detailHits.get('mismatch'), 1, 'mismatched Top N detail should be opened once and rejected')
  assert.strictEqual(detailHits.get('finance') || 0, 0, 'non-Top N detail should not be opened')
  assert.strictEqual(detailHits.get('backend') || 0, 0, 'non-Top N detail should not be opened')

  const coarse = JSON.parse(readFileSync(join(config.trace.outDir, 'job-crawl-pagination', 'job-candidates-coarse.json'), 'utf8'))
  const final = JSON.parse(readFileSync(join(config.trace.outDir, 'job-crawl-pagination', 'job-candidates-final.json'), 'utf8'))
  assert.strictEqual(coarse.scanned, 5)
  assert.strictEqual(coarse.pagesScanned, 3)
  assert.strictEqual(final.detailsAttempted, 2)
  assert.strictEqual(final.detailsOpened, 1)
  assert.strictEqual(final.detailsVerified, 1)
  assert.strictEqual(final.detailsFailed, 1)
  assert.strictEqual(final.decision.shouldApply, true)
  assert.strictEqual(final.candidates[0].title, 'Frontend Automation Engineer')

  console.log('job-crawl-pagination-test: PASS')
  console.log(`  trace: ${result.summary.tracePath}`)
} finally {
  await sessionManager.closeAll()
  await new Promise((resolve) => server.close(resolve))
}
