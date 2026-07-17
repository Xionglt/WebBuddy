import { createHash } from 'node:crypto'
import type {
  ContentOrigin,
  ContentSensitivity,
  ContentTrust,
  JsonValue,
} from '../task/contracts.js'
import { redactSensitiveData } from '../security/redaction.js'
import type { MemoryScope } from './types.js'

export const MEMORY_ENTRY_SCHEMA_VERSION = 'memory-entry/v2' as const
export const MEMORY_WRITE_REQUEST_SCHEMA_VERSION = 'memory-write-request/v2' as const
export const MEMORY_WRITE_DECISION_SCHEMA_VERSION = 'memory-write-policy-decision/v1' as const

export type MemoryTransformKind =
  | 'direct'
  | 'redaction'
  | 'normalization'
  | 'summary'
  | 'embedding'
  | 'trace'

/**
 * Optional tenant/user identifiers are comparison fields, not a requirement
 * to deploy a multi-tenant store. runId remains the current authority fence.
 */
export interface MemoryActorScope {
  tenantId?: string
  userId?: string
  projectId?: string
  sessionId?: string
  runId: string
}

export interface MemoryTargetScope {
  kind: MemoryScope
  tenantId?: string
  userId?: string
  projectId?: string
  sessionId?: string
  runId?: string
}

export interface MemoryProvenance {
  contentId: string
  capturedAt: string
  parentContentIds: string[]
  tenantId?: string
  userId?: string
  projectId?: string
  sessionId?: string
  runId: string
}

/**
 * Source metadata is copied and deep-frozen into an accepted MemoryEntry.
 * A derived source must name all of its direct parents through provenance.
 */
export interface MemoryDerivedFrom {
  contentId: string
  origin: ContentOrigin
  trust: ContentTrust
  sensitivity: ContentSensitivity
  provenance: MemoryProvenance
}

export interface MemoryTransformStep {
  kind: MemoryTransformKind
  inputContentIds: string[]
  outputContentId: string
}

export interface MemoryWriteSecurity {
  origin: ContentOrigin
  trust: ContentTrust
  sensitivity: ContentSensitivity
  provenance: MemoryProvenance
  derivedFrom: MemoryDerivedFrom[]
  transformChain: MemoryTransformStep[]
}

/**
 * Minimal B1 write input. TTL, confidence, conflicts, supersedes, revision,
 * retrieval and forget deliberately belong to B2 and are absent here.
 */
export interface MemoryWriteRequest {
  schemaVersion: typeof MEMORY_WRITE_REQUEST_SCHEMA_VERSION
  requestId: string
  actorScope: MemoryActorScope
  targetScope: MemoryTargetScope
  content: JsonValue
  security: MemoryWriteSecurity
}

/**
 * Immutable object passed to the underlying writer only after policy allow.
 */
export interface MemoryEntry {
  schemaVersion: typeof MEMORY_ENTRY_SCHEMA_VERSION
  entryId: string
  content: JsonValue
  contentHash: string
  scope: MemoryTargetScope
  trust: ContentTrust
  sensitivity: ContentSensitivity
  provenance: MemoryProvenance
  derivedFrom: MemoryDerivedFrom[]
  transformChain: MemoryTransformStep[]
  createdAt: string
}

export type MemoryWriteDenyCode =
  | 'invalid_request'
  | 'unsupported_schema_version'
  | 'actor_scope_mismatch'
  | 'target_scope_mismatch'
  | 'invalid_provenance'
  | 'incomplete_ancestry'
  | 'invalid_transform_chain'
  | 'trust_upgrade'
  | 'secret_ancestry'
  | 'sensitive_content_detected'
  | 'reusable_untrusted_source'
  | 'scope_violation'

export type MemoryWriteDecision =
  | {
      schemaVersion: typeof MEMORY_WRITE_DECISION_SCHEMA_VERSION
      action: 'allow'
      reasonCode: 'policy_satisfied'
      requestId: string
      entry: Readonly<MemoryEntry>
    }
  | {
      schemaVersion: typeof MEMORY_WRITE_DECISION_SCHEMA_VERSION
      action: 'deny'
      reasonCode: MemoryWriteDenyCode
      requestId?: string
      reason: string
    }

export interface MemoryWritePolicy {
  evaluate(request: unknown, actorScope: MemoryActorScope): MemoryWriteDecision
}

/**
 * The intentionally narrow B1 Store port. CRUD, retrieval, TTL, conflict
 * resolution and forget are not part of this unit.
 */
export interface MemoryEntryWriter {
  write(entry: Readonly<MemoryEntry>): void | Promise<void>
}

export interface PolicyEnforcedMemoryStore {
  put?(entry: Readonly<MemoryEntry>): unknown | Promise<unknown>
  write?(entry: Readonly<MemoryEntry>): unknown | Promise<unknown>
}

export interface PolicyEnforcedMemoryWriter {
  write(request: unknown): Promise<MemoryWriteDecision>
}

const ORIGINS = new Set<string>([
  'system',
  'user',
  'web',
  'tool',
  'download',
  'artifact',
  'memory',
  'subagent',
  'derived',
])
const TRUST_LEVELS = new Set<string>([
  'trusted_runtime',
  'user_authorized',
  'untrusted_external',
  'derived_untrusted',
  'non_authoritative',
])
const SENSITIVITY_LEVELS = new Set<string>([
  'public',
  'internal',
  'personal',
  'auth',
  'secret',
])
const SCOPES = new Set<string>(['run', 'session', 'project', 'user'])
const TRANSFORM_KINDS = new Set<string>([
  'direct',
  'redaction',
  'normalization',
  'summary',
  'embedding',
  'trace',
])
const REUSABLE_SCOPES = new Set<MemoryScope>(['project', 'user'])
const EXTERNAL_ORIGINS = new Set<ContentOrigin>(['web', 'download', 'tool', 'subagent'])
const DERIVED_ORIGINS = new Set<ContentOrigin>(['artifact', 'memory', 'derived'])
const SCOPE_KEYS = new Set(['tenantId', 'userId', 'projectId', 'sessionId', 'runId'])
const REQUEST_KEYS = new Set([
  'schemaVersion',
  'requestId',
  'actorScope',
  'targetScope',
  'content',
  'security',
])
const ACTOR_SCOPE_KEYS = new Set([...SCOPE_KEYS])
const TARGET_SCOPE_KEYS = new Set(['kind', ...SCOPE_KEYS])
const SECURITY_KEYS = new Set([
  'origin',
  'trust',
  'sensitivity',
  'provenance',
  'derivedFrom',
  'transformChain',
])
const PROVENANCE_KEYS = new Set(['contentId', 'capturedAt', 'parentContentIds', ...SCOPE_KEYS])
const DERIVED_FROM_KEYS = new Set(['contentId', 'origin', 'trust', 'sensitivity', 'provenance'])
const TRANSFORM_KEYS = new Set(['kind', 'inputContentIds', 'outputContentId'])
const SENSITIVITY_RANK: Record<ContentSensitivity, number> = {
  public: 0,
  internal: 1,
  personal: 2,
  auth: 3,
  secret: 4,
}

class PolicyRejection extends Error {
  readonly code: MemoryWriteDenyCode

  constructor(code: MemoryWriteDenyCode, message: string) {
    super(message)
    this.name = 'PolicyRejection'
    this.code = code
  }
}

export function memoryContentHash(content: JsonValue): string {
  assertJsonSafe(content, 'content')
  return createHash('sha256').update(canonicalJson(content)).digest('hex')
}

/**
 * Invalid/unsupported input becomes a deny decision instead of throwing.
 */
export function evaluateMemoryWriteRequest(
  request: unknown,
  actorScope: MemoryActorScope,
): MemoryWriteDecision {
  let requestId: string | undefined
  try {
    const trustedActor = validateActorScope(actorScope, 'configured actorScope')
    const validated = validateRequest(request)
    requestId = validated.requestId
    if (!sameActorScope(validated.actorScope, trustedActor)) {
      throw new PolicyRejection('actor_scope_mismatch', 'Memory request actor scope does not match the writer.')
    }
    validateTargetScope(validated.targetScope, trustedActor)
    enforcePolicy(validated)
    return {
      schemaVersion: MEMORY_WRITE_DECISION_SCHEMA_VERSION,
      action: 'allow',
      reasonCode: 'policy_satisfied',
      requestId,
      entry: deepFreeze(materializeEntry(validated)),
    }
  } catch (error) {
    const rejection = error instanceof PolicyRejection
      ? error
      : new PolicyRejection('invalid_request', 'Memory write request failed closed.')
    return deny(rejection.code, rejection.message, requestId)
  }
}

export const DEFAULT_MEMORY_WRITE_POLICY: MemoryWritePolicy = Object.freeze({
  evaluate: evaluateMemoryWriteRequest,
})

/**
 * A denied decision returns before writer.write can be observed.
 */
export async function writeMemoryWithPolicy(
  writer: MemoryEntryWriter,
  request: unknown,
  actorScope: MemoryActorScope,
  policy: MemoryWritePolicy = DEFAULT_MEMORY_WRITE_POLICY,
): Promise<MemoryWriteDecision> {
  if (!writer || typeof writer.write !== 'function') {
    return deny('invalid_request', 'Memory writer is missing or invalid.')
  }
  if (!policy || typeof policy.evaluate !== 'function') {
    return deny('invalid_request', 'Memory write policy is missing or invalid.')
  }
  let decision: MemoryWriteDecision
  try {
    decision = policy.evaluate(request, actorScope)
  } catch {
    return deny('invalid_request', 'Memory write policy failed closed.')
  }
  if (decision.action !== 'allow') return decision
  await writer.write(decision.entry)
  return decision
}

/**
 * Minimal production factory consumed by the independent B1 security gate.
 */
export function createPolicyEnforcedMemoryWriter(input: {
  store: PolicyEnforcedMemoryStore
  actorScope: MemoryActorScope
  policy?: MemoryWritePolicy
}): PolicyEnforcedMemoryWriter {
  const actorScope = validateActorScope(input?.actorScope, 'configured actorScope')
  const store = input?.store
  const persist = typeof store?.put === 'function'
    ? store.put.bind(store)
    : typeof store?.write === 'function'
      ? store.write.bind(store)
      : undefined
  return Object.freeze({
    async write(request: unknown): Promise<MemoryWriteDecision> {
      if (!persist) return deny('invalid_request', 'Memory Store does not expose put or write.')
      return writeMemoryWithPolicy(
        { write: async (entry) => { await persist(entry) } },
        request,
        actorScope,
        input.policy ?? DEFAULT_MEMORY_WRITE_POLICY,
      )
    },
  })
}

function validateRequest(value: unknown): MemoryWriteRequest {
  const request = closedObject(value, REQUEST_KEYS, 'MemoryWriteRequest')
  if (request.schemaVersion !== MEMORY_WRITE_REQUEST_SCHEMA_VERSION) {
    throw new PolicyRejection('unsupported_schema_version', 'Unsupported MemoryWriteRequest schema version.')
  }
  const requestId = requiredId(request.requestId, 'requestId')
  assertJsonSafe(request.content, 'content')
  return {
    schemaVersion: MEMORY_WRITE_REQUEST_SCHEMA_VERSION,
    requestId,
    actorScope: validateActorScope(request.actorScope, 'actorScope'),
    targetScope: parseTargetScope(request.targetScope),
    content: clone(request.content as JsonValue),
    security: validateSecurity(request.security),
  }
}

function validateActorScope(value: unknown, label: string): MemoryActorScope {
  const scope = closedObject(value, ACTOR_SCOPE_KEYS, label)
  return {
    ...optionalScopeFields(scope, label),
    runId: requiredId(scope.runId, `${label}.runId`),
  }
}

function parseTargetScope(value: unknown): MemoryTargetScope {
  const scope = closedObject(value, TARGET_SCOPE_KEYS, 'targetScope')
  if (typeof scope.kind !== 'string' || !SCOPES.has(scope.kind)) {
    throw new PolicyRejection('target_scope_mismatch', 'Memory target scope kind is invalid.')
  }
  return {
    kind: scope.kind as MemoryScope,
    ...optionalScopeFields(scope, 'targetScope'),
  }
}

function validateSecurity(value: unknown): MemoryWriteSecurity {
  const security = closedObject(value, SECURITY_KEYS, 'security')
  if (!Array.isArray(security.derivedFrom) || security.derivedFrom.length === 0) {
    throw new PolicyRejection('incomplete_ancestry', 'Memory security requires derivedFrom ancestry.')
  }
  if (!Array.isArray(security.transformChain) || security.transformChain.length === 0) {
    throw new PolicyRejection('invalid_transform_chain', 'Memory security requires a transform chain.')
  }
  return {
    origin: requiredOrigin(security.origin, 'security.origin'),
    trust: requiredTrust(security.trust, 'security.trust'),
    sensitivity: requiredSensitivity(security.sensitivity, 'security.sensitivity'),
    provenance: validateProvenance(security.provenance, 'security.provenance'),
    derivedFrom: security.derivedFrom.map((item, index) => validateDerivedFrom(item, index)),
    transformChain: security.transformChain.map((item, index) => validateTransform(item, index)),
  }
}

function validateProvenance(value: unknown, label: string): MemoryProvenance {
  const provenance = closedObject(value, PROVENANCE_KEYS, label)
  if (!Array.isArray(provenance.parentContentIds) || provenance.parentContentIds.length > 256) {
    throw new PolicyRejection('invalid_provenance', `${label}.parentContentIds must be a bounded array.`)
  }
  const parentContentIds = provenance.parentContentIds.map(
    (item, index) => requiredId(item, `${label}.parentContentIds[${index}]`),
  )
  if (new Set(parentContentIds).size !== parentContentIds.length) {
    throw new PolicyRejection('invalid_provenance', `${label}.parentContentIds contains duplicates.`)
  }
  return {
    contentId: requiredId(provenance.contentId, `${label}.contentId`),
    capturedAt: requiredTimestamp(provenance.capturedAt, `${label}.capturedAt`),
    parentContentIds,
    ...optionalScopeFields(provenance, label),
    runId: requiredId(provenance.runId, `${label}.runId`),
  }
}

function validateDerivedFrom(value: unknown, index: number): MemoryDerivedFrom {
  const label = `security.derivedFrom[${index}]`
  const item = closedObject(value, DERIVED_FROM_KEYS, label)
  const contentId = requiredId(item.contentId, `${label}.contentId`)
  const provenance = validateProvenance(item.provenance, `${label}.provenance`)
  if (contentId !== provenance.contentId) {
    throw new PolicyRejection('invalid_provenance', `${label} does not match its provenance contentId.`)
  }
  return {
    contentId,
    origin: requiredOrigin(item.origin, `${label}.origin`),
    trust: requiredTrust(item.trust, `${label}.trust`),
    sensitivity: requiredSensitivity(item.sensitivity, `${label}.sensitivity`),
    provenance,
  }
}

function validateTransform(value: unknown, index: number): MemoryTransformStep {
  const label = `security.transformChain[${index}]`
  const step = closedObject(value, TRANSFORM_KEYS, label)
  if (typeof step.kind !== 'string' || !TRANSFORM_KINDS.has(step.kind)) {
    throw new PolicyRejection('invalid_transform_chain', `${label}.kind is invalid.`)
  }
  if (!Array.isArray(step.inputContentIds) || step.inputContentIds.length === 0) {
    throw new PolicyRejection('invalid_transform_chain', `${label}.inputContentIds must not be empty.`)
  }
  const inputContentIds = step.inputContentIds.map(
    (item, inputIndex) => requiredId(item, `${label}.inputContentIds[${inputIndex}]`),
  )
  if (new Set(inputContentIds).size !== inputContentIds.length) {
    throw new PolicyRejection('invalid_transform_chain', `${label}.inputContentIds contains duplicates.`)
  }
  return {
    kind: step.kind as MemoryTransformKind,
    inputContentIds,
    outputContentId: requiredId(step.outputContentId, `${label}.outputContentId`),
  }
}

function enforcePolicy(request: MemoryWriteRequest): void {
  const { security } = request
  validateAncestry(security, request.actorScope)
  validateTransformChain(security)

  const lineage = [security, ...security.derivedFrom]
  const allSensitivities = lineage.map((item) => item.sensitivity)
  if (allSensitivities.some((value) => value === 'auth' || value === 'secret')) {
    throw new PolicyRejection(
      'secret_ancestry',
      'Secret/auth ancestry cannot be persisted, including after summary, embedding, trace or redaction.',
    )
  }

  validateOriginTrust(security.origin, security.trust, 'security')
  for (const parent of security.derivedFrom) {
    validateOriginTrust(parent.origin, parent.trust, `derivedFrom:${parent.contentId}`)
  }

  const nonDirect = security.transformChain.some((step) => step.kind !== 'direct')
  if (nonDirect) {
    const expectedTrust = security.derivedFrom.some((parent) => parent.trust === 'non_authoritative')
      ? 'non_authoritative'
      : 'derived_untrusted'
    if (!DERIVED_ORIGINS.has(security.origin) || security.trust !== expectedTrust) {
      throw new PolicyRejection('trust_upgrade', 'Transformed content cannot mint trusted Memory authority.')
    }
  } else {
    const source = security.derivedFrom[0]!
    if (
      security.transformChain.length !== 1
      || !sameIdSet(security.transformChain[0]!.inputContentIds, [source.contentId])
      || security.derivedFrom.length !== 1
      || security.origin !== source.origin
      || security.trust !== source.trust
      || security.sensitivity !== source.sensitivity
    ) {
      throw new PolicyRejection('trust_upgrade', 'Direct Memory must preserve its single source classification.')
    }
  }

  const inheritedSensitivity = maxSensitivity(security.derivedFrom.map((parent) => parent.sensitivity))
  if (
    SENSITIVITY_RANK[security.sensitivity] < SENSITIVITY_RANK[inheritedSensitivity]
    && !security.transformChain.some((step) => step.kind === 'redaction')
  ) {
    throw new PolicyRejection(
      'invalid_transform_chain',
      'Sensitivity may only decrease through an explicit redaction transform.',
    )
  }

  if (redactSensitiveData(request.content).changed) {
    throw new PolicyRejection(
      'sensitive_content_detected',
      'Credential-like content cannot be persisted even when metadata labels it non-sensitive.',
    )
  }

  if (
    REUSABLE_SCOPES.has(request.targetScope.kind)
    && lineage.some((item) => EXTERNAL_ORIGINS.has(item.origin))
  ) {
    throw new PolicyRejection(
      'reusable_untrusted_source',
      'Web, download, tool or subagent ancestry cannot enter reusable Memory by default.',
    )
  }
  if (
    REUSABLE_SCOPES.has(request.targetScope.kind)
    && lineage.some((item) => (
      item.trust === 'untrusted_external'
      || item.trust === 'derived_untrusted'
      || item.trust === 'non_authoritative'
    ))
  ) {
    throw new PolicyRejection(
      'reusable_untrusted_source',
      'Untrusted, derived or non-authoritative content cannot enter reusable Memory by default.',
    )
  }
  if (
    request.targetScope.kind === 'project'
    && maxSensitivity(allSensitivities) === 'personal'
  ) {
    throw new PolicyRejection('scope_violation', 'Personal Memory may not be persisted to project scope.')
  }
}

function validateAncestry(security: MemoryWriteSecurity, actorScope: MemoryActorScope): void {
  assertProvenanceWithinActor(security.provenance, actorScope)
  const parents = new Map<string, MemoryDerivedFrom>()
  for (const parent of security.derivedFrom) {
    if (parents.has(parent.contentId)) {
      throw new PolicyRejection('invalid_provenance', 'Memory ancestry contains duplicate content ids.')
    }
    assertProvenanceWithinActor(parent.provenance, actorScope)
    parents.set(parent.contentId, parent)
  }
  if (!sameIdSet(security.provenance.parentContentIds, [...parents.keys()])) {
    throw new PolicyRejection('incomplete_ancestry', 'Memory provenance must declare the complete derivedFrom set.')
  }
  for (const parent of parents.values()) {
    for (const ancestorId of parent.provenance.parentContentIds) {
      if (!parents.has(ancestorId)) {
        throw new PolicyRejection('incomplete_ancestry', 'Memory ancestry omits a declared ancestor.')
      }
    }
  }
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (contentId: string): void => {
    if (visiting.has(contentId)) {
      throw new PolicyRejection('invalid_provenance', 'Memory ancestry must be acyclic.')
    }
    if (visited.has(contentId)) return
    const parent = parents.get(contentId)
    if (!parent) throw new PolicyRejection('incomplete_ancestry', 'Memory ancestry is incomplete.')
    visiting.add(contentId)
    for (const ancestorId of parent.provenance.parentContentIds) visit(ancestorId)
    visiting.delete(contentId)
    visited.add(contentId)
  }
  for (const contentId of security.provenance.parentContentIds) visit(contentId)
}

function validateTransformChain(security: MemoryWriteSecurity): void {
  const available = new Set(security.derivedFrom.map((parent) => parent.contentId))
  const outputs = new Set<string>()
  for (const step of security.transformChain) {
    if (step.inputContentIds.some((contentId) => !available.has(contentId))) {
      throw new PolicyRejection('invalid_transform_chain', 'Memory transform input has no immutable source.')
    }
    if (outputs.has(step.outputContentId) || available.has(step.outputContentId)) {
      throw new PolicyRejection('invalid_transform_chain', 'Memory transform output contentId is not unique.')
    }
    outputs.add(step.outputContentId)
    available.add(step.outputContentId)
  }
  const finalStep = security.transformChain[security.transformChain.length - 1]!
  if (finalStep.outputContentId !== security.provenance.contentId) {
    throw new PolicyRejection('invalid_transform_chain', 'Memory transform chain does not terminate at provenance.')
  }
}

function validateTargetScope(target: MemoryTargetScope, actor: MemoryActorScope): void {
  const requiredField: keyof MemoryActorScope = target.kind === 'run'
    ? 'runId'
    : target.kind === 'session'
      ? 'sessionId'
      : target.kind === 'project'
        ? 'projectId'
        : 'userId'
  if (!target[requiredField]) {
    throw new PolicyRejection('target_scope_mismatch', `Memory ${target.kind} scope requires ${requiredField}.`)
  }
  for (const key of SCOPE_KEYS) {
    const targetValue = target[key as keyof MemoryTargetScope]
    if (targetValue !== undefined && targetValue !== actor[key as keyof MemoryActorScope]) {
      throw new PolicyRejection('target_scope_mismatch', `Memory target ${key} crosses the writer boundary.`)
    }
  }
  if (actor.tenantId !== undefined && target.tenantId !== actor.tenantId) {
    throw new PolicyRejection('target_scope_mismatch', 'Memory target tenantId is missing or foreign.')
  }
}

function assertProvenanceWithinActor(
  provenance: MemoryProvenance,
  actor: MemoryActorScope,
): void {
  for (const key of SCOPE_KEYS) {
    const sourceValue = provenance[key as keyof MemoryProvenance]
    const actorValue = actor[key as keyof MemoryActorScope]
    if (sourceValue !== undefined && sourceValue !== actorValue) {
      throw new PolicyRejection('invalid_provenance', `Memory provenance ${key} crosses the writer boundary.`)
    }
  }
  if (provenance.runId !== actor.runId) {
    throw new PolicyRejection('invalid_provenance', 'Memory provenance runId is foreign.')
  }
  if (actor.tenantId !== undefined && provenance.tenantId !== actor.tenantId) {
    throw new PolicyRejection('invalid_provenance', 'Memory provenance tenantId is missing or foreign.')
  }
  if (actor.userId !== undefined && provenance.userId !== actor.userId) {
    throw new PolicyRejection('invalid_provenance', 'Memory provenance userId is missing or foreign.')
  }
}

function materializeEntry(request: MemoryWriteRequest): MemoryEntry {
  return {
    schemaVersion: MEMORY_ENTRY_SCHEMA_VERSION,
    entryId: request.security.provenance.contentId,
    content: clone(request.content),
    contentHash: memoryContentHash(request.content),
    scope: clone(request.targetScope),
    trust: request.security.trust,
    sensitivity: request.security.sensitivity,
    provenance: clone(request.security.provenance),
    derivedFrom: clone(request.security.derivedFrom),
    transformChain: clone(request.security.transformChain),
    createdAt: request.security.provenance.capturedAt,
  }
}

function validateOriginTrust(origin: ContentOrigin, trust: ContentTrust, label: string): void {
  const valid = origin === 'system'
    ? trust === 'trusted_runtime'
    : origin === 'user'
      ? trust === 'user_authorized'
      : origin === 'subagent'
        ? trust === 'non_authoritative'
        : origin === 'web' || origin === 'tool' || origin === 'download' || origin === 'memory'
          ? trust === 'untrusted_external'
          : trust === 'derived_untrusted' || trust === 'non_authoritative'
  if (!valid) throw new PolicyRejection('trust_upgrade', `${label} contains an origin/trust mismatch.`)
}

function requiredOrigin(value: unknown, label: string): ContentOrigin {
  if (typeof value !== 'string' || !ORIGINS.has(value)) {
    throw new PolicyRejection('invalid_provenance', `${label} is invalid.`)
  }
  return value as ContentOrigin
}

function requiredTrust(value: unknown, label: string): ContentTrust {
  if (typeof value !== 'string' || !TRUST_LEVELS.has(value)) {
    throw new PolicyRejection('invalid_provenance', `${label} is invalid.`)
  }
  return value as ContentTrust
}

function requiredSensitivity(value: unknown, label: string): ContentSensitivity {
  if (typeof value !== 'string' || !SENSITIVITY_LEVELS.has(value)) {
    throw new PolicyRejection('invalid_provenance', `${label} is invalid.`)
  }
  return value as ContentSensitivity
}

function optionalScopeFields(
  value: Record<string, unknown>,
  label: string,
): Partial<MemoryActorScope> {
  const output: Partial<MemoryActorScope> = {}
  for (const key of ['tenantId', 'userId', 'projectId', 'sessionId', 'runId'] as const) {
    if (value[key] !== undefined) output[key] = requiredId(value[key], `${label}.${key}`)
  }
  return output
}

function sameActorScope(left: MemoryActorScope, right: MemoryActorScope): boolean {
  return [...SCOPE_KEYS].every((key) => (
    left[key as keyof MemoryActorScope] === right[key as keyof MemoryActorScope]
  ))
}

function sameIdSet(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value) => right.includes(value))
}

function requiredId(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() !== value || value.length === 0 || value.length > 512) {
    throw new PolicyRejection('invalid_request', `${label} must be a non-empty bounded string.`)
  }
  return value
}

function requiredTimestamp(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || !Number.isFinite(Date.parse(value))) {
    throw new PolicyRejection('invalid_request', `${label} must be a valid timestamp.`)
  }
  return value
}

function closedObject(
  value: unknown,
  keys: ReadonlySet<string>,
  label: string,
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PolicyRejection('invalid_request', `${label} must be a plain object.`)
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new PolicyRejection('invalid_request', `${label} must be a plain object.`)
  }
  for (const key of Object.keys(value)) {
    if (!keys.has(key)) {
      throw new PolicyRejection('invalid_request', `${label} contains unsupported field ${key}.`)
    }
  }
  return value as Record<string, unknown>
}

function assertJsonSafe(value: unknown, label: string, seen = new Set<object>()): asserts value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new PolicyRejection('invalid_request', `${label} contains a non-finite number.`)
    return
  }
  if (typeof value !== 'object') {
    throw new PolicyRejection('invalid_request', `${label} is not JSON-safe.`)
  }
  if (seen.has(value)) throw new PolicyRejection('invalid_request', `${label} contains a cycle.`)
  seen.add(value)
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      assertJsonSafe(value[index], `${label}[${index}]`, seen)
    }
  } else {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new PolicyRejection('invalid_request', `${label} contains a non-plain object.`)
    }
    for (const [key, child] of Object.entries(value)) {
      assertJsonSafe(child, `${label}.${key}`, seen)
    }
  }
  seen.delete(value)
}

function maxSensitivity(values: ContentSensitivity[]): ContentSensitivity {
  return values.reduce(
    (highest, candidate) => SENSITIVITY_RANK[candidate] > SENSITIVITY_RANK[highest]
      ? candidate
      : highest,
    'public',
  )
}

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`).join(',')}}`
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}

function deny(
  reasonCode: MemoryWriteDenyCode,
  reason: string,
  requestId?: string,
): MemoryWriteDecision {
  return {
    schemaVersion: MEMORY_WRITE_DECISION_SCHEMA_VERSION,
    action: 'deny',
    reasonCode,
    ...(requestId ? { requestId } : {}),
    reason,
  }
}
