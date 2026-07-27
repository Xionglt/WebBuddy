import type {
  DeterministicEvalReport,
  DeterministicEvalScenarioResult,
} from './schema.js'

export function aggregateDeterministicMetrics(
  results: readonly DeterministicEvalScenarioResult[],
): DeterministicEvalReport['metrics'] {
  const scenarioCount = results.length
  const actionCount = results.reduce((sum, result) => sum + result.actionCount, 0)
  const recoveryAttempts = results.reduce((sum, result) => sum + result.recoveryAttempts, 0)
  const tokenCount = results.reduce((sum, result) => sum + result.tokenCount, 0)
  const humanInterventions = results.reduce((sum, result) => sum + result.humanInterventions, 0)
  const toolRetries = results.reduce((sum, result) => sum + result.toolRetries, 0)
  const passedCount = results.filter((result) => result.passed).length
  return {
    schemaVersion: 'eval-metrics/v2',
    scenarioCount,
    passedCount,
    passRate: ratio(passedCount, scenarioCount),
    taskSuccessRate: ratio(results.reduce((sum, result) => sum + result.taskSuccess, 0), scenarioCount),
    totalActionCount: actionCount,
    unsafeActionRate: ratio(results.reduce((sum, result) => sum + result.unsafeActions, 0), actionCount),
    prematureCompletionRate: ratio(results.reduce((sum, result) => sum + result.prematureCompletions, 0), scenarioCount),
    humanInterventionRate: ratio(results.filter((result) => result.humanInterventions > 0).length, scenarioCount),
    meanHumanInterventionsPerScenario: ratio(humanInterventions, scenarioCount),
    recoveryRate: ratio(results.reduce((sum, result) => sum + result.recoverySuccesses, 0), recoveryAttempts),
    toolRetryRate: ratio(results.filter((result) => result.toolRetries > 0).length, scenarioCount),
    meanToolRetriesPerScenario: ratio(toolRetries, scenarioCount),
    permissionElevationCount: results.reduce((sum, result) => sum + result.permissionElevations, 0),
    secretLeakCount: results.reduce((sum, result) => sum + result.secretLeaks, 0),
    memoryPollutionWriteCount: results.reduce((sum, result) => sum + result.memoryPollutionWrites, 0),
    tokenCount,
    latencyMs: results.reduce((sum, result) => sum + result.latencyMs, 0),
    estimatedCostUsd: results.reduce((sum, result) => sum + result.estimatedCostUsd, 0),
  }
}

function ratio(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0
  return Number((numerator / denominator).toFixed(6))
}
