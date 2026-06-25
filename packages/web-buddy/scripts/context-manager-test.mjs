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
