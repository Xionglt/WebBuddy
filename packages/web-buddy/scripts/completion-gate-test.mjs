#!/usr/bin/env node
import assert from 'node:assert/strict'
import { CompletionGate } from '../dist/workflow/completion-gate.js'

const ignoredNotDone = CompletionGate.evaluate({
  done: false,
  blocked: false,
  workflowEvaluation: evaluation({ phase: 'done' }),
  source: 'agent_done',
})
assert.equal(ignoredNotDone.schemaVersion, 'completion-gate-decision/v1')
assert.equal(ignoredNotDone.action, 'ignore')
assert.equal(ignoredNotDone.recommendedStatus, 'unchanged')

const blockedRuntime = CompletionGate.evaluate({
  done: true,
  blocked: true,
  workflowEvaluation: evaluation({ phase: 'done' }),
  source: 'agent_done',
})
assert.equal(blockedRuntime.action, 'block')
assert.equal(blockedRuntime.recommendedStatus, 'blocked')

const ignoredWithoutEvaluation = CompletionGate.evaluate({
  done: true,
  blocked: false,
  source: 'agent_done',
})
assert.equal(ignoredWithoutEvaluation.action, 'ignore')
assert.equal(ignoredWithoutEvaluation.recommendedStatus, 'unchanged')

const blockedReadyForFinalSubmit = CompletionGate.evaluate({
  done: true,
  blocked: false,
  workflowEvaluation: evaluation({ phase: 'ready_for_final_submit' }),
  source: 'agent_done',
})
assert.equal(blockedReadyForFinalSubmit.action, 'block')
assert.equal(blockedReadyForFinalSubmit.recommendedStatus, 'blocked')
assert.equal(blockedReadyForFinalSubmit.workflowPhase, 'ready_for_final_submit')
assert.match(blockedReadyForFinalSubmit.reason, /final submit/i)

const blockedDirectSubmitReview = CompletionGate.evaluate({
  done: true,
  blocked: false,
  workflowEvaluation: evaluation({ phase: 'direct_submit_review' }),
  source: 'agent_done',
})
assert.equal(blockedDirectSubmitReview.action, 'block')
assert.equal(blockedDirectSubmitReview.recommendedStatus, 'blocked')
assert.equal(blockedDirectSubmitReview.workflowPhase, 'direct_submit_review')
assert.match(blockedDirectSubmitReview.reason, /direct-submit review/i)

const blockedByFinalSubmitBlocker = CompletionGate.evaluate({
  done: true,
  blocked: false,
  workflowEvaluation: evaluation({
    phase: 'done',
    blockers: [finalSubmitBlocker()],
  }),
  source: 'agent_done',
})
assert.equal(blockedByFinalSubmitBlocker.action, 'block')
assert.equal(blockedByFinalSubmitBlocker.recommendedStatus, 'blocked')
assert.equal(blockedByFinalSubmitBlocker.blockers[0].gateKind, 'final_submit')
assert.match(blockedByFinalSubmitBlocker.reason, /final-submit blocker/i)

const blockedMissingUserConfirm = CompletionGate.evaluate({
  done: true,
  blocked: false,
  workflowEvaluation: evaluation({
    phase: 'done',
    missingCriteria: [missingUserConfirmCriterion()],
  }),
  source: 'agent_done',
})
assert.equal(blockedMissingUserConfirm.action, 'block')
assert.equal(blockedMissingUserConfirm.recommendedStatus, 'blocked')
assert.deepEqual(blockedMissingUserConfirm.missingCriteria[0].missingEvidenceKinds, ['user_confirm'])
assert.match(blockedMissingUserConfirm.reason, /required workflow evidence is missing/i)

const allowedDone = CompletionGate.evaluate({
  done: true,
  blocked: false,
  workflowEvaluation: evaluation({
    phase: 'done',
    evidenceIds: ['ev-tool-done', 'ev-user-confirm'],
  }),
  source: 'agent_done',
})
assert.equal(allowedDone.action, 'allow')
assert.equal(allowedDone.recommendedStatus, 'completed')
assert.equal(allowedDone.workflowPhase, 'done')
assert.deepEqual(allowedDone.missingCriteria, [])
assert.deepEqual(allowedDone.blockers, [])
assert.deepEqual(allowedDone.evidenceIds, ['ev-tool-done', 'ev-user-confirm'])

console.log('completion-gate-test: PASS')

function evaluation(overrides = {}) {
  const phase = overrides.phase ?? 'done'
  return {
    state: workflowState(phase),
    changed: false,
    matchedCriteria: [],
    missingCriteria: overrides.missingCriteria ?? [],
    blockers: overrides.blockers ?? [],
    evidenceIds: overrides.evidenceIds ?? [],
    reason: 'Minimal completion gate test evaluation.',
  }
}

function workflowState(phase) {
  return {
    schemaVersion: 'workflow-state/v1',
    phase,
    confidence: 'high',
    reason: `Test workflow phase is ${phase}.`,
    updatedAt: '2026-06-30T00:00:00.000Z',
  }
}

function missingUserConfirmCriterion() {
  return {
    id: 'done-requires-explicit-completion-evidence',
    kind: 'phase_required_evidence',
    evidenceKinds: ['tool_result', 'user_confirm'],
    missingEvidenceKinds: ['user_confirm'],
    evidenceIds: ['ev-tool-done'],
  }
}

function finalSubmitBlocker() {
  return {
    kind: 'human_handoff',
    gateKind: 'final_submit',
    message: 'Final submit requires human takeover.',
    evidenceIds: ['ev-policy-final-submit'],
  }
}
