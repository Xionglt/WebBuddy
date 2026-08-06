#!/usr/bin/env node
import assert from 'node:assert/strict'

import {
  buildPageSemanticFingerprint,
  evaluateWebMemoryGovernance,
  pageSemanticFingerprintSimilarity,
} from '../dist/memory/web-memory-governance.js'
import { retrieveLifecycleMemoryContextBatch } from '../dist/memory/context-provider.js'
import { validateContextItem } from '../dist/task/contracts.js'

const saved = fingerprint({
  fields: [field('Full name', 'text', true), field('Resume', 'file', true)],
  actions: [action('Save draft', 'L2'), action('Preview application', 'L3')],
})
const reordered = fingerprint({
  fields: [field('Resume', 'file', true), field('Full name', 'text', true)],
  actions: [action('Preview application', 'L3'), action('Save draft', 'L2')],
})
const drifted = fingerprint({
  fields: [field('Resume', 'file', true), field('Full name', 'text', true)],
  actions: [action('Submit application', 'L4'), action('Save draft', 'L2')],
})

assert.equal(saved.digest, reordered.digest, 'layout reordering must not invalidate semantic memory')
assert.equal(pageSemanticFingerprintSimilarity(saved, reordered), 1)
assert(pageSemanticFingerprintSimilarity(saved, drifted) < 0.8, 'preview-to-submit drift must fail the default gate')

const procedure = webMemory('procedure', {
  pageFingerprint: saved,
  mode: 'current_page',
})
assert.deepEqual(evaluateWebMemoryGovernance(record('procedure', procedure), {
  currentUrl: 'https://jobs.example/apply/999',
  workflow: 'job_application',
}), {
  status: 'advisory',
  reasonCode: 'page_fingerprint_required',
  requiresLiveVerification: true,
  canExpandPermissions: false,
})
const verified = evaluateWebMemoryGovernance(record('procedure', procedure), {
  currentUrl: 'https://jobs.example/apply/999',
  workflow: 'job_application',
  pageFingerprint: reordered,
})
assert.equal(verified.status, 'advisory')
assert.equal(verified.reasonCode, 'procedure_verified_against_current_page')
assert.equal(verified.fingerprintSimilarity, 1)
const rejectedDrift = evaluateWebMemoryGovernance(record('procedure', procedure), {
  currentUrl: 'https://jobs.example/apply/999',
  workflow: 'job_application',
  pageFingerprint: drifted,
})
assert.equal(rejectedDrift.status, 'rejected')
assert.equal(rejectedDrift.reasonCode, 'page_fingerprint_mismatch')

assert.equal(evaluateWebMemoryGovernance(record('auth', webMemory('authorization')), {
  currentUrl: 'https://jobs.example/apply/123',
  workflow: 'job_application',
}).reasonCode, 'historical_authorization_rejected')
assert.equal(evaluateWebMemoryGovernance(record('constraint', webMemory('restrictive_constraint')), {
  currentUrl: 'https://jobs.example/apply/123',
  workflow: 'job_application',
}).status, 'eligible')
assert.equal(evaluateWebMemoryGovernance(record('wrong-site', procedure), {
  currentUrl: 'https://attacker.example/apply/123',
  workflow: 'job_application',
  pageFingerprint: reordered,
}).reasonCode, 'origin_mismatch')

const retrieval = {
  schemaVersion: 'memory-lifecycle-retrieval-result/v2',
  mode: 'keyword',
  records: [
    ranked(record('procedure', procedure)),
    ranked(record('auth', webMemory('authorization'))),
    ranked(record('constraint', webMemory('restrictive_constraint'))),
  ],
}
const batch = await retrieveLifecycleMemoryContextBatch({
  service: { async retrieve() { return retrieval } },
  ownerScope: { schemaVersion: 'owner-scope/v1', tenantId: 'tenant-a', userId: 'user-a' },
  query: 'apply using remembered preferences',
  runId: 'run-current',
  revision: 4,
  sessionId: 'session-current',
  maxResults: 5,
  currentUrl: 'https://jobs.example/apply/999',
  workflow: 'job_application',
  pageFingerprint: reordered,
})
assert.equal(batch.status, 'retrieved')
assert.equal(batch.contextItems.length, 2, 'historical authorization must be removed before prompt injection')
assert.deepEqual(batch.governance, {
  evaluated: 3,
  injected: 2,
  eligible: 1,
  advisory: 1,
  rejected: 1,
  reasons: {
    procedure_verified_against_current_page: 1,
    historical_authorization_rejected: 1,
    restrictive_constraint: 1,
  },
})
const procedureContext = batch.contextItems.find((item) => item.memory.memoryId === 'procedure')
assert(procedureContext)
assert.equal(procedureContext.content.schemaVersion, 'governed-web-memory-context/v1')
assert.equal(procedureContext.content.governance.canExpandPermissions, false)
assert.equal(procedureContext.instructionAuthority, 'data_only')
for (const item of batch.contextItems) assert.doesNotThrow(() => validateContextItem(item))

console.log('web-memory-governance-test: PASS')

function fingerprint({ fields, actions }) {
  return buildPageSemanticFingerprint({
    page: { url: 'https://jobs.example/apply/123?source=feed', pageType: 'form' },
    form: {
      url: 'https://jobs.example/apply/123?source=feed',
      fields,
      submitCandidates: actions,
    },
    workflowStage: 'job_application',
  })
}

function field(label, controlKind, required) {
  return {
    index: 0,
    label,
    controlKind,
    required,
    filled: false,
    disabled: false,
    readonly: false,
    invalid: false,
  }
}

function action(text, risk) {
  return { tag: 'button', role: 'button', text, risk, visible: true }
}

function webMemory(effect, options = {}) {
  return {
    schemaVersion: 'web-memory/v1',
    effect,
    statement: effect === 'authorization'
      ? 'The user once allowed automatic submission.'
      : effect === 'restrictive_constraint'
        ? 'Always ask before final submission.'
        : 'The third form step used to lead to a preview page.',
    applicability: {
      urlOrigin: 'https://jobs.example',
      pathPattern: '/apply/:id',
      workflow: 'job_application',
    },
    evidence: {
      source: effect === 'procedure' ? 'runtime_observation' : 'user_instruction',
      capturedAt: '2026-08-01T00:00:00.000Z',
      ...(options.pageFingerprint ? { pageFingerprint: options.pageFingerprint } : {}),
    },
    validation: {
      mode: options.mode ?? (effect === 'authorization' ? 'current_session' : 'none'),
    },
  }
}

function ranked(record) {
  return { record, score: 1, reason: 'keyword' }
}

function record(entryId, content) {
  return {
    schemaVersion: 'memory-lifecycle-record/v2',
    entryId,
    contentVersionId: `${entryId}:v1`,
    revision: 1,
    state: 'active',
    content,
    contentHash: 'a'.repeat(64),
    scope: { kind: 'user', tenantId: 'tenant-a', userId: 'user-a' },
    trust: 'user_authorized',
    sensitivity: 'personal',
    provenance: {
      contentId: `${entryId}:v1`,
      capturedAt: '2026-08-01T00:00:00.000Z',
      parentContentIds: [],
      runId: 'memory-source-run',
    },
    derivedFrom: [],
    transformChain: [],
    confidence: 1,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    supersedes: [],
    conflicts: [],
  }
}
