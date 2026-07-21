#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runRuntimeArtifactEval } from '../dist/evals/runtime-artifact-runner.js'
import { writeRuntimeArtifactEvalReport } from '../dist/evals/runtime-artifact-report.js'
import { generateAndWriteSafetyReport } from '../dist/policy/safety-report.js'
import { loadConfig } from '../dist/sdk/config.js'
import { runJobApplicationAgent } from '../dist/sdk/orchestrator.js'
import { sessionManager } from '../dist/session/manager.js'

const runId = `runtime-artifact-e2e-${Date.now()}`
const outputDir = join(tmpdir(), runId)
const traceDir = join(outputDir, 'traces', `run_${runId}`)
const reportDir = join(outputDir, 'eval-report')

try {
  const evalCase = JSON.parse(await readFile('./evals/cases/demo-research-runtime.json', 'utf8'))
  const config = loadConfig({
    model: { apiKey: null, authToken: null },
    trace: { outDir: outputDir },
    browser: {
      headless: true,
      visualHighlight: false,
      typeDelayMs: 0,
      slowMoMs: 0,
      keepBrowserOpen: false,
    },
    human: { mode: 'auto' },
  })

  const runtime = await runJobApplicationAgent({
    config,
    mode: 'demo-research',
    runId,
    source: 'benchmark',
    profile: 'benchmark',
    taskPrompt: 'Run the local read-only web research runtime artifact evaluation.',
  })
  assert.equal(runtime.finalState, 'completed')

  generateAndWriteSafetyReport({ traceDir })
  const result = runRuntimeArtifactEval({ traceDir, evalCase })
  const paths = await writeRuntimeArtifactEvalReport({ result, outDir: reportDir })

  assert.equal(result.passed, true, result.loadErrors.join('\n'))
  assert.equal(result.runId, runId)
  assert.equal(result.sessionId, `run_${runId}`)
  assert.equal(result.scenario, 'demo-research')
  assert(result.checks.every((check) => check.passed))

  const jsonReport = JSON.parse(await readFile(paths.jsonPath, 'utf8'))
  const markdownReport = await readFile(paths.markdownPath, 'utf8')
  assert.equal(jsonReport.runId, runId)
  assert.equal(jsonReport.passed, true)
  assert(markdownReport.includes(`Run: \`${runId}\``))
  assert.match(markdownReport, /Result: \*\*PASS\*\*/)

  console.log('runtime-artifact-e2e-test: PASS')
} finally {
  await sessionManager.closeAll().catch(() => {})
  await rm(outputDir, { recursive: true, force: true })
}
