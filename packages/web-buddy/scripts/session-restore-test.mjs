#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendJsonLine, FileSessionRecorder, FileSessionStore, restoreSessionState } from '../dist/session/index.js'
import {
  answerPendingContinuation,
  createPendingContinuation,
  createResumeCapsule,
} from '../dist/control/index.js'
import { ActionLedger } from '../dist/task/action-ledger.js'

const root = mkdtempSync(join(tmpdir(), 'mfa-session-restore-'))

try {
  const store = new FileSessionStore({ rootDir: root })
  const session = await store.create({
    sessionId: 'restore-test-session',
    runId: 'restore-test-run',
    source: 'test',
    goal: 'Verify session restore from transcript.',
    mode: 'test',
    now: '2026-06-30T00:00:00.000Z',
  })
  const recorder = new FileSessionRecorder(store, session)

  await recorder.updateStatus('blocked', {
    blockedReason: 'Waiting for user confirmation.',
    updatedAt: '2026-06-30T00:00:01.000Z',
  })
  const blockedSession = await store.get(session.sessionId)
  assert(blockedSession, 'blocked session should be saved')
  const savedBeforeRestore = readFileSync(join(blockedSession.outputDir, 'session.json'), 'utf8')

  const oldWorkflowState = {
    schemaVersion: 'workflow-state/v1',
    phase: 'in_target_flow',
    observationPhase: 'in_target_flow',
    confidence: 'medium',
    reason: 'Reviewing the application.',
    updatedAt: '2026-06-30T00:00:02.000Z',
  }
  const latestWorkflowState = {
    schemaVersion: 'workflow-state/v1',
    phase: 'done',
    observationPhase: 'done',
    confidence: 'high',
    reason: 'Agent reported completion.',
    updatedAt: '2026-06-30T00:00:06.000Z',
  }
  const pageEvidence = {
    schemaVersion: 'workflow-evidence/v1',
    id: 'restore-page-evidence',
    kind: 'page',
    summary: 'Application review page was observed.',
    source: 'session-restore-test',
    confidence: 'high',
    ts: '2026-06-30T00:00:03.000Z',
    phase: 'in_target_flow',
  }
  const toolEvidence = {
    schemaVersion: 'workflow-evidence/v1',
    id: 'restore-tool-evidence',
    kind: 'tool_result',
    summary: 'agent_done reported the task as complete.',
    source: 'session-restore-test',
    confidence: 'medium',
    ts: '2026-06-30T00:00:07.000Z',
    phase: 'done',
  }
  const oldMissingCriterion = {
    id: 'old-missing-form-evidence',
    kind: 'evidence_required',
    description: 'Old evaluation should be replaced by the latest one.',
    phase: 'in_target_flow',
    evidenceKinds: ['form'],
    missingEvidenceKinds: ['form'],
    evidenceIds: [],
    reason: 'Old missing criterion.',
  }
  const latestMissingCriterion = {
    id: 'done-requires-explicit-completion-evidence',
    kind: 'evidence_required',
    description: 'The done phase must be supported by explicit completion evidence.',
    phase: 'done',
    evidenceKinds: ['tool_result', 'user_confirm'],
    missingEvidenceKinds: ['user_confirm'],
    evidenceIds: ['restore-tool-evidence'],
    reason: 'Missing required evidence: user_confirm.',
  }
  const latestBlocker = {
    id: 'missing-evidence-done-requires-explicit-completion-evidence',
    kind: 'missing_evidence',
    message: 'Missing required evidence: user_confirm.',
    phase: 'done',
    criterionId: 'done-requires-explicit-completion-evidence',
    missingEvidenceKinds: ['user_confirm'],
    evidenceIds: ['restore-tool-evidence'],
  }
  const gateFallbackCriterion = {
    id: 'gate-only-missing-user-confirm',
    kind: 'evidence_required',
    description: 'Gate fallback criterion.',
    phase: 'done',
    evidenceKinds: ['user_confirm'],
    missingEvidenceKinds: ['user_confirm'],
    evidenceIds: [],
    reason: 'Gate missing criterion should only be used when no evaluation criteria exist.',
  }
  const gateFallbackBlocker = {
    id: 'gate-only-blocker',
    kind: 'missing_evidence',
    message: 'Gate fallback blocker.',
    phase: 'done',
    missingEvidenceKinds: ['user_confirm'],
    evidenceIds: [],
  }

  await recorder.transcript({ type: 'user_message', content: 'Please continue this application.' })
  await recorder.transcript({ type: 'assistant_message', content: 'I will inspect the current page.' })
  await recorder.transcript({
    type: 'tool_call',
    toolCallId: 'call_restore_snapshot',
    name: 'browser_snapshot',
    args: { includeText: true },
  })
  await recorder.transcript({
    type: 'tool_result',
    toolCallId: 'call_restore_snapshot',
    name: 'browser_snapshot',
    ok: true,
    result: { observation: 'Application review page is visible.' },
  })
  await recorder.transcript({ type: 'workflow_snapshot', workflowState: oldWorkflowState })
  await recorder.transcript({ type: 'workflow_evidence', evidence: pageEvidence })
  await recorder.transcript({
    type: 'workflow_evaluation',
    evaluation: {
      state: oldWorkflowState,
      changed: true,
      matchedCriteria: [],
      missingCriteria: [oldMissingCriterion],
      blockers: [],
      evidenceIds: ['restore-page-evidence'],
      reason: 'Old evaluation.',
    },
  })
  await recorder.transcript({
    type: 'completion_gate',
    decision: {
      schemaVersion: 'completion-gate-decision/v1',
      action: 'block',
      recommendedStatus: 'blocked',
      reason: 'Old gate decision.',
      missingCriteria: [oldMissingCriterion],
      blockers: [],
      workflowPhase: 'in_target_flow',
      evidenceIds: ['restore-page-evidence'],
    },
  })
  await recorder.transcript({ type: 'workflow_snapshot', workflowState: latestWorkflowState })
  await recorder.transcript({ type: 'workflow_evidence', evidence: toolEvidence })
  await recorder.transcript({
    type: 'workflow_evaluation',
    evaluation: {
      state: latestWorkflowState,
      changed: true,
      matchedCriteria: [],
      missingCriteria: [latestMissingCriterion],
      blockers: [latestBlocker],
      evidenceIds: ['restore-tool-evidence'],
      reason: 'Latest evaluation.',
    },
  })
  await recorder.transcript({
    type: 'completion_gate',
    decision: {
      schemaVersion: 'completion-gate-decision/v1',
      action: 'block',
      recommendedStatus: 'blocked',
      reason: 'Latest gate decision.',
      missingCriteria: [gateFallbackCriterion],
      blockers: [gateFallbackBlocker],
      workflowPhase: 'done',
      observationPhase: 'done',
      evidenceIds: ['restore-tool-evidence'],
    },
  })
  await recorder.transcript({
    type: 'final_result',
    status: 'completed',
    result: { summary: 'Old final result.' },
  })
  await recorder.transcript({
    type: 'final_result',
    status: 'blocked',
    reason: 'Latest final result is blocked pending user confirmation.',
  })
  await appendJsonLine(session.transcriptPath, {
    sessionId: session.sessionId,
    runId: session.runId,
    entryId: 'legacy-versionless-memory',
    ts: '2026-06-30T00:00:08.000Z',
    type: 'memory_snapshot',
    memory: { note: 'A versionless legacy v1 record remains migratable.' },
  })
  const continuationContract = {
    schemaVersion: 'web-task-contract/v1',
    contractId: 'restore-continuation-contract',
    revision: 0,
    criteria: [{
      id: 'restore-draft-only',
      kind: 'action_boundary',
      description: 'Do not submit the restored task',
      actionKinds: ['submit'],
      outcome: 'not_performed',
    }],
  }
  const pendingContinuation = createPendingContinuation({
    runId: session.runId,
    runRevision: 0,
    attempt: 1,
    sessionId: session.sessionId,
    goal: session.goal,
    goalRevision: 0,
    contract: continuationContract,
    field: 'contact_email',
    question: 'Which contact email should be used?',
    currentUrl: 'https://fixture.example/review',
    now: '2026-06-30T00:00:09.000Z',
  })
  const resumeCapsule = createResumeCapsule(
    answerPendingContinuation(pendingContinuation, {
      answer: 'resume@example.com',
      intentPatch: 'Continue the draft but do not submit it.',
      answeredAt: '2026-06-30T00:00:10.000Z',
    }),
    { runRevision: 1, attempt: 2 },
    '2026-06-30T00:00:11.000Z',
  )
  await recorder.transcript({
    type: 'user_continuation',
    continuationId: resumeCapsule.continuationId,
    questionId: resumeCapsule.answeredQuestion.questionId,
    field: resumeCapsule.answeredQuestion.field,
    answer: resumeCapsule.answeredQuestion.answer,
    intentPatch: resumeCapsule.intentPatch,
    capsule: resumeCapsule,
  })
  await recorder.event({
    type: 'action_ledger_updated',
    data: {
      entry: {
        schemaVersion: 'action-ledger-entry/v1',
        sequence: 1,
        actionId: 'turn_001:submit_call',
        actionKind: 'submit',
        toolName: 'browser_click',
        status: 'proposed',
        recordedAt: '2026-06-30T00:00:12.000Z',
      },
    },
  })
  await recorder.event({
    type: 'action_ledger_updated',
    data: {
      entry: {
        schemaVersion: 'action-ledger-entry/v1',
        sequence: 2,
        actionId: 'turn_001:submit_call',
        actionKind: 'submit',
        toolName: 'browser_click',
        status: 'authorized',
        recordedAt: '2026-06-30T00:00:13.000Z',
      },
    },
  })

  const restored = await restoreSessionState({
    store,
    sessionId: session.sessionId,
    now: '2026-06-30T00:01:00.000Z',
  })

  assert.equal(restored.schemaVersion, 'restored-session-state/v1')
  assert.equal(restored.session.sessionId, session.sessionId)
  assert.equal(restored.session.status, 'blocked')
  assert.equal(restored.transcriptCount, 16)
  assert.equal(restored.restoredAt, '2026-06-30T00:01:00.000Z')
  assert.equal(restored.migrationWarnings.length, 0)
  assert.equal(restored.latestWorkflowState?.phase, 'done')
  assert.equal(restored.latestWorkflowState?.observationPhase, 'done')
  assert.equal(restored.latestWorkflowEvaluation?.state.observationPhase, 'done')
  assert.equal(restored.latestCompletionGate?.observationPhase, 'done')
  assert.equal(restored.latestWorkflowEvaluation?.reason, 'Latest evaluation.')
  assert.equal(restored.latestCompletionGate?.reason, 'Latest gate decision.')
  assert.equal(restored.latestFinalResult?.status, 'blocked')
  assert.deepEqual(
    restored.workflowEvidence.map((evidence) => evidence.id),
    ['restore-page-evidence', 'restore-tool-evidence'],
  )
  assert.deepEqual(restored.missingCriteria, [latestMissingCriterion])
  assert.deepEqual(restored.blockers, [latestBlocker])
  assert.deepEqual(
    restored.restoredMessages.map((message) => message.role),
    ['user', 'assistant', 'assistant', 'tool', 'user'],
  )
  assert.equal(restored.restoredMessages[2].tool_calls?.[0]?.function.name, 'browser_snapshot')
  assert.equal(restored.restoredMessages[3].tool_call_id, 'call_restore_snapshot')
  assert.match(restored.restoredMessages[4].content, /DURABLE_CONTINUATION_RESUME/)
  assert.match(restored.restoredMessages[4].content, /current page observation is authoritative/i)
  assert.equal(restored.latestResumeCapsule?.continuationId, resumeCapsule.continuationId)
  assert.equal(restored.latestResumeCapsule?.target.runRevision, 1)
  assert.deepEqual(
    restored.actionLedgerEntries.map((entry) => entry.status),
    ['proposed', 'authorized'],
  )
  const restoredActionLedger = ActionLedger.restore(restored.actionLedgerEntries)
  assert.equal(restoredActionLedger.latest('turn_001:submit_call')?.status, 'authorized')
  assert.deepEqual(restoredActionLedger.outcomes(['submit']), [{
    actionKind: 'submit',
    outcome: 'not_performed',
  }, {
    actionKind: 'submit',
    outcome: 'approved',
    actionId: 'turn_001:submit_call',
  }])

  const restoredFromSessionObject = await restoreSessionState({
    session: blockedSession,
    now: '2026-06-30T00:02:00.000Z',
  })
  assert.equal(restoredFromSessionObject.restoredAt, '2026-06-30T00:02:00.000Z')
  assert.deepEqual(restoredFromSessionObject.missingCriteria, [latestMissingCriterion])

  const restoredFromDirectSession = await restoreSessionState(blockedSession)
  assert.equal(restoredFromDirectSession.session.sessionId, session.sessionId)
  assert.equal(restoredFromDirectSession.latestWorkflowState?.phase, 'done')
  assert.equal(restoredFromDirectSession.latestWorkflowState?.observationPhase, 'done')

  const savedAfterRestore = readFileSync(join(blockedSession.outputDir, 'session.json'), 'utf8')
  assert.equal(savedAfterRestore, savedBeforeRestore, 'restoreSessionState should not write or mutate the session')

  const fallbackSession = await store.create({
    sessionId: 'restore-gate-fallback-session',
    runId: 'restore-gate-fallback-run',
    source: 'test',
    goal: 'Verify completion gate fallback.',
    mode: 'test',
    now: '2026-06-30T00:03:00.000Z',
  })
  const fallbackRecorder = new FileSessionRecorder(store, fallbackSession)
  await fallbackRecorder.transcript({ type: 'workflow_snapshot', workflowState: latestWorkflowState })
  await fallbackRecorder.transcript({
    type: 'completion_gate',
    decision: {
      schemaVersion: 'completion-gate-decision/v1',
      action: 'block',
      recommendedStatus: 'blocked',
      reason: 'Gate fallback decision.',
      missingCriteria: [gateFallbackCriterion],
      blockers: [gateFallbackBlocker],
      workflowPhase: 'done',
      evidenceIds: [],
    },
  })

  const fallbackRestored = await restoreSessionState({
    store,
    sessionId: fallbackSession.sessionId,
    now: '2026-06-30T00:04:00.000Z',
  })
  assert.equal(fallbackRestored.latestWorkflowEvaluation, undefined)
  assert.deepEqual(fallbackRestored.missingCriteria, [gateFallbackCriterion])
  assert.deepEqual(fallbackRestored.blockers, [gateFallbackBlocker])

  const corruptLedgerSession = await store.create({
    sessionId: 'restore-corrupt-ledger-session',
    runId: 'restore-corrupt-ledger-run',
    source: 'test',
    goal: 'Reject a corrupt durable action ledger.',
    mode: 'test',
    now: '2026-06-30T00:05:00.000Z',
  })
  const corruptLedgerRecorder = new FileSessionRecorder(store, corruptLedgerSession)
  await corruptLedgerRecorder.event({
    type: 'action_ledger_updated',
    data: {
      entry: {
        schemaVersion: 'action-ledger-entry/v1',
        sequence: 1,
        actionId: 'corrupt-action',
        actionKind: 'submit',
        toolName: 'browser_click',
        status: 'forged_performed',
        recordedAt: '2026-06-30T00:05:01.000Z',
      },
    },
  })
  await assert.rejects(
    restoreSessionState({ session: corruptLedgerSession }),
    /invalid action ledger event/i,
    'corrupt action history must fail closed instead of being forgotten during resume',
  )

  await appendJsonLine(session.transcriptPath, {
    version: 99,
    sessionId: session.sessionId,
    runId: session.runId,
    entryId: 'unknown-version-tool-call',
    ts: '2026-06-30T00:00:09.000Z',
    type: 'tool_call',
    toolCallId: 'must-not-restore',
    name: 'browser_click',
    args: { ref: 'e-danger', confirmed: true },
  })
  await assert.rejects(
    restoreSessionState({ store, sessionId: session.sessionId }),
    /UNSUPPORTED_TRANSCRIPT_ENTRY_VERSION/,
    'an explicit future transcript schema must never be interpreted as executable v1 history',
  )

  console.log('session-restore-test: PASS')
} finally {
  rmSync(root, { recursive: true, force: true })
}
