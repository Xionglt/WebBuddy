import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import {
  sanitizeForPersistence,
  type PersistenceSanitizer,
} from '../security/redaction.js'

export type ToolResultArtifactKind =
  | 'page_snapshot'
  | 'browser_screenshot'
  | 'dom_dump'
  | 'network_log'
  | 'resume_query'
  | 'llm_summary'
  | 'generic_json'
  | 'text'

export type ToolResultArtifactSensitivity = 'public' | 'internal' | 'personal' | 'secret'

export interface ToolResultRetention {
  scope: 'run' | 'session' | 'project_debug'
  expiresAt?: string
  deleteWithSession?: boolean
}

export interface ToolResultRedaction {
  status: 'not_needed' | 'redacted' | 'contains_sensitive'
  redactedFields?: string[]
  reason?: string
}

export interface ToolResultArtifactRef {
  schemaVersion: 'tool-result-artifact-ref/v1'
  artifactId: string
  runId: string
  sessionId: string
  toolCallId: string
  toolName: string
  kind: ToolResultArtifactKind
  uri: string
  mediaType: string
  bytes: number
  sha256: string
  createdAt: string
  retention: ToolResultRetention
  sensitivity: ToolResultArtifactSensitivity
  redaction?: ToolResultRedaction
  summary?: string
}

export interface StoredToolResultEnvelope {
  schemaVersion: 'stored-tool-result/v1'
  ref: ToolResultArtifactRef
  content: unknown
  metadata?: {
    pageUrl?: string
    workflowPhase?: string
    riskLevel?: string
    policyCode?: string
  }
}

export interface ToolResultStoreWriteInput {
  runId: string
  sessionId: string
  toolCallId: string
  toolName: string
  kind: ToolResultArtifactKind
  content: unknown
  mediaType?: string
  sensitivity?: ToolResultArtifactSensitivity
  retention?: Partial<ToolResultRetention>
  summary?: string
  metadata?: StoredToolResultEnvelope['metadata']
}

export interface ToolResultStore {
  write(input: ToolResultStoreWriteInput): Promise<ToolResultArtifactRef>
  read(ref: ToolResultArtifactRef): Promise<StoredToolResultEnvelope>
  exists(ref: ToolResultArtifactRef): Promise<boolean>
}

export class FileToolResultStore implements ToolResultStore {
  private readonly rootDir: string
  private readonly now: () => Date
  private readonly sanitize?: PersistenceSanitizer

  constructor(options: {
    rootDir: string
    now?: () => Date
    sanitize?: PersistenceSanitizer
  }) {
    this.rootDir = resolve(options.rootDir)
    this.now = options.now ?? (() => new Date())
    this.sanitize = options.sanitize
  }

  async write(input: ToolResultStoreWriteInput): Promise<ToolResultArtifactRef> {
    const sensitivity = input.sensitivity ?? 'internal'
    if (sensitivity === 'secret') {
      throw new Error('SECRET_ARTIFACT_REJECTED: ordinary tool-result storage cannot persist secret content.')
    }
    const rawContent = normalizeStoredContent(input.content)
    const content = sanitizeForPersistence(rawContent, this.sanitize)
    const changed = stableStringify(content) !== stableStringify(rawContent)
    const mediaType = input.mediaType ?? defaultMediaType(input.kind)
    const bytes = contentBytes(content, mediaType)
    const sha256 = sha256Hex(bytes)
    const artifactId = randomUUID()
    const createdAt = this.now().toISOString()
    const dir = join(this.rootDir, safePathPart(input.sessionId), safePathPart(input.runId))
    const uri = join(dir, `${safePathPart(artifactId)}.json`)
    const safeSummary = input.summary === undefined
      ? undefined
      : String(sanitizeForPersistence(input.summary, this.sanitize))
    const safeMetadata = input.metadata === undefined
      ? undefined
      : sanitizeForPersistence(input.metadata, this.sanitize) as StoredToolResultEnvelope['metadata']
    const ref: ToolResultArtifactRef = {
      schemaVersion: 'tool-result-artifact-ref/v1',
      artifactId,
      runId: input.runId,
      sessionId: input.sessionId,
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      kind: input.kind,
      uri,
      mediaType,
      bytes: bytes.length,
      sha256,
      createdAt,
      retention: {
        scope: input.retention?.scope ?? 'run',
        ...(input.retention?.expiresAt ? { expiresAt: input.retention.expiresAt } : {}),
        deleteWithSession: input.retention?.deleteWithSession ?? true,
      },
      sensitivity,
      redaction: redactionForWrite(changed),
      ...(safeSummary ? { summary: safeSummary } : {}),
    }
    const envelope: StoredToolResultEnvelope = {
      schemaVersion: 'stored-tool-result/v1',
      ref,
      content,
      ...(safeMetadata ? { metadata: safeMetadata } : {}),
    }

    await mkdir(dir, { recursive: true })
    await writeFile(uri, `${JSON.stringify(envelope, null, 2)}\n`, 'utf8')
    return ref
  }

  async read(ref: ToolResultArtifactRef): Promise<StoredToolResultEnvelope> {
    assertKnownRef(ref)
    const path = this.pathFor(ref)
    const raw = await readFile(path, 'utf8')
    const envelope = JSON.parse(raw) as StoredToolResultEnvelope
    if (envelope.schemaVersion !== 'stored-tool-result/v1') {
      throw new Error(`Unsupported stored tool result schema: ${String(envelope.schemaVersion)}`)
    }
    assertStoredRefMatches(ref, envelope.ref)
    const bytes = contentBytes(envelope.content, ref.mediaType)
    const sha256 = sha256Hex(bytes)
    if (bytes.length !== ref.bytes || sha256 !== ref.sha256) {
      throw new Error(`Stored artifact integrity check failed for ${ref.artifactId}`)
    }
    return envelope
  }

  async exists(ref: ToolResultArtifactRef): Promise<boolean> {
    try {
      assertKnownRef(ref)
      const info = await stat(this.pathFor(ref))
      return info.isFile()
    } catch {
      return false
    }
  }

  private pathFor(ref: ToolResultArtifactRef): string {
    const path = isAbsolute(ref.uri) ? resolve(ref.uri) : resolve(this.rootDir, ref.uri)
    const rootWithSlash = `${this.rootDir}/`
    if (path !== this.rootDir && !path.startsWith(rootWithSlash)) {
      throw new Error(`Tool result artifact path escapes store root: ${ref.uri}`)
    }
    return path
  }
}

function assertKnownRef(ref: ToolResultArtifactRef): void {
  if (ref.schemaVersion !== 'tool-result-artifact-ref/v1') {
    throw new Error(`Unsupported tool result artifact ref schema: ${String(ref.schemaVersion)}`)
  }
}

function assertStoredRefMatches(expected: ToolResultArtifactRef, actual: ToolResultArtifactRef): void {
  if (stableStringify(actual) === stableStringify(expected)) return
  throw new Error(`Stored artifact ref mismatch for ${expected.artifactId}`)
}

function defaultMediaType(kind: ToolResultArtifactKind): string {
  if (kind === 'browser_screenshot') return 'image/png'
  if (kind === 'text') return 'text/plain; charset=utf-8'
  return 'application/json'
}

function normalizeStoredContent(content: unknown): unknown {
  if (content === undefined) return null
  if (Buffer.isBuffer(content)) {
    return {
      encoding: 'base64',
      data: content.toString('base64'),
    }
  }
  return content
}

function contentBytes(content: unknown, mediaType: string): Buffer {
  if (Buffer.isBuffer(content)) return content
  if (!mediaType.startsWith('application/json') && isEncodedBufferContent(content)) {
    return Buffer.from(content.data, content.encoding)
  }
  if (mediaType.startsWith('text/') && typeof content === 'string') return Buffer.from(content, 'utf8')
  return Buffer.from(JSON.stringify(content) ?? 'null', 'utf8')
}

function isEncodedBufferContent(value: unknown): value is { encoding: 'base64'; data: string } {
  return Boolean(
    value &&
      typeof value === 'object' &&
      (value as { encoding?: unknown }).encoding === 'base64' &&
      typeof (value as { data?: unknown }).data === 'string',
  )
}

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function safePathPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-|-$/g, '').slice(0, 120) || 'item'
}

function redactionForWrite(changed: boolean): ToolResultRedaction {
  if (changed) {
    return {
      status: 'redacted',
      reason: 'Persistence-boundary sanitizer changed the stored payload.',
    }
  }
  return { status: 'not_needed' }
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortJsonValue(value))
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, sortJsonValue(item)]),
  )
}
