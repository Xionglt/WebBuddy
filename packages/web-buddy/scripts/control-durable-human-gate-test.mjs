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
import { digestCanonicalJson, snapshotWebTaskInput } from '../dist/task/contracts.js'

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
  await runs.attachSession(runId, {
    schemaVersion: 'session-ref/v1',
    provider: 'file-session-store',
    id: 'session-durable-gate-c4',
    runId,
    attempt: 1,
  }, 'attach-session-durable-gate-c4')

  const abortController = new AbortController()
  const gate = new DurableHumanGate({
    runs,
    approvals,
    runId,
    runRevision: 0,
    attempt: 1,
    taskContract: contract,
    goal: 'Prepare a draft.',
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
    argsSha256: digestCanonicalJson({ ref: 'submit' }),
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
        context: {
          sinkActionId: actionBinding.actionId,
          sinkActionBindingSha256: digestCanonicalJson(actionBinding),
        },
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

  const executionApprovalId = 'approval-durable-gate-execute-c4'
  const executionActionBinding = {
    ...actionBinding,
    actionId: 'submit-tool-execute-c4',
    externalBusinessKey: 'portal:tenant-c4:invoice:EXECUTE-1',
    externalEffectDigest: 'e'.repeat(64),
    externalProbeId: 'invoice-query/v1',
    externalActionKind: 'submit',
    externalEffectPreview: '{"invoiceId":"EXECUTE-1","operation":"submit_invoice"}',
    actionSeq: 8,
  }
  const executionPermission = {
      request: {
        schemaVersion: 'permission-request/v1',
        requestId: 'permission-durable-gate-execute-c4',
        runId,
        sessionId: 'session-durable-gate-c4',
        step: 8,
        requestedAt: new Date().toISOString(),
        subject: {
          kind: 'tool_call',
          toolCallId: executionActionBinding.actionId,
          toolName: 'browser_click',
          args: { ref: 'submit' },
        },
        riskLevel: 'critical',
        currentUrl: 'https://fixture.example/review',
        context: {
          sinkActionId: executionActionBinding.actionId,
          sinkActionBindingSha256: digestCanonicalJson(executionActionBinding),
        },
        policy: {
          schemaVersion: 'policy-decision/v1',
          action: 'gate',
          policyCode: 'final_submit',
          ruleId: 'final_submit.v1',
          reason: 'Machine execution requires a distinct exact authorization.',
          auditTags: [],
        },
      },
      decision: { action: 'ask' },
      approval: {
        schemaVersion: 'approval-request/v1',
        id: executionApprovalId,
        approvalId: executionApprovalId,
        runId,
        sessionId: 'session-durable-gate-c4',
        status: 'pending',
        gateKind: 'final_submit',
        title: 'Execution authorization required',
        message: 'Approve and execute this exact submit?',
        reason: 'Machine execution requires a distinct exact authorization.',
        allowedDecisions: ['approve', 'approve_and_execute', 'decline'],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      actionBinding: executionActionBinding,
    }
  await assert.rejects(
    gate.confirmPermission(
      'final_submit',
      'Reject a binding for a foreign contract.',
      { url: 'https://fixture.example/review' },
      {
        ...executionPermission,
        actionBinding: {
          ...executionActionBinding,
          contractId: 'foreign-contract',
        },
      },
    ),
    /DURABLE_HUMAN_GATE_BINDING_MISMATCH/,
    'the durable gate must reject an ActionBinding outside the exact task contract',
  )
  await assert.rejects(
    gate.confirmPermission(
      'final_submit',
      'Reject an envelope for a foreign run.',
      { url: 'https://fixture.example/review' },
      {
        ...executionPermission,
        request: { ...executionPermission.request, runId: 'foreign-run' },
      },
    ),
    /DURABLE_HUMAN_GATE_BINDING_MISMATCH/,
    'the durable gate must reject a permission envelope outside the current run/session',
  )
  const executionDecisionPromise = gate.confirmPermission(
    'final_submit',
    'Approve and execute this exact submit?',
    { url: 'https://fixture.example/review' },
    executionPermission,
  )
  await until(async () => (await runs.get(runId))?.state === 'blocked_on_human')
  const durableExecutionApproval = await approvals.get(executionApprovalId)
  assert.deepEqual(
    durableExecutionApproval?.allowedDecisions,
    ['approved', 'approved_and_execute', 'denied'],
  )
  const resolvedExecution = await approvals.resolve({
    approvalId: executionApprovalId,
    expectedRecordRevision: 0,
    expectation: {
      runId,
      runRevision: 0,
      attempt: 1,
      sessionId: 'session-durable-gate-c4',
      actionId: executionActionBinding.actionId,
      actionBindingSha256: controlRecordDigest(executionActionBinding),
      sourceOrigin: executionActionBinding.sourceOrigin,
      destinationOrigin: executionActionBinding.destinationOrigin,
    },
    decision: 'approved_and_execute',
    idempotencyKey: 'resolve-durable-gate-execute-c4',
    nonce: 'nonce-durable-gate-execute-c4',
    expiresAt,
  })
  assert.equal(resolvedExecution.status, 'approved')
  assert.equal(resolvedExecution.resolution?.schemaVersion, 'approval-binding/v2')
  assert.equal(resolvedExecution.resolution?.decision, 'approved_and_execute')
  assert.equal(await gate.resolveLive(executionApprovalId, 'approved_and_execute'), true)
  assert.equal(await executionDecisionPromise, 'approve_and_execute')
  assert.equal((await runs.get(runId))?.state, 'running')

  const informationPromise = gate.requestInfo({
    field: 'contact_email',
    question: 'Which contact email should be used in the draft?',
    options: ['work@example.com', 'personal@example.com'],
    currentUrl: 'https://fixture.example/review',
  })
  await until(async () => Boolean((await runs.get(runId))?.pendingContinuation))
  const waitingForInformation = await runs.get(runId)
  assert.equal(waitingForInformation?.state, 'blocked_on_human')
  assert.equal(waitingForInformation?.pendingContinuation?.status, 'pending')
  assert.equal(waitingForInformation?.pendingContinuation?.question.field, 'contact_email')
  assert.equal(waitingForInformation?.pendingContinuation?.environment?.url, 'https://fixture.example/review')

  const continuationId = waitingForInformation?.pendingContinuation?.continuationId
  assert(continuationId)
  const answered = await runs.answerContinuation(runId, {
    continuationId,
    answer: 'work@example.com',
    intentPatch: 'Use this address only in the draft; do not submit.',
    idempotencyKey: 'answer-durable-gate-c4',
    expectedRecordRevision: waitingForInformation.recordRevision,
    expectedRunRevision: 0,
    expectedAttempt: 1,
  })
  assert.equal(answered.changed, true)
  assert.equal(answered.record.pendingContinuation?.status, 'answered')
  assert.equal(await gate.resolveInformationLive(continuationId), true)
  assert.deepEqual(await informationPromise, {
    answer: 'work@example.com',
    intentPatch: 'Use this address only in the draft; do not submit.',
  })
  const continued = await runs.get(runId)
  assert.equal(continued?.state, 'running')
  assert.equal(continued?.runRevision, 0, 'live information continuation stays in the same fenced attempt')
  assert.equal(continued?.pendingContinuation, undefined)
  assert.equal(continued?.lastResumeCapsule?.continuationId, continuationId)
  assert.equal(continued?.lastResumeCapsule?.reobserveRequired, true)
  assert.equal(continued?.lastResumeCapsule?.staleBrowserRefsInvalid, true)
  assert.equal(continued?.lastResumeCapsule?.priorApprovalsInvalid, true)
  assert.equal(await gate.resolveInformationLive(continuationId), false)

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
