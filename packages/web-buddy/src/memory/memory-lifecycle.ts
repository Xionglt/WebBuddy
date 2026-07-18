import { memoryContentHash } from './memory-write-policy.js'
import {
  DEFAULT_MEMORY_WRITE_POLICY,
  type MemoryActorScope,
  type MemoryDerivedFrom,
  type MemoryEntry,
  type MemoryProvenance,
  type MemoryTargetScope,
  type MemoryTransformStep,
  type MemoryWriteDecision,
  type MemoryWritePolicy,
} from './memory-write-policy.js'
import type {
  ContentOrigin,
  ContentSensitivity,
  ContentTrust,
  JsonValue,
} from '../task/contracts.js'
import type { MemoryScope } from './types.js'
import type { MemoryTransformKind } from './memory-write-policy.js'
import { redactSensitiveData } from '../security/redaction.js'
import {
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
} from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

export const MEMORY_LIFECYCLE_RECORD_SCHEMA_VERSION = 'memory-lifecycle-record/v2' as const
export const MEMORY_LIFECYCLE_STORE_SCHEMA_VERSION = 'memory-lifecycle-store/v1' as const
export const MEMORY_LIFECYCLE_RETRIEVAL_RESULT_SCHEMA_VERSION =
  'memory-lifecycle-retrieval-result/v2' as const

export type MemoryLifecycleErrorCode =
  | 'invalid_request'
  | 'unsupported_schema_version'
  | 'scope_violation'
  | 'corrupt_store'
  | 'store_busy'
  | 'persistence_failed'

export class MemoryLifecycleError extends Error {
  readonly code: MemoryLifecycleErrorCode

  constructor(code: MemoryLifecycleErrorCode, message: string) {
    super(message)
    this.name = 'MemoryLifecycleError'
    this.code = code
  }
}

export interface MemoryVersionExpectation {
  entryId: string
  expectedRevision: number
}

export interface MemoryVersionRef {
  entryId: string
  revision: number
}

export interface MemoryTombstone {
  schemaVersion: 'memory-tombstone/v1'
  entryId: string
  contentHash: string
  authoritative: true
  kind: 'deleted' | 'forgotten'
  at: string
  reason?: string
}

/**
 * B2 keeps the B1 security carrier on active records. A tombstone removes
 * content and lineage while retaining the opaque id/hash/scope fence needed
 * to prevent id/hash resurrection after restart.
 */
export interface MemoryLifecycleRecord {
  schemaVersion: typeof MEMORY_LIFECYCLE_RECORD_SCHEMA_VERSION
  entryId: string
  contentVersionId: string
  revision: number
  state: 'active' | 'tombstone'
  content: JsonValue | null
  contentHash: string
  scope: MemoryTargetScope
  trust: ContentTrust
  sensitivity: ContentSensitivity
  provenance: MemoryProvenance | null
  derivedFrom: MemoryDerivedFrom[]
  transformChain: MemoryTransformStep[]
  confidence: number
  createdAt: string
  updatedAt: string
  lastUsedAt?: string
  expiresAt?: string
  supersedes: MemoryVersionRef[]
  conflicts: MemoryVersionRef[]
  supersededBy?: string
  tombstone?: MemoryTombstone
}

export type MemoryLifecycleConflictCode =
  | 'revision_conflict'
  | 'entry_exists'
  | 'duplicate_content'
  | 'tombstoned'
  | 'not_found'
  | 'reference_conflict'

export type MemoryLifecycleMutationResult =
  | {
      status: 'created' | 'updated' | 'deduplicated' | 'deleted' | 'forgotten'
      record: Readonly<MemoryLifecycleRecord>
    }
  | {
      status: 'conflict'
      code: MemoryLifecycleConflictCode
      entryId?: string
      currentRevision?: number
      reason: string
    }
  | {
      status: 'policy_denied'
      decision: Extract<MemoryWriteDecision, { action: 'deny' }>
    }

export interface MemoryCreateRequest {
  schemaVersion: 'memory-lifecycle-create/v2'
  writeRequest: unknown
  confidence?: number
  ttlMs?: number
  expiresAt?: string
  supersedes?: MemoryVersionExpectation[]
  conflicts?: MemoryVersionExpectation[]
}

export interface MemoryUpdateRequest {
  schemaVersion: 'memory-lifecycle-update/v2'
  entryId: string
  scope: MemoryTargetScope
  expectedRevision: number
  writeRequest: unknown
  confidence?: number
  ttlMs?: number
  expiresAt?: string
  supersedes?: MemoryVersionExpectation[]
  conflicts?: MemoryVersionExpectation[]
}

export interface MemoryGetRequest {
  schemaVersion: 'memory-lifecycle-get/v2'
  entryId: string
  scope: MemoryTargetScope
  includeTombstone?: boolean
  includeExpired?: boolean
  includeSuperseded?: boolean
}

export interface MemoryListRequest {
  schemaVersion: 'memory-lifecycle-list/v2'
  scope: MemoryTargetScope
  includeTombstones?: boolean
  includeExpired?: boolean
  includeSuperseded?: boolean
}

export interface MemoryDeleteRequest {
  schemaVersion: 'memory-lifecycle-delete/v2'
  entryId: string
  scope: MemoryTargetScope
  expectedRevision: number
  reason?: string
}

export interface MemoryForgetRequest {
  schemaVersion: 'memory-lifecycle-forget/v2'
  entryId: string
  scope: MemoryTargetScope
  expectedRevision: number
  reason?: string
}

export interface MemoryRetrieveRequest {
  schemaVersion: 'memory-lifecycle-retrieve/v2'
  scope: MemoryTargetScope
  query: string
  maxResults: number
}

export interface MemoryRetrievalCandidate {
  entryId: string
  content: JsonValue
  contentHash: string
  confidence: number
}

export interface MemoryEmbeddingMatch {
  entryId: string
  score: number
}

/**
 * Provider output is advisory. The retriever intersects every returned id
 * with its already-filtered active candidate set before producing a result.
 */
export interface EmbeddingProvider {
  rank(input: {
    query: string
    candidates: ReadonlyArray<Readonly<MemoryRetrievalCandidate>>
    maxResults: number
  }): Promise<ReadonlyArray<Readonly<MemoryEmbeddingMatch>>>
}

export interface MemoryRetrievalResult {
  schemaVersion: typeof MEMORY_LIFECYCLE_RETRIEVAL_RESULT_SCHEMA_VERSION
  mode: 'keyword' | 'hybrid' | 'keyword_fallback'
  records: Array<{
    record: Readonly<MemoryLifecycleRecord>
    score: number
    reason: 'keyword' | 'embedding' | 'keyword+embedding'
  }>
}

export interface MemoryLifecyclePaths {
  root: string
  state: string
  lock: string
}

export function memoryLifecyclePaths(root: string): MemoryLifecyclePaths {
  if (typeof root !== 'string' || root.trim().length === 0) {
    throw new MemoryLifecycleError('invalid_request', 'Memory root must be a non-empty path.')
  }
  return {
    root,
    state: join(root, 'memory-lifecycle-v2.json'),
    lock: join(root, 'memory-lifecycle-v2.lock'),
  }
}

interface PersistedMemoryLifecycleState {
  schemaVersion: typeof MEMORY_LIFECYCLE_STORE_SCHEMA_VERSION
  storeRevision: number
  updatedAt: string
  records: MemoryLifecycleRecord[]
}

interface StoreVisibility {
  includeTombstones?: boolean
  includeExpired?: boolean
  includeSuperseded?: boolean
}

const POLICY_APPROVAL = Symbol('memory-lifecycle-policy-approval')

interface PolicyApprovedCreate {
  readonly [POLICY_APPROVAL]: true
  entry: Readonly<MemoryEntry>
  confidence: number
  expiresAt?: string
  supersedes: MemoryVersionExpectation[]
  conflicts: MemoryVersionExpectation[]
}

interface PolicyApprovedUpdate extends PolicyApprovedCreate {
  entryId: string
  scope: MemoryTargetScope
  expectedRevision: number
}

export interface MemoryStore {
  create(input: PolicyApprovedCreate): Promise<MemoryLifecycleMutationResult>
  update(input: PolicyApprovedUpdate): Promise<MemoryLifecycleMutationResult>
  get(
    entryId: string,
    scope: MemoryTargetScope,
    visibility?: StoreVisibility,
  ): Promise<Readonly<MemoryLifecycleRecord> | undefined>
  list(
    scope: MemoryTargetScope,
    visibility?: StoreVisibility,
  ): Promise<Array<Readonly<MemoryLifecycleRecord>>>
  tombstone(input: {
    entryId: string
    scope: MemoryTargetScope
    expectedRevision: number
    kind: 'deleted' | 'forgotten'
    reason?: string
  }): Promise<MemoryLifecycleMutationResult>
  touch(input: {
    entryId: string
    scope: MemoryTargetScope
    expectedRevision: number
  }): Promise<MemoryLifecycleMutationResult>
}

export class FileMemoryStore implements MemoryStore {
  readonly paths: MemoryLifecyclePaths
  readonly actorScope: Readonly<MemoryActorScope>
  readonly #now: () => Date

  constructor(input: {
    root: string
    actorScope: MemoryActorScope
    now?: () => Date
  }) {
    this.paths = memoryLifecyclePaths(input?.root)
    this.actorScope = deepFreeze(clone(validateActorScope(input?.actorScope)))
    this.#now = input?.now ?? (() => new Date())
    readClock(this.#now)
  }

  async create(input: PolicyApprovedCreate): Promise<MemoryLifecycleMutationResult> {
    const approved = validateApprovedCreate(input, this.actorScope, this.#now)
    return this.#write(async (state, at) => {
      const scope = canonicalScope(approved.entry.scope, this.actorScope)
      const sameId = state.records.find((record) => (
        record.entryId === approved.entry.entryId && sameScope(record.scope, scope)
      ))
      if (sameId) {
        if (sameId.state === 'tombstone') {
          return noWrite(conflict(
            'tombstoned',
            'A tombstoned Memory id cannot be resurrected.',
            sameId,
          ))
        }
        if (sameId.contentHash === approved.entry.contentHash) {
          return noWrite({
            status: 'deduplicated',
            record: freezeRecord(sameId),
          })
        }
        return noWrite(conflict('entry_exists', 'Memory id already exists with different content.', sameId))
      }

      const sameHash = state.records.find((record) => (
        record.contentHash === approved.entry.contentHash && sameScope(record.scope, scope)
      ))
      if (sameHash?.state === 'tombstone') {
        return noWrite(conflict(
          'tombstoned',
          'A tombstoned Memory content hash cannot be resurrected.',
          sameHash,
        ))
      }
      if (sameHash?.state === 'active') {
        return noWrite({
          status: 'deduplicated',
          record: freezeRecord(sameHash),
        })
      }

      const references = validateReferences(
        state.records,
        scope,
        approved.supersedes,
        approved.conflicts,
      )
      if ('conflict' in references) return noWrite(references.conflict)

      const record = materializeLifecycleRecord(approved, scope, at)
      applySupersedes(state.records, references.supersedes, record.entryId, at)
      state.records.push(record)
      return changed({
        status: 'created',
        record: freezeRecord(record),
      })
    })
  }

  async update(input: PolicyApprovedUpdate): Promise<MemoryLifecycleMutationResult> {
    const approved = validateApprovedUpdate(input, this.actorScope, this.#now)
    return this.#write(async (state, at) => {
      const index = findRecordIndex(state.records, approved.entryId, approved.scope)
      if (index < 0) {
        return noWrite(conflict('not_found', 'Memory entry does not exist.'))
      }
      const current = state.records[index]!
      if (current.state === 'tombstone') {
        return noWrite(conflict('tombstoned', 'Tombstoned Memory cannot be updated.', current))
      }
      if (current.revision !== approved.expectedRevision) {
        return noWrite(conflict(
          'revision_conflict',
          'Memory revision changed before update.',
          current,
        ))
      }
      const entryScope = canonicalScope(approved.entry.scope, this.actorScope)
      if (!sameScope(entryScope, approved.scope) || !sameScope(current.scope, approved.scope)) {
        throw new MemoryLifecycleError('scope_violation', 'Memory update crossed its durable scope.')
      }

      const duplicate = state.records.find((record, candidateIndex) => (
        candidateIndex !== index
        && record.state === 'active'
        && record.contentHash === approved.entry.contentHash
        && sameScope(record.scope, approved.scope)
      ))
      if (duplicate) {
        return noWrite(conflict(
          'duplicate_content',
          'Memory update duplicates another active entry.',
          duplicate,
        ))
      }

      const references = validateReferences(
        state.records,
        approved.scope,
        approved.supersedes,
        approved.conflicts,
        current.entryId,
      )
      if ('conflict' in references) return noWrite(references.conflict)

      const next: MemoryLifecycleRecord = {
        ...materializeLifecycleRecord(approved, approved.scope, at),
        entryId: current.entryId,
        contentVersionId: approved.entry.entryId,
        revision: current.revision + 1,
        createdAt: current.createdAt,
        lastUsedAt: current.lastUsedAt,
      }
      applySupersedes(state.records, references.supersedes, current.entryId, at)
      state.records[index] = next
      return changed({
        status: 'updated',
        record: freezeRecord(next),
      })
    })
  }

  async get(
    entryIdValue: string,
    scopeValue: MemoryTargetScope,
    visibility: StoreVisibility = {},
  ): Promise<Readonly<MemoryLifecycleRecord> | undefined> {
    const entryId = requiredId(entryIdValue, 'entryId')
    const scope = canonicalScope(scopeValue, this.actorScope)
    const options = validateVisibility(visibility)
    const state = await this.#read()
    const record = state.records.find((candidate) => (
      candidate.entryId === entryId && sameScope(candidate.scope, scope)
    ))
    if (!record || !visible(record, options, readClock(this.#now))) return undefined
    return freezeRecord(record)
  }

  async list(
    scopeValue: MemoryTargetScope,
    visibility: StoreVisibility = {},
  ): Promise<Array<Readonly<MemoryLifecycleRecord>>> {
    const scope = canonicalScope(scopeValue, this.actorScope)
    const options = validateVisibility(visibility)
    const at = readClock(this.#now)
    const state = await this.#read()
    return state.records
      .filter((record) => sameScope(record.scope, scope) && visible(record, options, at))
      .sort(compareRecords)
      .map(freezeRecord)
  }

  async tombstone(input: {
    entryId: string
    scope: MemoryTargetScope
    expectedRevision: number
    kind: 'deleted' | 'forgotten'
    reason?: string
  }): Promise<MemoryLifecycleMutationResult> {
    const parsed = validateTombstoneInput(input, this.actorScope)
    return this.#write(async (state, at) => {
      const index = findRecordIndex(state.records, parsed.entryId, parsed.scope)
      if (index < 0) return noWrite(conflict('not_found', 'Memory entry does not exist.'))
      const current = state.records[index]!
      if (current.state === 'tombstone') {
        return noWrite(conflict('tombstoned', 'Memory entry is already tombstoned.', current))
      }
      if (current.revision !== parsed.expectedRevision) {
        return noWrite(conflict(
          'revision_conflict',
          'Memory revision changed before tombstone.',
          current,
        ))
      }
      const record: MemoryLifecycleRecord = {
        ...current,
        revision: current.revision + 1,
        state: 'tombstone',
        content: null,
        provenance: null,
        derivedFrom: [],
        transformChain: [],
        confidence: 0,
        updatedAt: at,
        lastUsedAt: undefined,
        expiresAt: undefined,
        supersedes: [],
        conflicts: [],
        supersededBy: undefined,
        tombstone: {
          schemaVersion: 'memory-tombstone/v1',
          entryId: current.entryId,
          contentHash: current.contentHash,
          authoritative: true,
          kind: parsed.kind,
          at,
          ...(parsed.reason ? { reason: parsed.reason } : {}),
        },
      }
      state.records[index] = record
      return changed({
        status: parsed.kind === 'deleted' ? 'deleted' : 'forgotten',
        record: freezeRecord(record),
      })
    })
  }

  async touch(input: {
    entryId: string
    scope: MemoryTargetScope
    expectedRevision: number
  }): Promise<MemoryLifecycleMutationResult> {
    const parsed = validateTouchInput(input, this.actorScope)
    return this.#write(async (state, at) => {
      const index = findRecordIndex(state.records, parsed.entryId, parsed.scope)
      if (index < 0) return noWrite(conflict('not_found', 'Memory entry does not exist.'))
      const current = state.records[index]!
      if (current.state === 'tombstone') {
        return noWrite(conflict('tombstoned', 'Tombstoned Memory cannot be touched.', current))
      }
      if (current.revision !== parsed.expectedRevision) {
        return noWrite(conflict(
          'revision_conflict',
          'Memory revision changed before last-used update.',
          current,
        ))
      }
      if (!visible(current, {}, at)) {
        return noWrite(conflict('not_found', 'Expired or superseded Memory cannot be touched.', current))
      }
      if (current.lastUsedAt && Date.parse(current.lastUsedAt) >= Date.parse(at)) {
        return noWrite({
          status: 'updated',
          record: freezeRecord(current),
        })
      }
      const record: MemoryLifecycleRecord = {
        ...current,
        revision: current.revision,
        updatedAt: laterTimestamp(current.updatedAt, at),
        lastUsedAt: at,
      }
      state.records[index] = record
      return changed({
        status: 'updated',
        record: freezeRecord(record),
      })
    })
  }

  async #read(): Promise<PersistedMemoryLifecycleState> {
    await mkdir(this.paths.root, { recursive: true })
    try {
      return validateState(JSON.parse(await readFile(this.paths.state, 'utf8')))
    } catch (error) {
      if (isFileNotFound(error)) return emptyState(readClock(this.#now))
      if (error instanceof MemoryLifecycleError) throw error
      throw new MemoryLifecycleError('corrupt_store', 'Memory lifecycle state is not valid JSON.')
    }
  }

  async #write(
    operation: (
      state: PersistedMemoryLifecycleState,
      at: string,
    ) => Promise<WriteDisposition<MemoryLifecycleMutationResult>>
      | WriteDisposition<MemoryLifecycleMutationResult>,
  ): Promise<MemoryLifecycleMutationResult> {
    const lock = await acquireLock(this.paths)
    try {
      const state = await this.#read()
      const at = laterTimestamp(state.updatedAt, readClock(this.#now))
      const disposition = await operation(state, at)
      if (!disposition.changed) return disposition.result
      state.storeRevision += 1
      state.updatedAt = at
      state.records.sort(compareRecords)
      await persistState(this.paths, state)
      return disposition.result
    } finally {
      await releaseLock(this.paths, lock)
    }
  }
}

export class GovernedMemoryRetriever {
  readonly #store: MemoryStore
  readonly #actorScope: Readonly<MemoryActorScope>
  readonly #provider?: EmbeddingProvider

  constructor(input: {
    store: MemoryStore
    actorScope: MemoryActorScope
    embeddingProvider?: EmbeddingProvider
  }) {
    if (!input?.store || typeof input.store.list !== 'function' || typeof input.store.touch !== 'function') {
      throw new MemoryLifecycleError('invalid_request', 'Memory retriever requires a valid Store.')
    }
    if (
      input.embeddingProvider !== undefined
      && typeof input.embeddingProvider.rank !== 'function'
    ) {
      throw new MemoryLifecycleError('invalid_request', 'EmbeddingProvider.rank is required.')
    }
    this.#store = input.store
    this.#actorScope = deepFreeze(clone(validateActorScope(input.actorScope)))
    this.#provider = input.embeddingProvider
  }

  async retrieve(value: unknown): Promise<MemoryRetrievalResult> {
    const request = parseRetrieveRequest(value, this.#actorScope)
    const candidates = await this.#store.list(request.scope)
    const candidateMap = new Map(candidates.map((record) => [record.entryId, record]))
    const keywordScores = new Map<string, number>()
    for (const record of candidates) {
      const score = keywordScore(record, request.query)
      if (score > 0) keywordScores.set(record.entryId, score)
    }

    let mode: MemoryRetrievalResult['mode'] = 'keyword'
    let embeddingScores = new Map<string, number>()
    if (this.#provider) {
      try {
        const providerCandidates = candidates.map((record) => deepFreeze({
          entryId: record.entryId,
          content: clone(record.content as JsonValue),
          contentHash: record.contentHash,
          confidence: record.confidence,
        }))
        const matches = await this.#provider.rank({
          query: request.query,
          candidates: providerCandidates,
          maxResults: request.maxResults,
        })
        embeddingScores = validateEmbeddingMatches(matches, candidateMap)
        mode = 'hybrid'
      } catch {
        mode = 'keyword_fallback'
        embeddingScores = new Map()
      }
    }

    const scored = candidates
      .map((record) => {
        const keyword = keywordScores.get(record.entryId) ?? 0
        const embedding = embeddingScores.get(record.entryId) ?? 0
        return {
          record,
          score: keyword + embedding,
          reason: keyword > 0 && embedding > 0
            ? 'keyword+embedding' as const
            : embedding > 0
              ? 'embedding' as const
              : 'keyword' as const,
        }
      })
      .filter((item) => item.score > 0)
      .sort((left, right) => right.score - left.score || compareRecords(left.record, right.record))
      .slice(0, request.maxResults)

    const touched: MemoryRetrievalResult['records'] = []
    for (const item of scored) {
      const result = await this.#store.touch({
        entryId: item.record.entryId,
        scope: request.scope,
        expectedRevision: item.record.revision,
      })
      if (result.status === 'updated') {
        touched.push({
          ...item,
          record: result.record,
        })
      } else if (result.status === 'conflict') {
        const current = await this.#store.get(item.record.entryId, request.scope)
        if (current) touched.push({ ...item, record: current })
      }
    }
    return {
      schemaVersion: MEMORY_LIFECYCLE_RETRIEVAL_RESULT_SCHEMA_VERSION,
      mode,
      records: touched,
    }
  }
}

export class MemoryLifecycleService {
  readonly #store: MemoryStore
  readonly #retriever: GovernedMemoryRetriever
  readonly #actorScope: Readonly<MemoryActorScope>
  readonly #policy: MemoryWritePolicy
  readonly #now: () => Date

  constructor(input: {
    store: MemoryStore
    actorScope: MemoryActorScope
    retriever?: GovernedMemoryRetriever
    embeddingProvider?: EmbeddingProvider
    policy?: MemoryWritePolicy
    now?: () => Date
  }) {
    if (!input?.store) {
      throw new MemoryLifecycleError('invalid_request', 'Memory service requires a Store.')
    }
    if (input.policy !== undefined && typeof input.policy.evaluate !== 'function') {
      throw new MemoryLifecycleError('invalid_request', 'Memory write policy is invalid.')
    }
    this.#store = input.store
    this.#actorScope = deepFreeze(clone(validateActorScope(input.actorScope)))
    this.#policy = input.policy ?? DEFAULT_MEMORY_WRITE_POLICY
    this.#now = input.now ?? (() => new Date())
    readClock(this.#now)
    this.#retriever = input.retriever ?? new GovernedMemoryRetriever({
      store: input.store,
      actorScope: this.#actorScope,
      embeddingProvider: input.embeddingProvider,
    })
  }

  async create(value: unknown): Promise<MemoryLifecycleMutationResult> {
    const request = parseCreateRequest(value, this.#now)
    const decision = this.#evaluate(request.writeRequest)
    if (decision.action === 'deny') return { status: 'policy_denied', decision }
    return this.#store.create({
      [POLICY_APPROVAL]: true,
      entry: decision.entry,
      confidence: request.confidence,
      expiresAt: request.expiresAt,
      supersedes: request.supersedes,
      conflicts: request.conflicts,
    })
  }

  async update(value: unknown): Promise<MemoryLifecycleMutationResult> {
    const request = parseUpdateRequest(value, this.#actorScope, this.#now)
    const decision = this.#evaluate(request.writeRequest)
    if (decision.action === 'deny') return { status: 'policy_denied', decision }
    const entryScope = canonicalScope(decision.entry.scope, this.#actorScope)
    if (!sameScope(entryScope, request.scope)) {
      throw new MemoryLifecycleError('scope_violation', 'Approved Memory write targets another scope.')
    }
    return this.#store.update({
      [POLICY_APPROVAL]: true,
      entryId: request.entryId,
      scope: request.scope,
      expectedRevision: request.expectedRevision,
      entry: decision.entry,
      confidence: request.confidence,
      expiresAt: request.expiresAt,
      supersedes: request.supersedes,
      conflicts: request.conflicts,
    })
  }

  async get(value: unknown): Promise<Readonly<MemoryLifecycleRecord> | undefined> {
    const request = parseGetRequest(value, this.#actorScope)
    return this.#store.get(request.entryId, request.scope, {
      includeTombstones: request.includeTombstone,
      includeExpired: request.includeExpired,
      includeSuperseded: request.includeSuperseded,
    })
  }

  async list(value: unknown): Promise<Array<Readonly<MemoryLifecycleRecord>>> {
    const request = parseListRequest(value, this.#actorScope)
    return this.#store.list(request.scope, {
      includeTombstones: request.includeTombstones,
      includeExpired: request.includeExpired,
      includeSuperseded: request.includeSuperseded,
    })
  }

  async delete(value: unknown): Promise<MemoryLifecycleMutationResult> {
    const request = parseDeleteRequest(value, this.#actorScope)
    return this.#store.tombstone({
      ...request,
      kind: 'deleted',
    })
  }

  async forget(value: unknown): Promise<MemoryLifecycleMutationResult> {
    const request = parseForgetRequest(value, this.#actorScope)
    return this.#store.tombstone({
      ...request,
      kind: 'forgotten',
    })
  }

  async retrieve(value: unknown): Promise<MemoryRetrievalResult> {
    return this.#retriever.retrieve(value)
  }

  #evaluate(value: unknown): MemoryWriteDecision {
    try {
      return this.#policy.evaluate(value, this.#actorScope)
    } catch {
      return {
        schemaVersion: 'memory-write-policy-decision/v1',
        action: 'deny',
        reasonCode: 'invalid_request',
        reason: 'Memory write policy failed closed.',
      }
    }
  }
}

export function createFileMemoryLifecycle(input: {
  root: string
  actorScope: MemoryActorScope
  now?: () => Date
  embeddingProvider?: EmbeddingProvider
  policy?: MemoryWritePolicy
}): {
  store: FileMemoryStore
  retriever: GovernedMemoryRetriever
  service: MemoryLifecycleService
} {
  const store = new FileMemoryStore({
    root: input?.root,
    actorScope: input?.actorScope,
    now: input?.now,
  })
  const retriever = new GovernedMemoryRetriever({
    store,
    actorScope: input?.actorScope,
    embeddingProvider: input?.embeddingProvider,
  })
  const service = new MemoryLifecycleService({
    store,
    retriever,
    actorScope: input?.actorScope,
    policy: input?.policy,
    now: input?.now,
  })
  return Object.freeze({ store, retriever, service })
}

interface ParsedCreate {
  writeRequest: unknown
  confidence: number
  expiresAt?: string
  supersedes: MemoryVersionExpectation[]
  conflicts: MemoryVersionExpectation[]
}

interface ParsedUpdate extends ParsedCreate {
  entryId: string
  scope: MemoryTargetScope
  expectedRevision: number
}

const CREATE_KEYS = new Set([
  'schemaVersion',
  'writeRequest',
  'confidence',
  'ttlMs',
  'expiresAt',
  'supersedes',
  'conflicts',
])
const UPDATE_KEYS = new Set([
  'schemaVersion',
  'entryId',
  'scope',
  'expectedRevision',
  'writeRequest',
  'confidence',
  'ttlMs',
  'expiresAt',
  'supersedes',
  'conflicts',
])
const GET_KEYS = new Set([
  'schemaVersion',
  'entryId',
  'scope',
  'includeTombstone',
  'includeExpired',
  'includeSuperseded',
])
const LIST_KEYS = new Set([
  'schemaVersion',
  'scope',
  'includeTombstones',
  'includeExpired',
  'includeSuperseded',
])
const TOMBSTONE_REQUEST_KEYS = new Set([
  'schemaVersion',
  'entryId',
  'scope',
  'expectedRevision',
  'reason',
])
const RETRIEVE_KEYS = new Set(['schemaVersion', 'scope', 'query', 'maxResults'])
const SCOPE_KEYS = new Set(['kind', 'tenantId', 'userId', 'projectId', 'sessionId', 'runId'])
const ACTOR_SCOPE_KEYS = new Set(['tenantId', 'userId', 'projectId', 'sessionId', 'runId'])
const VERSION_EXPECTATION_KEYS = new Set(['entryId', 'expectedRevision'])
const VERSION_REF_KEYS = new Set(['entryId', 'revision'])
const STATE_KEYS = new Set(['schemaVersion', 'storeRevision', 'updatedAt', 'records'])
const RECORD_KEYS = new Set([
  'schemaVersion',
  'entryId',
  'contentVersionId',
  'revision',
  'state',
  'content',
  'contentHash',
  'scope',
  'trust',
  'sensitivity',
  'provenance',
  'derivedFrom',
  'transformChain',
  'confidence',
  'createdAt',
  'updatedAt',
  'lastUsedAt',
  'expiresAt',
  'supersedes',
  'conflicts',
  'supersededBy',
  'tombstone',
])
const TOMBSTONE_KEYS = new Set([
  'schemaVersion',
  'entryId',
  'contentHash',
  'authoritative',
  'kind',
  'at',
  'reason',
])
const PROVENANCE_KEYS = new Set([
  'contentId',
  'capturedAt',
  'parentContentIds',
  'tenantId',
  'userId',
  'projectId',
  'sessionId',
  'runId',
])
const DERIVED_KEYS = new Set(['contentId', 'origin', 'trust', 'sensitivity', 'provenance'])
const TRANSFORM_KEYS = new Set(['kind', 'inputContentIds', 'outputContentId'])
const TRUST = new Set<ContentTrust>([
  'trusted_runtime',
  'user_authorized',
  'untrusted_external',
  'derived_untrusted',
  'non_authoritative',
])
const SENSITIVITY = new Set<ContentSensitivity>([
  'public',
  'internal',
  'personal',
  'auth',
  'secret',
])
const ORIGINS = new Set<ContentOrigin>([
  'system',
  'user',
  'web',
  'tool',
  'download',
  'artifact',
  'memory',
  'subagent',
  'derived',
])
const TRANSFORMS = new Set<MemoryTransformKind>([
  'direct',
  'redaction',
  'normalization',
  'summary',
  'embedding',
  'trace',
])
const MAX_TTL_MS = 366 * 24 * 60 * 60 * 1000

function parseCreateRequest(value: unknown, now: () => Date): ParsedCreate {
  const input = closedObject(value, CREATE_KEYS, 'MemoryCreateRequest')
  assertVersion(input.schemaVersion, 'memory-lifecycle-create/v2')
  if (!Object.hasOwn(input, 'writeRequest')) {
    invalid('MemoryCreateRequest.writeRequest is required.')
  }
  return {
    writeRequest: input.writeRequest,
    confidence: optionalConfidence(input.confidence),
    ...parseExpiry(input.ttlMs, input.expiresAt, now),
    supersedes: parseExpectations(input.supersedes, 'supersedes'),
    conflicts: parseExpectations(input.conflicts, 'conflicts'),
  }
}

function parseUpdateRequest(
  value: unknown,
  actor: MemoryActorScope,
  now: () => Date,
): ParsedUpdate {
  const input = closedObject(value, UPDATE_KEYS, 'MemoryUpdateRequest')
  assertVersion(input.schemaVersion, 'memory-lifecycle-update/v2')
  if (!Object.hasOwn(input, 'writeRequest')) {
    invalid('MemoryUpdateRequest.writeRequest is required.')
  }
  return {
    entryId: requiredId(input.entryId, 'entryId'),
    scope: canonicalScope(input.scope, actor),
    expectedRevision: requiredRevision(input.expectedRevision, 'expectedRevision'),
    writeRequest: input.writeRequest,
    confidence: optionalConfidence(input.confidence),
    ...parseExpiry(input.ttlMs, input.expiresAt, now),
    supersedes: parseExpectations(input.supersedes, 'supersedes'),
    conflicts: parseExpectations(input.conflicts, 'conflicts'),
  }
}

function parseGetRequest(
  value: unknown,
  actor: MemoryActorScope,
): MemoryGetRequest {
  const input = closedObject(value, GET_KEYS, 'MemoryGetRequest')
  assertVersion(input.schemaVersion, 'memory-lifecycle-get/v2')
  return {
    schemaVersion: 'memory-lifecycle-get/v2',
    entryId: requiredId(input.entryId, 'entryId'),
    scope: canonicalScope(input.scope, actor),
    includeTombstone: optionalBoolean(input.includeTombstone, 'includeTombstone'),
    includeExpired: optionalBoolean(input.includeExpired, 'includeExpired'),
    includeSuperseded: optionalBoolean(input.includeSuperseded, 'includeSuperseded'),
  }
}

function parseListRequest(
  value: unknown,
  actor: MemoryActorScope,
): MemoryListRequest {
  const input = closedObject(value, LIST_KEYS, 'MemoryListRequest')
  assertVersion(input.schemaVersion, 'memory-lifecycle-list/v2')
  return {
    schemaVersion: 'memory-lifecycle-list/v2',
    scope: canonicalScope(input.scope, actor),
    includeTombstones: optionalBoolean(input.includeTombstones, 'includeTombstones'),
    includeExpired: optionalBoolean(input.includeExpired, 'includeExpired'),
    includeSuperseded: optionalBoolean(input.includeSuperseded, 'includeSuperseded'),
  }
}

function parseDeleteRequest(
  value: unknown,
  actor: MemoryActorScope,
): Omit<MemoryDeleteRequest, 'schemaVersion'> {
  return parseTombstoneRequest(value, actor, 'memory-lifecycle-delete/v2')
}

function parseForgetRequest(
  value: unknown,
  actor: MemoryActorScope,
): Omit<MemoryForgetRequest, 'schemaVersion'> {
  return parseTombstoneRequest(value, actor, 'memory-lifecycle-forget/v2')
}

function parseTombstoneRequest(
  value: unknown,
  actor: MemoryActorScope,
  version: 'memory-lifecycle-delete/v2' | 'memory-lifecycle-forget/v2',
): {
  entryId: string
  scope: MemoryTargetScope
  expectedRevision: number
  reason?: string
} {
  const input = closedObject(value, TOMBSTONE_REQUEST_KEYS, 'MemoryTombstoneRequest')
  assertVersion(input.schemaVersion, version)
  return {
    entryId: requiredId(input.entryId, 'entryId'),
    scope: canonicalScope(input.scope, actor),
    expectedRevision: requiredRevision(input.expectedRevision, 'expectedRevision'),
    ...(input.reason === undefined ? {} : { reason: safeReason(input.reason, 'reason') }),
  }
}

function parseRetrieveRequest(
  value: unknown,
  actor: MemoryActorScope,
): MemoryRetrieveRequest {
  const input = closedObject(value, RETRIEVE_KEYS, 'MemoryRetrieveRequest')
  assertVersion(input.schemaVersion, 'memory-lifecycle-retrieve/v2')
  return {
    schemaVersion: 'memory-lifecycle-retrieve/v2',
    scope: canonicalScope(input.scope, actor),
    query: boundedText(input.query, 'query', 16_384, true),
    maxResults: boundedInteger(input.maxResults, 'maxResults', 1, 100),
  }
}

function parseExpiry(
  ttlValue: unknown,
  expiresValue: unknown,
  now: () => Date,
): { expiresAt?: string } {
  if (ttlValue !== undefined && expiresValue !== undefined) {
    invalid('ttlMs and expiresAt are mutually exclusive.')
  }
  const at = readClock(now)
  if (ttlValue !== undefined) {
    const ttlMs = boundedInteger(ttlValue, 'ttlMs', 1, MAX_TTL_MS)
    return { expiresAt: new Date(Date.parse(at) + ttlMs).toISOString() }
  }
  if (expiresValue !== undefined) {
    const expiresAt = requiredTimestamp(expiresValue, 'expiresAt')
    if (Date.parse(expiresAt) <= Date.parse(at)) {
      invalid('expiresAt must be in the future.')
    }
    return { expiresAt }
  }
  return {}
}

function optionalConfidence(value: unknown): number {
  if (value === undefined) return 1
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    invalid('confidence must be between 0 and 1.')
  }
  return value
}

function parseExpectations(value: unknown, label: string): MemoryVersionExpectation[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 256) invalid(`${label} must be a bounded array.`)
  const parsed = value.map((item, index) => {
    const input = closedObject(item, VERSION_EXPECTATION_KEYS, `${label}[${index}]`)
    return {
      entryId: requiredId(input.entryId, `${label}[${index}].entryId`),
      expectedRevision: requiredRevision(
        input.expectedRevision,
        `${label}[${index}].expectedRevision`,
      ),
    }
  })
  if (new Set(parsed.map((item) => item.entryId)).size !== parsed.length) {
    invalid(`${label} contains duplicate entry ids.`)
  }
  return parsed
}

function validateApprovedCreate(
  input: PolicyApprovedCreate,
  actor: MemoryActorScope,
  now: () => Date,
): PolicyApprovedCreate {
  if (input?.[POLICY_APPROVAL] !== true
    || !input.entry
    || input.entry.schemaVersion !== 'memory-entry/v2') {
    invalid('Store accepts only a B1 policy-approved MemoryEntry.')
  }
  const scope = canonicalScope(input.entry.scope, actor)
  if (input.entry.contentHash !== memoryContentHash(input.entry.content)) {
    invalid('Policy-approved MemoryEntry content hash is invalid.')
  }
  return {
    [POLICY_APPROVAL]: true,
    entry: deepFreeze(clone({ ...input.entry, scope })),
    confidence: optionalConfidence(input.confidence),
    ...(input.expiresAt === undefined
      ? {}
      : { expiresAt: validateFutureExpiry(input.expiresAt, now) }),
    supersedes: parseExpectations(input.supersedes, 'supersedes'),
    conflicts: parseExpectations(input.conflicts, 'conflicts'),
  }
}

function validateApprovedUpdate(
  input: PolicyApprovedUpdate,
  actor: MemoryActorScope,
  now: () => Date,
): PolicyApprovedUpdate {
  const create = validateApprovedCreate(input, actor, now)
  return {
    ...create,
    entryId: requiredId(input.entryId, 'entryId'),
    scope: canonicalScope(input.scope, actor),
    expectedRevision: requiredRevision(input.expectedRevision, 'expectedRevision'),
  }
}

function validateFutureExpiry(value: unknown, now: () => Date): string {
  const expiresAt = requiredTimestamp(value, 'expiresAt')
  if (Date.parse(expiresAt) <= Date.parse(readClock(now))) {
    invalid('expiresAt must be in the future.')
  }
  return expiresAt
}

function validateTombstoneInput(
  input: {
    entryId: string
    scope: MemoryTargetScope
    expectedRevision: number
    kind: 'deleted' | 'forgotten'
    reason?: string
  },
  actor: MemoryActorScope,
): typeof input {
  if (input.kind !== 'deleted' && input.kind !== 'forgotten') {
    invalid('Tombstone kind is invalid.')
  }
  return {
    entryId: requiredId(input.entryId, 'entryId'),
    scope: canonicalScope(input.scope, actor),
    expectedRevision: requiredRevision(input.expectedRevision, 'expectedRevision'),
    kind: input.kind,
    ...(input.reason === undefined ? {} : { reason: safeReason(input.reason, 'reason') }),
  }
}

function validateTouchInput(
  input: {
    entryId: string
    scope: MemoryTargetScope
    expectedRevision: number
  },
  actor: MemoryActorScope,
): typeof input {
  return {
    entryId: requiredId(input.entryId, 'entryId'),
    scope: canonicalScope(input.scope, actor),
    expectedRevision: requiredRevision(input.expectedRevision, 'expectedRevision'),
  }
}

function materializeLifecycleRecord(
  input: PolicyApprovedCreate,
  scope: MemoryTargetScope,
  at: string,
): MemoryLifecycleRecord {
  return {
    schemaVersion: MEMORY_LIFECYCLE_RECORD_SCHEMA_VERSION,
    entryId: input.entry.entryId,
    contentVersionId: input.entry.entryId,
    revision: 0,
    state: 'active',
    content: clone(input.entry.content),
    contentHash: input.entry.contentHash,
    scope: clone(scope),
    trust: input.entry.trust,
    sensitivity: input.entry.sensitivity,
    provenance: clone(input.entry.provenance),
    derivedFrom: clone(input.entry.derivedFrom),
    transformChain: clone(input.entry.transformChain),
    confidence: input.confidence,
    createdAt: input.entry.createdAt,
    updatedAt: at,
    ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
    supersedes: input.supersedes.map(toVersionRef),
    conflicts: input.conflicts.map(toVersionRef),
  }
}

function validateReferences(
  records: MemoryLifecycleRecord[],
  scope: MemoryTargetScope,
  supersedes: MemoryVersionExpectation[],
  conflictsValue: MemoryVersionExpectation[],
  selfId?: string,
):
  | {
      supersedes: Array<{ record: MemoryLifecycleRecord; expected: MemoryVersionExpectation }>
      conflicts: Array<{ record: MemoryLifecycleRecord; expected: MemoryVersionExpectation }>
    }
  | { conflict: Extract<MemoryLifecycleMutationResult, { status: 'conflict' }> } {
  const supersedesSet = new Set(supersedes.map((item) => item.entryId))
  if (conflictsValue.some((item) => supersedesSet.has(item.entryId))) {
    return {
      conflict: conflict('reference_conflict', 'A Memory cannot both supersede and conflict with one entry.'),
    }
  }
  const resolve = (
    expectations: MemoryVersionExpectation[],
    label: string,
  ): Array<{ record: MemoryLifecycleRecord; expected: MemoryVersionExpectation }>
    | Extract<MemoryLifecycleMutationResult, { status: 'conflict' }> => {
    const output: Array<{ record: MemoryLifecycleRecord; expected: MemoryVersionExpectation }> = []
    for (const expected of expectations) {
      if (expected.entryId === selfId) {
        return conflict('reference_conflict', `${label} cannot reference the updated Memory itself.`)
      }
      const record = records.find((candidate) => (
        candidate.entryId === expected.entryId && sameScope(candidate.scope, scope)
      ))
      if (!record || record.state !== 'active') {
        return conflict('reference_conflict', `${label} references missing or tombstoned Memory.`)
      }
      if (record.revision !== expected.expectedRevision) {
        return conflict(
          'revision_conflict',
          `${label} revision changed before mutation.`,
          record,
        )
      }
      output.push({ record, expected })
    }
    return output
  }
  const resolvedSupersedes = resolve(supersedes, 'supersedes')
  if (!Array.isArray(resolvedSupersedes)) return { conflict: resolvedSupersedes }
  const resolvedConflicts = resolve(conflictsValue, 'conflicts')
  if (!Array.isArray(resolvedConflicts)) return { conflict: resolvedConflicts }
  return {
    supersedes: resolvedSupersedes,
    conflicts: resolvedConflicts,
  }
}

function applySupersedes(
  records: MemoryLifecycleRecord[],
  references: Array<{ record: MemoryLifecycleRecord }>,
  successorId: string,
  at: string,
): void {
  for (const reference of references) {
    const index = records.indexOf(reference.record)
    records[index] = {
      ...reference.record,
      revision: reference.record.revision + 1,
      updatedAt: at,
      supersededBy: successorId,
    }
  }
}

function toVersionRef(value: MemoryVersionExpectation): MemoryVersionRef {
  return {
    entryId: value.entryId,
    revision: value.expectedRevision,
  }
}

function visible(
  record: MemoryLifecycleRecord,
  visibility: StoreVisibility,
  at: string,
): boolean {
  if (record.state === 'tombstone' && !visibility.includeTombstones) return false
  if (
    record.state === 'active'
    && record.expiresAt
    && Date.parse(record.expiresAt) <= Date.parse(at)
    && !visibility.includeExpired
  ) return false
  if (record.supersededBy && !visibility.includeSuperseded) return false
  return true
}

function validateVisibility(value: StoreVisibility): StoreVisibility {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('Visibility is invalid.')
  const keys = new Set(['includeTombstones', 'includeExpired', 'includeSuperseded'])
  for (const key of Object.keys(value)) {
    if (!keys.has(key)) invalid(`Visibility contains unsupported field ${key}.`)
  }
  return {
    includeTombstones: optionalBoolean(value.includeTombstones, 'includeTombstones'),
    includeExpired: optionalBoolean(value.includeExpired, 'includeExpired'),
    includeSuperseded: optionalBoolean(value.includeSuperseded, 'includeSuperseded'),
  }
}

function keywordScore(record: Readonly<MemoryLifecycleRecord>, query: string): number {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return record.confidence
  const text = JSON.stringify(record.content).toLowerCase()
  const matches = terms.filter((term) => text.includes(term)).length
  if (matches === 0) return 0
  return matches / terms.length + record.confidence * 0.1
}

function validateEmbeddingMatches(
  value: unknown,
  candidates: ReadonlyMap<string, Readonly<MemoryLifecycleRecord>>,
): Map<string, number> {
  if (!Array.isArray(value) || value.length > 10_000) {
    throw new MemoryLifecycleError('invalid_request', 'EmbeddingProvider returned an invalid match set.')
  }
  const output = new Map<string, number>()
  for (const [index, item] of value.entries()) {
    const match = closedObject(item, new Set(['entryId', 'score']), `embeddingMatch[${index}]`)
    const entryId = requiredId(match.entryId, `embeddingMatch[${index}].entryId`)
    if (typeof match.score !== 'number' || !Number.isFinite(match.score) || match.score < 0) {
      invalid(`embeddingMatch[${index}].score is invalid.`)
    }
    if (!candidates.has(entryId)) continue
    output.set(entryId, Math.max(output.get(entryId) ?? 0, match.score))
  }
  return output
}

function validateState(value: unknown): PersistedMemoryLifecycleState {
  const input = closedObject(value, STATE_KEYS, 'MemoryLifecycleState', 'corrupt_store')
  if (input.schemaVersion !== MEMORY_LIFECYCLE_STORE_SCHEMA_VERSION) {
    throw new MemoryLifecycleError(
      'unsupported_schema_version',
      'Unsupported Memory lifecycle Store schema version.',
    )
  }
  const recordsValue = input.records
  if (!Array.isArray(recordsValue) || recordsValue.length > 1_000_000) {
    corrupt('Memory lifecycle records must be a bounded array.')
  }
  const records = recordsValue.map((record, index) => validateStoredRecord(record, index))
  const ids = new Set<string>()
  for (const record of records) {
    const key = `${canonicalScopeKey(record.scope)}:${record.entryId}`
    if (ids.has(key)) corrupt('Memory lifecycle Store contains duplicate ids.')
    ids.add(key)
  }
  return {
    schemaVersion: MEMORY_LIFECYCLE_STORE_SCHEMA_VERSION,
    storeRevision: boundedInteger(input.storeRevision, 'storeRevision', 0, Number.MAX_SAFE_INTEGER, 'corrupt_store'),
    updatedAt: requiredTimestamp(input.updatedAt, 'updatedAt', 'corrupt_store'),
    records,
  }
}

function validateStoredRecord(value: unknown, index: number): MemoryLifecycleRecord {
  const label = `records[${index}]`
  const input = closedObject(value, RECORD_KEYS, label, 'corrupt_store')
  if (input.schemaVersion !== MEMORY_LIFECYCLE_RECORD_SCHEMA_VERSION) {
    throw new MemoryLifecycleError(
      'unsupported_schema_version',
      `Unsupported ${label} schema version.`,
    )
  }
  const state = input.state
  if (state !== 'active' && state !== 'tombstone') corrupt(`${label}.state is invalid.`)
  const scope = parseStoredScope(input.scope, `${label}.scope`)
  const content = validateJson(input.content, `${label}.content`)
  const contentHash = digest(input.contentHash, `${label}.contentHash`)
  const provenance = input.provenance === null
    ? null
    : validateStoredProvenance(input.provenance, `${label}.provenance`)
  const derivedFrom = validateStoredDerived(input.derivedFrom, `${label}.derivedFrom`)
  const transformChain = validateStoredTransforms(input.transformChain, `${label}.transformChain`)
  const tombstone = input.tombstone === undefined
    ? undefined
    : validateStoredTombstone(input.tombstone, `${label}.tombstone`)
  if (state === 'active') {
    if (content === null || provenance === null || derivedFrom.length === 0 || transformChain.length === 0) {
      corrupt(`${label} active record lost content or lineage.`)
    }
    if (tombstone !== undefined) corrupt(`${label} active record carries a tombstone.`)
    if (memoryContentHash(content) !== contentHash) corrupt(`${label} content hash does not match.`)
  } else {
    if (
      content !== null
      || provenance !== null
      || derivedFrom.length !== 0
      || transformChain.length !== 0
      || !tombstone
      || tombstone.authoritative !== true
    ) {
      corrupt(`${label} tombstone still contains recoverable content or lineage.`)
    }
    if (tombstone.entryId !== input.entryId || tombstone.contentHash !== contentHash) {
      corrupt(`${label} tombstone is not bound to its Memory id and content hash.`)
    }
  }
  return {
    schemaVersion: MEMORY_LIFECYCLE_RECORD_SCHEMA_VERSION,
    entryId: requiredId(input.entryId, `${label}.entryId`, 'corrupt_store'),
    contentVersionId: requiredId(input.contentVersionId, `${label}.contentVersionId`, 'corrupt_store'),
    revision: requiredRevision(input.revision, `${label}.revision`, 'corrupt_store'),
    state,
    content,
    contentHash,
    scope,
    trust: enumValue(input.trust, TRUST, `${label}.trust`, 'corrupt_store'),
    sensitivity: enumValue(
      input.sensitivity,
      SENSITIVITY,
      `${label}.sensitivity`,
      'corrupt_store',
    ),
    provenance,
    derivedFrom,
    transformChain,
    confidence: storedConfidence(input.confidence, `${label}.confidence`),
    createdAt: requiredTimestamp(input.createdAt, `${label}.createdAt`, 'corrupt_store'),
    updatedAt: requiredTimestamp(input.updatedAt, `${label}.updatedAt`, 'corrupt_store'),
    ...(input.lastUsedAt === undefined
      ? {}
      : { lastUsedAt: requiredTimestamp(input.lastUsedAt, `${label}.lastUsedAt`, 'corrupt_store') }),
    ...(input.expiresAt === undefined
      ? {}
      : { expiresAt: requiredTimestamp(input.expiresAt, `${label}.expiresAt`, 'corrupt_store') }),
    supersedes: validateVersionRefs(input.supersedes, `${label}.supersedes`),
    conflicts: validateVersionRefs(input.conflicts, `${label}.conflicts`),
    ...(input.supersededBy === undefined
      ? {}
      : { supersededBy: requiredId(input.supersededBy, `${label}.supersededBy`, 'corrupt_store') }),
    ...(tombstone ? { tombstone } : {}),
  }
}

function validateStoredProvenance(value: unknown, label: string): MemoryProvenance {
  const input = closedObject(value, PROVENANCE_KEYS, label, 'corrupt_store')
  return {
    contentId: requiredId(input.contentId, `${label}.contentId`, 'corrupt_store'),
    capturedAt: requiredTimestamp(input.capturedAt, `${label}.capturedAt`, 'corrupt_store'),
    parentContentIds: stringArray(input.parentContentIds, `${label}.parentContentIds`, 'corrupt_store'),
    ...storedOptionalIds(input, label),
    runId: requiredId(input.runId, `${label}.runId`, 'corrupt_store'),
  }
}

function validateStoredDerived(value: unknown, label: string): MemoryDerivedFrom[] {
  if (!Array.isArray(value) || value.length > 256) corrupt(`${label} must be a bounded array.`)
  return value.map((candidate, index) => {
    const itemLabel = `${label}[${index}]`
    const item = closedObject(candidate, DERIVED_KEYS, itemLabel, 'corrupt_store')
    return {
      contentId: requiredId(item.contentId, `${itemLabel}.contentId`, 'corrupt_store'),
      origin: enumValue(item.origin, ORIGINS, `${itemLabel}.origin`, 'corrupt_store'),
      trust: enumValue(item.trust, TRUST, `${itemLabel}.trust`, 'corrupt_store'),
      sensitivity: enumValue(
        item.sensitivity,
        SENSITIVITY,
        `${itemLabel}.sensitivity`,
        'corrupt_store',
      ),
      provenance: validateStoredProvenance(item.provenance, `${itemLabel}.provenance`),
    }
  })
}

function validateStoredTransforms(value: unknown, label: string): MemoryTransformStep[] {
  if (!Array.isArray(value) || value.length > 256) corrupt(`${label} must be a bounded array.`)
  return value.map((candidate, index) => {
    const itemLabel = `${label}[${index}]`
    const item = closedObject(candidate, TRANSFORM_KEYS, itemLabel, 'corrupt_store')
    return {
      kind: enumValue(item.kind, TRANSFORMS, `${itemLabel}.kind`, 'corrupt_store'),
      inputContentIds: stringArray(item.inputContentIds, `${itemLabel}.inputContentIds`, 'corrupt_store'),
      outputContentId: requiredId(
        item.outputContentId,
        `${itemLabel}.outputContentId`,
        'corrupt_store',
      ),
    }
  })
}

function validateStoredTombstone(value: unknown, label: string): MemoryTombstone {
  const input = closedObject(value, TOMBSTONE_KEYS, label, 'corrupt_store')
  if (
    input.schemaVersion !== 'memory-tombstone/v1'
    || input.authoritative !== true
    || (input.kind !== 'deleted' && input.kind !== 'forgotten')
  ) corrupt(`${label} is invalid.`)
  return {
    schemaVersion: 'memory-tombstone/v1',
    entryId: requiredId(input.entryId, `${label}.entryId`, 'corrupt_store'),
    contentHash: digest(input.contentHash, `${label}.contentHash`),
    authoritative: true,
    kind: input.kind,
    at: requiredTimestamp(input.at, `${label}.at`, 'corrupt_store'),
    ...(input.reason === undefined
      ? {}
      : { reason: safeReason(input.reason, `${label}.reason`, 'corrupt_store') }),
  }
}

function validateVersionRefs(value: unknown, label: string): MemoryVersionRef[] {
  if (!Array.isArray(value) || value.length > 256) corrupt(`${label} must be a bounded array.`)
  return value.map((candidate, index) => {
    const item = closedObject(candidate, VERSION_REF_KEYS, `${label}[${index}]`, 'corrupt_store')
    return {
      entryId: requiredId(item.entryId, `${label}[${index}].entryId`, 'corrupt_store'),
      revision: requiredRevision(item.revision, `${label}[${index}].revision`, 'corrupt_store'),
    }
  })
}

function parseStoredScope(value: unknown, label: string): MemoryTargetScope {
  const input = closedObject(value, SCOPE_KEYS, label, 'corrupt_store')
  if (input.kind !== 'run' && input.kind !== 'session' && input.kind !== 'project' && input.kind !== 'user') {
    corrupt(`${label}.kind is invalid.`)
  }
  const result: MemoryTargetScope = { kind: input.kind }
  for (const key of ['tenantId', 'userId', 'projectId', 'sessionId', 'runId'] as const) {
    if (input[key] !== undefined) {
      result[key] = requiredId(input[key], `${label}.${key}`, 'corrupt_store')
    }
  }
  assertCanonicalStoredScope(result, label)
  return result
}

function assertCanonicalStoredScope(scope: MemoryTargetScope, label: string): void {
  if (!scope.tenantId || !scope.userId) corrupt(`${label} lacks tenant/user ownership.`)
  if (scope.kind === 'project' && !scope.projectId) corrupt(`${label} lacks projectId.`)
  if (scope.kind === 'session' && !scope.sessionId) corrupt(`${label} lacks sessionId.`)
  if (scope.kind === 'run' && !scope.runId) corrupt(`${label} lacks runId.`)
  if (scope.kind === 'user' && (scope.projectId || scope.sessionId || scope.runId)) {
    corrupt(`${label} is not canonical user scope.`)
  }
  if (scope.kind === 'project' && (scope.sessionId || scope.runId)) {
    corrupt(`${label} is not canonical project scope.`)
  }
  if (scope.kind === 'session' && scope.runId) corrupt(`${label} is not canonical session scope.`)
}

function canonicalScope(value: unknown, actorValue: MemoryActorScope): MemoryTargetScope {
  const actor = validateActorScope(actorValue)
  const input = closedObject(value, SCOPE_KEYS, 'MemoryTargetScope')
  if (input.kind !== 'run' && input.kind !== 'session' && input.kind !== 'project' && input.kind !== 'user') {
    scopeViolation('Memory target scope kind is invalid.')
  }
  const claimed: Partial<Record<'tenantId' | 'userId' | 'projectId' | 'sessionId' | 'runId', string>> = {}
  for (const key of ['tenantId', 'userId', 'projectId', 'sessionId', 'runId'] as const) {
    if (input[key] !== undefined) claimed[key] = requiredId(input[key], `scope.${key}`)
    if (claimed[key] !== undefined && claimed[key] !== actor[key]) {
      scopeViolation(`Memory scope ${key} crosses the configured actor.`)
    }
  }
  if (!actor.tenantId || claimed.tenantId !== actor.tenantId) {
    scopeViolation('Memory scope must bind the configured tenantId.')
  }
  if (!actor.userId || claimed.userId !== actor.userId) {
    scopeViolation('Memory scope must bind the configured userId.')
  }
  const result: MemoryTargetScope = {
    kind: input.kind,
    tenantId: actor.tenantId,
    userId: actor.userId,
  }
  if (input.kind === 'project' || input.kind === 'session' || input.kind === 'run') {
    if (!actor.projectId || claimed.projectId !== actor.projectId) {
      scopeViolation(`Memory ${input.kind} scope must bind projectId.`)
    }
    result.projectId = actor.projectId
  }
  if (input.kind === 'session' || input.kind === 'run') {
    if (!actor.sessionId || claimed.sessionId !== actor.sessionId) {
      scopeViolation(`Memory ${input.kind} scope must bind sessionId.`)
    }
    result.sessionId = actor.sessionId
  }
  if (input.kind === 'run') {
    if (claimed.runId !== actor.runId) scopeViolation('Memory run scope must bind runId.')
    result.runId = actor.runId
  }
  return result
}

function validateActorScope(value: unknown): MemoryActorScope {
  const input = closedObject(value, ACTOR_SCOPE_KEYS, 'MemoryActorScope')
  const output: MemoryActorScope = {
    runId: requiredId(input.runId, 'actorScope.runId'),
  }
  for (const key of ['tenantId', 'userId', 'projectId', 'sessionId'] as const) {
    if (input[key] !== undefined) output[key] = requiredId(input[key], `actorScope.${key}`)
  }
  if (!output.tenantId || !output.userId) {
    scopeViolation('B2 requires explicit tenantId and userId actor bindings.')
  }
  return output
}

function sameScope(left: MemoryTargetScope, right: MemoryTargetScope): boolean {
  return canonicalScopeKey(left) === canonicalScopeKey(right)
}

function canonicalScopeKey(scope: MemoryTargetScope): string {
  return JSON.stringify([
    scope.kind,
    scope.tenantId ?? null,
    scope.userId ?? null,
    scope.projectId ?? null,
    scope.sessionId ?? null,
    scope.runId ?? null,
  ])
}

function findRecordIndex(
  records: MemoryLifecycleRecord[],
  entryId: string,
  scope: MemoryTargetScope,
): number {
  return records.findIndex((record) => (
    record.entryId === entryId && sameScope(record.scope, scope)
  ))
}

function compareRecords(
  left: Pick<MemoryLifecycleRecord, 'entryId' | 'updatedAt'>,
  right: Pick<MemoryLifecycleRecord, 'entryId' | 'updatedAt'>,
): number {
  return right.updatedAt.localeCompare(left.updatedAt) || left.entryId.localeCompare(right.entryId)
}

function emptyState(at: string): PersistedMemoryLifecycleState {
  return {
    schemaVersion: MEMORY_LIFECYCLE_STORE_SCHEMA_VERSION,
    storeRevision: 0,
    updatedAt: at,
    records: [],
  }
}

type WriteDisposition<T> =
  | { changed: true; result: T }
  | { changed: false; result: T }

function changed<T>(result: T): WriteDisposition<T> {
  return { changed: true, result }
}

function noWrite<T>(result: T): WriteDisposition<T> {
  return { changed: false, result }
}

function conflict(
  code: MemoryLifecycleConflictCode,
  reason: string,
  record?: Pick<MemoryLifecycleRecord, 'entryId' | 'revision'>,
): Extract<MemoryLifecycleMutationResult, { status: 'conflict' }> {
  return {
    status: 'conflict',
    code,
    ...(record ? { entryId: record.entryId, currentRevision: record.revision } : {}),
    reason,
  }
}

async function persistState(
  paths: MemoryLifecyclePaths,
  state: PersistedMemoryLifecycleState,
): Promise<void> {
  const temp = `${paths.state}.${process.pid}.${randomUUID()}.tmp`
  let handle
  try {
    await mkdir(paths.root, { recursive: true })
    handle = await open(temp, 'wx', 0o600)
    await handle.writeFile(`${JSON.stringify(state)}\n`, 'utf8')
    await handle.sync()
    await handle.close()
    handle = undefined
    await rename(temp, paths.state)
    try {
      const directory = await open(paths.root, 'r')
      await directory.sync()
      await directory.close()
    } catch {
      // Some filesystems do not support directory fsync; atomic rename remains.
    }
  } catch (error) {
    if (handle) await handle.close().catch(() => {})
    await unlink(temp).catch(() => {})
    throw new MemoryLifecycleError(
      'persistence_failed',
      `Memory lifecycle state could not be persisted: ${errorMessage(error)}`,
    )
  }
}

async function acquireLock(paths: MemoryLifecyclePaths): Promise<Awaited<ReturnType<typeof open>>> {
  await mkdir(paths.root, { recursive: true })
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      const handle = await open(paths.lock, 'wx', 0o600)
      await handle.writeFile(`${JSON.stringify({
        pid: process.pid,
        acquiredAt: new Date().toISOString(),
      })}\n`, 'utf8')
      await handle.sync()
      return handle
    } catch (error) {
      if (!isAlreadyExists(error)) {
        throw new MemoryLifecycleError('persistence_failed', 'Memory Store lock could not be acquired.')
      }
      try {
        const lockStat = await stat(paths.lock)
        if (Date.now() - lockStat.mtimeMs > 30_000) {
          await unlink(paths.lock)
          continue
        }
      } catch (inspectError) {
        if (isFileNotFound(inspectError)) continue
      }
      await delay(5)
    }
  }
  throw new MemoryLifecycleError('store_busy', 'Memory Store remained locked.')
}

async function releaseLock(
  paths: MemoryLifecyclePaths,
  handle: Awaited<ReturnType<typeof open>>,
): Promise<void> {
  await handle.close().catch(() => {})
  await unlink(paths.lock).catch(() => {})
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function closedObject(
  value: unknown,
  keys: ReadonlySet<string>,
  label: string,
  code: 'invalid_request' | 'corrupt_store' = 'invalid_request',
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new MemoryLifecycleError(code, `${label} must be a plain object.`)
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new MemoryLifecycleError(code, `${label} must be a plain object.`)
  }
  for (const key of Object.keys(value)) {
    if (!keys.has(key)) {
      throw new MemoryLifecycleError(code, `${label} contains unsupported field ${key}.`)
    }
  }
  return value as Record<string, unknown>
}

function assertVersion(value: unknown, expected: string): void {
  if (value !== expected) {
    throw new MemoryLifecycleError(
      'unsupported_schema_version',
      `Unsupported schema version; expected ${expected}.`,
    )
  }
}

function requiredId(
  value: unknown,
  label: string,
  code: 'invalid_request' | 'corrupt_store' = 'invalid_request',
): string {
  if (
    typeof value !== 'string'
    || value.trim() !== value
    || value.length === 0
    || value.length > 512
  ) throw new MemoryLifecycleError(code, `${label} must be a non-empty bounded string.`)
  return value
}

function boundedText(
  value: unknown,
  label: string,
  max: number,
  allowEmpty = false,
  code: 'invalid_request' | 'corrupt_store' = 'invalid_request',
): string {
  if (
    typeof value !== 'string'
    || value.length > max
    || (!allowEmpty && value.trim().length === 0)
  ) throw new MemoryLifecycleError(code, `${label} must be a bounded string.`)
  return value
}

function safeReason(
  value: unknown,
  label: string,
  code: 'invalid_request' | 'corrupt_store' = 'invalid_request',
): string {
  const reason = boundedText(value, label, 1_024, false, code)
  if (redactSensitiveData(reason).changed) {
    throw new MemoryLifecycleError(code, `${label} contains credential-like material.`)
  }
  return reason
}

function requiredRevision(
  value: unknown,
  label: string,
  code: 'invalid_request' | 'corrupt_store' = 'invalid_request',
): number {
  return boundedInteger(value, label, 0, Number.MAX_SAFE_INTEGER, code)
}

function boundedInteger(
  value: unknown,
  label: string,
  min: number,
  max: number,
  code: 'invalid_request' | 'corrupt_store' = 'invalid_request',
): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    throw new MemoryLifecycleError(code, `${label} must be an integer from ${min} through ${max}.`)
  }
  return value as number
}

function requiredTimestamp(
  value: unknown,
  label: string,
  code: 'invalid_request' | 'corrupt_store' = 'invalid_request',
): string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || !Number.isFinite(Date.parse(value))
  ) throw new MemoryLifecycleError(code, `${label} must be a valid timestamp.`)
  return new Date(value).toISOString()
}

function optionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') invalid(`${label} must be boolean.`)
  return value
}

function validateJson(value: unknown, label: string): JsonValue {
  assertJson(value, label, new Set())
  return clone(value as JsonValue)
}

function assertJson(value: unknown, label: string, seen: Set<object>): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) corrupt(`${label} contains a non-finite number.`)
    return
  }
  if (typeof value !== 'object') corrupt(`${label} is not JSON-safe.`)
  if (seen.has(value)) corrupt(`${label} contains a cycle.`)
  seen.add(value)
  if (Array.isArray(value)) {
    value.forEach((child, index) => assertJson(child, `${label}[${index}]`, seen))
  } else {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      corrupt(`${label} contains a non-plain object.`)
    }
    Object.entries(value).forEach(([key, child]) => assertJson(child, `${label}.${key}`, seen))
  }
  seen.delete(value)
}

function storedOptionalIds(
  input: Record<string, unknown>,
  label: string,
): Partial<MemoryActorScope> {
  const output: Partial<MemoryActorScope> = {}
  for (const key of ['tenantId', 'userId', 'projectId', 'sessionId'] as const) {
    if (input[key] !== undefined) {
      output[key] = requiredId(input[key], `${label}.${key}`, 'corrupt_store')
    }
  }
  return output
}

function stringArray(
  value: unknown,
  label: string,
  code: 'invalid_request' | 'corrupt_store',
): string[] {
  if (!Array.isArray(value) || value.length > 256) {
    throw new MemoryLifecycleError(code, `${label} must be a bounded string array.`)
  }
  const output = value.map((item, index) => requiredId(item, `${label}[${index}]`, code))
  if (new Set(output).size !== output.length) {
    throw new MemoryLifecycleError(code, `${label} contains duplicates.`)
  }
  return output
}

function enumValue<T extends string>(
  value: unknown,
  values: ReadonlySet<string>,
  label: string,
  code: 'invalid_request' | 'corrupt_store',
): T {
  if (typeof value !== 'string' || !values.has(value)) {
    throw new MemoryLifecycleError(code, `${label} is invalid.`)
  }
  return value as T
}

function digest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    corrupt(`${label} must be a SHA-256 digest.`)
  }
  return value
}

function storedConfidence(value: unknown, label: string): number {
  if (
    typeof value !== 'number'
    || !Number.isFinite(value)
    || value < 0
    || value > 1
  ) corrupt(`${label} must be between 0 and 1.`)
  return value
}

function readClock(now: () => Date): string {
  const value = now()
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    invalid('Memory clock returned an invalid Date.')
  }
  return value.toISOString()
}

function laterTimestamp(left: string, right: string): string {
  return Date.parse(left) >= Date.parse(right) ? left : right
}

function freezeRecord(record: MemoryLifecycleRecord): Readonly<MemoryLifecycleRecord> {
  return deepFreeze(clone(record))
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}

function invalid(message: string): never {
  throw new MemoryLifecycleError('invalid_request', message)
}

function corrupt(message: string): never {
  throw new MemoryLifecycleError('corrupt_store', message)
}

function scopeViolation(message: string): never {
  throw new MemoryLifecycleError('scope_violation', message)
}

function isFileNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as { code?: unknown }).code === 'ENOENT')
}

function isAlreadyExists(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as { code?: unknown }).code === 'EEXIST')
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
