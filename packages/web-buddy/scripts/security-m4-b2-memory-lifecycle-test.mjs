#!/usr/bin/env node
import assert from 'node:assert/strict'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const fixtureUrl = new URL('./fixtures/security/m4-b2-memory-lifecycle.json', import.meta.url)
const fixture = JSON.parse(readFileSync(fixtureUrl, 'utf8'))
if (fixture.schemaVersion !== 'security-m4-b2-memory-lifecycle/v1') {
  throw new Error(`Unsupported M4-B2 security fixture schema: ${String(fixture.schemaVersion)}`)
}

const sourceUrl = new URL('../src/memory/memory-lifecycle.ts', import.meta.url)
const distUrl = new URL('../dist/memory/memory-lifecycle.js', import.meta.url)
const useSource = process.env.WEB_BUDDY_TEST_SOURCE === '1' || !existsSync(distUrl)
if (useSource) await installSourceResolver()
const lifecycle = await import(useSource ? sourceUrl : distUrl)
assert.equal(
  typeof lifecycle.createFileMemoryLifecycle,
  'function',
  'B2 must export createFileMemoryLifecycle',
)

const roots = []
const results = []

try {
  await check('create persists one governed active record', async () => {
    const harness = createHarness('create')
    const created = await createRecord(harness, {
      entryId: 'memory-language',
      body: fixture.sentinels.safe,
    })
    assert.equal(created.status, 'created')
    assert.equal(created.record.state, 'active')
    assert.equal(created.record.revision, 0)
    assert.equal(created.record.content.body, fixture.sentinels.safe)
    assert.equal(created.record.scope.tenantId, fixture.actorScope.tenantId)
  })

  await check('stale expectedRevision cannot overwrite a newer user correction', async () => {
    const harness = createHarness('stale-cas')
    const created = await createRecord(harness, {
      entryId: 'memory-cas',
      body: fixture.sentinels.safe,
    })
    harness.clock.value = Date.parse(fixture.clock.updatedAt)
    const updated = await harness.service.update(updateInput({
      entryId: created.record.entryId,
      expectedRevision: created.record.revision,
      body: fixture.sentinels.newerCorrection,
      requestId: 'update-newer-correction',
    }))
    assert.equal(updated.status, 'updated')
    const beforeConflict = await snapshotTree(harness.root)
    const stale = await harness.service.update(updateInput({
      entryId: created.record.entryId,
      expectedRevision: created.record.revision,
      body: fixture.sentinels.staleOverwrite,
      requestId: 'update-stale-overwrite',
    }))
    assert.equal(stale.status, 'conflict')
    assert.equal(stale.currentRevision, updated.record.revision)
    assert.deepEqual(await snapshotTree(harness.root), beforeConflict)
    const current = await getIncludingAll(harness, created.record.entryId)
    assert.equal(current.revision, updated.record.revision)
    assert.equal(current.content.body, fixture.sentinels.newerCorrection)
    assert(!JSON.stringify(current).includes(fixture.sentinels.staleOverwrite))
  })

  await check('concurrent equal-revision updates have exactly one winner', async () => {
    const harness = createHarness('concurrent-cas')
    const created = await createRecord(harness, {
      entryId: 'memory-concurrent',
      body: fixture.sentinels.safe,
    })
    const [left, right] = await Promise.all([
      harness.service.update(updateInput({
        entryId: created.record.entryId,
        expectedRevision: created.record.revision,
        body: 'Concurrent correction A',
        requestId: 'concurrent-a',
      })),
      harness.service.update(updateInput({
        entryId: created.record.entryId,
        expectedRevision: created.record.revision,
        body: 'Concurrent correction B',
        requestId: 'concurrent-b',
      })),
    ])
    assert.deepEqual(
      [left.status, right.status].sort(),
      ['conflict', 'updated'],
    )
    const current = await getIncludingAll(harness, created.record.entryId)
    assert.equal(current.revision, created.record.revision + 1)
    assert(
      current.content.body === 'Concurrent correction A'
      || current.content.body === 'Concurrent correction B',
    )
  })

  for (const operation of ['delete', 'forget']) {
    await check(`${operation} creates an authoritative content-free tombstone`, async () => {
      const harness = createHarness(`tombstone-${operation}`)
      const created = await createRecord(harness, {
        entryId: `memory-${operation}`,
        body: `${fixture.sentinels.safe} ${operation}`,
      })
      const result = await harness.service[operation]({
        schemaVersion: `memory-lifecycle-${operation}/v2`,
        entryId: created.record.entryId,
        scope: userScope(),
        expectedRevision: created.record.revision,
        reason: `security-${operation}-test`,
      })
      assert.equal(result.status, operation === 'delete' ? 'deleted' : 'forgotten')
    assert.equal(result.record.state, 'tombstone')
      assert.equal(result.record.content, null)
      assert.deepEqual(result.record.derivedFrom, [])
      assert.deepEqual(result.record.transformChain, [])
      assert(result.record.tombstone)
      assert.equal(result.record.tombstone.contentHash, created.record.contentHash)
      assert.equal(result.record.tombstone.entryId, created.record.entryId)
      assert.equal(result.record.tombstone.authoritative, true)
      assert.equal(result.record.tombstone.kind, operation === 'delete' ? 'deleted' : 'forgotten')
    })
  }

  await check('stale delete and stale forget are byte-preserving conflicts', async () => {
    const harness = createHarness('stale-tombstone')
    const created = await createRecord(harness, {
      entryId: 'memory-stale-tombstone',
      body: fixture.sentinels.safe,
    })
    const updated = await harness.service.update(updateInput({
      entryId: created.record.entryId,
      expectedRevision: created.record.revision,
      body: fixture.sentinels.newerCorrection,
      requestId: 'update-before-stale-tombstone',
    }))
    for (const operation of ['delete', 'forget']) {
      const before = await snapshotTree(harness.root)
      const result = await harness.service[operation]({
        schemaVersion: `memory-lifecycle-${operation}/v2`,
        entryId: created.record.entryId,
        scope: userScope(),
        expectedRevision: created.record.revision,
      })
      assert.equal(result.status, 'conflict')
      assert.equal(result.currentRevision, updated.record.revision)
      assert.deepEqual(await snapshotTree(harness.root), before)
    }
  })

  await check('tombstones are excluded from get/list/keyword retrieval', async () => {
    const harness = createHarness('tombstone-query')
    const active = await createRecord(harness, {
      entryId: 'memory-active',
      body: fixture.sentinels.safe,
    })
    const removed = await createRecord(harness, {
      entryId: 'memory-removed',
      body: `${fixture.sentinels.safe} removed`,
    })
    await harness.service.forget({
      schemaVersion: 'memory-lifecycle-forget/v2',
      entryId: removed.record.entryId,
      scope: userScope(),
      expectedRevision: removed.record.revision,
    })
    assert.equal(await harness.service.get(getInput(removed.record.entryId)), undefined)
    assert.deepEqual(
      (await harness.service.list(listInput())).map((record) => record.entryId),
      [active.record.entryId],
    )
    const retrieved = await harness.service.retrieve(retrieveInput('language'))
    assert(retrieved.records.some((item) => item.record.entryId === active.record.entryId))
    assert(!retrieved.records.some((item) => item.record.entryId === removed.record.entryId))
    const tombstone = await harness.service.get({
      ...getInput(removed.record.entryId),
      includeTombstone: true,
    })
    assert.equal(tombstone.state, 'tombstone')
    assert.equal(tombstone.tombstone.kind, 'forgotten')
  })

  await check('restart preserves tombstone exclusion and prevents resurrection', async () => {
    const harness = createHarness('restart-tombstone')
    const removed = await createRecord(harness, {
      entryId: 'memory-restart-forgotten',
      body: fixture.sentinels.safe,
    })
    const deleted = await createRecord(harness, {
      entryId: 'memory-restart-deleted',
      body: `${fixture.sentinels.safe} deleted`,
    })
    await harness.service.forget({
      schemaVersion: 'memory-lifecycle-forget/v2',
      entryId: removed.record.entryId,
      scope: userScope(),
      expectedRevision: removed.record.revision,
    })
    await harness.service.delete({
      schemaVersion: 'memory-lifecycle-delete/v2',
      entryId: deleted.record.entryId,
      scope: userScope(),
      expectedRevision: deleted.record.revision,
    })
    const restarted = restartHarness(harness)
    for (const tombstoned of [removed.record, deleted.record]) {
      assert.equal(await restarted.service.get(getInput(tombstoned.entryId)), undefined)
      assert(!JSON.stringify(await restarted.service.list(listInput()))
        .includes(tombstoned.entryId))
      assert(!JSON.stringify(await restarted.service.retrieve(retrieveInput('language')))
        .includes(tombstoned.entryId))
    }

    const sameId = await restarted.service.create(createInput({
      entryId: removed.record.entryId,
      body: fixture.sentinels.safe,
      requestId: 'recreate-same-id',
    }))
    assert.equal(sameId.status, 'conflict')
    const sameHash = await restarted.service.create(createInput({
      entryId: 'memory-restart-same-hash',
      body: fixture.sentinels.safe,
      requestId: 'recreate-same-hash',
    }))
    assert.equal(sameHash.status, 'conflict')
  })

  await check('persisted tombstone id/hash binding is validated fail-closed', async () => {
    const harness = createHarness('tombstone-binding')
    const created = await createRecord(harness, {
      entryId: 'memory-tombstone-binding',
      body: fixture.sentinels.safe,
    })
    await harness.service.delete({
      schemaVersion: 'memory-lifecycle-delete/v2',
      entryId: created.record.entryId,
      scope: userScope(),
      expectedRevision: created.record.revision,
    })
    const statePath = lifecycle.memoryLifecyclePaths(harness.root).state
    const state = JSON.parse(readFileSync(statePath, 'utf8'))
    const record = state.records.find((item) => item.entryId === created.record.entryId)
    record.tombstone.contentHash = '0'.repeat(64)
    writeFileSync(statePath, `${JSON.stringify(state)}\n`, 'utf8')
    const restarted = restartHarness(harness)
    await assert.rejects(
      restarted.service.list({
        ...listInput(),
        includeTombstones: true,
      }),
      (error) => error?.code === 'corrupt_store',
    )
  })

  await check('delete/forget reason cannot persist a secret outside B1 policy', async () => {
    const harness = createHarness('secret-tombstone-reason')
    for (const operation of ['delete', 'forget']) {
      const created = await createRecord(harness, {
        entryId: `memory-secret-${operation}-reason`,
        body: `${fixture.sentinels.safe} ${operation}`,
      })
      try {
        await harness.service[operation]({
          schemaVersion: `memory-lifecycle-${operation}/v2`,
          entryId: created.record.entryId,
          scope: userScope(),
          expectedRevision: created.record.revision,
          reason: fixture.sentinels.secret,
        })
      } catch {
        // A fail-closed rejection is an acceptable outcome.
      }
      assert(
        !readFileSync(lifecycle.memoryLifecyclePaths(harness.root).state, 'utf8')
          .includes(fixture.sentinels.secret),
        `secret ${operation} reason reached durable Memory bytes`,
      )
      const stored = await harness.service.get({
        ...getInput(created.record.entryId),
        includeTombstone: true,
      })
      assert(!JSON.stringify(stored).includes(fixture.sentinels.secret))
    }
  })

  await check('embedding results are intersected with eligible candidates', async () => {
    let observedCandidates
    const provider = {
      async rank({ candidates }) {
        observedCandidates = structuredClone(candidates)
        return [
          { entryId: fixture.embedding.maliciousUnknownId, score: 1 },
          { entryId: 'memory-embedding-active', score: 0.8 },
        ]
      },
    }
    const harness = createHarness('embedding-intersection', { embeddingProvider: provider })
    const active = await createRecord(harness, {
      entryId: 'memory-embedding-active',
      body: fixture.sentinels.safe,
    })
    const removed = await createRecord(harness, {
      entryId: fixture.embedding.maliciousUnknownId,
      body: `${fixture.sentinels.safe} malicious vector candidate`,
    })
    await harness.service.delete({
      schemaVersion: 'memory-lifecycle-delete/v2',
      entryId: removed.record.entryId,
      scope: userScope(),
      expectedRevision: removed.record.revision,
    })
    const result = await harness.service.retrieve(retrieveInput(fixture.embedding.query))
    assert.equal(result.mode, 'hybrid')
    assert(!JSON.stringify(observedCandidates).includes(removed.record.entryId))
    assert.deepEqual(
      result.records.map((item) => item.record.entryId),
      [active.record.entryId],
    )
  })

  await check('embedding failure falls back without reviving tombstones', async () => {
    const provider = {
      async rank() {
        throw new Error(fixture.embedding.failureMessage)
      },
    }
    const harness = createHarness('embedding-failure', { embeddingProvider: provider })
    const active = await createRecord(harness, {
      entryId: 'memory-fallback-active',
      body: fixture.sentinels.safe,
    })
    const removed = await createRecord(harness, {
      entryId: 'memory-fallback-removed',
      body: `${fixture.sentinels.safe} removed`,
    })
    await harness.service.forget({
      schemaVersion: 'memory-lifecycle-forget/v2',
      entryId: removed.record.entryId,
      scope: userScope(),
      expectedRevision: removed.record.revision,
    })
    const result = await harness.service.retrieve(retrieveInput('language'))
    assert.equal(result.mode, 'keyword_fallback')
    assert(result.records.some((item) => item.record.entryId === active.record.entryId))
    assert(!result.records.some((item) => item.record.entryId === removed.record.entryId))
  })

  await check('expired records stay excluded before and after restart', async () => {
    const harness = createHarness('ttl')
    const created = await createRecord(harness, {
      entryId: 'memory-ttl',
      body: fixture.sentinels.safe,
      ttlMs: 120_000,
    })
    harness.clock.value += 60_000
    const firstRetrieval = await harness.service.retrieve(retrieveInput('language'))
    assert(firstRetrieval.records.some((item) => item.record.entryId === created.record.entryId))
    const used = await getIncludingAll(harness, created.record.entryId)
    assert.equal(used.lastUsedAt, new Date(harness.clock.value).toISOString())

    harness.clock.value += 120_000
    assert.equal(await harness.service.get(getInput(created.record.entryId)), undefined)
    assert(!JSON.stringify(await harness.service.list(listInput())).includes(created.record.entryId))
    assert(!JSON.stringify(await harness.service.retrieve(retrieveInput('language')))
      .includes(created.record.entryId))
    const expired = await harness.service.get({
      ...getInput(created.record.entryId),
      includeExpired: true,
    })
    assert.equal(expired.lastUsedAt, used.lastUsedAt)

    const restarted = restartHarness(harness)
    assert.equal(await restarted.service.get(getInput(created.record.entryId)), undefined)
    assert(!JSON.stringify(await restarted.service.retrieve(retrieveInput('language')))
      .includes(created.record.entryId))
  })

  await check('lastUsed changes only on eligible retrieval and never regresses', async () => {
    const harness = createHarness('last-used')
    const created = await createRecord(harness, {
      entryId: 'memory-last-used',
      body: fixture.sentinels.safe,
    })
    assert.equal(created.record.lastUsedAt, undefined)
    harness.clock.value = Date.parse(fixture.clock.retrievedAt)
    await harness.service.get(getInput(created.record.entryId))
    await harness.service.list(listInput())
    assert.equal((await getIncludingAll(harness, created.record.entryId)).lastUsedAt, undefined)
    await harness.service.retrieve(retrieveInput('language'))
    const first = await getIncludingAll(harness, created.record.entryId)
    assert.equal(first.lastUsedAt, fixture.clock.retrievedAt)
    harness.clock.value -= 60_000
    await harness.service.retrieve(retrieveInput('language'))
    const second = await getIncludingAll(harness, created.record.entryId)
    assert.equal(second.lastUsedAt, first.lastUsedAt)
    assert.equal(second.revision, first.revision)
  })

  await check('same-scope duplicate content deduplicates without a second record', async () => {
    const harness = createHarness('dedup')
    const first = await createRecord(harness, {
      entryId: 'memory-dedup-first',
      body: fixture.sentinels.safe,
    })
    const second = await createRecord(harness, {
      entryId: 'memory-dedup-second',
      body: fixture.sentinels.safe,
      requestId: 'create-dedup-second',
    })
    assert.equal(second.status, 'deduplicated')
    assert.equal(second.record.entryId, first.record.entryId)
    assert.deepEqual(
      (await harness.service.list(listInput())).map((record) => record.entryId),
      [first.record.entryId],
    )
  })

  await check('supersedes is atomic and removes the old record from retrieval', async () => {
    const harness = createHarness('supersedes')
    const oldRecord = await createRecord(harness, {
      entryId: 'memory-superseded-old',
      body: 'The user prefers Chinese.',
    })
    const conflictRecord = await createRecord(harness, {
      entryId: 'memory-explicit-conflict',
      body: 'The user also requested concise answers.',
    })
    const replacement = await createRecord(harness, {
      entryId: 'memory-superseded-new',
      body: fixture.sentinels.newerCorrection,
      supersedes: [{
        entryId: oldRecord.record.entryId,
        expectedRevision: oldRecord.record.revision,
      }],
      conflicts: [{
        entryId: conflictRecord.record.entryId,
        expectedRevision: conflictRecord.record.revision,
      }],
    })
    assert.equal(replacement.status, 'created')
    assert(JSON.stringify(replacement.record.supersedes).includes(oldRecord.record.entryId))
    assert(JSON.stringify(replacement.record.conflicts).includes(conflictRecord.record.entryId))
    assert.equal(await harness.service.get(getInput(oldRecord.record.entryId)), undefined)
    const superseded = await harness.service.get({
      ...getInput(oldRecord.record.entryId),
      includeSuperseded: true,
    })
    assert.equal(superseded.state, 'active')
    assert.equal(superseded.supersededBy, replacement.record.entryId)
    const stillConflicted = await harness.service.get(getInput(conflictRecord.record.entryId))
    assert.equal(stillConflicted.revision, conflictRecord.record.revision)
    assert.equal(stillConflicted.content.body, 'The user also requested concise answers.')
    const retrieval = await harness.service.retrieve(retrieveInput('language'))
    assert(!retrieval.records.some((item) => item.record.entryId === oldRecord.record.entryId))
    assert(retrieval.records.some((item) => item.record.entryId === replacement.record.entryId))
  })

  await check('stale supersedes reference is conflict and writes no replacement', async () => {
    const harness = createHarness('stale-supersedes')
    const oldRecord = await createRecord(harness, {
      entryId: 'memory-stale-supersedes-old',
      body: fixture.sentinels.safe,
    })
    const updated = await harness.service.update(updateInput({
      entryId: oldRecord.record.entryId,
      expectedRevision: oldRecord.record.revision,
      body: fixture.sentinels.newerCorrection,
      requestId: 'advance-supersedes-target',
    }))
    assert.equal(updated.status, 'updated')
    const before = await snapshotTree(harness.root)
    const replacement = await harness.service.create(createInput({
      entryId: 'memory-stale-supersedes-new',
      body: 'Replacement with a stale reference',
      requestId: 'stale-supersedes-create',
      supersedes: [{
        entryId: oldRecord.record.entryId,
        expectedRevision: oldRecord.record.revision,
      }],
    }))
    assert.equal(replacement.status, 'conflict')
    assert.deepEqual(await snapshotTree(harness.root), before)
    assert.equal(
      await harness.service.get(getInput('memory-stale-supersedes-new')),
      undefined,
    )
  })

  for (const [boundary, foreignScope] of Object.entries(fixture.foreignScopes)) {
    await check(`${boundary} scope cannot get/list/retrieve or mutate`, async () => {
      const harness = createHarness(`foreign-${boundary}`)
      const created = await createRecord(harness, {
        entryId: `memory-foreign-${boundary}`,
        body: fixture.sentinels.safe,
      })
      const before = await snapshotTree(harness.root)
      for (const operation of [
        () => harness.service.get({ ...getInput(created.record.entryId), scope: foreignScope }),
        () => harness.service.list({ ...listInput(), scope: foreignScope }),
        () => harness.service.retrieve({ ...retrieveInput('language'), scope: foreignScope }),
        () => harness.service.delete({
          schemaVersion: 'memory-lifecycle-delete/v2',
          entryId: created.record.entryId,
          scope: foreignScope,
          expectedRevision: created.record.revision,
        }),
        () => harness.service.forget({
          schemaVersion: 'memory-lifecycle-forget/v2',
          entryId: created.record.entryId,
          scope: foreignScope,
          expectedRevision: created.record.revision,
        }),
      ]) {
        await assert.rejects(operation)
      }
      assert.deepEqual(await snapshotTree(harness.root), before)
    })
  }

  for (const [name, mutate] of [
    ['web prompt injection', (request) => {
      request.content.body = fixture.sentinels.webPoison
      setDirectClassification(request, 'web', 'untrusted_external', 'public')
    }],
    ['subagent prompt injection', (request) => {
      request.content.body = fixture.sentinels.webPoison
      setDirectClassification(request, 'subagent', 'non_authoritative', 'public')
    }],
    ['secret ancestry', (request) => {
      request.content.body = fixture.sentinels.secret
      setDirectClassification(request, 'user', 'user_authorized', 'secret')
    }],
  ]) {
    await check(`${name} remains denied by B1 before B2 persistence`, async () => {
      const harness = createHarness(`policy-${name.replaceAll(' ', '-')}`)
      const input = createInput({
        entryId: `memory-policy-${name.replaceAll(' ', '-')}`,
        body: fixture.sentinels.safe,
      })
      mutate(input.writeRequest)
      const before = await snapshotTree(harness.root)
      const result = await harness.service.create(input)
      assert.equal(result.status, 'policy_denied')
      assert.deepEqual(await snapshotTree(harness.root), before)
      assert.deepEqual(await harness.service.list(listInput()), [])
    })
  }

  await check('foreign create scope is policy-denied before lifecycle persistence', async () => {
    const harness = createHarness('foreign-create')
    const input = createInput({
      entryId: 'memory-foreign-create',
      body: fixture.sentinels.safe,
    })
    input.writeRequest.targetScope = fixture.foreignScopes.user
    const before = await snapshotTree(harness.root)
    const result = await harness.service.create(input)
    assert.equal(result.status, 'policy_denied')
    assert.deepEqual(await snapshotTree(harness.root), before)
  })

  await check('unknown schemas and extension fields fail closed without writes', async () => {
    const harness = createHarness('closed-shapes')
    const created = await createRecord(harness, {
      entryId: 'memory-closed-shapes',
      body: fixture.sentinels.safe,
    })
    const before = await snapshotTree(harness.root)
    const cases = [
      () => harness.service.create({
        ...createInput({ entryId: 'memory-unknown-create', body: 'unknown create' }),
        schemaVersion: 'memory-lifecycle-create/v999',
      }),
      () => harness.service.create({
        ...createInput({ entryId: 'memory-extra-create', body: 'extra create' }),
        authority: 'trusted_runtime',
      }),
      () => harness.service.update({
        ...updateInput({
          entryId: created.record.entryId,
          expectedRevision: created.record.revision,
          body: 'unknown update',
          requestId: 'unknown-update',
        }),
        schemaVersion: 'memory-lifecycle-update/v999',
      }),
      () => harness.service.get({
        ...getInput(created.record.entryId),
        unexpected: true,
      }),
      () => harness.service.list({
        ...listInput(),
        schemaVersion: 'memory-lifecycle-list/v999',
      }),
      () => harness.service.delete({
        schemaVersion: 'memory-lifecycle-delete/v2',
        entryId: created.record.entryId,
        scope: userScope(),
        expectedRevision: created.record.revision,
        approved: true,
      }),
      () => harness.service.forget({
        schemaVersion: 'memory-lifecycle-forget/v999',
        entryId: created.record.entryId,
        scope: userScope(),
        expectedRevision: created.record.revision,
      }),
      () => harness.service.retrieve({
        ...retrieveInput('language'),
        includeTombstones: true,
      }),
    ]
    for (const operation of cases) await assert.rejects(operation)
    assert.deepEqual(await snapshotTree(harness.root), before)
    const current = await getIncludingAll(harness, created.record.entryId)
    assert.equal(current.revision, created.record.revision)
  })
} finally {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
}

const passed = results.filter((result) => result.status === 'PASS').length
for (const result of results) {
  console.log(`${result.status} ${result.name}${result.detail ? ` — ${result.detail}` : ''}`)
}
console.log(
  `security-m4-b2-memory-lifecycle-test: ${passed}/${results.length} checks passed (${useSource ? 'source' : 'compiled'})`,
)
if (passed !== results.length) process.exitCode = 1

function createHarness(name, { embeddingProvider } = {}) {
  const root = mkdtempSync(join(tmpdir(), `web-buddy-m4-b2-${name}-`))
  roots.push(root)
  const clock = { value: Date.parse(fixture.clock.createdAt) }
  return {
    root,
    clock,
    ...lifecycle.createFileMemoryLifecycle({
      root,
      actorScope: structuredClone(fixture.actorScope),
      now: () => new Date(clock.value),
      ...(embeddingProvider ? { embeddingProvider } : {}),
    }),
    embeddingProvider,
  }
}

function restartHarness(harness, overrides = {}) {
  return {
    root: harness.root,
    clock: harness.clock,
    ...lifecycle.createFileMemoryLifecycle({
      root: harness.root,
      actorScope: structuredClone(fixture.actorScope),
      now: () => new Date(harness.clock.value),
      ...(overrides.embeddingProvider ?? harness.embeddingProvider
        ? { embeddingProvider: overrides.embeddingProvider ?? harness.embeddingProvider }
        : {}),
    }),
  }
}

async function createRecord(harness, input) {
  return harness.service.create(createInput(input))
}

function createInput({
  entryId,
  body,
  requestId = `create-${entryId}`,
  ttlMs,
  expiresAt,
  supersedes,
  conflicts,
}) {
  return {
    schemaVersion: 'memory-lifecycle-create/v2',
    writeRequest: directWriteRequest({ entryId, body, requestId }),
    confidence: 0.9,
    ...(ttlMs === undefined ? {} : { ttlMs }),
    ...(expiresAt === undefined ? {} : { expiresAt }),
    ...(supersedes === undefined ? {} : { supersedes }),
    ...(conflicts === undefined ? {} : { conflicts }),
  }
}

function updateInput({
  entryId,
  expectedRevision,
  body,
  requestId,
  ttlMs,
  expiresAt,
  supersedes,
  conflicts,
}) {
  return {
    schemaVersion: 'memory-lifecycle-update/v2',
    entryId,
    scope: userScope(),
    expectedRevision,
    writeRequest: directWriteRequest({
      entryId: `${entryId}-version-${requestId}`,
      body,
      requestId,
    }),
    ...(ttlMs === undefined ? {} : { ttlMs }),
    ...(expiresAt === undefined ? {} : { expiresAt }),
    ...(supersedes === undefined ? {} : { supersedes }),
    ...(conflicts === undefined ? {} : { conflicts }),
  }
}

function directWriteRequest({ entryId, body, requestId }) {
  const parentId = `source-${requestId}`
  return {
    schemaVersion: 'memory-write-request/v2',
    requestId,
    actorScope: structuredClone(fixture.actorScope),
    targetScope: userScope(),
    content: {
      kind: 'semantic_note',
      title: 'User preference',
      body,
      topics: ['language', 'preference'],
    },
    security: {
      origin: 'user',
      trust: 'user_authorized',
      sensitivity: 'personal',
      provenance: provenance(entryId, [parentId]),
      derivedFrom: [{
        contentId: parentId,
        origin: 'user',
        trust: 'user_authorized',
        sensitivity: 'personal',
        provenance: provenance(parentId),
      }],
      transformChain: [{
        kind: 'direct',
        inputContentIds: [parentId],
        outputContentId: entryId,
      }],
    },
  }
}

function setDirectClassification(request, origin, trust, sensitivity) {
  request.security.origin = origin
  request.security.trust = trust
  request.security.sensitivity = sensitivity
  request.security.derivedFrom[0].origin = origin
  request.security.derivedFrom[0].trust = trust
  request.security.derivedFrom[0].sensitivity = sensitivity
}

function provenance(contentId, parentContentIds = []) {
  return {
    contentId,
    capturedAt: fixture.clock.createdAt,
    parentContentIds,
    tenantId: fixture.actorScope.tenantId,
    userId: fixture.actorScope.userId,
    projectId: fixture.actorScope.projectId,
    sessionId: fixture.actorScope.sessionId,
    runId: fixture.actorScope.runId,
  }
}

function userScope() {
  return {
    kind: 'user',
    tenantId: fixture.actorScope.tenantId,
    userId: fixture.actorScope.userId,
  }
}

function getInput(entryId) {
  return {
    schemaVersion: 'memory-lifecycle-get/v2',
    entryId,
    scope: userScope(),
  }
}

function listInput() {
  return {
    schemaVersion: 'memory-lifecycle-list/v2',
    scope: userScope(),
  }
}

function retrieveInput(query) {
  return {
    schemaVersion: 'memory-lifecycle-retrieve/v2',
    scope: userScope(),
    query,
    maxResults: 10,
  }
}

function getIncludingAll(harness, entryId) {
  return harness.service.get({
    ...getInput(entryId),
    includeTombstone: true,
    includeExpired: true,
    includeSuperseded: true,
  })
}

async function snapshotTree(root) {
  const output = {}
  await visit(root, '')
  return output

  async function visit(directory, relative) {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      const path = join(directory, entry.name)
      const key = relative ? `${relative}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        await visit(path, key)
      } else {
        output[key] = (await readFile(path)).toString('base64')
      }
    }
  }
}

async function check(name, operation) {
  try {
    await operation()
    results.push({ name, status: 'PASS' })
  } catch (error) {
    results.push({
      name,
      status: 'FAIL',
      detail: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    })
  }
}

async function installSourceResolver() {
  const { registerHooks } = await import('node:module')
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (
        specifier.startsWith('.')
        && specifier.endsWith('.js')
        && context.parentURL?.includes('/src/')
      ) {
        const typescriptUrl = new URL(`${specifier.slice(0, -3)}.ts`, context.parentURL)
        if (existsSync(typescriptUrl)) return { url: typescriptUrl.href, shortCircuit: true }
      }
      return nextResolve(specifier, context)
    },
  })
}
