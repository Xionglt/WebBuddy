#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  ApprovalService,
  DurableHumanGate,
  FileApprovalStore,
  FileRunStore,
  RunService,
} from '../dist/control/index.js'
import { controlRecordDigest } from '../dist/control/store-contracts.js'
import { snapshotWebTaskInput } from '../dist/task/contracts.js'

const rootDir = await mkdtemp(join(tmpdir(), 'web-buddy-durable-gate-'))
try {
  const runs = new RunService(new FileRunStore({ rootDir }))
  const approvals = new ApprovalService(new FileApprovalStore({ rootDir }))
  const runId = 'durable-gate-c4'
  const contract = {
    schemaVersion: 'web-task-contract/v1',
    contractId: 'durable-gate-c4',
    revision: 0,
    criteria: [{
      id: 'draft-only',
      kind: 'action_boundary',
      description: 'Do not submit without approval.',
      actionKinds: ['submit'],
      outcome: 'not_performed',
    }],
  }
  await runs.create(snapshotWebTaskInput({
    schemaVersion: 'web-task-input/v1',
    runId,
    revision: 0,
    goal: { instruction: 'Prepare a draft.' },
    contract,
  }), { idempotencyKey: 'create-durable-gate-c4' })
  await runs.start(runId, 'start-durable-gate-c4')

  const abortController = new AbortController()
  const gate = new DurableHumanGate({
    runs,
    approvals,
    runId,
    runRevision: 0,
    attempt: 1,
    taskContract: contract,
    sessionId: 'session-durable-gate-c4',
    abortSignal: abortController.signal,
  })
  const approvalId = 'approval-durable-gate-c4'
  const expiresAt = '2030-01-01T00:00:00.000Z'
  const actionBinding = {
    schemaVersion: 'action-binding/v1',
    contractId: contract.contractId,
    contractRevision: contract.revision,
    runId,
    sessionRef: {
      schemaVersion: 'session-ref/v1',
      provider: 'file-session-store',
      id: 'session-durable-gate-c4',
      runId,
      attempt: 1,
    },
    actionId: 'submit-tool-c4',
    toolName: 'browser_click',
    argsSha256: 'd'.repeat(64),
    sourceContentIds: ['page-current-c4'],
    sourceSensitiveClasses: [],
    sourceOrigin: 'https://fixture.example',
    destinationOrigin: 'https://fixture.example',
    actionSeq: 7,
    expiresAt,
  }
  const decisionPromise = gate.confirmPermission(
    'final_submit',
    'Approve submit?',
    { url: 'https://fixture.example/review' },
    {
      request: {
        schemaVersion: 'permission-request/v1',
        requestId: 'permission-durable-gate-c4',
        runId,
        sessionId: 'session-durable-gate-c4',
        step: 7,
        requestedAt: new Date().toISOString(),
        subject: {
          kind: 'tool_call',
          toolCallId: 'submit-tool-c4',
          toolName: 'browser_click',
          args: { ref: 'submit' },
        },
        riskLevel: 'critical',
        currentUrl: 'https://fixture.example/review',
        policy: {
          schemaVersion: 'policy-decision/v1',
          action: 'gate',
          policyCode: 'final_submit',
          ruleId: 'final_submit.v1',
          reason: 'Submit requires approval.',
          auditTags: [],
        },
      },
      decision: { action: 'ask' },
      approval: {
        schemaVersion: 'approval-request/v1',
        id: approvalId,
        approvalId,
        runId,
        sessionId: 'session-durable-gate-c4',
        status: 'pending',
        gateKind: 'final_submit',
        title: 'Approval required',
        message: 'Approve submit?',
        reason: 'Submit requires approval.',
        allowedDecisions: ['approve', 'decline'],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      actionBinding,
    },
  )

  await until(async () => (await runs.get(runId))?.state === 'blocked_on_human')
  const blocked = await runs.get(runId)
  assert.deepEqual(blocked?.pendingApprovalIds, [approvalId])
  const durable = await approvals.get(approvalId)
  assert.equal(durable?.status, 'pending')
  assert.equal(durable?.actionBindingSha256, controlRecordDigest(actionBinding))

  const resolved = await approvals.resolve({
    approvalId,
    expectedRecordRevision: 0,
    expectation: {
      runId,
      runRevision: 0,
      attempt: 1,
      sessionId: 'session-durable-gate-c4',
      actionId: actionBinding.actionId,
      actionBindingSha256: controlRecordDigest(actionBinding),
      sourceOrigin: actionBinding.sourceOrigin,
      destinationOrigin: actionBinding.destinationOrigin,
    },
    decision: 'approved',
    idempotencyKey: 'resolve-durable-gate-c4',
    nonce: 'nonce-durable-gate-c4',
    expiresAt,
  })
  assert.equal(resolved.status, 'approved')
  assert.equal(await gate.resolveLive(approvalId, 'approved'), true)
  assert.equal(await decisionPromise, 'approve')
  const resumed = await runs.get(runId)
  assert.equal(resumed?.state, 'running')
  assert.deepEqual(resumed?.pendingApprovalIds, [])
  assert.equal(resumed?.runRevision, 0, 'live approval continuation stays in the same fenced attempt')

  assert.equal(await gate.resolveLive(approvalId, 'approved'), false, 'approval cannot resume the live turn twice')
  console.log('control durable human gate tests passed')
} finally {
  await rm(rootDir, { recursive: true, force: true })
}

async function until(predicate) {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setImmediate(resolve))
  }
  throw new Error('Timed out waiting for durable gate state.')
}
