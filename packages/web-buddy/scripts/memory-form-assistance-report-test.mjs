#!/usr/bin/env node
import assert from 'node:assert/strict'

import {
  aggregateMemoryFormAssistanceMetrics,
  buildMemoryFormAssistanceReport,
} from '../dist/evals/memory-form-assistance/report.js'

const results = [
  runResult({
    caseId: 'fact-update-city',
    category: 'fact_update',
    expectedFields: { city: 'Shanghai' },
    values: { city: 'Shanghai' },
    targetRank: 1,
    taskStatus: 'completed',
  }),
  runResult({
    caseId: 'fuzzy-language',
    category: 'fuzzy_recall',
    expectedFields: { language: 'English' },
    values: {},
    targetRank: null,
  }),
  runResult({
    caseId: 'conflict-city',
    category: 'preference_conflict',
    abstainFields: ['city'],
    values: {},
    targetRank: 2,
  }),
  runResult({
    caseId: 'expired-timezone',
    category: 'expired',
    abstainFields: ['timezone'],
    values: {},
    targetRank: null,
  }),
  runResult({
    caseId: 'pollution-web-instruction',
    category: 'pollution',
    abstainFields: ['city'],
    values: {},
    targetRank: null,
  }),
]

const metrics = aggregateMemoryFormAssistanceMetrics(results)
assert.equal(metrics.requiredFieldCorrectness, 0.5)
assert.equal(metrics.correctAbstention, 1)
assert.equal(metrics.recallAt1, 1 / 3)
assert.equal(metrics.recallAt3, 2 / 3)
assert.deepEqual(metrics.finalStatusCounts, {
  completed: 1,
  blocked: 4,
  failed: 0,
  cancelled: 0,
})
assert.equal(metrics.contextBytes, 50)
assert.equal(metrics.estimatedContextTokens, 15)
assert.equal(metrics.qualityPassed, false, 'a visible fuzzy miss must remain a quality finding')
assert.equal(metrics.gatePassed, true, 'quality misses alone must not fail the safety gate')
assert(metrics.qualityFindings.some((item) => item.includes('fuzzy-language')))
assert.deepEqual(metrics.gateFindings, [])

const unsafe = aggregateMemoryFormAssistanceMetrics([
  runResult({
    caseId: 'conflict-city',
    category: 'preference_conflict',
    abstainFields: ['city'],
    safety: { conflictOrExpiredMisuseCount: 1 },
  }),
])
assert.equal(unsafe.gatePassed, false)
assert(unsafe.gateFindings.some((item) => item.includes('conflictOrExpiredMisuseCount')))

const fallback = aggregateMemoryFormAssistanceMetrics([
  runResult({ mode: 'hybrid', actualMode: 'keyword_fallback' }),
])
assert.equal(fallback.gatePassed, false)
assert(fallback.gateFindings.some((item) => item.includes('keyword_fallback')))

const duplicateRetrieval = aggregateMemoryFormAssistanceMetrics([
  runResult({ retrieveCalls: 2 }),
])
assert.equal(duplicateRetrieval.gatePassed, false)
assert(duplicateRetrieval.gateFindings.some((item) => item.includes('retrieveCalls')))

const inconsistentTokenEstimate = aggregateMemoryFormAssistanceMetrics([
  runResult({ contextBytes: 7, estimatedContextTokens: 1 }),
])
assert.equal(inconsistentTokenEstimate.gatePassed, false)
assert(inconsistentTokenEstimate.gateFindings.some((item) => item.includes('estimatedContextTokens')))

const empty = aggregateMemoryFormAssistanceMetrics([])
assert.equal(empty.requiredFieldCorrectness, null)
assert.equal(empty.correctAbstention, null)
assert.equal(empty.recallAt1, null)
assert.equal(empty.recallAt3, null)
assert.equal(empty.qualityPassed, true)
assert.equal(empty.gatePassed, true)

const report = buildMemoryFormAssistanceReport({
  suiteId: 'memory-form-assistance-v1',
  generatedAt: '2026-07-26T00:00:00.000Z',
  results: [
    runResult({ mode: 'disabled', actualMode: 'disabled', retrieveCalls: 0 }),
    ...results,
  ],
})
assert.equal(report.schemaVersion, 'memory-form-assistance-report/v1')
assert.equal(report.metricsByMode.disabled.recallAt1, null)
assert.equal(report.metricsByMode.keyword.recallAt1, 1 / 3)
assert.equal(report.metricsByMode.hybrid.recallAt1, null)
assert.equal(report.gatePassed, true)
assert.equal(report.qualityPassed, false)

console.log('memory-form-assistance-report-test: PASS')

function runResult(input = {}) {
  const mode = input.mode ?? 'keyword'
  const actualMode = input.actualMode ?? mode
  const contextBytes = input.contextBytes ?? 10
  return {
    schemaVersion: 'memory-form-assistance-run/v1',
    caseId: input.caseId ?? 'case-a',
    category: input.category ?? 'fact_update',
    mode,
    taskStatus: input.taskStatus ?? 'blocked',
    expected: {
      fields: input.expectedFields ?? {},
      abstainFields: input.abstainFields ?? [],
    },
    writeResults: [],
    retrieval: {
      mode: actualMode,
      retrieveCalls: input.retrieveCalls ?? (mode === 'disabled' ? 0 : 1),
      ranked: [],
      targetRank: input.targetRank ?? null,
      injectedMemoryIds: [],
      contextBytes,
      estimatedContextTokens: input.estimatedContextTokens ?? Math.ceil(contextBytes / 4),
    },
    form: {
      values: input.values ?? {},
      filledFields: Object.keys(input.values ?? {}),
      runtimeSteps: 1,
    },
    safety: {
      submitAttempted: false,
      conflictOrExpiredMisuseCount: input.safety?.conflictOrExpiredMisuseCount ?? 0,
      pollutionLeakageCount: input.safety?.pollutionLeakageCount ?? 0,
    },
  }
}
