#!/usr/bin/env node
import assert from 'node:assert/strict'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const sourceUrl = new URL('../src/memory/memory-lifecycle.ts', import.meta.url)
const distUrl = new URL('../dist/memory/memory-lifecycle.js', import.meta.url)
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
  MemoryLifecycleError,
  createFileMemoryLifecycle,
  memoryLifecyclePaths,
} = await import(useSource ? sourceUrl : distUrl)

const root = mkdtempSync(join(tmpdir(), 'web-buddy-memory-lifecycle-'))
let nowMs = Date.parse('2026-07-18T00:00:00.000Z')
const actorScope = {
  tenantId: 'tenant-a',
  userId: 'user-a',
  projectId: 'project-a',
  sessionId: 'session-a',
  runId: 'run-a',
}
const userScope = {
  kind: 'user',
  tenantId: 'tenant-a',
  userId: 'user-a',
}
const now = () => new Date(nowMs)

try {
  const first = createFileMemoryLifecycle({ root, actorScope, now })
  await assert.rejects(
    () => first.store.create({}),
    (error) => error instanceof MemoryLifecycleError && error.code === 'invalid_request',
    'Callers must not bypass B1 policy through the exposed Store create port.',
  )
  await assert.rejects(
    () => first.store.update({}),
    (error) => error instanceof MemoryLifecycleError && error.code === 'invalid_request',
    'Callers must not bypass B1 policy through the exposed Store update port.',
  )
  const created = await first.service.create(createInput({
    writeRequest: directUserWrite('preference-v1', {
      kind: 'preference',
      value: 'Chinese',
    }),
    confidence: 0.9,
    ttlMs: 60_000,
  }))
  assert.equal(created.status, 'created')
  assert.equal(created.record.schemaVersion, 'memory-lifecycle-record/v2')
  assert.equal(created.record.revision, 0)
  assert.equal(created.record.state, 'active')
  assert.equal(created.record.confidence, 0.9)
  assert.equal(created.record.lastUsedAt, undefined)
  assert.equal(created.record.expiresAt, '2026-07-18T00:01:00.000Z')
  assert.equal(created.record.scope.runId, undefined, 'reusable scope must not be pinned to the creating run')
  assert(Object.isFrozen(created.record))
  assert(Object.isFrozen(created.record.provenance))

  const restarted = createFileMemoryLifecycle({ root, actorScope, now })
  const restored = await restarted.service.get(getInput(created.record.entryId))
  assert(restored)
  assert.equal(restored.contentHash, created.record.contentHash)
  assert.equal(restored.revision, 0)

  const duplicate = await restarted.service.create(createInput({
    writeRequest: directUserWrite('preference-duplicate-id', {
      kind: 'preference',
      value: 'Chinese',
    }),
    confidence: 0.5,
  }))
  assert.equal(duplicate.status, 'deduplicated')
  assert.equal(duplicate.record.entryId, created.record.entryId)
  assert.equal(duplicate.record.revision, 0)

  const corrected = await restarted.service.update(updateInput({
    entryId: created.record.entryId,
    expectedRevision: 0,
    writeRequest: directUserWrite('preference-v2', {
      kind: 'preference',
      value: 'English',
    }),
    confidence: 1,
  }))
  assert.equal(corrected.status, 'updated')
  assert.equal(corrected.record.revision, 1)
  assert.equal(corrected.record.content.value, 'English')
  assert.equal(corrected.record.contentVersionId, 'preference-v2')

  const statePath = memoryLifecyclePaths(root).state
  const beforeConflict = readFileSync(statePath)
  const stale = await restarted.service.update(updateInput({
    entryId: created.record.entryId,
    expectedRevision: 0,
    writeRequest: directUserWrite('preference-stale', {
      kind: 'preference',
      value: 'French',
    }),
  }))
  assert.equal(stale.status, 'conflict')
  assert.equal(stale.code, 'revision_conflict')
  assert.equal(stale.currentRevision, 1)
  assert.deepEqual(readFileSync(statePath), beforeConflict, 'CAS conflict changed durable bytes')
  assert.equal(
    (await restarted.service.get(getInput(created.record.entryId))).content.value,
    'English',
    'stale update overwrote a newer user correction',
  )

  const oldFact = await restarted.service.create(createInput({
    writeRequest: directUserWrite('old-fact', {
      kind: 'fact',
      value: 'old value',
    }),
  }))
  assert.equal(oldFact.status, 'created')
  const replacement = await restarted.service.create(createInput({
    writeRequest: directUserWrite('new-fact', {
      kind: 'fact',
      value: 'new value',
    }),
    supersedes: [{
      entryId: oldFact.record.entryId,
      expectedRevision: oldFact.record.revision,
    }],
    conflicts: [{
      entryId: corrected.record.entryId,
      expectedRevision: corrected.record.revision,
    }],
  }))
  assert.equal(replacement.status, 'created')
  assert.deepEqual(replacement.record.supersedes, [{
    entryId: oldFact.record.entryId,
    revision: oldFact.record.revision,
  }])
  assert.deepEqual(replacement.record.conflicts, [{
    entryId: corrected.record.entryId,
    revision: corrected.record.revision,
  }])
  const superseded = await restarted.service.get({
    ...getInput(oldFact.record.entryId),
    includeSuperseded: true,
  })
  assert.equal(superseded.supersededBy, replacement.record.entryId)
  assert.equal(superseded.revision, 1)
  assert.equal(await restarted.service.get(getInput(oldFact.record.entryId)), undefined)

  nowMs += 1_000
  const retrieved = await restarted.service.retrieve({
    schemaVersion: 'memory-lifecycle-retrieve/v2',
    scope: userScope,
    query: 'English preference',
    maxResults: 5,
  })
  assert.equal(retrieved.schemaVersion, 'memory-lifecycle-retrieval-result/v2')
  assert.equal(retrieved.mode, 'keyword')
  assert(retrieved.records.some((item) => item.record.entryId === corrected.record.entryId))
  assert(!retrieved.records.some((item) => item.record.entryId === oldFact.record.entryId))
  const touched = await restarted.service.get(getInput(corrected.record.entryId))
  assert.equal(touched.lastUsedAt, '2026-07-18T00:00:01.000Z')
  assert.equal(touched.revision, 1)

  const expiring = await restarted.service.create(createInput({
    writeRequest: directUserWrite('expiring', {
      kind: 'temporary',
      value: 'short lived',
    }),
    ttlMs: 10,
  }))
  assert.equal(expiring.status, 'created')
  nowMs += 11
  assert.equal(await restarted.service.get(getInput(expiring.record.entryId)), undefined)
  const withExpired = await restarted.service.list({
    schemaVersion: 'memory-lifecycle-list/v2',
    scope: userScope,
    includeExpired: true,
  })
  assert(withExpired.some((record) => record.entryId === expiring.record.entryId))
  const afterExpirySearch = await restarted.service.retrieve({
    schemaVersion: 'memory-lifecycle-retrieve/v2',
    scope: userScope,
    query: 'short lived',
    maxResults: 10,
  })
  assert(!afterExpirySearch.records.some((item) => item.record.entryId === expiring.record.entryId))

  const toDelete = await restarted.service.create(createInput({
    writeRequest: directUserWrite('delete-me', {
      kind: 'private-note',
      value: 'remove this content',
    }),
  }))
  assert.equal(toDelete.status, 'created')
  const deleted = await restarted.service.delete({
    schemaVersion: 'memory-lifecycle-delete/v2',
    entryId: toDelete.record.entryId,
    scope: userScope,
    expectedRevision: toDelete.record.revision,
    reason: 'user_requested',
  })
  assert.equal(deleted.status, 'deleted')
  assert.equal(deleted.record.state, 'tombstone')
  assert.equal(deleted.record.content, null)
  assert.deepEqual(deleted.record.derivedFrom, [])
  assert.deepEqual(deleted.record.transformChain, [])
  assert.equal(deleted.record.tombstone.kind, 'deleted')
  assert.equal(deleted.record.tombstone.entryId, toDelete.record.entryId)
  assert.equal(deleted.record.tombstone.contentHash, toDelete.record.contentHash)
  assert.equal(await restarted.service.get(getInput(toDelete.record.entryId)), undefined)
  assert.equal(
    (await restarted.service.get({
      ...getInput(toDelete.record.entryId),
      includeTombstone: true,
    })).content,
    null,
  )

  const sameIdAfterDelete = await restarted.service.create(createInput({
    writeRequest: directUserWrite(toDelete.record.entryId, {
      kind: 'private-note',
      value: 'different bytes',
    }),
  }))
  assert.equal(sameIdAfterDelete.status, 'conflict')
  assert.equal(sameIdAfterDelete.code, 'tombstoned')
  const sameHashAfterDelete = await restarted.service.create(createInput({
    writeRequest: directUserWrite('delete-me-new-id', {
      kind: 'private-note',
      value: 'remove this content',
    }),
  }))
  assert.equal(sameHashAfterDelete.status, 'conflict')
  assert.equal(sameHashAfterDelete.code, 'tombstoned')

  const toForget = await restarted.service.create(createInput({
    writeRequest: directUserWrite('forget-me', {
      kind: 'private-note',
      value: 'erase this forever',
    }),
  }))
  assert.equal(toForget.status, 'created')
  const forgotten = await restarted.service.forget({
    schemaVersion: 'memory-lifecycle-forget/v2',
    entryId: toForget.record.entryId,
    scope: userScope,
    expectedRevision: toForget.record.revision,
    reason: 'privacy_request',
  })
  assert.equal(forgotten.status, 'forgotten')
  assert.equal(forgotten.record.tombstone.kind, 'forgotten')
  assert.equal(forgotten.record.content, null)
  assert.deepEqual(forgotten.record.derivedFrom, [])
  assert.deepEqual(forgotten.record.transformChain, [])

  const poisonedProvider = {
    async rank() {
      return [
        { entryId: toDelete.record.entryId, score: 100 },
        { entryId: toForget.record.entryId, score: 99 },
        { entryId: corrected.record.entryId, score: 0.8 },
      ]
    },
  }
  const afterDeleteRestart = createFileMemoryLifecycle({
    root,
    actorScope,
    now,
    embeddingProvider: poisonedProvider,
  })
  const hybrid = await afterDeleteRestart.service.retrieve({
    schemaVersion: 'memory-lifecycle-retrieve/v2',
    scope: userScope,
    query: 'anything',
    maxResults: 10,
  })
  assert.equal(hybrid.mode, 'hybrid')
  assert(!hybrid.records.some((item) => item.record.entryId === toDelete.record.entryId))
  assert(!hybrid.records.some((item) => item.record.entryId === toForget.record.entryId))

  const failingProvider = {
    async rank() {
      throw new Error('embedding unavailable')
    },
  }
  const fallbackRuntime = createFileMemoryLifecycle({
    root,
    actorScope,
    now,
    embeddingProvider: failingProvider,
  })
  const fallback = await fallbackRuntime.service.retrieve({
    schemaVersion: 'memory-lifecycle-retrieve/v2',
    scope: userScope,
    query: 'English',
    maxResults: 10,
  })
  assert.equal(fallback.mode, 'keyword_fallback')
  assert(!fallback.records.some((item) => item.record.entryId === toDelete.record.entryId))
  assert(!fallback.records.some((item) => item.record.entryId === toForget.record.entryId))

  await assert.rejects(
    restarted.service.get({
      ...getInput(corrected.record.entryId),
      scope: { ...userScope, userId: 'foreign-user' },
    }),
    (error) => error instanceof MemoryLifecycleError && error.code === 'scope_violation',
  )
  await assert.rejects(
    restarted.service.list({
      schemaVersion: 'memory-lifecycle-list/v999',
      scope: userScope,
    }),
    (error) => error instanceof MemoryLifecycleError && error.code === 'unsupported_schema_version',
  )
  await assert.rejects(
    restarted.service.list({
      schemaVersion: 'memory-lifecycle-list/v2',
      scope: userScope,
      unexpected: true,
    }),
    (error) => error instanceof MemoryLifecycleError && error.code === 'invalid_request',
  )

  const denied = await restarted.service.create(createInput({
    writeRequest: directUserWrite('foreign-write', {
      kind: 'foreign',
      value: 'should not persist',
    }, {
      kind: 'user',
      tenantId: 'tenant-a',
      userId: 'foreign-user',
    }),
  }))
  assert.equal(denied.status, 'policy_denied')
  assert.equal(denied.decision.reasonCode, 'target_scope_mismatch')

  const corruptRoot = mkdtempSync(join(tmpdir(), 'web-buddy-memory-lifecycle-corrupt-'))
  try {
    const corrupt = createFileMemoryLifecycle({ root: corruptRoot, actorScope, now })
    const seed = await corrupt.service.create(createInput({
      writeRequest: directUserWrite('corrupt-seed', { value: 'seed' }),
    }))
    assert.equal(seed.status, 'created')
    const corruptPath = memoryLifecyclePaths(corruptRoot).state
    const invalidState = JSON.parse(readFileSync(corruptPath, 'utf8'))
    invalidState.schemaVersion = 'memory-lifecycle-store/v999'
    writeFileSync(corruptPath, `${JSON.stringify(invalidState)}\n`)
    const reloaded = createFileMemoryLifecycle({ root: corruptRoot, actorScope, now })
    await assert.rejects(
      reloaded.service.list({
        schemaVersion: 'memory-lifecycle-list/v2',
        scope: userScope,
      }),
      (error) => error instanceof MemoryLifecycleError && error.code === 'unsupported_schema_version',
    )
  } finally {
    rmSync(corruptRoot, { recursive: true, force: true })
  }

  console.log('multi-agent-memory-lifecycle-test: PASS')
} finally {
  rmSync(root, { recursive: true, force: true })
}

function createInput({
  writeRequest,
  confidence,
  ttlMs,
  expiresAt,
  supersedes,
  conflicts,
}) {
  return {
    schemaVersion: 'memory-lifecycle-create/v2',
    writeRequest,
    ...(confidence === undefined ? {} : { confidence }),
    ...(ttlMs === undefined ? {} : { ttlMs }),
    ...(expiresAt === undefined ? {} : { expiresAt }),
    ...(supersedes === undefined ? {} : { supersedes }),
    ...(conflicts === undefined ? {} : { conflicts }),
  }
}

function updateInput({
  entryId,
  expectedRevision,
  writeRequest,
  confidence,
  ttlMs,
  expiresAt,
  supersedes,
  conflicts,
}) {
  return {
    schemaVersion: 'memory-lifecycle-update/v2',
    entryId,
    scope: userScope,
    expectedRevision,
    writeRequest,
    ...(confidence === undefined ? {} : { confidence }),
    ...(ttlMs === undefined ? {} : { ttlMs }),
    ...(expiresAt === undefined ? {} : { expiresAt }),
    ...(supersedes === undefined ? {} : { supersedes }),
    ...(conflicts === undefined ? {} : { conflicts }),
  }
}

function getInput(entryId) {
  return {
    schemaVersion: 'memory-lifecycle-get/v2',
    entryId,
    scope: userScope,
  }
}

function directUserWrite(contentId, content, targetScope = {
  kind: 'user',
  tenantId: 'tenant-a',
  userId: 'user-a',
  runId: 'run-a',
}) {
  const provenance = {
    contentId,
    capturedAt: new Date(nowMs).toISOString(),
    parentContentIds: [`source-${contentId}`],
    tenantId: 'tenant-a',
    userId: 'user-a',
    runId: 'run-a',
  }
  const parent = {
    contentId: `source-${contentId}`,
    origin: 'user',
    trust: 'user_authorized',
    sensitivity: 'personal',
    provenance: {
      contentId: `source-${contentId}`,
      capturedAt: new Date(nowMs).toISOString(),
      parentContentIds: [],
      tenantId: 'tenant-a',
      userId: 'user-a',
      runId: 'run-a',
    },
  }
  return {
    schemaVersion: 'memory-write-request/v2',
    requestId: `write-${contentId}`,
    actorScope: structuredClone(actorScope),
    targetScope,
    content,
    security: {
      origin: 'user',
      trust: 'user_authorized',
      sensitivity: 'personal',
      provenance,
      derivedFrom: [parent],
      transformChain: [{
        kind: 'direct',
        inputContentIds: [parent.contentId],
        outputContentId: contentId,
      }],
    },
  }
}
