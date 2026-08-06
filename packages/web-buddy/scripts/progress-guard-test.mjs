#!/usr/bin/env node
import assert from 'node:assert/strict'
import { AgentProgressGuard } from '../dist/runtime/local/progress-guard.js'

const stable = context('https://example.test/apply', 'in_target_flow', '')
const filled = context('https://example.test/apply', 'in_target_flow', 'Zhang San')
const call = {
  id: 'call-1',
  name: 'resume_query',
  arguments: { query: 'profile', timeoutMs: 1000 },
}
const sameCallWithOperationalChanges = {
  ...call,
  id: 'call-2',
  arguments: { query: 'profile', timeoutMs: 5000 },
}
const failure = {
  ok: false,
  pageChanged: false,
  done: false,
  observation: 'FAILED (TOOL_TIMEOUT): upstream timed out',
}

const guard = new AgentProgressGuard({ repeatThreshold: 2, maxReplans: 1 })
assert.equal(guard.beforeCall(call, stable).action, 'allow')
guard.record(call, stable, stable, failure)
assert.equal(guard.beforeCall(call, stable).action, 'allow')
guard.record(sameCallWithOperationalChanges, stable, stable, failure)

const replan = guard.beforeCall(call, stable)
assert.equal(replan.action, 'replan')
assert.equal(replan.repeats, 2)

const blocked = guard.beforeCall(call, stable)
assert.equal(blocked.action, 'block')
assert.equal(blocked.repeats, 2)

guard.record(call, stable, filled, { ...failure, ok: true, observation: 'Filled name.' })
assert.equal(guard.beforeCall(call, filled).action, 'allow', 'state progress must reset the loop streak')

const observationGuard = new AgentProgressGuard({ repeatThreshold: 2 })
observationGuard.record(call, stable, stable, failure)
observationGuard.record(call, stable, stable, { ...failure, observation: 'FAILED (RATE_LIMIT): retry later' })
assert.equal(
  observationGuard.beforeCall(call, stable).action,
  'allow',
  'a new observation must reset the identical-outcome streak',
)

const pollingGuard = new AgentProgressGuard({ repeatThreshold: 1 })
const snapshot = { id: 'snapshot', name: 'browser_snapshot', arguments: {} }
pollingGuard.record(snapshot, stable, stable, { ok: true, pageChanged: false, observation: 'same page' })
assert.equal(pollingGuard.beforeCall(snapshot, stable).action, 'allow', 'observation tools are exempt')

console.log('progress-guard-test: PASS')

function context(url, workflowPhase, nameValue) {
  return {
    url,
    workflowPhase,
    page: {
      schemaVersion: 'page-state/v1',
      url,
      title: 'Application',
      pageType: 'form',
      interactiveCount: 1,
      formCount: 1,
      linkCount: 0,
      buttonCount: 1,
      inputCount: 1,
      textSummary: 'Application form',
      updatedAt: '2026-07-28T00:00:00.000Z',
    },
    form: {
      schemaVersion: 'form-state/v1',
      url,
      fields: [{
        index: 0,
        fieldKey: 'name',
        label: 'Name',
        value: nameValue,
        required: true,
        filled: Boolean(nameValue),
        disabled: false,
        readonly: false,
        invalid: !nameValue,
      }],
      missingRequired: nameValue ? [] : [{ index: 0, fieldKey: 'name', label: 'Name' }],
      filledFields: [],
      submitCandidates: [],
      updatedAt: '2026-07-28T00:00:00.000Z',
    },
  }
}
