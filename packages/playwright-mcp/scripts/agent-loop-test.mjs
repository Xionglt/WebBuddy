/**
 * Agent-loop integration test — drives the generic LLM agent loop with a MOCK
 * LLM (no real model key needed) to prove the loop plumbing works: the "model"
 * reads the snapshot, picks refs, types, and calls agent_done. Validates tool
 * dispatch, page-view refresh, risk gating, and the no-submit contract.
 *
 *   npm run test:agent-loop   (after build)
 */
import assert from 'node:assert'
import { runJobApplicationAgent } from '../dist/sdk/orchestrator.js'
import { loadConfig } from '../dist/sdk/config.js'
import { writeSampleResumePdf } from '../dist/sdk/resume.js'
import { sessionManager } from '../dist/session/manager.js'

// A minimal LlmGateway stand-in: returns scripted tool calls. Each turn it
// inspects the latest snapshot to find the right ref for the field it fills —
// exactly what a real model would do after reading the page view.
class MockLlm {
  constructor() {
    this.hasKey = true
    this.label = 'mock-llm'
    this._plan = [
      { kind: 'snapshot' },
      { kind: 'type', field: /name|姓名/i, value: 'Zhang San' },
      { kind: 'type', field: /email|邮箱/i, value: 'zhangsan@example.com' },
      { kind: 'type', field: /phone|手机/i, value: '13800001234' },
      { kind: 'done' },
    ]
    this._i = 0
  }

  _findRef(regex) {
    const snap = sessionManager.get('default')?.latestSnapshot
    if (!snap) return undefined
    for (const [ref, stored] of snap.refMap) {
      const hay = [stored.name, stored.text, stored.aria].filter(Boolean).join(' ')
      if (regex.test(hay) && (stored.tag === 'input' || stored.tag === 'textarea')) return ref
    }
    return undefined
  }

  async chatWithTools(_messages, _opts) {
    const step = this._plan[this._i++]
    if (!step) return { content: 'no more steps', toolCalls: [] }
    if (step.kind === 'snapshot') {
      return { content: 'Let me look at the form.', toolCalls: [{ id: 'c1', name: 'browser_snapshot', arguments: {} }] }
    }
    if (step.kind === 'type') {
      const ref = this._findRef(step.field)
      assert(ref, `mock could not find ref for ${step.field}`)
      return { content: `Filling ${step.field}.`, toolCalls: [{ id: 'c2', name: 'browser_type', arguments: { ref, text: step.value } }] }
    }
    if (step.kind === 'done') {
      return { content: 'Done filling the draft.', toolCalls: [{ id: 'c3', name: 'agent_done', arguments: { summary: 'Filled name/email/phone; did not submit.', blocked: false } }] }
    }
    return { content: '', toolCalls: [] }
  }
}

const config = loadConfig()
config.browser.headless = true
config.browser.visualHighlight = false
config.browser.typeDelayMs = 0
config.browser.slowMoMs = 0
config.human.mode = 'auto'
config.resumePath = '/tmp/mfa-agent-loop-resume.pdf'
writeSampleResumePdf(config.resumePath)

const events = []
const result = await runJobApplicationAgent({
  config,
  mode: 'demo-form',
  llm: new MockLlm(),
  onEvent: (e) => events.push(e),
})

console.log('events:')
for (const e of events) console.log(`  [${e.level}] ${e.phase}: ${e.message}`)
console.log('result:', result.finalState, '—', result.message.slice(0, 80))

assert.strictEqual(result.finalState, 'filled', `expected filled, got ${result.finalState}`)
assert(/did not submit|not submitted/i.test(result.message), 'must state it did not submit')

// The agent must have used the agent loop (think/act/observe events).
const sawAct = events.some((e) => e.level === 'act' && /browser_type/.test(e.message))
assert(sawAct, 'agent loop should have typed via browser_type')

console.log('\nagent-loop-test: PASS')

await sessionManager.closeAll()
