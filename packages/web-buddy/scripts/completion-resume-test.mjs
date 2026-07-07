#!/usr/bin/env node
import assert from 'node:assert/strict'
import {
  CompletionResumeService,
  completionResumeService,
} from '../dist/workflow/completion-resume.js'
import { createUserConfirmation } from '../dist/session/index.js'
import { WorkflowEngine } from '../dist/workflow/workflow-engine.js'

const now = '2026-06-30T12:00:00.000Z'

class RecordingWorkflowEngine {
  constructor() {
    this.inner = new WorkflowEngine()
    this.inputs = []
  }

  evaluate(input) {
    this.inputs.push(input)
    return this.inner.evaluate(input)
  }
}

const noConfirmationEngine = new RecordingWorkflowEngine()
const noConfirmation = completionResumeService.evaluate({
  restored: restoredDoneBlocked(),
  workflowEngine: noConfirmationEngine,
  now,
})

assert.equal(noConfirmation.schemaVersion, 'completion-resume-result/v1')
assert.equal(noConfirmation.status, 'blocked')
assert.equal(noConfirmation.completionGateDecision.action, 'block')
assert.equal(noConfirmation.completionGateDecision.recommendedStatus, 'blocked')
assert.equal(noConfirmation.workflowEvaluation.state.phase, 'done')
assert(
  noConfirmation.workflowEvaluation.missingCriteria.some((criterion) =>
    criterion.id === 'done-requires-explicit-completion-evidence' &&
    criterion.missingEvidenceKinds.includes('user_confirm')
  ),
  'resume without user confirmation should keep missing user_confirm blocked',
)
assert.deepEqual(
  noConfirmation.evidence.map((evidence) => evidence.kind),
  ['tool_result'],
  'resume should not manufacture user_confirm evidence',
)
assert.equal(noConfirmationEngine.inputs.length, 1)
assert(
  noConfirmationEngine.inputs[0].recentActions.some((action) =>
    action.toolName === 'agent_done' &&
    action.toolResult?.done === true &&
    action.agentDoneBlocked === false
  ),
  'resume should pass restored agent_done/tool_result facts to WorkflowEngine',
)
assert(
  !noConfirmationEngine.inputs[0].recentActions.some((action) => action.toolName === 'user_confirm'),
  'resume should not represent user confirmation as a recent action',
)

const confirmation = createUserConfirmation({
  sessionId: 'resume-session',
  runId: 'resume-run',
  confirmedBy: 'user',
  scope: 'completion',
  message: 'I reviewed the result and confirm the workflow is complete.',
  workflowPhase: 'done',
  ts: now,
})
const withConfirmation = CompletionResumeService.evaluate({
  restored: restoredDoneBlocked(),
  confirmation,
  now,
})

assert.equal(withConfirmation.status, 'completed')
assert.equal(withConfirmation.completionGateDecision.action, 'allow')
assert.equal(withConfirmation.completionGateDecision.recommendedStatus, 'completed')
assert.equal(withConfirmation.workflowEvaluation.state.phase, 'done')
assert.equal(withConfirmation.workflowEvaluation.missingCriteria.length, 0)
assert(withConfirmation.evidence.some((evidence) => evidence.id === 'ev-tool-agent-done'))
assert(withConfirmation.evidence.some((evidence) => evidence.id === confirmation.evidence.id))
assert.deepEqual(
  withConfirmation.workflowEvaluation.evidenceIds.sort(),
  ['ev-tool-agent-done', confirmation.evidence.id].sort(),
)
assert.match(withConfirmation.reason, /resume_completion/)

const restored = restoredDoneBlocked()
const clonedResult = completionResumeService.evaluate({
  restored,
  confirmation,
  now,
})
clonedResult.evidence[0].summary = 'mutated outside service result'
assert.equal(
  restored.workflowEvidence[0].summary,
  'agent_done reported the workflow as complete.',
  'resume result evidence should be cloned from restored evidence',
)

const finalSubmit = completionResumeService.evaluate({
  restored: restoredReadyForFinalSubmit(),
  confirmation: createUserConfirmation({
    sessionId: 'resume-session',
    runId: 'resume-run',
    confirmedBy: 'user',
    scope: 'completion',
    message: 'I confirm the form is ready.',
    workflowPhase: 'final_submit_boundary',
    ts: now,
  }),
  now,
})

assert.equal(finalSubmit.status, 'blocked')
assert.equal(finalSubmit.completionGateDecision.action, 'block')
assert.equal(finalSubmit.completionGateDecision.workflowPhase, 'final_submit_boundary')
assert.match(finalSubmit.reason, /final submit/i)
assert(
  finalSubmit.completionGateDecision.blockers.some((blocker) => blocker.gateKind === 'final_submit'),
  'final-submit blocker should survive resume recheck',
)

const fallbackInitial = completionResumeService.evaluate({
  restored: restoredDoneBlocked({ latestWorkflowState: undefined }),
  confirmation,
  now,
})
assert.equal(fallbackInitial.status, 'completed')
assert.equal(fallbackInitial.workflowEvaluation.state.phase, 'done')

console.log('completion-resume-test: PASS')

function restoredDoneBlocked(overrides = {}) {
  return {
    schemaVersion: 'restored-session-state/v1',
    session: session({ status: 'blocked', blockedReason: 'Waiting for user confirmation.' }),
    transcriptCount: 5,
    restoredAt: now,
    latestWorkflowState: workflowState('done', 'Agent reported completion.'),
    workflowEvidence: [toolDoneEvidence()],
    latestFinalResult: {
      version: 1,
      sessionId: 'resume-session',
      runId: 'resume-run',
      entryId: 'final-blocked',
      ts: now,
      type: 'final_result',
      status: 'blocked',
      reason: 'Completion gate blocked pending user confirmation.',
    },
    missingCriteria: [],
    blockers: [],
    ...overrides,
  }
}

function restoredReadyForFinalSubmit() {
  const finalSubmitBlocker = {
    id: 'human-handoff-final-submit',
    kind: 'human_handoff',
    message: 'Final submit requires human takeover before completion.',
    phase: 'final_submit_boundary',
    gateKind: 'final_submit',
    evidenceIds: ['ev-policy-final-submit'],
  }

  return {
    schemaVersion: 'restored-session-state/v1',
    session: session({ status: 'blocked', blockedReason: 'Final submit requires manual takeover.' }),
    transcriptCount: 6,
    restoredAt: now,
    latestWorkflowState: {
      ...workflowState('final_submit_boundary', 'Policy identified a final-submit gate.'),
      humanHandoffRequired: true,
      blocker: 'Final submit requires human takeover before completion.',
    },
    workflowEvidence: [
      {
        schemaVersion: 'workflow-evidence/v1',
        id: 'ev-form-ready',
        kind: 'form',
        summary: 'Application form is filled.',
        source: 'runtime_context',
        confidence: 'high',
        ts: now,
        phase: 'final_submit_boundary',
      },
      {
        schemaVersion: 'workflow-evidence/v1',
        id: 'ev-policy-final-submit',
        kind: 'policy',
        summary: 'Policy identified final submit gate.',
        source: 'policy_engine',
        confidence: 'high',
        ts: now,
        phase: 'final_submit_boundary',
        data: {
          action: 'gate',
          riskLevel: 'high',
          gateKind: 'final_submit',
          policyCode: 'policy.final_submit.manual',
          ruleId: 'policy.final_submit.manual.v1',
        },
      },
    ],
    latestWorkflowEvaluation: {
      state: workflowState('final_submit_boundary', 'Policy identified a final-submit gate.'),
      changed: true,
      matchedCriteria: [],
      missingCriteria: [],
      blockers: [finalSubmitBlocker],
      evidenceIds: ['ev-form-ready', 'ev-policy-final-submit'],
      reason: 'Final submit requires human takeover.',
    },
    latestCompletionGate: {
      schemaVersion: 'completion-gate-decision/v1',
      action: 'block',
      recommendedStatus: 'blocked',
      reason: 'Completion gate blocked final submit.',
      missingCriteria: [],
      blockers: [finalSubmitBlocker],
      workflowPhase: 'final_submit_boundary',
      evidenceIds: ['ev-form-ready', 'ev-policy-final-submit'],
    },
    latestFinalResult: {
      version: 1,
      sessionId: 'resume-session',
      runId: 'resume-run',
      entryId: 'final-submit-blocked',
      ts: now,
      type: 'final_result',
      status: 'blocked',
      reason: 'Final submit requires manual takeover.',
    },
    missingCriteria: [],
    blockers: [finalSubmitBlocker],
  }
}

function toolDoneEvidence() {
  return {
    schemaVersion: 'workflow-evidence/v1',
    id: 'ev-tool-agent-done',
    kind: 'tool_result',
    summary: 'agent_done reported the workflow as complete.',
    source: 'agent_done',
    confidence: 'medium',
    ts: now,
    phase: 'done',
    data: {
      observation: 'agent_done: Workflow complete.',
      pageChanged: false,
      done: true,
      data: { blocked: false },
    },
  }
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

function session(overrides = {}) {
  return {
    version: 1,
    sessionId: 'resume-session',
    runId: 'resume-run',
    source: 'test',
    status: 'blocked',
    goal: 'Resume completion.',
    createdAt: now,
    updatedAt: now,
    outputDir: '/tmp/resume-session',
    transcriptPath: '/tmp/resume-session/transcript.jsonl',
    eventsPath: '/tmp/resume-session/events.jsonl',
    workflowPath: '/tmp/resume-session/workflow.json',
    ...overrides,
  }
}
