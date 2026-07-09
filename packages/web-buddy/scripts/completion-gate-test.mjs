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

const blockedLogin = CompletionGate.evaluate({
  done: true,
  blocked: false,
  workflowEvaluation: evaluation({ phase: 'external_blocker' }),
  page: pageState({
    pageType: 'login',
    title: 'Sign in',
    formCount: 0,
    inputCount: 0,
    textSummary: 'Sign in is required before continuing.',
  }),
  taskType: 'apply_entry',
  source: 'agent_done',
})
assert.equal(blockedLogin.action, 'block')
assert.equal(blockedLogin.recommendedStatus, 'blocked')
assert.equal(blockedLogin.workflowPhase, 'external_blocker')
assert.match(blockedLogin.reason, /external blocker/i)

const blockedByFinalSubmitBlocker = CompletionGate.evaluate({
  done: true,
  blocked: false,
  workflowEvaluation: evaluation({
    phase: 'in_target_flow',
    blockers: [finalSubmitBlocker()],
  }),
  taskType: 'final_review',
  source: 'agent_done',
})
assert.equal(blockedByFinalSubmitBlocker.action, 'block')
assert.equal(blockedByFinalSubmitBlocker.recommendedStatus, 'blocked')
assert.equal(blockedByFinalSubmitBlocker.blockers[0].gateKind, 'final_submit')

const allowedFillForm = CompletionGate.evaluate({
  done: true,
  blocked: false,
  workflowEvaluation: evaluation({
    phase: 'in_target_flow',
    evidenceIds: ['ev-tool-fill', 'ev-form-audit'],
  }),
  form: formState({ formCoverage: scrolledBottomCoverage() }),
  fillLedgerSummary: ledgerSummary({ total: 2, verified: 2 }),
  requiresCurrentResumeUpload: true,
  currentResumeUploaded: true,
  taskType: 'fill_form',
  source: 'agent_done',
})
assert.equal(allowedFillForm.action, 'allow')
assert.equal(allowedFillForm.recommendedStatus, 'completed')
assert.equal(allowedFillForm.workflowPhase, 'in_target_flow')
assert.deepEqual(allowedFillForm.evidenceIds, ['ev-tool-fill', 'ev-form-audit'])
assert.match(allowedFillForm.reason, /fill_form target state reached/i)

const allowedDespiteDonePhaseNotPresent = CompletionGate.evaluate({
  done: true,
  blocked: false,
  workflowEvaluation: evaluation({ phase: 'in_target_flow' }),
  form: formState({ formCoverage: scrolledBottomCoverage() }),
  fillLedgerSummary: ledgerSummary({ total: 1, verified: 1 }),
  taskType: 'fill_form',
  source: 'agent_done',
})
assert.equal(allowedDespiteDonePhaseNotPresent.action, 'allow')
assert.equal(allowedDespiteDonePhaseNotPresent.workflowPhase, 'in_target_flow')

const rejectedFillFormViewportCoverage = CompletionGate.evaluate({
  done: true,
  blocked: false,
  workflowEvaluation: evaluation({ phase: 'in_target_flow' }),
  form: formState({
    formCoverage: scrolledBottomCoverage({
      scope: 'viewport',
      complete: false,
      auditTool: 'browser_form_snapshot',
      scrolledBottom: false,
    }),
  }),
  fillLedgerSummary: ledgerSummary({ total: 1, verified: 1 }),
  taskType: 'fill_form',
  source: 'agent_done',
})
assert.equal(rejectedFillFormViewportCoverage.action, 'reject')
assert.notEqual(rejectedFillFormViewportCoverage.recommendedStatus, 'completed')
assert.match(rejectedFillFormViewportCoverage.reason, /scope=viewport/)

const rejectedUntrustedMissingRequired = CompletionGate.evaluate({
  done: true,
  blocked: false,
  workflowEvaluation: evaluation({ phase: 'in_target_flow' }),
  form: formState({
    formCoverage: scrolledBottomCoverage(),
    missingRequiredMayBeIncomplete: true,
  }),
  fillLedgerSummary: ledgerSummary({ total: 1, verified: 1 }),
  taskType: 'fill_form',
  source: 'agent_done',
})
assert.equal(rejectedUntrustedMissingRequired.action, 'reject')
assert.equal(rejectedUntrustedMissingRequired.recommendedStatus, 'unchanged')
assert.match(rejectedUntrustedMissingRequired.reason, /missingRequired may be incomplete/)
assert.match(rejectedUntrustedMissingRequired.reason, /continue browser_form_audit/i)

const rejectedRequiredSelectPlaceholder = CompletionGate.evaluate({
  done: true,
  blocked: false,
  workflowEvaluation: evaluation({ phase: 'in_target_flow' }),
  form: formState({
    formCoverage: scrolledBottomCoverage(),
    fields: [requiredSelectPlaceholder('Preferred role track *')],
    missingRequired: [requiredSelectPlaceholder('Preferred role track *')],
    filledFields: [],
  }),
  fillLedgerSummary: ledgerSummary({ total: 1, verified: 1 }),
  taskType: 'fill_form',
  source: 'agent_done',
})
assert.equal(rejectedRequiredSelectPlaceholder.action, 'reject')
assert.notEqual(rejectedRequiredSelectPlaceholder.recommendedStatus, 'completed')
assert.match(rejectedRequiredSelectPlaceholder.reason, /Preferred role track/)

const allowedExploreFromTaskEvidence = CompletionGate.evaluate({
  done: true,
  blocked: false,
  workflowEvaluation: evaluation({
    phase: 'in_target_flow',
    missingCriteria: [missingUserConfirmCriterion()],
  }),
  page: pageState({
    pageType: 'detail',
    title: 'Role detail',
    textSummary: 'Role detail, company, location, and requirements are visible.',
  }),
  summary: 'Candidate detail: Role title, company, location, and requirements were captured.',
  taskType: 'explore',
  source: 'agent_done',
})
assert.equal(allowedExploreFromTaskEvidence.action, 'allow')
assert.equal(allowedExploreFromTaskEvidence.recommendedStatus, 'completed')
assert.equal(allowedExploreFromTaskEvidence.missingCriteria[0].id, 'done-requires-explicit-completion-evidence')

const allowedApplyEntryFromUploadSurface = CompletionGate.evaluate({
  done: true,
  blocked: false,
  workflowEvaluation: evaluation({ phase: 'in_target_flow' }),
  page: pageState({
    pageType: 'form',
    title: 'Application',
    textSummary: 'Application profile and resume upload controls are visible.',
  }),
  form: formState({
    uploadHints: [{ tag: 'input', type: 'file', text: 'Resume upload', visible: true, accept: '.pdf' }],
  }),
  taskType: 'apply_entry',
  source: 'agent_done',
})
assert.equal(allowedApplyEntryFromUploadSurface.action, 'allow')
assert.equal(allowedApplyEntryFromUploadSurface.recommendedStatus, 'completed')

const rejectedActionableDialog = CompletionGate.evaluate({
  done: true,
  blocked: true,
  workflowEvaluation: evaluation({ phase: 'in_target_flow' }),
  page: pageState({
    pageType: 'detail',
    textSummary: 'Please confirm whether to continue. Cancel Apply',
  }),
  form: formState({
    submitCandidates: [
      submitCandidate('Cancel'),
      submitCandidate('Apply'),
    ],
  }),
  source: 'agent_done',
})
assert.equal(rejectedActionableDialog.action, 'reject')
assert.equal(rejectedActionableDialog.recommendedStatus, 'unchanged')
assert.match(rejectedActionableDialog.reason, /PREMATURE_AGENT_DONE_REJECTED/)
assert.match(rejectedActionableDialog.reason, /Apply/)
assert.match(rejectedActionableDialog.reason, /Cancel/)

const rejectedRuntimeBlockedWithoutExternalBlocker = CompletionGate.evaluate({
  done: true,
  blocked: true,
  workflowEvaluation: evaluation({ phase: 'done' }),
  source: 'agent_done',
})
assert.equal(rejectedRuntimeBlockedWithoutExternalBlocker.action, 'reject')
assert.equal(rejectedRuntimeBlockedWithoutExternalBlocker.recommendedStatus, 'unchanged')
assert.equal(rejectedRuntimeBlockedWithoutExternalBlocker.missingCriteria.at(-1).id, 'task_completion_missing_evidence')
assert.match(rejectedRuntimeBlockedWithoutExternalBlocker.reason, /PREMATURE_AGENT_DONE_REJECTED/)

const rejectedDonePhaseWithoutTaskEvidence = CompletionGate.evaluate({
  done: true,
  blocked: false,
  workflowEvaluation: evaluation({ phase: 'done' }),
  source: 'agent_done',
})
assert.equal(rejectedDonePhaseWithoutTaskEvidence.action, 'reject')
assert.equal(rejectedDonePhaseWithoutTaskEvidence.workflowPhase, 'done')
assert.match(rejectedDonePhaseWithoutTaskEvidence.reason, /task completion evidence is missing/i)

const rejectedReadyForFinalSubmitWithoutEvidenceBlocker = CompletionGate.evaluate({
  done: true,
  blocked: false,
  workflowEvaluation: evaluation({ phase: 'final_submit_boundary' }),
  source: 'agent_done',
})
assert.equal(rejectedReadyForFinalSubmitWithoutEvidenceBlocker.action, 'reject')
assert.equal(rejectedReadyForFinalSubmitWithoutEvidenceBlocker.recommendedStatus, 'unchanged')
assert.equal(rejectedReadyForFinalSubmitWithoutEvidenceBlocker.workflowPhase, 'final_submit_boundary')

const rejectedDirectSubmitReviewWithoutEvidenceBlocker = CompletionGate.evaluate({
  done: true,
  blocked: false,
  workflowEvaluation: evaluation({ phase: 'final_submit_boundary' }),
  source: 'agent_done',
})
assert.equal(rejectedDirectSubmitReviewWithoutEvidenceBlocker.action, 'reject')
assert.equal(rejectedDirectSubmitReviewWithoutEvidenceBlocker.recommendedStatus, 'unchanged')
assert.equal(rejectedDirectSubmitReviewWithoutEvidenceBlocker.workflowPhase, 'final_submit_boundary')

const rejectedFinalReviewWithoutExternalBlocker = CompletionGate.evaluate({
  done: true,
  blocked: false,
  workflowEvaluation: evaluation({ phase: 'done' }),
  taskType: 'final_review',
  source: 'agent_done',
})
assert.equal(rejectedFinalReviewWithoutExternalBlocker.action, 'reject')
assert.equal(rejectedFinalReviewWithoutExternalBlocker.recommendedStatus, 'unchanged')
assert.match(rejectedFinalReviewWithoutExternalBlocker.reason, /final_review never auto-completes/i)

const rejectedFinalReviewIncompleteCoverage = CompletionGate.evaluate({
  done: true,
  blocked: false,
  workflowEvaluation: evaluation({ phase: 'in_target_flow' }),
  form: formState({
    formCoverage: scrolledBottomCoverage({
      scope: 'viewport',
      complete: false,
      auditTool: 'browser_form_snapshot',
      scrolledBottom: false,
    }),
  }),
  taskType: 'final_review',
  source: 'agent_done',
})
assert.equal(rejectedFinalReviewIncompleteCoverage.action, 'reject')
assert.notEqual(rejectedFinalReviewIncompleteCoverage.recommendedStatus, 'completed')
assert.match(rejectedFinalReviewIncompleteCoverage.reason, /scope=viewport/)

const rejectedResumeNotUploaded = CompletionGate.evaluate({
  done: true,
  blocked: false,
  workflowEvaluation: evaluation({ phase: 'done' }),
  form: formState({ formCoverage: scrolledBottomCoverage() }),
  fillLedgerSummary: ledgerSummary({ total: 1, verified: 1 }),
  requiresCurrentResumeUpload: true,
  currentResumeUploaded: false,
  taskType: 'fill_form',
  source: 'agent_done',
})
assert.equal(rejectedResumeNotUploaded.action, 'reject')
assert.equal(rejectedResumeNotUploaded.missingCriteria.at(-1).id, 'task_completion_missing_evidence')
assert.match(rejectedResumeNotUploaded.reason, /Current resume upload must be verified/)

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
    url: 'about:blank',
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
    url: 'about:blank',
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
    scope: 'full_audit',
    complete: true,
    scrolledTop: true,
    scrolledBottom: true,
    segments: 2,
    totalFieldsSeen: 1,
    fieldLimit: 240,
    fieldLimitReached: false,
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

function requiredSelectPlaceholder(label) {
  return {
    index: 0,
    fieldKey: label.toLowerCase().replace(/\W+/g, '-'),
    controlKind: 'select_native',
    tag: 'select',
    label,
    value: 'Select one',
    required: true,
    filled: false,
    disabled: false,
    readonly: false,
    invalid: false,
    options: [
      { value: '', label: 'Select one', selected: true },
      { value: 'frontend', label: 'Frontend' },
    ],
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
