#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileSessionRecorder, FileSessionStore, restoreSessionState } from '../dist/session/index.js'

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
    phase: 'reviewing',
    confidence: 'medium',
    reason: 'Reviewing the application.',
    updatedAt: '2026-06-30T00:00:02.000Z',
  }
  const latestWorkflowState = {
    schemaVersion: 'workflow-state/v1',
    phase: 'done',
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
    phase: 'reviewing',
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
    phase: 'reviewing',
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
      workflowPhase: 'reviewing',
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

  const restored = await restoreSessionState({
    store,
    sessionId: session.sessionId,
    now: '2026-06-30T00:01:00.000Z',
  })

  assert.equal(restored.schemaVersion, 'restored-session-state/v1')
  assert.equal(restored.session.sessionId, session.sessionId)
  assert.equal(restored.session.status, 'blocked')
  assert.equal(restored.transcriptCount, 10)
  assert.equal(restored.restoredAt, '2026-06-30T00:01:00.000Z')
  assert.equal(restored.latestWorkflowState?.phase, 'done')
  assert.equal(restored.latestWorkflowEvaluation?.reason, 'Latest evaluation.')
  assert.equal(restored.latestCompletionGate?.reason, 'Latest gate decision.')
  assert.equal(restored.latestFinalResult?.status, 'blocked')
  assert.deepEqual(
    restored.workflowEvidence.map((evidence) => evidence.id),
    ['restore-page-evidence', 'restore-tool-evidence'],
  )
  assert.deepEqual(restored.missingCriteria, [latestMissingCriterion])
  assert.deepEqual(restored.blockers, [latestBlocker])

  const restoredFromSessionObject = await restoreSessionState({
    session: blockedSession,
    now: '2026-06-30T00:02:00.000Z',
  })
  assert.equal(restoredFromSessionObject.restoredAt, '2026-06-30T00:02:00.000Z')
  assert.deepEqual(restoredFromSessionObject.missingCriteria, [latestMissingCriterion])

  const restoredFromDirectSession = await restoreSessionState(blockedSession)
  assert.equal(restoredFromDirectSession.session.sessionId, session.sessionId)
  assert.equal(restoredFromDirectSession.latestWorkflowState?.phase, 'done')

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

  console.log('session-restore-test: PASS')
} finally {
  rmSync(root, { recursive: true, force: true })
}
