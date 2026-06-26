import assert from 'node:assert/strict'
import {
  decideToolPolicy,
  gateKindForTool,
  policyRiskLevel,
  requiresHumanGate,
  shouldStopAfterGateDecision,
} from '../dist/policy/agent-policy.js'

const finalSubmit = decideToolPolicy({
  toolName: 'browser_click_text',
  args: { text: 'Submit application' },
  risk: 'L3',
  safetyMode: 'guarded',
})
assert.equal(finalSubmit.action, 'gate')
assert.equal(finalSubmit.riskLevel, 'high')
assert.equal(finalSubmit.gateKind, 'final_submit')
assert.equal(finalSubmit.requiresFreshContext, true)
assert.match(finalSubmit.reason, /final-submit/i)

const ordinaryClick = decideToolPolicy({
  toolName: 'browser_click_text',
  args: { text: 'Add another experience' },
  risk: 'L1',
  safetyMode: 'guarded',
})
assert.equal(ordinaryClick.action, 'allow')
assert.equal(ordinaryClick.riskLevel, 'low')
assert.equal(ordinaryClick.gateKind, undefined)
assert.equal(ordinaryClick.requiresFreshContext, undefined)

const rawSubmit = decideToolPolicy({
  toolName: 'browser_click_text',
  args: { text: 'Confirm and submit' },
  risk: 'L3',
  safetyMode: 'raw',
})
assert.equal(rawSubmit.action, 'auto_confirm')
assert.equal(rawSubmit.gateKind, 'final_submit')
assert.equal(rawSubmit.requiresFreshContext, true)

const staleSubmit = decideToolPolicy({
  toolName: 'browser_click_text',
  args: { text: 'Submit application' },
  risk: 'L3',
  safetyMode: 'guarded',
  freshness: {
    pageStateStale: false,
    formStateStale: true,
    pageStateAgeMs: 1200,
    formStateAgeMs: 45_000,
    staleAfterMs: 30_000,
  },
})
assert.equal(staleSubmit.action, 'gate')
assert.equal(staleSubmit.gateKind, 'final_submit')
assert.equal(staleSubmit.requiresFreshContext, true)
assert.match(staleSubmit.reason, /stale/i)
assert.match(staleSubmit.reason, /form ageMs=45000/)

assert.equal(
  gateKindForTool({
    toolName: 'browser_click',
    args: { ref: 'e1' },
    currentUrl: 'https://talent-holding.alibaba.com/off-campus/position-detail?lang=zh',
    refLabel: '立即投递',
  }),
  'high_risk_action',
)
assert.equal(
  gateKindForTool({
    toolName: 'browser_click',
    args: { ref: 'e2' },
    currentUrl: 'https://example.com/apply',
    refLabel: 'Publish application',
  }),
  'final_submit',
)

assert.equal(policyRiskLevel('L4'), 'critical')
assert.equal(policyRiskLevel('L2'), 'medium')
assert.equal(requiresHumanGate('L3'), true)
assert.equal(requiresHumanGate('L2'), false)
assert.equal(shouldStopAfterGateDecision('takeover'), true)
assert.equal(shouldStopAfterGateDecision('approve'), false)

console.log('policy-decision-test: PASS')
