#!/usr/bin/env node
import assert from 'node:assert/strict'
import { PermissionEngine } from '../dist/permission/permission-engine.js'

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
  workflowPhase: 'login_required',
  policyAction: 'gate',
  gateKind: 'login',
  policyCode: 'policy.workflow.login_required',
  ruleId: 'policy.workflow.login_required.v1',
  reason: 'Workflow is in login_required; route this step through the login human gate.',
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
  workflowPhase: 'captcha_required',
  policyAction: 'gate',
  gateKind: 'captcha',
  policyCode: 'policy.workflow.captcha_required',
  ruleId: 'policy.workflow.captcha_required.v1',
  reason: 'Workflow is in captcha_required; route this step through the captcha human gate.',
}))
assert.equal(captcha.action, 'ask')
assert.equal(captcha.gateKind, 'captcha')
assert.equal(captcha.rememberable, false)

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

const rawAutoConfirm = engine.evaluate(permissionRequest({
  requestId: 'perm-raw-auto-confirm',
  toolName: 'browser_click_text',
  args: { text: 'Submit application' },
  risk: 'L3',
  riskLevel: 'high',
  policyAction: 'auto_confirm',
  gateKind: 'final_submit',
  policyCode: 'policy.raw.auto_confirm',
  ruleId: 'policy.raw.auto_confirm.v1',
  reason: 'Raw safety mode auto-confirms high-risk click actions for compatibility.',
}))
assert.equal(rawAutoConfirm.action, 'allow')
assert.equal(rawAutoConfirm.source, 'policy')
assert.equal(rawAutoConfirm.gateKind, 'final_submit')
assert(rawAutoConfirm.auditTags.includes('compat:auto_confirm'))

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
      auditTags: [`action:${policyAction}`, `risk:${riskLevel}`],
      ...(requiresFreshContext ? { requiresFreshContext } : {}),
    },
  }
}
