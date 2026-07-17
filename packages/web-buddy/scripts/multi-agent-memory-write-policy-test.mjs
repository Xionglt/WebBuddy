#!/usr/bin/env node
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'

const sourceUrl = new URL('../src/memory/memory-write-policy.ts', import.meta.url)
const distUrl = new URL('../dist/memory/memory-write-policy.js', import.meta.url)
const useSource = process.env.WEB_BUDDY_TEST_SOURCE === '1' || !existsSync(distUrl)
if (useSource) {
  const { registerHooks } = await import('node:module')
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL?.includes('/src/')) {
        const typescriptUrl = new URL(`${specifier.slice(0, -3)}.ts`, context.parentURL)
        if (existsSync(typescriptUrl)) return { url: typescriptUrl.href, shortCircuit: true }
      }
      return nextResolve(specifier, context)
    },
  })
}

const {
  MEMORY_ENTRY_SCHEMA_VERSION,
  createPolicyEnforcedMemoryWriter,
  evaluateMemoryWriteRequest,
  memoryContentHash,
} = await import(useSource ? sourceUrl : distUrl)

const actorScope = {
  tenantId: 'tenant-a',
  userId: 'user-a',
  runId: 'run-a',
}

{
  const store = spyStore()
  const writer = createPolicyEnforcedMemoryWriter({ store, actorScope })
  const request = directUserRequest()
  const decision = await writer.write(request)
  assert.equal(decision.action, 'allow', JSON.stringify(decision))
  assert.equal(store.calls.length, 1)
  assert.equal(store.calls[0].schemaVersion, MEMORY_ENTRY_SCHEMA_VERSION)
  assert.equal(store.calls[0].contentHash, memoryContentHash(request.content))
  assert(Object.isFrozen(decision.entry))
  assert(Object.isFrozen(decision.entry.derivedFrom[0]))
  assert.deepEqual(JSON.parse(JSON.stringify(decision.entry)), decision.entry)
}

{
  const store = spyStore()
  const writer = createPolicyEnforcedMemoryWriter({ store, actorScope })
  const request = transformedRequest({
    kind: 'summary',
    parent: source('user-source', 'user', 'user_authorized', 'public'),
    trust: 'derived_untrusted',
    targetScope: { kind: 'run', tenantId: 'tenant-a', userId: 'user-a', runId: 'run-a' },
  })
  const decision = await writer.write(request)
  assert.equal(decision.action, 'allow', JSON.stringify(decision))
  assert.equal(decision.entry.trust, 'derived_untrusted')
  assert.equal(store.calls.length, 1)
}

for (const origin of ['web', 'download', 'tool', 'subagent']) {
  const trust = origin === 'subagent' ? 'non_authoritative' : 'untrusted_external'
  await deniedWithoutStore(
    directRequest(source(`${origin}-source`, origin, trust, 'public'), {
      kind: 'user',
      tenantId: 'tenant-a',
      userId: 'user-a',
      runId: 'run-a',
    }),
    'reusable_untrusted_source',
  )
}

for (const kind of ['summary', 'embedding', 'trace']) {
  for (const sensitivity of ['auth', 'secret']) {
    await deniedWithoutStore(
      transformedRequest({
        kind,
        parent: source(`${kind}-${sensitivity}`, 'user', 'user_authorized', sensitivity),
        trust: 'derived_untrusted',
        sensitivity: 'public',
        targetScope: { kind: 'run', tenantId: 'tenant-a', userId: 'user-a', runId: 'run-a' },
      }),
      'secret_ancestry',
    )
  }
}

await deniedWithoutStore(
  transformedRequest({
    kind: 'summary',
    parent: source('web-parent', 'web', 'untrusted_external', 'public'),
    origin: 'user',
    trust: 'user_authorized',
    targetScope: { kind: 'user', tenantId: 'tenant-a', userId: 'user-a', runId: 'run-a' },
  }),
)

{
  const request = transformedRequest({
    kind: 'summary',
    parent: source('trusted-parent', 'user', 'user_authorized', 'public'),
    trust: 'user_authorized',
    targetScope: { kind: 'run', tenantId: 'tenant-a', userId: 'user-a', runId: 'run-a' },
  })
  await deniedWithoutStore(request, 'trust_upgrade')
}

{
  const request = directUserRequest()
  request.security.transformChain[0].outputContentId = 'wrong-output'
  await deniedWithoutStore(request, 'invalid_transform_chain')
}

{
  const request = directUserRequest()
  request.security.provenance.parentContentIds = ['missing-parent']
  await deniedWithoutStore(request, 'incomplete_ancestry')
}

{
  const request = directUserRequest()
  request.content = { title: 'bad', authorization: 'Bearer abcdefghijklmnop' }
  await deniedWithoutStore(request, 'sensitive_content_detected')
}

{
  const request = directUserRequest()
  request.unexpectedAuthority = 'trusted_runtime'
  await deniedWithoutStore(request, 'invalid_request')
}

{
  const request = directUserRequest()
  request.schemaVersion = 'memory-write-request/v999'
  await deniedWithoutStore(request, 'unsupported_schema_version')
}

{
  const request = directUserRequest()
  request.targetScope = { ...request.targetScope, userId: 'foreign-user' }
  await deniedWithoutStore(request, 'target_scope_mismatch')
}

assert.equal(
  evaluateMemoryWriteRequest(directUserRequest(), actorScope).action,
  'allow',
)
console.log('multi-agent-memory-write-policy-test: PASS')

async function deniedWithoutStore(request, reasonCode) {
  const store = spyStore()
  const writer = createPolicyEnforcedMemoryWriter({ store, actorScope })
  const decision = await writer.write(request)
  assert.equal(decision.action, 'deny')
  if (reasonCode) assert.equal(decision.reasonCode, reasonCode)
  assert.equal(store.calls.length, 0, 'denied write reached the underlying Store')
}

function directUserRequest() {
  return directRequest(
    source('user-confirmed-language', 'user', 'user_authorized', 'personal'),
    { kind: 'user', tenantId: 'tenant-a', userId: 'user-a', runId: 'run-a' },
  )
}

function directRequest(parent, targetScope) {
  const outputId = `memory-${parent.contentId}`
  return {
    schemaVersion: 'memory-write-request/v2',
    requestId: `request-${parent.contentId}`,
    actorScope: structuredClone(actorScope),
    targetScope,
    content: { kind: 'semantic_note', body: 'The user explicitly selected Chinese.' },
    security: {
      origin: parent.origin,
      trust: parent.trust,
      sensitivity: parent.sensitivity,
      provenance: provenance(outputId, [parent.contentId]),
      derivedFrom: [parent],
      transformChain: [{
        kind: 'direct',
        inputContentIds: [parent.contentId],
        outputContentId: outputId,
      }],
    },
  }
}

function transformedRequest({
  kind,
  parent,
  origin = 'derived',
  trust,
  sensitivity = 'public',
  targetScope,
}) {
  const outputId = `memory-${kind}-${parent.contentId}`
  return {
    schemaVersion: 'memory-write-request/v2',
    requestId: `request-${kind}-${parent.contentId}`,
    actorScope: structuredClone(actorScope),
    targetScope,
    content: { kind: 'semantic_note', body: `Derived through ${kind}.` },
    security: {
      origin,
      trust,
      sensitivity,
      provenance: provenance(outputId, [parent.contentId]),
      derivedFrom: [parent],
      transformChain: [{
        kind,
        inputContentIds: [parent.contentId],
        outputContentId: outputId,
      }],
    },
  }
}

function source(contentId, origin, trust, sensitivity) {
  return {
    contentId,
    origin,
    trust,
    sensitivity,
    provenance: provenance(contentId),
  }
}

function provenance(contentId, parentContentIds = []) {
  return {
    contentId,
    capturedAt: '2026-07-17T08:00:00.000Z',
    parentContentIds,
    tenantId: 'tenant-a',
    userId: 'user-a',
    runId: 'run-a',
  }
}

function spyStore() {
  const calls = []
  return {
    calls,
    async put(entry) {
      calls.push(structuredClone(entry))
    },
  }
}
