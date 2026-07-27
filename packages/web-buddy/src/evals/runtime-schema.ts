import type { CompletionContractEvaluation } from '../task/completion-contract.js'
import type { WebTaskInputSnapshot, WebTaskResult } from '../task/contracts.js'
import type { EvalExpectedOutcome, EvalScenarioCategory } from './schema.js'

export type RuntimeEvalSignalSource =
  | 'runtime_trace'
  | 'harness_assertion'
  | 'external_grader'

/**
 * Security-sensitive observations are optional at the type boundary so an
 * incomplete trace can still be diagnosed. Missing hard-gate observations
 * never default to zero: the runtime grader reports them as unverified and
 * fails closed.
 */
export interface RuntimeEvalSignals {
  schemaVersion: 'runtime-eval-signals/v1'
  source: RuntimeEvalSignalSource
  observedAt: string
  actionCount?: number
  unsafeActions?: number
  humanInterventions?: number
  recoveryAttempts?: number
  recoverySuccesses?: number
  toolRetries?: number
  permissionElevations?: number
  secretLeaks?: number
  memoryPollutionWrites?: number
  tokenCount?: number
  estimatedCostUsd?: number
  notes?: string[]
}

export interface GradeRuntimeRunInput {
  scenarioId: string
  category: EvalScenarioCategory
  expectedOutcome: EvalExpectedOutcome
  input: WebTaskInputSnapshot
  result: WebTaskResult
  signals?: RuntimeEvalSignals
  now?: Date
}

export interface GradeRunBundleInput {
  dir: string
  scenarioId?: string
  category: EvalScenarioCategory
  expectedOutcome: EvalExpectedOutcome
  now?: Date
}

export type RuntimeHardGate =
  | 'unsafe_actions'
  | 'permission_elevations'
  | 'secret_leaks'
  | 'memory_pollution_writes'
  | 'recovery_observation'

export interface RuntimeEvalResult {
  schemaVersion: 'runtime-eval-result/v1'
  scenarioId: string
  category: EvalScenarioCategory
  runId: string
  expectedOutcome: EvalExpectedOutcome
  actualStatus: WebTaskResult['status']
  passed: boolean
  statusMatchesExpected: boolean
  completionContractSatisfied: boolean
  completionEvaluation: CompletionContractEvaluation
  taskSuccess: number
  actionCount: number
  unsafeActions: number | null
  prematureCompletions: number
  humanInterventions: number
  recoveryAttempts: number | null
  recoverySuccesses: number | null
  toolRetries: number | null
  permissionElevations: number | null
  secretLeaks: number | null
  memoryPollutionWrites: number | null
  durationMs: number
  llmCalls: number
  toolCalls: number
  tokenCount: number | null
  estimatedCostUsd: number | null
  signalSource?: RuntimeEvalSignalSource
  unverifiedHardGates: RuntimeHardGate[]
  blockers: string[]
  notes: string[]
}

export interface RuntimeEvalAggregateMetrics {
  schemaVersion: 'runtime-eval-metrics/v1'
  scenarioCount: number
  passedCount: number
  passRate: number
  taskSuccessRate: number
  totalActionCount: number
  unsafeActionCount: number | null
  unsafeActionRate: number | null
  prematureCompletionRate: number
  humanInterventionRate: number
  meanHumanInterventionsPerScenario: number
  recoveryRate: number | null
  toolRetryRate: number | null
  meanToolRetriesPerScenario: number | null
  permissionElevationCount: number | null
  secretLeakCount: number | null
  memoryPollutionWriteCount: number | null
  hardGateCoverageRate: number
  durationMs: number
  meanDurationMs: number
  llmCalls: number
  toolCalls: number
  tokenCount: number | null
  estimatedCostUsd: number | null
}
