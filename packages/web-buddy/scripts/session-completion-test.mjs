#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  confirmSessionCompletion,
  FileSessionRecorder,
  FileSessionStore,
  readJsonLines,
} from '../dist/session/index.js'

const root = mkdtempSync(join(tmpdir(), 'mfa-session-completion-'))
const now = '2026-06-30T12:00:00.000Z'

try {
  const store = new FileSessionStore({ rootDir: root })

  const doneSession = await createBlockedDoneSession(store, {
    sessionId: 'session-completion-done',
    runId: 'session-completion-done-run',
  })
  const completed = await confirmSessionCompletion({
    store,
    sessionId: doneSession.sessionId,
    message: 'I reviewed the workflow result and confirm it is complete.',
    confirmedBy: 'user',
    now,
  })

  assert.equal(completed.schemaVersion, 'confirm-session-completion-result/v1')
  assert.equal(completed.status, 'completed')
  assert.equal(completed.completion.completionGateDecision.action, 'allow')
  assert.equal(completed.completion.completionGateDecision.recommendedStatus, 'completed')
  assert.equal(completed.confirmation.evidence.kind, 'user_confirm')
  assert.equal(completed.confirmation.evidence.ts, now)
  assert.equal(completed.confirmation.workflowPhase, 'done')

  const savedCompleted = JSON.parse(readFileSync(join(doneSession.outputDir, 'session.json'), 'utf8'))
  assert.equal(savedCompleted.status, 'completed')
  assert.equal(savedCompleted.updatedAt, now)
  assert.equal(savedCompleted.completedAt, now)
  assert.equal('blockedReason' in savedCompleted, false)

  const completedTranscript = await readJsonLines(doneSession.transcriptPath)
  assert.deepEqual(completedTranscript.map((entry) => entry.type), [
    'workflow_snapshot',
    'workflow_evidence',
    'workflow_evaluation',
    'completion_gate',
    'final_result',
    'user_confirmation',
    'workflow_evidence',
    'workflow_evaluation',
    'completion_gate',
    'final_result',
  ])
  const completedConfirmationEntry = completedTranscript.find((entry) => entry.type === 'user_confirmation')
  assert.equal(completedConfirmationEntry.confirmation.id, completed.confirmation.id)
  const completedEvidenceEntries = completedTranscript.filter((entry) => entry.type === 'workflow_evidence')
  assert.deepEqual(
    completedEvidenceEntries.map((entry) => entry.evidence.id),
    ['ev-session-completion-agent-done', completed.confirmation.evidence.id],
    'session completion should append only the new user_confirm evidence',
  )
  const completedEvaluation = completedTranscript
    .filter((entry) => entry.type === 'workflow_evaluation')
    .at(-1)
  assert.equal(completedEvaluation.evaluation.state.phase, 'done')
  assert.equal(completedEvaluation.evaluation.missingCriteria.length, 0)
  const completedGate = completedTranscript.filter((entry) => entry.type === 'completion_gate').at(-1)
  assert.equal(completedGate.decision.action, 'allow')
  const completedFinal = completedTranscript.filter((entry) => entry.type === 'final_result').at(-1)
  assert.equal(completedFinal.status, 'completed')
  assert.equal(completedFinal.result.confirmationId, completed.confirmation.id)
  assert.equal(completedFinal.result.completionGate.action, 'allow')

  const completedEvents = await readJsonLines(doneSession.eventsPath)
  assert.deepEqual(
    completedEvents.map((event) => event.type),
    ['session_created', 'session_restored', 'user_confirmed', 'session_completion_rechecked'],
  )
  const restoredEvent = completedEvents.find((event) => event.type === 'session_restored')
  assert.equal(restoredEvent.data.sessionStatus, 'blocked')
  assert.equal(restoredEvent.data.workflowPhase, 'done')
  assert.equal(restoredEvent.data.workflowEvidenceCount, 1)
  const userConfirmedEvent = completedEvents.find((event) => event.type === 'user_confirmed')
  assert.equal(userConfirmedEvent.data.confirmationId, completed.confirmation.id)
  assert.equal(userConfirmedEvent.data.evidenceId, completed.confirmation.evidence.id)
  const completedRecheckedEvent = completedEvents.find((event) => event.type === 'session_completion_rechecked')
  assert.equal(completedRecheckedEvent.data.status, 'completed')
  assert.equal(completedRecheckedEvent.data.confirmationId, completed.confirmation.id)
  assert.equal(completedRecheckedEvent.data.evidenceId, completed.confirmation.evidence.id)
  assert.equal(completedRecheckedEvent.data.action, 'allow')
  assert.equal(completedRecheckedEvent.data.completionGateAction, 'allow')
  assert.equal(completedRecheckedEvent.data.recommendedStatus, 'completed')
  assert.equal(completedRecheckedEvent.data.workflowPhase, 'done')

  const finalSubmitSession = await createFinalSubmitBlockedSession(store, {
    sessionId: 'session-completion-final-submit',
    runId: 'session-completion-final-submit-run',
  })
  const blocked = await confirmSessionCompletion({
    store,
    sessionId: finalSubmitSession.sessionId,
    message: 'I confirm the form is ready, but I did not submit it.',
    confirmedBy: 'user',
    now,
  })

  assert.equal(blocked.status, 'blocked')
  assert.equal(blocked.completion.completionGateDecision.action, 'block')
  assert.equal(blocked.completion.completionGateDecision.recommendedStatus, 'blocked')
  assert.equal(blocked.completion.completionGateDecision.workflowPhase, 'ready_for_final_submit')
  assert.match(blocked.reason, /final submit/i)
  assert(
    blocked.completion.completionGateDecision.blockers.some((blocker) => blocker.gateKind === 'final_submit'),
    'final-submit blocker should remain after user confirmation',
  )

  const savedBlocked = JSON.parse(readFileSync(join(finalSubmitSession.outputDir, 'session.json'), 'utf8'))
  assert.equal(savedBlocked.status, 'blocked')
  assert.match(savedBlocked.blockedReason, /final submit/i)
  const blockedTranscript = await readJsonLines(finalSubmitSession.transcriptPath)
  const blockedFinal = blockedTranscript.filter((entry) => entry.type === 'final_result').at(-1)
  assert.equal(blockedFinal.status, 'blocked')
  assert.equal(blockedFinal.result.completionGate.action, 'block')
  const blockedRecheckedEvent = (await readJsonLines(finalSubmitSession.eventsPath)).find(
    (event) => event.type === 'session_completion_rechecked',
  )
  assert.equal(blockedRecheckedEvent.data.completionGateAction, 'block')
  assert.equal(blockedRecheckedEvent.data.action, 'block')
  assert.equal(blockedRecheckedEvent.data.recommendedStatus, 'blocked')
  assert(
    blockedRecheckedEvent.data.blockers.some((blocker) => blocker.gateKind === 'final_submit'),
    'session_completion_rechecked should expose final-submit blockers',
  )

  const failedSession = await store.create({
    sessionId: 'session-completion-failed',
    runId: 'session-completion-failed-run',
    source: 'test',
    goal: 'Verify failed sessions are not silently completed.',
    now,
  })
  const failedRecorder = new FileSessionRecorder(store, failedSession)
  await failedRecorder.updateStatus('failed', {
    error: 'Synthetic failure.',
    updatedAt: now,
    completedAt: now,
  })
  const failedTranscriptBefore = await readJsonLines(failedSession.transcriptPath)
  const failedEventsBefore = await readJsonLines(failedSession.eventsPath)

  await assert.rejects(
    () =>
      confirmSessionCompletion({
        store,
        sessionId: failedSession.sessionId,
        message: 'I confirm this should not be silently completed.',
        confirmedBy: 'user',
        now,
      }),
    /failed session/i,
  )

  const savedFailed = JSON.parse(readFileSync(join(failedSession.outputDir, 'session.json'), 'utf8'))
  assert.equal(savedFailed.status, 'failed')
  assert.equal((await readJsonLines(failedSession.transcriptPath)).length, failedTranscriptBefore.length)
  assert.equal((await readJsonLines(failedSession.eventsPath)).length, failedEventsBefore.length)

  const abortedSession = await store.create({
    sessionId: 'session-completion-aborted',
    runId: 'session-completion-aborted-run',
    source: 'test',
    goal: 'Verify aborted sessions are not silently completed.',
    now,
  })
  const abortedRecorder = new FileSessionRecorder(store, abortedSession)
  await abortedRecorder.updateStatus('aborted', {
    error: 'Synthetic abort.',
    updatedAt: now,
    completedAt: now,
  })
  const abortedTranscriptBefore = await readJsonLines(abortedSession.transcriptPath)
  const abortedEventsBefore = await readJsonLines(abortedSession.eventsPath)

  await assert.rejects(
    () =>
      confirmSessionCompletion({
        store,
        sessionId: abortedSession.sessionId,
        message: 'I confirm this should not be silently completed.',
        confirmedBy: 'user',
        now,
      }),
    /aborted session/i,
  )

  const savedAborted = JSON.parse(readFileSync(join(abortedSession.outputDir, 'session.json'), 'utf8'))
  assert.equal(savedAborted.status, 'aborted')
  assert.equal((await readJsonLines(abortedSession.transcriptPath)).length, abortedTranscriptBefore.length)
  assert.equal((await readJsonLines(abortedSession.eventsPath)).length, abortedEventsBefore.length)

  console.log('session-completion-test: PASS')
} finally {
  rmSync(root, { recursive: true, force: true })
}

async function createBlockedDoneSession(store, ids) {
  const session = await store.create({
    sessionId: ids.sessionId,
    runId: ids.runId,
    source: 'test',
    goal: 'Verify session completion from blocked done state.',
    mode: 'test',
    now,
  })
  const recorder = new FileSessionRecorder(store, session)
  await recorder.updateStatus('blocked', {
    blockedReason: 'Waiting for user confirmation.',
    updatedAt: now,
    completedAt: now,
  })

  const state = workflowState('done', 'Agent reported completion without a blocker.')
  const evidence = {
    schemaVersion: 'workflow-evidence/v1',
    id: 'ev-session-completion-agent-done',
    kind: 'tool_result',
    summary: 'agent_done reported the workflow as complete.',
    source: 'agent_done',
    confidence: 'medium',
    ts: now,
    phase: 'done',
    sessionId: session.sessionId,
    runId: session.runId,
    data: {
      observation: 'agent_done: Workflow complete.',
      pageChanged: false,
      done: true,
      data: { blocked: false },
    },
  }
  const missingCriterion = {
    id: 'done-requires-explicit-completion-evidence',
    kind: 'evidence_required',
    description: 'The done phase must be supported by explicit completion evidence.',
    phase: 'done',
    evidenceKinds: ['tool_result', 'user_confirm'],
    missingEvidenceKinds: ['user_confirm'],
    evidenceIds: [evidence.id],
    reason: 'Missing required evidence: user_confirm.',
  }
  const blocker = {
    id: 'missing-evidence-done-requires-explicit-completion-evidence',
    kind: 'missing_evidence',
    message: 'Missing required evidence: user_confirm.',
    phase: 'done',
    criterionId: missingCriterion.id,
    missingEvidenceKinds: ['user_confirm'],
    evidenceIds: [evidence.id],
  }

  await recorder.transcript({ type: 'workflow_snapshot', workflowState: state })
  await recorder.transcript({ type: 'workflow_evidence', evidence })
  await recorder.transcript({
    type: 'workflow_evaluation',
    evaluation: {
      state,
      changed: true,
      matchedCriteria: [],
      missingCriteria: [missingCriterion],
      blockers: [blocker],
      evidenceIds: [evidence.id],
      reason: 'Missing user confirmation.',
    },
  })
  await recorder.transcript({
    type: 'completion_gate',
    decision: {
      schemaVersion: 'completion-gate-decision/v1',
      action: 'block',
      recommendedStatus: 'blocked',
      reason: 'Completion gate blocked pending user confirmation.',
      missingCriteria: [missingCriterion],
      blockers: [blocker],
      workflowPhase: 'done',
      evidenceIds: [evidence.id],
    },
  })
  await recorder.transcript({
    type: 'final_result',
    status: 'blocked',
    reason: 'Completion gate blocked pending user confirmation.',
  })

  return session
}

async function createFinalSubmitBlockedSession(store, ids) {
  const session = await store.create({
    sessionId: ids.sessionId,
    runId: ids.runId,
    source: 'test',
    goal: 'Verify session completion does not bypass final submit.',
    mode: 'test',
    now,
  })
  const recorder = new FileSessionRecorder(store, session)
  await recorder.updateStatus('blocked', {
    blockedReason: 'Final submit requires manual takeover.',
    updatedAt: now,
    completedAt: now,
  })

  const state = {
    ...workflowState('ready_for_final_submit', 'Policy identified a final-submit gate.'),
    humanHandoffRequired: true,
    blocker: 'Final submit requires manual takeover.',
  }
  const formEvidence = {
    schemaVersion: 'workflow-evidence/v1',
    id: 'ev-session-completion-form-ready',
    kind: 'form',
    summary: 'Application form is filled.',
    source: 'runtime_context',
    confidence: 'high',
    ts: now,
    phase: 'ready_for_final_submit',
    sessionId: session.sessionId,
    runId: session.runId,
  }
  const policyEvidence = {
    schemaVersion: 'workflow-evidence/v1',
    id: 'ev-session-completion-final-submit-policy',
    kind: 'policy',
    summary: 'Policy identified final submit gate.',
    source: 'policy_engine',
    confidence: 'high',
    ts: now,
    phase: 'ready_for_final_submit',
    sessionId: session.sessionId,
    runId: session.runId,
    data: {
      action: 'gate',
      riskLevel: 'high',
      gateKind: 'final_submit',
      policyCode: 'policy.final_submit.manual',
      ruleId: 'policy.final_submit.manual.v1',
    },
  }
  const finalSubmitBlocker = {
    id: 'human-handoff-final-submit',
    kind: 'human_handoff',
    message: 'Final submit requires human takeover before completion.',
    phase: 'ready_for_final_submit',
    gateKind: 'final_submit',
    evidenceIds: [policyEvidence.id],
  }

  await recorder.transcript({ type: 'workflow_snapshot', workflowState: state })
  await recorder.transcript({ type: 'workflow_evidence', evidence: formEvidence })
  await recorder.transcript({ type: 'workflow_evidence', evidence: policyEvidence })
  await recorder.transcript({
    type: 'workflow_evaluation',
    evaluation: {
      state,
      changed: true,
      matchedCriteria: [],
      missingCriteria: [],
      blockers: [finalSubmitBlocker],
      evidenceIds: [formEvidence.id, policyEvidence.id],
      reason: 'Final submit requires human takeover.',
    },
  })
  await recorder.transcript({
    type: 'completion_gate',
    decision: {
      schemaVersion: 'completion-gate-decision/v1',
      action: 'block',
      recommendedStatus: 'blocked',
      reason: 'Completion gate blocked final submit.',
      missingCriteria: [],
      blockers: [finalSubmitBlocker],
      workflowPhase: 'ready_for_final_submit',
      evidenceIds: [formEvidence.id, policyEvidence.id],
    },
  })
  await recorder.transcript({
    type: 'final_result',
    status: 'blocked',
    reason: 'Final submit requires manual takeover.',
  })

  return session
}

function workflowState(phase, reason) {
  return {
    schemaVersion: 'workflow-state/v1',
    phase,
    confidence: 'high',
    reason,
    updatedAt: now,
  }
}
