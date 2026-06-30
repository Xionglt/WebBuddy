import { randomUUID } from 'node:crypto'
import type { WorkflowEvidence } from './workflow-evidence.js'
import type { WorkflowPhase } from './workflow-state.js'

export interface UserConfirmationInput {
  sessionId: string
  runId: string
  confirmedBy: 'user'
  message: string
  scope: 'completion'
  workflowPhase?: WorkflowPhase | string
  turnId?: string
  ts?: string
  metadata?: Record<string, unknown>
}

export interface UserConfirmation {
  schemaVersion: 'user-confirmation/v1'
  id: string
  sessionId: string
  runId: string
  confirmedBy: 'user'
  scope: 'completion'
  message: string
  ts: string
  workflowPhase?: WorkflowPhase | string
  turnId?: string
  metadata?: Record<string, unknown>
  evidence: WorkflowEvidence
}

const MAX_SUMMARY_MESSAGE_LENGTH = 240

export function createUserConfirmation(input: UserConfirmationInput): UserConfirmation {
  assertUserConfirmationInput(input)

  const ts = input.ts ?? new Date().toISOString()
  const id = `user_confirmation_${randomUUID()}`
  const message = input.message.trim()
  const messageSummary = summarizeConfirmationMessage(message)
  const metadata = input.metadata ? cloneRecord(input.metadata) : undefined

  const evidence: WorkflowEvidence = {
    schemaVersion: 'workflow-evidence/v1',
    id: `evid_user_confirm_${randomUUID()}`,
    kind: 'user_confirm',
    summary: messageSummary,
    source: 'user_confirmation',
    confidence: 'high',
    ts,
    ...(input.workflowPhase ? { phase: input.workflowPhase } : {}),
    sessionId: input.sessionId,
    runId: input.runId,
    ...(input.turnId ? { turnId: input.turnId } : {}),
    data: {
      confirmationId: id,
      confirmedBy: 'user',
      scope: 'completion',
      messageSummary,
    },
    ...(metadata ? { metadata: cloneRecord(metadata) } : {}),
  }

  return {
    schemaVersion: 'user-confirmation/v1',
    id,
    sessionId: input.sessionId,
    runId: input.runId,
    confirmedBy: 'user',
    scope: 'completion',
    message,
    ts,
    ...(input.workflowPhase ? { workflowPhase: input.workflowPhase } : {}),
    ...(input.turnId ? { turnId: input.turnId } : {}),
    ...(metadata ? { metadata } : {}),
    evidence,
  }
}

function assertUserConfirmationInput(input: UserConfirmationInput): void {
  if (!input || typeof input !== 'object') {
    throw new Error('User confirmation input is required.')
  }

  assertNonEmptyString(input.sessionId, 'sessionId')
  assertNonEmptyString(input.runId, 'runId')
  assertNonEmptyString(input.message, 'message')

  if (input.confirmedBy !== 'user') {
    throw new Error('User confirmation must be explicitly confirmed by user.')
  }

  if (input.scope !== 'completion') {
    throw new Error('User confirmation scope must be completion.')
  }
}

function assertNonEmptyString(value: unknown, label: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`User confirmation ${label} must be a non-empty string.`)
  }
}

function summarizeConfirmationMessage(message: string): string {
  const normalized = message.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (normalized.length <= MAX_SUMMARY_MESSAGE_LENGTH) return normalized
  return `${normalized.slice(0, MAX_SUMMARY_MESSAGE_LENGTH - 3).trimEnd()}...`
}

function cloneRecord(record: Record<string, unknown>): Record<string, unknown> {
  const clone: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(record)) {
    clone[key] = cloneValue(value)
  }
  return clone
}

function cloneValue(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(cloneValue)

  const clone: Record<string, unknown> = {}
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    clone[key] = cloneValue(nested)
  }
  return clone
}
