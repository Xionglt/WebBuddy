#!/usr/bin/env node
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ContextManager } from '../dist/context/context-manager.js'
import { observationManager } from '../dist/observation/observation-manager.js'

const root = mkdtempSync(join(tmpdir(), 'mfa-context-manager-'))

try {
  const poisonedArtifactDir = join(root, 'artifacts')
  mkdirSync(poisonedArtifactDir, { recursive: true })
  const poisonedPageArtifact = join(poisonedArtifactDir, 'page-state-latest.json')
  const poisonedFormArtifact = join(poisonedArtifactDir, 'form-state-latest.json')
  writeFileSync(poisonedPageArtifact, JSON.stringify({ schemaVersion: 'page-state/v1', title: 'POISON ARTIFACT' }))
  writeFileSync(poisonedFormArtifact, JSON.stringify({ schemaVersion: 'form-state/v1', fields: [{ label: 'POISON FIELD' }] }))
  assert(existsSync(poisonedPageArtifact), 'test artifact should exist')

  const pageState = {
    schemaVersion: 'page-state/v1',
    url: 'https://example.test/apply',
    title: 'Mock Application Page',
    pageType: 'form',
    interactiveCount: 4,
    formCount: 1,
    linkCount: 1,
    buttonCount: 1,
    inputCount: 2,
    textSummary: 'Mock page text from provider memory.',
    updatedAt: '2026-06-25T00:00:00.000Z',
  }
  const formState = {
    schemaVersion: 'form-state/v1',
    url: pageState.url,
    fields: [
      field(0, 'Name', 'Zhang San', true),
      field(1, 'Email', '', true),
    ],
    filledFields: [field(0, 'Name', 'Zhang San', true)],
    missingRequired: [field(1, 'Email', '', true)],
    submitCandidates: [{ tag: 'button', type: 'submit', text: 'Submit application', risk: 'L3', visible: true }],
    updatedAt: '2026-06-25T00:00:00.000Z',
  }
  const taskState = {
    schemaVersion: 'task-state/v1',
    goal: 'Fill the current form.',
    phase: 'filling',
    knownBlockers: ['Email is missing'],
    completionCriteria: ['Required fields are filled', 'Final submit is not clicked'],
    updatedAt: '2026-06-25T00:00:30.000Z',
  }
  const workflowState = {
    schemaVersion: 'workflow-state/v1',
    phase: 'filling_application',
    confidence: 'medium',
    reason: 'Application fields are present.',
    updatedAt: '2026-06-25T00:00:30.000Z',
  }
  const fieldPlan = {
    schemaVersion: 'field-plan/v1',
    planned: [
      {
        fieldKey: 'email',
        fieldIndex: 1,
        label: 'Email',
        controlKind: 'text',
        required: true,
        intendedValue: 'zhangsan@example.com',
        valueSource: 'resume',
        sourceRef: 'contact.email',
        confidence: 0.97,
      },
    ],
    sourceFormUrl: pageState.url,
    fieldCount: 2,
    updatedAt: '2026-06-25T00:00:31.000Z',
  }
  const fillLedgerSummary = {
    schemaVersion: 'fill-ledger-summary/v1',
    total: 1,
    verified: 0,
    failed: 0,
    needsUser: 0,
    skipped: 0,
    pendingRequired: 1,
    updatedAt: '2026-06-25T00:00:32.000Z',
  }
  const answerSummary = '- field=Email | answer=zhangsan@example.com | source=ask_user | at=2026-06-25T00:00:33.000Z'

  const provider = {
    getPageState(sessionId) {
      assert.equal(sessionId, 'ctx-test')
      return pageState
    },
    getFormState(sessionId) {
      assert.equal(sessionId, 'ctx-test')
      return formState
    },
  }

  const manager = new ContextManager({ observationProvider: provider, maxRecentActions: 2 })
  const snapshot = await manager.createSnapshot({
    sessionId: 'ctx-test',
    goal: 'Fill the current form.',
    resumeSummary: 'name: Zhang San\nemail: zhangsan@example.com',
    recentActions: [
      recent(1, 'browser_snapshot'),
      recent(2, 'browser_type'),
      recent(3, 'browser_form_snapshot'),
    ],
    safetyNotes: ['Do not submit final applications.'],
    blockers: ['captcha not present'],
    taskState,
    workflowState,
    fieldPlan,
    fillLedgerSummary,
    answerSummary,
    updatedAt: '2026-06-25T00:01:00.000Z',
  })

  assert.equal(snapshot.schemaVersion, 'context-snapshot/v1')
  assert.equal(snapshot.sessionId, 'ctx-test')
  assert.equal(snapshot.page?.title, 'Mock Application Page')
  assert.equal(snapshot.form?.filledFields[0]?.value, 'Zhang San')
  assert.equal(snapshot.form?.missingRequired[0]?.label, 'Email')
  assert.equal(snapshot.recentActions.length, 2)
  assert.deepEqual(snapshot.recentActions.map((action) => action.toolName), ['browser_type', 'browser_form_snapshot'])
  assert.equal(snapshot.safetyNotes[0], 'Do not submit final applications.')
  assert.equal(snapshot.blockers[0], 'captcha not present')
  assert.deepEqual(snapshot.taskState, taskState)
  assert.deepEqual(snapshot.workflowState, workflowState)
  assert.deepEqual(snapshot.fieldPlan, fieldPlan)
  assert.deepEqual(snapshot.fillLedgerSummary, fillLedgerSummary)
  assert.equal(snapshot.answerSummary, answerSummary)
  assert.equal(snapshot.freshness.staleAfterMs, 30_000)
  assert.equal(snapshot.freshness.pageStateUpdatedAt, pageState.updatedAt)
  assert.equal(snapshot.freshness.formStateUpdatedAt, formState.updatedAt)
  assert.equal(snapshot.freshness.pageStateAgeMs, 60_000)
  assert.equal(snapshot.freshness.formStateAgeMs, 60_000)
  assert.equal(snapshot.freshness.pageStateStale, true)
  assert.equal(snapshot.freshness.formStateStale, true)

  const overrideSnapshot = await new ContextManager({ observationProvider: provider, staleAfterMs: 120_000 }).createSnapshot({
    sessionId: 'ctx-test',
    goal: 'Fill the current form.',
    resumeSummary: 'name: Zhang San\nemail: zhangsan@example.com',
    updatedAt: '2026-06-25T00:01:00.000Z',
  })
  assert.equal(overrideSnapshot.freshness.staleAfterMs, 120_000)
  assert.equal(overrideSnapshot.freshness.pageStateAgeMs, 60_000)
  assert.equal(overrideSnapshot.freshness.formStateAgeMs, 60_000)
  assert.equal(overrideSnapshot.freshness.pageStateStale, false)
  assert.equal(overrideSnapshot.freshness.formStateStale, false)

  const serialized = JSON.stringify(snapshot)
  assert(!serialized.includes('POISON ARTIFACT'), 'ContextManager must ignore trace artifact page files')
  assert(!serialized.includes('POISON FIELD'), 'ContextManager must ignore trace artifact form files')

  const defaultSessionId = 'ctx-default-provider'
  observationManager.refreshPageState({ sessionId: defaultSessionId, snapshot: pageSnapshot('Default Provider Page') })
  const defaultSnapshot = await new ContextManager().createSnapshot({
    sessionId: defaultSessionId,
    goal: 'Use default provider.',
    resumeSummary: 'name: Default',
  })
  assert.equal(defaultSnapshot.page?.title, 'Default Provider Page')
  assert.equal(defaultSnapshot.form?.schemaVersion, 'form-state/v1')

  console.log('context-manager-test: PASS')
} finally {
  rmSync(root, { recursive: true, force: true })
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

function recent(step, toolName) {
  return {
    step,
    toolName,
    argumentsSummary: `ref=e${step}`,
    status: 'ok',
    observation: `observation ${step}`,
    at: `2026-06-25T00:00:0${step}.000Z`,
  }
}

function pageSnapshot(title) {
  return {
    snapshotId: 'snap_context_default',
    url: 'https://example.test/default',
    title,
    textSummary: 'Default provider page text.',
    elements: [
      {
        ref: 'e1',
        tag: 'input',
        role: 'textbox',
        name: 'Name',
        text: 'Name',
        value: '',
        visible: true,
        disabled: false,
        risk: 'L2',
        locatorHints: {},
        fingerprint: {},
      },
      {
        ref: 'e2',
        tag: 'button',
        role: 'button',
        name: 'Submit application',
        text: 'Submit application',
        visible: true,
        disabled: false,
        risk: 'L3',
        locatorHints: {},
        fingerprint: {},
      },
    ],
    stats: {
      elementCount: 2,
      interactiveCount: 2,
      formCount: 1,
      linkCount: 0,
      buttonCount: 1,
      inputCount: 1,
      truncated: false,
    },
  }
}
