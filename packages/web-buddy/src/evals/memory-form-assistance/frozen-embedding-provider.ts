import { createHash } from 'node:crypto'
import type { EmbeddingProvider, MemoryEmbeddingMatch } from '../../memory/memory-lifecycle.js'

export const MEMORY_EMBEDDING_INPUT_MANIFEST_SCHEMA_VERSION =
  'memory-embedding-input-manifest/v1' as const
export const MEMORY_EMBEDDING_SNAPSHOT_SCHEMA_VERSION =
  'memory-embedding-snapshot/v1' as const

export interface MemoryEmbeddingInputManifest {
  schemaVersion: typeof MEMORY_EMBEDDING_INPUT_MANIFEST_SCHEMA_VERSION
  inputs: Array<{
    kind: 'query' | 'memory_content'
    sha256: string
    text: string
  }>
}

export interface MemoryEmbeddingSnapshot {
  schemaVersion: typeof MEMORY_EMBEDDING_SNAPSHOT_SCHEMA_VERSION
  model: {
    id: 'BAAI/bge-m3'
    revision: string
    filesManifestSha256: string
    implementation: string
    dimension: 1024
    normalization: 'l2'
  }
  generatedAt: string
  inputs: Array<{
    kind: 'query' | 'memory_content'
    sha256: string
    vector: number[]
  }>
}

export function assertMemoryEmbeddingInputManifest(
  value: unknown,
): asserts value is MemoryEmbeddingInputManifest {
  const manifest = closedObject(value, new Set(['schemaVersion', 'inputs']), 'manifest')
  if (manifest.schemaVersion !== MEMORY_EMBEDDING_INPUT_MANIFEST_SCHEMA_VERSION) {
    throw new Error(`Unsupported embedding input manifest schema: ${String(manifest.schemaVersion)}`)
  }
  if (!Array.isArray(manifest.inputs) || manifest.inputs.length === 0) {
    throw new Error('Embedding input manifest requires inputs.')
  }
  const keys = new Set<string>()
  let previousKey = ''
  for (const [index, candidate] of manifest.inputs.entries()) {
    const item = closedObject(candidate, new Set(['kind', 'sha256', 'text']), `inputs[${index}]`)
    const kind = embeddingKind(item.kind, `inputs[${index}].kind`)
    const text = requiredString(item.text, `inputs[${index}].text`)
    const sha256 = digest(item.sha256, `inputs[${index}].sha256`)
    if (hash(text) !== sha256) throw new Error(`inputs[${index}] sha256 does not match text.`)
    const key = `${kind}:${sha256}`
    if (keys.has(key)) throw new Error(`Embedding input manifest contains duplicate ${key}.`)
    if (previousKey && key.localeCompare(previousKey) < 0) {
      throw new Error('Embedding input manifest must use deterministic order.')
    }
    previousKey = key
    keys.add(key)
  }
}

export function assertMemoryEmbeddingSnapshot(
  value: unknown,
  manifestValue: unknown,
): asserts value is MemoryEmbeddingSnapshot {
  assertMemoryEmbeddingInputManifest(manifestValue)
  const manifest = manifestValue
  const snapshot = closedObject(value, new Set(['schemaVersion', 'model', 'generatedAt', 'inputs']), 'snapshot')
  if (snapshot.schemaVersion !== MEMORY_EMBEDDING_SNAPSHOT_SCHEMA_VERSION) {
    throw new Error(`Unsupported embedding snapshot schema: ${String(snapshot.schemaVersion)}`)
  }
  const model = closedObject(
    snapshot.model,
    new Set(['id', 'revision', 'filesManifestSha256', 'implementation', 'dimension', 'normalization']),
    'snapshot.model',
  )
  if (model.id !== 'BAAI/bge-m3') throw new Error('snapshot.model.id must be BAAI/bge-m3.')
  requiredString(model.revision, 'snapshot.model.revision')
  digest(model.filesManifestSha256, 'snapshot.model.filesManifestSha256')
  requiredString(model.implementation, 'snapshot.model.implementation')
  if (model.dimension !== 1024) throw new Error('snapshot.model.dimension must be 1024.')
  if (model.normalization !== 'l2') throw new Error('snapshot.model.normalization must be l2.')
  utcTimestamp(snapshot.generatedAt, 'snapshot.generatedAt')
  if (!Array.isArray(snapshot.inputs)) throw new Error('snapshot.inputs must be an array.')

  const expected = new Set(manifest.inputs.map((item) => `${item.kind}:${item.sha256}`))
  const observed = new Set<string>()
  for (const [index, candidate] of snapshot.inputs.entries()) {
    const item = closedObject(candidate, new Set(['kind', 'sha256', 'vector']), `snapshot.inputs[${index}]`)
    const kind = embeddingKind(item.kind, `snapshot.inputs[${index}].kind`)
    const sha256 = digest(item.sha256, `snapshot.inputs[${index}].sha256`)
    const key = `${kind}:${sha256}`
    if (observed.has(key)) throw new Error(`Embedding snapshot contains duplicate ${key}.`)
    observed.add(key)
    if (!Array.isArray(item.vector) || item.vector.length !== 1024) {
      throw new Error(`snapshot.inputs[${index}].vector must contain 1024 values.`)
    }
    if (!item.vector.every((number) => typeof number === 'number' && Number.isFinite(number))) {
      throw new Error(`snapshot.inputs[${index}].vector contains a non-finite value.`)
    }
    const norm = Math.sqrt(item.vector.reduce((sum, number) => sum + number * number, 0))
    if (Math.abs(norm - 1) > 1e-5) {
      throw new Error(`snapshot.inputs[${index}].vector must be L2 normalized.`)
    }
  }
  if (expected.size !== observed.size || [...expected].some((key) => !observed.has(key))) {
    throw new Error('Embedding snapshot coverage does not match the input manifest.')
  }
}

export class FrozenEmbeddingProvider implements EmbeddingProvider {
  readonly #vectors: ReadonlyMap<string, readonly number[]>

  constructor(input: { snapshot: unknown; manifest: unknown }) {
    assertMemoryEmbeddingSnapshot(input.snapshot, input.manifest)
    this.#vectors = new Map(input.snapshot.inputs.map((item) => [
      `${item.kind}:${item.sha256}`,
      Object.freeze([...item.vector]),
    ]))
  }

  async rank(input: Parameters<EmbeddingProvider['rank']>[0]): Promise<MemoryEmbeddingMatch[]> {
    const queryHash = hash(input.query)
    const query = this.#vectors.get(`query:${queryHash}`)
    if (!query) throw new Error(`Missing frozen query embedding: ${queryHash}`)
    const matches = input.candidates.map((candidate) => {
      const vector = this.#vectors.get(`memory_content:${candidate.contentHash}`)
      if (!vector) throw new Error(`Missing frozen Memory embedding: ${candidate.contentHash}`)
      return {
        entryId: candidate.entryId,
        score: (cosine(query, vector) + 1) / 2,
      }
    })
    return matches
      .sort((left, right) => right.score - left.score || left.entryId.localeCompare(right.entryId))
      .slice(0, input.maxResults)
  }
}

function cosine(left: readonly number[], right: readonly number[]): number {
  return left.reduce((sum, number, index) => sum + number * right[index]!, 0)
}

function embeddingKind(value: unknown, label: string): 'query' | 'memory_content' {
  if (value !== 'query' && value !== 'memory_content') throw new Error(`${label} is invalid.`)
  return value
}

function digest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest.`)
  }
  return value
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a non-empty string.`)
  return value
}

function utcTimestamp(value: unknown, label: string): string {
  const timestamp = requiredString(value, label)
  if (new Date(timestamp).toISOString() !== timestamp) throw new Error(`${label} must be canonical UTC.`)
  return timestamp
}

function closedObject(
  value: unknown,
  allowed: ReadonlySet<string>,
  label: string,
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`)
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${label} has unknown field ${key}.`)
  }
  return value as Record<string, unknown>
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
