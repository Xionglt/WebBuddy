#!/usr/bin/env node
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildRunManifest,
  writeRunManifest,
} from '../dist/metrics/trace-inputs.js'
import { generateAndWriteSafetyReport } from '../dist/policy/safety-report.js'

const root = mkdtempSync(join(tmpdir(), 'mfa-safety-report-'))

try {
  const outputDir = join(root, 'output')
  const runId = 'safety-report-run'
  const sessionId = `run_${runId}`
  const runDir = join(outputDir, runId)
  const traceDir = join(outputDir, 'traces', sessionId)
  mkdirSync(runDir, { recursive: true })
  mkdirSync(traceDir, { recursive: true })

  const sessionJson = join(traceDir, 'session.json')
  const eventsJsonl = join(traceDir, 'events.jsonl')
  const legacyTraceJsonl = join(runDir, 'trace.jsonl')
  const summaryJson = join(runDir, 'summary.json')

  writeFileSync(sessionJson, JSON.stringify({
    schemaVersion: 'agent-trace/v1',
    sessionId,
    runId,
    source: 'local-runtime',
    scenario: 'demo-form',
    profile: 'debug',
    status: 'cancelled',
    startedAt: '2026-06-26T00:00:00.000Z',
    endedAt: '2026-06-26T00:00:05.000Z',
    totals: {},
  }))
  writeFileSync(eventsJsonl, [
    traceEvent(policyEvent({
      step: 1,
      toolName: 'browser_click_text',
      action: 'gate',
      riskLevel: 'high',
      gateKind: 'login',
      policyCode: 'policy.workflow.login_required',
      ruleId: 'policy.workflow.login_required.v1',
      reason: 'Workflow is in login_required; route this step through the login human gate.',
      workflowPhase: 'login_required',
      requiresFreshContext: true,
    })),
    traceEvent(policyEvent({
      step: 2,
      toolName: 'browser_click_text',
      action: 'gate',
      riskLevel: 'high',
      gateKind: 'captcha',
      policyCode: 'policy.workflow.captcha_required',
      ruleId: 'policy.workflow.captcha_required.v1',
      reason: 'Workflow is in captcha_required; route this step through the captcha human gate.',
      workflowPhase: 'captcha_required',
      requiresFreshContext: true,
    })),
    traceEvent(policyEvent({
      step: 3,
      toolName: 'browser_click_text',
      risk: 'L3',
      action: 'gate',
      riskLevel: 'high',
      gateKind: 'high_risk_action',
      policyCode: 'policy.workflow.apply_entry',
      ruleId: 'policy.workflow.apply_entry.v1',
      reason: 'Apply-entry action requires a high-risk gate but is not a final-submit action.',
      workflowPhase: 'entering_application',
      requiresFreshContext: true,
    })),
    traceEvent({
      schemaVersion: 'permission-decision/v1-wrapper',
      event: 'permission_decision',
      value: {
        step: 3,
        request: {
          requestId: 'perm-trusted-apply',
          step: 3,
          subject: { kind: 'tool_call', toolName: 'browser_click_text', argBrief: 'text=Apply now' },
          risk: 'L3',
          riskLevel: 'high',
          currentUrl: 'https://example.test/jobs/1',
          gateKind: 'high_risk_action',
          policy: { policyCode: 'policy.workflow.apply_entry', reason: 'Apply-entry action requires a high-risk gate.' },
        },
        decision: permissionDecision({
          requestId: 'perm-trusted-apply',
          action: 'allow',
          ruleId: 'permission.mode.trusted.auto_allow.v1',
          policyCode: 'policy.workflow.apply_entry',
          risk: 'L3',
          riskLevel: 'high',
          permissionMode: 'trusted',
          gateKind: 'high_risk_action',
          reason: 'Trusted permission mode auto-allows non-final L3 application-flow actions.',
          auditTags: ['permission:allow', 'permission:auto_allow', 'permission_mode:trusted'],
        }),
      },
    }),
    traceEvent({
      schemaVersion: 'permission-decision/v1-wrapper',
      event: 'permission_decision',
      value: {
        step: 4,
        request: {
          requestId: 'perm-policy-deny',
          step: 4,
          subject: { kind: 'tool_call', toolName: 'browser_upload_file', argBrief: 'ref=e9' },
          risk: 'L4',
          riskLevel: 'critical',
          currentUrl: 'https://example.test/apply',
          gateKind: 'upload_resume',
          policy: { policyCode: 'policy.workflow.upload_resume', reason: 'Resume upload requires permission.' },
        },
        decision: permissionDecision({
          requestId: 'perm-policy-deny',
          action: 'deny',
          ruleId: 'permission.policy_block.deny.v1',
          policyCode: 'policy.workflow.upload_resume',
          risk: 'L4',
          riskLevel: 'critical',
          permissionMode: 'safe',
          gateKind: 'upload_resume',
          reason: 'Resume upload was denied by policy.',
          auditTags: ['permission:deny', 'permission_mode:safe'],
        }),
      },
    }),
    traceEvent(policyEvent({
      step: 5,
      toolName: 'browser_click_text',
      action: 'gate',
      riskLevel: 'critical',
      gateKind: 'final_submit',
      policyCode: 'policy.workflow.final_submit',
      ruleId: 'policy.workflow.final_submit.v1',
      reason: 'Submit-like action in review phase requires the final-submit safety gate.',
      workflowPhase: 'ready_for_final_submit',
      requiresFreshContext: true,
    })),
  ].join('\n') + '\n')
  writeFileSync(legacyTraceJsonl, [
    JSON.stringify({ step: 1, phase: 'agent_loop', action: 'GATE [final_submit] browser_click_text(text=Submit application) -> takeover', status: 'blocked' }),
  ].join('\n') + '\n')
  writeFileSync(summaryJson, JSON.stringify({
    runId,
    steps: 1,
    screenshots: 0,
    finalStatus: 'blocked',
  }))

  writeRunManifest(buildRunManifest({
    runId,
    sessionId,
    source: 'local-runtime',
    scenario: 'demo-form',
    profile: 'debug',
    runDir,
    traceDir,
    legacyTraceDir: runDir,
    files: {
      sessionJson,
      eventsJsonl,
      legacyTraceJsonl,
      summaryJson,
    },
  }))

  const result = generateAndWriteSafetyReport({ runId, outputDir })
  assert.equal(result.path, join(traceDir, 'safety-report.json'))
  assert.equal(existsSync(result.path), true)
  assert.equal(result.report.schemaVersion, 'safety-report/v1')
  assert.equal(result.report.runId, runId)
  assert.equal(result.report.finalStatus, 'blocked')
  assert.equal(result.report.finalWorkflowPhase, 'ready_for_final_submit')
  assert.equal(result.report.finalSubmitAttempted, true)
  assert.equal(result.report.finalSubmitBlocked, true)
  assert.equal(result.report.loginHandoffRequired, true)
  assert.equal(result.report.captchaHandoffRequired, true)
  assert.equal(result.report.highRiskActionCount, 4)
  assert.equal(result.report.gateCount, 4)
  assert.equal(result.report.riskDecisionCount, 6)
  assert.equal(result.report.autoAllowedCount, 1)
  assert.equal(result.report.gatedCount, 3)
  assert.equal(result.report.deniedCount, 1)
  assert.deepEqual(result.report.policyCodes, [
    'policy.workflow.login_required',
    'policy.workflow.captcha_required',
    'policy.workflow.apply_entry',
    'policy.workflow.final_submit',
  ])
  assert.match(result.report.summary, /Final submit was attempted and blocked/i)
  assert.match(result.report.summary, /1 auto-allowed, 3 gated, and 1 denied/i)

  console.log('safety-report-test: PASS')
} finally {
  rmSync(root, { recursive: true, force: true })
}

function traceEvent(input) {
  const event = input.event || 'policy_decision'
  const value = Object.prototype.hasOwnProperty.call(input, 'value') ? input.value : input
  return JSON.stringify({
    schemaVersion: 'agent-trace/v1',
    sessionId: 'test',
    ts: '2026-06-26T00:00:00.000Z',
    event,
    data: {
      kind: 'json',
      value,
    },
  })
}

function policyEvent(input) {
  return {
    schemaVersion: 'policy-audit/v1',
    at: '2026-06-26T00:00:00.000Z',
    sessionId: 'test',
    ...input,
  }
}

function permissionDecision(input) {
  return {
    schemaVersion: 'permission-decision/v1',
    source: 'config_rule',
    decidedAt: '2026-06-26T00:00:00.000Z',
    rememberable: false,
    remember: {
      supportedScopes: ['once'],
      defaultScope: 'once',
    },
    ...input,
  }
}
