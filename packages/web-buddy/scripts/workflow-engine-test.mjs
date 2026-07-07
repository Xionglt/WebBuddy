#!/usr/bin/env node
import assert from 'node:assert/strict'
import { WorkflowEngine } from '../dist/workflow/workflow-engine.js'
import { EvidenceStore } from '../dist/workflow/workflow-evidence.js'
import { createInitialWorkflowState } from '../dist/workflow/workflow-state.js'

const now = '2026-06-30T00:00:00.000Z'
const engine = new WorkflowEngine()
const initial = createInitialWorkflowState(now)

const loginEvidence = snapshot([
  evidence('ev-page-login', 'page', 'Login page is visible.', 'external_blocker'),
  evidence('ev-workflow-login', 'workflow_state', 'Workflow entered login handoff.', 'external_blocker'),
])
const login = engine.evaluate({
  previous: initial,
  currentUrl: 'https://example.test/sso/login',
  page: page({ title: 'SSO 登录', pageType: 'login', textSummary: 'Please sign in to continue.' }),
  evidenceSnapshot: loginEvidence,
  now,
})
assert.equal(login.changed, true)
assert.equal(login.state.phase, 'external_blocker')
assert.equal(login.state.observationPhase, 'external_blocker')
assert.equal(login.observationPhase, 'external_blocker')
assert.equal(login.state.humanHandoffRequired, true)
assert.match(login.state.blocker, /login/i)
assert(login.blockers.some((blocker) => blocker.kind === 'human_handoff' && blocker.gateKind === 'login'))
assert(login.matchedCriteria.some((criterion) => criterion.id === 'handoff-phases-require-human-action'))
assert(login.evidenceIds.includes('ev-page-login'))

const captcha = engine.evaluate({
  previous: initial,
  page: page({ pageType: 'captcha', title: 'Security check', textSummary: '请完成人机验证' }),
  evidenceSnapshot: snapshot([evidence('ev-page-captcha', 'page', 'Captcha page is visible.', 'external_blocker')]),
  now,
})
assert.equal(captcha.state.phase, 'external_blocker')
assert.equal(captcha.state.observationPhase, 'external_blocker')
assert.equal(captcha.state.humanHandoffRequired, true)
assert(captcha.blockers.some((blocker) => blocker.kind === 'human_handoff' && blocker.gateKind === 'captcha'))

const in_target_flow = {
  ...initial,
  phase: 'in_target_flow',
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
  previous: in_target_flow,
  form: readyForm,
  policyFacts: [finalSubmitPolicyFact],
  evidenceSnapshot: snapshot([
    evidence('ev-form-ready-without-policy', 'form', 'Application form is filled.', 'final_submit_boundary'),
  ]),
  now,
})
assert.equal(readyMissingPolicyEvidence.state.phase, 'final_submit_boundary')
assert.equal(readyMissingPolicyEvidence.state.observationPhase, 'final_submit_boundary')
assert(
  readyMissingPolicyEvidence.missingCriteria.some(
    (criterion) =>
      criterion.id === 'final-submit-boundary-requires-page-form-and-policy-evidence' &&
      criterion.missingEvidenceKinds.includes('policy'),
  ),
  'policy facts alone should not satisfy persisted policy evidence',
)
assert(
  readyMissingPolicyEvidence.blockers.some(
    (blocker) =>
      blocker.kind === 'missing_evidence' &&
      blocker.criterionId === 'final-submit-boundary-requires-page-form-and-policy-evidence',
  ),
  'final_submit_boundary should report missing policy evidence as a blocker',
)

const ready = engine.evaluate({
  previous: in_target_flow,
  form: readyForm,
  policyFacts: [finalSubmitPolicyFact],
  evidenceSnapshot: snapshot([
    evidence('ev-page-ready', 'page', 'Application review page is visible.', 'final_submit_boundary'),
    evidence('ev-form-ready', 'form', 'Application form is filled.', 'final_submit_boundary'),
    evidence('ev-policy-final', 'policy', 'Policy identified final submit gate.', 'final_submit_boundary'),
  ]),
  now,
})
assert.equal(ready.state.phase, 'final_submit_boundary')
assert.equal(ready.state.observationPhase, 'final_submit_boundary')
assert.notEqual(ready.state.phase, 'done', 'final_submit_boundary must not mean completed')
assert.equal(ready.state.humanHandoffRequired, true)
assert.match(ready.state.blocker, /Final submit/i)
assert(ready.blockers.some((blocker) => blocker.kind === 'human_handoff' && blocker.gateKind === 'final_submit'))
assert(ready.matchedCriteria.some((criterion) => criterion.id === 'final-submit-boundary-requires-page-form-and-policy-evidence'))
assert(ready.evidenceIds.includes('ev-form-ready'))
assert(ready.evidenceIds.includes('ev-policy-final'))

const directSubmitForm = form({
  url: 'https://example.test/apply/direct',
  fields: [field(0, '我已阅读并同意申请工作需知', '', false, 'checkbox')],
  missingRequired: [],
  filledFields: [],
  submitCandidates: [{ tag: 'button', type: 'submit', text: '确认投递', risk: 'L3', visible: true }],
})
const directSubmitReview = engine.evaluate({
  previous: enteringState(),
  currentUrl: 'https://example.test/apply/direct',
  page: page({
    url: 'https://example.test/apply/direct',
    title: 'Direct apply',
    textSummary: '我已阅读并同意申请工作需知。确认投递',
    inputCount: 1,
    buttonCount: 1,
  }),
  form: directSubmitForm,
  policyFacts: [{ action: 'gate', riskLevel: 'critical', reason: 'final submit', gateKind: 'final_submit' }],
  evidenceSnapshot: snapshot([
    evidence('ev-page-direct-submit', 'page', 'Direct submit page is visible.', 'final_submit_boundary'),
    evidence('ev-form-direct-submit', 'form', 'Only agreement checkbox and apply button are visible.', 'final_submit_boundary'),
    evidence('ev-policy-direct-submit', 'policy', 'Policy identified final submit gate.', 'final_submit_boundary'),
  ]),
  now,
})
assert.equal(directSubmitReview.state.phase, 'final_submit_boundary')
assert.equal(directSubmitReview.state.observationPhase, 'final_submit_boundary')
assert.notEqual(directSubmitReview.state.phase, 'blocked')
assert.equal(directSubmitReview.state.humanHandoffRequired, true)
assert(directSubmitReview.blockers.some((blocker) => blocker.kind === 'human_handoff' && blocker.gateKind === 'final_submit'))
assert(directSubmitReview.matchedCriteria.some((criterion) => criterion.id === 'final-submit-boundary-requires-page-form-and-policy-evidence'))
assert(directSubmitReview.evidenceIds.includes('ev-form-direct-submit'))

const finalDeclined = engine.evaluate({
  previous: ready.state,
  approvalFacts: [{ gateKind: 'final_submit', status: 'denied', decision: 'decline' }],
  evidenceSnapshot: snapshot([evidence('ev-workflow-blocked', 'workflow_state', 'Final submit was declined.', 'blocked')]),
  now,
})
assert.equal(finalDeclined.state.phase, 'final_submit_boundary')
assert.equal(finalDeclined.state.observationPhase, 'final_submit_boundary')
assert(finalDeclined.blockers.some((blocker) => blocker.kind === 'human_handoff' && blocker.gateKind === 'final_submit'))

const profileAfterFinalCancel = engine.evaluate({
  previous: ready.state,
  currentUrl: 'https://example.test/profile/resume',
  page: page({
    url: 'https://example.test/profile/resume',
    title: '个人中心',
    pageType: 'form',
    textSummary: '个人中心 简历管理 上传简历 保存',
    formCount: 1,
    inputCount: 3,
    buttonCount: 2,
    facts: {
      hasAgreementCheckbox: false,
      agreementChecked: false,
      hasApplicationQuotaDialog: false,
      hasRealUploadInput: true,
      uploadCandidateCount: 1,
      submitLikeButtons: [{ tag: 'button', type: 'button', text: '保存', visible: true }],
      likelyApplyEntryButtons: [],
      likelyFinalSubmitButtons: [],
      visibleBlockingDialog: { present: false },
    },
  }),
  form: form({
    url: 'https://example.test/profile/resume',
    fields: [field(0, '上传简历', '', false, 'file'), field(1, '姓名', 'Zhang San', true)],
    filledFields: [field(1, '姓名', 'Zhang San', true)],
    submitCandidates: [{ tag: 'button', type: 'button', text: '保存', visible: true }],
  }),
  policyFacts: [finalSubmitPolicyFact],
  permissionFacts: [{ gateKind: 'final_submit', decision: 'deny' }],
  approvalFacts: [{ gateKind: 'final_submit', status: 'denied', decision: 'decline' }],
  evidenceSnapshot: snapshot([
    evidence('ev-page-ready', 'page', 'Previous application review page was visible.', 'final_submit_boundary'),
    evidence('ev-policy-final', 'policy', 'Previous policy identified final submit gate.', 'final_submit_boundary'),
  ]),
  now,
})
assert.equal(profileAfterFinalCancel.state.phase, 'in_target_flow')
assert.equal(profileAfterFinalCancel.state.observationPhase, 'in_target_flow')
assert.equal(profileAfterFinalCancel.state.humanHandoffRequired, undefined)
assert.equal(profileAfterFinalCancel.state.blocker, undefined)
assert(!profileAfterFinalCancel.blockers.some((blocker) => blocker.gateKind === 'final_submit'))

const doneMissingEvidence = engine.evaluate({
  previous: in_target_flow,
  recentActions: [
    {
      toolName: 'agent_done',
      toolResult: { observation: 'agent_done: Completed.', done: true, data: { blocked: false } },
    },
  ],
  evidenceSnapshot: snapshot([evidence('ev-form-in_target_flow', 'form', 'Review page is visible.', 'in_target_flow')]),
  now,
})
assert.equal(doneMissingEvidence.state.phase, 'done')
assert.equal(doneMissingEvidence.state.observationPhase, 'done')
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
  previous: in_target_flow,
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
assert.equal(doneWithEvidence.state.observationPhase, 'done')
assert(doneWithEvidence.matchedCriteria.some((criterion) => criterion.id === 'done-requires-explicit-completion-evidence'))
assert(doneWithEvidence.evidenceIds.includes('ev-tool-done'))
assert(doneWithEvidence.evidenceIds.includes('ev-user-confirm'))

const taskCompleted = engine.evaluate({
  previous: in_target_flow,
  page: page({ pageType: 'form', formCount: 1, inputCount: 2, textSummary: 'Application form ready for review.' }),
  form: {
    ...readyForm,
    formCoverage: {
      totalFields: 2,
      visibleFields: 2,
      coveredFields: 2,
      uncoveredRequired: [],
      scrolledBottom: true,
      updatedAt: now,
    },
  },
  taskType: 'fill_form',
  fillLedgerSummary: {
    total: 2,
    verified: 2,
    failed: 0,
    needsUser: 0,
    skipped: 0,
    pendingRequired: 0,
    updatedAt: now,
  },
  requiresCurrentResumeUpload: true,
  currentResumeUploaded: true,
  policyFacts: [finalSubmitPolicyFact],
  evidenceSnapshot: snapshot([evidence('ev-form-task-complete', 'form', 'Filled form verified.', 'in_target_flow')]),
  now,
})
assert.equal(taskCompleted.state.phase, 'done')
assert.equal(taskCompleted.state.observationPhase, 'done')
assert.equal(taskCompleted.observationPhase, 'done')

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
    phase: 'in_target_flow',
    confidence: 'medium',
    reason: 'Apply entry action appears to open the application flow.',
  }
}
