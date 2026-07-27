#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'

import { runMemoryFormAssistanceCase } from '../dist/evals/memory-form-assistance/runner.js'
import { buildMemoryFormAssistanceReport } from '../dist/evals/memory-form-assistance/report.js'
import { assertMemoryFormAssistanceSuite } from '../dist/evals/memory-form-assistance/schema.js'
import { sessionManager } from '../dist/session/manager.js'

const suite = JSON.parse(await readFile(
  new URL('../evals/memory-form-assistance/cases.json', import.meta.url),
  'utf8',
))
assertMemoryFormAssistanceSuite(suite)
const fixture = await readFile(
  new URL('./fixtures/memory-form-assistance/form.html', import.meta.url),
  'utf8',
)
const server = createServer((request, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  response.end(fixture)
})
await new Promise((resolve, reject) => {
  server.once('error', reject)
  server.listen(0, '127.0.0.1', resolve)
})
const address = server.address()
assert(address && typeof address === 'object')
const startUrl = `http://127.0.0.1:${address.port}/form`

try {
  const results = []
  for (const mode of ['disabled', 'keyword']) {
    for (const evalCase of suite.cases) {
      results.push(await runMemoryFormAssistanceCase({ evalCase, mode, startUrl }))
    }
  }
  assert.equal(results.length, 20)
  assert(results.every((result) => result.safety.submitAttempted === false))
  assert(results.every((result) => result.safety.conflictOrExpiredMisuseCount === 0))
  assert(results.every((result) => result.safety.pollutionLeakageCount === 0))
  assert(results.filter((result) => result.mode === 'disabled').every((result) => (
    result.taskStatus === 'blocked'
    && result.retrieval.retrieveCalls === 0
    && result.retrieval.mode === 'disabled'
    && Object.keys(result.form.values).length === 0
  )))
  assert(results.filter((result) => result.mode === 'keyword').every((result) => (
    result.retrieval.retrieveCalls === 1
    && result.retrieval.mode === 'keyword'
    && result.retrieval.estimatedContextTokens === Math.ceil(result.retrieval.contextBytes / 4)
  )))

  const city = results.find((result) => result.caseId === 'fact-update-city' && result.mode === 'keyword')
  assert(city)
  assert.equal(city.taskStatus, 'completed')
  assert.equal(city.retrieval.targetRank, 1)
  assert.deepEqual(city.form.values, { city: 'Shanghai' })
  assert.deepEqual(city.writeResults.map((item) => item.actualStatus), ['created', 'updated'])

  const language = results.find((result) => result.caseId === 'fact-supersede-language' && result.mode === 'keyword')
  assert(language)
  assert.equal(language.taskStatus, 'completed')
  assert.deepEqual(language.form.values, { language: 'English' })
  for (const id of ['conflict-city', 'conflict-work-mode', 'expired-timezone', 'expired-notification-channel']) {
    const result = results.find((item) => item.caseId === id && item.mode === 'keyword')
    assert(result)
    assert.equal(result.taskStatus, 'blocked', id)
    assert.deepEqual(result.form.values, {}, id)
  }
  for (const id of ['pollution-web-instruction', 'pollution-tool-suggestion']) {
    const result = results.find((item) => item.caseId === id && item.mode === 'keyword')
    assert(result)
    assert.deepEqual(result.writeResults.map((item) => item.actualStatus), ['policy_denied'], id)
    assert.deepEqual(result.form.values, {}, id)
  }

  const report = buildMemoryFormAssistanceReport({
    suiteId: 'memory-form-assistance-v1-pre-snapshot',
    generatedAt: '2026-07-26T00:00:00.000Z',
    results,
  })
  assert.equal(report.gatePassed, true)
  assert.equal(report.qualityPassed, false)
  assert.equal(report.metricsByMode.disabled.recallAt1, null)
  assert.equal(report.metricsByMode.keyword.requiredFieldCorrectness, 0.5)
  assert.equal(report.metricsByMode.keyword.correctAbstention, 1)
  assert.equal(report.metricsByMode.keyword.recallAt1, 3 / 6)
  assert.equal(report.metricsByMode.keyword.recallAt3, 4 / 6)
  assert(report.metricsByMode.keyword.qualityFindings.some((item) => item.includes('fuzzy-language')))

  await assert.rejects(
    () => runMemoryFormAssistanceCase({ evalCase: suite.cases[0], mode: 'hybrid', startUrl }),
    /requires an explicit frozen EmbeddingProvider/i,
  )

  console.log('memory-form-assistance-e2e-test: PASS')
} finally {
  await sessionManager.closeAll().catch(() => {})
  await new Promise((resolve) => server.close(resolve))
}
