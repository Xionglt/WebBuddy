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
assert.equal(legacyDecision.actionIntent, 'final_submit')
assert.equal(legacyDecision.gateKind, 'final_submit')
assert.equal(legacyDecision.policyCode, 'policy.high_risk.gate')
assert.equal(legacyDecision.ruleId, 'policy.high_risk.gate.v1')

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

const criticalRisk = engine.evaluate({
  toolName: 'browser_click_text',
  args: { text: 'Confirm and submit' },
  risk: 'L4',
})
assert.equal(criticalRisk.action, 'gate')
assert.equal(criticalRisk.riskLevel, 'critical')
assert.equal(criticalRisk.actionIntent, 'final_submit')
assert.equal(criticalRisk.gateKind, 'final_submit')

const applyEntry = engine.evaluate({
  toolName: 'browser_click_text',
  args: { text: 'Apply' },
  risk: 'L3',
  workflowPhase: 'job_detail',
})
assert.equal(applyEntry.action, 'gate')
assert.equal(applyEntry.actionIntent, 'apply_entry')
assert.equal(applyEntry.gateKind, 'high_risk_action')
assert.equal(applyEntry.policyCode, 'policy.workflow.apply_entry')

const finalSubmit = engine.evaluate({
  toolName: 'browser_click_text',
  args: { text: 'Confirm and submit' },
  risk: 'L3',
  workflowPhase: 'ready_for_final_submit',
})
assert.equal(finalSubmit.gateKind, 'final_submit')
assert.equal(finalSubmit.actionIntent, 'final_submit')
assert.equal(finalSubmit.policyCode, 'policy.workflow.final_submit')

const directSubmitFinal = engine.evaluate({
  toolName: 'browser_click_text',
  args: { text: '投递简历' },
  risk: 'L3',
  workflowPhase: 'direct_submit_review',
})
assert.equal(directSubmitFinal.action, 'gate')
assert.equal(directSubmitFinal.actionIntent, 'final_submit')
assert.equal(directSubmitFinal.gateKind, 'final_submit')
assert.equal(directSubmitFinal.policyCode, 'policy.workflow.final_submit')
assert.match(directSubmitFinal.reason, /direct-submit review/i)

const alibabaDetailApplyText = engine.evaluate({
  toolName: 'browser_click_text',
  args: { text: '投递简历' },
  risk: 'L3',
  currentUrl: 'https://talent-holding.alibaba.com/off-campus/position-detail?lang=zh&positionId=100010400004',
  workflowPhase: 'direct_submit_review',
})
assert.equal(alibabaDetailApplyText.action, 'gate')
assert.equal(alibabaDetailApplyText.actionIntent, 'apply_entry')
assert.equal(alibabaDetailApplyText.gateKind, 'high_risk_action')
assert.equal(alibabaDetailApplyText.policyCode, 'policy.workflow.apply_entry')

const alibabaDetailModalApplyRef = engine.evaluate({
  toolName: 'browser_click',
  args: { ref: 'e6' },
  refLabel: '投递',
  risk: 'L3',
  currentUrl: 'https://talent-holding.alibaba.com/off-campus/position-detail?lang=zh&positionId=100010400004',
  contextText: '温馨提示：你暂未申请职位，本月能申请5个职位，请慎重选择！ 取消 投递',
  workflowPhase: 'direct_submit_review',
})
assert.equal(alibabaDetailModalApplyRef.action, 'gate')
assert.equal(alibabaDetailModalApplyRef.actionIntent, 'application_confirm')
assert.equal(alibabaDetailModalApplyRef.gateKind, 'high_risk_action')
assert.equal(alibabaDetailModalApplyRef.policyCode, 'policy.workflow.application_confirm')

const alibabaDetailModalApplyWithoutQuotaText = engine.evaluate({
  toolName: 'browser_click',
  args: { ref: 'e7' },
  refLabel: '投递',
  risk: 'L3',
  currentUrl: 'https://talent-holding.alibaba.com/off-campus/position-detail?lang=zh&positionId=100010400004',
  contextText: '职位详情 投递简历 取消 投递',
  workflowPhase: 'direct_submit_review',
})
assert.equal(alibabaDetailModalApplyWithoutQuotaText.action, 'gate')
assert.equal(alibabaDetailModalApplyWithoutQuotaText.actionIntent, 'application_confirm')
assert.equal(alibabaDetailModalApplyWithoutQuotaText.gateKind, 'high_risk_action')
assert.equal(alibabaDetailModalApplyWithoutQuotaText.policyCode, 'policy.workflow.application_confirm')

const alibabaDetailApplyWithNoticeLabel = engine.evaluate({
  toolName: 'browser_click',
  args: { ref: 'e3' },
  refLabel: '投递简历 申请此职位表明您已阅读并同意阿里巴巴集团及关联公司的《申请工作需知》',
  risk: 'L3',
  currentUrl: 'https://talent-holding.alibaba.com/off-campus/position-detail?lang=zh&positionId=100021460001',
  workflowPhase: 'direct_submit_review',
})
assert.equal(alibabaDetailApplyWithNoticeLabel.action, 'gate')
assert.equal(alibabaDetailApplyWithNoticeLabel.actionIntent, 'apply_entry')
assert.equal(alibabaDetailApplyWithNoticeLabel.gateKind, 'high_risk_action')
assert.equal(alibabaDetailApplyWithNoticeLabel.policyCode, 'policy.workflow.apply_entry')

const alibabaDetailConfirmSubmitText = engine.evaluate({
  toolName: 'browser_click_text',
  args: { text: '确认投递' },
  risk: 'L3',
  currentUrl: 'https://talent-holding.alibaba.com/off-campus/position-detail?lang=zh&positionId=100010400004',
  workflowPhase: 'reviewing',
})
assert.equal(alibabaDetailConfirmSubmitText.action, 'gate')
assert.equal(alibabaDetailConfirmSubmitText.actionIntent, 'final_submit')
assert.equal(alibabaDetailConfirmSubmitText.gateKind, 'final_submit')

const uploadResume = engine.evaluate({
  toolName: 'browser_upload_file',
  args: { filePath: '/tmp/resume.pdf', text: '上传简历' },
  risk: 'L4',
})
assert.equal(uploadResume.actionIntent, 'upload_resume')
assert.equal(uploadResume.gateKind, 'upload_resume')
assert.equal(uploadResume.policyCode, 'policy.workflow.upload_resume')

assert.equal(inferActionIntent({
  toolName: 'browser_upload_file',
  args: { filePath: '/tmp/resume.pdf', text: '投递简历' },
  risk: 'L4',
}), 'unknown_high_risk')

const login = engine.evaluate({
  toolName: 'browser_click_text',
  args: { text: 'Sign in' },
  risk: 'L3',
  workflowPhase: 'login_required',
})
assert.equal(login.action, 'gate')
assert.equal(login.actionIntent, 'login')
assert.equal(login.gateKind, 'login')
assert.equal(login.policyCode, 'policy.workflow.login_required')
assert.match(login.reason, /login/i)

const captcha = engine.evaluate({
  toolName: 'browser_click_text',
  args: { text: 'Verify' },
  risk: 'L3',
  workflowPhase: 'captcha_required',
})
assert.equal(captcha.action, 'gate')
assert.equal(captcha.actionIntent, 'captcha')
assert.equal(captcha.gateKind, 'captcha')
assert.equal(captcha.policyCode, 'policy.workflow.captcha_required')
assert.match(captcha.reason, /captcha/i)

const raw = engine.evaluate({
  toolName: 'browser_click_text',
  args: { text: 'Submit application' },
  risk: 'L3',
  safetyMode: 'raw',
})
assert.equal(raw.action, 'gate')
assert.equal(raw.gateKind, 'final_submit')
assert.equal(raw.policyCode, 'policy.high_risk.gate')

const rawHighRiskClick = engine.evaluate({
  toolName: 'browser_click',
  args: { ref: 'apply-now' },
  refLabel: 'Apply now',
  risk: 'L3',
  safetyMode: 'raw',
})
assert.equal(rawHighRiskClick.action, 'gate')
assert.equal(rawHighRiskClick.actionIntent, 'apply_entry')
assert.equal(rawHighRiskClick.policyCode, 'policy.workflow.apply_entry')

const stale = engine.evaluate({
  toolName: 'browser_click_text',
  args: { text: 'Submit application' },
  risk: 'L3',
  freshness: {
    pageStateStale: true,
    formStateStale: true,
    pageStateAgeMs: 45_000,
    formStateAgeMs: 60_000,
    staleAfterMs: 30_000,
  },
})
assert.equal(stale.action, 'block')
assert.equal(stale.requiresFreshContext, true)
assert.equal(stale.policyCode, 'policy.freshness.high_risk_stale')
assert.match(stale.reason, /Context appears stale/i)

const audit = createPolicyAuditEvent({
  sessionId: 'sess-test',
  step: 7,
  toolName: 'browser_click_text',
  decision: finalSubmit,
  at: '2026-06-26T00:00:00.000Z',
})
assert.equal(audit.schemaVersion, 'policy-audit/v1')
assert.equal(audit.sessionId, 'sess-test')
assert.equal(audit.step, 7)
assert.equal(audit.toolName, 'browser_click_text')
assert.equal(audit.action, 'gate')
assert.equal(audit.actionIntent, 'final_submit')
assert.equal(audit.gateKind, 'final_submit')
assert.equal(audit.policyCode, 'policy.workflow.final_submit')
assert.equal(audit.workflowPhase, 'ready_for_final_submit')

console.log('policy-engine-test: PASS')
