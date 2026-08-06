#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PermissionEngine } from '../dist/permission/permission-engine.js'
import { createToolPermissionRequest } from '../dist/permission/permission-types.js'
import {
  appendPersistentPermissionRule,
  loadPersistentPermissionRules,
  persistentPermissionRuleFromDecision,
} from '../dist/permission/persistent-rules.js'

const root = mkdtempSync(join(tmpdir(), 'mfa-permission-remember-'))
const rulesPath = join(root, 'permission-rules.json')
const now = new Date('2026-07-09T00:00:00.000Z')

try {
  const firstEngine = new PermissionEngine({ now: () => now })
  const firstRequest = request('perm-probe-1', 'browser_click_text', 'Apply now', 'high_risk_action')
  const firstDecision = firstEngine.evaluate(firstRequest)
  assert.equal(firstDecision.action, 'ask')
  assert.deepEqual(firstDecision.remember.supportedScopes, ['once', 'session'])

  const remembered = persistentPermissionRuleFromDecision({
    id: 'remember-apply-now-session',
    request: firstRequest,
    decision: {
      ...firstDecision,
      action: 'allow',
      source: 'user',
      reason: 'User approved this high-risk apply-entry action for the current session.',
    },
    rememberScope: 'session',
    now: now.toISOString(),
  })
  assert(remembered, 'session approval should write a session-bound remembered rule')
  await appendPersistentPermissionRule(rulesPath, remembered, now.toISOString())

  const loadedRules = await loadPersistentPermissionRules(rulesPath)
  assert.equal(loadedRules.length, 1)
  assert.equal(loadedRules[0].scope, 'session')
  assert.equal(loadedRules[0].sessionId, 'sess-permission-remember')

  const secondEngine = new PermissionEngine({ now: () => now, persistentRules: loadedRules })
  const secondDecision = secondEngine.evaluate(request('perm-probe-2', 'browser_click_text', 'Apply now', 'high_risk_action'))
  assert.equal(secondDecision.action, 'allow')
  assert.equal(secondDecision.source, 'runtime_rule')
  assert(secondDecision.auditTags.includes('permission:persistent'))

  const laterSessionDecision = secondEngine.evaluate(request(
    'perm-probe-later-session',
    'browser_click_text',
    'Apply now',
    'high_risk_action',
    'sess-later',
  ))
  assert.equal(laterSessionDecision.action, 'ask', 'session grant must not widen a later session')

  const rejectedAlwaysAllow = persistentPermissionRuleFromDecision({
    id: 'remember-apply-now-always',
    request: firstRequest,
    decision: {
      ...firstDecision,
      action: 'allow',
      source: 'user',
      reason: 'Attempt to persist positive authorization forever.',
    },
    rememberScope: 'always',
    now: now.toISOString(),
  })
  assert.equal(rejectedAlwaysAllow, undefined, 'positive authorization must never persist across sessions')

  const rememberedDeny = persistentPermissionRuleFromDecision({
    id: 'remember-apply-now-deny',
    request: firstRequest,
    decision: {
      ...firstDecision,
      action: 'deny',
      source: 'user',
      reason: 'Never perform this high-risk action on this origin.',
    },
    rememberScope: 'always',
    now: now.toISOString(),
  })
  assert(rememberedDeny, 'restrictive deny may persist across sessions')
  await appendPersistentPermissionRule(rulesPath, rememberedDeny, now.toISOString())
  const denyRules = await loadPersistentPermissionRules(rulesPath)
  const laterEngine = new PermissionEngine({ now: () => now, persistentRules: denyRules })
  const deniedLater = laterEngine.evaluate(request(
    'perm-probe-denied-later',
    'browser_click_text',
    'Apply now',
    'high_risk_action',
    'sess-much-later',
  ))
  assert.equal(deniedLater.action, 'deny')
  assert.equal(deniedLater.source, 'runtime_rule')

  const finalRemember = persistentPermissionRuleFromDecision({
    id: 'remember-final-submit',
    request: request('perm-final-remember-attempt', 'browser_click_text', 'Submit application', 'final_submit'),
    decision: {
      ...firstDecision,
      action: 'allow',
      gateKind: 'final_submit',
      reason: 'Attempt to remember final submit.',
    },
    rememberScope: 'always',
    now: now.toISOString(),
  })
  assert.equal(finalRemember, undefined, 'final_submit must not be written as remembered allow')

  const finalDecision = secondEngine.evaluate(request('perm-probe-final', 'browser_click_text', 'Submit application', 'final_submit'))
  assert.equal(finalDecision.action, 'ask')
  assert.equal(finalDecision.gateKind, 'final_submit')
  assert.equal(finalDecision.source, 'policy')

  console.log('permission-remember-e2e-test: PASS')
} finally {
  rmSync(root, { recursive: true, force: true })
}

function request(requestId, toolName, text, gateKind, sessionId = 'sess-permission-remember') {
  return createToolPermissionRequest({
    call: {
      id: `${requestId}-call`,
      name: toolName,
      arguments: { text },
    },
    policyDecision: {
      schemaVersion: 'policy-decision/v1',
      action: 'gate',
      riskLevel: gateKind === 'final_submit' ? 'critical' : 'high',
      gateKind,
      policyCode: gateKind === 'final_submit' ? 'policy.workflow.final_submit' : 'policy.high_risk.gate',
      ruleId: gateKind === 'final_submit' ? 'policy.workflow.final_submit.v1' : 'policy.high_risk.gate.v1',
      reason: gateKind === 'final_submit'
        ? 'Submit-like action in review phase requires the final-submit safety gate.'
        : 'High-risk tool action requires a human gate.',
      auditTags: [`gate:${gateKind}`, gateKind === 'final_submit' ? 'risk:critical' : 'risk:high'],
    },
    risk: gateKind === 'final_submit' ? 'L4' : 'L3',
    currentUrl: 'https://example.test/apply',
    runId: 'run-permission-remember',
    sessionId,
    turnId: 'turn-1',
    step: 1,
    now: () => now,
  })
}
