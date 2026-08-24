import type { KernelEvent } from '../kernel/kernel-events.js'
import type {
  AgentSession,
  AgentSessionStatus,
  SessionStore,
  TranscriptEntry,
} from './session-types.js'
import { createTranscriptEntryId } from './transcript.js'

type EventInput = Omit<KernelEvent, 'version' | 'sessionId' | 'runId' | 'ts'>
type TranscriptInput = DistributiveOmit<TranscriptEntry, 'version' | 'sessionId' | 'runId' | 'entryId' | 'ts'>
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, Extract<keyof T, K>> : never

export interface SessionRecorder {
  readonly session: AgentSession
  readonly durability: 'durable' | 'none'
  event(event: EventInput): Promise<void>
  transcript(entry: TranscriptInput): Promise<void>
  /** Bypasses best-effort swallowing for effects that must be durable before acknowledgement. */
  transcriptDurably(entry: TranscriptInput): Promise<void>
  workflow(workflowState: unknown): Promise<void>
  updateStatus(status: AgentSessionStatus, patch?: Partial<AgentSession>): Promise<void>
}

export interface FileSessionRecorderOptions {
  bestEffort?: boolean
  warn?: (message: string) => void
}

export class FileSessionRecorder implements SessionRecorder {
  readonly durability = 'durable' as const
  session: AgentSession
  private readonly bestEffort: boolean
  private readonly warn?: (message: string) => void

  constructor(
    private readonly store: SessionStore,
    session: AgentSession,
    options: FileSessionRecorderOptions = {},
  ) {
    this.session = session
    this.bestEffort = options.bestEffort ?? false
    this.warn = options.warn
  }

  async event(event: EventInput): Promise<void> {
    await this.run('event', async () => {
      await this.store.appendEvent({
        version: 1,
        sessionId: this.session.sessionId,
        runId: this.session.runId,
        ts: new Date().toISOString(),
        ...event,
      })
    })
  }

  async transcript(entry: TranscriptInput): Promise<void> {
    await this.run('transcript', async () => {
      await this.appendTranscript(entry)
    })
  }

  async transcriptDurably(entry: TranscriptInput): Promise<void> {
    await this.appendTranscript(entry)
  }

  async workflow(workflowState: unknown): Promise<void> {
    await this.run('workflow', async () => {
      await this.store.writeWorkflowSnapshot(this.session.sessionId, workflowState)
    })
  }

  async updateStatus(status: AgentSessionStatus, patch: Partial<AgentSession> = {}): Promise<void> {
    await this.run('status', async () => {
      const now = new Date().toISOString()
      this.session = await this.store.update(this.session.sessionId, {
        ...patch,
        status,
        updatedAt: patch.updatedAt ?? now,
        ...(isTerminalStatus(status) && !patch.completedAt ? { completedAt: now } : {}),
      })
    })
  }

  private async run(label: string, operation: () => Promise<void>): Promise<void> {
    try {
      await operation()
    } catch (error) {
      if (!this.bestEffort) throw error
      this.warn?.(`Session recorder ${label} write failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private async appendTranscript(entry: TranscriptInput): Promise<void> {
    await this.store.appendTranscript({
      version: 1,
      sessionId: this.session.sessionId,
      runId: this.session.runId,
      entryId: createTranscriptEntryId(entry.type),
      ts: new Date().toISOString(),
      ...entry,
    } as TranscriptEntry)
  }
}

export class NoopSessionRecorder implements SessionRecorder {
  readonly durability = 'none' as const
  readonly session: AgentSession = {
    version: 1,
    sessionId: 'noop',
    runId: 'noop',
    source: 'test',
    status: 'created',
    goal: '',
    createdAt: '',
    updatedAt: '',
    outputDir: '',
    transcriptPath: '',
    eventsPath: '',
    workflowPath: '',
  }

  async event(): Promise<void> {}
  async transcript(): Promise<void> {}
  async transcriptDurably(): Promise<void> {}
  async workflow(): Promise<void> {}
  async updateStatus(): Promise<void> {}
}

function isTerminalStatus(status: AgentSessionStatus): boolean {
  return status === 'completed' || status === 'blocked' || status === 'failed' || status === 'aborted'
}
