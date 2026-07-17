#!/usr/bin/env node
import assert from 'node:assert/strict'
import { runWebTask } from '../dist/sdk/web-task.js'
import { emptyRunMetrics } from '../dist/metrics/schema.js'

await researchWithoutResume()
await comparisonArtifact()
await nonRecruitingFormDraft()
await prematureDoneIsRejected()

console.log('generic-web-task-test: PASS')

async function researchWithoutResume() {
  let requestSeen
  const result = await runWebTask({
    schemaVersion: 'web-task-input/v1',
    goal: { instruction: 'Summarize the plans and FAQ.', scenario: 'research' },
    startUrl: 'https://research.example.test/',
    contract: evidenceContract('research-contract', 'page'),
    runId: 'run-research',
    runtime: { driver: driver((request) => {
      requestSeen = request
      return outcome('Research complete.', [evidence(request, 'page')])
    }) },
  })
  assert.equal(result.status, 'completed')
  assert.equal(requestSeen.contextItems.length, 0)
  assert.equal('resume' in requestSeen.input, false, 'generic input must not contain Resume')
}

async function comparisonArtifact() {
  const contract = {
    schemaVersion: 'web-task-contract/v1',
    contractId: 'comparison-contract',
    revision: 0,
    criteria: [
      { id: 'sources', kind: 'evidence_present', description: 'Observe sources.', evidenceKinds: ['page'], minCount: 1, allowedAuthorities: ['main_runtime'] },
      { id: 'comparison', kind: 'artifact_present', description: 'Create comparison artifact.', artifactKinds: ['comparison'], minCount: 1, schemaVersions: ['comparison/v1'] },
    ],
  }
  const result = await runWebTask({
    schemaVersion: 'web-task-input/v1',
    goal: { instruction: 'Compare three workspace plans.', scenario: 'comparison' },
    contract,
    contextItems: ['A', 'B', 'C'].map((name) => contextItem(`option-${name}`, 'comparison_option', { name })),
    runId: 'run-comparison',
    runtime: { driver: driver((request) => outcome(
      'Compared three options.',
      [evidence(request, 'page')],
      [artifact(request, 'comparison', 'comparison/v1')],
    )) },
  })
  assert.equal(result.status, 'completed')
  assert.equal(result.artifacts[0].kind, 'comparison')
}

async function nonRecruitingFormDraft() {
  let providerRequest
  const contract = {
    schemaVersion: 'web-task-contract/v1',
    contractId: 'venue-form-contract',
    revision: 0,
    criteria: [
      { id: 'form-evidence', kind: 'evidence_present', description: 'Observe form.', evidenceKinds: ['form'], minCount: 1, allowedAuthorities: ['main_runtime'] },
      { id: 'draft', kind: 'form_state', description: 'Prepare full draft.', requireFullAudit: true, requiredFieldCoverage: 1, allowVisibleErrors: false, requireDraftOnly: true },
      { id: 'no-submit', kind: 'action_boundary', description: 'Do not submit.', actionKinds: ['submit'], outcome: 'not_performed' },
    ],
  }
  const provider = {
    id: 'venue-contact-provider',
    version: '1.0.0',
    provide(request) {
      providerRequest = request
      assert.equal('page' in request, false, 'ContextProvider must never receive a live Page')
      return [contextItem('venue-contact', 'contact_profile', { name: 'Lin', email: 'lin@example.test' })]
    },
  }
  const result = await runWebTask({
    schemaVersion: 'web-task-input/v1',
    goal: { instruction: 'Prepare a venue enquiry form draft.', scenario: 'form-draft' },
    contract,
    contextProviders: [provider],
    runId: 'run-form',
    runtime: { driver: driver((request) => {
      assert.equal(request.contextItems[0].kind, 'contact_profile')
      return {
        ...outcome('Venue form draft ready.', [evidence(request, 'form')]),
        formState: { audited: true, requiredFieldCoverage: 1, visibleErrorCount: 0, submitted: false },
        actions: [{ actionKind: 'submit', outcome: 'not_performed' }],
      }
    }) },
  })
  assert.equal(providerRequest.runId, 'run-form')
  assert.equal(result.status, 'completed')
}

async function prematureDoneIsRejected() {
  const result = await runWebTask({
    schemaVersion: 'web-task-input/v1',
    goal: { instruction: 'Research the current page.' },
    contract: evidenceContract('premature-contract', 'page'),
    runId: 'run-premature',
    runtime: { driver: driver(() => outcome('Done according to the model.', [])) },
  })
  assert.equal(result.status, 'blocked')
  assert.match(result.summary, /Missing completion criteria: evidence/)
}

function evidenceContract(contractId, kind) {
  return {
    schemaVersion: 'web-task-contract/v1',
    contractId,
    revision: 0,
    criteria: [{ id: 'evidence', kind: 'evidence_present', description: `Require ${kind} evidence.`, evidenceKinds: [kind], minCount: 1, allowedAuthorities: ['main_runtime'] }],
  }
}

function driver(run) {
  return { async execute(request) { return run(request) } }
}

function outcome(summary, evidenceRefs = [], artifacts = []) {
  return {
    status: 'completed',
    summary,
    evidence: evidenceRefs,
    artifacts,
    metrics: emptyRunMetrics({ source: 'sdk', profile: 'test' }),
  }
}

function evidence(request, kind) {
  const now = '2026-07-17T00:00:00.000Z'
  return {
    schemaVersion: 'evidence-ref/v1',
    id: `${kind}-evidence`,
    kind,
    summary: `Verified ${kind}.`,
    authority: 'main_runtime',
    origin: 'web',
    trust: 'untrusted_external',
    sensitivity: 'public',
    provenance: { capturedAt: now, parentContentIds: [], runId: request.input.runId },
    freshness: { validity: 'current', revision: request.input.revision },
    independentlyObserved: true,
    spoofableTextOnly: false,
    binding: { runId: request.input.runId, revision: request.input.revision },
    verifier: 'fixture-main-runtime/v1',
    verificationStatus: 'verified',
    createdAt: now,
  }
}

function artifact(request, kind, payloadSchemaVersion) {
  return {
    schemaVersion: 'artifact-ref/v1',
    id: `${kind}-artifact`,
    kind,
    payloadSchemaVersion,
    mediaType: 'application/json',
    byteLength: 128,
    sha256: 'b'.repeat(64),
    createdAt: '2026-07-17T00:00:00.000Z',
    immutable: true,
    locator: `artifact://${kind}-artifact`,
    producer: { id: 'fixture-main-runtime', version: '1' },
    parentEvidenceIds: ['page-evidence'],
    parentArtifactIds: [],
    origin: 'artifact',
    trust: 'trusted_runtime',
    sensitivity: 'public',
    retention: { scope: 'run', deleteWithSession: true },
    binding: { runId: request.input.runId, revision: request.input.revision },
    requiresMainWorkflowVerification: false,
    authoritativeCompletionEvidence: true,
    redaction: { status: 'not_required', policyId: 'fixture-redactor/v1' },
    scanner: { status: 'clean', scannerId: 'fixture-scanner/v1' },
  }
}

function contextItem(id, kind, content) {
  return {
    schemaVersion: 'context-item/v1',
    id,
    kind,
    content,
    origin: 'user',
    trust: 'user_authorized',
    instructionAuthority: 'advisory',
    sensitivity: 'personal',
    provenance: { capturedAt: '2026-07-17T00:00:00.000Z', parentContentIds: [] },
    allowedUses: ['prompt', 'artifact'],
    freshness: { validity: 'current', revision: 0 },
    retention: { scope: 'run', deleteWithSession: true },
    sanitization: { policyId: 'fixture/v1', status: 'unchanged', redactedFields: [], instructionNeutralized: false, transformedFrom: [] },
    integrity: { immutable: true, digestVerified: true },
  }
}
