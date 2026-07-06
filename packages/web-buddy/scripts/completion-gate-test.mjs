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

const rejectedAlibabaConfirmation = CompletionGate.evaluate({
  done: true,
  blocked: true,
  workflowEvaluation: evaluation({ phase: 'job_detail' }),
  page: pageState({
    url: 'https://talent-holding.alibaba.com/off-campus/position-detail?lang=zh&positionId=fixture',
    pageType: 'detail',
    textSummary: '温馨提示：你暂未申请职位，本月能申请5个职位，请慎重选择！ 取消 投递',
  }),
  form: formState({
    submitCandidates: [
      submitCandidate('取消'),
      submitCandidate('投递'),
    ],
  }),
  source: 'agent_done',
})
assert.equal(rejectedAlibabaConfirmation.action, 'reject')
assert.equal(rejectedAlibabaConfirmation.recommendedStatus, 'unchanged')
assert.match(rejectedAlibabaConfirmation.reason, /ALIBABA_APPLICATION_CONFIRMATION_STILL_OPEN/)
assert.match(rejectedAlibabaConfirmation.reason, /投递/)
assert.match(rejectedAlibabaConfirmation.reason, /取消/)

const rejectedUploadEntry = CompletionGate.evaluate({
  done: true,
  blocked: true,
  workflowEvaluation: evaluation({ phase: 'editing_resume' }),
  page: pageState({ pageType: 'form', textSummary: 'Application form 上传附件简历' }),
  form: formState({
    uploadHints: [{ tag: 'input', type: 'file', text: '上传附件简历', visible: true, accept: '.pdf' }],
  }),
  source: 'agent_done',
})
assert.equal(rejectedUploadEntry.action, 'reject')
assert.match(rejectedUploadEntry.reason, /upload entry/i)

const rejectedMissingRequired = CompletionGate.evaluate({
  done: true,
  blocked: true,
  workflowEvaluation: evaluation({ phase: 'filling_application' }),
  page: pageState({ pageType: 'form', textSummary: 'Application form' }),
  form: formState({
    fields: [requiredField('姓名')],
    missingRequired: [requiredField('姓名')],
  }),
  source: 'agent_done',
})
assert.equal(rejectedMissingRequired.action, 'reject')
assert.match(rejectedMissingRequired.reason, /required form field/i)
assert.match(rejectedMissingRequired.reason, /姓名/)

const rejectedAfterLoginCleared = CompletionGate.evaluate({
  done: true,
  blocked: true,
  workflowEvaluation: evaluation({
    phase: 'filling_application',
    state: workflowState('filling_application', {
      lastTransition: {
        from: 'login_required',
        to: 'filling_application',
        reason: 'Human handoff appears cleared and the current page has application form fields.',
        at: '2026-06-30T00:00:01.000Z',
      },
    }),
  }),
  page: pageState({ pageType: 'form', textSummary: 'Application form' }),
  form: formState({ fields: [filledField('姓名', 'Zhang San')] }),
  source: 'agent_done',
})
assert.equal(rejectedAfterLoginCleared.action, 'reject')
assert.match(rejectedAfterLoginCleared.reason, /login\/captcha handoff has cleared/i)

const rejectedAfterCaptchaCleared = CompletionGate.evaluate({
  done: true,
  blocked: true,
  workflowEvaluation: evaluation({
    phase: 'job_detail',
    state: workflowState('job_detail', {
      lastTransition: {
        from: 'captcha_required',
        to: 'job_detail',
        reason: 'Human handoff appears cleared and the current page is a job detail page.',
        at: '2026-06-30T00:00:01.000Z',
      },
    }),
  }),
  page: pageState({ pageType: 'detail', textSummary: '岗位详情 立即投递', interactiveCount: 1, buttonCount: 1 }),
  form: formState({ submitCandidates: [submitCandidate('立即投递')] }),
  source: 'agent_done',
})
assert.equal(rejectedAfterCaptchaCleared.action, 'reject')
assert.match(rejectedAfterCaptchaCleared.reason, /business workflow/i)

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

const rejectedNoAudit = CompletionGate.evaluate({
  done: true,
  blocked: false,
  workflowEvaluation: evaluation({ phase: 'done' }),
  form: formState({ fields: [filledField('姓名', 'Zhang San')] }),
  fillLedgerSummary: ledgerSummary({ total: 1, verified: 1 }),
  source: 'agent_done',
})
assert.equal(rejectedNoAudit.action, 'reject')
assert.match(rejectedNoAudit.reason, /fill_form_coverage_scrolled_bottom/)
assert.match(rejectedNoAudit.reason, /browser_form_audit/)

const rejectedLedgerPendingRequired = CompletionGate.evaluate({
  done: true,
  blocked: false,
  workflowEvaluation: evaluation({ phase: 'done' }),
  form: formState({ formCoverage: scrolledBottomCoverage() }),
  fillLedgerSummary: ledgerSummary({ total: 2, verified: 1, pendingRequired: 1 }),
  source: 'agent_done',
})
assert.equal(rejectedLedgerPendingRequired.action, 'reject')
assert.match(rejectedLedgerPendingRequired.reason, /fill_pending_required_zero/)

const rejectedLedgerNeedsUser = CompletionGate.evaluate({
  done: true,
  blocked: false,
  workflowEvaluation: evaluation({ phase: 'done' }),
  form: formState({ formCoverage: scrolledBottomCoverage() }),
  fillLedgerSummary: ledgerSummary({ total: 2, verified: 1, needsUser: 1 }),
  source: 'agent_done',
})
assert.equal(rejectedLedgerNeedsUser.action, 'reject')
assert.match(rejectedLedgerNeedsUser.reason, /ask_user/)

const rejectedLedgerFailed = CompletionGate.evaluate({
  done: true,
  blocked: false,
  workflowEvaluation: evaluation({ phase: 'done' }),
  form: formState({ formCoverage: scrolledBottomCoverage() }),
  fillLedgerSummary: ledgerSummary({ total: 2, verified: 1, failed: 1 }),
  source: 'agent_done',
})
assert.equal(rejectedLedgerFailed.action, 'reject')
assert.match(rejectedLedgerFailed.reason, /fill_failed_zero/)

const rejectedResumeNotUploaded = CompletionGate.evaluate({
  done: true,
  blocked: false,
  workflowEvaluation: evaluation({ phase: 'done' }),
  form: formState({ formCoverage: scrolledBottomCoverage() }),
  fillLedgerSummary: ledgerSummary({ total: 1, verified: 1 }),
  requiresCurrentResumeUpload: true,
  currentResumeUploaded: false,
  source: 'agent_done',
})
assert.equal(rejectedResumeNotUploaded.action, 'reject')
assert.match(rejectedResumeNotUploaded.reason, /fill_current_resume_uploaded/)

const allowedDone = CompletionGate.evaluate({
  done: true,
  blocked: false,
  workflowEvaluation: evaluation({
    phase: 'done',
    evidenceIds: ['ev-tool-done', 'ev-user-confirm'],
  }),
  form: formState({ formCoverage: scrolledBottomCoverage() }),
  fillLedgerSummary: ledgerSummary({ total: 1, verified: 1 }),
  requiresCurrentResumeUpload: true,
  currentResumeUploaded: true,
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
    state: overrides.state ?? workflowState(phase),
    changed: false,
    matchedCriteria: [],
    missingCriteria: overrides.missingCriteria ?? [],
    blockers: overrides.blockers ?? [],
    evidenceIds: overrides.evidenceIds ?? [],
    reason: 'Minimal completion gate test evaluation.',
  }
}

function workflowState(phase, overrides = {}) {
  return {
    schemaVersion: 'workflow-state/v1',
    phase,
    confidence: 'high',
    reason: `Test workflow phase is ${phase}.`,
    updatedAt: '2026-06-30T00:00:00.000Z',
    ...overrides,
  }
}

function pageState(overrides = {}) {
  return {
    schemaVersion: 'page-state/v1',
    url: 'https://example.test/apply',
    title: 'Application',
    pageType: 'form',
    interactiveCount: 2,
    formCount: 1,
    linkCount: 0,
    buttonCount: 0,
    inputCount: 1,
    textSummary: 'Application form',
    updatedAt: '2026-06-30T00:00:00.000Z',
    ...overrides,
  }
}

function formState(overrides = {}) {
  return {
    schemaVersion: 'form-state/v1',
    url: 'https://example.test/apply',
    fields: [],
    missingRequired: [],
    filledFields: [],
    submitCandidates: [],
    uploadHints: [],
    visibleErrors: [],
    updatedAt: '2026-06-30T00:00:00.000Z',
    ...overrides,
  }
}

function scrolledBottomCoverage(overrides = {}) {
  return {
    schemaVersion: 'form-coverage/v1',
    scrolledTop: true,
    scrolledBottom: true,
    segments: 2,
    totalFieldsSeen: 1,
    auditTool: 'browser_form_audit',
    updatedAt: '2026-06-30T00:00:00.000Z',
    ...overrides,
  }
}

function ledgerSummary(overrides = {}) {
  return {
    schemaVersion: 'fill-ledger-summary/v1',
    total: 0,
    verified: 0,
    failed: 0,
    needsUser: 0,
    skipped: 0,
    pendingRequired: 0,
    updatedAt: '2026-06-30T00:00:00.000Z',
    ...overrides,
  }
}

function submitCandidate(text) {
  return { tag: 'button', text, visible: true, risk: 'L1' }
}

function requiredField(label) {
  return {
    index: 0,
    label,
    tag: 'input',
    type: 'text',
    required: true,
    filled: false,
    disabled: false,
    readonly: false,
    invalid: false,
  }
}

function filledField(label, value) {
  return {
    ...requiredField(label),
    value,
    filled: true,
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
