#!/usr/bin/env node
import assert from 'node:assert/strict'
import { evaluateTaskCompletion } from '../dist/workflow/task-completion.js'

const exploreDone = evaluateTaskCompletion({
  taskType: 'explore',
  page: pageState({ pageType: 'detail', textSummary: 'Role detail with company, location, and requirements.' }),
  summary: 'Detail: Frontend Engineer at Example Co, remote, React requirements.',
  evidenceSnapshot: evidenceSnapshot([
    pageEvidence({ summary: 'Observed detail page with company and role information.', pageType: 'detail' }),
  ]),
})
assert.equal(exploreDone.targetStateReached, true)
assert.equal(exploreDone.externalBlockerVisible, false)
assert.deepEqual(exploreDone.missingEvidence, [])

const exploreLoginBlocker = evaluateTaskCompletion({
  taskType: 'explore',
  page: pageState({ pageType: 'login', textSummary: 'Please login to continue.' }),
  summary: '',
  evidenceSnapshot: evidenceSnapshot([
    pageEvidence({ summary: 'Login page requires sign in.', pageType: 'login' }),
  ]),
})
assert.equal(exploreLoginBlocker.targetStateReached, false)
assert.equal(exploreLoginBlocker.externalBlockerVisible, true)
assert.match(exploreLoginBlocker.reason, /external blocker/i)

const applyEntryFormSurface = evaluateTaskCompletion({
  taskType: 'apply_entry',
  page: pageState({ pageType: 'form', formCount: 1, inputCount: 3, textSummary: 'Application form profile resume upload' }),
  form: formState({
    fields: [field('Full name')],
    uploadHints: [{ tag: 'input', type: 'file', text: 'Upload resume', visible: true }],
  }),
  summary: 'Opened the application form.',
  evidenceSnapshot: evidenceSnapshot([
    pageEvidence({ summary: 'Application form is visible.', pageType: 'form' }),
  ]),
})
assert.equal(applyEntryFormSurface.targetStateReached, true)
assert.equal(applyEntryFormSurface.externalBlockerVisible, false)

const applyEntrySubmitted = evaluateTaskCompletion({
  taskType: 'apply_entry',
  page: pageState({ pageType: 'confirmation', textSummary: 'Application submitted. Next step will be emailed.' }),
  summary: 'The page says submitted and shows next step guidance.',
  evidenceSnapshot: evidenceSnapshot([
    pageEvidence({ summary: 'Confirmation page: application submitted.', pageType: 'confirmation' }),
  ]),
})
assert.equal(applyEntrySubmitted.targetStateReached, true)

const applyEntryUnavailable = evaluateTaskCompletion({
  taskType: 'apply_entry',
  page: pageState({ pageType: 'detail', textSummary: 'This position is closed and no longer available.' }),
  summary: 'Position closed.',
  evidenceSnapshot: evidenceSnapshot([
    pageEvidence({ summary: 'Position closed and unavailable.', pageType: 'detail' }),
  ]),
})
assert.equal(applyEntryUnavailable.targetStateReached, false)
assert.equal(applyEntryUnavailable.externalBlockerVisible, true)

const fillFormDone = evaluateTaskCompletion({
  taskType: 'fill_form',
  page: pageState({ pageType: 'form', textSummary: 'Application form' }),
  form: formState({ visibleErrors: [], formCoverage: coverage(true) }),
  formCoverage: coverage(true),
  fillLedgerSummary: ledger({ total: 3, verified: 3 }),
  requiresCurrentResumeUpload: true,
  currentResumeUploaded: true,
  evidenceSnapshot: evidenceSnapshot([
    pageEvidence({ summary: 'Application form audited to bottom.', pageType: 'form' }),
  ]),
})
assert.equal(fillFormDone.targetStateReached, true)
assert.deepEqual(fillFormDone.missingEvidence, [])

const fillFormMissingResumeAndErrors = evaluateTaskCompletion({
  taskType: 'fill_form',
  page: pageState({ pageType: 'form', textSummary: 'Application form' }),
  form: formState({ visibleErrors: ['Phone is required'], formCoverage: coverage(false) }),
  fillLedgerSummary: ledger({ pendingRequired: 1, failed: 1, needsUser: 1 }),
  requiresCurrentResumeUpload: true,
  currentResumeUploaded: false,
  evidenceSnapshot: evidenceSnapshot([
    pageEvidence({ summary: 'Application form still has visible errors.', pageType: 'form' }),
  ]),
})
assert.equal(fillFormMissingResumeAndErrors.targetStateReached, false)
assert.match(fillFormMissingResumeAndErrors.missingEvidence.join(' '), /scope=full_audit and complete=true/)
assert.match(fillFormMissingResumeAndErrors.missingEvidence.join(' '), /pendingRequired/)
assert.match(fillFormMissingResumeAndErrors.missingEvidence.join(' '), /Current resume/)
assert.match(fillFormMissingResumeAndErrors.missingEvidence.join(' '), /Phone is required/)

const fillFormViewportCoverageIncomplete = evaluateTaskCompletion({
  taskType: 'fill_form',
  page: pageState({ pageType: 'form', textSummary: 'Application form' }),
  form: formState({ visibleErrors: [], formCoverage: coverage(true, { scope: 'viewport', complete: false, auditTool: 'browser_form_snapshot' }) }),
  fillLedgerSummary: ledger({ total: 1, verified: 1 }),
  evidenceSnapshot: evidenceSnapshot([
    pageEvidence({ summary: 'Only viewport form snapshot was captured.', pageType: 'form' }),
  ]),
})
assert.equal(fillFormViewportCoverageIncomplete.targetStateReached, false)
assert.match(fillFormViewportCoverageIncomplete.missingEvidence.join(' '), /scope=viewport/)
assert.match(fillFormViewportCoverageIncomplete.missingEvidence.join(' '), /complete=false/)

const fillFormUntrustedMissingRequired = evaluateTaskCompletion({
  taskType: 'fill_form',
  page: pageState({ pageType: 'form', textSummary: 'Application form' }),
  form: formState({
    visibleErrors: [],
    formCoverage: coverage(true),
    missingRequiredMayBeIncomplete: true,
  }),
  fillLedgerSummary: ledger({ total: 1, verified: 1 }),
  evidenceSnapshot: evidenceSnapshot([
    pageEvidence({ summary: 'Application form audited, but required-field coverage is untrusted.', pageType: 'form' }),
  ]),
})
assert.equal(fillFormUntrustedMissingRequired.targetStateReached, false)
assert.match(fillFormUntrustedMissingRequired.missingEvidence.join(' '), /missingRequired may be incomplete/)
assert.match(fillFormUntrustedMissingRequired.missingEvidence.join(' '), /browser_form_audit/)

const fillFormRequiredSelectPlaceholder = evaluateTaskCompletion({
  taskType: 'fill_form',
  page: pageState({ pageType: 'form', textSummary: 'Application form' }),
  form: formState({
    visibleErrors: [],
    formCoverage: coverage(true),
    fields: [requiredSelectPlaceholder('Preferred role track *')],
    missingRequired: [requiredSelectPlaceholder('Preferred role track *')],
    filledFields: [],
  }),
  fillLedgerSummary: ledger({ total: 1, verified: 1 }),
  evidenceSnapshot: evidenceSnapshot([
    pageEvidence({ summary: 'Application form audited to bottom.', pageType: 'form' }),
  ]),
})
assert.equal(fillFormRequiredSelectPlaceholder.targetStateReached, false)
assert.match(fillFormRequiredSelectPlaceholder.missingEvidence.join(' '), /Preferred role track/)

const fillFormPermissionTextIsNotExternalBlocker = evaluateTaskCompletion({
  taskType: 'fill_form',
  page: pageState({ pageType: 'form', textSummary: 'Permission wall text appears near the form.' }),
  form: formState({ visibleErrors: [], formCoverage: coverage(true) }),
  fillLedgerSummary: ledger(),
  evidenceSnapshot: evidenceSnapshot([
    pageEvidence({ summary: 'Form page contains permission wall text.', pageType: 'form' }),
  ]),
})
assert.equal(fillFormPermissionTextIsNotExternalBlocker.targetStateReached, true)
assert.equal(fillFormPermissionTextIsNotExternalBlocker.externalBlockerVisible, false)

const finalReviewBoundary = evaluateTaskCompletion({
  taskType: 'final_review',
  page: pageState({ pageType: 'confirmation', textSummary: 'Review details before final submit.' }),
  form: formState({ submitCandidates: [{ tag: 'button', text: 'Submit application', risk: 'L4', visible: true }] }),
  summary: 'Ready for final submit.',
  evidenceSnapshot: evidenceSnapshot([
    pageEvidence({ summary: 'Final submission page.', pageType: 'confirmation' }),
  ]),
})
assert.equal(finalReviewBoundary.targetStateReached, false)
assert.equal(finalReviewBoundary.externalBlockerVisible, true)
assert.match(finalReviewBoundary.missingEvidence.join(' '), /human takeover/i)

console.log('task-completion tests passed')

function pageState(overrides = {}) {
  return {
    schemaVersion: 'page-state/v1',
    url: 'https://example.test/jobs/1',
    title: 'Example',
    pageType: 'unknown',
    interactiveCount: 0,
    formCount: 0,
    linkCount: 0,
    buttonCount: 0,
    inputCount: 0,
    textSummary: '',
    updatedAt: '2026-07-07T00:00:00.000Z',
    ...overrides,
  }
}

function formState(overrides = {}) {
  return {
    schemaVersion: 'form-state/v1',
    url: 'https://example.test/jobs/1/apply',
    fields: [],
    missingRequired: [],
    filledFields: [],
    submitCandidates: [],
    uploadHints: [],
    visibleErrors: [],
    updatedAt: '2026-07-07T00:00:00.000Z',
    ...overrides,
  }
}

function field(label) {
  return {
    index: 0,
    label,
    required: true,
    filled: true,
    disabled: false,
    readonly: false,
    invalid: false,
  }
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

function coverage(scrolledBottom, overrides = {}) {
  return {
    schemaVersion: 'form-coverage/v1',
    scope: 'full_audit',
    complete: scrolledBottom,
    scrolledTop: true,
    scrolledBottom,
    segments: 2,
    totalFieldsSeen: 3,
    fieldLimit: 240,
    fieldLimitReached: false,
    auditTool: 'browser_form_audit',
    updatedAt: '2026-07-07T00:00:00.000Z',
    ...overrides,
  }
}

function ledger(overrides = {}) {
  return {
    schemaVersion: 'fill-ledger-summary/v1',
    total: 0,
    verified: 0,
    failed: 0,
    needsUser: 0,
    skipped: 0,
    pendingRequired: 0,
    updatedAt: '2026-07-07T00:00:00.000Z',
    ...overrides,
  }
}

function pageEvidence({ summary, pageType }) {
  return {
    schemaVersion: 'workflow-evidence/v1',
    id: `ev-${pageType}-${Math.random().toString(36).slice(2)}`,
    kind: 'page',
    summary,
    source: 'test',
    confidence: 'high',
    ts: '2026-07-07T00:00:00.000Z',
    data: { pageType },
  }
}

function evidenceSnapshot(evidence) {
  const byKind = {}
  const countsByKind = {}
  for (const item of evidence) {
    byKind[item.kind] = [...(byKind[item.kind] ?? []), item]
    countsByKind[item.kind] = (countsByKind[item.kind] ?? 0) + 1
  }
  return {
    schemaVersion: 'evidence-store-snapshot/v1',
    version: 1,
    generatedAt: '2026-07-07T00:00:00.000Z',
    total: evidence.length,
    kinds: Object.keys(countsByKind),
    countsByKind,
    evidence,
    byKind,
    all: evidence,
  }
}
