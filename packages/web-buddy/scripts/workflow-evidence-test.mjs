#!/usr/bin/env node
import assert from 'node:assert/strict'
import { jobApplicationWorkflowDefinition } from '../dist/workflow/workflow-definition.js'
import { EvidenceStore } from '../dist/workflow/workflow-evidence.js'

const workflowPhases = [
  'in_target_flow',
  'external_blocker',
  'final_submit_boundary',
  'done',
  'blocked',
]

assert.equal(jobApplicationWorkflowDefinition.schemaVersion, 'workflow-definition/v1')
assert.equal(jobApplicationWorkflowDefinition.id, 'job-application')
assert.equal(jobApplicationWorkflowDefinition.initialPhase, 'in_target_flow')
assert.deepEqual(jobApplicationWorkflowDefinition.terminalPhases, ['done', 'blocked'])
assert.deepEqual(
  jobApplicationWorkflowDefinition.phases.map((phase) => phase.id),
  workflowPhases,
  'built-in workflow should expose only the five observation phases',
)
assert.deepEqual(
  jobApplicationWorkflowDefinition.phases.map((phase) => phase.phase),
  workflowPhases,
  'phase aliases should also expose only the five observation phases',
)

const finalSubmitPhase = jobApplicationWorkflowDefinition.phases.find((phase) => phase.id === 'final_submit_boundary')
assert(finalSubmitPhase, 'final_submit_boundary phase should exist')
assert.equal(finalSubmitPhase.humanHandoffRequired, true)
assert(finalSubmitPhase.requiredEvidenceKinds.includes('policy'))

const doneCriterion = jobApplicationWorkflowDefinition.completionCriteria.find(
  (criterion) => criterion.id === 'done-requires-explicit-completion-evidence',
)
assert(doneCriterion, 'done completion criterion should exist')
assert.equal(doneCriterion.kind, 'evidence_required')
assert.equal(doneCriterion.phase, 'done')
assert.deepEqual(doneCriterion.evidenceKinds, ['tool_result', 'user_confirm'])
assert.equal(doneCriterion.required, true)

const times = [
  '2026-06-29T00:00:00.000Z',
  '2026-06-29T00:00:01.000Z',
  '2026-06-29T00:00:02.000Z',
  '2026-06-29T00:00:03.000Z',
  '2026-06-29T00:00:04.000Z',
]
let cursor = 0
const store = new EvidenceStore({
  now: () => new Date(times[cursor++] ?? times.at(-1)),
})

const pageEvidence = store.add({
  kind: 'page',
  summary: 'Application form page is visible.',
  source: 'browser_snapshot',
  confidence: 'high',
  phase: 'in_target_flow',
  sessionId: 'session-1',
  runId: 'run-1',
  data: { url: 'https://example.test/apply' },
})

assert.equal(pageEvidence.schemaVersion, 'workflow-evidence/v1')
assert.equal(pageEvidence.id, 'evid_page_0001')
assert.equal(pageEvidence.ts, '2026-06-29T00:00:00.000Z')
assert.equal(pageEvidence.confidence, 'high')
assert.equal(pageEvidence.phase, 'in_target_flow')

pageEvidence.summary = 'mutated outside store'
pageEvidence.data.url = 'https://example.test/mutated'
assert.equal(store.list()[0].summary, 'Application form page is visible.')
assert.equal(store.list()[0].data.url, 'https://example.test/apply')

const formEvidence = store.add({
  id: 'form-evidence-1',
  kind: 'form',
  summary: 'Required application fields are filled.',
  source: 'browser_form_snapshot',
  phase: 'in_target_flow',
  metadata: { fieldCount: 8, missingRequiredCount: 0 },
})

assert.equal(formEvidence.id, 'form-evidence-1')
assert.equal(formEvidence.confidence, 'medium', 'EvidenceStore should default confidence to medium')
assert.equal(formEvidence.ts, '2026-06-29T00:00:01.000Z')

const duplicate = store.add({
  id: 'form-evidence-1',
  kind: 'form',
  summary: 'Duplicate should not replace original evidence.',
  source: 'test',
})
assert.equal(duplicate.summary, 'Required application fields are filled.')
assert.equal(store.list().length, 2)

assert.equal(store.byKind('page').length, 1)
assert.equal(store.byKind('form').length, 1)
assert.equal(store.byKind('policy').length, 0)

const workflowStateData = {
  state: {
    phase: 'done',
    blocker: undefined,
    criteria: [{ id: 'done-requires-explicit-completion-evidence', status: 'matched' }],
  },
  nested: {
    evidenceIds: ['ev-tool-done', 'ev-user-confirm'],
  },
}
const workflowStateMetadata = {
  completion: {
    missingEvidenceKinds: [],
  },
}
const workflowStateEvidence = store.add({
  kind: 'workflow_state',
  summary: 'Workflow reached done with explicit evidence.',
  source: 'workflow_engine',
  confidence: 'high',
  phase: 'done',
  data: workflowStateData,
  metadata: workflowStateMetadata,
})
workflowStateData.state.phase = 'mutated input'
workflowStateData.nested.evidenceIds.push('mutated-input')
workflowStateMetadata.completion.missingEvidenceKinds.push('mutated-input')
workflowStateEvidence.data.state.phase = 'mutated returned evidence'
workflowStateEvidence.data.nested.evidenceIds.push('mutated-return')
workflowStateEvidence.metadata.completion.missingEvidenceKinds.push('mutated-return')

const storedWorkflowEvidence = store.byKind('workflow_state')[0]
assert.equal(storedWorkflowEvidence.id, 'evid_workflow_state_0002')
assert.equal(storedWorkflowEvidence.ts, '2026-06-29T00:00:02.000Z')
assert.equal(storedWorkflowEvidence.data.state.phase, 'done')
assert.deepEqual(storedWorkflowEvidence.data.nested.evidenceIds, ['ev-tool-done', 'ev-user-confirm'])
assert.deepEqual(storedWorkflowEvidence.metadata.completion.missingEvidenceKinds, [])

const snapshot = store.snapshot()
assert.equal(snapshot.schemaVersion, 'evidence-store-snapshot/v1')
assert.equal(snapshot.version, 1)
assert.equal(snapshot.generatedAt, '2026-06-29T00:00:03.000Z')
assert.equal(snapshot.total, 3)
assert.deepEqual(snapshot.kinds, ['page', 'form', 'workflow_state'])
assert.deepEqual(snapshot.countsByKind, { page: 1, form: 1, workflow_state: 1 })
assert.equal(snapshot.evidence.length, 3)
assert.equal(snapshot.all.length, 3)
assert.equal(snapshot.byKind.page.length, 1)
assert.equal(snapshot.byKind.form.length, 1)
assert.equal(snapshot.byKind.workflow_state.length, 1)

snapshot.evidence[0].summary = 'mutated snapshot'
snapshot.byKind.page[0].summary = 'mutated snapshot group'
snapshot.byKind.workflow_state[0].data.state.phase = 'mutated snapshot nested data'
snapshot.byKind.workflow_state[0].metadata.completion.missingEvidenceKinds.push('mutated-snapshot')
assert.equal(store.list()[0].summary, 'Application form page is visible.')
assert.equal(store.byKind('workflow_state')[0].data.state.phase, 'done')
assert.deepEqual(store.byKind('workflow_state')[0].metadata.completion.missingEvidenceKinds, [])

console.log('workflow-evidence-test: PASS')
