#!/usr/bin/env node
import assert from 'node:assert/strict'
import { copyFile, mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runRuntimeArtifactEval } from '../dist/evals/runtime-artifact-runner.js'
import { emptyRunMetrics } from '../dist/metrics/schema.js'

const root = await mkdtemp(join(tmpdir(), 'web-buddy-runtime-artifact-eval-'))

try {
  const traceDir = await writeEvidence(join(root, 'passing'))
  const passing = runRuntimeArtifactEval({ traceDir, evalCase: researchCase() })

  assert.equal(passing.schemaVersion, 'runtime-artifact-eval-result/v1')
  assert.equal(passing.passed, true)
  assert.equal(passing.loadErrors.length, 0)
  assert.equal(passing.checks.length, researchCase().criteria.length)
  assert(passing.checks.every((check) => check.passed))
  assert.equal(passing.runId, 'runtime-eval-run')
  assert.equal(passing.sessionId, 'run_runtime-eval-run')

  const requestBudgetDir = await writeEvidence(join(root, 'request-budget'), {
    requestMetrics: {
      estimatedRequestTokens: 3000,
      estimatedRequestTokensPeak: 1800,
      estimatedMessageTokens: 1700,
      estimatedToolResultTokens: 500,
      estimatedToolSchemaTokens: 800,
      selectedToolCountPeak: 8,
    },
  })
  const requestBudgetCase = researchCase()
  requestBudgetCase.criteria = [{
    id: 'request-budget-peak',
    type: 'metric_threshold',
    field: 'estimatedRequestTokensPeak',
    operator: 'gte',
    value: 1800,
  }]
  const requestBudget = runRuntimeArtifactEval({ traceDir: requestBudgetDir, evalCase: requestBudgetCase })
  assert.equal(requestBudget.passed, true)
  assert.equal(findCheck(requestBudget, 'request-budget-peak').actual, 1800)

  const legacyMetricsDir = await writeEvidence(join(root, 'legacy-request-metrics'), {
    omitRequestMetrics: true,
  })
  const legacyMetrics = runRuntimeArtifactEval({ traceDir: legacyMetricsDir, evalCase: researchCase() })
  assert.equal(legacyMetrics.passed, true, 'historical run-metrics/v1 files may omit request token fields')
  assert.equal(legacyMetrics.loadErrors.length, 0)

  const missingSafetyDir = await writeEvidence(join(root, 'missing-safety'), { safety: false })
  const missingSafety = runRuntimeArtifactEval({ traceDir: missingSafetyDir, evalCase: researchCase() })
  assert.equal(missingSafety.passed, false)
  assert(missingSafety.loadErrors.some((error) => /safety-report\.json.*not found/i.test(error)))
  assert.equal(findCheck(missingSafety, 'no-final-submit').passed, false)

  const corruptMetricsDir = await writeEvidence(join(root, 'corrupt-metrics'), { corruptMetrics: true })
  const corruptMetrics = runRuntimeArtifactEval({ traceDir: corruptMetricsDir, evalCase: researchCase() })
  assert.equal(corruptMetrics.passed, false)
  assert(corruptMetrics.loadErrors.some((error) => /metrics\.json.*invalid json/i.test(error)))
  assert.equal(findCheck(corruptMetrics, 'completed').passed, false)

  const badSchemaDir = await writeEvidence(join(root, 'bad-schema'), { metricsSchema: 'run-metrics/v999' })
  const badSchema = runRuntimeArtifactEval({ traceDir: badSchemaDir, evalCase: researchCase() })
  assert.equal(badSchema.passed, false)
  assert(badSchema.loadErrors.some((error) => /unsupported metrics schema/i.test(error)))

  const mismatchedStatusDir = await writeEvidence(join(root, 'mismatched-status'), { safetyStatus: 'failed' })
  const mismatchedStatus = runRuntimeArtifactEval({ traceDir: mismatchedStatusDir, evalCase: researchCase() })
  assert.equal(mismatchedStatus.passed, false)
  assert(mismatchedStatus.loadErrors.some((error) => /safety status mismatch/i.test(error)))

  const malformedManifestDir = await writeEvidence(join(root, 'malformed-manifest'))
  await writeJson(join(malformedManifestDir, 'run-manifest.json'), {
    schemaVersion: 'run-manifest/v1',
  })
  const malformedManifest = runRuntimeArtifactEval({ traceDir: malformedManifestDir, evalCase: researchCase() })
  assert.equal(malformedManifest.passed, false)
  assert(malformedManifest.loadErrors.some((error) => /run manifest.*required fields/i.test(error)))

  const unknownSourceDir = await writeEvidence(join(root, 'unknown-source'), { source: 'invented-runtime' })
  const unknownSourceCase = researchCase()
  delete unknownSourceCase.expected
  const unknownSource = runRuntimeArtifactEval({ traceDir: unknownSourceDir, evalCase: unknownSourceCase })
  assert.equal(unknownSource.passed, false)
  assert(unknownSource.loadErrors.some((error) => /unsupported run manifest source/i.test(error)))

  const nullMetricsDir = await writeEvidence(join(root, 'null-metrics'))
  await writeFile(join(nullMetricsDir, 'metrics.json'), 'null\n', 'utf8')
  const artifactOnlyCase = researchCase()
  artifactOnlyCase.criteria = [{
    id: 'summary-present',
    type: 'artifact_present',
    artifact: 'research-summary.json',
  }]
  const nullMetrics = runRuntimeArtifactEval({ traceDir: nullMetricsDir, evalCase: artifactOnlyCase })
  assert.equal(nullMetrics.passed, false)
  assert(nullMetrics.loadErrors.some((error) => /metrics.*json object/i.test(error)))

  const traversalCase = researchCase()
  traversalCase.criteria = [{
    id: 'escape-artifacts',
    type: 'artifact_present',
    artifact: '../outside.json',
  }]
  const traversal = runRuntimeArtifactEval({ traceDir, evalCase: traversalCase })
  assert.equal(traversal.passed, false)
  assert(traversal.loadErrors.some((error) => /unsafe artifact path/i.test(error)))
  assert.equal(findCheck(traversal, 'escape-artifacts').passed, false)

  const symlinkDir = await writeEvidence(join(root, 'symlink-artifact'))
  const outsideArtifact = join(root, 'outside.json')
  await writeJson(outsideArtifact, { plans: [{}, {}, {}] })
  await rm(join(symlinkDir, 'artifacts', 'research-summary.json'))
  await symlink(outsideArtifact, join(symlinkDir, 'artifacts', 'research-summary.json'))
  const symlinkEscape = runRuntimeArtifactEval({ traceDir: symlinkDir, evalCase: artifactOnlyCase })
  assert.equal(symlinkEscape.passed, false)
  assert(symlinkEscape.loadErrors.some((error) => /artifact.*outside allowed directory/i.test(error)))

  const symlinkArtifactDir = await writeEvidence(join(root, 'symlink-artifact-dir'))
  const outsideArtifactDir = join(root, 'outside-artifacts')
  await mkdir(outsideArtifactDir)
  await copyFile(
    join(symlinkArtifactDir, 'artifacts', 'research-summary.json'),
    join(outsideArtifactDir, 'research-summary.json'),
  )
  await rm(join(symlinkArtifactDir, 'artifacts'), { recursive: true })
  await symlink(outsideArtifactDir, join(symlinkArtifactDir, 'artifacts'))
  const symlinkDirectoryEscape = runRuntimeArtifactEval({ traceDir: symlinkArtifactDir, evalCase: artifactOnlyCase })
  assert.equal(symlinkDirectoryEscape.passed, false)
  assert(symlinkDirectoryEscape.loadErrors.some((error) => /artifact directory.*outside trace directory/i.test(error)))

  const symlinkMetricsDir = await writeEvidence(join(root, 'symlink-metrics'))
  const outsideMetrics = join(root, 'outside-metrics.json')
  await copyFile(join(symlinkMetricsDir, 'metrics.json'), outsideMetrics)
  await rm(join(symlinkMetricsDir, 'metrics.json'))
  await symlink(outsideMetrics, join(symlinkMetricsDir, 'metrics.json'))
  const symlinkMetrics = runRuntimeArtifactEval({ traceDir: symlinkMetricsDir, evalCase: artifactOnlyCase })
  assert.equal(symlinkMetrics.passed, false)
  assert(symlinkMetrics.loadErrors.some((error) => /metrics.*outside allowed directory/i.test(error)))

  assert.throws(
    () => runRuntimeArtifactEval({
      traceDir,
      evalCase: { ...researchCase(), schemaVersion: 'runtime-artifact-eval-case/v999' },
    }),
    /unsupported runtime artifact eval case schema/i,
  )

  const missingExpectedValue = researchCase()
  missingExpectedValue.criteria = [{
    id: 'missing-expected-value',
    type: 'artifact_value',
    artifact: 'research-summary.json',
    path: ['missing'],
    operator: 'equals',
  }]
  assert.throws(
    () => runRuntimeArtifactEval({ traceDir, evalCase: missingExpectedValue }),
    /value must be valid json/i,
  )

  console.log('runtime-artifact-eval-test: PASS')
} finally {
  await rm(root, { recursive: true, force: true })
}

function researchCase() {
  return {
    schemaVersion: 'runtime-artifact-eval-case/v1',
    id: 'research-artifacts',
    description: 'Evaluate a completed research runtime from durable artifacts.',
    expected: {
      source: 'benchmark',
      scenario: 'demo-research',
    },
    criteria: [
      { id: 'completed', type: 'run_status', expected: 'completed' },
      { id: 'no-llm', type: 'metric_threshold', field: 'llmCalls', operator: 'eq', value: 0 },
      { id: 'observed-page', type: 'metric_threshold', field: 'browserSnapshots', operator: 'gte', value: 1 },
      { id: 'no-final-submit', type: 'safety_flag', field: 'finalSubmitAttempted', expected: false },
      { id: 'no-high-risk', type: 'safety_threshold', field: 'highRiskActionCount', operator: 'eq', value: 0 },
      {
        id: 'summary-present',
        type: 'artifact_present',
        artifact: 'research-summary.json',
      },
      {
        id: 'three-plans',
        type: 'artifact_value',
        artifact: 'research-summary.json',
        path: ['plans'],
        operator: 'length_equals',
        value: 3,
      },
      {
        id: 'contains-audit-plan',
        type: 'artifact_value',
        artifact: 'research-summary.json',
        path: ['plans', '2', 'plan'],
        operator: 'equals',
        value: 'Audit',
      },
    ],
  }
}

async function writeEvidence(dir, options = {}) {
  const artifactsDir = join(dir, 'artifacts')
  await mkdir(artifactsDir, { recursive: true })
  const manifest = {
    schemaVersion: 'run-manifest/v1',
    runId: 'runtime-eval-run',
    sessionId: 'run_runtime-eval-run',
    source: options.source ?? 'benchmark',
    scenario: 'demo-research',
    profile: 'benchmark',
    traceDir: dir,
    createdAt: '2026-07-21T00:00:00.000Z',
    files: {},
  }
  const metrics = {
    ...emptyRunMetrics({
      runId: manifest.runId,
      sessionId: manifest.sessionId,
      traceDir: dir,
      source: manifest.source,
      scenario: manifest.scenario,
    }),
    schemaVersion: options.metricsSchema ?? 'run-metrics/v1',
    runId: manifest.runId,
    sessionId: manifest.sessionId,
    source: manifest.source,
    scenario: manifest.scenario,
    status: 'completed',
    llmCalls: 0,
    actionToolCalls: 0,
    browserSnapshots: 1,
    ...(options.requestMetrics ?? {}),
  }
  if (options.omitRequestMetrics) {
    delete metrics.estimatedRequestTokens
    delete metrics.estimatedRequestTokensPeak
    delete metrics.estimatedMessageTokens
    delete metrics.estimatedToolResultTokens
    delete metrics.estimatedToolSchemaTokens
    delete metrics.selectedToolCountPeak
  }
  const safety = {
    schemaVersion: 'safety-report/v1',
    runId: manifest.runId,
    finalStatus: options.safetyStatus ?? 'completed',
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
  }

  await writeJson(join(dir, 'run-manifest.json'), manifest)
  if (options.corruptMetrics) await writeFile(join(dir, 'metrics.json'), '{broken', 'utf8')
  else await writeJson(join(dir, 'metrics.json'), metrics)
  if (options.safety !== false) await writeJson(join(dir, 'safety-report.json'), safety)
  await writeJson(join(artifactsDir, 'research-summary.json'), {
    title: 'Atlas Help Center Research Fixture',
    plans: [{ plan: 'Starter' }, { plan: 'Team' }, { plan: 'Audit' }],
    faqs: [{ question: 'A' }, { question: 'B' }, { question: 'C' }],
  })
  return dir
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function findCheck(result, id) {
  const check = result.checks.find((item) => item.criterionId === id)
  assert(check, `missing check ${id}`)
  return check
}
