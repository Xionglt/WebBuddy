#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  ApprovalService,
  FileApprovalStore,
  FileRunStore,
  RunService,
  RunServiceError,
  controlRecordDigest,
} from '../dist/control/index.js'
import { snapshotWebTaskInput } from '../dist/task/contracts.js'

const rootDir = await mkdtemp(join(tmpdir(), 'web-buddy-run-service-'))
try {
  const runStore = new FileRunStore({ rootDir })
  const service = new RunService(runStore)
  const runId = 'run-service-c3'
  const snapshot = snapshotWebTaskInput({
    schemaVersion: 'web-task-input/v1',
    runId,
    revision: 0,
    goal: { instruction: 'Research a deterministic fixture.' },
    contract: {
      schemaVersion: 'web-task-contract/v1',
      contractId: 'control-plane-c3',
      revision: 0,
      criteria: [{
        id: 'observed',
        kind: 'evidence_present',
        description: 'Observe fixture.',
        evidenceKinds: ['page_observation'],
        minCount: 1,
        allowedAuthorities: ['main_runtime'],
      }],
    },
  })

  assert.equal((await service.create(snapshot, { idempotencyKey: 'create-c3' })).record.state, 'queued')
  assert.equal((await service.start(runId, 'start-c3')).state, 'running')
  assert.equal((await service.requestPause(runId, 'pause-c3')).state, 'pausing')
  assert.equal((await service.requestPause(runId, 'pause-c3-replay')).state, 'pausing', 'pause is idempotent')

  await assert.rejects(
    service.transition(runId, { to: 'completed', idempotencyKey: 'complete-while-pausing' }),
    (error) => error instanceof RunServiceError && error.code === 'ILLEGAL_TRANSITION',
    'pausing cannot be treated as completed before a safe-boundary acknowledgement',
  )

  const paused = await service.acknowledgePause(runId, {
    schemaVersion: 'safe-turn-boundary-ref/v1',
    runId,
    runRevision: 0,
    attempt: 1,
    turnId: 'turn-7',
    actionSeq: 9,
    observedAt: new Date().toISOString(),
  }, 'pause-ack-c3')
  assert.equal(paused.state, 'paused')
  assert.equal(paused.lastSafeBoundary?.turnId, 'turn-7')

  const resuming = await service.resume(runId, 'resume-c3')
  assert.equal(resuming.state, 'resuming')
  assert.equal(resuming.runRevision, 1)
  assert.equal(resuming.attempt, 2)
  await service.transition(runId, { to: 'running', idempotencyKey: 'restart-c3' })
  await assert.rejects(
    service.requestPause(runId, 'stale-pause-c3', undefined, {
      expectedRunRevision: 0,
      expectedAttempt: 1,
    }),
    (error) => error?.code === 'STALE_ATTEMPT',
    'a stale control request must not cross a lifecycle epoch',
  )

  const late = await service.acceptResult({
    runId,
    runRevision: 0,
    attempt: 1,
    terminalState: 'completed',
    idempotencyKey: 'late-result-c3',
  })
  assert.equal(late.accepted, false)
  assert.equal(late.record.state, 'running', 'late result must not mutate lifecycle state')
  assert.equal(
    (await service.events(runId)).items.at(-1)?.eventType,
    'late_result_rejected',
    'late result rejection is durable and auditable',
  )

  const completed = await service.acceptResult({
    runId,
    runRevision: 1,
    attempt: 2,
    terminalState: 'completed',
    reason: 'Fixture evidence verified.',
    idempotencyKey: 'current-result-c3',
    resourceRefs: [{
      schemaVersion: 'control-resource-ref/v1',
      id: 'trace-c3',
      kind: 'trace',
      locator: 'traces/run-service-c3',
    }],
  })
  assert.equal(completed.accepted, true)
  assert.equal(completed.record.state, 'completed')
  assert.equal(completed.record.resourceRefs[0].kind, 'trace')
  await assert.rejects(
    service.requestCancel(runId, 'cancel-terminal-c3'),
    (error) => error instanceof RunServiceError && error.code === 'ILLEGAL_TRANSITION',
  )

  const cancelId = 'run-service-cancel-c3'
  const cancelSnapshot = snapshotWebTaskInput({
    ...snapshot,
    schemaVersion: 'web-task-input/v1',
    runId: cancelId,
  })
  await service.create(cancelSnapshot, { idempotencyKey: 'create-cancel-c3' })
  assert.equal((await service.requestCancel(cancelId, 'cancel-before-start-c3')).state, 'cancelled')
  assert.equal((await service.requestCancel(cancelId, 'cancel-before-start-c3-replay')).state, 'cancelled')

  const approvalStore = new FileApprovalStore({ rootDir })
  const approvals = new ApprovalService(approvalStore)
  const actionBinding = {
    schemaVersion: 'action-binding/v1',
    contractId: 'control-plane-c3',
    contractRevision: 1,
    runId,
    actionId: 'submit-c3',
    toolName: 'browser_click',
    argsSha256: 'a'.repeat(64),
    sourceContentIds: ['page-c3'],
    sourceSensitiveClasses: [],
    sourceOrigin: 'https://source.example',
    destinationOrigin: 'https://destination.example',
    actionSeq: 10,
    expiresAt: '2030-01-01T00:00:00.000Z',
  }
  const requestedAt = new Date().toISOString()
  const approvalId = 'approval-service-c3'
  const enqueued = await approvals.enqueue({
    approvalId,
    runId,
    runRevision: 1,
    attempt: 2,
    status: 'pending',
    actionBinding,
    allowedDecisions: ['approved', 'denied'],
    requestedAt,
    expiresAt: '2030-01-01T00:00:00.000Z',
  }, 'enqueue-approval-c3')
  assert.equal(enqueued.record.status, 'pending')
  assert.equal((await approvals.list({ statuses: ['pending'] })).items.length, 1)

  const expectation = {
    runId,
    runRevision: 1,
    attempt: 2,
    actionId: actionBinding.actionId,
    actionBindingSha256: controlRecordDigest(actionBinding),
    sourceOrigin: actionBinding.sourceOrigin,
    destinationOrigin: actionBinding.destinationOrigin,
  }
  await assert.rejects(
    approvals.resolve({
      approvalId,
      expectedRecordRevision: 0,
      expectation: { ...expectation, destinationOrigin: 'https://redirected.example' },
      decision: 'approved',
      idempotencyKey: 'resolve-wrong-origin-c3',
      nonce: 'nonce-wrong',
      expiresAt: '2030-01-01T00:00:00.000Z',
    }),
    (error) => error?.code === 'BINDING_MISMATCH',
  )
  const resolved = await approvals.resolve({
    approvalId,
    expectedRecordRevision: 0,
    expectation,
    decision: 'approved',
    idempotencyKey: 'resolve-approval-c3',
    nonce: 'nonce-c3',
    expiresAt: '2030-01-01T00:00:00.000Z',
  })
  assert.equal(resolved.status, 'approved')
  await assert.rejects(
    approvals.resolve({
      approvalId,
      expectedRecordRevision: 1,
      expectation,
      decision: 'approved',
      idempotencyKey: 'resolve-approval-again-c3',
      nonce: 'nonce-c3-again',
      expiresAt: '2030-01-01T00:00:00.000Z',
    }),
    (error) => error?.code === 'APPROVAL_NOT_PENDING',
    'durable approval cannot be reused',
  )

  console.log('control run service tests passed')
} finally {
  await rm(rootDir, { recursive: true, force: true })
}
