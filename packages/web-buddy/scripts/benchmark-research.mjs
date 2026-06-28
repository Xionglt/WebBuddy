#!/usr/bin/env node
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runJobApplicationAgent } from '../dist/sdk/orchestrator.js'
import { loadConfig } from '../dist/sdk/config.js'
import { sessionManager } from '../dist/session/manager.js'
import { generateAndWriteSafetyReport } from '../dist/policy/safety-report.js'

const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
const runId = `benchmark-research-${timestamp}`

function readJson(path) {
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

const config = loadConfig()
const reportDir = join(config.trace.outDir, 'benchmarks', timestamp)
mkdirSync(reportDir, { recursive: true })
const reportPath = join(reportDir, 'research-report.json')

const events = []
let runError = null
let report = {
  schemaVersion: 'benchmark-report/v1',
  name: 'research',
  runId,
  status: 'failed',
  startedAt: new Date().toISOString(),
  endedAt: '',
  reportPath,
  traceDir: '',
  metricsPath: '',
  safetyReportPath: '',
  pageStatePath: '',
  researchSummaryPath: '',
  summary: null,
  metrics: null,
  safetyReport: null,
  pageState: null,
  researchSummary: null,
  events,
  error: null,
}

try {
  config.browser.headless = true
  config.browser.visualHighlight = false
  config.browser.typeDelayMs = 0
  config.browser.slowMoMs = 0
  config.human.mode = 'auto'

  const result = await runJobApplicationAgent({
    config,
    mode: 'demo-research',
    runId,
    source: 'benchmark',
    profile: 'benchmark',
    taskPrompt: 'Run the local read-only web research benchmark.',
    onEvent: (event) => events.push(event),
  })

  const traceDir = join(config.trace.outDir, 'traces', `run_${runId}`)
  const metricsPath = join(traceDir, 'metrics.json')
  const pageStatePath = join(traceDir, 'artifacts', 'page-state-latest.json')
  const researchSummaryPath = join(traceDir, 'artifacts', 'research-summary.json')
  const safety = generateAndWriteSafetyReport({ runId, outputDir: config.trace.outDir })

  report = {
    ...report,
    status: result.finalState,
    traceDir,
    metricsPath,
    safetyReportPath: safety.path,
    pageStatePath,
    researchSummaryPath,
    summary: result.summary,
    metrics: readJson(metricsPath),
    safetyReport: readJson(safety.path),
    pageState: readJson(pageStatePath),
    researchSummary: readJson(researchSummaryPath),
  }
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error)
  runError = error
} finally {
  report.endedAt = new Date().toISOString()
  writeFileSync(reportPath, JSON.stringify(report, null, 2))
  await sessionManager.closeAll().catch(() => {})
  console.log(`benchmark-research: report ${reportPath}`)
}

if (runError) throw runError
validateResearchReport(report)

function validateResearchReport(value) {
  assert.equal(value.status, 'completed')
  assert(value.metrics, 'benchmark expected metrics.json to be readable')
  assert.equal(value.metrics.scenario, 'demo-research')
  assert.equal(value.metrics.status, 'completed')
  assert(value.metrics.browserSnapshots >= 1, 'benchmark expected at least one browser snapshot')
  assert(value.metrics.screenshots >= 1, 'benchmark expected screenshots')

  assert.equal(value.pageState?.schemaVersion, 'page-state/v1', 'benchmark expected page-state-latest.json')
  assert.match(value.pageState?.title || '', /Atlas Help Center/i)

  assert(value.researchSummary, 'benchmark expected research-summary.json to be readable')
  assert.equal(value.researchSummary.plans?.length, 3)
  assert.equal(value.researchSummary.faqs?.length, 3)
  assert.equal(value.safetyReport?.schemaVersion, 'safety-report/v1')
  assert.equal(value.safetyReport.finalSubmitAttempted, false)
  assert.equal(value.safetyReport.loginHandoffRequired, false)
  assert.equal(value.safetyReport.captchaHandoffRequired, false)
}
