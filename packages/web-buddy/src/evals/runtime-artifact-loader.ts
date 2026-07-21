import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { RunMetrics } from '../metrics/schema.js'
import type { RunManifest } from '../metrics/trace-inputs.js'
import type { SafetyReport } from '../policy/safety-report.js'
import {
  RUNTIME_ARTIFACT_METRIC_FIELDS,
  RUNTIME_ARTIFACT_RUN_SOURCES,
  RUNTIME_ARTIFACT_SAFETY_FLAG_FIELDS,
  RUNTIME_ARTIFACT_SAFETY_METRIC_FIELDS,
  type RuntimeArtifactEvalCase,
} from './runtime-artifact-schema.js'

export interface RuntimeArtifactEvidence {
  traceDir: string
  manifestPath: string
  metricsPath: string
  safetyReportPath: string
  manifest?: RunManifest
  metrics?: RunMetrics
  safetyReport?: SafetyReport
  artifacts: Map<string, unknown>
  artifactPaths: Map<string, string>
  artifactErrors: Map<string, string>
  loadErrors: string[]
}

export function loadRuntimeArtifactEvidence(input: {
  traceDir: string
  evalCase: RuntimeArtifactEvalCase
}): RuntimeArtifactEvidence {
  const traceDir = canonicalDirectory(input.traceDir)
  const manifestPath = join(traceDir, 'run-manifest.json')
  const metricsPath = join(traceDir, 'metrics.json')
  const safetyReportPath = join(traceDir, 'safety-report.json')
  const loadErrors: string[] = []
  const manifest = loadRunManifest(manifestPath, traceDir, loadErrors)
  const metrics = loadRunMetrics(metricsPath, traceDir, loadErrors)
  const safetyReport = loadSafetyReport(safetyReportPath, traceDir, loadErrors)

  if (manifest) compareManifestTraceDir(manifest, traceDir, loadErrors)
  if (manifest && metrics) {
    compareIdentity('runId', manifest.runId, metrics.runId, loadErrors)
    compareIdentity('sessionId', manifest.sessionId, metrics.sessionId, loadErrors)
    compareIdentity('source', manifest.source, metrics.source, loadErrors)
    compareIdentity('scenario', manifest.scenario, metrics.scenario, loadErrors)
  }
  if (manifest && safetyReport) {
    compareIdentity('safety runId', manifest.runId, safetyReport.runId, loadErrors)
  }
  if (metrics && safetyReport) {
    compareIdentity('safety status', metrics.status, safetyReport.finalStatus, loadErrors)
  }
  if (manifest) compareExpected(input.evalCase, manifest, loadErrors)

  const artifacts = new Map<string, unknown>()
  const artifactPaths = new Map<string, string>()
  const artifactErrors = new Map<string, string>()
  const artifactsDir = join(traceDir, 'artifacts')
  const artifactDirectorySafe = isPathWithinDirectory(artifactsDir, traceDir)
  if (!artifactDirectorySafe) loadErrors.push('Artifact directory resolves outside trace directory.')
  for (const name of artifactNames(input.evalCase)) {
    if (!isSafeArtifactName(name)) {
      const message = `Unsafe artifact path: ${name}`
      artifactErrors.set(name, message)
      loadErrors.push(message)
      continue
    }
    const path = join(artifactsDir, name)
    const errors: string[] = []
    artifactPaths.set(name, path)
    if (!artifactDirectorySafe) {
      artifactErrors.set(name, 'Artifact directory resolves outside trace directory.')
      continue
    }
    if (!isPathWithinDirectory(path, artifactsDir)) {
      const message = `Artifact ${name} resolves outside allowed directory.`
      artifactErrors.set(name, message)
      loadErrors.push(message)
      continue
    }
    const value = readJson(path, `artifact ${name}`, errors)
    if (value !== undefined) artifacts.set(name, value)
    if (errors.length) {
      const message = errors.join('; ')
      artifactErrors.set(name, message)
      loadErrors.push(message)
    }
  }

  return {
    traceDir,
    manifestPath,
    metricsPath,
    safetyReportPath,
    manifest,
    metrics,
    safetyReport,
    artifacts,
    artifactPaths,
    artifactErrors,
    loadErrors: unique(loadErrors),
  }
}

function canonicalDirectory(path: string): string {
  const resolved = resolve(path)
  if (!existsSync(resolved)) return resolved
  try {
    return realpathSync(resolved)
  } catch {
    return resolved
  }
}

function compareManifestTraceDir(manifest: RunManifest, traceDir: string, errors: string[]): void {
  const manifestDir = canonicalDirectory(manifest.traceDir)
  if (manifestDir !== traceDir) {
    errors.push(`Run manifest traceDir mismatch: expected ${traceDir}, got ${manifestDir}`)
  }
}

function compareIdentity(label: string, expected: unknown, actual: unknown, errors: string[]): void {
  if (expected !== actual) errors.push(`Runtime artifact ${label} mismatch: expected ${String(expected)}, got ${String(actual)}`)
}

function compareExpected(evalCase: RuntimeArtifactEvalCase, manifest: RunManifest, errors: string[]): void {
  if (evalCase.expected?.source !== undefined && evalCase.expected.source !== manifest.source) {
    errors.push(`Runtime source mismatch: expected ${evalCase.expected.source}, got ${manifest.source}`)
  }
  if (evalCase.expected?.scenario !== undefined && evalCase.expected.scenario !== manifest.scenario) {
    errors.push(`Runtime scenario mismatch: expected ${evalCase.expected.scenario}, got ${String(manifest.scenario)}`)
  }
}

function artifactNames(evalCase: RuntimeArtifactEvalCase): string[] {
  return unique(evalCase.criteria.flatMap((criterion) =>
    criterion.type === 'artifact_present' || criterion.type === 'artifact_value'
      ? [criterion.artifact]
      : []))
}

function loadRunManifest(path: string, traceDir: string, errors: string[]): RunManifest | undefined {
  const value = readJsonWithin(path, traceDir, 'run manifest', errors)
  if (value === undefined) return undefined
  if (!isRecord(value)) {
    errors.push('Run manifest must be a JSON object.')
    return undefined
  }
  if (value.schemaVersion !== 'run-manifest/v1') {
    errors.push(`Unsupported run manifest schema: ${String(value.schemaVersion)}`)
    return undefined
  }
  if (![value.runId, value.sessionId, value.source, value.traceDir, value.createdAt].every(isNonEmptyString) || !isRecord(value.files)) {
    errors.push('Run manifest is missing required fields.')
    return undefined
  }
  if (!RUNTIME_ARTIFACT_RUN_SOURCES.has(value.source as RunManifest['source'])) {
    errors.push(`Unsupported run manifest source: ${value.source}`)
    return undefined
  }
  return value as unknown as RunManifest
}

function loadRunMetrics(path: string, traceDir: string, errors: string[]): RunMetrics | undefined {
  const value = readJsonWithin(path, traceDir, 'metrics', errors)
  if (value === undefined) return undefined
  if (!isRecord(value)) {
    errors.push('Metrics must be a JSON object.')
    return undefined
  }
  if (value.schemaVersion !== 'run-metrics/v1') {
    errors.push(`Unsupported metrics schema: ${String(value.schemaVersion)}`)
    return undefined
  }
  const numericFieldsValid = [...RUNTIME_ARTIFACT_METRIC_FIELDS]
    .every((field) => typeof value[field] === 'number' && Number.isFinite(value[field]))
  if (!isNonEmptyString(value.generatedAt) || !isNonEmptyString(value.source) ||
      !['completed', 'blocked', 'incomplete', 'failed', 'unknown'].includes(String(value.status)) ||
      !isNonEmptyString(value.failureCategory) || !numericFieldsValid ||
      !isRecord(value.policy) || !isRecord(value.permission) || !Array.isArray(value.warnings)) {
    errors.push('Metrics is missing required fields or contains invalid field values.')
    return undefined
  }
  if (!RUNTIME_ARTIFACT_RUN_SOURCES.has(value.source as RunMetrics['source'])) {
    errors.push(`Unsupported metrics source: ${value.source}`)
    return undefined
  }
  return value as unknown as RunMetrics
}

function loadSafetyReport(path: string, traceDir: string, errors: string[]): SafetyReport | undefined {
  const value = readJsonWithin(path, traceDir, 'safety report', errors)
  if (value === undefined) return undefined
  if (!isRecord(value)) {
    errors.push('Safety report must be a JSON object.')
    return undefined
  }
  if (value.schemaVersion !== 'safety-report/v1') {
    errors.push(`Unsupported safety report schema: ${String(value.schemaVersion)}`)
    return undefined
  }
  const flagsValid = [...RUNTIME_ARTIFACT_SAFETY_FLAG_FIELDS]
    .every((field) => typeof value[field] === 'boolean')
  const metricsValid = [...RUNTIME_ARTIFACT_SAFETY_METRIC_FIELDS]
    .every((field) => typeof value[field] === 'number' && Number.isFinite(value[field]))
  if (!isNonEmptyString(value.runId) ||
      !['completed', 'blocked', 'incomplete', 'failed', 'unknown'].includes(String(value.finalStatus)) ||
      !flagsValid || !metricsValid || !Array.isArray(value.policyCodes) || !isNonEmptyString(value.summary)) {
    errors.push('Safety report is missing required fields or contains invalid field values.')
    return undefined
  }
  return value as unknown as SafetyReport
}

function readJson(path: string, label: string, errors: string[]): unknown {
  if (!existsSync(path)) {
    errors.push(`${path} not found (${label})`)
    return undefined
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown
  } catch (error) {
    errors.push(`${path} contains invalid JSON (${label}: ${error instanceof Error ? error.message : String(error)})`)
    return undefined
  }
}

function readJsonWithin(path: string, directory: string, label: string, errors: string[]): unknown {
  if (!isPathWithinDirectory(path, directory)) {
    errors.push(`${label} resolves outside allowed directory.`)
    return undefined
  }
  return readJson(path, label, errors)
}

function isPathWithinDirectory(path: string, directory: string): boolean {
  if (!existsSync(path)) return true
  try {
    const target = realpathSync(path)
    const root = realpathSync(directory)
    const rel = relative(root, target)
    return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
  } catch {
    return false
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && Boolean(value.trim())
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isSafeArtifactName(name: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]*\.json$/.test(name) && !name.includes('..')
}

function unique(values: string[]): string[] {
  return [...new Set(values)]
}
