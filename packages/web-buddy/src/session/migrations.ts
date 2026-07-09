import type { AgentSession, TranscriptEntry } from './session-types.js'

export function migrateAgentSession(value: unknown): AgentSession {
  if (!isRecord(value)) throw new Error('Invalid session file: expected object')
  const version = value.version ?? 1
  if (version !== 1) throw new Error(`Unsupported session version: ${String(version)}`)
  return { ...value, version: 1 } as AgentSession
}

export function migrateTranscriptEntry(value: unknown): TranscriptEntry {
  if (!isRecord(value)) throw new Error('Invalid transcript entry: expected object')
  const version = value.version ?? 1
  if (version !== 1) throw new Error(`Unsupported transcript entry version: ${String(version)}`)
  return { ...value, version: 1 } as TranscriptEntry
}

export function migrateTranscriptEntries(values: unknown[]): TranscriptEntry[] {
  return values.map(migrateTranscriptEntry)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
