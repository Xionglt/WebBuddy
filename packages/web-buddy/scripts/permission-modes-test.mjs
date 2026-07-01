#!/usr/bin/env node
import assert from 'node:assert/strict'
import { PermissionEngine } from '../dist/permission/permission-engine.js'
import { loadConfig } from '../dist/sdk/config.js'

const fixedDate = new Date('2026-07-01T00:00:00.000Z')
const originalPermissionMode = process.env.PERMISSION_MODE

process.env.PERMISSION_MODE = 'review'
assert.equal(loadConfig().human.permissionMode, 'review')
restorePermissionMode()

const safe = new PermissionEngine({ now: () => fixedDate, permissionMode: 'safe' })
const safeApplyEntry = safe.evaluate(applyEntryRequest('safe-apply-entry'))
assert.equal(safeApplyEntry.action, 'ask')
assert.equal(safeApplyEntry.gateKind, 'high_risk_action')
assert.equal(safeApplyEntry.permissionMode, 'safe')

const trusted = new PermissionEngine({ now: () => fixedDate, permissionMode: 'trusted' })
const trustedApplyEntry = trusted.evaluate(applyEntryRequest('trusted-apply-entry'))
assert.equal(trustedApplyEntry.action, 'allow')
assert.equal(trustedApplyEntry.source, 'config_rule')
assert.equal(trustedApplyEntry.ruleId, 'permission.mode.trusted.auto_allow.v1')
assert.equal(trustedApplyEntry.permissionMode, 'trusted')
assert(trustedApplyEntry.auditTags.includes('permission:auto_allow'))
assert(trustedApplyEntry.auditTags.includes('permission_mode:trusted'))
assert(trustedApplyEntry.auditTags.includes('auto_allowed_by:trusted'))
assert.equal(trustedApplyEntry.gateKind, 'high_risk_action')

const trustedFinalSubmit = trusted.evaluate(finalSubmitRequest('trusted-final-submit'))
assert.equal(trustedFinalSubmit.action, 'ask')
assert.equal(trustedFinalSubmit.gateKind, 'final_submit')
assert.equal(trustedFinalSubmit.permissionMode, 'trusted')

const trustedLogin = trusted.evaluate(loginRequest('trusted-login'))
assert.equal(trustedLogin.action, 'ask')
assert.equal(trustedLogin.gateKind, 'login')

const trustedCaptcha = trusted.evaluate(captchaRequest('trusted-captcha'))
assert.equal(trustedCaptcha.action, 'ask')
assert.equal(trustedCaptcha.gateKind, 'captcha')

const autopilot = new PermissionEngine({ now: () => fixedDate, permissionMode: 'autopilot' })
const autopilotFinalSubmit = autopilot.evaluate(finalSubmitRequest('autopilot-final-submit'))
assert.equal(autopilotFinalSubmit.action, 'ask')
assert.equal(autopilotFinalSubmit.gateKind, 'final_submit')
assert.equal(autopilotFinalSubmit.permissionMode, 'autopilot')
assert(!autopilotFinalSubmit.auditTags.includes('permission:auto_allow'))

const autopilotLogin = autopilot.evaluate(loginRequest('autopilot-login'))
assert.equal(autopilotLogin.action, 'ask')
assert.equal(autopilotLogin.gateKind, 'login')

const autopilotCaptcha = autopilot.evaluate(captchaRequest('autopilot-captcha'))
assert.equal(autopilotCaptcha.action, 'ask')
assert.equal(autopilotCaptcha.gateKind, 'captcha')

console.log('permission-modes-test: PASS')

function restorePermissionMode() {
  if (originalPermissionMode === undefined) delete process.env.PERMISSION_MODE
  else process.env.PERMISSION_MODE = originalPermissionMode
}

function applyEntryRequest(id) {
  return permissionRequest({
    requestId: id,
    toolName: 'browser_click_text',
    args: { text: '投递简历' },
    risk: 'L3',
    riskLevel: 'high',
    workflowPhase: 'entering_application',
    policyAction: 'gate',
    gateKind: 'high_risk_action',
    policyCode: 'policy.workflow.apply_entry',
    ruleId: 'policy.workflow.apply_entry.v1',
    reason: 'Apply-entry action requires a high-risk gate but is not a final-submit action.',
    policyAuditTags: ['action:gate', 'risk:high', 'workflow', 'apply_entry', 'gate:high_risk_action'],
  })
}

function finalSubmitRequest(id) {
  return permissionRequest({
    requestId: id,
    toolName: 'browser_click_text',
    args: { text: 'Submit application' },
    risk: 'L4',
    riskLevel: 'critical',
    workflowPhase: 'ready_for_final_submit',
    policyAction: 'gate',
    gateKind: 'final_submit',
    policyCode: 'policy.workflow.final_submit',
    ruleId: 'policy.workflow.final_submit.v1',
    reason: 'Submit-like action in review phase requires the final-submit safety gate.',
    policyAuditTags: ['action:gate', 'risk:critical', 'workflow', 'final_submit', 'gate:final_submit'],
  })
}

function loginRequest(id) {
  return permissionRequest({
    requestId: id,
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
    policyAuditTags: ['action:gate', 'risk:high', 'workflow', 'login_required', 'human_handoff', 'gate:login'],
  })
}

function captchaRequest(id) {
  return permissionRequest({
    requestId: id,
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
    policyAuditTags: ['action:gate', 'risk:high', 'workflow', 'captcha_required', 'human_handoff', 'gate:captcha'],
  })
}

function permissionRequest({
  requestId,
  toolName,
  args,
  risk,
  riskLevel,
  workflowPhase,
  policyAction,
  gateKind,
  policyCode,
  ruleId,
  reason,
  policyAuditTags,
}) {
  return {
    schemaVersion: 'permission-request/v1',
    requestId,
    runId: 'run-permission-modes-test',
    sessionId: 'sess-permission-modes-test',
    turnId: 'turn-1',
    step: 1,
    requestedAt: fixedDate.toISOString(),
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
    workflowPhase,
    gateKind,
    policy: {
      schemaVersion: 'policy-decision/v1',
      action: policyAction,
      policyCode,
      ruleId,
      reason,
      auditTags: policyAuditTags,
    },
  }
}
