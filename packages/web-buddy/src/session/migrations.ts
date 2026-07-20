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
  if (version !== 1) {
    throw new Error(`UNSUPPORTED_SESSION_VERSION: ${String(version)}`)
  }
  const migrated = { ...value, version: 1 }
  validateAgentSessionV1(migrated)
  return { value: migrated as AgentSession, warnings: [] }
}

export function migrateTranscriptEntry(value: unknown): TranscriptEntry {
  return migrateTranscriptEntryWithWarnings(value).value
}

export function migrateTranscriptEntryWithWarnings(value: unknown): MigrationResult<TranscriptEntry> {
  if (!isRecord(value)) throw new Error('Invalid transcript entry: expected object')
  const version = value.version ?? 1
  if (version !== 1) {
    throw new Error(`UNSUPPORTED_TRANSCRIPT_ENTRY_VERSION: ${String(version)}`)
  }
  const migrated = { ...value, version: 1 }
  validateTranscriptEntryV1(migrated)
  return { value: migrated as TranscriptEntry, warnings: [] }
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

function validateAgentSessionV1(
  value: Record<string, unknown> & { version: number },
): void {
  for (const field of [
    'sessionId',
    'runId',
    'source',
    'status',
    'goal',
    'createdAt',
    'updatedAt',
    'outputDir',
    'transcriptPath',
    'eventsPath',
    'workflowPath',
  ]) {
    if (typeof value[field] !== 'string' || value[field].length === 0) {
      throw new Error(`INVALID_SESSION_V1: ${field} must be a non-empty string`)
    }
  }
  if (!['cli', 'web', 'sdk', 'benchmark', 'test'].includes(value.source as string)) {
    throw new Error(`INVALID_SESSION_V1: unsupported source ${String(value.source)}`)
  }
  if (!['created', 'running', 'blocked', 'completed', 'failed', 'aborted'].includes(value.status as string)) {
    throw new Error(`INVALID_SESSION_V1: unsupported status ${String(value.status)}`)
  }
}

function validateTranscriptEntryV1(value: Record<string, unknown> & { version: number }): void {
  for (const field of ['sessionId', 'runId', 'entryId', 'ts', 'type']) {
    if (typeof value[field] !== 'string' || value[field].length === 0) {
      throw new Error(`INVALID_TRANSCRIPT_ENTRY_V1: ${field} must be a non-empty string`)
    }
  }
  if (!TRANSCRIPT_ENTRY_TYPES.has(value.type as string)) {
    throw new Error(`INVALID_TRANSCRIPT_ENTRY_V1: unsupported type ${String(value.type)}`)
  }
}

const TRANSCRIPT_ENTRY_TYPES = new Set([
  'user_message',
  'assistant_message',
  'tool_call',
  'tool_result',
  'policy_decision',
  'permission_decision',
  'approval_request',
  'approval_decision',
  'skill_context',
  'workflow_snapshot',
  'memory_snapshot',
  'workflow_evidence',
  'user_confirmation',
  'user_answer',
  'workflow_evaluation',
  'completion_gate',
  'context_compaction',
  'async_task_notification_attachment',
  'final_result',
  'error',
])
