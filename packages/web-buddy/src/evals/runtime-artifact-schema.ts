import type { RunSource } from '../metrics/trace-inputs.js'
import type { RunMetricsStatus } from '../metrics/schema.js'

export type RuntimeArtifactThresholdOperator = 'eq' | 'gte' | 'lte'

export type RuntimeArtifactMetricField =
  | 'durationMs'
  | 'llmCalls'
  | 'toolCalls'
  | 'mcpToolCalls'
  | 'observationToolCalls'
  | 'actionToolCalls'
  | 'humanToolCalls'
  | 'evalToolCalls'
  | 'browserSnapshots'
  | 'browserClicks'
  | 'browserTypes'
  | 'browserWaits'
  | 'screenshots'
  | 'manualHandoffs'
  | 'skillCalls'
  | 'skillHits'
  | 'memoryEvents'
  | 'memoryUpdates'
  | 'memoryRetrievals'
  | 'toolResults'
  | 'toolResultArtifacts'
  | 'toolResultArtifactBytes'
  | 'contextCompactions'
  | 'contextBuilds'
  | 'contextChars'
  | 'contextTruncations'
  | 'recentActionsIncluded'
  | 'pageStateAgeMs'
  | 'formStateAgeMs'
  | 'spans'
  | 'events'
  | 'legacySteps'
  | 'stdoutBytes'
  | 'stderrBytes'
  | 'streamJsonBytes'
  | 'runLogBytes'
  | 'promptBytes'

export type RuntimeArtifactSafetyFlagField =
  | 'finalSubmitAttempted'
  | 'finalSubmitBlocked'
  | 'loginHandoffRequired'
  | 'captchaHandoffRequired'

export type RuntimeArtifactSafetyMetricField =
  | 'highRiskActionCount'
  | 'gateCount'
  | 'riskDecisionCount'
  | 'autoAllowedCount'
  | 'gatedCount'
  | 'deniedCount'

interface RuntimeArtifactCriterionBase {
  id: string
  description?: string
}

export interface RuntimeArtifactRunStatusCriterion extends RuntimeArtifactCriterionBase {
  type: 'run_status'
  expected: RunMetricsStatus
}

export interface RuntimeArtifactMetricThresholdCriterion extends RuntimeArtifactCriterionBase {
  type: 'metric_threshold'
  field: RuntimeArtifactMetricField
  operator: RuntimeArtifactThresholdOperator
  value: number
}

export interface RuntimeArtifactSafetyFlagCriterion extends RuntimeArtifactCriterionBase {
  type: 'safety_flag'
  field: RuntimeArtifactSafetyFlagField
  expected: boolean
}

export interface RuntimeArtifactSafetyThresholdCriterion extends RuntimeArtifactCriterionBase {
  type: 'safety_threshold'
  field: RuntimeArtifactSafetyMetricField
  operator: RuntimeArtifactThresholdOperator
  value: number
}

export interface RuntimeArtifactPresentCriterion extends RuntimeArtifactCriterionBase {
  type: 'artifact_present'
  artifact: string
  schemaVersion?: string
}

export interface RuntimeArtifactValueCriterion extends RuntimeArtifactCriterionBase {
  type: 'artifact_value'
  artifact: string
  path: string[]
  operator: 'equals' | 'length_equals' | 'contains'
  value: unknown
}

export type RuntimeArtifactCriterion =
  | RuntimeArtifactRunStatusCriterion
  | RuntimeArtifactMetricThresholdCriterion
  | RuntimeArtifactSafetyFlagCriterion
  | RuntimeArtifactSafetyThresholdCriterion
  | RuntimeArtifactPresentCriterion
  | RuntimeArtifactValueCriterion

export interface RuntimeArtifactEvalCase {
  schemaVersion: 'runtime-artifact-eval-case/v1'
  id: string
  description: string
  expected?: {
    source?: RunSource
    scenario?: string
  }
  criteria: RuntimeArtifactCriterion[]
}

export interface RuntimeArtifactEvalCheck {
  criterionId: string
  criterionType: RuntimeArtifactCriterion['type']
  passed: boolean
  expected?: unknown
  actual?: unknown
  evidencePath?: string
  message: string
}

export interface RuntimeArtifactEvalResult {
  schemaVersion: 'runtime-artifact-eval-result/v1'
  caseId: string
  generatedAt: string
  traceDir: string
  runId?: string
  sessionId?: string
  source?: RunSource
  scenario?: string
  passed: boolean
  checks: RuntimeArtifactEvalCheck[]
  loadErrors: string[]
}

export const RUNTIME_ARTIFACT_RUN_SOURCES = new Set<RunSource>([
  'sdk',
  'local-runtime',
  'cli-demo',
  'web-ui',
  'benchmark',
  'claude-runtime',
  'claude-adapter',
  'mcp-server',
  'unknown',
])

const RUN_STATUSES = new Set<RunMetricsStatus>([
  'completed',
  'blocked',
  'incomplete',
  'failed',
  'unknown',
])

export const RUNTIME_ARTIFACT_METRIC_FIELDS = new Set<RuntimeArtifactMetricField>([
  'durationMs',
  'llmCalls',
  'toolCalls',
  'mcpToolCalls',
  'observationToolCalls',
  'actionToolCalls',
  'humanToolCalls',
  'evalToolCalls',
  'browserSnapshots',
  'browserClicks',
  'browserTypes',
  'browserWaits',
  'screenshots',
  'manualHandoffs',
  'skillCalls',
  'skillHits',
  'memoryEvents',
  'memoryUpdates',
  'memoryRetrievals',
  'toolResults',
  'toolResultArtifacts',
  'toolResultArtifactBytes',
  'contextCompactions',
  'contextBuilds',
  'contextChars',
  'contextTruncations',
  'recentActionsIncluded',
  'pageStateAgeMs',
  'formStateAgeMs',
  'spans',
  'events',
  'legacySteps',
  'stdoutBytes',
  'stderrBytes',
  'streamJsonBytes',
  'runLogBytes',
  'promptBytes',
])

export const RUNTIME_ARTIFACT_SAFETY_FLAG_FIELDS = new Set<RuntimeArtifactSafetyFlagField>([
  'finalSubmitAttempted',
  'finalSubmitBlocked',
  'loginHandoffRequired',
  'captchaHandoffRequired',
])

export const RUNTIME_ARTIFACT_SAFETY_METRIC_FIELDS = new Set<RuntimeArtifactSafetyMetricField>([
  'highRiskActionCount',
  'gateCount',
  'riskDecisionCount',
  'autoAllowedCount',
  'gatedCount',
  'deniedCount',
])

export function assertRuntimeArtifactEvalCase(value: unknown): asserts value is RuntimeArtifactEvalCase {
  if (!isRecord(value) || value.schemaVersion !== 'runtime-artifact-eval-case/v1') {
    throw new Error(`Unsupported runtime artifact eval case schema: ${String(isRecord(value) ? value.schemaVersion : value)}`)
  }
  if (typeof value.id !== 'string' || !value.id.trim()) throw new Error('Runtime artifact eval case id is required.')
  if (typeof value.description !== 'string' || !value.description.trim()) {
    throw new Error('Runtime artifact eval case description is required.')
  }
  if (value.expected !== undefined) validateExpected(value.expected)
  if (!Array.isArray(value.criteria) || value.criteria.length === 0) {
    throw new Error('Runtime artifact eval case requires at least one criterion.')
  }
  const ids = new Set<string>()
  for (const criterion of value.criteria) {
    validateCriterion(criterion)
    if (ids.has(criterion.id)) throw new Error(`Duplicate runtime artifact criterion id: ${criterion.id}`)
    ids.add(criterion.id)
  }
}

function validateExpected(value: unknown): void {
  if (!isRecord(value)) throw new Error('Runtime artifact eval expected must be an object.')
  if (value.source !== undefined && (typeof value.source !== 'string' || !RUNTIME_ARTIFACT_RUN_SOURCES.has(value.source as RunSource))) {
    throw new Error(`Unsupported runtime source: ${String(value.source)}`)
  }
  if (value.scenario !== undefined && (typeof value.scenario !== 'string' || !value.scenario.trim())) {
    throw new Error('Runtime artifact expected scenario must be a non-empty string.')
  }
}

function validateCriterion(value: unknown): asserts value is RuntimeArtifactCriterion {
  if (!isRecord(value)) throw new Error('Runtime artifact criterion must be an object.')
  if (typeof value.id !== 'string' || !value.id.trim()) throw new Error('Runtime artifact criterion id is required.')
  if (value.description !== undefined && typeof value.description !== 'string') {
    throw new Error(`Runtime artifact criterion ${value.id} description must be a string.`)
  }
  switch (value.type) {
    case 'run_status':
      if (typeof value.expected !== 'string' || !RUN_STATUSES.has(value.expected as RunMetricsStatus)) {
        throw new Error(`Runtime artifact criterion ${value.id} has an unsupported run status.`)
      }
      return
    case 'metric_threshold':
      validateThreshold(value, RUNTIME_ARTIFACT_METRIC_FIELDS)
      return
    case 'safety_flag':
      if (typeof value.field !== 'string' || !RUNTIME_ARTIFACT_SAFETY_FLAG_FIELDS.has(value.field as RuntimeArtifactSafetyFlagField)) {
        throw new Error(`Runtime artifact criterion ${value.id} has an unsupported safety flag.`)
      }
      if (typeof value.expected !== 'boolean') throw new Error(`Runtime artifact criterion ${value.id} expected must be boolean.`)
      return
    case 'safety_threshold':
      validateThreshold(value, RUNTIME_ARTIFACT_SAFETY_METRIC_FIELDS)
      return
    case 'artifact_present':
      validateArtifactName(value.id, value.artifact)
      if (value.schemaVersion !== undefined && typeof value.schemaVersion !== 'string') {
        throw new Error(`Runtime artifact criterion ${value.id} schemaVersion must be a string.`)
      }
      return
    case 'artifact_value':
      validateArtifactName(value.id, value.artifact)
      if (!Array.isArray(value.path) || value.path.length === 0 || !value.path.every(isSafePathSegment)) {
        throw new Error(`Runtime artifact criterion ${value.id} has an unsafe or empty value path.`)
      }
      if (!['equals', 'length_equals', 'contains'].includes(String(value.operator))) {
        throw new Error(`Runtime artifact criterion ${value.id} has an unsupported artifact operator.`)
      }
      if (value.value === undefined || !isJsonValue(value.value)) {
        throw new Error(`Runtime artifact criterion ${value.id} value must be valid JSON.`)
      }
      if (value.operator === 'length_equals' && (!Number.isInteger(value.value) || Number(value.value) < 0)) {
        throw new Error(`Runtime artifact criterion ${value.id} length_equals value must be a non-negative integer.`)
      }
      return
    default:
      throw new Error(`Unsupported runtime artifact criterion type: ${String(value.type)}`)
  }
}

function validateThreshold(value: Record<string, unknown>, fields: ReadonlySet<string>): void {
  if (typeof value.field !== 'string' || !fields.has(value.field)) {
    throw new Error(`Runtime artifact criterion ${String(value.id)} has an unsupported numeric field.`)
  }
  if (!['eq', 'gte', 'lte'].includes(String(value.operator))) {
    throw new Error(`Runtime artifact criterion ${String(value.id)} has an unsupported threshold operator.`)
  }
  if (typeof value.value !== 'number' || !Number.isFinite(value.value)) {
    throw new Error(`Runtime artifact criterion ${String(value.id)} threshold must be finite.`)
  }
}

function validateArtifactName(id: unknown, artifact: unknown): void {
  if (typeof artifact !== 'string' || !artifact.trim()) {
    throw new Error(`Runtime artifact criterion ${String(id)} requires an artifact path.`)
  }
}

function isSafePathSegment(value: unknown): boolean {
  return typeof value === 'string' && Boolean(value) && !['__proto__', 'prototype', 'constructor'].includes(value)
}

function isJsonValue(value: unknown): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(isJsonValue)
  if (!isRecord(value)) return false
  return Object.entries(value).every(([key, item]) =>
    !['__proto__', 'prototype', 'constructor'].includes(key) && isJsonValue(item))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
