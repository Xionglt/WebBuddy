/**
 * End-to-end auto-apply test:
 *   resume JSON + job-list URL -> match best job -> fill application form ->
 *   submit to a local sandbox endpoint.
 */
import assert from 'node:assert'
import { createServer } from 'node:http'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runJobApplicationAgent } from '../dist/sdk/orchestrator.js'
import { loadConfig } from '../dist/sdk/config.js'
import { sessionManager } from '../dist/session/manager.js'

const tmp = mkdtempSync(join(tmpdir(), 'mfa-auto-apply-'))
const resumePath = join(tmp, 'resume.json')
writeFileSync(resumePath, JSON.stringify({
  name: 'Zhang San',
  email: 'zhangsan@example.com',
  phone: '13800001234',
  location: 'Hangzhou',
  summary: 'Frontend engineer focused on TypeScript, React, Playwright automation, and polished product workflows.',
  skills: ['typescript', 'react', 'playwright', 'node', 'graphql'],
  experience: [{ company: 'Example Cloud', title: 'Frontend Engineer', period: '2021-2025' }],
  education: [],
  keywords: ['frontend', 'typescript', 'react', 'playwright'],
  source: 'json',
}, null, 2))

const submissions = []

function html(body) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Local Careers</title></head><body>${body}</body></html>`
}

const server = createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://localhost')
  if (req.method === 'GET' && url.pathname === '/jobs') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(html(`
      <h1>Local Careers</h1>
      <article data-job-card data-job-id="frontend" data-title="Frontend Automation Engineer"
        data-tags="typescript,react,playwright,node,graphql"
        data-category="Engineering"
        data-location="Hangzhou"
        data-apply-url="/apply/frontend">
        <h2 data-job-title>Frontend Automation Engineer</h2>
        <p>Build TypeScript React interfaces and Playwright automation for agentic workflows.</p>
        <a href="/apply/frontend" data-apply-link>Apply</a>
      </article>
      <article data-job-card data-job-id="finance" data-title="Finance Operations Analyst"
        data-tags="excel,accounting,forecasting"
        data-category="Finance"
        data-location="Shanghai"
        data-apply-url="/apply/finance">
        <h2 data-job-title>Finance Operations Analyst</h2>
        <p>Own monthly accounting close and financial reporting.</p>
        <a href="/apply/finance" data-apply-link>Apply</a>
      </article>
    `))
    return
  }

  if (req.method === 'GET' && url.pathname.startsWith('/apply/')) {
    const jobId = url.pathname.split('/').pop()
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(html(`
      <h1>${jobId === 'frontend' ? 'Frontend Automation Engineer' : 'Finance Operations Analyst'} Application</h1>
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
      const body = Buffer.concat(chunks).toString('utf8')
      const fields = Object.fromEntries(new URLSearchParams(body))
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
const jobsUrl = `http://127.0.0.1:${port}/jobs`

const config = loadConfig()
config.resumePath = resumePath
config.trace.outDir = join(tmp, 'output')
config.browser.headless = true
config.browser.visualHighlight = false
config.browser.typeDelayMs = 0
config.browser.slowMoMs = 0
config.browser.blockLocalhost = false
config.browser.allowedDomains = []
config.human.mode = 'auto'

const events = []

try {
  const result = await runJobApplicationAgent({
    config,
    mode: 'auto-apply',
    startUrl: jobsUrl,
    onEvent: (e) => events.push(e),
    runId: 'e2e-auto-apply',
  })

  console.log('events:')
  for (const e of events) console.log(`  [${e.level}] ${e.phase}: ${e.message}`)
  console.log('result:', result.finalState, '-', result.message)
  console.log('chosen:', result.chosenJob?.id, result.chosenJob?.title)
  console.log('submissions:', JSON.stringify(submissions, null, 2))
  console.log('trace:', result.summary.tracePath)

  assert.strictEqual(result.finalState, 'submitted')
  assert.strictEqual(result.chosenJob?.id, 'frontend')
  assert.strictEqual(submissions.length, 1)
  assert.strictEqual(submissions[0].jobId, 'frontend')
  assert.strictEqual(submissions[0].fields.name, 'Zhang San')
  assert.strictEqual(submissions[0].fields.email, 'zhangsan@example.com')
  assert.strictEqual(submissions[0].fields.phone, '13800001234')
  assert.strictEqual(submissions[0].fields.city, 'Hangzhou')
  assert.match(submissions[0].fields.summary, /TypeScript|React|Playwright/i)

  console.log('\ne2e-auto-apply: PASS')
} finally {
  await sessionManager.closeAll()
  await new Promise((resolve) => server.close(resolve))
}
