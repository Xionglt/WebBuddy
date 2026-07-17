#!/usr/bin/env node
import assert from 'node:assert/strict'
import { appendFile, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  APPROVAL_EVENT_SCHEMA_VERSION,
  APPROVAL_RECORD_SCHEMA_VERSION,
  ControlStoreError,
  RUN_EVENT_SCHEMA_VERSION,
  RUN_RECORD_SCHEMA_VERSION,
  FileApprovalStore,
  FileRunStore,
  controlRecordDigest,
  fileControlStorePaths,
} from '../dist/control/index.js'

const root = await mkdtemp(join(tmpdir(), 'web-buddy-control-store-'))
const ownerScope = {
  schemaVersion: 'owner-scope/v1',
  tenantId: 'tenant-c2',
  userId: 'user-c2',
}

try {
  await runRestartAndIdempotency()
  await runCrashRecoveryMatrix()
  await runConcurrencyAndCorruption()
  await runApprovalMatrix()
  console.log('control-file-store-test: PASS')
} finally {
  await rm(root, { recursive: true, force: true })
}

async function runRestartAndIdempotency() {
  const store = new FileRunStore({ rootDir: root })
  const create = runCreate('run-restart')
  const committed = await store.create(create)
  assert.equal(committed.replayed, false)
  assert.equal((await store.create(create)).replayed, true)
  await assertStoreError(
    store.create({
      ...create,
      record: { ...create.record, reason: 'different bytes' },
    }),
    'IDEMPOTENCY_CONFLICT',
  )

  const restarted = new FileRunStore({ rootDir: root })
  assert.equal((await restarted.get(create.record.runId, { ownerScope }))?.state, 'queued')
  assert.equal((await restarted.get(create.record.runId))?.state, undefined, 'scope omission is local default, not wildcard')
  assert.deepEqual((await restarted.list({ ownerScope })).items.map((record) => record.runId), ['run-restart'])
  assert.deepEqual((await restarted.readEvents(create.record.runId, { ownerScope })).items.map((event) => event.eventSequence), [0])
}

async function runCrashRecoveryMatrix() {
  for (const point of ['after_wal', 'after_record', 'after_event', 'after_idempotency']) {
    const id = `run-crash-${point}`
    let injected = false
    const crashing = new FileRunStore({
      rootDir: root,
      faultInjector(candidate, entity) {
        if (!injected && candidate === point && entity.id === id) {
          injected = true
          throw new Error(`fault:${point}`)
        }
      },
    })
    await assert.rejects(crashing.create(runCreate(id)), new RegExp(`fault:${point}`))
    const restarted = new FileRunStore({ rootDir: root })
    const recovered = await restarted.get(id, { ownerScope })
    assert.equal(recovered?.state, 'queued', `${point} must recover the record`)
    assert.deepEqual((await restarted.readEvents(id, { ownerScope })).items.map((event) => event.eventSequence), [0])
    assert.equal((await restarted.create(runCreate(id))).replayed, true, `${point} must recover idempotency`)
  }

  const listOnlyId = 'run-list-recovers-wal'
  let injected = false
  const crashing = new FileRunStore({
    rootDir: root,
    faultInjector(point, entity) {
      if (!injected && point === 'after_wal' && entity.id === listOnlyId) {
        injected = true
        throw new Error('fault:list-after-wal')
      }
    },
  })
  await assert.rejects(crashing.create(runCreate(listOnlyId)), /fault:list-after-wal/)
  const listed = await new FileRunStore({ rootDir: root }).list({ ownerScope })
  assert(listed.items.some((record) => record.runId === listOnlyId), 'list must recover WAL-only entities')
}

async function runConcurrencyAndCorruption() {
  const store = new FileRunStore({ rootDir: root })
  const created = runCreate('run-concurrent')
  await store.create(created)
  const first = runMutation(created.record, created.event, 'mutation-a')
  const second = runMutation(created.record, created.event, 'mutation-b')
  const settled = await Promise.allSettled([
    store.transact(created.record.runId, first),
    store.transact(created.record.runId, second),
  ])
  assert.equal(settled.filter((item) => item.status === 'fulfilled').length, 1)
  const rejected = settled.find((item) => item.status === 'rejected')
  assert(rejected && rejected.reason instanceof ControlStoreError)
  assert.equal(rejected.reason.code, 'REVISION_CONFLICT')

  const paths = fileControlStorePaths(root, 'run', created.record.runId, ownerScope)
  await appendFile(paths.events, '{corrupt-tail\n', 'utf8')
  const events = await store.readEvents(created.record.runId, { ownerScope })
  assert.deepEqual(events.items.map((event) => event.eventSequence), [0, 1])
  assert((await readdir(paths.dir)).some((name) => name.startsWith('events.corrupt.')))

  const corrupt = runCreate('run-corrupt-record')
  await store.create(corrupt)
  const corruptPaths = fileControlStorePaths(root, 'run', corrupt.record.runId, ownerScope)
  await writeFile(corruptPaths.record, '{"schemaVersion":"control-run-record/v999"}\n', 'utf8')
  const list = await store.list({ ownerScope })
  assert(!list.items.some((record) => record.runId === corrupt.record.runId))
  assert((await readdir(corruptPaths.dir)).some((name) => name.includes('.quarantine.invalid-run-record.')))
}

async function runApprovalMatrix() {
  const create = approvalCreate('approval-c2', 'run-restart')
  let injected = false
  const crashing = new FileApprovalStore({
    rootDir: root,
    faultInjector(point, entity) {
      if (!injected && point === 'after_event' && entity.id === create.record.approvalId) {
        injected = true
        throw new Error('fault:approval-after-event')
      }
    },
  })
  await assert.rejects(crashing.create(create), /fault:approval-after-event/)

  const store = new FileApprovalStore({ rootDir: root })
  assert.equal((await store.get(create.record.approvalId, { ownerScope }))?.status, 'pending')
  assert.equal((await store.list({ ownerScope, statuses: ['pending'] })).items.length, 1)
  await assertStoreError(
    store.resolveOnce(resolveCommand(create.record, { destinationOrigin: 'https://attacker.example.test' })),
    'BINDING_MISMATCH',
  )

  const commandA = resolveCommand(create.record, {}, 'resolve-a', 'nonce-a')
  const commandB = resolveCommand(create.record, {}, 'resolve-b', 'nonce-b')
  const settled = await Promise.allSettled([store.resolveOnce(commandA), store.resolveOnce(commandB)])
  assert.equal(settled.filter((item) => item.status === 'fulfilled').length, 1, 'exactly one concurrent decision may commit')
  const winner = settled.find((item) => item.status === 'fulfilled')
  assert(winner && winner.value.record.status === 'approved')
  const loser = settled.find((item) => item.status === 'rejected')
  assert(loser && loser.reason instanceof ControlStoreError)
  assert(
    loser.reason.code === 'APPROVAL_NOT_PENDING' || loser.reason.code === 'REVISION_CONFLICT',
    `losing resolver must fail closed, got ${loser.reason.code}`,
  )

  const winningCommand = winner.value.event.idempotencyKey === commandA.idempotencyKey ? commandA : commandB
  assert.equal((await store.resolveOnce(winningCommand)).replayed, true, 'identical resolve replay is idempotent')
  const restarted = new FileApprovalStore({ rootDir: root })
  assert.equal((await restarted.get(create.record.approvalId, { ownerScope }))?.status, 'approved')
  assert.deepEqual((await restarted.readEvents(create.record.approvalId, { ownerScope })).items.map((event) => event.eventSequence), [0, 1])
}

function runCreate(runId) {
  const now = '2026-07-17T03:00:00.000Z'
  const snapshot = {
    schemaVersion: 'web-task-input-snapshot/v1',
    inputSchemaVersion: 'web-task-input/v1',
    goal: { instruction: 'Research a deterministic fixture.' },
    contract: {
      schemaVersion: 'web-task-contract/v1',
      contractId: `contract-${runId}`,
      revision: 0,
      criteria: [{
        id: 'page',
        kind: 'evidence_present',
        description: 'Observe page.',
        evidenceKinds: ['page'],
        minCount: 1,
        allowedAuthorities: ['main_runtime'],
      }],
    },
    contextItems: [],
    contextProviders: [],
    runId,
    revision: 0,
    ownerScope,
    sha256: 'a'.repeat(64),
  }
  const record = {
    schemaVersion: RUN_RECORD_SCHEMA_VERSION,
    runId,
    recordRevision: 0,
    runRevision: 0,
    attempt: 1,
    state: 'queued',
    inputSnapshot: snapshot,
    inputDigest: snapshot.sha256,
    ownerScope,
    artifactRefs: [],
    resourceRefs: [],
    pendingApprovalIds: [],
    nextEventSequence: 1,
    createdAt: now,
    updatedAt: now,
  }
  const event = {
    schemaVersion: RUN_EVENT_SCHEMA_VERSION,
    eventId: `${runId}:event:0`,
    eventSequence: 0,
    eventType: 'run_created',
    runId,
    recordRevisionBefore: null,
    recordRevisionAfter: 0,
    runRevision: 0,
    attempt: 1,
    occurredAt: now,
    idempotencyKey: `create:${runId}`,
    ownerScope,
  }
  return { record, event, options: { idempotencyKey: event.idempotencyKey } }
}

function runMutation(current, _currentEvent, key) {
  const updatedAt = '2026-07-17T03:00:01.000Z'
  const record = {
    ...current,
    recordRevision: 1,
    runRevision: 1,
    state: 'running',
    nextEventSequence: 2,
    updatedAt,
  }
  const event = {
    schemaVersion: RUN_EVENT_SCHEMA_VERSION,
    eventId: `${current.runId}:event:1:${key}`,
    eventSequence: 1,
    eventType: 'state_transitioned',
    runId: current.runId,
    recordRevisionBefore: 0,
    recordRevisionAfter: 1,
    runRevision: 1,
    attempt: 1,
    occurredAt: updatedAt,
    idempotencyKey: key,
    ownerScope,
  }
  return { expectedRecordRevision: 0, record, event, idempotencyKey: key }
}

function approvalCreate(approvalId, runId) {
  const requestedAt = '2026-07-17T03:01:00.000Z'
  const sessionRef = {
    schemaVersion: 'session-ref/v1',
    provider: 'file-session-store',
    id: 'session-c2',
    runId,
    attempt: 1,
  }
  const actionBinding = {
    schemaVersion: 'action-binding/v1',
    contractId: `contract-${runId}`,
    contractRevision: 0,
    runId,
    sessionRef,
    actionId: 'send-c2',
    toolName: 'browser_type',
    argsSha256: 'b'.repeat(64),
    sourceContentIds: ['contact'],
    sourceSensitiveClasses: ['identity'],
    sourceOrigin: 'https://source.example.test',
    destinationOrigin: 'https://target.example.test',
    actionSeq: 2,
    expiresAt: '2026-07-17T04:00:00.000Z',
  }
  const record = {
    schemaVersion: APPROVAL_RECORD_SCHEMA_VERSION,
    approvalId,
    runId,
    recordRevision: 0,
    runRevision: 1,
    attempt: 1,
    status: 'pending',
    actionBinding,
    actionBindingSha256: controlRecordDigest(actionBinding),
    allowedDecisions: ['approved', 'denied'],
    ownerScope,
    sessionRef,
    nextEventSequence: 1,
    requestedAt,
    updatedAt: requestedAt,
    expiresAt: '2026-07-17T03:30:00.000Z',
  }
  const event = {
    schemaVersion: APPROVAL_EVENT_SCHEMA_VERSION,
    eventId: `${approvalId}:event:0`,
    eventSequence: 0,
    eventType: 'approval_enqueued',
    approvalId,
    runId,
    recordRevisionBefore: null,
    recordRevisionAfter: 0,
    runRevision: 1,
    attempt: 1,
    actionId: actionBinding.actionId,
    occurredAt: requestedAt,
    idempotencyKey: `create:${approvalId}`,
    ownerScope,
  }
  return { record, event, options: { idempotencyKey: event.idempotencyKey } }
}

function resolveCommand(record, expectationPatch = {}, idempotencyKey = 'resolve-approval-c2', nonce = 'approval-c2-once') {
  const resolvedAt = '2026-07-17T03:02:00.000Z'
  return {
    approvalId: record.approvalId,
    expectedRecordRevision: 0,
    idempotencyKey,
    expectation: {
      runId: record.runId,
      runRevision: record.runRevision,
      attempt: record.attempt,
      sessionId: record.sessionRef.id,
      actionId: record.actionBinding.actionId,
      actionBindingSha256: record.actionBindingSha256,
      sourceOrigin: record.actionBinding.sourceOrigin,
      destinationOrigin: record.actionBinding.destinationOrigin,
      ...expectationPatch,
    },
    resolution: {
      schemaVersion: 'approval-binding/v1',
      approvalId: record.approvalId,
      actionBindingSha256: record.actionBindingSha256,
      decision: 'approved',
      issuedAt: resolvedAt,
      expiresAt: '2026-07-17T03:20:00.000Z',
      nonce,
    },
    resolvedAt,
  }
}

async function assertStoreError(promise, code) {
  await assert.rejects(promise, (error) => {
    assert(error instanceof ControlStoreError)
    assert.equal(error.code, code)
    return true
  })
}
