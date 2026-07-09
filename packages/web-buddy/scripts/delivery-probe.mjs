#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '../../..')
const webBuddyRoot = resolve(__dirname, '..')

function stamp() {
  return new Date().toISOString().replaceAll(':', '-').replace(/\.\d{3}Z$/, 'Z')
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function argValue(name) {
  const index = process.argv.indexOf(name)
  return index === -1 ? '' : process.argv[index + 1] || ''
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

function writeJson(path, value) {
  return writeFile(path, `${JSON.stringify(value, null, 2)}\n`)
}

function parseProbeJson(stdout) {
  const start = stdout.indexOf('{')
  const end = stdout.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) return null
  return JSON.parse(stdout.slice(start, end + 1))
}

function runProbe() {
  return new Promise((resolveRun) => {
    const startedAt = new Date()
    const waitOnLogin = process.env.DELIVERY_WAIT_ON_LOGIN === 'true'
    const probeArgs = [resolve(__dirname, 'alibaba-application-probe.mjs')]
    if (targetPositionId) probeArgs.push('--target-position-id', targetPositionId)
    if (targetJobTitle) probeArgs.push('--target-job-title', targetJobTitle)
    const child = spawn(process.execPath, probeArgs, {
      cwd: webBuddyRoot,
      env: {
        ...process.env,
        DELIVERY_TARGET_POSITION_ID: targetPositionId,
        DELIVERY_TARGET_JOB_TITLE: targetJobTitle,
        ALIBABA_PROBE_POSITION_ID: targetPositionId,
        ALIBABA_PROBE_JOB_TITLE: targetJobTitle,
        PLAYWRIGHT_HEADLESS: 'false',
        PLAYWRIGHT_KEEP_BROWSER_OPEN: 'false',
        KEEP_BROWSER_OPEN: 'false',
        HUMAN_GATE_MODE: process.env.HUMAN_GATE_MODE || 'cli',
        PERMISSION_MODE: process.env.PERMISSION_MODE || 'safe',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    if (waitOnLogin) {
      process.stdin.resume()
      const forwardInput = (chunk) => {
        if (!child.killed) {
          child.stdin.write(chunk)
          child.stdin.end()
        }
        process.stdin.off('data', forwardInput)
        process.stdin.pause()
      }
      process.stdin.on('data', forwardInput)
      child.on('close', () => {
        process.stdin.off('data', forwardInput)
        process.stdin.pause()
      })
    } else {
      child.stdin.end()
    }
    child.stdout.on('data', (chunk) => {
      const text = chunk.toString()
      stdout += text
      process.stdout.write(text)
    })
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString()
      stderr += text
      process.stderr.write(text)
    })
    child.on('close', (code, signal) => {
      resolveRun({
        code,
        signal,
        startedAt,
        endedAt: new Date(),
        stdout,
        stderr,
        result: parseProbeJson(stdout),
      })
    })
  })
}

async function main() {
  if (!targetPositionId && !targetJobTitle) {
    throw new Error('delivery-probe requires --target-position-id or --target-job-title; refusing to default to the live first Alibaba job.')
  }

  const runId = `delivery-probe-${stamp()}`
  const sessionId = `run_${runId}`
  const traceDir = resolve(repoRoot, 'output/traces', sessionId)
  const sessionDir = resolve(repoRoot, 'output/sessions', sessionId)
  const artifactsDir = resolve(traceDir, 'artifacts')

  await mkdir(artifactsDir, { recursive: true })
  await mkdir(sessionDir, { recursive: true })

  const run = await runProbe()
  const durationMs = run.endedAt.getTime() - run.startedAt.getTime()
  const result = run.result
  const finalSubmit =
    Boolean(result?.safety?.submittedApplication) ||
    /final_submit|submittedApplication.*true|提交申请成功|投递成功/i.test(run.stdout + run.stderr)
  const irreversibleSideEffect =
    finalSubmit ||
    Boolean(result?.safety?.uploadedResume) ||
    /upload(ed)?Resume.*true|上传简历成功/i.test(run.stdout + run.stderr)
  const targetDrift = Boolean(
    result?.target?.drift ||
      (targetPositionId && normalizePositionId(result?.detail?.positionId) !== normalizePositionId(targetPositionId)) ||
      (targetJobTitle && compactText(result?.chosenJob?.title) !== compactText(targetJobTitle)),
  )
  const fieldAssertionsPassed = Boolean(result?.fieldAssertions?.passed)

  const status =
    finalSubmit || irreversibleSideEffect
      ? 'unsafe_side_effect'
      : targetDrift
        ? 'target_drift'
      : run.code === 0 && result?.ok
        ? 'safe_blocked_or_presubmit'
        : 'probe_failed'

  const metrics = {
    schemaVersion: 'delivery-probe-metrics/v1',
    generatedAt: new Date().toISOString(),
    runId,
    sessionId,
    traceDir,
    sessionDir,
    source: 'delivery-probe',
    scenario: 'alibaba-presubmit',
    status,
    durationMs,
    processExitCode: run.code,
    processSignal: run.signal,
    headful: true,
    savedProfileData: false,
    targetPositionId,
    targetJobTitle,
    targetMatchedBy: targetPositionId ? 'positionId' : 'jobTitle',
    targetDrift,
    fieldAssertionsPassed,
    finalSubmit,
    irreversibleSideEffect,
    reachedLogin: Boolean(result?.afterApply?.reachedLogin),
    loginRequested: Boolean(result?.afterApply?.loginRequested),
    reachedApplicationForm: Boolean(result?.afterApply?.reachedApplicationForm),
    manualLoginHandoff: Boolean(result?.afterApply?.manualLoginHandoff),
    manualLoginContinued: Boolean(result?.afterApply?.manualLoginContinued),
    advertisedTotal: result?.list?.advertisedTotal ?? null,
    sampledJobs: result?.list?.sampledJobs?.length ?? 0,
    hasApplyButton: Boolean(result?.detail?.hasApplyButton),
    hasNoticeCheckbox: Boolean(result?.detail?.hasNoticeCheckbox),
    noticeGate: Boolean(result?.detail?.noticeGate),
    positionId: result?.detail?.positionId || '',
    chosenJobTitle: result?.chosenJob?.title || '',
    detailUrl: result?.detail?.urlBeforeApply || '',
    extractorSource: result?.list?.extractorSource || '',
    domCardCount: result?.list?.domCardCount ?? null,
    apiPagesScanned: result?.list?.apiPagesScanned ?? null,
    networkEvents: result?.recentNetworkEvents?.length ?? 0,
    stdoutBytes: Buffer.byteLength(run.stdout),
    stderrBytes: Buffer.byteLength(run.stderr),
    resultSha256: sha256(JSON.stringify(result || {})),
  }

  const manifest = {
    schemaVersion: 'run-manifest/v1',
    runId,
    sessionId,
    source: 'delivery-probe',
    scenario: 'alibaba-presubmit',
    profile: 'safe-headful-no-save',
    runDir: traceDir,
    traceDir,
    sessionDir,
    createdAt: run.startedAt.toISOString(),
    files: {
      metricsJson: resolve(traceDir, 'metrics.json'),
      eventsJsonl: resolve(traceDir, 'events.jsonl'),
      sessionJson: resolve(sessionDir, 'session.json'),
      resultJson: resolve(artifactsDir, 'probe-result.json'),
      stdoutTxt: resolve(artifactsDir, 'stdout.txt'),
      stderrTxt: resolve(artifactsDir, 'stderr.txt'),
    },
    safety: {
      headfulRequired: true,
      noFinalSubmit: true,
      noCaptchaBypass: true,
      noProfileSaveByDefault: true,
    },
    target: {
      positionId: targetPositionId,
      jobTitle: targetJobTitle,
      matchedBy: targetPositionId ? 'positionId' : 'jobTitle',
    },
  }

  const session = {
    schemaVersion: 'agent-trace/v1',
    sessionId,
    runId,
    source: 'delivery-probe',
    scenario: 'alibaba-presubmit',
    cwd: webBuddyRoot,
    status,
    startedAt: run.startedAt.toISOString(),
    endedAt: run.endedAt.toISOString(),
    redactionMode: 'redacted',
    totals: {
      spans: 0,
      llmCalls: 0,
      toolCalls: 0,
      browserSnapshots: 0,
      screenshots: 0,
      networkEvents: metrics.networkEvents,
    },
    metadata: {
      traceDir,
      sessionDir,
      metrics,
      target: manifest.target,
    },
  }

  const events = [
    {
      type: 'delivery_probe.completed',
      at: run.endedAt.toISOString(),
      runId,
      status,
      metrics,
      result,
    },
  ]

  await writeJson(resolve(traceDir, 'metrics.json'), metrics)
  await writeJson(resolve(traceDir, 'run-manifest.json'), manifest)
  await writeJson(resolve(sessionDir, 'session.json'), session)
  await writeJson(resolve(artifactsDir, 'probe-result.json'), result || { parseError: true })
  await writeFile(resolve(artifactsDir, 'stdout.txt'), run.stdout)
  await writeFile(resolve(artifactsDir, 'stderr.txt'), run.stderr)
  await writeFile(resolve(traceDir, 'events.jsonl'), events.map((event) => JSON.stringify(event)).join('\n') + '\n')
  await writeFile(resolve(traceDir, status === 'probe_failed' ? 'FAILED' : 'DONE'), `${status}\n`)

  console.log(
    JSON.stringify(
      {
        runId,
        traceDir,
        sessionDir,
        metricsPath: resolve(traceDir, 'metrics.json'),
        status,
        finalSubmit,
        irreversibleSideEffect,
        targetPositionId,
        targetJobTitle,
        targetDrift,
        fieldAssertionsPassed,
      },
      null,
      2,
    ),
  )

  if (status === 'unsafe_side_effect') process.exitCode = 2
  else if (status === 'probe_failed' || status === 'target_drift') process.exitCode = 1
}

main().catch((error) => {
  console.error('delivery probe failed:', error)
  process.exit(1)
})
