import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAgentTraceSession } from '../dist/agent-trace/index.js'
import { buildFormState } from '../dist/observation/form-state-builder.js'
import { observationManager } from '../dist/observation/observation-manager.js'
import { buildPageState } from '../dist/observation/page-state.js'
import { detectPageType } from '../dist/observation/page-type-detector.js'

const root = mkdtempSync(join(tmpdir(), 'mfa-observation-'))

try {
  const snapshot = {
    snapshotId: 'snap_test',
    url: 'https://example.test/apply',
    title: 'Apply for Frontend Engineer',
    textSummary: 'Application form for Frontend Engineer. Submit application when complete.',
    elements: [
      element('e1', 'input', 'Name', 'L2'),
      element('e2', 'input', 'Email', 'L2'),
      element('e3', 'button', 'Submit application', 'L3'),
      element('e4', 'a', 'Back to jobs', 'L1'),
    ],
    stats: {
      elementCount: 4,
      interactiveCount: 4,
      formCount: 1,
      linkCount: 1,
      buttonCount: 1,
      inputCount: 2,
      truncated: false,
    },
  }

  const pageState = buildPageState(snapshot, 'form', '2026-06-24T00:00:00.000Z')
  assert.equal(pageState.schemaVersion, 'page-state/v1')
  assert.equal(pageState.pageType, 'form')
  assert.equal(pageState.formCount, 1)
  assert.equal(pageState.inputCount, 2)
  assert.equal(detectPageType(pageState), 'form')
  assert.equal(detectPageType({ title: 'Security check', textSummary: 'Please verify you are human before continuing.' }), 'captcha')

  const formState = buildFormState({
    url: snapshot.url,
    fields: [
      { index: 0, label: 'Name', tag: 'input', type: 'text', value: 'Zhang San', required: true },
      { index: 1, label: 'Email', tag: 'input', type: 'email', value: '', required: true },
      { index: 2, label: 'City', tag: 'select', value: 'hangzhou', required: false, options: [
        { value: 'hangzhou', label: 'Hangzhou', selected: true },
        { value: 'shanghai', label: 'Shanghai', selected: false },
      ] },
      { index: 3, label: 'Portfolio', tag: 'input', type: 'url', value: '', required: false },
    ],
    submitCandidates: [{ tag: 'button', type: 'submit', text: 'Submit application', risk: 'L3', visible: true }],
    uploadHints: [{ tag: 'input', type: 'file', text: '', visible: true, accept: '.pdf' }],
    visibleErrors: ['Email is required'],
  }, '2026-06-24T00:00:00.000Z')
  assert.equal(formState.schemaVersion, 'form-state/v1')
  assert.equal(formState.fields.length, 4)
  assert.equal(formState.filledFields.length, 2)
  assert.equal(formState.missingRequired.length, 1)
  assert.equal(formState.missingRequired[0].label, 'Email')
  assert.equal(formState.submitCandidates[0].risk, 'L3')
  assert.equal(formState.fields[2].options.length, 2)
  assert.equal(formState.fields[2].options[0].selected, true)
  assert.equal(formState.uploadHints.length, 1)
  assert.equal(formState.uploadHints[0].accept, '.pdf')
  assert.deepEqual(formState.visibleErrors, ['Email is required'])

  const trace = createAgentTraceSession({ sessionId: 'obs_test', outDir: root, source: 'observation-test' })
  assert(trace, 'trace should be created for artifact test')

  const observedPage = observationManager.refreshPageState({ sessionId: 'default', snapshot })
  const observedForm = observationManager.refreshFormState({
    sessionId: 'default',
    formSnapshot: {
      url: snapshot.url,
      fields: formState.fields,
      submitCandidates: formState.submitCandidates,
      uploadHints: formState.uploadHints,
      visibleErrors: formState.visibleErrors,
    },
  })

  assert.equal(observedPage.pageType, 'form')
  assert.equal(observedForm.missingRequired.length, 1)

  const artifactsDir = join(root, 'obs_test', 'artifacts')
  const pageArtifact = join(artifactsDir, 'page-state-latest.json')
  const formArtifact = join(artifactsDir, 'form-state-latest.json')
  assert(existsSync(pageArtifact), `expected ${pageArtifact}`)
  assert(existsSync(formArtifact), `expected ${formArtifact}`)
  assert.equal(JSON.parse(readFileSync(pageArtifact, 'utf8')).schemaVersion, 'page-state/v1')
  const artifactFormState = JSON.parse(readFileSync(formArtifact, 'utf8'))
  assert.equal(artifactFormState.schemaVersion, 'form-state/v1')
  assert.equal(artifactFormState.fields[2].options.length, 2)
  assert.equal(artifactFormState.uploadHints[0].accept, '.pdf')
  assert.deepEqual(artifactFormState.visibleErrors, ['Email is required'])
  trace.finalize({ status: 'success' })

  console.log('observation-test: PASS')
} finally {
  rmSync(root, { recursive: true, force: true })
}

function element(ref, tag, name, risk) {
  return {
    ref,
    tag,
    name,
    text: name,
    visible: true,
    risk,
    locatorHints: {},
    fingerprint: {},
  }
}
