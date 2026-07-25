#!/usr/bin/env node
import assert from 'node:assert/strict'

import {
  retrieveLifecycleMemoryContext,
  retrieveLifecycleMemoryContextBatch,
} from '../dist/memory/context-provider.js'
import { validateContextItem } from '../dist/task/contracts.js'

let retrieveCalls = 0
const retrieval = {
  schemaVersion: 'memory-lifecycle-retrieval-result/v2',
  mode: 'keyword',
  records: [
    { record: memoryRecord('city', 'personal'), score: 1.1, reason: 'keyword' },
    { record: memoryRecord('secret', 'secret'), score: 0.7, reason: 'keyword' },
  ],
}
const service = {
  async retrieve(request) {
    retrieveCalls += 1
    assert.equal(request.query, 'city preference')
    assert.equal(request.maxResults, 3)
    assert.deepEqual(request.scope, { kind: 'user', tenantId: 'tenant-a', userId: 'user-a' })
    return retrieval
  },
}
const input = {
  service,
  ownerScope: { schemaVersion: 'owner-scope/v1', tenantId: 'tenant-a', userId: 'user-a' },
  query: 'city preference',
  runId: 'run-a',
  revision: 2,
  sessionId: 'session-a',
  maxResults: 3,
}

const batch = await retrieveLifecycleMemoryContextBatch(input)
assert.equal(retrieveCalls, 1)
assert.equal(batch.status, 'retrieved')
assert.equal(batch.retrieval, retrieval, 'batch must preserve the exact single retrieval result')
assert.deepEqual(batch.retrieval.records.map((item) => item.record.entryId), ['city', 'secret'])
assert.equal(batch.contextItems.length, 1, 'secret Memory must not enter Runtime Context')
assert.equal(batch.contextItems[0].memory.memoryId, 'city')
assert.equal(batch.contextItems[0].trust, 'untrusted_external')
assert.doesNotThrow(() => validateContextItem(batch.contextItems[0]))

retrieveCalls = 0
const legacyContext = await retrieveLifecycleMemoryContext(input)
assert.equal(retrieveCalls, 1)
assert.deepEqual(legacyContext, batch.contextItems)

retrieveCalls = 0
const missingScope = await retrieveLifecycleMemoryContextBatch({ ...input, ownerScope: undefined })
assert.deepEqual(missingScope, { status: 'skipped', reason: 'missing_scope', contextItems: [] })
assert.equal(retrieveCalls, 0)

const emptyQuery = await retrieveLifecycleMemoryContextBatch({ ...input, query: '   ' })
assert.deepEqual(emptyQuery, { status: 'skipped', reason: 'empty_query', contextItems: [] })
assert.equal(retrieveCalls, 0)

console.log('memory-context-batch-test: PASS')

function memoryRecord(entryId, sensitivity) {
  return {
    schemaVersion: 'memory-lifecycle-record/v2',
    entryId,
    contentVersionId: `${entryId}:v1`,
    revision: 1,
    state: 'active',
    content: { kind: 'form_preference', fieldKey: 'city', value: 'Shanghai', statement: 'city preference' },
    contentHash: 'b'.repeat(64),
    scope: { kind: 'user', tenantId: 'tenant-a', userId: 'user-a' },
    trust: 'user_authorized',
    sensitivity,
    provenance: {
      contentId: `${entryId}:v1`,
      capturedAt: '2026-07-26T00:00:00.000Z',
      parentContentIds: [],
      runId: 'memory-run',
    },
    derivedFrom: [],
    transformChain: [],
    confidence: 1,
    createdAt: '2026-07-26T00:00:00.000Z',
    updatedAt: '2026-07-26T00:00:00.000Z',
    supersedes: [],
    conflicts: [],
  }
}
