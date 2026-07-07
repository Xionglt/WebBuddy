import assert from 'node:assert/strict'
import {
  decideToolPolicy,
  gateKindForTool,
  inferActionIntent,
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
assert.equal(finalSubmit.actionIntent, 'safety_sensitive')
assert.equal(finalSubmit.gateKind, 'final_submit')
assert.equal(finalSubmit.requiresFreshContext, true)
assert.match(finalSubmit.reason, /final submit/i)
assert.equal(finalSubmit.schemaVersion, 'policy-decision/v1')
assert.equal(finalSubmit.policyCode, 'policy.high_risk.gate')
assert.equal(finalSubmit.ruleId, 'policy.high_risk.gate.v1')
assert(finalSubmit.auditTags.includes('intent:safety_sensitive'))
assert(finalSubmit.auditTags.includes('gate:final_submit'))
assert(finalSubmit.auditTags.includes('invariant:no_final_submit'))

const applyEntry = decideToolPolicy({
  toolName: 'browser_click_text',
  args: { text: 'Apply' },
  risk: 'L3',
  safetyMode: 'guarded',
  workflowPhase: 'in_target_flow',
})
assert.equal(applyEntry.action, 'gate')
assert.equal(applyEntry.actionIntent, 'unknown_high_risk')
assert.equal(applyEntry.gateKind, 'high_risk_action')
assert.equal(applyEntry.policyCode, 'policy.high_risk.gate')

const applicationEntry = decideToolPolicy({
  toolName: 'browser_click_text',
  args: { text: '立即投递' },
  risk: 'L3',
  safetyMode: 'guarded',
  workflowState: {
    schemaVersion: 'workflow-state/v1',
    phase: 'in_target_flow',
    confidence: 'medium',
    reason: 'Opening application flow.',
    updatedAt: '2026-06-26T00:00:00.000Z',
  },
})
assert.equal(applicationEntry.actionIntent, 'unknown_high_risk')
assert.equal(applicationEntry.gateKind, 'high_risk_action')

const workflowFinalSubmit = decideToolPolicy({
  toolName: 'browser_click_text',
  args: { text: 'Submit application' },
  risk: 'L3',
  safetyMode: 'guarded',
  workflowPhase: 'final_submit_boundary',
})
assert.equal(workflowFinalSubmit.gateKind, 'final_submit')
assert.equal(workflowFinalSubmit.actionIntent, 'safety_sensitive')
assert.equal(workflowFinalSubmit.policyCode, 'policy.high_risk.gate')

const ordinaryClick = decideToolPolicy({
  toolName: 'browser_click_text',
  args: { text: 'Add another experience' },
  risk: 'L1',
  safetyMode: 'guarded',
})
assert.equal(ordinaryClick.action, 'allow')
assert.equal(ordinaryClick.riskLevel, 'low')
assert.equal(ordinaryClick.actionIntent, 'state_change')
assert.equal(ordinaryClick.gateKind, undefined)
assert.equal(ordinaryClick.requiresFreshContext, undefined)

const rawSubmit = decideToolPolicy({
  toolName: 'browser_click_text',
  args: { text: 'Confirm and submit' },
  risk: 'L3',
  safetyMode: 'raw',
})
assert.equal(rawSubmit.action, 'gate')
assert.equal(rawSubmit.actionIntent, 'safety_sensitive')
assert.equal(rawSubmit.gateKind, 'final_submit')
assert.equal(rawSubmit.requiresFreshContext, true)
assert.equal(rawSubmit.policyCode, 'policy.high_risk.gate')

const rawHighRiskClick = decideToolPolicy({
  toolName: 'browser_click',
  args: { ref: 'job-apply' },
  refLabel: 'Apply now',
  risk: 'L4',
  safetyMode: 'raw',
  workflowPhase: 'in_target_flow',
})
assert.equal(rawHighRiskClick.action, 'gate')
assert.equal(rawHighRiskClick.riskLevel, 'critical')
assert.equal(rawHighRiskClick.actionIntent, 'unknown_high_risk')
assert.equal(rawHighRiskClick.policyCode, 'policy.high_risk.gate')

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
assert.equal(staleSubmit.action, 'block')
assert.equal(staleSubmit.actionIntent, 'safety_sensitive')
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
    workflowPhase: 'final_submit_boundary',
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

assert.equal(
  inferActionIntent({
    toolName: 'browser_click',
    args: { ref: 'e3' },
    currentUrl: 'https://talent-holding.alibaba.com/off-campus/position-detail?lang=zh',
    refLabel: '投递',
    contextText: '温馨提示：你暂未申请职位，本月能申请5个职位，请慎重选择！ 取消 投递',
    workflowPhase: 'final_submit_boundary',
  }),
  'safety_sensitive',
)
assert.equal(
  inferActionIntent({
    toolName: 'browser_click',
    args: { ref: 'e4' },
    currentUrl: 'https://talent-holding.alibaba.com/off-campus/position-detail?lang=zh',
    refLabel: '投递',
    contextText: '职位详情 投递简历 取消 投递',
    workflowPhase: 'final_submit_boundary',
  }),
  'state_change',
)
assert.equal(
  inferActionIntent({
    toolName: 'browser_click_text',
    args: { text: '投递简历' },
    currentUrl: 'https://talent-holding.alibaba.com/off-campus/position-detail?lang=zh',
    workflowPhase: 'final_submit_boundary',
  }),
  'state_change',
)
assert.equal(
  inferActionIntent({
    toolName: 'browser_click_text',
    args: { text: '完成投递' },
    currentUrl: 'https://talent-holding.alibaba.com/off-campus/position-detail?lang=zh',
    workflowPhase: 'in_target_flow',
  }),
  'safety_sensitive',
)
assert.equal(
  inferActionIntent({
    toolName: 'browser_upload_file',
    args: { filePath: '/tmp/resume.pdf', text: '投递简历' },
    risk: 'L4',
  }),
  'safety_sensitive',
)
assert.equal(
  inferActionIntent({
    toolName: 'browser_upload_file',
    args: { filePath: '/tmp/resume.pdf', text: '上传简历' },
    risk: 'L4',
  }),
  'safety_sensitive',
)

assert.equal(policyRiskLevel('L4'), 'critical')
assert.equal(policyRiskLevel('L2'), 'medium')
assert.equal(requiresHumanGate('L3'), true)
assert.equal(requiresHumanGate('L2'), false)
assert.equal(shouldStopAfterGateDecision('takeover'), true)
assert.equal(shouldStopAfterGateDecision('approve'), false)

console.log('policy-decision-test: PASS')
