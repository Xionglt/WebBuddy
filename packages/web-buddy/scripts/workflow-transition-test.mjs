#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createInitialWorkflowState } from '../dist/workflow/workflow-state.js'
import { transitionWorkflowState } from '../dist/workflow/workflow-transition.js'

const now = '2026-06-26T00:00:00.000Z'
const initial = createInitialWorkflowState(now)

const login = transitionWorkflowState({
  previous: initial,
  currentUrl: 'https://example.test/sso/login',
  page: page({ title: 'SSO 登录', textSummary: 'Please sign in to continue.' }),
  now,
})
assert.equal(login.changed, true)
assert.equal(login.state.phase, 'external_blocker')
assert.equal(login.state.humanHandoffRequired, true)
assert.match(login.state.blocker, /login/i)

const captcha = transitionWorkflowState({
  previous: initial,
  page: page({ pageType: 'captcha', title: 'Security check', textSummary: '请完成人机验证' }),
  now,
})
assert.equal(captcha.state.phase, 'external_blocker')
assert.equal(captcha.state.humanHandoffRequired, true)
assert.match(captcha.state.blocker, /verification/i)

const jobDetail = { ...initial, phase: 'in_target_flow' }
const entering = transitionWorkflowState({
  previous: jobDetail,
  toolName: 'browser_click_text',
  toolResult: { observation: 'Clicked 立即投递 and opened the application flow.', pageChanged: true },
  policyDecision: { action: 'gate', riskLevel: 'high', reason: 'entry', gateKind: 'high_risk_action' },
  now,
})
assert.equal(entering.state.phase, 'in_target_flow')

const filling = transitionWorkflowState({
  previous: initial,
  form: form({
    fields: [field(0, 'Name', 'Zhang San', true), field(1, 'Email', '', true), field(2, 'Phone', '', true)],
    missingRequired: [field(1, 'Email', '', true), field(2, 'Phone', '', true)],
    filledFields: [field(0, 'Name', 'Zhang San', true)],
  }),
  now,
})
assert.equal(filling.state.phase, 'in_target_flow')

const in_target_flow = transitionWorkflowState({
  previous: filling.state,
  form: form({
    fields: [field(0, 'Name', 'Zhang San', true), field(1, 'Email', 'zhangsan@example.com', true)],
    missingRequired: [],
    filledFields: [field(0, 'Name', 'Zhang San', true), field(1, 'Email', 'zhangsan@example.com', true)],
    submitCandidates: [{ tag: 'button', type: 'submit', text: 'Submit application', risk: 'L3', visible: true }],
  }),
  now,
})
assert.equal(in_target_flow.state.phase, 'final_submit_boundary')

const directSubmitReview = transitionWorkflowState({
  previous: entering.state,
  currentUrl: 'https://example.test/apply/direct',
  page: page({
    url: 'https://example.test/apply/direct',
    title: 'Direct apply',
    textSummary: '我已阅读并同意申请工作需知。确认投递',
    inputCount: 1,
    buttonCount: 1,
  }),
  form: form({
    url: 'https://example.test/apply/direct',
    fields: [field(0, '我已阅读并同意申请工作需知', '', false, 'checkbox')],
    missingRequired: [],
    filledFields: [],
    submitCandidates: [{ tag: 'button', type: 'submit', text: '确认投递', risk: 'L3', visible: true }],
  }),
  now,
})
assert.equal(directSubmitReview.state.phase, 'final_submit_boundary')
assert.equal(directSubmitReview.state.humanHandoffRequired, true)
assert.match(directSubmitReview.state.blocker, /final submit/i)

const applicationEntryNotice = transitionWorkflowState({
  previous: entering.state,
  currentUrl: 'https://example.test/apply/notice',
  page: page({
    url: 'https://example.test/apply/notice',
    title: 'Apply notice',
    textSummary: '我已阅读并同意申请工作需知。投递简历',
    inputCount: 1,
    buttonCount: 1,
  }),
  form: form({
    url: 'https://example.test/apply/notice',
    fields: [field(0, '我已阅读并同意申请工作需知', '', false, 'checkbox')],
    missingRequired: [],
    filledFields: [],
    submitCandidates: [{ tag: 'button', type: 'button', text: '投递简历', risk: 'L3', visible: true }],
  }),
  now,
})
assert.equal(applicationEntryNotice.state.phase, 'in_target_flow')
assert.notEqual(applicationEntryNotice.state.phase, 'final_submit_boundary')

const ready = transitionWorkflowState({
  previous: in_target_flow.state,
  policyDecision: { action: 'gate', riskLevel: 'high', reason: 'final submit', gateKind: 'final_submit' },
  gateKind: 'final_submit',
  now,
})
assert.equal(ready.state.phase, 'final_submit_boundary')

const finalBlocked = transitionWorkflowState({
  previous: ready.state,
  gateKind: 'final_submit',
  gateDecision: 'takeover',
  now,
})
assert.equal(finalBlocked.state.phase, 'final_submit_boundary')
assert.equal(finalBlocked.state.humanHandoffRequired, true)

const done = transitionWorkflowState({ previous: in_target_flow.state, agentDoneBlocked: false, now })
assert.equal(done.state.phase, 'done')

const blocked = transitionWorkflowState({ previous: in_target_flow.state, agentDoneBlocked: true, now })
assert.equal(blocked.state.phase, 'blocked')
assert.equal(blocked.state.humanHandoffRequired, true)

console.log('workflow-transition-test: PASS')

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
