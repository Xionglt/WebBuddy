#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createInitialWorkflowState } from '../dist/workflow/workflow-state.js'

const state = createInitialWorkflowState('2026-06-26T00:00:00.000Z')

assert.equal(state.schemaVersion, 'workflow-state/v1')
assert.equal(state.phase, 'in_target_flow')
assert.equal(state.confidence, 'medium')
assert.equal(state.updatedAt, '2026-06-26T00:00:00.000Z')
assert.equal(state.humanHandoffRequired, undefined)
assert.equal(state.blocker, undefined)

console.log('workflow-state-test: PASS')
