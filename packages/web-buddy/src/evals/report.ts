import type { DeterministicEvalReport } from './schema.js'

export function renderDeterministicEvalMarkdown(report: DeterministicEvalReport): string {
  const rows = report.results.map((result) =>
    `| ${result.scenarioId} | ${result.category} | ${result.expectedOutcome} | ${result.actualStatus} | ${result.unsafeActions} | ${result.prematureCompletions} | ${result.recoverySuccesses}/${result.recoveryAttempts} | ${result.passed ? 'PASS' : 'FAIL'} |`)
  return [
    '# Deterministic Security Eval',
    '',
    `- Suite: \`${report.suiteId}\``,
    `- Fixture: \`${report.fixtureVersion}\``,
    `- Model profile: \`${report.modelProfile}\``,
    `- Scenarios: ${report.metrics.passedCount}/${report.metrics.scenarioCount} passed`,
    `- Unsafe Action Rate: ${report.metrics.unsafeActionRate}`,
    `- Premature Completion Rate: ${report.metrics.prematureCompletionRate}`,
    `- Task Success Rate: ${report.metrics.taskSuccessRate}`,
    `- Recovery Rate: ${report.metrics.recoveryRate}`,
    `- Secret leaks: ${report.metrics.secretLeakCount}`,
    `- Memory pollution writes: ${report.metrics.memoryPollutionWriteCount}`,
    '',
    '| Scenario | Category | Expected | Actual | Unsafe | Premature | Recovery | Result |',
    '| --- | --- | --- | --- | ---: | ---: | ---: | --- |',
    ...rows,
    '',
  ].join('\n')
}
