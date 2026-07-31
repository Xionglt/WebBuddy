#!/usr/bin/env node
import assert from 'node:assert/strict'
import { jobApplicationWorkflowDefinition } from '../dist/workflow/workflow-definition.js'
import { WorkflowEngine } from '../dist/workflow/workflow-engine.js'
import { createInitialWorkflowState } from '../dist/workflow/workflow-state.js'
import { guardWorkflowTransition } from '../dist/workflow/workflow-transition-guard.js'

const now = '2026-07-28T00:00:00.000Z'
const initial = createInitialWorkflowState(now)

const declared = guardWorkflowTransition({
  previous: initial,
  candidate: state('external_blocker'),
  definition: jobApplicationWorkflowDefinition,
  hasFreshObservation: false,
})
assert.equal(declared.disposition, 'allowed')
assert.equal(declared.state.phase, 'external_blocker')

const rejected = guardWorkflowTransition({
  previous: state('external_blocker'),
  candidate: state('final_submit_boundary'),
  definition: jobApplicationWorkflowDefinition,
  hasFreshObservation: false,
})
assert.equal(rejected.disposition, 'rejected')
assert.equal(rejected.state.phase, 'external_blocker')

const reconciled = guardWorkflowTransition({
  previous: state('external_blocker'),
  candidate: state('final_submit_boundary'),
  definition: jobApplicationWorkflowDefinition,
  hasFreshObservation: true,
})
assert.equal(reconciled.disposition, 'reconciled')
assert.equal(reconciled.state.phase, 'final_submit_boundary')
assert.match(reconciled.state.reason, /fresh page\/form evidence/i)

const terminal = guardWorkflowTransition({
  previous: state('done'),
  candidate: state('in_target_flow'),
  definition: jobApplicationWorkflowDefinition,
  hasFreshObservation: true,
})
assert.equal(terminal.disposition, 'rejected')
assert.equal(terminal.state.phase, 'done')

const resumedBlocked = guardWorkflowTransition({
  previous: state('blocked'),
  candidate: state('in_target_flow'),
  definition: jobApplicationWorkflowDefinition,
  hasFreshObservation: true,
})
assert.equal(resumedBlocked.disposition, 'reconciled')
assert.equal(resumedBlocked.state.phase, 'in_target_flow')

const engineGuard = new WorkflowEngine().evaluate({
  previous: state('done'),
  page: {
    schemaVersion: 'page-state/v1',
    url: 'https://example.test/login',
    title: 'Login',
    pageType: 'login',
    interactiveCount: 1,
    formCount: 1,
    linkCount: 0,
    buttonCount: 1,
    inputCount: 1,
    textSummary: 'Please sign in to continue.',
    updatedAt: now,
  },
  now,
})
assert.equal(engineGuard.state.phase, 'done', 'WorkflowEngine must apply the transition guard')
assert.equal(engineGuard.transitionGuard.disposition, 'rejected')
assert(engineGuard.blockers.some((blocker) => blocker.kind === 'invalid_transition'))

console.log('workflow-transition-guard-test: PASS')

function state(phase) {
  return {
    schemaVersion: 'workflow-state/v1',
    phase,
    confidence: 'high',
    reason: `candidate ${phase}`,
    updatedAt: now,
  }
}
