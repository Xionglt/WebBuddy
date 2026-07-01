#!/usr/bin/env node
import assert from 'node:assert/strict'
import {
  appendRiskDecision,
  createPermissionRiskDecision,
  createPolicyRiskDecision,
  createRiskDecisionsArtifact,
  createRiskDecisionsArtifactFromEvents,
  formatCompactRiskDecision,
  serializeRiskDecisionsArtifact,
} from '../dist/policy/risk-decisions.js'

const policyDecision = {
  schemaVersion: 'policy-decision/v1',
  action: 'gate',
  riskLevel: 'high',
  reason: 'Apply-entry action requires a high-risk gate but is not a final-submit action.',
  gateKind: 'high_risk_action',
  requiresFreshContext: true,
  policyCode: 'policy.workflow.apply_entry',
  ruleId: 'policy.workflow.apply_entry.v1',
  workflowPhase: 'entering_application',
  auditTags: ['action:gate', 'risk:high', 'workflow:entering_application'],
}

const policyRecord = createPolicyRiskDecision({
  step: 1,
  toolName: 'browser_click_text',
  action: 'browser_click_text(text=投递简历, token=secret-token, email=person@example.com)',
  risk: 'L3',
  url: 'https://example.test/jobs/1',
  permissionMode: 'trusted',
  decision: policyDecision,
  timestamp: '2026-06-26T00:00:00.000Z',
})

assert.equal(policyRecord.schemaVersion, 'risk-decision/v1')
assert.equal(policyRecord.source, 'policy')
assert.equal(policyRecord.risk, 'L3')
assert.equal(policyRecord.riskLevel, 'high')
assert.equal(policyRecord.gateKind, 'high_risk_action')
assert.equal(policyRecord.decision, 'ask')
assert.equal(policyRecord.permissionMode, 'trusted')

const permissionRecord = createPermissionRiskDecision({
  step: 1,
  request: {
    schemaVersion: 'permission-request/v1',
    requestId: 'perm-apply-entry',
    step: 1,
    subject: {
      kind: 'tool_call',
      toolName: 'browser_click_text',
      argBrief: 'text=投递简历 token=secret-token email=person@example.com',
    },
    risk: 'L3',
    riskLevel: 'high',
    currentUrl: 'https://example.test/jobs/1',
    gateKind: 'high_risk_action',
    policy: {
      policyCode: 'policy.workflow.apply_entry',
      reason: 'Apply-entry action requires a high-risk gate.',
    },
  },
  decision: {
    schemaVersion: 'permission-decision/v1',
    requestId: 'perm-apply-entry',
    action: 'allow',
    source: 'config_rule',
    ruleId: 'permission.mode.trusted.auto_allow.v1',
    policyCode: 'policy.workflow.apply_entry',
    risk: 'L3',
    riskLevel: 'high',
    permissionMode: 'trusted',
    reason: 'Trusted permission mode auto-allows non-final L3 application-flow actions.',
    decidedAt: '2026-06-26T00:00:01.000Z',
    gateKind: 'high_risk_action',
    rememberable: false,
    remember: { supportedScopes: ['once'], defaultScope: 'once' },
    auditTags: ['permission:allow', 'permission:auto_allow', 'permission_mode:trusted'],
  },
})

assert.equal(permissionRecord.source, 'permission')
assert.equal(permissionRecord.decision, 'auto_allow')
assert.equal(permissionRecord.permissionMode, 'trusted')
assert.match(formatCompactRiskDecision(permissionRecord), /high-risk action auto-allowed by trusted mode/)

const artifact = createRiskDecisionsArtifact({
  runId: 'risk-timeline-run',
  sessionId: 'run_risk-timeline-run',
  generatedAt: '2026-06-26T00:00:02.000Z',
})
appendRiskDecision(artifact, policyRecord)
appendRiskDecision(artifact, permissionRecord)

assert.equal(artifact.schemaVersion, 'risk-decisions/v1')
assert.equal(artifact.summary.total, 2)
assert.equal(artifact.summary.gated, 1)
assert.equal(artifact.summary.autoAllowed, 1)

const serialized = serializeRiskDecisionsArtifact(artifact)
assert(!serialized.includes('secret-token'))
assert(!serialized.includes('person@example.com'))
assert(serialized.includes('[redacted]'))
assert(serialized.includes('[email:redacted]'))

const fromEvents = createRiskDecisionsArtifactFromEvents({
  runId: 'events-run',
  sessionId: 'run_events-run',
  generatedAt: '2026-06-26T00:00:03.000Z',
  events: [
    traceEvent('policy_decision', {
      schemaVersion: 'policy-audit/v1',
      at: '2026-06-26T00:00:00.000Z',
      sessionId: 'run_events-run',
      step: 2,
      toolName: 'browser_click_text',
      risk: 'L3',
      action: 'gate',
      riskLevel: 'critical',
      gateKind: 'final_submit',
      policyCode: 'policy.workflow.final_submit',
      ruleId: 'policy.workflow.final_submit.v1',
      reason: 'Submit-like action requires the final-submit safety gate.',
    }),
    traceEvent('permission_decision', {
      step: 2,
      request: {
        requestId: 'perm-final-submit',
        step: 2,
        subject: { kind: 'tool_call', toolName: 'browser_click_text', argBrief: 'text=Submit application' },
        risk: 'L4',
        riskLevel: 'critical',
        gateKind: 'final_submit',
      },
      decision: {
        schemaVersion: 'permission-decision/v1',
        requestId: 'perm-final-submit',
        action: 'ask',
        source: 'policy',
        ruleId: 'policy.workflow.final_submit.v1',
        risk: 'L4',
        riskLevel: 'critical',
        permissionMode: 'trusted',
        reason: 'Submit-like action requires the final-submit safety gate.',
        decidedAt: '2026-06-26T00:00:01.000Z',
        gateKind: 'final_submit',
        rememberable: false,
        remember: { supportedScopes: ['once'], defaultScope: 'once' },
        auditTags: ['permission:ask', 'gate:final_submit'],
      },
    }),
  ],
})

assert.equal(fromEvents.summary.total, 2)
assert.equal(fromEvents.summary.gated, 2)
assert.equal(fromEvents.decisions[0].gateKind, 'final_submit')
assert.match(formatCompactRiskDecision(fromEvents.decisions[1]), /final-submit gated/)

console.log('risk-timeline-test: PASS')

function traceEvent(event, value) {
  return {
    schemaVersion: 'agent-trace/v1',
    sessionId: 'test',
    ts: '2026-06-26T00:00:00.000Z',
    event,
    data: {
      kind: 'json',
      value,
    },
  }
}
