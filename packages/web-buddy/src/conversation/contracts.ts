import type { OwnerScope } from '../task/contracts.js'

export const CONVERSATION_RECORD_SCHEMA_VERSION = 'conversation-record/v1' as const
export const CONVERSATION_TURN_RECORD_SCHEMA_VERSION = 'conversation-turn-record/v1' as const
export const MAX_CONVERSATION_TEXT_BYTES = 8 * 1024
export const MAX_CONVERSATION_TURNS = 100

export interface ConversationTurnRecord {
  schemaVersion: typeof CONVERSATION_TURN_RECORD_SCHEMA_VERSION
  turnId: string
  sequence: number
  userMessage: string
  runId: string
  idempotencyKey: string
  requestDigest: string
  createdAt: string
}

export interface ConversationRecord {
  schemaVersion: typeof CONVERSATION_RECORD_SCHEMA_VERSION
  conversationId: string
  goal: string
  startUrl: string
  headless: boolean
  ownerScope?: OwnerScope
  recordRevision: number
  turns: ConversationTurnRecord[]
  createIdempotencyKey: string
  createRequestDigest: string
  createdAt: string
  updatedAt: string
}

export interface ConversationCreateInput {
  conversationId: string
  goal: string
  startUrl: string
  headless: boolean
  ownerScope?: OwnerScope
  idempotencyKey: string
  createdAt: string
}

export interface ConversationAppendTurnInput {
  conversationId: string
  turnId: string
  userMessage: string
  expectedRecordRevision: number
  ownerScope?: OwnerScope
  idempotencyKey: string
  createdAt: string
}

export type ConversationStoreErrorCode =
  | 'CONVERSATION_NOT_FOUND'
  | 'CONVERSATION_ALREADY_EXISTS'
  | 'REVISION_CONFLICT'
  | 'IDEMPOTENCY_CONFLICT'
  | 'INVALID_RECORD'
  | 'CONVERSATION_LIMIT_EXCEEDED'

export class ConversationStoreError extends Error {
  constructor(readonly code: ConversationStoreErrorCode, message: string) {
    super(message)
    this.name = 'ConversationStoreError'
  }
}

export function validateConversationText(value: unknown, path: string): asserts value is string {
  boundedText(value, path)
}

export function decodeConversationRecord(value: unknown): ConversationRecord {
  const record = object(value, 'Conversation record')
  exactKeys(record, [
    'schemaVersion',
    'conversationId',
    'goal',
    'startUrl',
    'headless',
    'ownerScope',
    'recordRevision',
    'turns',
    'createIdempotencyKey',
    'createRequestDigest',
    'createdAt',
    'updatedAt',
  ], 'Conversation record')
  if (record.schemaVersion !== CONVERSATION_RECORD_SCHEMA_VERSION) invalid('Unsupported Conversation record schema.')
  nonEmpty(record.conversationId, 'conversationId')
  boundedText(record.goal, 'goal')
  absoluteHttpUrl(record.startUrl, 'startUrl')
  if (typeof record.headless !== 'boolean') invalid('headless must be a boolean.')
  if (record.ownerScope !== undefined) validateOwnerScope(record.ownerScope)
  nonNegativeInteger(record.recordRevision, 'recordRevision')
  if (!Array.isArray(record.turns) || record.turns.length > MAX_CONVERSATION_TURNS) {
    invalid(`turns must contain at most ${MAX_CONVERSATION_TURNS} items.`)
  }
  const turns = record.turns.map(decodeConversationTurn)
  if (record.recordRevision !== turns.length) invalid('recordRevision must equal the persisted Turn count.')
  for (let index = 0; index < turns.length; index += 1) {
    if (turns[index].sequence !== index + 1) invalid('Turn sequence must be contiguous and one-based.')
  }
  unique(turns.map((turn) => turn.turnId), 'turnId')
  unique(turns.map((turn) => turn.idempotencyKey), 'Turn idempotency key')
  nonEmpty(record.createIdempotencyKey, 'createIdempotencyKey')
  digest(record.createRequestDigest, 'createRequestDigest')
  timestamp(record.createdAt, 'createdAt')
  timestamp(record.updatedAt, 'updatedAt')
  return structuredClone(record) as unknown as ConversationRecord
}

function decodeConversationTurn(value: unknown): ConversationTurnRecord {
  const turn = object(value, 'Conversation Turn')
  exactKeys(turn, [
    'schemaVersion',
    'turnId',
    'sequence',
    'userMessage',
    'runId',
    'idempotencyKey',
    'requestDigest',
    'createdAt',
  ], 'Conversation Turn')
  if (turn.schemaVersion !== CONVERSATION_TURN_RECORD_SCHEMA_VERSION) invalid('Unsupported Conversation Turn schema.')
  nonEmpty(turn.turnId, 'turnId')
  positiveInteger(turn.sequence, 'sequence')
  boundedText(turn.userMessage, 'userMessage')
  nonEmpty(turn.runId, 'runId')
  nonEmpty(turn.idempotencyKey, 'idempotencyKey')
  digest(turn.requestDigest, 'requestDigest')
  timestamp(turn.createdAt, 'createdAt')
  return structuredClone(turn) as unknown as ConversationTurnRecord
}

function validateOwnerScope(value: unknown): void {
  const scope = object(value, 'ownerScope')
  exactKeys(scope, ['schemaVersion', 'tenantId', 'userId', 'projectId'], 'ownerScope')
  if (scope.schemaVersion !== 'owner-scope/v1') invalid('Unsupported ownerScope schema.')
  if (![scope.tenantId, scope.userId, scope.projectId].some((item) => typeof item === 'string' && item.trim())) {
    invalid('ownerScope must identify at least one tenant, user or project.')
  }
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`${path} must be an object.`)
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  const allowedKeys = new Set(allowed)
  const unknown = Object.keys(value).filter((key) => !allowedKeys.has(key))
  if (unknown.length) invalid(`${path} contains unsupported field(s): ${unknown.sort().join(', ')}.`)
}

function nonEmpty(value: unknown, path: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) invalid(`${path} must be a non-empty string.`)
}

function boundedText(value: unknown, path: string): asserts value is string {
  nonEmpty(value, path)
  if (Buffer.byteLength(value, 'utf8') > MAX_CONVERSATION_TEXT_BYTES) {
    invalid(`${path} exceeds the ${MAX_CONVERSATION_TEXT_BYTES} byte limit.`)
  }
}

function absoluteHttpUrl(value: unknown, path: string): void {
  nonEmpty(value, path)
  let parsed: URL
  try { parsed = new URL(value) } catch { invalid(`${path} must be an absolute URL.`) }
  if (!['http:', 'https:'].includes(parsed!.protocol)) invalid(`${path} must use HTTP(S).`)
}

function nonNegativeInteger(value: unknown, path: string): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) invalid(`${path} must be a non-negative safe integer.`)
}

function positiveInteger(value: unknown, path: string): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) invalid(`${path} must be a positive safe integer.`)
}

function digest(value: unknown, path: string): asserts value is string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/i.test(value)) invalid(`${path} must be a SHA-256 digest.`)
}

function timestamp(value: unknown, path: string): asserts value is string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    invalid(`${path} must be a canonical UTC timestamp.`)
  }
}

function unique(values: string[], path: string): void {
  if (new Set(values).size !== values.length) invalid(`Duplicate ${path}.`)
}

function invalid(message: string): never {
  throw new ConversationStoreError('INVALID_RECORD', message)
}
