/**
 * Web API end-to-end auto-apply test:
 *   POST /api/resume + POST /api/run(auto-apply) -> local sandbox submission.
 */
import assert from 'node:assert'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmp = mkdtempSync(join(tmpdir(), 'mfa-web-auto-apply-'))
const submissions = []

function html(body) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Local Careers</title></head><body>${body}</body></html>`
}

function listen(server, port = 0) {
  return new Promise((resolve) => server.listen(port, '127.0.0.1', resolve))
}

function close(server) {
  return new Promise((resolve) => server.close(resolve))
}

function makeCareersServer() {
  return createServer((req, res) => {
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
}

async function waitForJson(url, timeoutMs = 20000) {
  const start = Date.now()
  let lastError
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url)
      if (res.ok) return await res.json()
      lastError = new Error(`HTTP ${res.status}`)
    } catch (error) {
      lastError = error
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw lastError || new Error(`Timed out waiting for ${url}`)
}

async function waitForDone(webBase, runId) {
  for (let i = 0; i < 120; i += 1) {
    const runs = await waitForJson(`${webBase}/api/runs`, 5000)
    const run = runs.find((r) => r.id === runId)
    if (run?.done) return run
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error(`Run did not finish: ${runId}`)
}

const careersServer = makeCareersServer()
await listen(careersServer)
const jobsUrl = `http://127.0.0.1:${careersServer.address().port}/jobs`

const webServer = createServer((_req, res) => {
  res.writeHead(503)
  res.end('placeholder')
})
await listen(webServer)
const webPort = webServer.address().port
await close(webServer)

const web = spawn(process.execPath, ['./dist/web/server.js'], {
  cwd: new URL('..', import.meta.url),
  env: {
    ...process.env,
    PORT: String(webPort),
    TRACE_OUT_DIR: join(tmp, 'output'),
    PLAYWRIGHT_HEADLESS: 'true',
    PLAYWRIGHT_VISUAL_HIGHLIGHT: 'false',
    PLAYWRIGHT_BLOCK_LOCALHOST: 'false',
    PLAYWRIGHT_ALLOWED_DOMAINS: '',
    PLAYWRIGHT_SLOWMO_MS: '0',
    PLAYWRIGHT_TYPE_DELAY_MS: '0',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})

const webBase = `http://127.0.0.1:${webPort}`
let stdout = ''
let stderr = ''
web.stdout.on('data', (chunk) => { stdout += chunk.toString() })
web.stderr.on('data', (chunk) => { stderr += chunk.toString() })

try {
  await waitForJson(`${webBase}/api/config`)

  const resume = JSON.stringify({
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
  })

  const upload = await fetch(`${webBase}/api/resume`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream', 'x-file-name': 'resume.json' },
    body: resume,
  }).then((res) => res.json())
  assert.match(upload.path, /\.json$/)

  const started = await fetch(`${webBase}/api/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'auto-apply', startUrl: jobsUrl, resumePath: upload.path, headless: true }),
  }).then((res) => res.json())
  assert(started.runId, 'web API should return runId')

  const run = await waitForDone(webBase, started.runId)
  const eventsText = await fetch(`${webBase}/api/events?id=${encodeURIComponent(started.runId)}`).then((res) => res.text())
  const trace = await waitForJson(`${webBase}/api/trace?id=${encodeURIComponent(started.runId)}`)

  console.log('web stdout:', stdout.trim())
  console.log('run:', JSON.stringify(run))
  console.log('events:')
  console.log(eventsText.trim())
  console.log('trace summary:', JSON.stringify(trace.summary))
  console.log('submissions:', JSON.stringify(submissions, null, 2))

  assert.strictEqual(run.finalState, 'submitted')
  assert.match(eventsText, /Best match.*Frontend Automation Engineer/s)
  assert.strictEqual(trace.summary?.runId, started.runId)
  assert(trace.steps?.some((s) => /Best match: Frontend Automation Engineer/.test(s.action)), 'trace should include match step')
  assert.strictEqual(submissions.length, 1)
  assert.strictEqual(submissions[0].jobId, 'frontend')
  assert.strictEqual(submissions[0].fields.name, 'Zhang San')
  assert.strictEqual(submissions[0].fields.email, 'zhangsan@example.com')
  assert.strictEqual(submissions[0].fields.phone, '13800001234')
  assert.strictEqual(submissions[0].fields.city, 'Hangzhou')
  assert.match(submissions[0].fields.summary, /TypeScript|React|Playwright/i)

  console.log('\ne2e-web-auto-apply: PASS')
} finally {
  web.kill('SIGTERM')
  await new Promise((resolve) => web.once('exit', resolve))
  await close(careersServer)
  if (stderr.trim()) console.error('web stderr:', stderr.trim())
}
