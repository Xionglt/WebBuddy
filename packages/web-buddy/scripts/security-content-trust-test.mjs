#!/usr/bin/env node
import assert from 'node:assert/strict'
import {
  classifyContentSecurity,
  deriveContentSecurity,
  toContextSecurityFields,
} from '../dist/security/index.js'

const now = new Date('2026-07-17T00:00:00.000Z')

const missing = classifyContentSecurity({ contentId: 'missing', now })
assert.equal(missing.origin, 'derived')
assert.equal(missing.trust, 'derived_untrusted')
assert.equal(missing.sensitivity, 'secret')
assert.equal(missing.classification.status, 'fail_closed')
assert(missing.classification.reasons.includes('origin_missing_or_invalid'))
assert(missing.classification.reasons.includes('sensitivity_missing_or_invalid'))

for (const origin of ['web', 'download', 'tool', 'memory']) {
  const item = classifyContentSecurity({
    contentId: origin,
    origin,
    trust: 'trusted_runtime',
    sensitivity: 'public',
    provenance: { capturedAt: now.toISOString(), parentContentIds: [] },
  })
  assert.equal(item.trust, 'untrusted_external', `${origin} must not self-elevate trust`)
  assert.equal(item.classification.status, 'fail_closed')
  assert(item.classification.reasons.includes('trust_clamped_for_origin'))
}

const downgradedMemory = classifyContentSecurity({
  contentId: 'downgraded-memory',
  origin: 'memory',
  trust: 'derived_untrusted',
  sensitivity: 'internal',
  provenance: { capturedAt: now.toISOString(), parentContentIds: [] },
})
assert.equal(downgradedMemory.trust, 'derived_untrusted')
assert.equal(downgradedMemory.classification.status, 'classified', 'explicit trust reduction must remain valid')

const subagent = classifyContentSecurity({
  contentId: 'subagent',
  origin: 'subagent',
  trust: 'user_authorized',
  sensitivity: 'internal',
  provenance: { capturedAt: now.toISOString(), parentContentIds: [] },
})
assert.equal(subagent.trust, 'non_authoritative')
assert(subagent.classification.reasons.includes('trust_clamped_for_origin'))

const trustedSystem = classifyContentSecurity({
  contentId: 'runtime-policy',
  origin: 'system',
  trust: 'trusted_runtime',
  sensitivity: 'internal',
  provenance: { capturedAt: now.toISOString(), parentContentIds: [] },
})
assert.equal(trustedSystem.classification.status, 'classified')
assert.equal(trustedSystem.trust, 'trusted_runtime')

const defaultWeb = classifyContentSecurity({
  contentId: 'default-web',
  origin: 'web',
  sensitivity: 'public',
  provenance: { capturedAt: now.toISOString(), parentContentIds: [] },
})
assert.equal(defaultWeb.trust, 'untrusted_external', 'web content must default to untrusted')
assert.equal(defaultWeb.classification.status, 'classified')

for (const origin of ['artifact', 'derived']) {
  const elevated = classifyContentSecurity({
    contentId: `elevated-${origin}`,
    origin,
    trust: 'trusted_runtime',
    sensitivity: 'public',
    provenance: { capturedAt: now.toISOString(), parentContentIds: [] },
  })
  assert.equal(elevated.trust, 'derived_untrusted')
  assert.equal(elevated.classification.status, 'fail_closed')
  assert(elevated.classification.reasons.includes('trust_clamped_for_origin'))
}

const unknown = classifyContentSecurity({
  contentId: 'unknown',
  origin: 'remote_frame',
  trust: 'root',
  sensitivity: 'probably_public',
  provenance: {
    capturedAt: now.toISOString(),
    parentContentIds: ['parent-a', '', 'parent-a'],
    sha256: 'not-a-digest',
  },
})
assert.equal(unknown.origin, 'derived')
assert.equal(unknown.trust, 'derived_untrusted')
assert.equal(unknown.sensitivity, 'secret')
assert.deepEqual(unknown.provenance.parentContentIds, ['parent-a'])
assert.equal('sha256' in unknown.provenance, false)
assert(unknown.classification.reasons.includes('provenance_parent_ids_invalid'))
assert(unknown.classification.reasons.includes('provenance_sha256_invalid'))

const malformedParents = classifyContentSecurity({
  contentId: 'malformed-parents',
  origin: 'web',
  sensitivity: 'public',
  provenance: { capturedAt: now.toISOString(), parentContentIds: 'forged-parent-id' },
})
assert.deepEqual(malformedParents.provenance.parentContentIds, [])
assert(malformedParents.classification.reasons.includes('provenance_parent_ids_invalid'))

const publicUser = classifyContentSecurity({
  contentId: 'user-profile',
  origin: 'user',
  trust: 'user_authorized',
  sensitivity: 'personal',
  provenance: { capturedAt: now.toISOString(), parentContentIds: [], runId: 'run-s1' },
})
const injectedWeb = classifyContentSecurity({
  contentId: 'web-page',
  origin: 'web',
  sensitivity: 'secret',
  provenance: {
    capturedAt: now.toISOString(),
    parentContentIds: ['network-response'],
    runId: 'run-s1',
    sourceOrigin: 'https://attacker.example.test',
  },
})
const derived = deriveContentSecurity([publicUser, injectedWeb], {
  contentId: 'summary',
  sensitivity: 'public',
  now,
  provenance: { runId: 'run-s1', parentContentIds: ['manual-parent'] },
})
assert.equal(derived.origin, 'derived')
assert.equal(derived.trust, 'derived_untrusted')
assert.equal(derived.sensitivity, 'secret', 'derivation must inherit the highest sensitivity')
assert.equal(derived.classification.status, 'fail_closed')
assert(derived.classification.reasons.includes('sensitivity_downgrade_blocked'))
assert.deepEqual(
  derived.provenance.parentContentIds,
  ['user-profile', 'web-page', 'network-response', 'manual-parent'],
)

const derivedFromSubagent = deriveContentSecurity([subagent], {
  contentId: 'subagent-summary',
  now,
})
assert.equal(derivedFromSubagent.trust, 'non_authoritative')

const derivedFromTrustedSystem = deriveContentSecurity([trustedSystem], {
  contentId: 'trusted-system-summary',
  now,
})
assert.equal(
  derivedFromTrustedSystem.trust,
  'derived_untrusted',
  'derived content must not retain executable trusted-runtime authority',
)

const orphan = deriveContentSecurity([], { contentId: 'orphan', now })
assert.equal(orphan.trust, 'derived_untrusted')
assert.equal(orphan.sensitivity, 'secret')
assert(orphan.classification.reasons.includes('derivation_without_parents'))

for (const value of [missing, missing.provenance, missing.provenance.parentContentIds, missing.classification, missing.classification.reasons, derived]) {
  assert.equal(Object.isFrozen(value), true, 'security metadata and nested lineage must be immutable')
}
assert.throws(() => {
  missing.provenance.parentContentIds.push('mutated')
}, TypeError)

const contextFields = toContextSecurityFields(derived)
contextFields.provenance.parentContentIds.push('clone-only')
assert.equal(derived.provenance.parentContentIds.includes('clone-only'), false)

assert.throws(
  () => classifyContentSecurity({ contentId: '   ', origin: 'web', sensitivity: 'public' }),
  /contentId must be a non-empty string/,
)

console.log('security-content-trust-test: PASS')
