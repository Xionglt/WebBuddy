import type { AgentSession, TranscriptEntry } from './session-types.js'

export interface MigrationWarning {
  code: 'unknown_session_version' | 'unknown_transcript_entry_version'
  message: string
  version: unknown
  entryId?: string
  type?: string
}

export interface MigrationResult<T> {
  value: T
  warnings: MigrationWarning[]
}

export function migrateAgentSession(value: unknown): AgentSession {
  return migrateAgentSessionWithWarnings(value).value
}

export function migrateAgentSessionWithWarnings(value: unknown): MigrationResult<AgentSession> {
  if (!isRecord(value)) throw new Error('Invalid session file: expected object')
  const version = value.version ?? 1
  const warnings: MigrationWarning[] = []
  if (version !== 1) {
    warnings.push({
      code: 'unknown_session_version',
      message: `Unknown session version ${String(version)}; interpreting as v1-compatible for restore.`,
      version,
      ...(typeof value.sessionId === 'string' ? { entryId: value.sessionId } : {}),
    })
  }
  return { value: { ...value, version: 1 } as AgentSession, warnings }
}

export function migrateTranscriptEntry(value: unknown): TranscriptEntry {
  return migrateTranscriptEntryWithWarnings(value).value
}

export function migrateTranscriptEntryWithWarnings(value: unknown): MigrationResult<TranscriptEntry> {
  if (!isRecord(value)) throw new Error('Invalid transcript entry: expected object')
  const version = value.version ?? 1
  const warnings: MigrationWarning[] = []
  if (version !== 1) {
    warnings.push({
      code: 'unknown_transcript_entry_version',
      message: `Unknown transcript entry version ${String(version)}; interpreting as v1-compatible for restore.`,
      version,
      ...(typeof value.entryId === 'string' ? { entryId: value.entryId } : {}),
      ...(typeof value.type === 'string' ? { type: value.type } : {}),
    })
  }
  return { value: { ...value, version: 1 } as TranscriptEntry, warnings }
}

export function migrateTranscriptEntries(values: unknown[]): TranscriptEntry[] {
  return migrateTranscriptEntriesWithWarnings(values).value
}

export function migrateTranscriptEntriesWithWarnings(values: unknown[]): MigrationResult<TranscriptEntry[]> {
  const entries: TranscriptEntry[] = []
  const warnings: MigrationWarning[] = []
  for (const value of values) {
    const result = migrateTranscriptEntryWithWarnings(value)
    entries.push(result.value)
    warnings.push(...result.warnings)
  }
  return { value: entries, warnings }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
