import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { KernelEvent } from '../kernel/kernel-events.js'
import {
  sanitizeForPersistence,
  type PersistenceSanitizer,
} from '../security/redaction.js'
import { assertSafeStorageIdentity } from '../security/storage-identity.js'
import { appendJsonLine, appendJsonLineDurably } from './transcript.js'
import { migrateAgentSession } from './migrations.js'
import type {
  AgentSession,
  AgentSessionStatus,
  CreateSessionInput,
  SessionStore,
  TranscriptEntry,
} from './session-types.js'

export interface FileSessionStoreOptions {
  rootDir?: string
  sanitize?: PersistenceSanitizer
}

// FileSessionStore instances in one process can point at the same session
// root. Share append tails at module scope so durable and best-effort writers
// cannot reorder JSONL records merely because one metadata lookup completed
// first. This is deliberately not a cross-process lease.
const PROCESS_APPEND_TAILS = new Map<string, Promise<void>>()

export class FileSessionStore implements SessionStore {
  readonly rootDir: string
  private readonly sanitize?: PersistenceSanitizer

  constructor(options: FileSessionStoreOptions = {}) {
    this.rootDir = resolve(options.rootDir ?? join(process.cwd(), 'output', 'sessions'))
    this.sanitize = options.sanitize
  }

  async create(input: CreateSessionInput): Promise<AgentSession> {
    const now = input.now ?? new Date().toISOString()
    const sessionId = input.sessionId ?? createSessionId(now)
    const runId = input.runId ?? sessionId
    assertSafeStorageIdentity(sessionId, 'sessionId')
    assertSafeStorageIdentity(runId, 'runId')
    const outputDir = join(this.rootDir, sessionId)
    const session: AgentSession = {
      version: 1,
      sessionId,
      runId,
      source: input.source,
      status: 'created',
      goal: String(sanitizeForPersistence(input.goal, this.sanitize)),
      ...(input.mode ? { mode: input.mode } : {}),
      createdAt: now,
      updatedAt: now,
      outputDir,
      transcriptPath: join(outputDir, 'transcript.jsonl'),
      eventsPath: join(outputDir, 'events.jsonl'),
      workflowPath: join(outputDir, 'workflow.json'),
      ...(input.traceRunId ? { traceRunId: input.traceRunId } : {}),
    }

    await mkdir(this.rootDir, { recursive: true })
    try {
      await mkdir(outputDir)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new Error(`Session already exists: ${sessionId}`)
      }
      throw error
    }
    await writeSession(this.protect(session))
    await writeFile(session.transcriptPath, '', { flag: 'a' })
    await writeFile(session.eventsPath, '', { flag: 'a' })
    await this.writeWorkflowSnapshot(sessionId, null)
    await appendJsonLine(session.eventsPath, this.protect({
      version: 1,
      type: 'session_created',
      sessionId,
      runId,
      ts: now,
      message: 'Session created.',
      data: { source: input.source, mode: input.mode },
    } satisfies KernelEvent))
    return session
  }

  async get(sessionId: string): Promise<AgentSession | undefined> {
    assertSafeStorageIdentity(sessionId, 'sessionId')
    try {
      const session = migrateAgentSession(JSON.parse(await readFile(this.sessionJsonPath(sessionId), 'utf8')))
      this.assertStorageBinding(sessionId, session)
      return session
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }

  async update(sessionId: string, patch: Partial<AgentSession>): Promise<AgentSession> {
    const current = await this.get(sessionId)
    if (!current) throw new Error(`Session not found: ${sessionId}`)
    const next = this.protect<AgentSession>({
      ...current,
      ...patch,
      version: 1,
      sessionId: current.sessionId,
      runId: current.runId,
      outputDir: current.outputDir,
      transcriptPath: current.transcriptPath,
      eventsPath: current.eventsPath,
      workflowPath: current.workflowPath,
      updatedAt: patch.updatedAt ?? new Date().toISOString(),
    })
    this.assertStorageBinding(sessionId, next)
    await writeSession(next)
    return next
  }

  async appendTranscript(entry: TranscriptEntry): Promise<void> {
    await enqueueProcessAppend(this.appendKey(entry.sessionId, 'transcript'), async () => {
      const session = await this.get(entry.sessionId)
      if (!session) throw new Error(`Session not found: ${entry.sessionId}`)
      await appendJsonLine(session.transcriptPath, this.protect(entry))
    })
  }

  async appendTranscriptDurably(entry: TranscriptEntry): Promise<void> {
    await enqueueProcessAppend(this.appendKey(entry.sessionId, 'transcript'), async () => {
      const session = await this.get(entry.sessionId)
      if (!session) throw new Error(`Session not found: ${entry.sessionId}`)
      await appendJsonLineDurably(session.transcriptPath, this.protect(entry))
    })
  }

  async appendEvent(event: KernelEvent): Promise<void> {
    await enqueueProcessAppend(this.appendKey(event.sessionId, 'events'), async () => {
      const session = await this.get(event.sessionId)
      if (!session) throw new Error(`Session not found: ${event.sessionId}`)
      await appendJsonLine(session.eventsPath, this.protect(event))
    })
  }

  async appendEventDurably(event: KernelEvent): Promise<void> {
    await enqueueProcessAppend(this.appendKey(event.sessionId, 'events'), async () => {
      const session = await this.get(event.sessionId)
      if (!session) throw new Error(`Session not found: ${event.sessionId}`)
      await appendJsonLineDurably(session.eventsPath, this.protect(event))
    })
  }

  async writeWorkflowSnapshot(sessionId: string, workflowState: unknown): Promise<void> {
    const session = await this.get(sessionId)
    if (!session) throw new Error(`Session not found: ${sessionId}`)
    await mkdir(dirname(session.workflowPath), { recursive: true })
    await writeFile(
      session.workflowPath,
      `${JSON.stringify(this.protect({
        version: 1,
        sessionId: session.sessionId,
        runId: session.runId,
        updatedAt: new Date().toISOString(),
        workflowState,
      }), null, 2)}\n`,
      'utf8',
    )
  }

  async list(options: { limit?: number; status?: AgentSessionStatus } = {}): Promise<AgentSession[]> {
    let entries
    try {
      entries = await readdir(this.rootDir, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }

    const sessions: AgentSession[] = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const session = await this.get(entry.name).catch(() => undefined)
      if (!session) continue
      if (options.status && session.status !== options.status) continue
      sessions.push(session)
    }

    sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    return options.limit ? sessions.slice(0, options.limit) : sessions
  }

  private sessionJsonPath(sessionId: string): string {
    return join(this.rootDir, sessionId, 'session.json')
  }

  private appendKey(sessionId: string, stream: 'transcript' | 'events'): string {
    assertSafeStorageIdentity(sessionId, 'sessionId')
    return `${this.rootDir}\0${sessionId}\0${stream}`
  }

  private assertStorageBinding(requestedSessionId: string, session: AgentSession): void {
    const outputDir = join(this.rootDir, requestedSessionId)
    assertSafeStorageIdentity(session.sessionId, 'stored sessionId')
    assertSafeStorageIdentity(session.runId, 'stored runId')
    if (session.sessionId !== requestedSessionId
      || session.outputDir !== outputDir
      || session.transcriptPath !== join(outputDir, 'transcript.jsonl')
      || session.eventsPath !== join(outputDir, 'events.jsonl')
      || session.workflowPath !== join(outputDir, 'workflow.json')) {
      throw new Error(`SESSION_STORAGE_BINDING_MISMATCH: stored paths do not match session ${requestedSessionId}.`)
    }
  }

  private protect<T>(value: T): T {
    return sanitizeForPersistence(value, this.sanitize) as unknown as T
  }
}

async function enqueueProcessAppend(key: string, operation: () => Promise<void>): Promise<void> {
  const previous = PROCESS_APPEND_TAILS.get(key) ?? Promise.resolve()
  const current = previous.catch(() => undefined).then(operation)
  PROCESS_APPEND_TAILS.set(key, current)
  try {
    await current
  } finally {
    if (PROCESS_APPEND_TAILS.get(key) === current) PROCESS_APPEND_TAILS.delete(key)
  }
}

function createSessionId(now: string): string {
  const stamp = now.replace(/[:.]/g, '-').replace(/[^\dTZ-]/g, '').slice(0, 19)
  return `session_${stamp}_${randomUUID().slice(0, 8)}`
}

async function writeSession(session: AgentSession): Promise<void> {
  await mkdir(session.outputDir, { recursive: true })
  await writeFile(join(session.outputDir, 'session.json'), `${JSON.stringify(session, null, 2)}\n`, 'utf8')
}
