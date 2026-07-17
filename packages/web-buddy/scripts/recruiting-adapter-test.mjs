#!/usr/bin/env node
import assert from 'node:assert/strict'
import { runRecruitingCompatibilityTask, legacyTaskCriteria } from '../dist/scenarios/recruiting/adapter.js'

let calls = 0
const legacy = {
  mode: 'demo-research',
  profile: { name: '', email: '', phone: '', location: '', summary: '', skills: [], experience: [], education: [], keywords: [], source: 'txt' },
  matches: [],
  finalState: 'completed',
  message: 'Legacy research completed.',
  summary: {
    runId: 'compat-run',
    startedAt: '2026-07-17T00:00:00.000Z',
    endedAt: '2026-07-17T00:00:01.000Z',
    steps: 1,
    screenshots: 0,
    finalStatus: 'ok',
    tracePath: 'output/compat-run/trace.jsonl',
  },
}
const result = await runRecruitingCompatibilityTask(
  { mode: 'demo-research', runId: 'compat-run' },
  async (options) => {
    calls += 1
    assert.equal(options.runId, 'compat-run')
    return legacy
  },
)
assert.equal(calls, 1, 'compatibility adapter must execute exactly one legacy workflow')
assert.deepEqual(result, legacy, 'legacy result shape and values must remain compatible')
assert.equal(legacyTaskCriteria('explore')[0].kind, 'evidence_present')
assert.equal(legacyTaskCriteria('fill_form')[0].id, 'legacy-form-draft')
assert.equal(legacyTaskCriteria('final_review')[0].kind, 'human_confirmation')

console.log('recruiting-adapter-test: PASS')
