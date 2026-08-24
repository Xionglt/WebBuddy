#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createSinkActionBinding,
  evaluateMemoryWritePolicy,
  evaluateRedirectPolicy,
  evaluateSinkPolicy,
  redactSensitiveData,
} from '../dist/security/index.js'
import { digestCanonicalJson } from '../dist/task/contracts.js'
import { appendMemdirRecord, readMemdirRecords } from '../dist/memory/index.js'
import { runAgentLoop } from '../dist/runtime/local/agent-loop.js'
import { ToolRegistry } from '../dist/runtime/local/tool-registry.js'
import { TraceRecorder } from '../dist/sdk/trace.js'

const now = new Date('2026-07-17T02:00:00.000Z')
const policy = {
  schemaVersion: 'task-policy/v1',
  defaultSensitiveAction: 'ask',
  rules: [{
    id: 'deny-payment',
    actionKinds: ['payment'],
    decision: 'deny',
    requireApprovalBinding: true,
  }],
}
const sourceItems = [{
  id: 'contact',
  origin: 'user',
  trust: 'user_authorized',
  sensitivity: 'personal',
}]
const action = createSinkActionBinding({
  contractId: 'contract-sink',
  revision: 4,
  runId: 'run-sink',
  actionId: 'send-contact',
  toolName: 'browser_type',
  args: { ref: 'e1', text: 'person@example.test' },
  sourceItems,
  sourceOrigin: 'https://source.example.test',
  destinationOrigin: 'https://target.example.test',
  actionSeq: 3,
  expiresAt: '2026-07-17T03:00:00.000Z',
})
const approval = {
  schemaVersion: 'approval-binding/v1',
  approvalId: 'approval-sink',
  actionBindingSha256: digestCanonicalJson(action),
  decision: 'approved',
  issuedAt: '2026-07-17T01:59:00.000Z',
  expiresAt: '2026-07-17T03:00:00.000Z',
  nonce: 'sink-once',
}
const base = {
  actionKind: 'type_or_paste',
  runId: 'run-sink',
  revision: 4,
  policy,
  sourceItems,
  payload: { ref: 'e1', text: 'person@example.test' },
  sourceOrigin: 'https://source.example.test',
  destinationOrigin: 'https://target.example.test',
  actionBinding: action,
  now,
}

assert.equal(evaluateSinkPolicy(base).action, 'ask', 'approval must be explicit')
const nonces = new Set()
const allowed = evaluateSinkPolicy({ ...base, approvalBinding: approval, consumedApprovalNonces: nonces })
assert.equal(allowed.action, 'allow')
assert.equal(allowed.consumedApproval?.consumedAt, now.toISOString())
assert.equal(evaluateSinkPolicy({ ...base, approvalBinding: approval, consumedApprovalNonces: nonces }).action, 'deny', 'approval is single-use')
const awarenessOnlySubmit = evaluateSinkPolicy({
  ...base,
  actionKind: 'submit',
  approvalBinding: { ...approval, nonce: 'submit-awareness-only' },
  consumedApprovalNonces: new Set(),
})
assert.equal(
  awarenessOnlySubmit.action,
  'deny',
  'ordinary approved awareness must not authorize an irreversible submit sink',
)
assert.match(awarenessOnlySubmit.reason, /semantic kind|external identity/)
const explicitlyExecutableSubmit = evaluateSinkPolicy({
  ...base,
  actionKind: 'submit',
  approvalBinding: {
    ...approval,
    schemaVersion: 'approval-binding/v2',
    decision: 'approved_and_execute',
    nonce: 'submit-execute-once',
  },
  consumedApprovalNonces: new Set(),
})
assert.equal(
  explicitlyExecutableSubmit.action,
  'deny',
  'an execution decision cannot reuse a type_or_paste binding for submit',
)
assert.match(explicitlyExecutableSubmit.reason, /semantic kind|external identity/)
const exactSubmitAction = createSinkActionBinding({
  contractId: 'contract-sink',
  revision: 4,
  runId: 'run-sink',
  actionId: 'submit-invoice',
  toolName: 'browser_click',
  args: { ref: 'e1', text: 'person@example.test' },
  sourceItems,
  sourceOrigin: 'https://source.example.test',
  destinationOrigin: 'https://target.example.test',
  externalBusinessKey: 'portal:tenant-a:invoice:INV-1',
  externalEffectDigest: 'e'.repeat(64),
  externalProbeId: 'invoice-query/v1',
  externalActionKind: 'submit',
  externalEffectPreview: '{"invoiceId":"INV-1","operation":"submit_invoice"}',
  actionSeq: 4,
  expiresAt: '2026-07-17T03:00:00.000Z',
})
const exactSubmitApproval = {
  ...approval,
  schemaVersion: 'approval-binding/v2',
  actionBindingSha256: digestCanonicalJson(exactSubmitAction),
  decision: 'approved_and_execute',
  nonce: 'exact-submit-execute-once',
}
const exactAwarenessOnlySubmit = evaluateSinkPolicy({
  ...base,
  actionKind: 'submit',
  actionBinding: exactSubmitAction,
  approvalBinding: {
    ...approval,
    actionBindingSha256: digestCanonicalJson(exactSubmitAction),
    nonce: 'exact-submit-awareness-only',
  },
  consumedApprovalNonces: new Set(),
})
assert.equal(exactAwarenessOnlySubmit.action, 'deny')
assert.match(exactAwarenessOnlySubmit.reason, /approved_and_execute/)
assert.equal(
  evaluateSinkPolicy({
    ...base,
    actionKind: 'submit',
    actionBinding: exactSubmitAction,
    approvalBinding: exactSubmitApproval,
    consumedApprovalNonces: new Set(),
  }).action,
  'allow',
  'a same-kind, reviewable, exact single-use approved_and_execute binding may authorize submit',
)
const exactSendAction = createSinkActionBinding({
  contractId: 'contract-sink',
  revision: 4,
  runId: 'run-sink',
  actionId: 'send-invoice',
  toolName: 'browser_click',
  args: { ref: 'e2', invoiceId: 'INV-2' },
  sourceItems,
  sourceOrigin: 'https://source.example.test',
  destinationOrigin: 'https://target.example.test',
  externalBusinessKey: 'portal:tenant-a:invoice:INV-2',
  externalEffectDigest: 'f'.repeat(64),
  externalProbeId: 'invoice-query/v1',
  externalActionKind: 'send',
  externalEffectPreview: '{"invoiceId":"INV-2","operation":"send_invoice"}',
  actionSeq: 5,
  expiresAt: '2026-07-17T03:00:00.000Z',
})
const exactSendBase = {
  ...base,
  actionKind: 'send',
  payload: { ref: 'e2', invoiceId: 'INV-2' },
  actionBinding: exactSendAction,
}
assert.equal(
  evaluateSinkPolicy({
    ...exactSendBase,
    approvalBinding: {
      ...approval,
      actionBindingSha256: digestCanonicalJson(exactSendAction),
      nonce: 'exact-send-awareness-only',
    },
    consumedApprovalNonces: new Set(),
  }).action,
  'deny',
  'ordinary awareness approval must not authorize a reconciled send effect',
)
assert.equal(
  evaluateSinkPolicy({
    ...exactSendBase,
    approvalBinding: {
      ...approval,
      schemaVersion: 'approval-binding/v2',
      actionBindingSha256: digestCanonicalJson(exactSendAction),
      decision: 'approved_and_execute',
      nonce: 'exact-send-execute-once',
    },
    consumedApprovalNonces: new Set(),
  }).action,
  'allow',
  'an exact reconciled send effect requires and accepts only explicit machine execution',
)
assert.equal(
  evaluateSinkPolicy({
    ...base,
    destinationOrigin: 'https://attacker.example.test',
    approvalBinding: { ...approval, nonce: 'wrong-origin' },
    consumedApprovalNonces: new Set(),
  }).action,
  'deny',
  'approval cannot move across origins',
)
assert.equal(evaluateSinkPolicy({ ...base, actionKind: 'payment' }).reasonCode, 'policy_denied')

const readOnlyNavigation = evaluateSinkPolicy({
  actionKind: 'navigate',
  runId: 'run-research',
  revision: 0,
  policy: {
    schemaVersion: 'task-policy/v1',
    defaultSensitiveAction: 'deny',
    rules: [{
      id: 'allow-research-navigation',
      actionKinds: ['navigate'],
      decision: 'allow',
      requireApprovalBinding: false,
    }],
  },
  payload: { url: 'https://second-source.example.test/docs' },
  destinationOrigin: 'https://second-source.example.test',
})
assert.equal(readOnlyNavigation.action, 'allow')
assert.equal(readOnlyNavigation.reasonCode, 'not_sensitive')

const personalNavigation = evaluateSinkPolicy({
  ...readOnlyNavigationInput(),
  sourceItems: [{ id: 'profile', origin: 'user', trust: 'user_authorized', sensitivity: 'personal' }],
})
assert.equal(personalNavigation.action, 'ask', 'navigation carrying personal data must retain an exact approval gate')

const secret = evaluateSinkPolicy({
  ...base,
  sourceItems: [{ id: 'secret', origin: 'user', trust: 'user_authorized', sensitivity: 'secret' }],
  payload: { authorization: 'Bearer very-secret-token-value' },
})
assert.equal(secret.reasonCode, 'secret_egress_blocked')
assert.equal(secret.redaction.changed, true)
assert(!JSON.stringify(secret.redaction.value).includes('very-secret-token-value'))

const redirect = evaluateRedirectPolicy({
  ...base,
  approvedDestinationOrigin: 'https://target.example.test',
  redirectedDestinationOrigin: 'https://redirected.example.test',
  approvalBinding: { ...approval, nonce: 'redirect' },
  consumedApprovalNonces: new Set(),
})
assert.equal(redirect.action, 'deny', 'old approval cannot authorize a redirect origin')

const redacted = redactSensitiveData({ password: 'p@ss', nested: { apiKey: 'sk-abcdefghijklmnop' } })
assert.equal(redacted.changed, true)
assert(!JSON.stringify(redacted.value).includes('p@ss'))

const trustedSecurity = {
  origin: 'user',
  trust: 'user_authorized',
  sensitivity: 'personal',
  provenanceId: 'user-confirmation-1',
}
const hostileSecurity = {
  origin: 'web',
  trust: 'untrusted_external',
  sensitivity: 'public',
  provenanceId: 'page-evil',
}
const record = memoryRecord()
assert.equal(evaluateMemoryWritePolicy(record, trustedSecurity).action, 'allow')
assert.equal(evaluateMemoryWritePolicy(record, hostileSecurity).action, 'deny')
assert.equal(evaluateMemoryWritePolicy({ ...record, sensitivity: 'secret' }, trustedSecurity).action, 'deny')

const root = await mkdtemp(join(tmpdir(), 'web-buddy-m2-memory-'))
try {
  await appendMemdirRecord(root, record, trustedSecurity)
  await assert.rejects(
    appendMemdirRecord(root, { ...record, id: 'poison' }, hostileSecurity),
    /MEMORY_WRITE_DENIED:untrusted_source_rejected/,
  )
  const records = await readMemdirRecords(root)
  assert.deepEqual(records.map((item) => item.id), ['memory-safe'])
} finally {
  await rm(root, { recursive: true, force: true })
}

const integrationRoot = await mkdtemp(join(tmpdir(), 'web-buddy-m2-sink-loop-'))
try {
  const allowedExecution = await runSinkLoop(integrationRoot, 'ask', 'approve')
  assert.equal(allowedExecution.executions.length, 1, 'approved exact sink action should execute once')
  assert.equal(allowedExecution.gates.length, 1, 'TaskPolicy ask must create a human gate')
  assert.equal(allowedExecution.gates[0].kind, 'high_risk_action')

  const deniedExecution = await runSinkLoop(integrationRoot, 'deny', 'approve')
  assert.equal(deniedExecution.executions.length, 0, 'TaskPolicy deny must stop before tool execution')
  assert.equal(deniedExecution.result.blocked, true)
} finally {
  await rm(integrationRoot, { recursive: true, force: true })
}

console.log('security-sink-policy-test: PASS')

function memoryRecord() {
  return {
    schemaVersion: 'memory-record/v1',
    id: 'memory-safe',
    kind: 'semantic_note',
    scope: 'user',
    userId: 'user-1',
    createdAt: '2026-07-17T02:00:00.000Z',
    updatedAt: '2026-07-17T02:00:00.000Z',
    source: { type: 'user', refId: 'confirmation-1' },
    sensitivity: 'personal',
    tags: ['confirmed'],
    confidence: 1,
    title: 'Preferred language',
    body: 'The user explicitly chose Chinese.',
    topics: ['preference'],
  }
}

function readOnlyNavigationInput() {
  return {
    actionKind: 'navigate',
    runId: 'run-research',
    revision: 0,
    policy: {
      schemaVersion: 'task-policy/v1',
      defaultSensitiveAction: 'deny',
      rules: [{
        id: 'allow-research-navigation',
        actionKinds: ['navigate'],
        decision: 'allow',
        requireApprovalBinding: false,
      }],
    },
    payload: { url: 'https://second-source.example.test/docs' },
    destinationOrigin: 'https://second-source.example.test',
  }
}

async function runSinkLoop(root, defaultSensitiveAction, gateDecision) {
  const executions = []
  const gates = []
  const trace = new TraceRecorder(root, {
    runId: `sink-loop-${defaultSensitiveAction}-${Date.now()}`,
    source: 'local-runtime',
    scenario: 'security-sink-policy',
    profile: 'deterministic',
    goal: 'Navigate to an explicitly approved destination.',
  })
  const call = {
    id: `navigate-${defaultSensitiveAction}`,
    name: 'browser_open',
    arguments: { url: 'https://target.example.test/path' },
  }
  const registry = new ToolRegistry([{
    name: 'browser_open',
    description: 'Deterministic navigation sink.',
    category: 'action',
    parameters: { type: 'object', properties: { url: { type: 'string' } } },
    inherentRisk: 'L1',
    async run(args) {
      executions.push(structuredClone(args))
      return { observation: 'navigation fixture executed', pageChanged: false }
    },
  }])
  const llm = {
    hasKey: true,
    label: 'sink-policy-fixture',
    turns: 0,
    async chatWithTools() {
      this.turns += 1
      return this.turns === 1
        ? { content: 'Navigate once.', toolCalls: [call] }
        : { content: 'Fixture complete.', toolCalls: [] }
    },
  }
  const result = await runAgentLoop({
    goal: 'Navigate to an explicitly approved destination.',
    contextItems: [contextItem()],
    taskContract: {
      schemaVersion: 'web-task-contract/v1',
      contractId: 'sink-loop-contract',
      revision: 1,
      criteria: [{
        id: 'page',
        kind: 'evidence_present',
        description: 'Observe a page.',
        evidenceKinds: ['page'],
        minCount: 1,
        allowedAuthorities: ['main_runtime'],
      }],
    },
    taskPolicy: {
      schemaVersion: 'task-policy/v1',
      defaultSensitiveAction,
      rules: [],
    },
    llm,
    registry,
    ctx: { sessionId: `sink-${defaultSensitiveAction}`, highlight: false, trace },
    gate: {
      async confirm(kind, message, context) {
        gates.push({ kind, message, context })
        return gateDecision
      },
    },
    maxSteps: 2,
    safetyMode: 'guarded',
    permissionMode: 'safe',
  })
  trace.finish()
  return { result, executions, gates }
}

function contextItem() {
  return {
    schemaVersion: 'context-item/v1',
    id: 'contact',
    kind: 'contact',
    content: { email: 'person@example.test' },
    origin: 'user',
    trust: 'user_authorized',
    instructionAuthority: 'advisory',
    sensitivity: 'personal',
    provenance: { capturedAt: '2026-07-17T02:00:00.000Z', parentContentIds: [] },
    allowedUses: ['prompt', 'sink'],
    freshness: { validity: 'current', revision: 1 },
    retention: { scope: 'run', deleteWithSession: true },
    sanitization: { policyId: 'fixture/v1', status: 'unchanged', redactedFields: [], instructionNeutralized: false, transformedFrom: [] },
    integrity: { immutable: true, digestVerified: true },
  }
}
