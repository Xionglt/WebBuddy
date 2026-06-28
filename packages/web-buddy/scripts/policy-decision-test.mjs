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
assert.equal(finalSubmit.schemaVersion, 'policy-decision/v1')
assert.equal(finalSubmit.policyCode, 'policy.high_risk.gate')
assert.equal(finalSubmit.ruleId, 'policy.high_risk.gate.v1')
assert(finalSubmit.auditTags.includes('gate:final_submit'))

const applyEntry = decideToolPolicy({
  toolName: 'browser_click_text',
  args: { text: 'Apply' },
  risk: 'L3',
  safetyMode: 'guarded',
  workflowPhase: 'job_detail',
})
assert.equal(applyEntry.action, 'gate')
assert.equal(applyEntry.gateKind, 'high_risk_action')
assert.equal(applyEntry.policyCode, 'policy.workflow.apply_entry')

const applicationEntry = decideToolPolicy({
  toolName: 'browser_click_text',
  args: { text: '立即投递' },
  risk: 'L3',
  safetyMode: 'guarded',
  workflowState: {
    schemaVersion: 'workflow-state/v1',
    phase: 'entering_application',
    confidence: 'medium',
    reason: 'Opening application flow.',
    updatedAt: '2026-06-26T00:00:00.000Z',
  },
})
assert.equal(applicationEntry.gateKind, 'high_risk_action')

const workflowFinalSubmit = decideToolPolicy({
  toolName: 'browser_click_text',
  args: { text: 'Submit application' },
  risk: 'L3',
  safetyMode: 'guarded',
  workflowPhase: 'ready_for_final_submit',
})
assert.equal(workflowFinalSubmit.gateKind, 'final_submit')
assert.equal(workflowFinalSubmit.policyCode, 'policy.workflow.final_submit')

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
assert.equal(rawSubmit.policyCode, 'policy.raw.auto_confirm')

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
assert.equal(staleSubmit.policyCode, 'policy.freshness.high_risk_stale')

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
