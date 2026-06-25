#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, extname, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runJobApplicationAgent } from '../dist/sdk/orchestrator.js'
import { loadConfig } from '../dist/sdk/config.js'
import { writeSampleResumePdf } from '../dist/sdk/resume.js'
import { sessionManager } from '../dist/session/manager.js'

const SCRIPT_DIR = fileURLToPath(new URL('.', import.meta.url))
const PACKAGE_ROOT = resolve(SCRIPT_DIR, '..')
const PAGE_ROOT = join(PACKAGE_ROOT, 'benchmarks', 'mock-pages')

const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
const runId = `benchmark-simple-${timestamp}`

function readJson(path) {
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

function contentType(file) {
  if (extname(file) === '.html') return 'text/html; charset=utf-8'
  return 'application/octet-stream'
}

function startStaticServer(root) {
  const server = createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    const requested = normalize(url.pathname === '/' ? '/simple-apply.html' : url.pathname)
    const file = join(root, basename(requested))
    if (!file.startsWith(root) || !existsSync(file)) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('not found')
      return
    }
    res.writeHead(200, { 'content-type': contentType(file), 'cache-control': 'no-store' })
    res.end(readFileSync(file))
  })

  return new Promise((resolveServer, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('Could not allocate benchmark HTTP port.'))
        return
      }
      resolveServer({ server, origin: `http://127.0.0.1:${address.port}` })
    })
  })
}

const config = loadConfig()
const reportDir = join(config.trace.outDir, 'benchmarks', timestamp)
mkdirSync(reportDir, { recursive: true })
const reportPath = join(reportDir, 'report.json')
const resumePath = join(reportDir, 'sample-resume.pdf')
writeSampleResumePdf(resumePath)

const events = []
let serverHandle
let runError = null
let report = {
  schemaVersion: 'benchmark-report/v1',
  name: 'simple-apply',
  runId,
  status: 'failed',
  startedAt: new Date().toISOString(),
  endedAt: '',
  url: '',
  reportPath,
  metricsPath: '',
  agentStatePath: '',
  observationArtifacts: {
    pageStatePath: '',
    formStatePath: '',
    pageState: null,
    formState: null,
  },
  summary: null,
  metrics: null,
  agentState: null,
  error: null,
}

try {
  serverHandle = await startStaticServer(PAGE_ROOT)
  const startUrl = `${serverHandle.origin}/simple-apply.html`
  report.url = startUrl

  config.browser.headless = true
  config.browser.visualHighlight = false
  config.browser.typeDelayMs = 0
  config.browser.slowMoMs = 0
  config.browser.blockLocalhost = false
  config.browser.allowedDomains = ['127.0.0.1', 'localhost']
  config.human.mode = 'auto'
  config.resumePath = resumePath

  const result = await runJobApplicationAgent({
    config,
    mode: 'auto-apply',
    startUrl,
    runId,
    source: 'benchmark',
    profile: 'benchmark',
    taskPrompt: 'Run the local simple apply benchmark.',
    onEvent: (event) => events.push(event),
  })

  const traceDir = join(config.trace.outDir, 'traces', `run_${runId}`)
  const metricsPath = join(traceDir, 'metrics.json')
  const agentStatePath = join(traceDir, 'agent-state.json')
  const pageStatePath = join(traceDir, 'artifacts', 'page-state-latest.json')
  const formStatePath = join(traceDir, 'artifacts', 'form-state-latest.json')
  report = {
    ...report,
    status: result.finalState,
    summary: result.summary,
    metricsPath,
    agentStatePath,
    observationArtifacts: {
      pageStatePath,
      formStatePath,
      pageState: readJson(pageStatePath),
      formState: readJson(formStatePath),
    },
    metrics: readJson(metricsPath),
    agentState: readJson(agentStatePath),
    events,
  }
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error)
  runError = error
} finally {
  report.endedAt = new Date().toISOString()
  writeFileSync(reportPath, JSON.stringify(report, null, 2))
  await sessionManager.closeAll().catch(() => {})
  if (serverHandle) {
    await new Promise((resolveClose) => serverHandle.server.close(resolveClose))
  }
  console.log(`benchmark-simple: report ${reportPath}`)
}

if (runError) throw runError
validateBenchmarkReport(report)

function validateBenchmarkReport(value) {
  assert(value.metrics, 'benchmark expected metrics.json to be readable')
  assert(value.agentState, 'benchmark expected agent-state.json to be readable')

  const pageState = value.observationArtifacts?.pageState
  const formState = value.observationArtifacts?.formState
  assert.equal(pageState?.schemaVersion, 'page-state/v1', 'benchmark expected page-state-latest.json')
  assert.equal(formState?.schemaVersion, 'form-state/v1', 'benchmark expected form-state-latest.json')

  const fields = formState.fields || []
  const filledFields = formState.filledFields || []
  const fieldValues = fields.map((field) => String(field.value || '')).join('\n')
  const hasExpectedFilledValues = ['Zhang San', 'zhangsan@example.com', '13800001234'].every((expected) =>
    fieldValues.includes(expected),
  )
  assert(
    filledFields.length >= 3 || hasExpectedFilledValues,
    `benchmark expected final FormState to include filled name/email/phone values, got ${filledFields.length} filled fields`,
  )
}
