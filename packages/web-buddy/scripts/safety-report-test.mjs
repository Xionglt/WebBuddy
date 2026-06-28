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
  assert.equal(result.report.highRiskActionCount, 3)
  assert.equal(result.report.gateCount, 3)
  assert.deepEqual(result.report.policyCodes, [
    'policy.workflow.login_required',
    'policy.workflow.captcha_required',
    'policy.workflow.final_submit',
  ])
  assert.match(result.report.summary, /Final submit was attempted and blocked/i)

  console.log('safety-report-test: PASS')
} finally {
  rmSync(root, { recursive: true, force: true })
}

function traceEvent(value) {
  return JSON.stringify({
    schemaVersion: 'agent-trace/v1',
    sessionId: 'test',
    ts: '2026-06-26T00:00:00.000Z',
    event: 'policy_decision',
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
