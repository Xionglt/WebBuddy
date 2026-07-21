#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import {
  renderRuntimeArtifactEvalMarkdown,
  writeRuntimeArtifactEvalReport,
} from '../dist/evals/runtime-artifact-report.js'
import { runRuntimeArtifactEval } from '../dist/evals/runtime-artifact-runner.js'
import { emptyRunMetrics } from '../dist/metrics/schema.js'

const execFileAsync = promisify(execFile)
const root = await mkdtemp(join(tmpdir(), 'web-buddy-runtime-artifact-report-'))

try {
  const traceDir = join(root, 'trace')
  const outDir = join(root, 'report')
  const cliOutDir = join(root, 'cli-report')
  const casePath = join(root, 'case.json')
  const evalCase = runtimeCase()
  await writeEvidence(traceDir)
  await writeJson(casePath, evalCase)

  const result = runRuntimeArtifactEval({ traceDir, evalCase })
  const markdown = renderRuntimeArtifactEvalMarkdown(result)
  assert.match(markdown, /^# Runtime Artifact Eval/m)
  assert.match(markdown, /Case: `report-case`/)
  assert.match(markdown, /\| completed \| run_status \| PASS \|/)
  assert.match(markdown, /\| summary \| artifact_present \| PASS \|/)

  const paths = await writeRuntimeArtifactEvalReport({ result, outDir })
  assert.equal(JSON.parse(await readFile(paths.jsonPath, 'utf8')).passed, true)
  assert.equal(await readFile(paths.markdownPath, 'utf8'), markdown)

  const { stdout } = await execFileAsync(process.execPath, [
    './dist/cli/runtime-artifact-eval.js',
    '--case', casePath,
    '--trace-dir', traceDir,
    '--out', cliOutDir,
  ], { cwd: process.cwd() })
  assert.match(stdout, /runtime artifact eval: PASS/)
  assert.equal(JSON.parse(await readFile(join(cliOutDir, 'runtime-artifact-eval.json'), 'utf8')).passed, true)

  const failingCasePath = join(root, 'failing-case.json')
  await writeJson(failingCasePath, {
    ...evalCase,
    id: 'failing-case',
    criteria: [{ id: 'no-llm', type: 'metric_threshold', field: 'llmCalls', operator: 'eq', value: 1 }],
  })
  await assert.rejects(
    execFileAsync(process.execPath, [
      './dist/cli/runtime-artifact-eval.js',
      '--case', failingCasePath,
      '--trace-dir', traceDir,
      '--out', join(root, 'failing-report'),
    ], { cwd: process.cwd() }),
    (error) => error.code === 1 && /runtime artifact eval: FAIL/.test(error.stdout),
  )

  console.log('runtime-artifact-report-test: PASS')
} finally {
  await rm(root, { recursive: true, force: true })
}

function runtimeCase() {
  return {
    schemaVersion: 'runtime-artifact-eval-case/v1',
    id: 'report-case',
    description: 'Exercise report and CLI output.',
    expected: { source: 'benchmark', scenario: 'demo-research' },
    criteria: [
      { id: 'completed', type: 'run_status', expected: 'completed' },
      { id: 'summary', type: 'artifact_present', artifact: 'research-summary.json' },
    ],
  }
}

async function writeEvidence(traceDir) {
  await mkdir(join(traceDir, 'artifacts'), { recursive: true })
  await writeJson(join(traceDir, 'run-manifest.json'), {
    schemaVersion: 'run-manifest/v1',
    runId: 'report-run',
    sessionId: 'run_report-run',
    source: 'benchmark',
    scenario: 'demo-research',
    traceDir,
    createdAt: '2026-07-21T00:00:00.000Z',
    files: {},
  })
  await writeJson(join(traceDir, 'metrics.json'), {
    ...emptyRunMetrics({
      runId: 'report-run',
      sessionId: 'run_report-run',
      traceDir,
      source: 'benchmark',
      scenario: 'demo-research',
    }),
    status: 'completed',
    llmCalls: 0,
  })
  await writeJson(join(traceDir, 'safety-report.json'), {
    schemaVersion: 'safety-report/v1',
    runId: 'report-run',
    finalStatus: 'completed',
    finalSubmitAttempted: false,
    finalSubmitBlocked: false,
    loginHandoffRequired: false,
    captchaHandoffRequired: false,
    highRiskActionCount: 0,
    gateCount: 0,
    riskDecisionCount: 0,
    autoAllowedCount: 0,
    gatedCount: 0,
    deniedCount: 0,
    policyCodes: [],
    summary: 'No high-risk or gated actions were recorded.',
  })
  await writeJson(join(traceDir, 'artifacts', 'research-summary.json'), { title: 'Atlas' })
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}
