#!/usr/bin/env node
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'

const distUrl = new URL('../dist/agents/multi-agent-contracts.js', import.meta.url)
const sourceUrl = new URL('../src/agents/multi-agent-contracts.ts', import.meta.url)
const useSource = process.env.WEB_BUDDY_TEST_SOURCE === '1'
const contracts = await import(useSource || !existsSync(distUrl) ? sourceUrl : distUrl)

const {
  AGENT_ARTIFACT_CONTRACT_SCHEMA_VERSION,
  AGENT_INVOCATION_RESULT_SCHEMA_VERSION,
  AGENT_RESULT_NOTIFICATION_SCHEMA_VERSION,
  MULTI_AGENT_ROLE_SCHEMA_VERSION,
  MultiAgentContractError,
  acceptAgentResultNotification,
  multiAgentDigest,
  sealAgentContextEnvelope,
  validateAgentInvocationResult,
  validateMultiAgentRole,
} = contracts

const runId = 'run-m4-a1'
const runRevision = 7
const binding = {
  schemaVersion: 'agent-invocation-binding/v1',
  invocationId: 'invocation-m4-a1',
  taskId: 'task-m4-a1',
  runId,
  runRevision,
  attempt: 2,
  parentActionSeq: 11,
  sessionRef: {
    schemaVersion: 'session-ref/v1',
    provider: 'file-session-store',
    id: 'session-m4-a1',
    runId,
    attempt: 2,
  },
}

const inputContract = artifactContract('input', 'input-page', ['page_snapshot'], ['page-snapshot/v1'])
const outputContract = artifactContract('output', 'output-plan', ['plan_proposal'], ['plan-proposal/v1'])
const role = {
  schemaVersion: MULTI_AGENT_ROLE_SCHEMA_VERSION,
  id: 'contract-test-role',
  version: '1.0.0',
  capabilities: ['context.read', 'artifact.read', 'plan.propose'],
  authority: 'recommend_only',
  allowedTools: ['artifact_read_json', 'artifact_list_refs'],
  inputArtifactContracts: [inputContract],
  outputArtifactContracts: [outputContract],
  livePageAccess: false,
  browserWrite: false,
  canResolveApproval: false,
  canWriteMemory: false,
  authoritativeCompletionEvidence: false,
  requiresMainWorkflowVerification: true,
}
validateMultiAgentRole(role)

for (const forgedRole of [
  { ...role, authority: 'browser_write' },
  { ...role, browserWrite: true },
  { ...role, capabilities: [...role.capabilities, 'browser.click'] },
  { ...role, allowedTools: [...role.allowedTools, 'browser_click'] },
  { ...role, authoritativeCompletionEvidence: true },
]) {
  assertContractError(() => validateMultiAgentRole(forgedRole), ['AUTHORITY_VIOLATION', 'CAPABILITY_VIOLATION'])
}

const envelope = sealAgentContextEnvelope({
  envelopeId: 'envelope-m4-a1',
  role,
  binding,
  objective: contextItem('objective', { instruction: 'Prepare a plan proposal.' }),
  contextItems: [contextItem('page-context', { title: 'Fixture page' })],
  inputArtifacts: [artifact('input-page-1', 'page_snapshot', 'page-snapshot/v1', 'tool', 'untrusted_external')],
  allowedTools: ['artifact_read_json', 'artifact_list_refs'],
  budget: {
    schemaVersion: 'agent-execution-budget/v1',
    maxInputTokens: 2_000,
    maxOutputTokens: 500,
    maxTurns: 4,
    maxToolCalls: 6,
    timeoutMs: 60_000,
    deadlineAt: '2026-07-17T02:01:00.000Z',
  },
  createdAt: '2026-07-17T02:00:00.000Z',
  expiresAt: '2026-07-17T02:01:00.000Z',
  parentHistoryIncluded: false,
  livePageIncluded: false,
  browserWrite: false,
  authoritativeCompletionEvidence: false,
  requiresMainWorkflowVerification: true,
})
assert.equal(envelope.payloadDigest.length, 64)
assert.deepEqual(JSON.parse(JSON.stringify(envelope)), envelope, 'Context Envelope must JSON round-trip')

assertContractError(
  () => sealAgentContextEnvelope({ ...unsignedEnvelope(envelope), page: { click() {} } }),
  ['INVALID_CONTRACT'],
)
assertContractError(
  () => sealAgentContextEnvelope({
    ...unsignedEnvelope(envelope),
    objective: contextItem('secret-objective', { token: 'secret' }, { sensitivity: 'secret' }),
  }),
  ['AUTHORITY_VIOLATION'],
)
assertContractError(
  () => sealAgentContextEnvelope({
    ...unsignedEnvelope(envelope),
    inputArtifacts: [{ ...envelope.inputArtifacts[0], binding: { ...envelope.inputArtifacts[0].binding, revision: runRevision - 1 } }],
  }),
  ['STALE_REVISION'],
)
assertContractError(
  () => sealAgentContextEnvelope({
    ...unsignedEnvelope(envelope),
    contextItems: [contextItem('stale-context', { title: 'Old' }, { freshness: { validity: 'current', revision: runRevision - 1 } })],
  }),
  ['STALE_REVISION'],
)

const output = {
  ...artifact('output-plan-1', 'plan_proposal', 'plan-proposal/v1', 'subagent', 'non_authoritative'),
  parentArtifactIds: ['input-page-1'],
}
const result = {
  schemaVersion: AGENT_INVOCATION_RESULT_SCHEMA_VERSION,
  resultId: 'result-m4-a1',
  roleId: role.id,
  roleVersion: role.version,
  binding,
  startedAt: '2026-07-17T02:00:01.000Z',
  finishedAt: '2026-07-17T02:00:02.000Z',
  outcome: 'succeeded',
  outputArtifacts: [output],
  requiresMainWorkflowVerification: true,
  authoritativeCompletionEvidence: false,
}
validateAgentInvocationResult(result, envelope)

assertContractError(
  () => validateAgentInvocationResult({ ...result, authoritativeCompletionEvidence: true }, envelope),
  ['AUTHORITY_VIOLATION'],
)
assertContractError(
  () => validateAgentInvocationResult({
    ...result,
    outputArtifacts: [{ ...output, binding: { ...output.binding, revision: runRevision - 1 } }],
  }, envelope),
  ['STALE_REVISION'],
)
assertContractError(
  () => validateAgentInvocationResult({
    ...result,
    outputArtifacts: [{ ...output, producer: { id: 'foreign-role', version: role.version } }],
  }, envelope),
  ['BINDING_MISMATCH'],
)
assertContractError(
  () => validateAgentInvocationResult({ ...result, finishedAt: '2026-07-17T02:01:00.001Z' }, envelope),
  ['TIMEOUT'],
)

const cancellation = {
  schemaVersion: 'agent-cancellation-request/v1',
  requestId: 'cancel-m4-a1',
  requestedAt: '2026-07-17T02:00:01.500Z',
  reason: 'user',
  runId,
  runRevision,
  attempt: 2,
  invocationId: binding.invocationId,
}
assertContractError(() => validateAgentInvocationResult(result, envelope, cancellation), ['CANCELLED'])
const cancelledResult = {
  ...result,
  resultId: 'result-m4-a1-cancelled',
  outcome: 'cancelled',
  outputArtifacts: [],
  cancellationRequestId: cancellation.requestId,
}
validateAgentInvocationResult(cancelledResult, envelope, cancellation)

const notification = {
  schemaVersion: AGENT_RESULT_NOTIFICATION_SCHEMA_VERSION,
  notificationId: 'notification-m4-a1',
  dedupeKey: 'dedupe-m4-a1',
  binding,
  resultId: result.resultId,
  resultDigest: multiAgentDigest(result),
  createdAt: '2026-07-17T02:00:03.000Z',
  requiresMainWorkflowVerification: true,
  authoritativeCompletionEvidence: false,
}
const receipts = new Map()
assert.equal(acceptAgentResultNotification(notification, result, envelope, receipts).status, 'accepted')
assert.equal(acceptAgentResultNotification(notification, result, envelope, receipts).status, 'duplicate')
assertContractError(
  () => acceptAgentResultNotification({ ...notification, notificationId: 'notification-mutated' }, result, envelope, receipts),
  ['IDEMPOTENCY_CONFLICT'],
)

console.log('multi-agent-contract-test: PASS')

function artifactContract(direction, contractId, artifactKinds, payloadSchemaVersions) {
  return {
    schemaVersion: AGENT_ARTIFACT_CONTRACT_SCHEMA_VERSION,
    contractId,
    direction,
    artifactKinds,
    payloadSchemaVersions,
    mediaTypes: ['application/json'],
    minCount: 1,
    maxCount: 1,
    immutableRequired: true,
    freshness: 'current_run_revision',
    allowedOrigins: direction === 'input' ? ['tool'] : ['subagent'],
    allowedTrust: direction === 'input' ? ['untrusted_external'] : ['non_authoritative'],
    lineage: direction === 'input' ? 'none' : 'at_least_one_current_input',
    requiresMainWorkflowVerification: true,
    authoritativeCompletionEvidence: false,
  }
}

function contextItem(id, content, overrides = {}) {
  return {
    schemaVersion: 'context-item/v1',
    id,
    kind: 'agent_context',
    content,
    origin: 'user',
    trust: 'user_authorized',
    instructionAuthority: 'advisory',
    sensitivity: 'personal',
    provenance: { capturedAt: '2026-07-17T02:00:00.000Z', parentContentIds: [], runId },
    allowedUses: ['subagent'],
    freshness: { validity: 'current', revision: runRevision },
    retention: { scope: 'run', deleteWithSession: true },
    sanitization: { policyId: 'm4-a1-test/v1', status: 'unchanged', redactedFields: [], instructionNeutralized: false, transformedFrom: [] },
    integrity: { immutable: true, digestVerified: true },
    ...overrides,
  }
}

function artifact(id, kind, payloadSchemaVersion, origin, trust) {
  return {
    schemaVersion: 'artifact-ref/v1',
    id,
    kind,
    payloadSchemaVersion,
    mediaType: 'application/json',
    byteLength: 128,
    sha256: 'a'.repeat(64),
    createdAt: '2026-07-17T02:00:00.000Z',
    immutable: true,
    locator: `artifact:${id}`,
    producer: { id: origin === 'subagent' ? role.id : 'main-runtime', version: '1.0.0' },
    parentEvidenceIds: [],
    parentArtifactIds: [],
    origin,
    trust,
    sensitivity: 'internal',
    retention: { scope: 'run', deleteWithSession: true },
    binding: { runId, revision: runRevision, sessionRef: binding.sessionRef, actionSeq: binding.parentActionSeq },
    requiresMainWorkflowVerification: origin === 'subagent',
    authoritativeCompletionEvidence: false,
    redaction: { status: 'not_required', policyId: 'm4-a1-test/v1' },
    scanner: { status: 'clean', scannerId: 'm4-a1-test/v1' },
  }
}

function unsignedEnvelope(value) {
  const { schemaVersion: _schemaVersion, payloadDigest: _payloadDigest, ...input } = value
  return structuredClone(input)
}

function assertContractError(operation, codes) {
  assert.throws(operation, (error) => {
    assert(error instanceof MultiAgentContractError)
    assert(codes.includes(error.code), `expected ${codes.join('|')}, got ${error.code}: ${error.message}`)
    return true
  })
}
