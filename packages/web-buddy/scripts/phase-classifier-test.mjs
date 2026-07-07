#!/usr/bin/env node
import assert from 'node:assert/strict'
import { classifyObservationPhase } from '../dist/workflow/phase-classifier.js'

const now = '2026-07-07T00:00:00.000Z'

assert.equal(
  classifyObservationPhase({
    page: page({ pageType: 'captcha' }),
    taskCompletionVerdict: { targetStateReached: true },
  }),
  'done',
  'targetStateReached wins over visible blockers',
)

assert.equal(
  classifyObservationPhase({
    page: page({ pageType: 'login', textSummary: 'Please sign in to continue.' }),
  }),
  'external_blocker',
  'login pages are external blockers',
)

assert.equal(
  classifyObservationPhase({
    page: page({ pageType: 'captcha', textSummary: 'Human verification required.' }),
  }),
  'external_blocker',
  'captcha pages are external blockers',
)

assert.equal(
  classifyObservationPhase({
    blockers: [{ id: 'handoff-login', kind: 'human_handoff', gateKind: 'login', message: 'Human login required.' }],
  }),
  'external_blocker',
  'login/captcha handoff blockers are external blockers',
)

assert.equal(
  classifyObservationPhase({
    externalBlockerVisible: true,
    page: page({ pageType: 'detail' }),
  }),
  'external_blocker',
  'explicit external blocker visibility maps to external_blocker',
)

assert.equal(
  classifyObservationPhase({
    taskCompletionVerdict: {
      targetStateReached: false,
      externalBlockerVisible: true,
    },
  }),
  'external_blocker',
  'task completion external blocker verdict maps to external_blocker',
)

assert.equal(
  classifyObservationPhase({
    form: form({
      submitCandidates: [{ tag: 'button', type: 'submit', text: 'Submit application', risk: 'L3', visible: true }],
    }),
  }),
  'final_submit_boundary',
  'submit-like final boundary is detected from form evidence',
)

assert.equal(
  classifyObservationPhase({
    page: page({ pageType: 'form' }),
    form: form({
      fields: [field(0, 'Email', '', true)],
      missingRequired: [field(0, 'Email', '', true)],
      submitCandidates: [{ tag: 'button', type: 'submit', text: 'Submit application', risk: 'L3', visible: true }],
    }),
  }),
  'in_target_flow',
  'fillable forms with missing required fields are not final-submit boundaries just because submit is visible',
)

assert.equal(
  classifyObservationPhase({
    page: page({ pageType: 'form' }),
    form: form({
      fields: [field(0, 'Name', '', false), field(1, 'Email', '', false, 'email')],
      submitCandidates: [{ tag: 'button', type: 'submit', text: 'Submit application', risk: 'L3', visible: true }],
    }),
  }),
  'in_target_flow',
  'fillable forms with empty real fields are not final-submit boundaries even when fields are not marked required',
)

assert.equal(
  classifyObservationPhase({
    page: page({
      formCount: 0,
      inputCount: 0,
      facts: {
        hasAgreementCheckbox: false,
        agreementChecked: false,
        hasApplicationQuotaDialog: false,
        hasRealUploadInput: false,
        uploadCandidateCount: 0,
        submitLikeButtons: [{ tag: 'button', type: 'submit', text: 'Confirm and submit', visible: true }],
        likelyApplyEntryButtons: [],
        likelyFinalSubmitButtons: [],
        visibleBlockingDialog: { present: false },
      },
    }),
  }),
  'final_submit_boundary',
  'page-only submit-like boundary is detected without URL assumptions',
)

assert.equal(
  classifyObservationPhase({
    blockers: [{ id: 'handoff-final', kind: 'human_handoff', gateKind: 'final_submit', message: 'Final submit requires takeover.' }],
  }),
  'final_submit_boundary',
  'final-submit blocker maps to final_submit_boundary',
)

assert.equal(
  classifyObservationPhase({
    page: page({
      pageType: 'form',
      textSummary: '温馨提示 你已申请2个职位，本月还能再申请3个，请慎重选择！ 投递 取消',
      facts: {
        hasAgreementCheckbox: true,
        agreementChecked: true,
        hasApplicationQuotaDialog: false,
        hasRealUploadInput: false,
        uploadCandidateCount: 0,
        submitLikeButtons: [{ tag: 'button', type: 'button', text: '投递', visible: true }],
        likelyApplyEntryButtons: [],
        likelyFinalSubmitButtons: [],
        visibleBlockingDialog: {
          present: true,
          kind: 'confirmation',
          text: '温馨提示 你已申请2个职位，本月还能再申请3个，请慎重选择！ 投递取消',
          role: 'alertdialog',
        },
      },
    }),
  }),
  'final_submit_boundary',
  'quota-like confirmation dialogs are final-submit boundaries even when classified as generic confirmation',
)

assert.equal(
  classifyObservationPhase({
    page: page({
      pageType: 'form',
      textSummary: '个人中心 简历管理 上传简历 保存',
      facts: {
        hasAgreementCheckbox: false,
        agreementChecked: false,
        hasApplicationQuotaDialog: false,
        hasRealUploadInput: true,
        uploadCandidateCount: 3,
        submitLikeButtons: [],
        likelyApplyEntryButtons: [],
        likelyFinalSubmitButtons: [],
        visibleBlockingDialog: { present: false },
      },
    }),
    form: form({
      fields: [],
      missingRequired: [],
      submitCandidates: [{ tag: 'button', type: 'button', text: '保存', visible: true }],
      facts: {
        hasAgreementCheckbox: false,
        agreementChecked: false,
        hasApplicationQuotaDialog: false,
        hasRealUploadInput: true,
        uploadCandidateCount: 3,
        submitLikeButtons: [],
        likelyApplyEntryButtons: [],
        likelyFinalSubmitButtons: [],
        visibleBlockingDialog: { present: false },
      },
    }),
  }),
  'in_target_flow',
  'resume upload/profile pages are not final-submit boundaries just because they have save buttons',
)

assert.equal(
  classifyObservationPhase({
    page: page({
      facts: {
        hasAgreementCheckbox: false,
        agreementChecked: false,
        hasApplicationQuotaDialog: true,
        hasRealUploadInput: false,
        uploadCandidateCount: 0,
        submitLikeButtons: [],
        likelyApplyEntryButtons: [],
        likelyFinalSubmitButtons: [],
        visibleBlockingDialog: { present: true, kind: 'quota', text: 'Quota exceeded.' },
      },
    }),
  }),
  'blocked',
  'unrecoverable quota blockers map to blocked',
)

assert.equal(
  classifyObservationPhase({
    blockers: [{ id: 'blocked', kind: 'workflow_blocked', message: 'Cannot continue.', recoverable: false }],
  }),
  'blocked',
  'explicit unrecoverable blockers map to blocked',
)

assert.equal(
  classifyObservationPhase({
    page: page({ pageType: 'form' }),
    form: form({ fields: [field(0, 'Name', 'Ada', true)], filledFields: [field(0, 'Name', 'Ada', true)] }),
    summary: 'Application form is still in progress.',
  }),
  'in_target_flow',
  'ordinary target-flow observations stay in target flow',
)

console.log('phase-classifier-test: PASS')

function page(overrides = {}) {
  return {
    schemaVersion: 'page-state/v1',
    url: 'https://example.test/generic',
    title: 'Generic workflow page',
    pageType: 'detail',
    interactiveCount: 3,
    formCount: 0,
    linkCount: 1,
    buttonCount: 1,
    inputCount: 0,
    textSummary: 'Generic target-flow page.',
    updatedAt: now,
    ...overrides,
  }
}

function form(overrides = {}) {
  return {
    schemaVersion: 'form-state/v1',
    url: 'https://example.test/generic',
    fields: [],
    missingRequired: [],
    filledFields: [],
    submitCandidates: [],
    updatedAt: now,
    ...overrides,
  }
}

function field(index, label, value, required) {
  return {
    index,
    label,
    tag: 'input',
    type: 'text',
    value,
    required,
    filled: Boolean(value),
    disabled: false,
    readonly: false,
    invalid: required && !value,
  }
}
