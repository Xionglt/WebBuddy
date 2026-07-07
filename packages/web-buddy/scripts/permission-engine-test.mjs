#!/usr/bin/env node
import assert from 'node:assert/strict'
import { PermissionEngine } from '../dist/permission/permission-engine.js'
import { createToolPermissionRequest } from '../dist/permission/permission-types.js'

const fixedDate = new Date('2026-06-29T00:00:00.000Z')
const engine = new PermissionEngine({ now: () => fixedDate })

const lowRisk = engine.evaluate(permissionRequest({
  requestId: 'perm-low-risk',
  toolName: 'browser_snapshot',
  risk: 'L1',
  riskLevel: 'low',
  policyAction: 'allow',
  policyCode: 'policy.low_risk.allow',
  ruleId: 'policy.low_risk.allow.v1',
  reason: 'Tool risk does not require a human gate.',
}))
assert.equal(lowRisk.schemaVersion, 'permission-decision/v1')
assert.equal(lowRisk.action, 'allow')
assert.equal(lowRisk.source, 'policy')
assert.equal(lowRisk.risk, 'L1')
assert.equal(lowRisk.riskLevel, 'low')
assert.equal(lowRisk.reason, 'Tool risk does not require a human gate.')
assert.equal(lowRisk.rememberable, false)
assert.equal(lowRisk.decidedAt, fixedDate.toISOString())

const policyGate = engine.evaluate(permissionRequest({
  requestId: 'perm-policy-gate',
  toolName: 'browser_click',
  args: { ref: 'e7' },
  risk: 'L3',
  riskLevel: 'high',
  policyAction: 'gate',
  gateKind: 'high_risk_action',
  policyCode: 'policy.high_risk.gate',
  ruleId: 'policy.high_risk.gate.v1',
  reason: 'High-risk tool action requires a human gate.',
}))
assert.equal(policyGate.action, 'ask')
assert.equal(policyGate.source, 'policy')
assert.equal(policyGate.gateKind, 'high_risk_action')
assert.equal(policyGate.rememberable, true)
assert.deepEqual(policyGate.remember.supportedScopes, ['once', 'session'])

const finalSubmit = engine.evaluate(permissionRequest({
  requestId: 'perm-final-submit',
  toolName: 'browser_click_text',
  args: { text: 'Submit application' },
  risk: 'L4',
  riskLevel: 'critical',
  policyAction: 'gate',
  gateKind: 'final_submit',
  policyCode: 'policy.workflow.final_submit',
  ruleId: 'policy.workflow.final_submit.v1',
  reason: 'Submit-like action in review phase requires the final-submit safety gate.',
}))
assert.equal(finalSubmit.action, 'ask')
assert.equal(finalSubmit.gateKind, 'final_submit')
assert.equal(finalSubmit.rememberable, false)
assert.deepEqual(finalSubmit.remember.supportedScopes, ['once'])

const upload = engine.evaluate(permissionRequest({
  requestId: 'perm-upload',
  toolName: 'browser_upload_file',
  args: { path: '/tmp/resume.pdf' },
  risk: 'L4',
  riskLevel: 'critical',
  policyAction: 'gate',
  policyCode: 'policy.high_risk.gate',
  ruleId: 'policy.high_risk.gate.v1',
  reason: 'Resume upload requires approval.',
}))
assert.equal(upload.action, 'ask')
assert.equal(upload.gateKind, 'upload_resume')

const login = engine.evaluate(permissionRequest({
  requestId: 'perm-login',
  toolName: 'browser_click_text',
  args: { text: 'Sign in' },
  risk: 'L3',
  riskLevel: 'high',
  workflowPhase: 'external_blocker',
  policyAction: 'gate',
  gateKind: 'login',
  policyCode: 'policy.workflow.external_blocker',
  ruleId: 'policy.workflow.external_blocker.v1',
  reason: 'Workflow is in external_blocker; route this step through the login human gate.',
}))
assert.equal(login.action, 'ask')
assert.equal(login.gateKind, 'login')
assert.equal(login.rememberable, false)

const captcha = engine.evaluate(permissionRequest({
  requestId: 'perm-captcha',
  toolName: 'browser_click_text',
  args: { text: 'Verify' },
  risk: 'L3',
  riskLevel: 'high',
  workflowPhase: 'external_blocker',
  policyAction: 'gate',
  gateKind: 'captcha',
  policyCode: 'policy.workflow.external_blocker',
  ruleId: 'policy.workflow.external_blocker.v1',
  reason: 'Workflow is in external_blocker; route this step through the captcha human gate.',
}))
assert.equal(captcha.action, 'ask')
assert.equal(captcha.gateKind, 'captcha')
assert.equal(captcha.rememberable, false)

const legacyPhaseOnlyLogin = engine.evaluate(permissionRequest({
  requestId: 'perm-legacy-phase-only-login',
  toolName: 'browser_click_text',
  args: { text: 'Sign in' },
  risk: 'L3',
  riskLevel: 'high',
  workflowPhase: 'external_blocker',
  policyAction: 'gate',
  policyCode: 'policy.high_risk.gate',
  ruleId: 'policy.high_risk.gate.v1',
  reason: 'High-risk tool action requires a human gate.',
}))
assert.equal(legacyPhaseOnlyLogin.action, 'ask')
assert.equal(legacyPhaseOnlyLogin.gateKind, 'high_risk_action')

const requestFromWorkflowState = createToolPermissionRequest({
  call: {
    id: 'call-state-phase',
    name: 'browser_click',
    arguments: { ref: 'apply' },
  },
  policyDecision: {
    schemaVersion: 'policy-decision/v1',
    action: 'gate',
    riskLevel: 'high',
    policyCode: 'policy.high_risk.gate',
    ruleId: 'policy.high_risk.gate.v1',
    reason: 'High-risk action requires permission.',
    auditTags: ['action:gate', 'risk:high'],
    workflowPhase: 'external_blocker',
  },
  workflowState: {
    schemaVersion: 'workflow-state/v1',
    phase: 'in_target_flow',
    observationPhase: 'in_target_flow',
    confidence: 'high',
    reason: 'Application flow is active.',
    updatedAt: fixedDate.toISOString(),
  },
  risk: 'L3',
  runId: 'run-permission-test',
  sessionId: 'sess-permission-test',
  turnId: 'turn-1',
  step: 2,
  now: () => fixedDate,
})
assert.equal(requestFromWorkflowState.workflowPhase, 'in_target_flow')
assert.equal(requestFromWorkflowState.observationPhase, 'in_target_flow')

const requestWithExplicitPhase = createToolPermissionRequest({
  call: {
    id: 'call-explicit-phase',
    name: 'browser_click',
    arguments: { ref: 'apply' },
  },
  policyDecision: {
    schemaVersion: 'policy-decision/v1',
    action: 'gate',
    riskLevel: 'high',
    policyCode: 'policy.high_risk.gate',
    ruleId: 'policy.high_risk.gate.v1',
    reason: 'High-risk action requires permission.',
    auditTags: ['action:gate', 'risk:high'],
    workflowPhase: 'external_blocker',
  },
  workflowPhase: 'in_target_flow',
  observationPhase: 'in_target_flow',
  risk: 'L3',
  runId: 'run-permission-test',
  sessionId: 'sess-permission-test',
  turnId: 'turn-1',
  step: 3,
  now: () => fixedDate,
})
assert.equal(requestWithExplicitPhase.workflowPhase, 'in_target_flow')
assert.equal(requestWithExplicitPhase.observationPhase, 'in_target_flow')

const requestWithoutRuntimePhase = createToolPermissionRequest({
  call: {
    id: 'call-no-runtime-phase',
    name: 'browser_click',
    arguments: { ref: 'apply' },
  },
  policyDecision: {
    schemaVersion: 'policy-decision/v1',
    action: 'gate',
    riskLevel: 'high',
    policyCode: 'policy.high_risk.gate',
    ruleId: 'policy.high_risk.gate.v1',
    reason: 'High-risk action requires permission.',
    auditTags: ['action:gate', 'risk:high'],
    workflowPhase: 'external_blocker',
  },
  risk: 'L3',
  runId: 'run-permission-test',
  sessionId: 'sess-permission-test',
  turnId: 'turn-1',
  step: 4,
  now: () => fixedDate,
})
assert.equal(requestWithoutRuntimePhase.workflowPhase, undefined)

const policyBlock = engine.evaluate(permissionRequest({
  requestId: 'perm-policy-block',
  toolName: 'browser_click',
  args: { ref: 'danger' },
  risk: 'L4',
  riskLevel: 'critical',
  policyAction: 'block',
  gateKind: 'high_risk_action',
  policyCode: 'policy.freshness.high_risk_stale',
  ruleId: 'policy.freshness.high_risk_stale.v1',
  reason: 'Context appears stale before a high-risk action.',
  requiresFreshContext: true,
}))
assert.equal(policyBlock.action, 'deny')
assert.equal(policyBlock.source, 'policy')
assert.equal(policyBlock.policyCode, 'policy.freshness.high_risk_stale')
assert.equal(policyBlock.ruleId, 'policy.freshness.high_risk_stale.v1')
assert.equal(policyBlock.requiresFreshContext, true)

const rawTrustedHighRiskGate = new PermissionEngine({
  now: () => fixedDate,
  permissionMode: 'trusted',
}).evaluate(permissionRequest({
  requestId: 'perm-raw-trusted-high-risk',
  toolName: 'browser_click_text',
  args: { text: 'Apply now' },
  risk: 'L3',
  riskLevel: 'high',
  policyAction: 'gate',
  gateKind: 'high_risk_action',
  policyCode: 'policy.workflow.apply_entry',
  ruleId: 'policy.workflow.apply_entry.v1',
  reason: 'Apply-entry action requires a high-risk gate but is not a final-submit action.',
  auditTags: ['action:gate', 'risk:high', 'safety:raw'],
}))
assert.equal(rawTrustedHighRiskGate.action, 'ask')
assert.equal(rawTrustedHighRiskGate.gateKind, 'high_risk_action')
assert(!rawTrustedHighRiskGate.auditTags.includes('auto_allow:permission_mode'))

const rawAutoConfirm = engine.evaluate(permissionRequest({
  requestId: 'perm-raw-auto-confirm',
  toolName: 'browser_click_text',
  args: { text: 'Open details' },
  risk: 'L3',
  riskLevel: 'high',
  policyAction: 'auto_confirm',
  gateKind: 'high_risk_action',
  policyCode: 'policy.raw.auto_confirm',
  ruleId: 'policy.raw.auto_confirm.v1',
  reason: 'Raw safety mode auto-confirms high-risk click actions for compatibility.',
}))
assert.equal(rawAutoConfirm.action, 'allow')
assert.equal(rawAutoConfirm.source, 'policy')
assert.equal(rawAutoConfirm.gateKind, 'high_risk_action')
assert(rawAutoConfirm.auditTags.includes('compat:auto_confirm'))

const finalSubmitWithAllowFlag = new PermissionEngine({
  now: () => fixedDate,
  permissionMode: 'autopilot',
  allowFinalSubmit: true,
}).evaluate(permissionRequest({
  requestId: 'perm-final-submit-allow-flag',
  toolName: 'browser_click_text',
  args: { text: 'Submit application' },
  risk: 'L4',
  riskLevel: 'critical',
  policyAction: 'gate',
  gateKind: 'final_submit',
  policyCode: 'policy.workflow.final_submit',
  ruleId: 'policy.workflow.final_submit.v1',
  reason: 'Submit-like action in review phase requires the final-submit safety gate.',
}))
assert.equal(finalSubmitWithAllowFlag.action, 'ask')
assert.equal(finalSubmitWithAllowFlag.gateKind, 'final_submit')

const rawAutoConfirmFinalSubmit = engine.evaluate(permissionRequest({
  requestId: 'perm-raw-auto-confirm-final-submit',
  toolName: 'browser_click_text',
  args: { text: 'Submit application' },
  risk: 'L3',
  riskLevel: 'high',
  policyAction: 'auto_confirm',
  gateKind: 'final_submit',
  policyCode: 'policy.raw.auto_confirm',
  ruleId: 'policy.raw.auto_confirm.v1',
  reason: 'Legacy raw auto-confirm request.',
}))
assert.equal(rawAutoConfirmFinalSubmit.action, 'ask')
assert.equal(rawAutoConfirmFinalSubmit.gateKind, 'final_submit')

for (const field of ['source', 'risk', 'reason', 'rememberable', 'gateKind']) {
  assert(field in policyGate, `permission decision should include ${field}`)
}

console.log('permission-engine-test: PASS')

function permissionRequest({
  requestId,
  toolName,
  args = {},
  risk,
  riskLevel,
  workflowPhase,
  policyAction,
  gateKind,
  policyCode,
  ruleId,
  reason,
  requiresFreshContext,
  auditTags,
}) {
  return {
    schemaVersion: 'permission-request/v1',
    requestId,
    runId: 'run-permission-test',
    sessionId: 'sess-permission-test',
    turnId: 'turn-1',
    step: 1,
    requestedAt: '2026-06-29T00:00:00.000Z',
    subject: {
      kind: 'tool_call',
      toolCallId: `${requestId}-call`,
      toolName,
      args,
      toolCategory: 'action',
    },
    risk,
    riskLevel,
    currentUrl: 'https://example.test/apply',
    ...(workflowPhase ? { workflowPhase } : {}),
    ...(gateKind ? { gateKind } : {}),
    policy: {
      schemaVersion: 'policy-decision/v1',
      action: policyAction,
      policyCode,
      ruleId,
      reason,
      auditTags: auditTags ?? [`action:${policyAction}`, `risk:${riskLevel}`],
      ...(requiresFreshContext ? { requiresFreshContext } : {}),
    },
  }
}
