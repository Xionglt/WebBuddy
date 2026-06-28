#!/usr/bin/env node
import assert from 'node:assert/strict'
import { decideToolPolicy } from '../dist/policy/agent-policy.js'
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
assert.equal(highRisk.gateKind, 'high_risk_action')
assert.equal(highRisk.policyCode, 'policy.high_risk.gate')

const criticalRisk = engine.evaluate({
  toolName: 'browser_click_text',
  args: { text: 'Confirm and submit' },
  risk: 'L4',
})
assert.equal(criticalRisk.action, 'gate')
assert.equal(criticalRisk.riskLevel, 'critical')
assert.equal(criticalRisk.gateKind, 'final_submit')

const applyEntry = engine.evaluate({
  toolName: 'browser_click_text',
  args: { text: 'Apply' },
  risk: 'L3',
  workflowPhase: 'job_detail',
})
assert.equal(applyEntry.action, 'gate')
assert.equal(applyEntry.gateKind, 'high_risk_action')
assert.equal(applyEntry.policyCode, 'policy.workflow.apply_entry')

const finalSubmit = engine.evaluate({
  toolName: 'browser_click_text',
  args: { text: 'Confirm and submit' },
  risk: 'L3',
  workflowPhase: 'ready_for_final_submit',
})
assert.equal(finalSubmit.gateKind, 'final_submit')
assert.equal(finalSubmit.policyCode, 'policy.workflow.final_submit')

const login = engine.evaluate({
  toolName: 'browser_click_text',
  args: { text: 'Sign in' },
  risk: 'L3',
  workflowPhase: 'login_required',
})
assert.equal(login.action, 'gate')
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
assert.equal(captcha.gateKind, 'captcha')
assert.equal(captcha.policyCode, 'policy.workflow.captcha_required')
assert.match(captcha.reason, /captcha/i)

const raw = engine.evaluate({
  toolName: 'browser_click_text',
  args: { text: 'Submit application' },
  risk: 'L3',
  safetyMode: 'raw',
})
assert.equal(raw.action, 'auto_confirm')
assert.equal(raw.gateKind, 'final_submit')
assert.equal(raw.policyCode, 'policy.raw.auto_confirm')

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
assert.equal(stale.action, 'gate')
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
assert.equal(audit.gateKind, 'final_submit')
assert.equal(audit.policyCode, 'policy.workflow.final_submit')
assert.equal(audit.workflowPhase, 'ready_for_final_submit')

console.log('policy-engine-test: PASS')
