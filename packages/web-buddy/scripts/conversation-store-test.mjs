#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ConversationStoreError,
  FileConversationStore,
} from '../dist/conversation/index.js'
import { digestCanonicalJson } from '../dist/task/contracts.js'

const rootDir = await mkdtemp(join(tmpdir(), 'web-buddy-conversation-store-'))
const store = new FileConversationStore({ rootDir })
const ownerScope = {
  schemaVersion: 'owner-scope/v1',
  tenantId: 'conversation-tenant',
  userId: 'conversation-user',
}
const foreignScope = {
  schemaVersion: 'owner-scope/v1',
  tenantId: 'foreign-tenant',
  userId: 'foreign-user',
}
const createdAt = '2026-07-28T10:00:00.000Z'

try {
  const createInput = {
    conversationId: 'conversation-store-main',
    goal: 'Complete one durable web goal.',
    startUrl: 'https://example.test/jobs/42',
    headless: true,
    ownerScope,
    idempotencyKey: 'conversation-create-main',
    createdAt,
  }
  const created = await store.create(createInput)
  assert.equal(created.replayed, false)
  assert.equal(created.record.schemaVersion, 'conversation-record/v1')
  assert.equal(created.record.recordRevision, 0)
  assert.deepEqual(created.record.turns, [])

  const replayedCreate = await store.create({
    ...structuredClone(createInput),
    createdAt: '2026-07-28T10:01:00.000Z',
  })
  assert.equal(replayedCreate.replayed, true)
  assert.deepEqual(replayedCreate.record, created.record)
  await rejectsCode(
    () => store.create({ ...createInput, goal: 'Different goal under the same key.' }),
    'IDEMPOTENCY_CONFLICT',
  )

  assert.equal((await store.get(createInput.conversationId, ownerScope))?.conversationId, createInput.conversationId)
  assert.equal(await store.get(createInput.conversationId, foreignScope), undefined)
  assert.deepEqual((await store.list(ownerScope)).map((item) => item.conversationId), [createInput.conversationId])
  assert.deepEqual(await store.list(foreignScope), [])

  let provisionCalls = 0
  const appendInput = {
    conversationId: createInput.conversationId,
    turnId: 'turn-main-1',
    userMessage: 'Research the role requirements first.',
    expectedRecordRevision: 0,
    ownerScope,
    idempotencyKey: 'conversation-turn-main-1',
    createdAt: '2026-07-28T10:02:00.000Z',
  }
  const appended = await store.appendTurn(appendInput, async () => {
    provisionCalls += 1
    return 'run-main-1'
  })
  assert.equal(appended.replayed, false)
  assert.equal(appended.record.recordRevision, 1)
  assert.equal(appended.turn.sequence, 1)
  assert.equal(appended.turn.runId, 'run-main-1')
  assert.equal(provisionCalls, 1)

  const replayedTurn = await store.appendTurn({
    ...structuredClone(appendInput),
    createdAt: '2026-07-28T10:03:00.000Z',
  }, async () => {
    provisionCalls += 1
    return 'run-must-not-be-created'
  })
  assert.equal(replayedTurn.replayed, true)
  assert.equal(replayedTurn.turn.runId, 'run-main-1')
  assert.equal(provisionCalls, 1, 'turn replay must not provision another Run')

  await rejectsCode(
    () => store.appendTurn({
      ...appendInput,
      userMessage: 'Different message under the same key.',
    }, async () => 'run-conflict'),
    'IDEMPOTENCY_CONFLICT',
  )
  await rejectsCode(
    () => store.appendTurn({
      ...appendInput,
      turnId: 'turn-stale',
      idempotencyKey: 'conversation-turn-stale',
      expectedRecordRevision: 0,
    }, async () => 'run-stale'),
    'REVISION_CONFLICT',
  )

  const concurrent = await store.create({
    ...createInput,
    conversationId: 'conversation-store-concurrent',
    idempotencyKey: 'conversation-create-concurrent',
  })
  const concurrentResults = await Promise.allSettled([
    store.appendTurn({
      conversationId: concurrent.record.conversationId,
      turnId: 'turn-concurrent-left',
      userMessage: 'Left message.',
      expectedRecordRevision: 0,
      ownerScope,
      idempotencyKey: 'conversation-turn-concurrent-left',
      createdAt,
    }, async () => 'run-concurrent-left'),
    store.appendTurn({
      conversationId: concurrent.record.conversationId,
      turnId: 'turn-concurrent-right',
      userMessage: 'Right message.',
      expectedRecordRevision: 0,
      ownerScope,
      idempotencyKey: 'conversation-turn-concurrent-right',
      createdAt,
    }, async () => 'run-concurrent-right'),
  ])
  assert.equal(
    concurrentResults.filter((result) => result.status === 'fulfilled').length,
    1,
    'one optimistic revision may create exactly one Turn',
  )
  const concurrentFailure = concurrentResults.find((result) => result.status === 'rejected')
  assert(concurrentFailure)
  assert.equal(concurrentFailure.reason instanceof ConversationStoreError, true)
  assert.equal(concurrentFailure.reason.code, 'REVISION_CONFLICT')

  await rejectsCode(
    () => store.appendTurn({
      conversationId: createInput.conversationId,
      turnId: 'turn-foreign',
      userMessage: 'Foreign write attempt.',
      expectedRecordRevision: 1,
      ownerScope: foreignScope,
      idempotencyKey: 'conversation-turn-foreign',
      createdAt,
    }, async () => 'run-foreign'),
    'CONVERSATION_NOT_FOUND',
  )

  const corrupt = await store.create({
    ...createInput,
    conversationId: 'conversation-store-corrupt',
    idempotencyKey: 'conversation-create-corrupt',
  })
  const corruptPath = join(
    rootDir,
    'scopes',
    `scope-${digestCanonicalJson(ownerScope).slice(0, 32)}`,
    'conversations',
    Buffer.from(corrupt.record.conversationId, 'utf8').toString('base64url'),
    'record.json',
  )
  await writeFile(corruptPath, '{"schemaVersion":"unknown"}\n', 'utf8')
  await rejectsCode(
    () => store.get(corrupt.record.conversationId, ownerScope),
    'INVALID_RECORD',
  )

  console.log('conversation store tests passed')
} finally {
  await rm(rootDir, { recursive: true, force: true })
}

async function rejectsCode(operation, code) {
  await assert.rejects(operation, (error) => {
    assert.equal(error instanceof ConversationStoreError, true)
    assert.equal(error.code, code)
    return true
  })
}
