import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { KernelEvent } from '../kernel/kernel-events.js'
import { appendJsonLine } from './transcript.js'
import type {
  AgentSession,
  AgentSessionStatus,
  CreateSessionInput,
  SessionStore,
  TranscriptEntry,
} from './session-types.js'

export interface FileSessionStoreOptions {
  rootDir?: string
}

export class FileSessionStore implements SessionStore {
  readonly rootDir: string

  constructor(options: FileSessionStoreOptions = {}) {
    this.rootDir = resolve(options.rootDir ?? join(process.cwd(), 'output', 'sessions'))
  }

  async create(input: CreateSessionInput): Promise<AgentSession> {
    const now = input.now ?? new Date().toISOString()
    const sessionId = input.sessionId ?? createSessionId(now)
    const runId = input.runId ?? sessionId
    const outputDir = join(this.rootDir, sessionId)
    const session: AgentSession = {
      version: 1,
      sessionId,
      runId,
      source: input.source,
      status: 'created',
      goal: input.goal,
      ...(input.mode ? { mode: input.mode } : {}),
      createdAt: now,
      updatedAt: now,
      outputDir,
      transcriptPath: join(outputDir, 'transcript.jsonl'),
      eventsPath: join(outputDir, 'events.jsonl'),
      workflowPath: join(outputDir, 'workflow.json'),
      ...(input.traceRunId ? { traceRunId: input.traceRunId } : {}),
    }

    await mkdir(outputDir, { recursive: true })
    await writeSession(session)
    await writeFile(session.transcriptPath, '', { flag: 'a' })
    await writeFile(session.eventsPath, '', { flag: 'a' })
    await this.writeWorkflowSnapshot(sessionId, null)
    await appendJsonLine(session.eventsPath, {
      version: 1,
      type: 'session_created',
      sessionId,
      runId,
      ts: now,
      message: 'Session created.',
      data: { source: input.source, mode: input.mode },
    } satisfies KernelEvent)
    return session
  }

  async get(sessionId: string): Promise<AgentSession | undefined> {
    try {
      return JSON.parse(await readFile(this.sessionJsonPath(sessionId), 'utf8')) as AgentSession
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }

  async update(sessionId: string, patch: Partial<AgentSession>): Promise<AgentSession> {
    const current = await this.get(sessionId)
    if (!current) throw new Error(`Session not found: ${sessionId}`)
    const next: AgentSession = {
      ...current,
      ...patch,
      version: 1,
      sessionId: current.sessionId,
      runId: current.runId,
      updatedAt: patch.updatedAt ?? new Date().toISOString(),
    }
    await writeSession(next)
    return next
  }

  async appendTranscript(entry: TranscriptEntry): Promise<void> {
    const session = await this.get(entry.sessionId)
    if (!session) throw new Error(`Session not found: ${entry.sessionId}`)
    await appendJsonLine(session.transcriptPath, entry)
  }

  async appendEvent(event: KernelEvent): Promise<void> {
    const session = await this.get(event.sessionId)
    if (!session) throw new Error(`Session not found: ${event.sessionId}`)
    await appendJsonLine(session.eventsPath, event)
  }

  async writeWorkflowSnapshot(sessionId: string, workflowState: unknown): Promise<void> {
    const session = await this.get(sessionId)
    if (!session) throw new Error(`Session not found: ${sessionId}`)
    await mkdir(dirname(session.workflowPath), { recursive: true })
    await writeFile(
      session.workflowPath,
      `${JSON.stringify({
        version: 1,
        sessionId: session.sessionId,
        runId: session.runId,
        updatedAt: new Date().toISOString(),
        workflowState,
      }, null, 2)}\n`,
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
}

function createSessionId(now: string): string {
  const stamp = now.replace(/[:.]/g, '-').replace(/[^\dTZ-]/g, '').slice(0, 19)
  return `session_${stamp}_${randomUUID().slice(0, 8)}`
}

async function writeSession(session: AgentSession): Promise<void> {
  await mkdir(session.outputDir, { recursive: true })
  await writeFile(join(session.outputDir, 'session.json'), `${JSON.stringify(session, null, 2)}\n`, 'utf8')
}
