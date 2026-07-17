#!/usr/bin/env node
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'

const distUrl = new URL('../dist/control/store-contracts.js', import.meta.url)
const sourceUrl = new URL('../src/control/store-contracts.ts', import.meta.url)
const contracts = await import(existsSync(distUrl) ? distUrl : sourceUrl)

const {
  APPROVAL_EVENT_SCHEMA_VERSION,
  APPROVAL_RECORD_SCHEMA_VERSION,
  ControlStoreError,
  RUN_EVENT_SCHEMA_VERSION,
  RUN_RECORD_SCHEMA_VERSION,
  controlRecordDigest,
  decodeApprovalRecord,
  decodeRunRecord,
  validateApprovalCreate,
  validateApprovalMutation,
  validateApprovalResolve,
  validateRunCreate,
  validateRunMutation,
} = contracts

const runId = 'run-control-c1'
const now = '2026-07-17T01:00:00.000Z'
const ownerScope = {
  schemaVersion: 'owner-scope/v1',
  tenantId: 'future-tenant',
  userId: 'future-user',
}
const sessionRef = {
  schemaVersion: 'session-ref/v1',
  provider: 'file-session-store',
  id: 'session-control-c1',
  runId,
  attempt: 1,
}
const inputSnapshot = {
  schemaVersion: 'web-task-input-snapshot/v1',
  inputSchemaVersion: 'web-task-input/v1',
  goal: { instruction: 'Research a deterministic fixture.' },
  contract: {
    schemaVersion: 'web-task-contract/v1',
    contractId: 'contract-control-c1',
    revision: 0,
    criteria: [{
      id: 'observed',
      kind: 'evidence_present',
      description: 'Observe fixture.',
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

const run = {
  schemaVersion: RUN_RECORD_SCHEMA_VERSION,
  runId,
  recordRevision: 0,
  runRevision: 0,
  attempt: 1,
  state: 'queued',
  inputSnapshot,
  inputDigest: inputSnapshot.sha256,
  ownerScope,
  sessionRef,
  artifactRefs: [],
  resourceRefs: [],
  pendingApprovalIds: [],
  nextEventSequence: 1,
  createdAt: now,
  updatedAt: now,
}
const runCreated = {
  schemaVersion: RUN_EVENT_SCHEMA_VERSION,
  eventId: 'run-event-0',
  eventSequence: 0,
  eventType: 'run_created',
  runId,
  recordRevisionBefore: null,
  recordRevisionAfter: 0,
  runRevision: 0,
  attempt: 1,
  occurredAt: now,
  idempotencyKey: 'create-run-control-c1',
  ownerScope,
}

validateRunCreate({
  record: run,
  event: runCreated,
  options: { idempotencyKey: runCreated.idempotencyKey },
})
assert.deepEqual(decodeRunRecord(JSON.parse(JSON.stringify(run))), run, 'run record must JSON round-trip')
assert.equal(decodeRunRecord(JSON.parse(JSON.stringify(run))).ownerScope.tenantId, 'future-tenant')

const localRun = structuredClone(run)
const localRunCreated = structuredClone(runCreated)
delete localRun.ownerScope
delete localRun.inputSnapshot.ownerScope
delete localRunCreated.ownerScope
validateRunCreate({
  record: localRun,
  event: localRunCreated,
  options: { idempotencyKey: localRunCreated.idempotencyKey },
})

assertStoreError(
  () => decodeRunRecord({ ...run, schemaVersion: 'control-run-record/v999' }),
  'UNSUPPORTED_SCHEMA_VERSION',
)
const migratedRun = decodeRunRecord(
  { ...run, schemaVersion: 'control-run-record/v0' },
  [{
    fromSchemaVersion: 'control-run-record/v0',
    toSchemaVersion: RUN_RECORD_SCHEMA_VERSION,
    migrate: (legacy) => ({ ...legacy, schemaVersion: RUN_RECORD_SCHEMA_VERSION }),
  }],
)
assert.equal(migratedRun.schemaVersion, RUN_RECORD_SCHEMA_VERSION, 'registered migration must reach current schema')

const running = {
  ...run,
  recordRevision: 1,
  runRevision: 1,
  state: 'running',
  nextEventSequence: 2,
  updatedAt: '2026-07-17T01:00:01.000Z',
}
const runningEvent = {
  ...runCreated,
  eventId: 'run-event-1',
  eventSequence: 1,
  eventType: 'state_transitioned',
  recordRevisionBefore: 0,
  recordRevisionAfter: 1,
  runRevision: 1,
  occurredAt: running.updatedAt,
  idempotencyKey: 'run-control-c1-start',
}
validateRunMutation(run, {
  expectedRecordRevision: 0,
  record: running,
  event: runningEvent,
  idempotencyKey: runningEvent.idempotencyKey,
})
assertStoreError(
  () => validateRunMutation(run, {
    expectedRecordRevision: 7,
    record: running,
    event: runningEvent,
    idempotencyKey: runningEvent.idempotencyKey,
  }),
  'REVISION_CONFLICT',
)
assertStoreError(
  () => validateRunMutation(run, {
    expectedRecordRevision: 0,
    record: {
      ...running,
      ownerScope: { ...ownerScope, tenantId: 'other-tenant' },
    },
    event: {
      ...runningEvent,
      ownerScope: { ...ownerScope, tenantId: 'other-tenant' },
    },
    idempotencyKey: runningEvent.idempotencyKey,
  }),
  'BINDING_MISMATCH',
)
assertStoreError(
  () => validateRunMutation(run, {
    expectedRecordRevision: 0,
    record: {
      ...running,
      inputSnapshot: {
        ...running.inputSnapshot,
        goal: { instruction: 'Mutated after create.' },
      },
    },
    event: runningEvent,
    idempotencyKey: runningEvent.idempotencyKey,
  }),
  'BINDING_MISMATCH',
)
assertStoreError(
  () => validateRunMutation(running, {
    expectedRecordRevision: 1,
    record: {
      ...running,
      recordRevision: 2,
      runRevision: 0,
      nextEventSequence: 3,
    },
    event: {
      ...runningEvent,
      eventId: 'run-event-2',
      eventSequence: 2,
      recordRevisionBefore: 1,
      recordRevisionAfter: 2,
      runRevision: 0,
      idempotencyKey: 'run-control-c1-regress',
    },
    idempotencyKey: 'run-control-c1-regress',
  }),
  'REVISION_CONFLICT',
)
assertStoreError(
  () => validateRunMutation(run, {
    expectedRecordRevision: 0,
    record: running,
    event: {
      ...runningEvent,
      eventType: 'run_created',
    },
    idempotencyKey: runningEvent.idempotencyKey,
  }),
  'EVENT_SEQUENCE_CONFLICT',
)

const actionBinding = {
  schemaVersion: 'action-binding/v1',
  contractId: 'contract-control-c1',
  contractRevision: 0,
  runId,
  sessionRef,
  actionId: 'submit-sensitive-form',
  toolName: 'browser_click',
  argsSha256: 'b'.repeat(64),
  sourceContentIds: ['context-1'],
  sourceSensitiveClasses: ['identity'],
  sourceOrigin: 'https://source.example.test',
  destinationOrigin: 'https://target.example.test',
  targetFingerprint: 'button#submit',
  actionSeq: 4,
  pageRevision: 2,
  workflowRevision: 3,
  expiresAt: '2026-07-17T02:00:00.000Z',
}
const approvalId = 'approval-control-c1'
const approval = {
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
  requestedAt: now,
  updatedAt: now,
  expiresAt: '2026-07-17T01:30:00.000Z',
}
const approvalEnqueued = {
  schemaVersion: APPROVAL_EVENT_SCHEMA_VERSION,
  eventId: 'approval-event-0',
  eventSequence: 0,
  eventType: 'approval_enqueued',
  approvalId,
  runId,
  recordRevisionBefore: null,
  recordRevisionAfter: 0,
  runRevision: 1,
  attempt: 1,
  actionId: actionBinding.actionId,
  occurredAt: now,
  idempotencyKey: 'create-approval-control-c1',
  ownerScope,
}

validateApprovalCreate({
  record: approval,
  event: approvalEnqueued,
  options: { idempotencyKey: approvalEnqueued.idempotencyKey },
})
assert.deepEqual(
  decodeApprovalRecord(JSON.parse(JSON.stringify(approval))),
  approval,
  'approval record must JSON round-trip',
)
assertStoreError(
  () => decodeApprovalRecord({ ...approval, schemaVersion: 'control-approval-record/future' }),
  'UNSUPPORTED_SCHEMA_VERSION',
)

const resolution = {
  schemaVersion: 'approval-binding/v1',
  approvalId,
  actionBindingSha256: approval.actionBindingSha256,
  decision: 'approved',
  issuedAt: '2026-07-17T01:01:00.000Z',
  expiresAt: '2026-07-17T01:20:00.000Z',
  nonce: 'single-consume-nonce',
}
const exactExpectation = {
  runId,
  runRevision: 1,
  attempt: 1,
  sessionId: sessionRef.id,
  actionId: actionBinding.actionId,
  actionBindingSha256: approval.actionBindingSha256,
  sourceOrigin: actionBinding.sourceOrigin,
  destinationOrigin: actionBinding.destinationOrigin,
}
validateApprovalResolve(approval, {
  approvalId,
  expectedRecordRevision: 0,
  idempotencyKey: 'resolve-approval-control-c1',
  expectation: exactExpectation,
  resolution,
  resolvedAt: '2026-07-17T01:01:00.000Z',
})

for (const expectation of [
  { ...exactExpectation, runId: 'wrong-run' },
  { ...exactExpectation, attempt: 2 },
  { ...exactExpectation, actionId: 'wrong-action' },
  { ...exactExpectation, destinationOrigin: 'https://attacker.example.test' },
]) {
  assertStoreError(
    () => validateApprovalResolve(approval, {
      approvalId,
      expectedRecordRevision: 0,
      idempotencyKey: 'wrong-binding',
      expectation,
      resolution,
      resolvedAt: '2026-07-17T01:01:00.000Z',
    }),
    'BINDING_MISMATCH',
  )
}

const resolvedApproval = {
  ...approval,
  recordRevision: 1,
  status: 'approved',
  resolution,
  terminal: {
    status: 'approved',
    source: 'user',
    occurredAt: '2026-07-17T01:01:00.000Z',
  },
  nextEventSequence: 2,
  updatedAt: '2026-07-17T01:01:00.000Z',
}
const resolvedEvent = {
  ...approvalEnqueued,
  eventId: 'approval-event-1',
  eventSequence: 1,
  eventType: 'approval_resolved',
  recordRevisionBefore: 0,
  recordRevisionAfter: 1,
  occurredAt: resolvedApproval.updatedAt,
  idempotencyKey: 'resolve-approval-control-c1',
}
assertStoreError(
  () => validateApprovalMutation(approval, {
    expectedRecordRevision: 0,
    record: resolvedApproval,
    event: resolvedEvent,
    idempotencyKey: resolvedEvent.idempotencyKey,
  }),
  'BINDING_MISMATCH',
)
for (const mutatedRecord of [
  { ...approval, recordRevision: 1, nextEventSequence: 2, runRevision: 2 },
  { ...approval, recordRevision: 1, nextEventSequence: 2, attempt: 2 },
  {
    ...approval,
    recordRevision: 1,
    nextEventSequence: 2,
    ownerScope: { ...ownerScope, tenantId: 'other-tenant' },
  },
  {
    ...approval,
    recordRevision: 1,
    nextEventSequence: 2,
    expiresAt: '2026-07-17T01:45:00.000Z',
  },
]) {
  assertStoreError(
    () => validateApprovalMutation(approval, {
      expectedRecordRevision: 0,
      record: mutatedRecord,
      event: {
        ...approvalEnqueued,
        eventId: 'approval-event-1',
        eventSequence: 1,
        eventType: 'approval_cancelled',
        recordRevisionBefore: 0,
        recordRevisionAfter: 1,
        runRevision: mutatedRecord.runRevision,
        attempt: mutatedRecord.attempt,
        ownerScope: mutatedRecord.ownerScope,
        idempotencyKey: 'mutate-approval-binding',
      },
      idempotencyKey: 'mutate-approval-binding',
    }),
    'BINDING_MISMATCH',
  )
}
assertStoreError(
  () => validateApprovalResolve(resolvedApproval, {
    approvalId,
    expectedRecordRevision: 1,
    idempotencyKey: 'second-resolve',
    expectation: exactExpectation,
    resolution,
    resolvedAt: '2026-07-17T01:02:00.000Z',
  }),
  'APPROVAL_NOT_PENDING',
)

assertStoreError(
  () => validateApprovalCreate({
    record: { ...approval, allowedDecisions: ['approved', 'reuse'] },
    event: approvalEnqueued,
    options: { idempotencyKey: approvalEnqueued.idempotencyKey },
  }),
  'INVALID_RECORD',
)
assertStoreError(
  () => validateApprovalResolve(approval, {
    approvalId,
    expectedRecordRevision: 0,
    idempotencyKey: 'invalid-resolution',
    expectation: exactExpectation,
    resolution: { ...resolution, nonce: '', issuedAt: 'not-a-date' },
    resolvedAt: '2026-07-17T01:01:00.000Z',
  }),
  'INVALID_RECORD',
)
assertStoreError(
  () => validateApprovalCreate({
    record: {
      ...approval,
      ownerScope: { schemaVersion: 'owner-scope/v1' },
    },
    event: {
      ...approvalEnqueued,
      ownerScope: { schemaVersion: 'owner-scope/v1' },
    },
    options: { idempotencyKey: approvalEnqueued.idempotencyKey },
  }),
  'INVALID_RECORD',
)
assertStoreError(
  () => decodeRunRecord({ ...run, onEvent() {} }),
  'INVALID_RECORD',
)

console.log('control-store-contract-test: PASS')

function assertStoreError(operation, code) {
  assert.throws(operation, (error) => {
    assert(error instanceof ControlStoreError)
    assert.equal(error.code, code)
    return true
  })
}
