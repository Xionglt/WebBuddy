export type EvalScenarioCategory =
  | 'research'
  | 'comparison'
  | 'form'
  | 'navigation'
  | 'recovery'
  | 'security'
  | 'completion'

export type EvalExpectedOutcome = 'completed' | 'blocked' | 'recovered'

export interface EvalTraceEvent {
  type: 'action' | 'evidence' | 'artifact' | 'human' | 'recovery' | 'memory_write' | 'output' | 'tool_retry'
  id: string
  outcome?: 'performed' | 'blocked' | 'failed' | 'succeeded'
  unsafe?: boolean
  origin?: string
  authorityBefore?: number
  authorityAfter?: number
  content?: string
  evidenceId?: string
  artifactId?: string
}

export interface DeterministicEvalScenario {
  schemaVersion: 'deterministic-eval-scenario/v1'
  id: string
  category: EvalScenarioCategory
  description: string
  modelProfile: 'deterministic-fixture'
  expectedOutcome: EvalExpectedOutcome
  attack?: {
    kind: 'direct_injection' | 'indirect_injection' | 'exfiltration' | 'memory_poisoning' | 'fake_completion'
    content: string
    secretMarkers?: string[]
  }
  trace: {
    events: EvalTraceEvent[]
    tokenCount: number
    latencyMs: number
    estimatedCostUsd: number
  }
  completion: {
    finalStatus: 'completed' | 'blocked' | 'failed'
    claimedCompleted: boolean
    requiredEvidenceIds: string[]
    observedEvidenceIds: string[]
    requiredArtifactIds?: string[]
    observedArtifactIds?: string[]
    blocker?: string
  }
}

export interface DeterministicEvalScenarioResult {
  schemaVersion: 'deterministic-eval-result/v1'
  scenarioId: string
  category: EvalScenarioCategory
  passed: boolean
  expectedOutcome: EvalExpectedOutcome
  actualStatus: DeterministicEvalScenario['completion']['finalStatus']
  taskSuccess: number
  unsafeActions: number
  prematureCompletions: number
  humanInterventions: number
  recoveryAttempts: number
  recoverySuccesses: number
  toolRetries: number
  permissionElevations: number
  secretLeaks: number
  memoryPollutionWrites: number
  injectionSignals: string[]
  tokenCount: number
  latencyMs: number
  estimatedCostUsd: number
  blockers: string[]
}

export interface DeterministicEvalReport {
  schemaVersion: 'deterministic-eval-report/v1'
  suiteId: string
  generatedAt: string
  modelProfile: 'deterministic-fixture'
  fixtureVersion: string
  results: DeterministicEvalScenarioResult[]
  metrics: {
    scenarioCount: number
    passedCount: number
    taskSuccessRate: number
    unsafeActionRate: number
    prematureCompletionRate: number
    humanInterventionRate: number
    recoveryRate: number
    toolRetryRate: number
    permissionElevationCount: number
    secretLeakCount: number
    memoryPollutionWriteCount: number
    tokenCount: number
    latencyMs: number
    estimatedCostUsd: number
  }
}
