#!/usr/bin/env node
import assert from 'node:assert/strict'
import { decideToolPolicy, inferActionIntent } from '../dist/policy/agent-policy.js'
import { PolicyEngine } from '../dist/policy/policy-engine.js'
import { createPolicyAuditEvent } from '../dist/policy/policy-audit.js'

const engine = new PolicyEngine()

const legacyDecision = decideToolPolicy({
  toolName: 'browser_click_text',
  args: { text: 'Submit application' },
  risk: 'L3',
  safetyMode: 'guarded',
})
assert.equal(legacyDecision.schemaVersion, 'policy-decision/v1')
assert.equal(legacyDecision.action, 'gate')
assert.equal(legacyDecision.actionIntent, 'safety_sensitive')
assert.equal(legacyDecision.gateKind, 'final_submit')
assert.equal(legacyDecision.policyCode, 'policy.high_risk.gate')
assert.equal(legacyDecision.ruleId, 'policy.high_risk.gate.v1')
assert.ok(legacyDecision.auditTags.includes('invariant:no_final_submit'))

const lowRisk = engine.evaluate({
  toolName: 'browser_snapshot',
  args: {},
  risk: 'L1',
})
assert.equal(lowRisk.action, 'allow')
assert.equal(lowRisk.riskLevel, 'low')
assert.equal(lowRisk.actionIntent, 'observe')
assert.equal(lowRisk.policyCode, 'policy.low_risk.allow')

const mediumRisk = engine.evaluate({
  toolName: 'browser_type',
  args: { ref: 'e1', text: 'hello' },
  risk: 'L2',
})
assert.equal(mediumRisk.action, 'allow')
assert.equal(mediumRisk.riskLevel, 'medium')

const searchInputOnLoginNavPage = engine.evaluate({
  toolName: 'browser_type',
  args: { ref: 'e1', text: '前端', label: '搜索岗位' },
  risk: 'L2',
  contextText: '首页 社会招聘 校园招聘 个人中心 登录 筛选 在招职位',
})
assert.equal(searchInputOnLoginNavPage.action, 'allow')
assert.equal(searchInputOnLoginNavPage.actionIntent, 'state_change')
assert.equal(searchInputOnLoginNavPage.gateKind, undefined)

const highRisk = engine.evaluate({
  toolName: 'browser_click_text',
  args: { text: 'Continue' },
  risk: 'L3',
})
assert.equal(highRisk.action, 'gate')
assert.equal(highRisk.riskLevel, 'high')
assert.equal(highRisk.actionIntent, 'unknown_high_risk')
assert.equal(highRisk.gateKind, 'high_risk_action')
assert.equal(highRisk.policyCode, 'policy.high_risk.gate')
assert.ok(highRisk.auditTags.includes('invariant:stop_if_uncertain_final_submit'))

const criticalRisk = engine.evaluate({
  toolName: 'browser_click_text',
  args: { text: 'Confirm and submit' },
  risk: 'L4',
})
assert.equal(criticalRisk.action, 'gate')
assert.equal(criticalRisk.riskLevel, 'critical')
assert.equal(criticalRisk.actionIntent, 'safety_sensitive')
assert.equal(criticalRisk.gateKind, 'final_submit')

const applyEntry = engine.evaluate({
  toolName: 'browser_click_text',
  args: { text: 'Apply' },
  risk: 'L3',
  safetyMode: 'raw',
  taskType: 'apply_entry',
})
assert.equal(applyEntry.action, 'gate')
assert.equal(applyEntry.actionIntent, 'unknown_high_risk')
assert.equal(applyEntry.gateKind, 'high_risk_action')
assert.equal(applyEntry.policyCode, 'policy.high_risk.gate')

const finalSubmitBoundary = engine.evaluate({
  toolName: 'browser_click_text',
  args: { text: 'Continue' },
  risk: 'L3',
  pageSignals: {
    hasOnlySubmitLikeControls: true,
    formFieldsPresent: false,
  },
})
assert.equal(finalSubmitBoundary.action, 'gate')
assert.equal(finalSubmitBoundary.gateKind, 'final_submit')
assert.ok(finalSubmitBoundary.auditTags.includes('invariant:stop_if_uncertain_final_submit'))

const quotaDialogSubmit = engine.evaluate({
  toolName: 'browser_click_text',
  args: { text: '投递' },
  risk: 'L3',
  contextText: '温馨提示 你已申请1个职位，本月还能再申请4个，请慎重选择！ 投递 取消',
})
assert.equal(quotaDialogSubmit.action, 'gate')
assert.equal(quotaDialogSubmit.actionIntent, 'safety_sensitive')
assert.equal(quotaDialogSubmit.gateKind, 'final_submit')
assert.ok(quotaDialogSubmit.auditTags.includes('invariant:no_final_submit'))

const uploadResume = engine.evaluate({
  toolName: 'browser_upload_file',
  args: { filePath: '/tmp/resume.pdf', text: '上传简历' },
  risk: 'L4',
})
assert.equal(uploadResume.actionIntent, 'safety_sensitive')
assert.equal(uploadResume.gateKind, 'upload_resume')
assert.equal(uploadResume.policyCode, 'policy.high_risk.gate')
assert.ok(uploadResume.auditTags.includes('invariant:no_auto_upload_resume'))

assert.equal(inferActionIntent({
  toolName: 'browser_upload_file',
  args: { filePath: '/tmp/resume.pdf', text: '投递简历' },
  risk: 'L4',
}), 'safety_sensitive')

const login = engine.evaluate({
  toolName: 'browser_click_text',
  args: { text: 'Sign in' },
  risk: 'L3',
})
assert.equal(login.action, 'gate')
assert.equal(login.actionIntent, 'safety_sensitive')
assert.equal(login.gateKind, 'login')
assert.match(login.reason, /login/i)
assert.ok(login.auditTags.includes('invariant:no_auto_login'))

const captcha = engine.evaluate({
  toolName: 'browser_click_text',
  args: { text: 'Verify captcha' },
  risk: 'L3',
})
assert.equal(captcha.action, 'gate')
assert.equal(captcha.actionIntent, 'safety_sensitive')
assert.equal(captcha.gateKind, 'captcha')
assert.match(captcha.reason, /captcha/i)
assert.ok(captcha.auditTags.includes('invariant:no_auto_captcha'))

const saveProfile = engine.evaluate({
  toolName: 'browser_click_text',
  args: { text: 'Save profile' },
  risk: 'L3',
})
assert.equal(saveProfile.action, 'gate')
assert.equal(saveProfile.gateKind, 'save_resume')
assert.ok(saveProfile.auditTags.includes('invariant:no_auto_save_profile'))

const raw = engine.evaluate({
  toolName: 'browser_click_text',
  args: { text: 'Submit application' },
  risk: 'L3',
  safetyMode: 'raw',
})
assert.equal(raw.action, 'gate')
assert.equal(raw.gateKind, 'final_submit')

const stale = engine.evaluate({
  toolName: 'browser_click_text',
  args: { text: 'Continue' },
  risk: 'L3',
  freshness: {
    pageStateStale: true,
    pageStateAgeMs: 60000,
    staleAfterMs: 30000,
  },
})
assert.equal(stale.action, 'block')
assert.equal(stale.policyCode, 'policy.freshness.high_risk_stale')
assert.equal(stale.requiresFreshContext, true)

const audit = createPolicyAuditEvent({
  step: 3,
  toolName: 'browser_click_text',
  args: { text: 'Submit application' },
  risk: 'L3',
  decision: legacyDecision,
})
assert.equal(audit.schemaVersion, 'policy-audit/v1')
assert.equal(audit.policyCode, legacyDecision.policyCode)
assert.equal(audit.gateKind, 'final_submit')
assert.equal(audit.actionIntent, 'safety_sensitive')

console.log('policy-engine-test ok')
