import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { RuntimeArtifactEvalResult } from './runtime-artifact-schema.js'

export function renderRuntimeArtifactEvalMarkdown(result: RuntimeArtifactEvalResult): string {
  const checks = result.checks.map((check) => [
    `| ${cell(check.criterionId)} | ${cell(check.criterionType)} | ${check.passed ? 'PASS' : 'FAIL'} | ${cell(check.message)} | ${cell(check.evidencePath ?? '')} |`,
  ].join(''))
  const loadErrors = result.loadErrors.length
    ? ['## Load Errors', '', ...result.loadErrors.map((error) => `- ${error}`), '']
    : []
  return [
    '# Runtime Artifact Eval',
    '',
    `- Case: \`${result.caseId}\``,
    `- Result: **${result.passed ? 'PASS' : 'FAIL'}**`,
    `- Run: \`${result.runId ?? 'unknown'}\``,
    `- Session: \`${result.sessionId ?? 'unknown'}\``,
    `- Source: \`${result.source ?? 'unknown'}\``,
    `- Scenario: \`${result.scenario ?? 'unknown'}\``,
    `- Trace: \`${result.traceDir}\``,
    '',
    ...loadErrors,
    '## Checks',
    '',
    '| Criterion | Type | Result | Message | Evidence |',
    '| --- | --- | --- | --- | --- |',
    ...checks,
    '',
  ].join('\n')
}

export async function writeRuntimeArtifactEvalReport(input: {
  result: RuntimeArtifactEvalResult
  outDir: string
}): Promise<{ jsonPath: string; markdownPath: string }> {
  const outDir = resolve(input.outDir)
  const jsonPath = join(outDir, 'runtime-artifact-eval.json')
  const markdownPath = join(outDir, 'runtime-artifact-eval.md')
  await mkdir(outDir, { recursive: true })
  await Promise.all([
    writeFile(jsonPath, `${JSON.stringify(input.result, null, 2)}\n`, 'utf8'),
    writeFile(markdownPath, renderRuntimeArtifactEvalMarkdown(input.result), 'utf8'),
  ])
  return { jsonPath, markdownPath }
}

function cell(value: string): string {
  return value.replaceAll('|', '\\|').replaceAll('\n', '<br>')
}
