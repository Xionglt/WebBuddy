import type { JsonObject, JsonValue } from './contracts.js'
import { redactSensitiveData } from '../security/redaction.js'
import { PublicContractError } from './task.js'

export const SERVICE_SCOPE_SCHEMA_VERSION = 'service-scope/v1' as const
export const SERVICE_STORE_QUERY_SCHEMA_VERSION = 'service-store-query/v1' as const
export const QUOTA_LIMIT_SCHEMA_VERSION = 'quota-limit/v1' as const
export const QUOTA_USAGE_SCHEMA_VERSION = 'quota-usage/v1' as const
export const QUOTA_DECISION_SCHEMA_VERSION = 'quota-decision/v1' as const
export const AUDIT_ACTOR_SCHEMA_VERSION = 'audit-actor/v1' as const
export const AUDIT_EVENT_SCHEMA_VERSION = 'audit-event/v1' as const

export type ServiceScope =
  | {
      schemaVersion: typeof SERVICE_SCOPE_SCHEMA_VERSION
      kind: 'local'
    }
  | {
      schemaVersion: typeof SERVICE_SCOPE_SCHEMA_VERSION
      kind: 'tenant'
      tenantId: string
      userId: string
    }

export interface ServiceStoreQuery {
  schemaVersion: typeof SERVICE_STORE_QUERY_SCHEMA_VERSION
  scope: ServiceScope
  resourceKind: 'run' | 'approval' | 'artifact' | 'trace' | 'memory' | 'audit'
  resourceId?: string
  cursor?: string
  limit?: number
}

export type QuotaDimension =
  | 'concurrent_runs'
  | 'runs_per_window'
  | 'runtime_ms_per_window'
  | 'storage_bytes'

export interface QuotaLimit {
  schemaVersion: typeof QUOTA_LIMIT_SCHEMA_VERSION
  scope: ServiceScope
  dimension: QuotaDimension
  maximum: number
  windowMs?: number
}

export interface QuotaUsage {
  schemaVersion: typeof QUOTA_USAGE_SCHEMA_VERSION
  scope: ServiceScope
  dimension: QuotaDimension
  used: number
  reserved: number
  measuredAt: string
  windowStartedAt?: string
}

export interface QuotaDecision {
  schemaVersion: typeof QUOTA_DECISION_SCHEMA_VERSION
  scope: ServiceScope
  dimension: QuotaDimension
  decision: 'allow' | 'deny'
  limit: number
  projected: number
  reasonCode: 'within_limit' | 'quota_exceeded' | 'scope_mismatch' | 'invalid_usage'
  evaluatedAt: string
}

export interface AuditActor {
  schemaVersion: typeof AUDIT_ACTOR_SCHEMA_VERSION
  actorId: string
  scope: ServiceScope
  authentication: 'local' | 'api_token' | 'bearer'
}

export type AuditAction =
  | 'run.create'
  | 'run.pause'
  | 'run.resume'
  | 'run.cancel'
  | 'approval.resolve'
  | 'artifact.read'
  | 'trace.read'
  | 'memory.read'
  | 'memory.write'
  | 'quota.deny'
  | 'auth.deny'

export interface AuditTarget {
  kind: 'run' | 'approval' | 'artifact' | 'trace' | 'memory' | 'quota' | 'api'
  id?: string
}

export interface AuditEvent {
  schemaVersion: typeof AUDIT_EVENT_SCHEMA_VERSION
  eventId: string
  requestId: string
  actor: AuditActor
  action: AuditAction
  target: AuditTarget
  occurredAt: string
  result: 'succeeded' | 'denied' | 'failed'
  reasonCode?: string
  redaction: 'not_required' | 'redacted'
  metadata?: JsonObject
}

export function validateServiceScope(value: unknown): ServiceScope {
  const scope = object(value, 'ServiceScope')
  if (scope.schemaVersion !== SERVICE_SCOPE_SCHEMA_VERSION) unsupported('ServiceScope')
  if (scope.kind === 'local') {
    closed(scope, ['schemaVersion', 'kind'], 'ServiceScope')
    return Object.freeze({
      schemaVersion: SERVICE_SCOPE_SCHEMA_VERSION,
      kind: 'local',
    })
  }
  if (scope.kind === 'tenant') {
    closed(scope, ['schemaVersion', 'kind', 'tenantId', 'userId'], 'ServiceScope')
    return Object.freeze({
      schemaVersion: SERVICE_SCOPE_SCHEMA_VERSION,
      kind: 'tenant',
      tenantId: id(scope.tenantId, 'tenantId'),
      userId: id(scope.userId, 'userId'),
    })
  }
  invalid('ServiceScope.kind must be local or tenant; omitted scope is never a wildcard.')
}

export function serviceScopeKey(scopeValue: ServiceScope): string {
  const scope = validateServiceScope(scopeValue)
  return scope.kind === 'local'
    ? 'local'
    : `tenant:${encodeURIComponent(scope.tenantId)}:user:${encodeURIComponent(scope.userId)}`
}

export function validateServiceStoreQuery(value: unknown): ServiceStoreQuery {
  const query = object(value, 'ServiceStoreQuery')
  closed(query, [
    'schemaVersion',
    'scope',
    'resourceKind',
    'resourceId',
    'cursor',
    'limit',
  ], 'ServiceStoreQuery')
  if (query.schemaVersion !== SERVICE_STORE_QUERY_SCHEMA_VERSION) unsupported('ServiceStoreQuery')
  if (!STORE_RESOURCE_KINDS.has(String(query.resourceKind))) invalid('ServiceStoreQuery.resourceKind is invalid.')
  const limit = query.limit === undefined ? undefined : positive(query.limit, 'ServiceStoreQuery.limit')
  if (limit !== undefined && limit > 1_000) invalid('ServiceStoreQuery.limit must not exceed 1000.')
  return {
    schemaVersion: SERVICE_STORE_QUERY_SCHEMA_VERSION,
    scope: validateServiceScope(query.scope),
    resourceKind: query.resourceKind as ServiceStoreQuery['resourceKind'],
    ...(query.resourceId === undefined ? {} : { resourceId: id(query.resourceId, 'resourceId') }),
    ...(query.cursor === undefined ? {} : { cursor: id(query.cursor, 'cursor') }),
    ...(limit === undefined ? {} : { limit }),
  }
}

export function assertServiceScopeAccess(actorValue: ServiceScope, targetValue: ServiceScope): void {
  const actor = validateServiceScope(actorValue)
  const target = validateServiceScope(targetValue)
  if (serviceScopeKey(actor) !== serviceScopeKey(target)) {
    throw new PublicContractError('SCOPE_MISMATCH', 'Actor scope cannot access the target scope.')
  }
}

export function evaluateQuota(
  limitValue: QuotaLimit,
  usageValue: QuotaUsage,
  requested: number,
  now = new Date(),
): QuotaDecision {
  const limit = validateQuotaLimit(limitValue)
  const usage = validateQuotaUsage(usageValue)
  assertServiceScopeAccess(limit.scope, usage.scope)
  if (limit.dimension !== usage.dimension) invalid('Quota dimension mismatch.')
  if (!Number.isSafeInteger(requested) || requested < 0) invalid('Requested quota must be a non-negative safe integer.')
  const projected = usage.used + usage.reserved + requested
  return Object.freeze({
    schemaVersion: QUOTA_DECISION_SCHEMA_VERSION,
    scope: limit.scope,
    dimension: limit.dimension,
    decision: projected <= limit.maximum ? 'allow' : 'deny',
    limit: limit.maximum,
    projected,
    reasonCode: projected <= limit.maximum ? 'within_limit' : 'quota_exceeded',
    evaluatedAt: now.toISOString(),
  })
}

export function validateAuditEvent(value: unknown): AuditEvent {
  const event = object(value, 'AuditEvent')
  closed(event, [
    'schemaVersion',
    'eventId',
    'requestId',
    'actor',
    'action',
    'target',
    'occurredAt',
    'result',
    'reasonCode',
    'redaction',
    'metadata',
  ], 'AuditEvent')
  if (event.schemaVersion !== AUDIT_EVENT_SCHEMA_VERSION) unsupported('AuditEvent')
  const actor = validateAuditActor(event.actor)
  const target = validateAuditTarget(event.target)
  if (!AUDIT_ACTIONS.has(String(event.action))) invalid('AuditEvent.action is invalid.')
  if (event.result !== 'succeeded' && event.result !== 'denied' && event.result !== 'failed') {
    invalid('AuditEvent.result is invalid.')
  }
  if (event.redaction !== 'not_required' && event.redaction !== 'redacted') invalid('AuditEvent.redaction is invalid.')
  const metadata = event.metadata === undefined
    ? undefined
    : safeAuditMetadata(event.metadata)
  const validated = {
    schemaVersion: AUDIT_EVENT_SCHEMA_VERSION,
    eventId: id(event.eventId, 'eventId'),
    requestId: id(event.requestId, 'requestId'),
    actor,
    action: event.action as AuditAction,
    target,
    occurredAt: timestamp(event.occurredAt, 'occurredAt'),
    result: event.result,
    ...(event.reasonCode === undefined ? {} : { reasonCode: id(event.reasonCode, 'reasonCode') }),
    redaction: event.redaction,
    ...(metadata === undefined ? {} : { metadata }),
  } satisfies AuditEvent
  rejectCredentialLike(validated, 'AuditEvent')
  return deepFreeze(validated)
}

function validateQuotaLimit(value: unknown): QuotaLimit {
  const limit = object(value, 'QuotaLimit')
  closed(limit, ['schemaVersion', 'scope', 'dimension', 'maximum', 'windowMs'], 'QuotaLimit')
  if (limit.schemaVersion !== QUOTA_LIMIT_SCHEMA_VERSION) unsupported('QuotaLimit')
  if (!QUOTA_DIMENSIONS.has(String(limit.dimension))) invalid('QuotaLimit.dimension is invalid.')
  const maximum = nonNegative(limit.maximum, 'QuotaLimit.maximum')
  const windowMs = limit.windowMs === undefined ? undefined : positive(limit.windowMs, 'QuotaLimit.windowMs')
  if (limit.dimension !== 'concurrent_runs' && limit.dimension !== 'storage_bytes' && windowMs === undefined) {
    invalid('Windowed quota requires windowMs.')
  }
  return {
    schemaVersion: QUOTA_LIMIT_SCHEMA_VERSION,
    scope: validateServiceScope(limit.scope),
    dimension: limit.dimension as QuotaDimension,
    maximum,
    ...(windowMs === undefined ? {} : { windowMs }),
  }
}

function validateQuotaUsage(value: unknown): QuotaUsage {
  const usage = object(value, 'QuotaUsage')
  closed(usage, [
    'schemaVersion',
    'scope',
    'dimension',
    'used',
    'reserved',
    'measuredAt',
    'windowStartedAt',
  ], 'QuotaUsage')
  if (usage.schemaVersion !== QUOTA_USAGE_SCHEMA_VERSION) unsupported('QuotaUsage')
  if (!QUOTA_DIMENSIONS.has(String(usage.dimension))) invalid('QuotaUsage.dimension is invalid.')
  return {
    schemaVersion: QUOTA_USAGE_SCHEMA_VERSION,
    scope: validateServiceScope(usage.scope),
    dimension: usage.dimension as QuotaDimension,
    used: nonNegative(usage.used, 'QuotaUsage.used'),
    reserved: nonNegative(usage.reserved, 'QuotaUsage.reserved'),
    measuredAt: timestamp(usage.measuredAt, 'QuotaUsage.measuredAt'),
    ...(usage.windowStartedAt === undefined
      ? {}
      : { windowStartedAt: timestamp(usage.windowStartedAt, 'QuotaUsage.windowStartedAt') }),
  }
}

function validateAuditActor(value: unknown): AuditActor {
  const actor = object(value, 'AuditActor')
  closed(actor, ['schemaVersion', 'actorId', 'scope', 'authentication'], 'AuditActor')
  if (actor.schemaVersion !== AUDIT_ACTOR_SCHEMA_VERSION) unsupported('AuditActor')
  if (actor.authentication !== 'local' && actor.authentication !== 'api_token' && actor.authentication !== 'bearer') {
    invalid('AuditActor.authentication is invalid.')
  }
  return {
    schemaVersion: AUDIT_ACTOR_SCHEMA_VERSION,
    actorId: id(actor.actorId, 'actorId'),
    scope: validateServiceScope(actor.scope),
    authentication: actor.authentication,
  }
}

function validateAuditTarget(value: unknown): AuditTarget {
  const target = object(value, 'AuditTarget')
  closed(target, ['kind', 'id'], 'AuditTarget')
  if (!AUDIT_TARGETS.has(String(target.kind))) invalid('AuditTarget.kind is invalid.')
  return {
    kind: target.kind as AuditTarget['kind'],
    ...(target.id === undefined ? {} : { id: id(target.id, 'AuditTarget.id') }),
  }
}

function safeAuditMetadata(value: unknown): JsonObject {
  const metadata = jsonClone(value, 'AuditEvent.metadata')
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) invalid('AuditEvent.metadata must be a JSON object.')
  rejectSecretKeys(metadata, '$')
  return metadata as JsonObject
}

function rejectCredentialLike(value: unknown, label: string): void {
  if (redactSensitiveData(value).changed) {
    invalid(`${label} contains credential-like material.`)
  }
}

function rejectSecretKeys(value: JsonValue, path: string): void {
  if (Array.isArray(value)) {
    value.forEach((child, index) => rejectSecretKeys(child, `${path}[${index}]`))
    return
  }
  if (!value || typeof value !== 'object') return
  for (const [key, child] of Object.entries(value)) {
    if (/(?:token|secret|password|cookie|authorization|api[-_]?key|captcha|otp)/i.test(key)) {
      invalid(`AuditEvent.metadata contains secret-bearing key at ${path}.${key}.`)
    }
    rejectSecretKeys(child, `${path}.${key}`)
  }
}

const QUOTA_DIMENSIONS = new Set<string>([
  'concurrent_runs',
  'runs_per_window',
  'runtime_ms_per_window',
  'storage_bytes',
])
const AUDIT_ACTIONS = new Set<string>([
  'run.create',
  'run.pause',
  'run.resume',
  'run.cancel',
  'approval.resolve',
  'artifact.read',
  'trace.read',
  'memory.read',
  'memory.write',
  'quota.deny',
  'auth.deny',
])
const AUDIT_TARGETS = new Set<string>(['run', 'approval', 'artifact', 'trace', 'memory', 'quota', 'api'])
const STORE_RESOURCE_KINDS = new Set<string>(['run', 'approval', 'artifact', 'trace', 'memory', 'audit'])

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`${label} must be a plain object.`)
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) invalid(`${label} must be a plain object.`)
  return value as Record<string, unknown>
}

function closed(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const allowed = new Set(keys)
  for (const key of Object.keys(value)) if (!allowed.has(key)) invalid(`${label} contains unsupported field ${key}.`)
}

function id(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() !== value || value.length === 0 || value.length > 512) {
    invalid(`${label} must be a bounded non-empty string.`)
  }
  return value
}

function timestamp(value: unknown, label: string): string {
  const result = id(value, label)
  if (!Number.isFinite(Date.parse(result))) invalid(`${label} must be a timestamp.`)
  return result
}

function nonNegative(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) invalid(`${label} must be a non-negative safe integer.`)
  return value as number
}

function positive(value: unknown, label: string): number {
  const result = nonNegative(value, label)
  if (result === 0) invalid(`${label} must be positive.`)
  return result
}

function jsonClone(value: unknown, label: string): JsonValue {
  try {
    assertJsonSafe(value, label)
    const serialized = JSON.stringify(value)
    if (serialized === undefined) invalid(`${label} must be JSON-safe.`)
    return JSON.parse(serialized) as JsonValue
  } catch {
    invalid(`${label} must be JSON-safe.`)
  }
}

function assertJsonSafe(value: unknown, label: string, seen = new Set<object>()): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) invalid(`${label} contains a non-finite number.`)
    return
  }
  if (typeof value !== 'object') invalid(`${label} is not JSON-safe.`)
  if (seen.has(value)) invalid(`${label} contains a cycle.`)
  seen.add(value)
  if (Array.isArray(value)) {
    value.forEach((child, index) => assertJsonSafe(child, `${label}[${index}]`, seen))
  } else {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) invalid(`${label} contains a non-plain object.`)
    for (const [key, child] of Object.entries(value)) assertJsonSafe(child, `${label}.${key}`, seen)
  }
  seen.delete(value)
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}

function invalid(message: string): never {
  throw new PublicContractError('INVALID_CONTRACT', message)
}

function unsupported(label: string): never {
  throw new PublicContractError('UNSUPPORTED_SCHEMA_VERSION', `${label} schema version is not supported.`)
}
