import { isDeepStrictEqual } from 'node:util'
import { loadRuntimeArtifactEvidence } from './runtime-artifact-loader.js'
import {
  assertRuntimeArtifactEvalCase,
  type RuntimeArtifactCriterion,
  type RuntimeArtifactEvalCase,
  type RuntimeArtifactEvalCheck,
  type RuntimeArtifactEvalResult,
  type RuntimeArtifactThresholdOperator,
} from './runtime-artifact-schema.js'

export function runRuntimeArtifactEval(input: {
  traceDir: string
  evalCase: RuntimeArtifactEvalCase | unknown
}): RuntimeArtifactEvalResult {
  assertRuntimeArtifactEvalCase(input.evalCase)
  const evalCase = input.evalCase
  const evidence = loadRuntimeArtifactEvidence({ traceDir: input.traceDir, evalCase })
  const checks = evalCase.criteria.map((criterion) => evaluateCriterion(criterion, evidence))
  return {
    schemaVersion: 'runtime-artifact-eval-result/v1',
    caseId: evalCase.id,
    generatedAt: new Date().toISOString(),
    traceDir: evidence.traceDir,
    runId: evidence.manifest?.runId,
    sessionId: evidence.manifest?.sessionId,
    source: evidence.manifest?.source,
    scenario: evidence.manifest?.scenario,
    passed: evidence.loadErrors.length === 0 && checks.every((check) => check.passed),
    checks,
    loadErrors: evidence.loadErrors,
  }
}

type Evidence = ReturnType<typeof loadRuntimeArtifactEvidence>

function evaluateCriterion(criterion: RuntimeArtifactCriterion, evidence: Evidence): RuntimeArtifactEvalCheck {
  switch (criterion.type) {
    case 'run_status':
      return compareCheck(criterion, evidence.metrics?.status, criterion.expected, evidence.metricsPath)
    case 'metric_threshold':
      return thresholdCheck(criterion, evidence.metrics?.[criterion.field], evidence.metricsPath)
    case 'safety_flag':
      return compareCheck(criterion, evidence.safetyReport?.[criterion.field], criterion.expected, evidence.safetyReportPath)
    case 'safety_threshold':
      return thresholdCheck(criterion, evidence.safetyReport?.[criterion.field], evidence.safetyReportPath)
    case 'artifact_present': {
      const actual = evidence.artifacts.get(criterion.artifact)
      const error = evidence.artifactErrors.get(criterion.artifact)
      const schema = isRecord(actual) ? actual.schemaVersion : undefined
      const passed = !error && actual !== undefined &&
        (criterion.schemaVersion === undefined || schema === criterion.schemaVersion)
      return {
        criterionId: criterion.id,
        criterionType: criterion.type,
        passed,
        expected: criterion.schemaVersion ? { present: true, schemaVersion: criterion.schemaVersion } : { present: true },
        actual: error ? { present: false } : { present: actual !== undefined, ...(schema === undefined ? {} : { schemaVersion: schema }) },
        evidencePath: evidence.artifactPaths.get(criterion.artifact),
        message: error ?? (passed ? 'Artifact is present.' : 'Artifact is missing or has an unexpected schema.'),
      }
    }
    case 'artifact_value': {
      const artifact = evidence.artifacts.get(criterion.artifact)
      const error = evidence.artifactErrors.get(criterion.artifact)
      const actual = error ? undefined : valueAtPath(artifact, criterion.path)
      const passed = !error && compareArtifactValue(actual, criterion.operator, criterion.value)
      return {
        criterionId: criterion.id,
        criterionType: criterion.type,
        passed,
        expected: { operator: criterion.operator, value: criterion.value },
        actual,
        evidencePath: evidence.artifactPaths.get(criterion.artifact),
        message: error ?? (passed ? 'Artifact value matched.' : `Artifact value at ${criterion.path.join('.')} did not match.`),
      }
    }
  }
}

function compareCheck(
  criterion: RuntimeArtifactCriterion,
  actual: unknown,
  expected: unknown,
  evidencePath: string,
): RuntimeArtifactEvalCheck {
  const passed = isDeepStrictEqual(actual, expected)
  return {
    criterionId: criterion.id,
    criterionType: criterion.type,
    passed,
    expected,
    actual,
    evidencePath,
    message: passed ? 'Value matched.' : `Expected ${formatValue(expected)}, got ${formatValue(actual)}.`,
  }
}

function thresholdCheck(
  criterion: Extract<RuntimeArtifactCriterion, { type: 'metric_threshold' | 'safety_threshold' }>,
  actual: unknown,
  evidencePath: string,
): RuntimeArtifactEvalCheck {
  const passed = typeof actual === 'number' && Number.isFinite(actual) &&
    compareNumber(actual, criterion.operator, criterion.value)
  return {
    criterionId: criterion.id,
    criterionType: criterion.type,
    passed,
    expected: { operator: criterion.operator, value: criterion.value },
    actual,
    evidencePath,
    message: passed
      ? 'Numeric threshold matched.'
      : `Expected ${criterion.field} ${criterion.operator} ${criterion.value}, got ${formatValue(actual)}.`,
  }
}

function compareNumber(actual: number, operator: RuntimeArtifactThresholdOperator, expected: number): boolean {
  if (operator === 'eq') return actual === expected
  if (operator === 'gte') return actual >= expected
  return actual <= expected
}

function compareArtifactValue(actual: unknown, operator: 'equals' | 'length_equals' | 'contains', expected: unknown): boolean {
  if (operator === 'equals') return isDeepStrictEqual(actual, expected)
  if (operator === 'length_equals') {
    return (Array.isArray(actual) || typeof actual === 'string') && actual.length === expected
  }
  if (typeof actual === 'string' && typeof expected === 'string') return actual.includes(expected)
  return Array.isArray(actual) && actual.some((item) => isDeepStrictEqual(item, expected))
}

function valueAtPath(value: unknown, path: readonly string[]): unknown {
  let current = value
  for (const segment of path) {
    if (Array.isArray(current)) {
      if (!/^\d+$/.test(segment)) return undefined
      current = current[Number(segment)]
      continue
    }
    if (!isRecord(current) || !Object.prototype.hasOwnProperty.call(current, segment)) return undefined
    current = current[segment]
  }
  return current
}

function formatValue(value: unknown): string {
  return value === undefined ? 'undefined' : JSON.stringify(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
