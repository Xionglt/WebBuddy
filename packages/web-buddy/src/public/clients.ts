import type {
  ArtifactRef,
  CheckpointRef,
  JsonObject,
  RunLifecycleState,
  SessionRef,
  WebTaskEvent,
  WebTaskInputSnapshot,
} from './contracts.js'
import {
  PublicContractError,
} from './task.js'
import {
  canonicalJson,
  validateArtifactRef,
  validateCheckpointRef,
  validateSessionRef,
} from '../task/contracts.js'
import { redactSensitiveData } from '../security/redaction.js'
import {
  assertServiceScopeAccess,
  validateServiceScope,
  type ServiceScope,
} from './service-contracts.js'

export const SDK_TRANSPORT_REQUEST_SCHEMA_VERSION = 'sdk-transport-request/v1' as const
export const PUBLIC_RUN_SCHEMA_VERSION = 'public-run/v1' as const
export const PUBLIC_RUN_LIST_SCHEMA_VERSION = 'public-run-list/v1' as const
export const PUBLIC_RUN_EVENTS_SCHEMA_VERSION = 'public-run-events/v1' as const
export const PUBLIC_ARTIFACT_LIST_SCHEMA_VERSION = 'public-artifact-list/v1' as const
export const PUBLIC_APPROVAL_SCHEMA_VERSION = 'public-approval/v1' as const
export const PUBLIC_APPROVAL_LIST_SCHEMA_VERSION = 'public-approval-list/v1' as const

export interface SdkTransportRequest {
  schemaVersion: typeof SDK_TRANSPORT_REQUEST_SCHEMA_VERSION
  method: 'GET' | 'POST'
  path: string
  scope: ServiceScope
  query?: JsonObject
  body?: JsonObject
}

export interface SdkTransport {
  send(request: Readonly<SdkTransportRequest>): Promise<unknown>
}

export interface PublicRun {
  schemaVersion: typeof PUBLIC_RUN_SCHEMA_VERSION
  runId: string
  revision: number
  attempt: number
  state: RunLifecycleState
  scope: ServiceScope
  updatedAt: string
  reason?: string
  pendingContinuation?: PublicContinuation
}

export interface PublicContinuation {
  continuationId: string
  kind: 'needs_information' | 'human_takeover' | 'operator_pause' | 'external_blocker'
  status: 'pending' | 'answered'
  question: {
    questionId: string
    field: string
    prompt: string
    options?: string[]
  }
  requestedAt: string
}

export interface PublicRunList {
  schemaVersion: typeof PUBLIC_RUN_LIST_SCHEMA_VERSION
  items: PublicRun[]
  nextCursor?: string
}

export interface PublicRunEvents {
  schemaVersion: typeof PUBLIC_RUN_EVENTS_SCHEMA_VERSION
  scope: ServiceScope
  runId: string
  items: WebTaskEvent[]
}

export interface PublicArtifactList {
  schemaVersion: typeof PUBLIC_ARTIFACT_LIST_SCHEMA_VERSION
  scope: ServiceScope
  runId: string
  items: ArtifactRef[]
}

export interface PublicApproval {
  schemaVersion: typeof PUBLIC_APPROVAL_SCHEMA_VERSION
  approvalId: string
  runId: string
  revision: number
  attempt: number
  status: 'pending' | 'approved' | 'denied' | 'expired' | 'cancelled'
  scope: ServiceScope
  action: {
    actionId: string
    kind: string
    sourceOrigin?: string
    destinationOrigin?: string
    externalBusinessKey?: string
    externalEffectDigest?: string
    externalProbeId?: string
    externalActionKind?: string
    externalEffectPreview?: string
  }
  allowedDecisions: Array<'approved' | 'approved_and_execute' | 'denied'>
  requestedAt: string
  expiresAt: string
}

export interface PublicApprovalList {
  schemaVersion: typeof PUBLIC_APPROVAL_LIST_SCHEMA_VERSION
  items: PublicApproval[]
  nextCursor?: string
}

export interface RunClient {
  create(request: {
    schemaVersion: 'run-client-create/v1'
    input: WebTaskInputSnapshot
    idempotencyKey: string
  }): Promise<PublicRun>
  list(request: {
    schemaVersion: 'run-client-list/v1'
    states?: RunLifecycleState[]
    cursor?: string
    limit?: number
  }): Promise<PublicRunList>
  get(request: {
    schemaVersion: 'run-client-get/v1'
    runId: string
  }): Promise<PublicRun | undefined>
  pause(request: RunControlRequest): Promise<PublicRun>
  resume(request: RunControlRequest): Promise<PublicRun>
  continue(request: ContinueRunRequest): Promise<PublicRun>
  cancel(request: RunControlRequest): Promise<PublicRun>
  events(request: {
    schemaVersion: 'run-client-events/v1'
    runId: string
    afterSequence?: number
  }): Promise<WebTaskEvent[]>
  artifacts(request: {
    schemaVersion: 'run-client-artifacts/v1'
    runId: string
  }): Promise<ArtifactRef[]>
}

export interface RunControlRequest {
  schemaVersion: 'run-client-control/v1'
  runId: string
  expectedRevision: number
  idempotencyKey: string
}

export interface ContinueRunRequest {
  schemaVersion: 'run-client-continuation/v1'
  runId: string
  continuationId: string
  expectedRevision: number
  answer: string
  intentPatch?: string
  idempotencyKey: string
}

export interface ApprovalClient {
  list(request: {
    schemaVersion: 'approval-client-list/v1'
    runId?: string
    statuses?: PublicApproval['status'][]
    cursor?: string
    limit?: number
  }): Promise<PublicApprovalList>
  resolve(request: {
    schemaVersion: 'approval-client-resolve/v1'
    approvalId: string
    expectedRevision: number
    decision: 'approved' | 'approved_and_execute' | 'denied'
    idempotencyKey: string
  }): Promise<PublicApproval>
}

export function createRunClient(input: {
  scope: ServiceScope
  transport: SdkTransport
}): RunClient {
  const scope = validateServiceScope(input.scope)
  const transport = requireTransport(input.transport)
  const send = (request: Omit<SdkTransportRequest, 'schemaVersion' | 'scope'>) => transport.send({
    schemaVersion: SDK_TRANSPORT_REQUEST_SCHEMA_VERSION,
    scope,
    ...request,
  })
  const client: RunClient = {
    async create(request) {
      version(request, 'run-client-create/v1', 'RunClient.create')
      return publicRun(await send({
        method: 'POST',
        path: '/api/runs',
        body: {
          schemaVersion: request.schemaVersion,
          input: request.input as unknown as JsonObject,
          idempotencyKey: request.idempotencyKey,
        },
      }), scope, request.input.runId)
    },
    async list(request) {
      version(request, 'run-client-list/v1', 'RunClient.list')
      return publicRunList(await send({
        method: 'GET',
        path: '/api/runs',
        query: jsonObject(request),
      }), scope)
    },
    async get(request) {
      version(request, 'run-client-get/v1', 'RunClient.get')
      const value = await send({ method: 'GET', path: `/api/runs/${segment(request.runId)}` })
      return value === undefined || value === null ? undefined : publicRun(value, scope, request.runId)
    },
    pause: (request) => control(send, scope, 'pause', request),
    resume: (request) => control(send, scope, 'resume', request),
    async continue(request) {
      version(request, 'run-client-continuation/v1', 'RunClient.continue')
      return publicRun(await send({
        method: 'POST',
        path: `/api/runs/${segment(request.runId)}/continuations/${segment(request.continuationId)}/resolve`,
        body: jsonObject(request),
      }), scope, request.runId)
    },
    cancel: (request) => control(send, scope, 'cancel', request),
    async events(request) {
      version(request, 'run-client-events/v1', 'RunClient.events')
      const value = await send({
        method: 'GET',
        path: `/api/runs/${segment(request.runId)}/events`,
        query: jsonObject(request),
      })
      return publicRunEvents(value, scope, request.runId).items
    },
    async artifacts(request) {
      version(request, 'run-client-artifacts/v1', 'RunClient.artifacts')
      const value = await send({
        method: 'GET',
        path: `/api/runs/${segment(request.runId)}/artifacts`,
      })
      return publicArtifactList(value, scope, request.runId).items
    },
  }
  return Object.freeze(client)
}

export function createApprovalClient(input: {
  scope: ServiceScope
  transport: SdkTransport
}): ApprovalClient {
  const scope = validateServiceScope(input.scope)
  const transport = requireTransport(input.transport)
  const send = (request: Omit<SdkTransportRequest, 'schemaVersion' | 'scope'>) => transport.send({
    schemaVersion: SDK_TRANSPORT_REQUEST_SCHEMA_VERSION,
    scope,
    ...request,
  })
  const client: ApprovalClient = {
    async list(request) {
      version(request, 'approval-client-list/v1', 'ApprovalClient.list')
      return publicApprovalList(await send({
        method: 'GET',
        path: '/api/approvals',
        query: jsonObject(request),
      }), scope, request.runId)
    },
    async resolve(request) {
      version(request, 'approval-client-resolve/v1', 'ApprovalClient.resolve')
      return publicApproval(await send({
        method: 'POST',
        path: `/api/approvals/${segment(request.approvalId)}/resolve`,
        body: jsonObject(request),
      }), scope, request.approvalId)
    },
  }
  return Object.freeze(client)
}

async function control(
  send: (request: Omit<SdkTransportRequest, 'schemaVersion' | 'scope'>) => Promise<unknown>,
  scope: ServiceScope,
  action: 'pause' | 'resume' | 'cancel',
  request: RunControlRequest,
): Promise<PublicRun> {
  version(request, 'run-client-control/v1', `RunClient.${action}`)
  return publicRun(await send({
    method: 'POST',
    path: `/api/runs/${segment(request.runId)}/${action}`,
    body: jsonObject(request),
  }), scope, request.runId)
}

function publicRun(value: unknown, scope: ServiceScope, expectedRunId?: string): PublicRun {
  const record = object(value, 'PublicRun')
  if (record.schemaVersion !== PUBLIC_RUN_SCHEMA_VERSION) unsupported('PublicRun')
  const resourceScope = validateServiceScope(record.scope)
  assertServiceScopeAccess(scope, resourceScope)
  if (!RUN_STATES.has(String(record.state))) transportError('PublicRun.state is invalid.')
  const runId = requiredString(record.runId, 'PublicRun.runId')
  if (expectedRunId !== undefined && runId !== expectedRunId) {
    transportError('PublicRun.runId does not match the request.')
  }
  return {
    schemaVersion: PUBLIC_RUN_SCHEMA_VERSION,
    runId,
    revision: nonNegative(record.revision, 'PublicRun.revision'),
    attempt: positive(record.attempt, 'PublicRun.attempt'),
    state: record.state as RunLifecycleState,
    scope: resourceScope,
    updatedAt: requiredTimestamp(record.updatedAt, 'PublicRun.updatedAt'),
    ...(record.reason === undefined ? {} : { reason: requiredString(record.reason, 'PublicRun.reason') }),
    ...(record.pendingContinuation === undefined
      ? {}
      : { pendingContinuation: publicContinuation(record.pendingContinuation) }),
  }
}

function publicContinuation(value: unknown): PublicContinuation {
  const continuation = object(value, 'PublicRun.pendingContinuation')
  const question = object(continuation.question, 'PublicRun.pendingContinuation.question')
  if (!CONTINUATION_KINDS.has(String(continuation.kind))) {
    transportError('PublicRun.pendingContinuation.kind is invalid.')
  }
  if (continuation.status !== 'pending' && continuation.status !== 'answered') {
    transportError('PublicRun.pendingContinuation.status is invalid.')
  }
  if (question.options !== undefined && !Array.isArray(question.options)) {
    transportError('PublicRun.pendingContinuation.question.options must be an array.')
  }
  return {
    continuationId: requiredString(
      continuation.continuationId,
      'PublicRun.pendingContinuation.continuationId',
    ),
    kind: continuation.kind as PublicContinuation['kind'],
    status: continuation.status,
    question: {
      questionId: requiredString(
        question.questionId,
        'PublicRun.pendingContinuation.question.questionId',
      ),
      field: requiredString(question.field, 'PublicRun.pendingContinuation.question.field'),
      prompt: requiredString(question.prompt, 'PublicRun.pendingContinuation.question.prompt'),
      ...(question.options === undefined
        ? {}
        : {
            options: question.options.map((option, index) =>
              requiredString(option, `PublicRun.pendingContinuation.question.options[${index}]`)),
          }),
    },
    requestedAt: requiredTimestamp(
      continuation.requestedAt,
      'PublicRun.pendingContinuation.requestedAt',
    ),
  }
}

function publicRunList(value: unknown, scope: ServiceScope): PublicRunList {
  const page = object(value, 'PublicRunList')
  if (page.schemaVersion !== PUBLIC_RUN_LIST_SCHEMA_VERSION || !Array.isArray(page.items)) {
    transportError('PublicRunList response is invalid.')
  }
  return {
    schemaVersion: PUBLIC_RUN_LIST_SCHEMA_VERSION,
    items: page.items.map((item) => publicRun(item, scope)),
    ...(typeof page.nextCursor === 'string' ? { nextCursor: page.nextCursor } : {}),
  }
}

function publicRunEvents(value: unknown, scope: ServiceScope, runId: string): PublicRunEvents {
  rejectForeignLegacyCollection(value, scope)
  const response = object(value, 'PublicRunEvents')
  closed(response, ['schemaVersion', 'scope', 'runId', 'items'], 'PublicRunEvents')
  if (response.schemaVersion !== PUBLIC_RUN_EVENTS_SCHEMA_VERSION || !Array.isArray(response.items)) {
    transportError('PublicRunEvents response is invalid.')
  }
  const resourceScope = validateServiceScope(response.scope)
  assertServiceScopeAccess(scope, resourceScope)
  if (requiredString(response.runId, 'PublicRunEvents.runId') !== runId) {
    transportError('PublicRunEvents.runId does not match the request.')
  }
  const items = response.items.map((value, index) => publicRunEvent(value, runId, index))
  for (let index = 1; index < items.length; index += 1) {
    const previous = items[index - 1]
    const current = items[index]
    if (current.sequence <= previous.sequence
      || current.revision < previous.revision
      || Date.parse(current.timestamp) < Date.parse(previous.timestamp)) {
      transportError(`PublicRunEvents.items[${index}] is not a strictly ordered event stream.`)
    }
  }
  return {
    schemaVersion: PUBLIC_RUN_EVENTS_SCHEMA_VERSION,
    scope: resourceScope,
    runId,
    items,
  }
}

function publicRunEvent(value: unknown, runId: string, index: number): WebTaskEvent {
  const label = `PublicRunEvents.items[${index}]`
  const event = object(value, label)
  closed(event, [
    'schemaVersion', 'sequence', 'type', 'timestamp', 'runId', 'revision', 'snapshot', 'data',
  ], label)
  if (event.schemaVersion !== 'web-task-event/v1') transportError(`${label}.schemaVersion is invalid.`)
  if (requiredString(event.runId, `${label}.runId`) !== runId) {
    transportError(`${label}.runId does not match the response Run.`)
  }
  const revision = nonNegative(event.revision, `${label}.revision`)
  const snapshot = event.snapshot === undefined
    ? undefined
    : publicRunSnapshot(event.snapshot, runId, revision, label)
  if (event.data !== undefined) {
    try {
      canonicalJson(event.data)
    } catch (error) {
      transportError(`${label}.data is not JSON-safe: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return {
    schemaVersion: 'web-task-event/v1',
    sequence: nonNegative(event.sequence, `${label}.sequence`),
    type: requiredString(event.type, `${label}.type`),
    timestamp: requiredTimestamp(event.timestamp, `${label}.timestamp`),
    runId,
    revision,
    ...(snapshot ? { snapshot } : {}),
    ...(event.data === undefined ? {} : { data: structuredClone(event.data) as JsonObject }),
  }
}

function publicRunSnapshot(
  value: unknown,
  runId: string,
  revision: number,
  eventLabel: string,
): NonNullable<WebTaskEvent['snapshot']> {
  const label = `${eventLabel}.snapshot`
  const snapshot = object(value, label)
  closed(snapshot, [
    'schemaVersion', 'runId', 'sessionRef', 'revision', 'attempt', 'state',
    'checkpointRef', 'updatedAt', 'reason',
  ], label)
  if (snapshot.schemaVersion !== 'run-snapshot/v1') transportError(`${label}.schemaVersion is invalid.`)
  const attempt = positive(snapshot.attempt, `${label}.attempt`)
  if (requiredString(snapshot.runId, `${label}.runId`) !== runId
    || nonNegative(snapshot.revision, `${label}.revision`) !== revision) {
    transportError(`${label} does not match its event Run/revision.`)
  }
  if (!RUN_STATES.has(String(snapshot.state))) transportError(`${label}.state is invalid.`)
  try {
    if (snapshot.sessionRef !== undefined) validateSessionRef(snapshot.sessionRef as SessionRef, runId, attempt)
    if (snapshot.checkpointRef !== undefined) validateCheckpointRef(snapshot.checkpointRef as CheckpointRef)
  } catch (error) {
    transportError(`${label} durable reference is invalid: ${error instanceof Error ? error.message : String(error)}`)
  }
  return {
    schemaVersion: 'run-snapshot/v1',
    runId,
    ...(snapshot.sessionRef === undefined
      ? {}
      : { sessionRef: structuredClone(snapshot.sessionRef) as SessionRef }),
    revision,
    attempt,
    state: snapshot.state as RunLifecycleState,
    ...(snapshot.checkpointRef === undefined
      ? {}
      : { checkpointRef: structuredClone(snapshot.checkpointRef) as CheckpointRef }),
    updatedAt: requiredTimestamp(snapshot.updatedAt, `${label}.updatedAt`),
    ...(snapshot.reason === undefined ? {} : { reason: requiredString(snapshot.reason, `${label}.reason`) }),
  }
}

function publicArtifactList(value: unknown, scope: ServiceScope, runId: string): PublicArtifactList {
  rejectForeignLegacyCollection(value, scope)
  const response = object(value, 'PublicArtifactList')
  closed(response, ['schemaVersion', 'scope', 'runId', 'items'], 'PublicArtifactList')
  if (response.schemaVersion !== PUBLIC_ARTIFACT_LIST_SCHEMA_VERSION || !Array.isArray(response.items)) {
    transportError('PublicArtifactList response is invalid.')
  }
  const resourceScope = validateServiceScope(response.scope)
  assertServiceScopeAccess(scope, resourceScope)
  if (requiredString(response.runId, 'PublicArtifactList.runId') !== runId) {
    transportError('PublicArtifactList.runId does not match the request.')
  }
  const items = response.items.map((value, index) => {
    const artifact = structuredClone(value) as ArtifactRef
    try {
      const revision = nonNegative(artifact?.binding?.revision, `PublicArtifactList.items[${index}].binding.revision`)
      validateArtifactRef(artifact, runId, revision)
    } catch (error) {
      transportError(`PublicArtifactList.items[${index}] is invalid: ${error instanceof Error ? error.message : String(error)}`)
    }
    const expectedOwnerScope = resourceScope.kind === 'local'
      ? undefined
      : {
          schemaVersion: 'owner-scope/v1' as const,
          tenantId: resourceScope.tenantId,
          userId: resourceScope.userId,
        }
    if ((expectedOwnerScope === undefined && artifact.ownerScope !== undefined)
      || (expectedOwnerScope !== undefined
        && (artifact.ownerScope === undefined
          || canonicalJson(artifact.ownerScope) !== canonicalJson(expectedOwnerScope)))) {
      transportError(`PublicArtifactList.items[${index}] owner scope does not match the response scope.`)
    }
    return artifact
  })
  return {
    schemaVersion: PUBLIC_ARTIFACT_LIST_SCHEMA_VERSION,
    scope: resourceScope,
    runId,
    items,
  }
}

function publicApproval(
  value: unknown,
  scope: ServiceScope,
  expectedApprovalId?: string,
  expectedRunId?: string,
): PublicApproval {
  const approval = object(value, 'PublicApproval')
  if (approval.schemaVersion !== PUBLIC_APPROVAL_SCHEMA_VERSION) unsupported('PublicApproval')
  const resourceScope = validateServiceScope(approval.scope)
  assertServiceScopeAccess(scope, resourceScope)
  if (!APPROVAL_STATES.has(String(approval.status))) transportError('PublicApproval.status is invalid.')
  const approvalId = requiredString(approval.approvalId, 'PublicApproval.approvalId')
  if (expectedApprovalId !== undefined && approvalId !== expectedApprovalId) {
    transportError('PublicApproval.approvalId does not match the request.')
  }
  const runId = requiredString(approval.runId, 'PublicApproval.runId')
  if (expectedRunId !== undefined && runId !== expectedRunId) {
    transportError('PublicApproval.runId does not match the list request.')
  }
  const action = object(approval.action, 'PublicApproval.action')
  if (!Array.isArray(approval.allowedDecisions)
    || approval.allowedDecisions.length === 0
    || new Set(approval.allowedDecisions).size !== approval.allowedDecisions.length
    || approval.allowedDecisions.some((decision) => (
      decision !== 'approved'
      && decision !== 'approved_and_execute'
      && decision !== 'denied'
    ))) {
    transportError('PublicApproval.allowedDecisions is invalid.')
  }
  const externalActionKind = action.externalActionKind === undefined
    ? undefined
    : requiredExternalActionKind(action.externalActionKind)
  const externalEffectPreview = action.externalEffectPreview === undefined
    ? undefined
    : requiredEffectPreview(action.externalEffectPreview)
  const externalBusinessKey = action.externalBusinessKey === undefined
    ? undefined
    : requiredCanonicalString(action.externalBusinessKey, 'PublicApproval.action.externalBusinessKey', 1_024)
  const externalEffectDigest = action.externalEffectDigest === undefined
    ? undefined
    : requiredSha256(action.externalEffectDigest, 'PublicApproval.action.externalEffectDigest')
  const externalProbeId = action.externalProbeId === undefined
    ? undefined
    : requiredCanonicalString(action.externalProbeId, 'PublicApproval.action.externalProbeId', 256)
  const externalIdentity = [externalBusinessKey, externalEffectDigest, externalProbeId]
  if (externalIdentity.some((item) => item !== undefined)
    && externalIdentity.some((item) => item === undefined)) {
    transportError('PublicApproval.action external identity must include business key, digest and probe id together.')
  }
  if ((externalActionKind !== undefined || externalEffectPreview !== undefined)
    && externalIdentity.some((item) => item === undefined)) {
    transportError('PublicApproval.action semantic kind and preview require a complete external identity.')
  }
  if (approval.allowedDecisions.includes('approved_and_execute')
    && (externalActionKind === undefined
      || externalIdentity.some((item) => item === undefined)
      || externalEffectPreview === undefined)) {
    transportError('PublicApproval cannot offer approved_and_execute without a reviewable external effect.')
  }
  const requestedAt = requiredTimestamp(approval.requestedAt, 'PublicApproval.requestedAt')
  const expiresAt = requiredTimestamp(approval.expiresAt, 'PublicApproval.expiresAt')
  if (Date.parse(expiresAt) <= Date.parse(requestedAt)) {
    transportError('PublicApproval.expiresAt must follow requestedAt.')
  }
  return {
    schemaVersion: PUBLIC_APPROVAL_SCHEMA_VERSION,
    approvalId,
    runId,
    revision: nonNegative(approval.revision, 'PublicApproval.revision'),
    attempt: positive(approval.attempt, 'PublicApproval.attempt'),
    status: approval.status as PublicApproval['status'],
    scope: resourceScope,
    action: {
      actionId: requiredString(action.actionId, 'PublicApproval.action.actionId'),
      kind: requiredString(action.kind, 'PublicApproval.action.kind'),
      ...(action.sourceOrigin === undefined
        ? {}
        : { sourceOrigin: requiredOrigin(action.sourceOrigin, 'PublicApproval.action.sourceOrigin') }),
      ...(action.destinationOrigin === undefined
        ? {}
        : { destinationOrigin: requiredOrigin(action.destinationOrigin, 'PublicApproval.action.destinationOrigin') }),
      ...(action.externalBusinessKey === undefined
        ? {}
        : { externalBusinessKey }),
      ...(action.externalEffectDigest === undefined
        ? {}
        : { externalEffectDigest }),
      ...(action.externalProbeId === undefined
        ? {}
        : { externalProbeId }),
      ...(action.externalActionKind === undefined
        ? {}
        : { externalActionKind }),
      ...(action.externalEffectPreview === undefined
        ? {}
        : { externalEffectPreview }),
    },
    allowedDecisions: [...approval.allowedDecisions] as PublicApproval['allowedDecisions'],
    requestedAt,
    expiresAt,
  }
}

function publicApprovalList(
  value: unknown,
  scope: ServiceScope,
  expectedRunId?: string,
): PublicApprovalList {
  const page = object(value, 'PublicApprovalList')
  if (page.schemaVersion !== PUBLIC_APPROVAL_LIST_SCHEMA_VERSION || !Array.isArray(page.items)) {
    transportError('PublicApprovalList response is invalid.')
  }
  return {
    schemaVersion: PUBLIC_APPROVAL_LIST_SCHEMA_VERSION,
    items: page.items.map((item) => publicApproval(item, scope, undefined, expectedRunId)),
    ...(typeof page.nextCursor === 'string' ? { nextCursor: page.nextCursor } : {}),
  }
}

function version(value: unknown, expected: string, label: string): void {
  const request = object(value, label)
  if (request.schemaVersion !== expected) unsupported(label)
}

function requireTransport(value: unknown): SdkTransport {
  if (!value || typeof value !== 'object' || typeof (value as SdkTransport).send !== 'function') {
    throw new PublicContractError('INVALID_CONTRACT', 'SDK transport must expose send().')
  }
  return value as SdkTransport
}

function jsonObject(value: unknown): JsonObject {
  try {
    return JSON.parse(JSON.stringify(value)) as JsonObject
  } catch {
    throw new PublicContractError('INVALID_CONTRACT', 'Client request must be JSON-safe.')
  }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) transportError(`${label} must be an object.`)
  return value as Record<string, unknown>
}

function closed(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const allowed = new Set(keys)
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) transportError(`${label} contains unsupported field ${key}.`)
  }
}

function rejectForeignLegacyCollection(value: unknown, scope: ServiceScope): void {
  if (!Array.isArray(value)) return
  for (const item of value) {
    if (item && typeof item === 'object' && !Array.isArray(item) && 'scope' in item) {
      assertServiceScopeAccess(scope, validateServiceScope((item as Record<string, unknown>).scope))
    }
  }
  transportError('Unscoped collection responses are not supported.')
}

function segment(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new PublicContractError('INVALID_CONTRACT', 'Resource id must be non-empty.')
  }
  return encodeURIComponent(value)
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) transportError(`${label} must be non-empty.`)
  return value
}

function requiredTimestamp(value: unknown, label: string): string {
  const result = requiredString(value, label)
  const parsed = Date.parse(result)
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== result) {
    transportError(`${label} must be a canonical UTC timestamp.`)
  }
  return result
}

function requiredSha256(value: unknown, label: string): string {
  const result = requiredString(value, label)
  if (!/^[a-f0-9]{64}$/i.test(result)) transportError(`${label} must be a SHA-256 digest.`)
  return result
}

function requiredCanonicalString(value: unknown, label: string, maxLength: number): string {
  const result = requiredString(value, label)
  if (result !== result.trim() || result.length > maxLength) {
    transportError(`${label} must be a bounded canonical string.`)
  }
  return result
}

function requiredOrigin(value: unknown, label: string): string {
  const result = requiredString(value, label)
  try {
    const parsed = new URL(result)
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== result) throw new Error('not canonical')
  } catch {
    transportError(`${label} must be a canonical HTTP(S) origin.`)
  }
  return result
}

function requiredExternalActionKind(value: unknown): 'upload' | 'send' | 'publish' | 'submit' | 'payment' {
  if (value !== 'upload' && value !== 'send' && value !== 'publish' && value !== 'submit' && value !== 'payment') {
    transportError('PublicApproval.action.externalActionKind is invalid.')
  }
  return value
}

function requiredEffectPreview(value: unknown): string {
  const preview = requiredString(value, 'PublicApproval.action.externalEffectPreview')
  if (preview.length > 1_024 || preview !== preview.trim()) {
    transportError('PublicApproval.action.externalEffectPreview must be bounded review text.')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(preview)
  } catch {
    transportError('PublicApproval.action.externalEffectPreview must be JSON.')
  }
  if (canonicalJson(parsed) !== preview) {
    transportError('PublicApproval.action.externalEffectPreview must be canonical JSON.')
  }
  if (redactSensitiveData(parsed).changed) {
    transportError('PublicApproval.action.externalEffectPreview must not contain secret-bearing material.')
  }
  return preview
}

function nonNegative(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) transportError(`${label} must be non-negative.`)
  return value as number
}

function positive(value: unknown, label: string): number {
  const result = nonNegative(value, label)
  if (result === 0) transportError(`${label} must be positive.`)
  return result
}

function unsupported(label: string): never {
  throw new PublicContractError('UNSUPPORTED_SCHEMA_VERSION', `${label} schema version is unsupported.`)
}

function transportError(message: string): never {
  throw new PublicContractError('TRANSPORT_ERROR', message)
}

const RUN_STATES = new Set<string>([
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
const CONTINUATION_KINDS = new Set<string>([
  'needs_information',
  'human_takeover',
  'operator_pause',
  'external_blocker',
])
const APPROVAL_STATES = new Set<string>(['pending', 'approved', 'denied', 'expired', 'cancelled'])
