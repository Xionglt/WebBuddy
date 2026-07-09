#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, extname, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildLoopContext,
  renderSystemContext,
  renderUserContext,
} from '../dist/agent/prompt-assembler.js'
import { browserFormAudit } from '../dist/browser/form-audit.js'
import { browserFormSnapshot } from '../dist/browser/form-snapshot.js'
import { browserOpen } from '../dist/browser/open.js'
import { browserSnapshot } from '../dist/browser/snapshot.js'
import { fillResumeDraft } from '../dist/sdk/form-fill.js'
import { AutoHumanGate } from '../dist/sdk/human.js'
import { loadConfig } from '../dist/sdk/config.js'
import { readResume, writeSampleResumePdf } from '../dist/sdk/resume.js'
import { TraceRecorder } from '../dist/sdk/trace.js'
import { sessionManager } from '../dist/session/manager.js'

const SCRIPT_DIR = fileURLToPath(new URL('.', import.meta.url))
const PACKAGE_ROOT = resolve(SCRIPT_DIR, '..')
const PAGE_ROOT = join(PACKAGE_ROOT, 'benchmarks', 'mock-pages')
const SESSION_ID = 'default'

const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
const runId = `benchmark-complex-${timestamp}`
const taskGoal = 'Run the local complex apply benchmark and validate Context, Freshness, and TaskState.'

function readJson(path) {
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

function readJsonl(path) {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

function tracePayloadValue(value) {
  if (value && typeof value === 'object' && !Array.isArray(value) && value.kind && Object.hasOwn(value, 'value')) {
    return value.value
  }
  return value
}

function contentType(file) {
  if (extname(file) === '.html') return 'text/html; charset=utf-8'
  return 'application/octet-stream'
}

function startStaticServer(root) {
  const server = createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    const requested = normalize(url.pathname === '/' ? '/complex-apply.html' : url.pathname)
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
const reportPath = join(reportDir, 'complex-report.json')
const resumePath = join(reportDir, 'sample-resume.pdf')
writeSampleResumePdf(resumePath)

process.env.PLAYWRIGHT_HEADLESS = 'true'
process.env.PLAYWRIGHT_VISUAL_HIGHLIGHT = 'false'
process.env.PLAYWRIGHT_TYPE_DELAY_MS = '0'
process.env.PLAYWRIGHT_SLOWMO_MS = '0'
process.env.PLAYWRIGHT_BLOCK_LOCALHOST = 'false'
process.env.PLAYWRIGHT_ALLOWED_DOMAINS = '127.0.0.1,localhost'

const gateEvents = []
let serverHandle
let trace
let traceFinished = false
let runError = null
let report = {
  schemaVersion: 'benchmark-report/v1',
  name: 'complex-apply',
  runId,
  status: 'failed',
  startedAt: new Date().toISOString(),
  endedAt: '',
  url: '',
  reportPath,
  metricsPath: '',
  agentStatePath: '',
  traceEventsPath: '',
  observationArtifacts: {
    pageStatePath: '',
    formStatePath: '',
    pageState: null,
    formState: null,
    snapshotContract: null,
    auditContract: null,
  },
  context: null,
  summary: null,
  metrics: null,
  agentState: null,
  gateEvents,
  error: null,
}

function finishTrace() {
  if (!trace || traceFinished) return null
  traceFinished = true
  return trace.finish()
}

function readTraceOutputs() {
  const traceDir = join(config.trace.outDir, 'traces', `run_${runId}`)
  const metricsPath = join(traceDir, 'metrics.json')
  const agentStatePath = join(traceDir, 'agent-state.json')
  const traceEventsPath = join(traceDir, 'events.jsonl')
  const pageStatePath = join(traceDir, 'artifacts', 'page-state-latest.json')
  const formStatePath = join(traceDir, 'artifacts', 'form-state-latest.json')
  return {
    traceDir,
    metricsPath,
    agentStatePath,
    traceEventsPath,
    pageStatePath,
    formStatePath,
    metrics: readJson(metricsPath),
    agentState: readJson(agentStatePath),
    pageState: readJson(pageStatePath),
    formState: readJson(formStatePath),
    traceEvents: readJsonl(traceEventsPath),
  }
}

try {
  serverHandle = await startStaticServer(PAGE_ROOT)
  const startUrl = `${serverHandle.origin}/complex-apply.html`
  report.url = startUrl

  trace = new TraceRecorder(config.trace.outDir, {
    runId,
    source: 'benchmark',
    scenario: 'complex-apply',
    profile: 'benchmark',
    goal: taskGoal,
  })

  const profileFromResume = await readResume(resumePath)
  assert(profileFromResume, 'benchmark expected sample resume to parse')
  const profile = {
    ...profileFromResume,
    location: profileFromResume.location || 'Hangzhou',
  }

  const open = await browserOpen({ url: startUrl, sessionId: SESSION_ID, waitUntil: 'domcontentloaded' })
  if (!open.ok) throw new Error(open.error.message)
  trace.record({
    phase: 'open_form',
    action: `Opened complex benchmark form: ${startUrl}`,
    url: sessionManager.get(SESSION_ID)?.page.url(),
    status: 'ok',
    screenshotPath: await trace.screenshot(sessionManager.get(SESSION_ID)?.page, 'complex-open'),
  })

  const fill = await fillResumeDraft(
    SESSION_ID,
    profile,
    new AutoHumanGate((kind, decision) => gateEvents.push({ kind, decision })),
    trace,
    false,
    { allowFinalSubmit: false },
  )

  const firstFormSnapshot = await browserFormSnapshot({ sessionId: SESSION_ID })
  const pageSnapshot = await browserSnapshot({ sessionId: SESSION_ID })
  const fullFormAudit = await browserFormAudit({ sessionId: SESSION_ID, maxFields: 240, waitMs: 40 })
  trace.record({
    phase: 'observation',
    action: 'Refreshed complex PageState/FormState artifacts with viewport snapshot and full form audit.',
    url: sessionManager.get(SESSION_ID)?.page.url(),
    status: firstFormSnapshot.ok || pageSnapshot.ok || fullFormAudit.ok ? 'ok' : 'warn',
    observation: [
      `browser_form_snapshot=${firstFormSnapshot.ok ? 'ok' : 'failed'}`,
      `browser_snapshot=${pageSnapshot.ok ? 'ok' : 'failed'}`,
      `browser_form_audit=${fullFormAudit.ok ? 'ok' : 'failed'}`,
    ].join(', '),
  })

  const taskState = {
    schemaVersion: 'task-state/v1',
    goal: taskGoal,
    phase: 'in_target_flow',
    knownBlockers: [
      'Captcha-like human verification remains visible.',
      'Resume upload and work authorization are intentionally unresolved.',
    ],
    completionCriteria: [
      'PageState and FormState artifacts are produced.',
      'Freshness metadata renders into prompt sections.',
      'TaskState renders into the context prompt.',
      'Trace metrics aggregate context selection data.',
    ],
    updatedAt: new Date().toISOString(),
  }
  const contextSnapshot = await buildLoopContext(
    {
      goal: taskGoal,
      resume: profile,
      ctx: { sessionId: SESSION_ID },
      safetyMode: 'guarded',
      extraContext: 'Complex local benchmark only; do not adapt a real website.',
      taskState,
    },
    [
      {
        step: 1,
        toolName: 'browser_snapshot',
        argumentsSummary: 'sessionId=default',
        status: 'ok',
        observation: 'Initial complex page snapshot captured.',
        at: new Date().toISOString(),
      },
      {
        step: 2,
        toolName: 'fillResumeDraft',
        argumentsSummary: 'deterministic local fill',
        status: fill.stoppedAt === 'submit' ? 'blocked' : 'ok',
        risk: 'L3',
        observation: `Filled ${fill.filled.filter((item) => item.ok).length} fields; stoppedAt=${fill.stoppedAt}.`,
        at: new Date().toISOString(),
      },
      {
        step: 3,
        toolName: 'browser_form_audit',
        argumentsSummary: 'sessionId=default',
        status: fullFormAudit.ok ? 'ok' : 'warn',
        observation: fullFormAudit.ok ? fullFormAudit.observation : fullFormAudit.error.message,
        at: new Date().toISOString(),
      },
    ],
    [
      'captcha-like verification blocker remains visible',
      'final submit gate was not approved for this complex benchmark',
    ],
  )

  const systemContext = renderSystemContext(contextSnapshot)
  const userContext = renderUserContext(contextSnapshot)
  const renderedContext = `${systemContext}\n\n${userContext}`
  report.context = {
    snapshotSchemaVersion: contextSnapshot.schemaVersion,
    freshness: contextSnapshot.freshness,
    taskState: contextSnapshot.taskState,
    renderedChars: renderedContext.length,
    includesTaskState: renderedContext.includes('## TASK_STATE') && renderedContext.includes('phase: in_target_flow'),
    includesFreshness: renderedContext.includes('freshness: ageMs='),
    includesBlocker: renderedContext.includes('captcha-like verification blocker'),
  }
  trace.record({
    phase: 'context_validation',
    action: 'Rendered complex context snapshot with Freshness and TaskState.',
    url: sessionManager.get(SESSION_ID)?.page.url(),
    status: 'ok',
    observation: `contextChars=${renderedContext.length}, phase=${contextSnapshot.taskState?.phase}`,
  })

  report.summary = finishTrace()
  const outputs = readTraceOutputs()
  const contextSelectionEvents = outputs.traceEvents.filter((event) => event.event === 'context_selection')
  report = {
    ...report,
    metricsPath: outputs.metricsPath,
    agentStatePath: outputs.agentStatePath,
    traceEventsPath: outputs.traceEventsPath,
    observationArtifacts: {
      pageStatePath: outputs.pageStatePath,
      formStatePath: outputs.formStatePath,
      pageState: outputs.pageState,
      formState: outputs.formState,
      snapshotContract: coverageContract(firstFormSnapshot),
      auditContract: coverageContract(fullFormAudit),
    },
    metrics: outputs.metrics,
    agentState: outputs.agentState,
    traceEvents: {
      contextSelectionCount: contextSelectionEvents.length,
      contextSelection: contextSelectionEvents.map((event) => tracePayloadValue(event.data)),
    },
  }

  validateBenchmarkReport(report)
  report.status = 'passed'
} catch (error) {
  runError = error
  report.error = error instanceof Error ? error.message : String(error)
  try {
    if (trace && !traceFinished) {
      trace.record({
        phase: 'fatal',
        action: `Complex benchmark error: ${report.error}`,
        status: 'error',
      })
      report.summary = finishTrace()
      const outputs = readTraceOutputs()
      report = {
        ...report,
        metricsPath: outputs.metricsPath,
        agentStatePath: outputs.agentStatePath,
        traceEventsPath: outputs.traceEventsPath,
        observationArtifacts: {
          pageStatePath: outputs.pageStatePath,
          formStatePath: outputs.formStatePath,
          pageState: outputs.pageState,
          formState: outputs.formState,
          snapshotContract: report.observationArtifacts.snapshotContract,
          auditContract: report.observationArtifacts.auditContract,
        },
        metrics: outputs.metrics,
        agentState: outputs.agentState,
      }
    }
  } catch {
    // Keep the original benchmark failure.
  }
} finally {
  report.endedAt = new Date().toISOString()
  writeFileSync(reportPath, JSON.stringify(report, null, 2))
  await sessionManager.closeAll().catch(() => {})
  if (serverHandle) {
    await new Promise((resolveClose) => serverHandle.server.close(resolveClose))
  }
  console.log(`benchmark-complex: report ${reportPath}`)
}

if (runError) throw runError

function validateBenchmarkReport(value) {
  assert(value.metrics, 'benchmark expected metrics.json to be readable')
  assert(value.agentState, 'benchmark expected agent-state.json to be readable')

  const pageState = value.observationArtifacts?.pageState
  const formState = value.observationArtifacts?.formState
  const snapshotContract = value.observationArtifacts?.snapshotContract
  const auditContract = value.observationArtifacts?.auditContract
  assert.equal(pageState?.schemaVersion, 'page-state/v1', 'benchmark expected page-state-latest.json')
  assert.equal(formState?.schemaVersion, 'form-state/v1', 'benchmark expected form-state-latest.json')
  assert.equal(snapshotContract?.scope, 'viewport', 'browser_form_snapshot contract should be viewport scoped')
  assert.equal(snapshotContract?.complete, false, 'browser_form_snapshot must not claim full coverage')
  assert.equal(snapshotContract?.auditTool, 'browser_form_snapshot', 'browser_form_snapshot should identify its source')
  assert.equal(auditContract?.scope, 'full_audit', 'browser_form_audit contract should be full_audit scoped')
  assert.equal(auditContract?.complete, true, 'browser_form_audit should provide complete coverage for the complex fixture')
  assert.equal(auditContract?.auditTool, 'browser_form_audit', 'browser_form_audit should identify its source')
  assert.equal(formState.coverageScope, 'full_audit', 'FormState should be refreshed from full_audit coverage')
  assert.equal(formState.completeCoverage, true, 'FormState should expose complete coverage signal')
  assert.equal(formState.formCoverage?.scope, 'full_audit', 'FormState.formCoverage should preserve full_audit scope')
  assert.equal(formState.formCoverage?.complete, true, 'FormState.formCoverage should preserve complete=true')
  assert.match(pageState.title || '', /Complex Apply Benchmark/, 'PageState should describe the complex page')
  assert(['form', 'captcha'].includes(pageState.pageType), `PageState should classify the complex page, got ${pageState.pageType}`)

  const fields = formState.fields || []
  const labels = fields.map((field) => field.label || '').join('\n')
  const values = fields.map((field) => String(field.value || '')).join('\n')
  assert.match(labels, /Full name/i, 'FormState should include required Full name')
  assert.match(labels, /Email/i, 'FormState should include required Email')
  assert.match(labels, /Preferred role track/i, 'FormState should include required select field')
  assert.match(labels, /Upload resume PDF/i, 'FormState should include required upload field')
  assert.match(labels, /Verification code/i, 'FormState should include captcha-like blocker field')
  assert.match(values, /Zhang San/, 'FormState should include filled name from resume')
  assert.match(values, /zhangsan@example\.com/, 'FormState should include filled email from resume')
  assert.match(values, /13800001234/, 'FormState should include filled phone from resume')
  assert.match(values, /Hangzhou/, 'FormState should include filled location from benchmark profile')

  const optionRichFields = fields.filter((field) => (field.options || []).length >= 16)
  assert(optionRichFields.length >= 2, 'FormState should capture select fields with many options')
  const preferredRole = fields.find((field) => /Preferred role track/i.test(field.label))
  const workAuthorization = fields.find((field) => /Work authorization/i.test(field.label))
  assert(preferredRole, 'FormState should include Preferred role track')
  assert(workAuthorization, 'FormState should include Work authorization')
  assert.equal(preferredRole.filled, false, 'Required select placeholder should not count as filled')
  assert.equal(workAuthorization.filled, false, 'Required select placeholder should not count as filled')
  assert(
    !(formState.filledFields || []).some((field) => /Preferred role track|Work authorization/i.test(field.label)),
    'Required select placeholders should not enter filledFields',
  )
  assert(
    (formState.uploadHints || []).some((hint) => /resume|upload|pdf/i.test(`${hint.text} ${hint.accept || ''}`)),
    'FormState should capture upload hints',
  )
  assert(
    (formState.visibleErrors || []).some((error) => /required|verification|captcha|authorization/i.test(error)),
    'FormState should capture visible validation errors',
  )
  assert(
    (formState.missingRequired || []).some((field) => /Preferred role track|Upload resume PDF|Work authorization|Verification code/i.test(field.label)),
    'FormState should preserve missing required blockers',
  )

  assert.equal(value.context?.snapshotSchemaVersion, 'context-snapshot/v1', 'ContextSnapshot should be built')
  assert.equal(value.context?.taskState?.schemaVersion, 'task-state/v1', 'TaskState should be present in context')
  assert.equal(value.context?.taskState?.phase, 'in_target_flow', 'TaskState phase should be benchmark-controlled')
  assert.equal(value.context?.freshness?.staleAfterMs, 30_000, 'Freshness stale threshold should be recorded')
  assert.equal(typeof value.context?.freshness?.pageStateAgeMs, 'number', 'PageState freshness age should be available')
  assert.equal(typeof value.context?.freshness?.formStateAgeMs, 'number', 'FormState freshness age should be available')
  assert(value.context?.includesTaskState, 'Rendered context should include TASK_STATE')
  assert(value.context?.includesFreshness, 'Rendered context should include freshness cues')
  assert(value.context?.includesBlocker, 'Rendered context should include blocker context')

  assert.equal(value.metrics.schemaVersion, 'run-metrics/v1', 'metrics schema should be readable')
  assert(value.metrics.contextBuilds >= 1, 'metrics should aggregate context_selection events')
  assert(value.metrics.contextChars > 0, 'metrics should include contextChars')
  assert.equal(typeof value.metrics.pageStateAgeMs, 'number', 'metrics should include pageStateAgeMs')
  assert.equal(typeof value.metrics.formStateAgeMs, 'number', 'metrics should include formStateAgeMs')
  assert(value.metrics.promptSectionChars?.TASK_STATE > 0, 'metrics should include TASK_STATE section chars')
  assert(value.metrics.promptSectionChars?.CURRENT_FORM_STATE > 0, 'metrics should include CURRENT_FORM_STATE section chars')
  assert(value.traceEvents?.contextSelectionCount >= 1, 'trace events should include context_selection')

  assert.equal(value.agentState.schemaVersion, 'agent-state/v1', 'agent-state schema should be readable')
  assert.equal(value.agentState.runId, value.runId, 'agent-state should share the benchmark run id')
  assert.equal(value.agentState.source, 'benchmark', 'agent-state should preserve benchmark source')
  assert.equal(value.agentState.scenario, 'complex-apply', 'agent-state should preserve scenario')
}

function coverageContract(toolResult) {
  if (!toolResult?.ok) return { ok: false }
  const coverage = toolResult.data?.formCoverage
  return {
    ok: true,
    scope: coverage?.scope,
    complete: coverage?.complete,
    scrolledTop: coverage?.scrolledTop,
    scrolledBottom: coverage?.scrolledBottom,
    segments: coverage?.segments,
    totalFieldsSeen: coverage?.totalFieldsSeen,
    fieldLimitReached: coverage?.fieldLimitReached,
    auditTool: coverage?.auditTool,
  }
}
