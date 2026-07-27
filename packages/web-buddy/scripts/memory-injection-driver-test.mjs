#!/usr/bin/env node
import assert from 'node:assert/strict'

import { createMemoryInjectionDriver } from '../dist/evals/memory-form-assistance/memory-injection-driver.js'
import { emptyRunMetrics } from '../dist/metrics/schema.js'

let providerCalls = 0
let downstreamItems
const retrieval = {
  schemaVersion: 'memory-lifecycle-retrieval-result/v2',
  mode: 'keyword',
  records: [],
}
const context = memoryContext('one')
const runtime = createMemoryInjectionDriver({
  downstream: {
    async execute(request) {
      downstreamItems = request.contextItems
      return outcome('completed')
    },
  },
  async batchProvider() {
    providerCalls += 1
    return { status: 'retrieved', retrieval, contextItems: [context] }
  },
})
const result = await runtime.driver.execute(request([]))
assert.equal(result.status, 'completed')
assert.equal(providerCalls, 1)
assert.deepEqual(downstreamItems, [context])
assert.equal(runtime.batch().retrieval, retrieval)
assert.deepEqual(runtime.batch().contextItems, [context])

const skipped = createMemoryInjectionDriver({
  downstream: { async execute(request) { downstreamItems = request.contextItems; return outcome('blocked') } },
  async batchProvider() { return { status: 'skipped', reason: 'empty_query', contextItems: [] } },
})
await skipped.driver.execute(request([userContext('existing')]))
assert.deepEqual(downstreamItems.map((item) => item.id), ['existing'])
assert.equal(skipped.batch().status, 'skipped')

const duplicate = createMemoryInjectionDriver({
  downstream: { async execute() { throw new Error('must not run') } },
  async batchProvider() {
    return { status: 'retrieved', retrieval, contextItems: [memoryContext('duplicate')] }
  },
})
await assert.rejects(
  () => duplicate.driver.execute(request([userContext('lifecycle-memory.duplicate.r1')])),
  /duplicate ContextItem ids/i,
)

console.log('memory-injection-driver-test: PASS')

function request(contextItems) {
  return {
    schemaVersion: 'web-task-runtime-request/v1',
    input: {
      schemaVersion: 'web-task-input-snapshot/v1',
      inputSchemaVersion: 'web-task-input/v1',
      runId: 'run-a',
      revision: 0,
      sha256: 'a'.repeat(64),
      goal: { instruction: 'city preference', scenario: 'form_draft' },
      contract: { schemaVersion: 'web-task-contract/v1', contractId: 'contract-a', revision: 0, criteria: [] },
      contextItems: [],
      contextProviders: [],
    },
    contextItems,
    runtime: {},
    emit() {},
  }
}

function memoryContext(id) {
  return {
    schemaVersion: 'context-item/v1',
    id: `lifecycle-memory.${id}.r1`,
    kind: 'lifecycle_memory',
    content: { kind: 'form_preference', fieldKey: 'city', value: 'Shanghai', statement: 'city preference' },
    origin: 'memory',
    trust: 'untrusted_external',
    instructionAuthority: 'data_only',
    sensitivity: 'personal',
    provenance: { capturedAt: '2026-07-26T00:00:00.000Z', parentContentIds: [], runId: 'run-a', sessionId: 'session-a', sha256: 'b'.repeat(64) },
    allowedUses: ['prompt'],
    freshness: { validity: 'current', revision: 0 },
    retention: { scope: 'session', deleteWithSession: true },
    sanitization: { policyId: 'memory-lifecycle-context/v1', status: 'unchanged', redactedFields: [], instructionNeutralized: true, transformedFrom: [`${id}:v1`] },
    integrity: { immutable: true, digestVerified: true },
    memory: { schemaVersion: 'memory-binding/v1', memoryId: id, revision: 1, scope: 'user', status: 'active', supersedesIds: [], conflictIds: [] },
  }
}

function userContext(id) {
  return {
    ...memoryContext('user-template'),
    id,
    origin: 'user',
    trust: 'user_authorized',
    instructionAuthority: 'advisory',
    memory: undefined,
  }
}

function outcome(status) {
  return {
    status,
    summary: status,
    evidence: [],
    artifacts: [],
    metrics: emptyRunMetrics({ source: 'benchmark' }),
  }
}
