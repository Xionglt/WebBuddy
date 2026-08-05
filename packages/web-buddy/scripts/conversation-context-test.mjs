#!/usr/bin/env node
import assert from 'node:assert/strict'
import {
  ConversationStoreError,
  assembleConversationContext,
} from '../dist/conversation/index.js'
import { validateContextItem } from '../dist/task/contracts.js'

const capturedAt = '2026-07-28T11:00:00.000Z'
const turns = Array.from({ length: 14 }, (_, index) => ({
  schemaVersion: 'conversation-turn-record/v1',
  turnId: `turn-${index + 1}`,
  sequence: index + 1,
  userMessage: `User message ${index + 1}`,
  runId: `run-${index + 1}`,
  idempotencyKey: `turn-key-${index + 1}`,
  requestDigest: String(index % 10).repeat(64),
  createdAt: `2026-07-28T10:${String(index).padStart(2, '0')}:00.000Z`,
}))
const conversation = {
  schemaVersion: 'conversation-record/v1',
  conversationId: 'conversation-context-main',
  goal: 'Complete the same durable goal.',
  startUrl: 'https://example.test/workspace',
  headless: true,
  recordRevision: turns.length,
  turns,
  createIdempotencyKey: 'conversation-context-create',
  createRequestDigest: 'a'.repeat(64),
  createdAt: '2026-07-28T09:00:00.000Z',
  updatedAt: turns.at(-1).createdAt,
}
const priorRuns = turns.map((turn) => ({
  runId: turn.runId,
  state: 'completed',
  reason: `Agent summary ${turn.sequence}`,
  artifactRefs: Array.from({ length: 3 }, (_, artifactIndex) => ({
    id: `artifact-${turn.sequence}-${artifactIndex + 1}`,
    kind: 'research_report',
    payloadSchemaVersion: 'research-report/v1',
    createdAt: turn.createdAt,
    locator: `/private/must-not-leak/${turn.sequence}/${artifactIndex + 1}`,
  })),
  resourceRefs: [{ id: `trace-${turn.sequence}`, locator: `/trace/${turn.sequence}` }],
}))

const items = assembleConversationContext({ conversation, priorRuns, capturedAt })
assert.equal(items.length, 2)
for (const item of items) validateContextItem(item)

const userHistory = items[0]
assert.equal(userHistory.kind, 'conversation_user_history')
assert.equal(userHistory.origin, 'user')
assert.equal(userHistory.trust, 'user_authorized')
assert.equal(userHistory.instructionAuthority, 'user_goal')
assert.equal(userHistory.sensitivity, 'personal')
assert.deepEqual(userHistory.allowedUses, ['prompt', 'trace'])
assert.equal(userHistory.content.length, 12)
assert.deepEqual(userHistory.content[0], { sequence: 3, message: 'User message 3' })
assert.deepEqual(userHistory.content.at(-1), { sequence: 14, message: 'User message 14' })

const runHistory = items[1]
assert.equal(runHistory.kind, 'conversation_run_history')
assert.equal(runHistory.origin, 'derived')
assert.equal(runHistory.trust, 'non_authoritative')
assert.equal(runHistory.instructionAuthority, 'data_only')
assert.equal(runHistory.sensitivity, 'internal')
assert.equal(runHistory.content.length, 12)
assert.equal(runHistory.content[0].summary, 'Agent summary 3')
assert.equal(runHistory.content.at(-1).runId, 'run-14')
assert.equal(
  runHistory.content.flatMap((entry) => entry.artifacts).length,
  24,
  'Conversation context must cap Artifact descriptors across inherited Turns',
)
assert.equal(JSON.stringify(runHistory.content).includes('locator'), false)
assert.equal(JSON.stringify(runHistory.content).includes('trace-'), false)

assert.throws(
  () => assembleConversationContext({
    conversation,
    priorRuns: priorRuns.filter((_, index) => index !== 5),
    capturedAt,
  }),
  (error) => error instanceof ConversationStoreError && error.code === 'INVALID_RECORD',
)
assert.throws(
  () => assembleConversationContext({
    conversation,
    priorRuns: priorRuns.map((run, index) => index === 5 ? { ...run, runId: 'wrong-run' } : run),
    capturedAt,
  }),
  (error) => error instanceof ConversationStoreError && error.code === 'INVALID_RECORD',
)

console.log('conversation context tests passed')
