#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '../../..')
const outputRoot = resolve(repoRoot, 'output')

const live = hasFlag('--live') || process.env.DELIVERY_RUNTIME_PROBE_LIVE === '1'
const targetPositionId =
  argValue('--target-position-id') ||
  process.env.DELIVERY_TARGET_POSITION_ID ||
  process.env.ALIBABA_PROBE_POSITION_ID ||
  ''
const targetJobTitle =
  argValue('--target-job-title') ||
  process.env.DELIVERY_TARGET_JOB_TITLE ||
  process.env.ALIBABA_PROBE_JOB_TITLE ||
  ''

if (live && !targetPositionId && !targetJobTitle) {
  throw new Error('delivery:probe:runtime --live requires --target-position-id or --target-job-title; refusing to drift to a live first job.')
}

const runId = `${live ? 'delivery-runtime-live' : 'delivery-runtime-fixture'}-${stamp()}`
const headless = live ? hasFlag('--headless') : !hasFlag('--headful')
const probeRoot = resolve(outputRoot, 'delivery-runtime-probe', runId)
mkdirSync(probeRoot, { recursive: true })

process.env.PLAYWRIGHT_HEADLESS = headless ? 'true' : 'false'
process.env.PLAYWRIGHT_KEEP_BROWSER_OPEN = 'false'
process.env.KEEP_BROWSER_OPEN = 'false'
process.env.PLAYWRIGHT_TYPE_DELAY_MS = process.env.PLAYWRIGHT_TYPE_DELAY_MS || '0'
process.env.PLAYWRIGHT_SLOWMO_MS = process.env.PLAYWRIGHT_SLOWMO_MS || '0'
if (!live) process.env.PLAYWRIGHT_ALLOW_DATA_URLS = 'true'
if (targetPositionId) process.env.ALIBABA_PROBE_POSITION_ID = targetPositionId
if (targetJobTitle) process.env.ALIBABA_PROBE_JOB_TITLE = targetJobTitle

const {
  AutoHumanGate,
  loadConfig,
  runJobApplicationAgent,
} = await import('../dist/sdk/orchestrator.js')
const { sessionManager } = await import('../dist/session/manager.js')

const gateKinds = []
const config = loadConfig({
  resumePath: resolve(probeRoot, 'sample-resume.pdf'),
  alibabaProbePositionId: targetPositionId,
  alibabaProbeJobTitle: targetJobTitle,
  trace: { outDir: outputRoot },
  human: {
    mode: 'auto',
    permissionMode: 'safe',
    allowFinalSubmit: false,
    autoApproveRisk: ['L0', 'L1', 'L2'],
  },
  agent: { maxSteps: live ? 8 : 7 },
  maxJobPagesToCrawl: Number(process.env.DELIVERY_RUNTIME_PROBE_MAX_PAGES || 5),
  maxJobsToCrawl: Number(process.env.DELIVERY_RUNTIME_PROBE_MAX_JOBS || 100),
  maxJobsToDetail: Number(process.env.DELIVERY_RUNTIME_PROBE_MAX_DETAILS || 10),
  memory: {
    answerStorePath: resolve(probeRoot, 'memory', 'answers.json'),
    permissionRulesPath: resolve(probeRoot, 'memory', 'permission-rules.json'),
    memdirPath: resolve(probeRoot, 'memory', 'memdir'),
  },
})

const events = []
const result = await runJobApplicationAgent({
  config,
  mode: live ? 'alibaba-apply' : 'demo-form',
  source: 'sdk',
  profile: live ? 'delivery-runtime-live' : 'delivery-runtime-fixture',
  runId,
  taskType: 'apply_entry',
  targetPositionId,
  targetJobTitle,
  gate: new AutoHumanGate((kind, decision) => {
    gateKinds.push(kind)
    events.push({ phase: 'human_gate', level: 'gate', message: `${kind}:${decision}` })
  }),
  llm: createDeliveryRuntimeProbeLlm({ live }),
  taskPrompt: live
    ? 'Runtime delivery probe: enter the explicit target application flow if safe, stop at login/captcha/final-submit boundaries, and never final-submit.'
    : 'Runtime delivery probe fixture: inspect the local application form, fill a safe draft, and stop without submit.',
  onEvent: (event) => {
    events.push(event)
    if (process.env.DELIVERY_RUNTIME_PROBE_VERBOSE === '1') {
      console.log(`[${event.level}] ${event.phase}: ${event.message}`)
    }
  },
})

const traceDir = resolve(outputRoot, 'traces', `run_${runId}`)
const sessionDir = result.session?.outputDir
const legacyRunDir = resolve(outputRoot, runId)
const artifactsDir = resolve(traceDir, 'artifacts')
mkdirSync(artifactsDir, { recursive: true })

const traceSession = readJson(resolve(traceDir, 'session.json'))
const metrics = readJson(resolve(traceDir, 'metrics.json'))
const transcript = readJsonl(result.session?.transcriptPath)
const sessionEvents = readJsonl(result.session?.eventsPath)
const traceEvents = readJsonl(resolve(traceDir, 'events.jsonl'))
const spans = readJsonl(resolve(traceDir, 'spans.jsonl'))
const workflow = readJson(result.session?.workflowPath)
const safety = safetyReport({ live, result, transcript, sessionEvents, traceEvents, spans, gateKinds })

const probeResult = {
  schemaVersion: 'delivery-probe-result/v1',
  probeId: runId,
  runId,
  sessionId: result.session?.sessionId ?? traceSession?.sessionId ?? `run_${runId}`,
  scenario: live ? 'alibaba-apply' : 'generic-job-apply',
  startedAt: traceSession?.startedAt ?? result.session?.createdAt ?? new Date().toISOString(),
  endedAt: traceSession?.endedAt ?? result.session?.updatedAt ?? new Date().toISOString(),
  config: {
    schemaVersion: 'delivery-probe-config/v1',
    scenario: live ? 'alibaba-apply' : 'generic-job-apply',
    runLabel: runId,
    goal: live ? 'Explicit Alibaba runtime delivery probe.' : 'Local runtime delivery fixture probe.',
    headful: !headless,
    keepBrowserOpen: false,
    permissionMode: 'safe',
    noFinalSubmit: true,
    noProfileSave: true,
    allowLoginHandoff: live,
    allowCaptchaHandoff: live,
    allowResumeUploadAfterConfirmation: false,
    resumePath: config.resumePath,
    memoryDir: config.memory.memdirPath,
    targetPositionId,
    targetJobTitle,
  },
  artifacts: {
    traceDir,
    sessionDir,
    eventsPath: resolve(traceDir, 'events.jsonl'),
    transcriptPath: result.session?.transcriptPath,
    workflowPath: result.session?.workflowPath,
    screenshots: [],
    toolResultArtifacts: toolResultArtifactUris(transcript, sessionEvents, traceEvents),
    metricsPath: resolve(traceDir, 'metrics.json'),
    legacyRunDir,
  },
  metrics: {
    steps: result.summary.steps,
    llmCalls: Number(metrics?.llmCalls ?? traceSession?.totals?.llmCalls ?? 0),
    toolCalls: Number(metrics?.toolCalls ?? traceSession?.totals?.toolCalls ?? 0),
    browserSnapshots: Number(metrics?.browserSnapshots ?? 0),
    permissionPrompts: sessionEvents.filter((event) => event.type === 'permission_evaluated').length,
    skillHits: Number(metrics?.skillHits ?? 0),
    contextCompactions: Number(metrics?.contextCompactions ?? 0),
    prematureAgentDoneRejects: countNeedle([transcript, sessionEvents, traceEvents], 'PREMATURE_AGENT_DONE_REJECTED'),
  },
  safety,
  outcome: {
    finalStatus: finalStatusFor(result.finalState, safety, live),
    summary: result.message,
    concreteProblem: safety.invariantViolations.length
      ? {
          symptom: 'Delivery probe violated a hard safety invariant.',
          evidence: safety.invariantViolations.map((violation) => violation.evidenceRef),
          suspectedModule: 'runtime-policy',
        }
      : undefined,
    nextAction: live
      ? 'Use the trace/session artifacts to verify login/captcha/final-submit handoff behavior before closing P0/P1 items.'
      : 'Run with --live and an explicit target when real-site evidence is required.',
  },
  runtimeEvidence: {
    runtimePath: true,
    syntheticSession: false,
    traceSessionJson: existsSync(resolve(traceDir, 'session.json')),
    spansJsonl: existsSync(resolve(traceDir, 'spans.jsonl')),
    traceEventsJsonl: existsSync(resolve(traceDir, 'events.jsonl')),
    sessionJson: existsSync(join(sessionDir ?? '', 'session.json')),
    transcriptJsonl: existsSync(result.session?.transcriptPath ?? ''),
    sessionEventsJsonl: existsSync(result.session?.eventsPath ?? ''),
    workflowJson: existsSync(result.session?.workflowPath ?? ''),
    spanCount: spans.length,
    transcriptEntries: transcript.length,
    sessionEvents: sessionEvents.length,
  },
}

const probeResultPath = resolve(artifactsDir, 'delivery-probe-result.json')
writeFileSync(probeResultPath, `${JSON.stringify(stripUndefined(probeResult), null, 2)}\n`, 'utf8')
writeFileSync(resolve(artifactsDir, 'delivery-runtime-events.json'), `${JSON.stringify(events, null, 2)}\n`, 'utf8')

console.log(JSON.stringify({
  runId,
  live,
  status: probeResult.outcome.finalStatus,
  finalState: result.finalState,
  traceDir,
  sessionDir,
  probeResultPath,
  runtimePath: probeResult.runtimeEvidence.runtimePath,
  syntheticSession: probeResult.runtimeEvidence.syntheticSession,
  toolCalls: probeResult.metrics.toolCalls,
  spans: probeResult.runtimeEvidence.spanCount,
  invariantViolations: probeResult.safety.invariantViolations.length,
}, null, 2))

await sessionManager.closeAll().catch(() => {})

if (probeResult.safety.invariantViolations.length > 0) process.exitCode = 2
else if (result.finalState === 'error') process.exitCode = 1

function createDeliveryRuntimeProbeLlm({ live }) {
  let calls = 0
  return {
    hasKey: true,
    label: live ? 'delivery-runtime-live-probe-llm' : 'delivery-runtime-fixture-probe-llm',
    async chat() {
      return 'Runtime delivery probe uses deterministic tool calls.'
    },
    async generateJson() {
      return null
    },
    async ask() {
      return ''
    },
    async chatWithTools(messages) {
      calls += 1
      const rendered = JSON.stringify(messages)
      return live ? liveProbeTurn(calls, rendered) : fixtureProbeTurn(calls)
    },
  }
}

function liveProbeTurn(calls, rendered) {
  if (/login|captcha|sso|登录|验证码/i.test(rendered)) {
    return {
      content: 'A login or captcha boundary is visible; stop for human handoff.',
      toolCalls: [{ id: `runtime-live-done-${calls}`, name: 'agent_done', arguments: { summary: 'Runtime probe stopped at login/captcha handoff; final submit was not executed.', blocked: true } }],
    }
  }
  if (calls === 1) {
    return {
      content: 'Audit the application surface before any completion decision.',
      toolCalls: [{ id: 'runtime-live-audit', name: 'browser_form_audit', arguments: { waitMs: 80 } }],
    }
  }
  return {
    content: 'Runtime live probe gathered application-flow evidence and will stop before submission.',
    toolCalls: [{ id: `runtime-live-done-${calls}`, name: 'agent_done', arguments: { summary: 'Runtime probe reached application-flow evidence and stopped before final submit.', blocked: false } }],
  }
}

function fixtureProbeTurn(calls) {
  const toolCalls = [
    { id: 'runtime-fixture-audit-before', name: 'browser_form_audit', arguments: { waitMs: 0 } },
    { id: 'runtime-fixture-set-name', name: 'browser_set_field', arguments: { label: '姓名 Name', controlKind: 'text', intendedValue: 'Runtime Probe' } },
    { id: 'runtime-fixture-set-phone', name: 'browser_set_field', arguments: { label: '手机 Phone', controlKind: 'text', intendedValue: '13800009999' } },
    { id: 'runtime-fixture-set-email', name: 'browser_set_field', arguments: { label: '邮箱 Email', controlKind: 'text', intendedValue: 'runtime.probe@example.com' } },
    { id: 'runtime-fixture-set-city', name: 'browser_set_field', arguments: { label: '期望城市 City', controlKind: 'text', intendedValue: 'Hangzhou' } },
    { id: 'runtime-fixture-audit-after', name: 'browser_form_audit', arguments: { waitMs: 0 } },
    {
      id: 'runtime-fixture-done',
      name: 'agent_done',
      arguments: {
        summary: 'Candidate detail: local runtime delivery application form audited and safe draft fields filled; final submit was not clicked.',
        blocked: false,
      },
    },
  ]
  const call = toolCalls[calls - 1] ?? toolCalls[toolCalls.length - 1]
  return { content: `Runtime fixture probe step ${calls}.`, toolCalls: [call] }
}

function safetyReport(input) {
  const serialized = JSON.stringify(input)
  const finalSubmitExecuted = /submittedApplication["']?\s*:\s*true|finalSubmitExecuted["']?\s*:\s*true|投递成功|提交成功/i.test(serialized)
  const profileSave = /profileSaveSideEffect["']?\s*:\s*(?!["']?no["']?)/i.test(serialized)
  const resumeUpload = /resumeUploadSideEffect["']?\s*:\s*(?!["']?no["']?)/i.test(serialized)
  const reachedLogin = input.live && /login|sso|登录|登陆/i.test(serialized)
  const reachedCaptcha = input.live && /captcha|验证码|人机验证/i.test(serialized)
  const reachedApplicationForm = /application form|申请|简历草稿|form_audit|browser_form_audit/i.test(serialized)
  const reachedFinalSubmitBoundary = /final_submit|final submit|Submit application|投递申请|确认投递|提交申请/i.test(serialized)
  const blockedGateKinds = [...new Set(input.gateKinds)]
  const invariantViolations = []
  if (finalSubmitExecuted) {
    invariantViolations.push({
      invariant: 'no_final_submit',
      severity: 'P0',
      evidenceRef: 'delivery-probe-result.json#safety.finalSubmitExecuted',
      description: 'Runtime delivery probe detected final-submit execution.',
    })
  }
  if (profileSave) {
    invariantViolations.push({
      invariant: 'no_profile_save',
      severity: 'P0',
      evidenceRef: 'delivery-probe-result.json#safety.profileSaveSideEffect',
      description: 'Runtime delivery probe detected profile save side-effect.',
    })
  }

  return {
    finalSubmitExecuted,
    profileSaveSideEffect: profileSave ? 'unknown' : 'no',
    resumeUploadSideEffect: resumeUpload ? 'unknown' : 'no',
    reachedLogin,
    reachedCaptcha,
    reachedApplicationForm,
    reachedFinalSubmitBoundary,
    blockedGateKinds,
    invariantViolations,
  }
}

function finalStatusFor(finalState, safety, live) {
  if (safety.invariantViolations.length > 0) return 'failed'
  if (safety.reachedCaptcha) return 'blocked_for_captcha'
  if (safety.reachedLogin) return 'blocked_for_login'
  if (!live && (finalState === 'filled' || finalState === 'completed')) return 'draft_ready_not_submitted'
  if (finalState === 'stopped_at_submit' || finalState === 'direct_submit_review' || safety.reachedFinalSubmitBoundary) return 'blocked_at_final_submit'
  if (finalState === 'filled' || finalState === 'completed') return 'draft_ready_not_submitted'
  if (finalState === 'blocked') return 'inconclusive'
  if (finalState === 'error') return 'failed'
  return 'completed_without_submission'
}

function toolResultArtifactUris(...collections) {
  const uris = []
  for (const collection of collections) {
    for (const item of collection ?? []) {
      const artifacts = item.artifacts ?? item.data?.artifacts ?? []
      for (const artifact of artifacts) {
        if (artifact?.uri) uris.push(artifact.uri)
      }
      if (item.data?.artifact?.uri) uris.push(item.data.artifact.uri)
    }
  }
  return [...new Set(uris)]
}

function countNeedle(collections, needle) {
  return collections.reduce((count, collection) => count + (JSON.stringify(collection).match(new RegExp(escapeRegExp(needle), 'g')) ?? []).length, 0)
}

function readJson(path) {
  if (!path || !existsSync(path)) return undefined
  return JSON.parse(readFileSync(path, 'utf8'))
}

function readJsonl(path) {
  if (!path || !existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

function stripUndefined(value) {
  if (Array.isArray(value)) return value.map(stripUndefined)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .map(([key, item]) => [key, stripUndefined(item)]),
  )
}

function stamp() {
  return new Date().toISOString().replaceAll(':', '-').replace(/\.\d{3}Z$/, 'Z')
}

function hasFlag(name) {
  return process.argv.includes(name)
}

function argValue(name) {
  const index = process.argv.indexOf(name)
  return index === -1 ? '' : process.argv[index + 1] || ''
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
