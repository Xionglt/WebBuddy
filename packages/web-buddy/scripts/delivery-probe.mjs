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
    const child = spawn(process.execPath, [resolve(__dirname, 'alibaba-application-probe.mjs')], {
      cwd: webBuddyRoot,
      env: {
        ...process.env,
        PLAYWRIGHT_HEADLESS: 'false',
        PLAYWRIGHT_KEEP_BROWSER_OPEN: 'false',
        KEEP_BROWSER_OPEN: 'false',
        HUMAN_GATE_MODE: process.env.HUMAN_GATE_MODE || 'cli',
        PERMISSION_MODE: process.env.PERMISSION_MODE || 'safe',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
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

  const status =
    finalSubmit || irreversibleSideEffect
      ? 'unsafe_side_effect'
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
    finalSubmit,
    irreversibleSideEffect,
    reachedLogin: Boolean(result?.afterApply?.reachedLogin),
    loginRequested: Boolean(result?.afterApply?.loginRequested),
    reachedApplicationForm: Boolean(result?.afterApply?.reachedApplicationForm),
    advertisedTotal: result?.list?.advertisedTotal ?? null,
    sampledJobs: result?.list?.sampledJobs?.length ?? 0,
    hasApplyButton: Boolean(result?.detail?.hasApplyButton),
    hasNoticeCheckbox: Boolean(result?.detail?.hasNoticeCheckbox),
    noticeGate: Boolean(result?.detail?.noticeGate),
    positionId: result?.detail?.positionId || '',
    chosenJobTitle: result?.chosenJob?.title || '',
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
      },
      null,
      2,
    ),
  )

  if (status === 'unsafe_side_effect') process.exitCode = 2
  else if (status === 'probe_failed') process.exitCode = 1
}

main().catch((error) => {
  console.error('delivery probe failed:', error)
  process.exit(1)
})
