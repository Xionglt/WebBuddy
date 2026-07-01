/**
 * Job match threshold test:
 *   low-score jobs stop before apply; high-score jobs enter the local sandbox
 *   apply decision; a stricter configured threshold can stop the same high job.
 */
import assert from 'node:assert'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runJobApplicationAgent } from '../dist/sdk/orchestrator.js'
import { loadConfig } from '../dist/sdk/config.js'
import { sessionManager } from '../dist/session/manager.js'

process.env.PLAYWRIGHT_BLOCK_LOCALHOST = 'false'
process.env.PLAYWRIGHT_HEADLESS = 'true'
process.env.PLAYWRIGHT_ALLOWED_DOMAINS = ''

const tmp = mkdtempSync(join(tmpdir(), 'mfa-job-threshold-'))
const resumePath = join(tmp, 'resume.json')
writeFileSync(resumePath, JSON.stringify({
  name: 'Zhang San',
  email: 'zhangsan@example.com',
  phone: '13800001234',
  location: 'Hangzhou',
  summary: 'Frontend engineer focused on TypeScript, React, Playwright automation, Node, and GraphQL.',
  targetRoles: ['Frontend Automation Engineer'],
  skills: ['typescript', 'react', 'playwright', 'node', 'graphql'],
  experience: [{ company: 'Example Cloud', title: 'Frontend Engineer', period: '2021-2025' }],
  education: [],
  keywords: ['frontend', 'typescript', 'react', 'playwright'],
  source: 'json',
}, null, 2))

const submissions = []
const applyHits = new Map()

function html(body) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Threshold Careers</title></head><body>${body}</body></html>`
}

function jobCard(job) {
  return `
    <article data-job-card data-job-id="${job.id}" data-title="${job.title}"
      data-tags="${job.tags}" data-category="${job.category}" data-location="${job.location}"
      data-apply-url="/apply/${job.id}">
      <h2 data-job-title>${job.title}</h2>
      <p>${job.text}</p>
      <a href="/apply/${job.id}" data-apply-link>Apply</a>
    </article>`
}

const server = createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://localhost')
  if (req.method === 'GET' && url.pathname === '/jobs/low') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(html(jobCard({
      id: 'finance',
      title: 'Finance Operations Analyst',
      tags: 'excel,accounting,forecasting',
      category: 'Finance',
      location: 'Shanghai',
      text: 'Own monthly close, accounting reconciliation, and finance reporting.',
    })))
    return
  }

  if (req.method === 'GET' && url.pathname === '/jobs/high') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(html(jobCard({
      id: 'frontend',
      title: 'Frontend Automation Engineer',
      tags: 'typescript,react,playwright,node,graphql,frontend',
      category: 'Engineering',
      location: 'Hangzhou',
      text: 'Build TypeScript React interfaces and Playwright automation for agentic workflows.',
    })))
    return
  }

  if (req.method === 'GET' && url.pathname.startsWith('/apply/')) {
    const jobId = url.pathname.split('/').pop()
    applyHits.set(jobId, (applyHits.get(jobId) || 0) + 1)
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(html(`
      <h1>${jobId} Application</h1>
      <form method="post" action="/apply/${jobId}">
        <label for="name">Full Name</label><input id="name" name="name" type="text">
        <label for="email">Email</label><input id="email" name="email" type="email">
        <label for="phone">Phone</label><input id="phone" name="phone" type="tel">
        <label for="city">City</label><input id="city" name="city" type="text">
        <label for="summary">Summary</label><textarea id="summary" name="summary"></textarea>
        <button type="submit">Submit Application</button>
      </form>
    `))
    return
  }

  if (req.method === 'POST' && url.pathname.startsWith('/apply/')) {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const fields = Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString('utf8')))
      submissions.push({ jobId: url.pathname.split('/').pop(), fields })
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(html(`<h1>Application submitted</h1><p data-status="submitted">Thanks, ${fields.name}.</p>`))
    })
    return
  }

  res.writeHead(404, { 'content-type': 'text/plain' })
  res.end('not found')
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const { port } = server.address()
const base = `http://127.0.0.1:${port}`

async function runAutoApply(runId, path, threshold) {
  const config = loadConfig()
  config.resumePath = resumePath
  config.trace.outDir = join(tmp, 'output')
  config.browser.headless = true
  config.browser.visualHighlight = false
  config.browser.blockLocalhost = false
  config.browser.allowedDomains = []
  config.browser.typeDelayMs = 0
  config.browser.slowMoMs = 0
  config.human.mode = 'auto'
  config.model.apiKey = null
  config.matchThreshold = threshold

  const result = await runJobApplicationAgent({
    config,
    mode: 'auto-apply',
    startUrl: `${base}${path}`,
    runId,
  })
  await sessionManager.closeAll()
  return { result, config }
}

try {
  const low = await runAutoApply('job-match-threshold-low', '/jobs/low', 0.45)
  assert.strictEqual(low.result.finalState, 'no_match')
  assert.strictEqual(low.result.chosenJob, undefined)
  assert.strictEqual(applyHits.get('finance') || 0, 0, 'below-threshold job should not open apply page')
  assert.strictEqual(submissions.length, 0, 'below-threshold job should not submit')
  const lowFinal = JSON.parse(readFileSync(join(low.config.trace.outDir, 'job-match-threshold-low', 'job-candidates-final.json'), 'utf8'))
  assert.strictEqual(lowFinal.decision.shouldApply, false)
  assert.strictEqual(lowFinal.threshold, 0.45)

  const strict = await runAutoApply('job-match-threshold-strict', '/jobs/high', 0.95)
  assert.strictEqual(strict.result.finalState, 'no_match')
  assert.strictEqual(applyHits.get('frontend') || 0, 0, 'configured high threshold should stop before apply')
  const strictFinal = JSON.parse(readFileSync(join(strict.config.trace.outDir, 'job-match-threshold-strict', 'job-candidates-final.json'), 'utf8'))
  assert.strictEqual(strictFinal.decision.shouldApply, false)
  assert.strictEqual(strictFinal.threshold, 0.95)

  const high = await runAutoApply('job-match-threshold-high', '/jobs/high', 0.45)
  assert.strictEqual(high.result.finalState, 'submitted')
  assert.strictEqual(high.result.chosenJob?.id, 'frontend')
  assert.strictEqual(applyHits.get('frontend'), 1)
  assert.strictEqual(submissions.length, 1)
  assert.strictEqual(submissions[0].jobId, 'frontend')
  assert.strictEqual(submissions[0].fields.name, 'Zhang San')
  const highFinal = JSON.parse(readFileSync(join(high.config.trace.outDir, 'job-match-threshold-high', 'job-candidates-final.json'), 'utf8'))
  assert.strictEqual(highFinal.decision.shouldApply, true)
  assert(highFinal.candidates[0].score >= 0.45, 'high candidate should meet default apply threshold')

  console.log('job-match-threshold-test: PASS')
  console.log(`  low trace: ${low.result.summary.tracePath}`)
  console.log(`  high trace: ${high.result.summary.tracePath}`)
} finally {
  await sessionManager.closeAll()
  await new Promise((resolve) => server.close(resolve))
}
