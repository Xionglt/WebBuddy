import { createHash, randomUUID } from 'node:crypto'
import { appendFile, mkdir, open, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type {
  ActionBinding,
  ImmutableArtifactKind,
  ImmutableArtifactRef,
  JsonValue,
} from './async-task-contracts.js'

export type SessionArtifactSensitivity = 'public' | 'user' | 'sensitive' | 'secret'

export interface SessionArtifactRecord {
  schemaVersion: 'session-artifact-record/v1'
  ref: ImmutableArtifactRef
  summary: string
  sensitivity: SessionArtifactSensitivity
}

export interface SessionArtifactStoreOptions {
  rootDir: string
  runId: string
  sessionId: string
  now?: () => Date
}

export interface WriteSessionJsonArtifactInput<TKind extends ImmutableArtifactKind> {
  artifactKind: TKind
  value: JsonValue
  actionBinding: ActionBinding
  summary: string
  sensitivity?: SessionArtifactSensitivity
  artifactIdPrefix?: string
}

/**
 * Content-addressed, append-only artifact storage for one durable Agent session.
 * Artifact bytes never change after publication; the JSONL manifest is only an
 * index and can be reconstructed from the immutable references it contains.
 */
export class SessionArtifactStore {
  readonly rootDir: string
  readonly runId: string
  readonly sessionId: string

  private readonly artifactDir: string
  private readonly manifestPath: string
  private readonly now: () => Date
  private readonly records = new Map<string, SessionArtifactRecord>()
  private initializePromise?: Promise<void>
  private writeChain: Promise<void> = Promise.resolve()

  constructor(options: SessionArtifactStoreOptions) {
    this.rootDir = resolve(options.rootDir)
    this.runId = nonEmpty(options.runId, 'runId')
    this.sessionId = nonEmpty(options.sessionId, 'sessionId')
    this.artifactDir = join(this.rootDir, 'async-artifacts')
    this.manifestPath = join(this.artifactDir, 'manifest.jsonl')
    this.now = options.now ?? (() => new Date())
  }

  async initialize(): Promise<void> {
    if (!this.initializePromise) {
      this.initializePromise = this.loadManifest()
    }
    await this.initializePromise
  }

  async writeJson<TKind extends ImmutableArtifactKind>(
    input: WriteSessionJsonArtifactInput<TKind>,
  ): Promise<ImmutableArtifactRef<TKind>> {
    await this.initialize()
    const bytes = Buffer.from(`${JSON.stringify(input.value, null, 2)}\n`, 'utf8')
    const digest = createHash('sha256').update(bytes).digest('hex')
    const prefix = safePart(input.artifactIdPrefix ?? input.artifactKind)
    const artifactId = `${prefix}_${digest.slice(0, 24)}`
    const fileName = `${artifactId}.json`
    const relativeSegments = ['async-artifacts', input.artifactKind, fileName]
    const path = join(this.rootDir, ...relativeSegments)
    const ref: ImmutableArtifactRef<TKind> = {
      schemaVersion: 'immutable-artifact-ref/v1',
      artifactId,
      artifactKind: input.artifactKind,
      runId: this.runId,
      sessionId: this.sessionId,
      storage: { store: 'session_artifacts', relativeSegments },
      mediaType: 'application/json',
      byteLength: bytes.byteLength,
      sha256: digest,
      createdAt: this.now().toISOString(),
      actionBinding: structuredClone(input.actionBinding),
      immutable: true,
    }
    const record: SessionArtifactRecord = {
      schemaVersion: 'session-artifact-record/v1',
      ref,
      summary: boundedSummary(input.summary),
      sensitivity: input.sensitivity ?? 'user',
    }

    await this.serializedWrite(async () => {
      const existing = this.records.get(artifactId)
      if (existing) {
        assertSameArtifact(existing.ref, ref)
        return
      }
      await writeImmutable(path, bytes)
      await appendManifestRecord(this.manifestPath, record)
      this.records.set(artifactId, structuredClone(record))
    })
    return structuredClone(this.records.get(artifactId)!.ref as ImmutableArtifactRef<TKind>)
  }

  async listRecords(): Promise<SessionArtifactRecord[]> {
    await this.initialize()
    return [...this.records.values()]
      .sort((left, right) => left.ref.createdAt.localeCompare(right.ref.createdAt)
        || left.ref.artifactId.localeCompare(right.ref.artifactId))
      .map((record) => structuredClone(record))
  }

  async readJson(ref: ImmutableArtifactRef): Promise<JsonValue> {
    await this.initialize()
    const owned = this.records.get(ref.artifactId)
    if (!owned) throw new Error(`Artifact ${ref.artifactId} is not indexed in session ${this.sessionId}.`)
    assertSameArtifact(owned.ref, ref)
    const path = join(this.rootDir, ...ref.storage.relativeSegments)
    const bytes = await readFile(path)
    const digest = createHash('sha256').update(bytes).digest('hex')
    if (bytes.byteLength !== ref.byteLength || digest !== ref.sha256) {
      throw new Error(`Artifact integrity verification failed for ${ref.artifactId}.`)
    }
    return JSON.parse(bytes.toString('utf8')) as JsonValue
  }

  private async loadManifest(): Promise<void> {
    await mkdir(this.artifactDir, { recursive: true })
    await writeFile(this.manifestPath, '', { flag: 'a' })
    const text = await readFile(this.manifestPath, 'utf8')
    const lines = text.split('\n')
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index].trim()
      if (!line) continue
      let record: SessionArtifactRecord
      try {
        record = JSON.parse(line) as SessionArtifactRecord
      } catch (error) {
        const truncatedTail = index === lines.length - 1 && !text.endsWith('\n')
        if (truncatedTail) break
        throw error
      }
      validateRecord(record, this.runId, this.sessionId)
      const existing = this.records.get(record.ref.artifactId)
      if (existing) assertSameArtifact(existing.ref, record.ref)
      else this.records.set(record.ref.artifactId, structuredClone(record))
    }
  }

  private async serializedWrite<T>(operation: () => Promise<T>): Promise<T> {
    const prior = this.writeChain
    let release!: () => void
    this.writeChain = new Promise<void>((resolveWrite) => { release = resolveWrite })
    await prior.catch(() => undefined)
    try {
      return await operation()
    } finally {
      release()
    }
  }
}

async function writeImmutable(path: string, bytes: Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`
  await writeFile(temporary, bytes, { flag: 'wx' })
  const handle = await open(temporary, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await rename(temporary, path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    const existing = await readFile(path)
    if (!Buffer.from(existing).equals(Buffer.from(bytes))) {
      throw new Error(`Immutable artifact collision at ${path}.`)
    }
  }
}

async function appendManifestRecord(path: string, record: SessionArtifactRecord): Promise<void> {
  await appendFile(path, `${JSON.stringify(record)}\n`, 'utf8')
  const handle = await open(path, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

function validateRecord(record: SessionArtifactRecord, runId: string, sessionId: string): void {
  if (!record || record.schemaVersion !== 'session-artifact-record/v1') {
    throw new Error('Unsupported session artifact manifest record.')
  }
  const { ref } = record
  if (ref.schemaVersion !== 'immutable-artifact-ref/v1'
    || ref.runId !== runId
    || ref.sessionId !== sessionId
    || ref.storage.store !== 'session_artifacts'
    || ref.immutable !== true
    || !/^[a-f0-9]{64}$/.test(ref.sha256)
    || ref.storage.relativeSegments.some((segment) => (
      !segment || segment === '.' || segment === '..' || segment.includes('/') || segment.includes('\\')
    ))) {
    throw new Error(`Invalid immutable artifact record ${ref?.artifactId ?? '(unknown)'}.`)
  }
  if (!['public', 'user', 'sensitive', 'secret'].includes(record.sensitivity)) {
    throw new Error(`Invalid artifact sensitivity for ${ref.artifactId}.`)
  }
}

function assertSameArtifact(left: ImmutableArtifactRef, right: ImmutableArtifactRef): void {
  if (left.artifactId !== right.artifactId
    || left.runId !== right.runId
    || left.sessionId !== right.sessionId
    || left.artifactKind !== right.artifactKind
    || left.mediaType !== right.mediaType
    || left.byteLength !== right.byteLength
    || left.sha256 !== right.sha256
    || JSON.stringify(left.storage.relativeSegments) !== JSON.stringify(right.storage.relativeSegments)
    || JSON.stringify(left.actionBinding) !== JSON.stringify(right.actionBinding)) {
    throw new Error(`Artifact ${right.artifactId} was republished with conflicting immutable metadata.`)
  }
}

function boundedSummary(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  return normalized.slice(0, 600) || 'Immutable session artifact.'
}

function safePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]+/g, '_').replace(/^_+|_+$/g, '') || 'artifact'
}

function nonEmpty(value: string, name: string): string {
  const normalized = value.trim()
  if (!normalized) throw new Error(`${name} must be non-empty.`)
  return normalized
}
