import { createHash } from 'node:crypto'
import type {
  ActionBinding,
  ApprovalBinding,
  ArtifactRef,
  CheckpointRef,
  JsonObject,
  JsonValue,
  OwnerScope,
  RunLifecycleState,
  SessionRef,
  WebTaskInputSnapshot,
} from '../task/contracts.js'

export const RUN_RECORD_SCHEMA_VERSION = 'control-run-record/v1' as const
export const RUN_EVENT_SCHEMA_VERSION = 'control-run-event/v1' as const
export const APPROVAL_RECORD_SCHEMA_VERSION = 'control-approval-record/v1' as const
export const APPROVAL_EVENT_SCHEMA_VERSION = 'control-approval-event/v1' as const

export type ControlStoreErrorCode =
  | 'INVALID_RECORD'
  | 'UNSUPPORTED_SCHEMA_VERSION'
  | 'MIGRATION_FAILED'
  | 'RUN_ALREADY_EXISTS'
  | 'RUN_NOT_FOUND'
  | 'APPROVAL_ALREADY_EXISTS'
  | 'APPROVAL_NOT_FOUND'
  | 'REVISION_CONFLICT'
  | 'EVENT_SEQUENCE_CONFLICT'
  | 'IDEMPOTENCY_CONFLICT'
  | 'BINDING_MISMATCH'
  | 'APPROVAL_NOT_PENDING'

export class ControlStoreError extends Error {
  readonly code: ControlStoreErrorCode
  readonly expectedRevision?: number
  readonly actualRevision?: number

  constructor(
    code: ControlStoreErrorCode,
    message: string,
    expectedRevision?: number,
    actualRevision?: number,
  ) {
    super(message)
    this.name = 'ControlStoreError'
    this.code = code
    this.expectedRevision = expectedRevision
    this.actualRevision = actualRevision
  }
}

/**
 * ownerScope is optional for the current local/single-user deployment. Omission
 * means the explicit local default scope, never an all-tenant wildcard.
 */
export interface ScopedStoreQuery {
  ownerScope?: OwnerScope
}

export interface StorePage<T> {
  items: T[]
  nextCursor?: string
}

export interface StoreCommit<TRecord, TEvent> {
  record: TRecord
  event: TEvent
  replayed: boolean
}

export interface StoreCreateOptions {
  idempotencyKey: string
}

export interface SafeTurnBoundaryRef {
  schemaVersion: 'safe-turn-boundary-ref/v1'
  runId: string
  runRevision: number
  attempt: number
  turnId: string
  actionSeq: number
  observedAt: string
  sessionRef?: SessionRef
  checkpointRef?: CheckpointRef
}

export interface OpaqueResourceRef {
  schemaVersion: 'control-resource-ref/v1'
  id: string
  kind: 'trace' | 'task_graph' | 'notification_outbox' | 'other'
  locator: string
}

export interface RunRecord {
  schemaVersion: typeof RUN_RECORD_SCHEMA_VERSION
  runId: string
  /** Store CAS revision. It is independent from contract/run freshness revision. */
  recordRevision: number
  /** Logical run epoch used to fence late results. */
  runRevision: number
  attempt: number
  state: RunLifecycleState
  inputSnapshot: WebTaskInputSnapshot
  inputDigest: string
  ownerScope?: OwnerScope
  sessionRef?: SessionRef
  checkpointRef?: CheckpointRef
  lastSafeBoundary?: SafeTurnBoundaryRef
  artifactRefs: ArtifactRef[]
  resourceRefs: OpaqueResourceRef[]
  pendingApprovalIds: string[]
  nextEventSequence: number
  createdAt: string
  updatedAt: string
  reason?: string
}

export type RunStoreEventType =
  | 'run_created'
  | 'state_transitioned'
  | 'control_requested'
  | 'safe_boundary_reached'
  | 'reference_attached'
  | 'recovery_classified'
  | 'late_result_rejected'

export interface RunStoreEvent {
  schemaVersion: typeof RUN_EVENT_SCHEMA_VERSION
  eventId: string
  eventSequence: number
  eventType: RunStoreEventType
  runId: string
  recordRevisionBefore: number | null
  recordRevisionAfter: number
  runRevision: number
  attempt: number
  occurredAt: string
  idempotencyKey: string
  ownerScope?: OwnerScope
  data?: JsonObject
}

export interface RunStoreCreate {
  record: RunRecord
  event: RunStoreEvent
  options: StoreCreateOptions
}

export interface RunStoreMutation {
  expectedRecordRevision: number
  record: RunRecord
  event: RunStoreEvent
  idempotencyKey: string
}

export interface RunListQuery extends ScopedStoreQuery {
  states?: RunLifecycleState[]
  limit?: number
  cursor?: string
}

export interface RunEventQuery extends ScopedStoreQuery {
  afterSequence?: number
  limit?: number
}

/**
 * transact() must atomically commit record + event. Implementations must use
 * compare-and-swap on expectedRecordRevision. Replaying the same idempotency key
 * with identical canonical bytes returns replayed=true; different bytes fail.
 */
export interface RunStore {
  create(input: RunStoreCreate): Promise<StoreCommit<RunRecord, RunStoreEvent>>
  get(runId: string, scope?: ScopedStoreQuery): Promise<RunRecord | undefined>
  list(query?: RunListQuery): Promise<StorePage<RunRecord>>
  transact(runId: string, mutation: RunStoreMutation): Promise<StoreCommit<RunRecord, RunStoreEvent>>
  readEvents(runId: string, query?: RunEventQuery): Promise<StorePage<RunStoreEvent>>
}

export type DurableApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired' | 'cancelled'

export interface ApprovalTerminalMetadata {
  status: Exclude<DurableApprovalStatus, 'pending'>
  source: 'user' | 'system' | 'timeout'
  occurredAt: string
  reason?: string
}

export interface ApprovalRecord {
  schemaVersion: typeof APPROVAL_RECORD_SCHEMA_VERSION
  approvalId: string
  runId: string
  recordRevision: number
  runRevision: number
  attempt: number
  status: DurableApprovalStatus
  actionBinding: ActionBinding
  actionBindingSha256: string
  allowedDecisions: Array<'approved' | 'denied'>
  ownerScope?: OwnerScope
  sessionRef?: SessionRef
  resolution?: ApprovalBinding
  terminal?: ApprovalTerminalMetadata
  nextEventSequence: number
  requestedAt: string
  updatedAt: string
  expiresAt: string
}

export type ApprovalStoreEventType =
  | 'approval_enqueued'
  | 'approval_resolved'
  | 'approval_expired'
  | 'approval_cancelled'
  | 'approval_replay_rejected'

export interface ApprovalStoreEvent {
  schemaVersion: typeof APPROVAL_EVENT_SCHEMA_VERSION
  eventId: string
  eventSequence: number
  eventType: ApprovalStoreEventType
  approvalId: string
  runId: string
  recordRevisionBefore: number | null
  recordRevisionAfter: number
  runRevision: number
  attempt: number
  actionId: string
  occurredAt: string
  idempotencyKey: string
  ownerScope?: OwnerScope
  data?: JsonObject
}

export interface ApprovalStoreCreate {
  record: ApprovalRecord
  event: ApprovalStoreEvent
  options: StoreCreateOptions
}

export interface ApprovalStoreMutation {
  expectedRecordRevision: number
  record: ApprovalRecord
  event: ApprovalStoreEvent
  idempotencyKey: string
}

export interface ApprovalResolutionExpectation {
  runId: string
  runRevision: number
  attempt: number
  sessionId?: string
  actionId: string
  actionBindingSha256: string
  sourceOrigin?: string
  destinationOrigin?: string
}

export interface ApprovalResolveCommand {
  approvalId: string
  ownerScope?: OwnerScope
  expectedRecordRevision: number
  idempotencyKey: string
  expectation: ApprovalResolutionExpectation
  resolution: ApprovalBinding
  resolvedAt: string
}

export interface ApprovalListQuery extends ScopedStoreQuery {
  statuses?: DurableApprovalStatus[]
  runId?: string
  limit?: number
  cursor?: string
}

export interface ApprovalEventQuery extends ScopedStoreQuery {
  afterSequence?: number
  limit?: number
}

/**
 * resolveOnce() is the only approval decision write. It must atomically check
 * pending status, record revision, expiry and exact run/session/action/origin
 * binding before writing one terminal record + event.
 */
export interface ApprovalStore {
  create(input: ApprovalStoreCreate): Promise<StoreCommit<ApprovalRecord, ApprovalStoreEvent>>
  get(approvalId: string, scope?: ScopedStoreQuery): Promise<ApprovalRecord | undefined>
  list(query?: ApprovalListQuery): Promise<StorePage<ApprovalRecord>>
  transact(approvalId: string, mutation: ApprovalStoreMutation): Promise<StoreCommit<ApprovalRecord, ApprovalStoreEvent>>
  resolveOnce(command: ApprovalResolveCommand): Promise<StoreCommit<ApprovalRecord, ApprovalStoreEvent>>
  readEvents(approvalId: string, query?: ApprovalEventQuery): Promise<StorePage<ApprovalStoreEvent>>
}

export interface ControlStoreMigration<T extends { schemaVersion: string }> {
  fromSchemaVersion: string
  toSchemaVersion: T['schemaVersion']
  migrate(input: JsonObject): T
}

export function decodeRunRecord(
  input: unknown,
  migrations: readonly ControlStoreMigration<RunRecord>[] = [],
): RunRecord {
  return decodeVersioned('RunRecord', input, RUN_RECORD_SCHEMA_VERSION, migrations, validateRunRecord)
}

export function decodeApprovalRecord(
  input: unknown,
  migrations: readonly ControlStoreMigration<ApprovalRecord>[] = [],
): ApprovalRecord {
  return decodeVersioned('ApprovalRecord', input, APPROVAL_RECORD_SCHEMA_VERSION, migrations, validateApprovalRecord)
}

export function validateRunRecord(record: RunRecord): void {
  if (record.schemaVersion !== RUN_RECORD_SCHEMA_VERSION) unsupported('RunRecord', record.schemaVersion)
  nonEmpty(record.runId, 'runId')
  integer(record.recordRevision, 'recordRevision')
  integer(record.runRevision, 'runRevision')
  positiveInteger(record.attempt, 'attempt')
  if (!RUN_STATES.has(record.state)) invalid(`Unsupported run state: ${String(record.state)}`)
  if (record.inputSnapshot?.schemaVersion !== 'web-task-input-snapshot/v1') invalid('inputSnapshot must be web-task-input-snapshot/v1.')
  if (record.inputSnapshot.runId !== record.runId) binding('inputSnapshot.runId does not match runId.')
  if (record.inputDigest !== record.inputSnapshot.sha256 || !SHA256.test(record.inputDigest)) invalid('inputDigest must match inputSnapshot.sha256.')
  if (record.runRevision < record.inputSnapshot.revision) invalid('runRevision cannot precede the frozen input revision.')
  validateOwnerScope(record.ownerScope)
  validateSessionRef(record.sessionRef, record.runId, record.attempt)
  validateCheckpointRef(record.checkpointRef)
  if (record.lastSafeBoundary) validateSafeBoundary(record.lastSafeBoundary, record)
  arrays(
    ['pendingApprovalIds', record.pendingApprovalIds],
    ['artifactRefs', record.artifactRefs],
    ['resourceRefs', record.resourceRefs],
  )
  unique(record.pendingApprovalIds, 'pendingApprovalIds')
  unique(record.artifactRefs.map((item) => item.id), 'artifactRefs.id')
  unique(record.resourceRefs.map((item) => item.id), 'resourceRefs.id')
  for (const artifact of record.artifactRefs) {
    if (artifact.schemaVersion !== 'artifact-ref/v1') unsupported('ArtifactRef', artifact.schemaVersion)
    if (artifact.binding.runId !== record.runId || artifact.binding.revision > record.runRevision) {
      binding(`Artifact ${artifact.id} is not bound to this run revision.`)
    }
  }
  for (const resource of record.resourceRefs) {
    if (resource.schemaVersion !== 'control-resource-ref/v1') unsupported('OpaqueResourceRef', resource.schemaVersion)
    nonEmpty(resource.id, 'resourceRef.id')
    nonEmpty(resource.locator, 'resourceRef.locator')
    if (isAbsoluteLocator(resource.locator)) invalid('resourceRef.locator must be opaque.')
  }
  integer(record.nextEventSequence, 'nextEventSequence')
  isoUtc(record.createdAt, 'createdAt')
  isoUtc(record.updatedAt, 'updatedAt')
  if (record.updatedAt < record.createdAt) invalid('updatedAt cannot precede createdAt.')
  assertJsonSafe(record)
}

export function validateRunCreate(input: RunStoreCreate): void {
  validateRunRecord(input.record)
  validateRunEvent(input.event)
  nonEmpty(input.options.idempotencyKey, 'options.idempotencyKey')
  if (input.record.recordRevision !== 0 || input.event.recordRevisionBefore !== null || input.event.recordRevisionAfter !== 0) {
    revision('Run create must begin at record revision 0.', 0, input.record.recordRevision)
  }
  if (input.event.eventType !== 'run_created' || input.event.eventSequence !== 0 || input.record.nextEventSequence !== 1) {
    eventConflict('Run create must commit run_created at sequence 0 and advance nextEventSequence to 1.')
  }
  validateRunEventBinding(input.record, input.event, input.options.idempotencyKey)
}

export function validateRunMutation(current: RunRecord, mutation: RunStoreMutation): void {
  validateRunRecord(current)
  validateRunRecord(mutation.record)
  validateRunEvent(mutation.event)
  nonEmpty(mutation.idempotencyKey, 'idempotencyKey')
  if (mutation.expectedRecordRevision !== current.recordRevision) {
    revision('Run mutation expected revision is stale.', mutation.expectedRecordRevision, current.recordRevision)
  }
  if (mutation.record.runId !== current.runId
    || mutation.record.createdAt !== current.createdAt
    || mutation.record.inputDigest !== current.inputDigest
    || controlRecordDigest(mutation.record.inputSnapshot) !== controlRecordDigest(current.inputSnapshot)
    || !sameOptionalJson(mutation.record.ownerScope, current.ownerScope)) {
    binding('Run identity, frozen input, owner scope and createdAt are immutable.')
  }
  if (mutation.record.runRevision < current.runRevision) {
    revision('Run logical revision cannot move backwards.', current.runRevision, mutation.record.runRevision)
  }
  if (mutation.record.attempt < current.attempt) {
    revision('Run attempt cannot move backwards.', current.attempt, mutation.record.attempt)
  }
  if (mutation.record.recordRevision !== current.recordRevision + 1) {
    revision('Run record revision must increment exactly once.', current.recordRevision + 1, mutation.record.recordRevision)
  }
  if (mutation.event.recordRevisionBefore !== current.recordRevision
    || mutation.event.recordRevisionAfter !== mutation.record.recordRevision) {
    revision('Run event revision fence does not match the mutation.', current.recordRevision, mutation.event.recordRevisionBefore ?? undefined)
  }
  if (mutation.event.eventSequence !== current.nextEventSequence
    || mutation.record.nextEventSequence !== current.nextEventSequence + 1) {
    eventConflict('Run event must consume exactly nextEventSequence.')
  }
  if (mutation.event.eventType === 'run_created') {
    eventConflict('run_created is valid only for RunStore.create().')
  }
  validateRunEventBinding(mutation.record, mutation.event, mutation.idempotencyKey)
}

export function validateApprovalRecord(record: ApprovalRecord): void {
  if (record.schemaVersion !== APPROVAL_RECORD_SCHEMA_VERSION) unsupported('ApprovalRecord', record.schemaVersion)
  nonEmpty(record.approvalId, 'approvalId')
  nonEmpty(record.runId, 'runId')
  integer(record.recordRevision, 'recordRevision')
  integer(record.runRevision, 'runRevision')
  positiveInteger(record.attempt, 'attempt')
  if (!APPROVAL_STATES.has(record.status)) invalid(`Unsupported approval status: ${String(record.status)}`)
  if (record.actionBinding?.schemaVersion !== 'action-binding/v1') invalid('actionBinding must be action-binding/v1.')
  if (record.actionBinding.runId !== record.runId) binding('actionBinding.runId does not match approval runId.')
  if (controlRecordDigest(record.actionBinding) !== record.actionBindingSha256) {
    binding('actionBindingSha256 does not match the canonical action binding.')
  }
  validateOwnerScope(record.ownerScope)
  validateSessionRef(record.sessionRef, record.runId, record.attempt)
  if (record.sessionRef && record.actionBinding.sessionRef?.id !== record.sessionRef.id) {
    binding('Approval sessionRef does not match actionBinding.sessionRef.')
  }
  arrays(['allowedDecisions', record.allowedDecisions])
  if (!record.allowedDecisions.length) invalid('allowedDecisions must be non-empty.')
  for (const decision of record.allowedDecisions) {
    if (!APPROVAL_DECISIONS.has(decision)) invalid(`Unsupported approval decision: ${String(decision)}`)
  }
  unique(record.allowedDecisions, 'allowedDecisions')
  if (record.status === 'pending' && (record.resolution || record.terminal)) {
    invalid('Pending approval cannot contain terminal resolution metadata.')
  }
  if (record.status === 'approved' || record.status === 'denied') {
    validateApprovalBindingRecord(record.resolution)
    if (!record.resolution || record.resolution.decision !== record.status) {
      invalid('Resolved approval must contain a matching ApprovalBinding decision.')
    }
    if (record.resolution.approvalId !== record.approvalId
      || record.resolution.actionBindingSha256 !== record.actionBindingSha256) {
      binding('ApprovalBinding does not match the durable approval record.')
    }
  }
  if ((record.status === 'expired' || record.status === 'cancelled') && record.resolution) {
    invalid('Expired/cancelled approval cannot carry an approved/denied binding.')
  }
  if (record.status !== 'pending' && record.terminal?.status !== record.status) {
    invalid('Terminal approval must contain matching terminal metadata.')
  }
  if (record.terminal) {
    if (!APPROVAL_TERMINAL_SOURCES.has(record.terminal.source)) {
      invalid(`Unsupported approval terminal source: ${String(record.terminal.source)}`)
    }
    isoUtc(record.terminal.occurredAt, 'terminal.occurredAt')
    if (record.terminal.reason !== undefined) nonEmpty(record.terminal.reason, 'terminal.reason')
  }
  integer(record.nextEventSequence, 'nextEventSequence')
  isoUtc(record.requestedAt, 'requestedAt')
  isoUtc(record.updatedAt, 'updatedAt')
  isoUtc(record.expiresAt, 'expiresAt')
  if (record.updatedAt < record.requestedAt || record.expiresAt <= record.requestedAt) {
    invalid('Approval timestamps are not monotonic.')
  }
  assertJsonSafe(record)
}

export function validateApprovalCreate(input: ApprovalStoreCreate): void {
  validateApprovalRecord(input.record)
  validateApprovalEvent(input.event)
  nonEmpty(input.options.idempotencyKey, 'options.idempotencyKey')
  if (input.record.status !== 'pending') invalid('Approval create must start pending.')
  if (input.record.recordRevision !== 0 || input.event.recordRevisionBefore !== null || input.event.recordRevisionAfter !== 0) {
    revision('Approval create must begin at record revision 0.', 0, input.record.recordRevision)
  }
  if (input.event.eventType !== 'approval_enqueued'
    || input.event.eventSequence !== 0
    || input.record.nextEventSequence !== 1) {
    eventConflict('Approval create must commit approval_enqueued at sequence 0.')
  }
  validateApprovalEventBinding(input.record, input.event, input.options.idempotencyKey)
}

export function validateApprovalMutation(current: ApprovalRecord, mutation: ApprovalStoreMutation): void {
  validateApprovalRecord(current)
  validateApprovalRecord(mutation.record)
  validateApprovalEvent(mutation.event)
  if (mutation.expectedRecordRevision !== current.recordRevision) {
    revision('Approval mutation expected revision is stale.', mutation.expectedRecordRevision, current.recordRevision)
  }
  if (current.status !== 'pending') {
    throw new ControlStoreError('APPROVAL_NOT_PENDING', `Approval ${current.approvalId} is already ${current.status}.`)
  }
  if (mutation.record.approvalId !== current.approvalId
    || mutation.record.runId !== current.runId
    || mutation.record.runRevision !== current.runRevision
    || mutation.record.attempt !== current.attempt
    || mutation.record.actionBindingSha256 !== current.actionBindingSha256
    || controlRecordDigest(mutation.record.actionBinding) !== controlRecordDigest(current.actionBinding)
    || controlRecordDigest(mutation.record.allowedDecisions) !== controlRecordDigest(current.allowedDecisions)
    || !sameOptionalJson(mutation.record.ownerScope, current.ownerScope)
    || !sameOptionalJson(mutation.record.sessionRef, current.sessionRef)
    || mutation.record.requestedAt !== current.requestedAt
    || mutation.record.expiresAt !== current.expiresAt) {
    binding('Approval identity, run epoch, exact action, decisions, scope, session and expiry are immutable.')
  }
  if (mutation.record.status === 'approved' || mutation.record.status === 'denied') {
    binding('Approval decisions may be written only through ApprovalStore.resolveOnce().')
  }
  if (mutation.record.recordRevision !== current.recordRevision + 1) {
    revision('Approval record revision must increment exactly once.', current.recordRevision + 1, mutation.record.recordRevision)
  }
  if (mutation.event.recordRevisionBefore !== current.recordRevision
    || mutation.event.recordRevisionAfter !== mutation.record.recordRevision) {
    revision('Approval event revision fence does not match the mutation.')
  }
  if (mutation.event.eventSequence !== current.nextEventSequence
    || mutation.record.nextEventSequence !== current.nextEventSequence + 1) {
    eventConflict('Approval event must consume exactly nextEventSequence.')
  }
  if (mutation.event.eventType === 'approval_enqueued'
    || mutation.event.eventType === 'approval_resolved') {
    eventConflict(`${mutation.event.eventType} is not valid for ApprovalStore.transact().`)
  }
  validateApprovalEventBinding(mutation.record, mutation.event, mutation.idempotencyKey)
}

export function validateApprovalResolve(
  record: ApprovalRecord,
  command: ApprovalResolveCommand,
  now = new Date(command.resolvedAt),
): void {
  validateApprovalRecord(record)
  nonEmpty(command.idempotencyKey, 'idempotencyKey')
  isoUtc(command.resolvedAt, 'resolvedAt')
  if (command.approvalId !== record.approvalId) binding('Approval id does not match.')
  if (!sameOptionalJson(command.ownerScope, record.ownerScope)) {
    binding('Approval resolution scope does not match the durable request.')
  }
  if (command.expectedRecordRevision !== record.recordRevision) {
    revision('Approval resolve expected revision is stale.', command.expectedRecordRevision, record.recordRevision)
  }
  if (record.status !== 'pending') {
    throw new ControlStoreError('APPROVAL_NOT_PENDING', `Approval ${record.approvalId} is already ${record.status}.`)
  }
  const expected = command.expectation
  const action = record.actionBinding
  if (expected.runId !== record.runId
    || expected.runRevision !== record.runRevision
    || expected.attempt !== record.attempt
    || expected.sessionId !== record.sessionRef?.id
    || expected.actionId !== action.actionId
    || expected.actionBindingSha256 !== record.actionBindingSha256
    || expected.sourceOrigin !== action.sourceOrigin
    || expected.destinationOrigin !== action.destinationOrigin) {
    binding('Approval resolution does not match the exact run/session/action/origin binding.')
  }
  if (command.resolution.schemaVersion !== 'approval-binding/v1'
    || command.resolution.approvalId !== record.approvalId
    || command.resolution.actionBindingSha256 !== record.actionBindingSha256) {
    binding('Approval resolution binding does not match the durable request.')
  }
  validateApprovalBindingRecord(command.resolution)
  if (!record.allowedDecisions.includes(command.resolution.decision)) {
    binding(`Approval decision ${command.resolution.decision} is not allowed.`)
  }
  if (now.getTime() >= Date.parse(record.expiresAt)
    || now.getTime() >= Date.parse(action.expiresAt)
    || now.getTime() >= Date.parse(command.resolution.expiresAt)) {
    binding('Approval request, action, or resolution binding has expired.')
  }
  if (Date.parse(command.resolution.issuedAt) > Date.parse(command.resolvedAt)) {
    invalid('Approval resolution cannot be issued after resolvedAt.')
  }
  if (command.resolution.consumedAt) binding('A pre-consumed ApprovalBinding cannot resolve a pending approval.')
}

export function controlRecordDigest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

function validateRunEvent(event: RunStoreEvent): void {
  if (event.schemaVersion !== RUN_EVENT_SCHEMA_VERSION) unsupported('RunStoreEvent', event.schemaVersion)
  if (!RUN_EVENT_TYPES.has(event.eventType)) invalid(`Unsupported run event type: ${String(event.eventType)}`)
  nonEmpty(event.eventId, 'eventId')
  integer(event.eventSequence, 'eventSequence')
  integer(event.recordRevisionAfter, 'recordRevisionAfter')
  if (event.recordRevisionBefore !== null) integer(event.recordRevisionBefore, 'recordRevisionBefore')
  integer(event.runRevision, 'runRevision')
  positiveInteger(event.attempt, 'attempt')
  isoUtc(event.occurredAt, 'occurredAt')
  nonEmpty(event.idempotencyKey, 'idempotencyKey')
  validateOwnerScope(event.ownerScope)
  assertJsonSafe(event)
}

function validateApprovalEvent(event: ApprovalStoreEvent): void {
  if (event.schemaVersion !== APPROVAL_EVENT_SCHEMA_VERSION) unsupported('ApprovalStoreEvent', event.schemaVersion)
  if (!APPROVAL_EVENT_TYPES.has(event.eventType)) {
    invalid(`Unsupported approval event type: ${String(event.eventType)}`)
  }
  nonEmpty(event.eventId, 'eventId')
  integer(event.eventSequence, 'eventSequence')
  integer(event.recordRevisionAfter, 'recordRevisionAfter')
  if (event.recordRevisionBefore !== null) integer(event.recordRevisionBefore, 'recordRevisionBefore')
  integer(event.runRevision, 'runRevision')
  positiveInteger(event.attempt, 'attempt')
  isoUtc(event.occurredAt, 'occurredAt')
  nonEmpty(event.idempotencyKey, 'idempotencyKey')
  validateOwnerScope(event.ownerScope)
  assertJsonSafe(event)
}

function validateRunEventBinding(record: RunRecord, event: RunStoreEvent, idempotencyKey: string): void {
  if (event.runId !== record.runId
    || event.recordRevisionAfter !== record.recordRevision
    || event.runRevision !== record.runRevision
    || event.attempt !== record.attempt
    || event.attempt !== record.attempt
    || event.idempotencyKey !== idempotencyKey
    || !sameOptionalJson(event.ownerScope, record.ownerScope)) {
    binding('Run event does not match its record/idempotency/scope fence.')
  }
}

function validateApprovalEventBinding(
  record: ApprovalRecord,
  event: ApprovalStoreEvent,
  idempotencyKey: string,
): void {
  if (event.approvalId !== record.approvalId
    || event.runId !== record.runId
    || event.actionId !== record.actionBinding.actionId
    || event.recordRevisionAfter !== record.recordRevision
    || event.runRevision !== record.runRevision
    || event.idempotencyKey !== idempotencyKey
    || !sameOptionalJson(event.ownerScope, record.ownerScope)) {
    binding('Approval event does not match its record/idempotency/scope fence.')
  }
}

function decodeVersioned<T extends { schemaVersion: string }>(
  kind: string,
  input: unknown,
  currentVersion: T['schemaVersion'],
  migrations: readonly ControlStoreMigration<T>[],
  validate: (record: T) => void,
): T {
  const raw = jsonObject(input, kind)
  if (raw.schemaVersion === currentVersion) {
    const record = structuredClone(raw) as T
    validate(record)
    return record
  }
  const candidates = migrations.filter((migration) =>
    migration.fromSchemaVersion === raw.schemaVersion && migration.toSchemaVersion === currentVersion)
  if (candidates.length !== 1) unsupported(kind, raw.schemaVersion)
  try {
    const migrated = candidates[0].migrate(structuredClone(raw))
    if (migrated.schemaVersion !== currentVersion) {
      throw new Error(`Migration returned ${migrated.schemaVersion}.`)
    }
    validate(migrated)
    return structuredClone(migrated)
  } catch (error) {
    if (error instanceof ControlStoreError) throw error
    throw new ControlStoreError('MIGRATION_FAILED', `${kind} migration failed: ${errorMessage(error)}`)
  }
}

function validateOwnerScope(scope: OwnerScope | undefined): void {
  if (!scope) return
  if (scope.schemaVersion !== 'owner-scope/v1') unsupported('OwnerScope', scope.schemaVersion)
  if (!scope.tenantId && !scope.userId && !scope.projectId) {
    invalid('ownerScope must identify at least one tenant, user or project; omit it for local default scope.')
  }
  for (const [key, value] of Object.entries(scope)) {
    if (key !== 'schemaVersion' && value !== undefined) nonEmpty(value, `ownerScope.${key}`)
  }
}

function validateApprovalBindingRecord(bindingValue: ApprovalBinding | undefined): void {
  if (!bindingValue || bindingValue.schemaVersion !== 'approval-binding/v1') {
    invalid('resolution must be approval-binding/v1.')
  }
  nonEmpty(bindingValue.approvalId, 'resolution.approvalId')
  if (!SHA256.test(bindingValue.actionBindingSha256)) {
    invalid('resolution.actionBindingSha256 must be a SHA-256 hex digest.')
  }
  if (!APPROVAL_DECISIONS.has(bindingValue.decision)) {
    invalid(`Unsupported approval resolution decision: ${String(bindingValue.decision)}`)
  }
  isoUtc(bindingValue.issuedAt, 'resolution.issuedAt')
  isoUtc(bindingValue.expiresAt, 'resolution.expiresAt')
  if (bindingValue.expiresAt <= bindingValue.issuedAt) {
    invalid('resolution.expiresAt must follow resolution.issuedAt.')
  }
  nonEmpty(bindingValue.nonce, 'resolution.nonce')
  if (bindingValue.consumedAt !== undefined) isoUtc(bindingValue.consumedAt, 'resolution.consumedAt')
}

function validateSessionRef(ref: SessionRef | undefined, runId: string, attempt: number): void {
  if (!ref) return
  if (ref.schemaVersion !== 'session-ref/v1') unsupported('SessionRef', ref.schemaVersion)
  if (ref.runId !== runId || ref.attempt !== attempt) binding('sessionRef does not match run/attempt.')
  nonEmpty(ref.provider, 'sessionRef.provider')
  nonEmpty(ref.id, 'sessionRef.id')
  validateCheckpointRef(ref.checkpointRef)
}

function validateCheckpointRef(ref: CheckpointRef | undefined): void {
  if (!ref) return
  if (ref.schemaVersion !== 'checkpoint-ref/v1') unsupported('CheckpointRef', ref.schemaVersion)
  nonEmpty(ref.provider, 'checkpointRef.provider')
  nonEmpty(ref.id, 'checkpointRef.id')
}

function validateSafeBoundary(boundary: SafeTurnBoundaryRef, record: RunRecord): void {
  if (boundary.schemaVersion !== 'safe-turn-boundary-ref/v1') unsupported('SafeTurnBoundaryRef', boundary.schemaVersion)
  if (boundary.runId !== record.runId
    || boundary.runRevision !== record.runRevision
    || boundary.attempt !== record.attempt) {
    binding('Safe turn boundary does not match run/revision/attempt.')
  }
  nonEmpty(boundary.turnId, 'lastSafeBoundary.turnId')
  integer(boundary.actionSeq, 'lastSafeBoundary.actionSeq')
  isoUtc(boundary.observedAt, 'lastSafeBoundary.observedAt')
  validateSessionRef(boundary.sessionRef, record.runId, record.attempt)
  validateCheckpointRef(boundary.checkpointRef)
}

function jsonObject(input: unknown, kind: string): JsonObject {
  assertJsonSafe(input)
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid(`${kind} must be a JSON object.`)
  return input as JsonObject
}

function assertJsonSafe(value: unknown): void {
  canonicalize(value, new WeakSet<object>(), '$')
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value, new WeakSet<object>(), '$'))
}

function canonicalize(value: unknown, seen: WeakSet<object>, path: string): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) invalid(`${path} contains a non-finite number.`)
    return value
  }
  if (typeof value !== 'object') invalid(`${path} is not JSON-safe.`)
  const object = value as object
  if (seen.has(object)) invalid(`${path} contains a cycle.`)
  seen.add(object)
  try {
    if (Array.isArray(value)) return value.map((item, index) => canonicalize(item, seen, `${path}[${index}]`))
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) invalid(`${path} contains a non-plain object.`)
    const output: JsonObject = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const nested = (value as Record<string, unknown>)[key]
      if (nested === undefined) invalid(`${path}.${key} is undefined; omit it explicitly.`)
      output[key] = canonicalize(nested, seen, `${path}.${key}`)
    }
    return output
  } finally {
    seen.delete(object)
  }
}

function isoUtc(value: string, path: string): void {
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    invalid(`${path} must be canonical ISO UTC with milliseconds.`)
  }
}

function isAbsoluteLocator(value: string): boolean {
  return /^(?:file:|\/|[A-Za-z]:[\\/])/.test(value)
}

function nonEmpty(value: unknown, path: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) invalid(`${path} must be a non-empty string.`)
}

function integer(value: number, path: string): void {
  if (!Number.isSafeInteger(value) || value < 0) invalid(`${path} must be a non-negative safe integer.`)
}

function positiveInteger(value: number, path: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) invalid(`${path} must be a positive safe integer.`)
}

function unique(values: readonly string[], path: string): void {
  if (new Set(values).size !== values.length) invalid(`${path} must not contain duplicates.`)
}

function arrays(...entries: Array<readonly [string, unknown]>): void {
  for (const [path, value] of entries) {
    if (!Array.isArray(value)) invalid(`${path} must be an array.`)
  }
}

function sameOptionalJson(left: unknown, right: unknown): boolean {
  if (left === undefined || right === undefined) return left === right
  return controlRecordDigest(left) === controlRecordDigest(right)
}

function unsupported(kind: string, version: unknown): never {
  throw new ControlStoreError('UNSUPPORTED_SCHEMA_VERSION', `${kind} schema version is unsupported: ${String(version)}`)
}

function invalid(message: string): never {
  throw new ControlStoreError('INVALID_RECORD', message)
}

function binding(message: string): never {
  throw new ControlStoreError('BINDING_MISMATCH', message)
}

function revision(message: string, expected?: number, actual?: number): never {
  throw new ControlStoreError('REVISION_CONFLICT', message, expected, actual)
}

function eventConflict(message: string): never {
  throw new ControlStoreError('EVENT_SEQUENCE_CONFLICT', message)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const SHA256 = /^[a-f0-9]{64}$/i
const RUN_STATES = new Set<RunLifecycleState>([
  'queued',
  'running',
  'pausing',
  'paused',
  'blocked_on_human',
  'resuming',
  'cancelling',
  'cancelled',
  'completed',
  'failed',
  'interrupted',
  'recoverable',
])
const APPROVAL_STATES = new Set<DurableApprovalStatus>([
  'pending',
  'approved',
  'denied',
  'expired',
  'cancelled',
])
const APPROVAL_DECISIONS = new Set<ApprovalBinding['decision']>(['approved', 'denied'])
const APPROVAL_TERMINAL_SOURCES = new Set<ApprovalTerminalMetadata['source']>(['user', 'system', 'timeout'])
const RUN_EVENT_TYPES = new Set<RunStoreEventType>([
  'run_created',
  'state_transitioned',
  'control_requested',
  'safe_boundary_reached',
  'reference_attached',
  'recovery_classified',
  'late_result_rejected',
])
const APPROVAL_EVENT_TYPES = new Set<ApprovalStoreEventType>([
  'approval_enqueued',
  'approval_resolved',
  'approval_expired',
  'approval_cancelled',
  'approval_replay_rejected',
])
