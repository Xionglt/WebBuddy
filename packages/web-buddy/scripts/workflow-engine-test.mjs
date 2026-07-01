#!/usr/bin/env node
import assert from 'node:assert/strict'
import { WorkflowEngine } from '../dist/workflow/workflow-engine.js'
import { EvidenceStore } from '../dist/workflow/workflow-evidence.js'
import { createInitialWorkflowState } from '../dist/workflow/workflow-state.js'

const now = '2026-06-30T00:00:00.000Z'
const engine = new WorkflowEngine()
const initial = createInitialWorkflowState(now)

const loginEvidence = snapshot([
  evidence('ev-page-login', 'page', 'Login page is visible.', 'login_required'),
  evidence('ev-workflow-login', 'workflow_state', 'Workflow entered login handoff.', 'login_required'),
])
const login = engine.evaluate({
  previous: initial,
  currentUrl: 'https://example.test/sso/login',
  page: page({ title: 'SSO 登录', pageType: 'login', textSummary: 'Please sign in to continue.' }),
  evidenceSnapshot: loginEvidence,
  now,
})
assert.equal(login.changed, true)
assert.equal(login.state.phase, 'login_required')
assert.equal(login.state.humanHandoffRequired, true)
assert.match(login.state.blocker, /login/i)
assert(login.blockers.some((blocker) => blocker.kind === 'human_handoff' && blocker.gateKind === 'login'))
assert(login.matchedCriteria.some((criterion) => criterion.id === 'handoff-phases-require-human-action'))
assert(login.evidenceIds.includes('ev-page-login'))

const captcha = engine.evaluate({
  previous: initial,
  page: page({ pageType: 'captcha', title: 'Security check', textSummary: '请完成人机验证' }),
  evidenceSnapshot: snapshot([evidence('ev-page-captcha', 'page', 'Captcha page is visible.', 'captcha_required')]),
  now,
})
assert.equal(captcha.state.phase, 'captcha_required')
assert.equal(captcha.state.humanHandoffRequired, true)
assert(captcha.blockers.some((blocker) => blocker.kind === 'human_handoff' && blocker.gateKind === 'captcha'))

const reviewing = {
  ...initial,
  phase: 'reviewing',
  confidence: 'medium',
  reason: 'Application form appears mostly filled and has submit candidates.',
}
const readyForm = form({
  fields: [field(0, 'Name', 'Zhang San', true), field(1, 'Email', 'zhangsan@example.com', true)],
  filledFields: [field(0, 'Name', 'Zhang San', true), field(1, 'Email', 'zhangsan@example.com', true)],
  missingRequired: [],
  submitCandidates: [{ tag: 'button', type: 'submit', text: 'Submit application', risk: 'L3', visible: true }],
})
const finalSubmitPolicyFact = { action: 'gate', riskLevel: 'high', reason: 'final submit', gateKind: 'final_submit' }
const readyMissingPolicyEvidence = engine.evaluate({
  previous: reviewing,
  form: readyForm,
  policyFacts: [finalSubmitPolicyFact],
  evidenceSnapshot: snapshot([
    evidence('ev-form-ready-without-policy', 'form', 'Application form is filled.', 'ready_for_final_submit'),
  ]),
  now,
})
assert.equal(readyMissingPolicyEvidence.state.phase, 'ready_for_final_submit')
assert(
  readyMissingPolicyEvidence.missingCriteria.some(
    (criterion) =>
      criterion.id === 'ready-for-final-submit-requires-form-and-policy-evidence' &&
      criterion.missingEvidenceKinds.includes('policy'),
  ),
  'policy facts alone should not satisfy persisted policy evidence',
)
assert(
  readyMissingPolicyEvidence.blockers.some(
    (blocker) =>
      blocker.kind === 'missing_evidence' &&
      blocker.criterionId === 'ready-for-final-submit-requires-form-and-policy-evidence',
  ),
  'ready_for_final_submit should report missing policy evidence as a blocker',
)

const ready = engine.evaluate({
  previous: reviewing,
  form: readyForm,
  policyFacts: [finalSubmitPolicyFact],
  evidenceSnapshot: snapshot([
    evidence('ev-form-ready', 'form', 'Application form is filled.', 'ready_for_final_submit'),
    evidence('ev-policy-final', 'policy', 'Policy identified final submit gate.', 'ready_for_final_submit'),
  ]),
  now,
})
assert.equal(ready.state.phase, 'ready_for_final_submit')
assert.notEqual(ready.state.phase, 'done', 'ready_for_final_submit must not mean completed')
assert.equal(ready.state.humanHandoffRequired, true)
assert.match(ready.state.blocker, /Final submit/i)
assert(ready.blockers.some((blocker) => blocker.kind === 'human_handoff' && blocker.gateKind === 'final_submit'))
assert(ready.matchedCriteria.some((criterion) => criterion.id === 'ready-for-final-submit-requires-form-and-policy-evidence'))
assert(ready.evidenceIds.includes('ev-form-ready'))
assert(ready.evidenceIds.includes('ev-policy-final'))

const directSubmitForm = form({
  url: 'https://example.test/apply/direct',
  fields: [field(0, '我已阅读并同意申请工作需知', '', false, 'checkbox')],
  missingRequired: [],
  filledFields: [],
  submitCandidates: [{ tag: 'button', type: 'submit', text: '投递简历', risk: 'L3', visible: true }],
})
const directSubmitReview = engine.evaluate({
  previous: enteringState(),
  currentUrl: 'https://example.test/apply/direct',
  page: page({
    url: 'https://example.test/apply/direct',
    title: 'Direct apply',
    textSummary: '我已阅读并同意申请工作需知。投递简历',
    inputCount: 1,
    buttonCount: 1,
  }),
  form: directSubmitForm,
  policyFacts: [{ action: 'gate', riskLevel: 'critical', reason: 'final submit', gateKind: 'final_submit' }],
  evidenceSnapshot: snapshot([
    evidence('ev-page-direct-submit', 'page', 'Direct submit page is visible.', 'direct_submit_review'),
    evidence('ev-form-direct-submit', 'form', 'Only agreement checkbox and apply button are visible.', 'direct_submit_review'),
    evidence('ev-policy-direct-submit', 'policy', 'Policy identified final submit gate.', 'direct_submit_review'),
  ]),
  now,
})
assert.equal(directSubmitReview.state.phase, 'direct_submit_review')
assert.notEqual(directSubmitReview.state.phase, 'blocked')
assert.equal(directSubmitReview.state.humanHandoffRequired, true)
assert(directSubmitReview.blockers.some((blocker) => blocker.kind === 'human_handoff' && blocker.gateKind === 'final_submit'))
assert(directSubmitReview.matchedCriteria.some((criterion) => criterion.id === 'direct-submit-review-requires-page-form-and-policy-evidence'))
assert(directSubmitReview.evidenceIds.includes('ev-form-direct-submit'))

const finalDeclined = engine.evaluate({
  previous: ready.state,
  approvalFacts: [{ gateKind: 'final_submit', status: 'denied', decision: 'decline' }],
  evidenceSnapshot: snapshot([evidence('ev-workflow-blocked', 'workflow_state', 'Final submit was declined.', 'blocked')]),
  now,
})
assert.equal(finalDeclined.state.phase, 'blocked')
assert(finalDeclined.blockers.some((blocker) => blocker.kind === 'human_handoff' && blocker.gateKind === 'final_submit'))
assert(finalDeclined.blockers.some((blocker) => blocker.kind === 'workflow_blocked'))
assert(finalDeclined.matchedCriteria.some((criterion) => criterion.id === 'blocked-is-terminal'))

const doneMissingEvidence = engine.evaluate({
  previous: reviewing,
  recentActions: [
    {
      toolName: 'agent_done',
      toolResult: { observation: 'agent_done: Completed.', done: true, data: { blocked: false } },
    },
  ],
  evidenceSnapshot: snapshot([evidence('ev-form-reviewing', 'form', 'Review page is visible.', 'reviewing')]),
  now,
})
assert.equal(doneMissingEvidence.state.phase, 'done')
assert(
  doneMissingEvidence.missingCriteria.some(
    (criterion) =>
      criterion.id === 'done-requires-explicit-completion-evidence' &&
      criterion.missingEvidenceKinds.includes('tool_result') &&
      criterion.missingEvidenceKinds.includes('user_confirm'),
  ),
  'done should report missing explicit completion evidence',
)
assert(doneMissingEvidence.blockers.some((blocker) => blocker.kind === 'missing_evidence'))

const doneWithEvidence = engine.evaluate({
  previous: reviewing,
  recentActions: [
    {
      toolName: 'agent_done',
      toolResult: { observation: 'agent_done: Completed.', done: true, data: { blocked: false } },
    },
  ],
  evidenceSnapshot: snapshot([
    evidence('ev-tool-done', 'tool_result', 'agent_done reported completion.', 'done'),
    evidence('ev-user-confirm', 'user_confirm', 'User confirmed completion.', 'done'),
  ]),
  now,
})
assert.equal(doneWithEvidence.state.phase, 'done')
assert(doneWithEvidence.matchedCriteria.some((criterion) => criterion.id === 'done-requires-explicit-completion-evidence'))
assert(doneWithEvidence.evidenceIds.includes('ev-tool-done'))
assert(doneWithEvidence.evidenceIds.includes('ev-user-confirm'))

console.log('workflow-engine-test: PASS')

function snapshot(items) {
  const store = new EvidenceStore({ now: () => new Date(now) })
  for (const item of items) store.add(item)
  return store.snapshot()
}

function evidence(id, kind, summary, phase) {
  return {
    id,
    kind,
    summary,
    source: 'workflow-engine-test',
    confidence: 'high',
    ts: now,
    phase,
  }
}

function page(overrides = {}) {
  return {
    schemaVersion: 'page-state/v1',
    url: 'https://example.test/jobs/1',
    title: 'Frontend Engineer detail',
    pageType: 'detail',
    interactiveCount: 3,
    formCount: 0,
    linkCount: 1,
    buttonCount: 1,
    inputCount: 0,
    textSummary: 'Job detail with Apply button.',
    updatedAt: now,
    ...overrides,
  }
}

function form(overrides = {}) {
  return {
    schemaVersion: 'form-state/v1',
    url: 'https://example.test/apply',
    fields: [],
    missingRequired: [],
    filledFields: [],
    submitCandidates: [],
    updatedAt: now,
    ...overrides,
  }
}

function field(index, label, value, required, type = 'text') {
  return {
    index,
    label,
    tag: 'input',
    type,
    value,
    required,
    filled: Boolean(value),
    disabled: false,
    readonly: false,
    invalid: required && !value,
  }
}

function enteringState() {
  return {
    ...initial,
    phase: 'entering_application',
    confidence: 'medium',
    reason: 'Apply entry action appears to open the application flow.',
  }
}
