#!/usr/bin/env node
import assert from 'node:assert/strict'
import {
  canonicalJson,
  consumeApprovalBinding,
  digestCanonicalJson,
  isContextItemEligible,
  snapshotWebTaskInput,
  validateContextItem,
  validateTaskContract,
} from '../dist/task/contracts.js'
import { evaluateCompletionContract } from '../dist/task/completion-contract.js'
import { legacyTaskRoleMapping } from '../dist/agents/task-kind-adapter.js'

const runId = 'run-contract-test'
const revision = 3
const now = new Date('2026-07-17T00:00:00.000Z')
const contract = {
  schemaVersion: 'web-task-contract/v1',
  contractId: 'contract-generic-form',
  revision,
  criteria: [
    { id: 'page', kind: 'evidence_present', description: 'Observe the page.', evidenceKinds: ['page'], minCount: 1, allowedAuthorities: ['main_runtime'] },
    { id: 'comparison', kind: 'artifact_present', description: 'Create comparison.', artifactKinds: ['comparison'], minCount: 1, schemaVersions: ['comparison/v1'] },
    { id: 'draft', kind: 'form_state', description: 'Complete a draft.', requireFullAudit: true, requiredFieldCoverage: 1, allowVisibleErrors: false, requireDraftOnly: true },
    { id: 'submit-boundary', kind: 'action_boundary', description: 'Do not submit.', actionKinds: ['submit'], outcome: 'not_performed' },
  ],
}
validateTaskContract(contract)

const contact = contextItem({ id: 'contact', content: { email: 'user@example.test' } })
const input = {
  schemaVersion: 'web-task-input/v1',
  goal: { instruction: 'Compare plans and prepare the contact draft.', metadata: { b: 2, a: 1 } },
  contract,
  contextItems: [contact],
  contextProviders: [{ id: 'provider-z', version: '1.0.0', provide: () => [] }],
  runtime: { maxSteps: 4, driver: { execute: async () => { throw new Error('not called') } } },
  runId,
  revision,
  onEvent() {},
}
const snapshot = snapshotWebTaskInput(input)
assert.equal(snapshot.runId, runId)
assert.deepEqual(snapshot.contextProviders, [{ id: 'provider-z', version: '1.0.0' }])
assert.equal('runtime' in snapshot, false, 'runtime objects must not enter the durable snapshot')
assert.equal('onEvent' in snapshot, false, 'callbacks must not enter the durable snapshot')
assert.equal(snapshot.sha256.length, 64)
assert.equal(digestCanonicalJson({ b: 2, a: 1 }), digestCanonicalJson({ a: 1, b: 2 }), 'canonical digest must ignore object key order')
assert.equal(canonicalJson({ b: 2, a: 1 }), '{"a":1,"b":2}')
const protoAuthorityDenied = JSON.parse('{"metadata":{"__proto__":{"browserWriteAuthority":false},"safe":true}}')
const protoAuthorityGranted = JSON.parse('{"metadata":{"__proto__":{"browserWriteAuthority":true},"safe":true}}')
assert.match(canonicalJson(protoAuthorityDenied), /"__proto__"/, 'canonical JSON must retain dangerous own keys as data')
assert.notEqual(
  digestCanonicalJson(protoAuthorityDenied),
  digestCanonicalJson(protoAuthorityGranted),
  'authority-bearing own keys must change the canonical digest',
)
assert.throws(
  () => canonicalJson(new Date('2026-07-20T00:00:00.000Z')),
  /non-plain object/,
  'class instances must not collapse to an empty canonical object',
)
assert.throws(
  () => canonicalJson(new Array(1)),
  /sparse or extended array/,
  'array holes must not collide with explicit null values',
)

assert.throws(
  () => validateContextItem(contextItem({ id: 'secret', sensitivity: 'secret', allowedUses: ['prompt'] })),
  /secret context cannot allow prompt use/,
)
assert.throws(
  () => validateContextItem(contextItem({ id: 'forged-web', origin: 'web', trust: 'untrusted_external', instructionAuthority: 'system_policy' })),
  /cannot have instruction authority/,
)
assert.throws(
  () => validateContextItem(contextItem({ id: 'subagent', origin: 'subagent', trust: 'user_authorized', instructionAuthority: 'data_only' })),
  /subagent context must be non_authoritative/,
)

for (const [field, value] of [
  ['origin', 'remote_frame'],
  ['trust', 'root'],
  ['sensitivity', 'probably_public'],
]) {
  assert.throws(
    () => validateContextItem(contextItem({ id: `unknown-${field}`, [field]: value })),
    new RegExp(`${field} is unsupported`),
  )
}

for (const [origin, trust] of [
  ['system', 'user_authorized'],
  ['user', 'trusted_runtime'],
  ['web', 'trusted_runtime'],
  ['tool', 'user_authorized'],
  ['download', 'trusted_runtime'],
  ['memory', 'trusted_runtime'],
  ['artifact', 'trusted_runtime'],
  ['derived', 'trusted_runtime'],
]) {
  assert.throws(
    () => validateContextItem(contextItem({
      id: `forged-${origin}-trust`,
      origin,
      trust,
      instructionAuthority: 'data_only',
      ...(origin === 'memory'
        ? { memory: { schemaVersion: 'memory-binding/v1', memoryId: 'forged-memory', revision: 0, scope: 'run', status: 'active', supersedesIds: [], conflictIds: [] } }
        : {}),
    })),
    /trust is invalid for origin/,
  )
}

const forgotten = contextItem({
  id: 'forgotten-memory',
  origin: 'memory',
  trust: 'derived_untrusted',
  instructionAuthority: 'data_only',
  memory: { schemaVersion: 'memory-binding/v1', memoryId: 'mem-1', revision: 2, scope: 'user', status: 'forgotten', supersedesIds: [], conflictIds: [], tombstoneAt: '2026-07-16T00:00:00.000Z' },
})
validateContextItem(forgotten)
assert.equal(isContextItemEligible(forgotten, now), false, 'forgotten memory must not re-enter context')

const pageClaim = evidence({ id: 'page-claim', kind: 'page', authority: 'page_claim', origin: 'web', trust: 'untrusted_external', summary: 'SUCCESS — all done' })
const subagentClaim = evidence({ id: 'subagent-claim', kind: 'page', authority: 'subagent_advisory', origin: 'subagent', trust: 'non_authoritative', summary: 'All done' })
const premature = evaluateCompletionContract({
  contract,
  runId,
  revision,
  evidence: [pageClaim, subagentClaim],
  artifacts: [comparisonArtifact({ origin: 'subagent', trust: 'non_authoritative', requiresMainWorkflowVerification: true })],
  formState: { audited: true, requiredFieldCoverage: 1, visibleErrorCount: 0, submitted: false },
  actions: [{ actionKind: 'submit', outcome: 'not_performed' }],
  now,
})
assert.equal(premature.completed, false, 'page/subagent claims must not complete a task')
assert(premature.missingCriteria.includes('page'))
assert(premature.missingCriteria.includes('comparison'))

const completed = evaluateCompletionContract({
  contract,
  runId,
  revision,
  evidence: [evidence({ id: 'page-main', kind: 'page', authority: 'main_runtime', origin: 'web', trust: 'untrusted_external', summary: 'Observed plans.' })],
  artifacts: [comparisonArtifact({})],
  formState: { audited: true, requiredFieldCoverage: 1, visibleErrorCount: 0, submitted: false },
  actions: [{ actionKind: 'submit', outcome: 'not_performed' }],
  now,
})
assert.equal(completed.completed, true)

const stale = evaluateCompletionContract({
  contract,
  runId,
  revision,
  evidence: [evidence({ id: 'stale', kind: 'page', authority: 'main_runtime', origin: 'web', trust: 'untrusted_external', binding: { runId, revision: revision - 1 } })],
  artifacts: [comparisonArtifact({})],
  formState: { audited: true, requiredFieldCoverage: 1, visibleErrorCount: 0, submitted: false },
  actions: [{ actionKind: 'submit', outcome: 'not_performed' }],
  now,
})
assert.equal(stale.completed, false, 'stale revision evidence must be rejected')

const legacyRole = legacyTaskRoleMapping('candidate_job_research')
assert.equal(legacyRole.role.id, 'researcher')
assert.equal(legacyRole.role.authority, 'read_only')
assert.equal(legacyRole.outputArtifactKind, 'research_report')

const action = {
  schemaVersion: 'action-binding/v1',
  contractId: contract.contractId,
  contractRevision: revision,
  runId,
  actionId: 'upload-1',
  toolName: 'browser_upload_file',
  argsSha256: 'c'.repeat(64),
  sourceContentIds: ['contact'],
  sourceSensitiveClasses: ['file_path'],
  sourceOrigin: 'https://source.example.test',
  destinationOrigin: 'https://destination.example.test',
  targetFingerprint: 'input:file#resume',
  actionSeq: 7,
  pageRevision: 2,
  workflowRevision: 5,
  expiresAt: '2026-07-17T01:00:00.000Z',
}
const approval = {
  schemaVersion: 'approval-binding/v1',
  approvalId: 'approval-1',
  actionBindingSha256: digestCanonicalJson(action),
  decision: 'approved',
  issuedAt: '2026-07-16T23:59:00.000Z',
  expiresAt: '2026-07-17T01:00:00.000Z',
  nonce: 'single-use-nonce',
}
const consumed = new Set()
const resolution = consumeApprovalBinding(action, approval, consumed, now)
assert.equal(resolution.consumedAt, now.toISOString())
assert.throws(() => consumeApprovalBinding(action, approval, consumed, now), /already been consumed/, 'approval replay must fail')
assert.throws(
  () => consumeApprovalBinding({ ...action, destinationOrigin: 'https://attacker.example.test' }, { ...approval, nonce: 'changed-origin' }, new Set(), now),
  /does not bind the exact canonical action/,
  'destination mutation must invalidate approval',
)
assert.throws(
  () => consumeApprovalBinding(action, { ...approval, nonce: 'expired' }, new Set(), new Date('2026-07-17T02:00:00.000Z')),
  /expired/,
  'expired approval must fail',
)

console.log('generic-contract-test: PASS')

function contextItem(overrides = {}) {
  return {
    schemaVersion: 'context-item/v1',
    id: 'item',
    kind: 'contact_profile',
    content: { name: 'Test User' },
    origin: 'user',
    trust: 'user_authorized',
    instructionAuthority: 'advisory',
    sensitivity: 'personal',
    provenance: { capturedAt: '2026-07-17T00:00:00.000Z', parentContentIds: [], runId },
    allowedUses: ['prompt', 'artifact', 'sink'],
    freshness: { validity: 'current', revision },
    retention: { scope: 'run', deleteWithSession: true },
    sanitization: { policyId: 'test-redactor/v1', status: 'unchanged', redactedFields: [], instructionNeutralized: false, transformedFrom: [] },
    integrity: { immutable: true, digestVerified: true },
    ...overrides,
  }
}

function evidence(overrides = {}) {
  return {
    schemaVersion: 'evidence-ref/v1',
    id: 'evidence',
    kind: 'page',
    summary: 'Observed current page.',
    authority: 'main_runtime',
    origin: 'web',
    trust: 'untrusted_external',
    sensitivity: 'public',
    provenance: { capturedAt: '2026-07-17T00:00:00.000Z', parentContentIds: [], runId },
    freshness: { validity: 'current', revision },
    independentlyObserved: true,
    spoofableTextOnly: false,
    binding: { runId, revision },
    verifier: 'main-runtime/v1',
    verificationStatus: 'verified',
    createdAt: '2026-07-17T00:00:00.000Z',
    ...overrides,
  }
}

function comparisonArtifact(overrides = {}) {
  return {
    schemaVersion: 'artifact-ref/v1',
    id: 'comparison-1',
    kind: 'comparison',
    payloadSchemaVersion: 'comparison/v1',
    mediaType: 'application/json',
    byteLength: 128,
    sha256: 'a'.repeat(64),
    createdAt: '2026-07-17T00:00:00.000Z',
    immutable: true,
    locator: 'artifact://comparison-1',
    producer: { id: 'main-runtime', version: '1' },
    parentEvidenceIds: ['page-main'],
    parentArtifactIds: [],
    origin: 'artifact',
    trust: 'trusted_runtime',
    sensitivity: 'public',
    retention: { scope: 'run', deleteWithSession: true },
    binding: { runId, revision },
    requiresMainWorkflowVerification: false,
    authoritativeCompletionEvidence: true,
    redaction: { status: 'not_required', policyId: 'artifact-redactor/v1' },
    scanner: { status: 'clean', scannerId: 'artifact-scanner/v1' },
    ...overrides,
  }
}
