#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

import {
  FrozenEmbeddingProvider,
  assertMemoryEmbeddingInputManifest,
  assertMemoryEmbeddingSnapshot,
} from '../dist/evals/memory-form-assistance/frozen-embedding-provider.js'
import { memoryContentHash } from '../dist/memory/memory-write-policy.js'

const manifest = JSON.parse(await readFile(
  new URL('../evals/memory-form-assistance/embedding-inputs.json', import.meta.url),
  'utf8',
))
assert.doesNotThrow(() => assertMemoryEmbeddingInputManifest(manifest))
assert(manifest.inputs.length > 10)
assert.deepEqual(
  manifest.inputs,
  [...manifest.inputs].sort((left, right) => (
    left.kind.localeCompare(right.kind) || left.sha256.localeCompare(right.sha256)
  )),
  'manifest inputs must have deterministic order',
)
assert.equal(new Set(manifest.inputs.map((item) => `${item.kind}:${item.sha256}`)).size, manifest.inputs.length)
for (const item of manifest.inputs) {
  assert.equal(sha256(item.text), item.sha256)
  if (item.kind === 'memory_content') {
    assert.equal(memoryContentHash(JSON.parse(item.text)), item.sha256)
  }
}

const query = 'query-a'
const candidateContent = { fieldKey: 'city', kind: 'form_preference', statement: 'City A', value: 'A' }
const contractManifest = {
  schemaVersion: 'memory-embedding-input-manifest/v1',
  inputs: [
    { kind: 'memory_content', sha256: memoryContentHash(candidateContent), text: canonicalJson(candidateContent) },
    { kind: 'query', sha256: sha256(query), text: query },
  ].sort((left, right) => left.kind.localeCompare(right.kind) || left.sha256.localeCompare(right.sha256)),
}
const queryVector = unitVector(0)
const candidateVector = unitVector(0)
const snapshot = snapshotFor(contractManifest, [queryVector, candidateVector])
assert.doesNotThrow(() => assertMemoryEmbeddingSnapshot(snapshot, contractManifest))

const provider = new FrozenEmbeddingProvider({ snapshot, manifest: contractManifest })
const ranked = await provider.rank({
  query,
  candidates: [{
    entryId: 'memory-a',
    content: candidateContent,
    contentHash: memoryContentHash(candidateContent),
    confidence: 1,
  }],
  maxResults: 3,
})
assert.deepEqual(ranked, [{ entryId: 'memory-a', score: 1 }])

assertSnapshotRejects({ ...snapshot, schemaVersion: 'memory-embedding-snapshot/v999' }, /schema/i)
assertSnapshotRejects({ ...snapshot, model: { ...snapshot.model, id: 'other' } }, /BAAI\/bge-m3/i)
assertSnapshotRejects({ ...snapshot, model: { ...snapshot.model, revision: '' } }, /revision/i)
assertSnapshotRejects({ ...snapshot, model: { ...snapshot.model, filesManifestSha256: 'bad' } }, /filesManifestSha256/i)
assertSnapshotRejects({ ...snapshot, model: { ...snapshot.model, dimension: 3 } }, /dimension/i)
assertSnapshotRejects({
  ...snapshot,
  inputs: snapshot.inputs.map((item, index) => index === 0 ? { ...item, vector: [1, 0] } : item),
}, /1024/i)
assertSnapshotRejects({
  ...snapshot,
  inputs: snapshot.inputs.map((item, index) => index === 0
    ? { ...item, vector: item.vector.map((value, vectorIndex) => vectorIndex === 0 ? 2 : value) }
    : item),
}, /L2/i)
assertSnapshotRejects({
  ...snapshot,
  inputs: [snapshot.inputs[0], snapshot.inputs[0]],
}, /duplicate|coverage/i)
assertSnapshotRejects({ ...snapshot, inputs: snapshot.inputs.slice(1) }, /coverage/i)

const missingQueryProvider = new FrozenEmbeddingProvider({ snapshot, manifest: contractManifest })
await assert.rejects(
  () => missingQueryProvider.rank({ query: 'missing', candidates: [], maxResults: 1 }),
  /missing frozen query embedding/i,
)

console.log('memory-form-assistance-embedding-test: PASS')

function snapshotFor(inputManifest, vectors) {
  return {
    schemaVersion: 'memory-embedding-snapshot/v1',
    model: {
      id: 'BAAI/bge-m3',
      revision: 'contract-test-revision',
      filesManifestSha256: 'a'.repeat(64),
      implementation: 'contract-test-only',
      dimension: 1024,
      normalization: 'l2',
    },
    generatedAt: '2026-07-26T00:00:00.000Z',
    inputs: inputManifest.inputs.map((item, index) => ({
      kind: item.kind,
      sha256: item.sha256,
      vector: vectors[index],
    })),
  }
}

function assertSnapshotRejects(value, pattern) {
  assert.throws(() => assertMemoryEmbeddingSnapshot(value, contractManifest), pattern)
}

function unitVector(index) {
  return Array.from({ length: 1024 }, (_, candidate) => candidate === index ? 1 : 0)
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
}
