import type {
  ArtifactRef,
  JsonObject,
  RunLifecycleState,
  WebTaskEvent,
  WebTaskInputSnapshot,
} from './contracts.js'
import {
  PublicContractError,
} from './task.js'
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
  }
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
    decision: 'approved' | 'denied'
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
      }), scope)
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
      return value === undefined || value === null ? undefined : publicRun(value, scope)
    },
    pause: (request) => control(send, scope, 'pause', request),
    resume: (request) => control(send, scope, 'resume', request),
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
      }), scope)
    },
    async resolve(request) {
      version(request, 'approval-client-resolve/v1', 'ApprovalClient.resolve')
      return publicApproval(await send({
        method: 'POST',
        path: `/api/approvals/${segment(request.approvalId)}/resolve`,
        body: jsonObject(request),
      }), scope)
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
  }), scope)
}

function publicRun(value: unknown, scope: ServiceScope): PublicRun {
  const record = object(value, 'PublicRun')
  if (record.schemaVersion !== PUBLIC_RUN_SCHEMA_VERSION) unsupported('PublicRun')
  const resourceScope = validateServiceScope(record.scope)
  assertServiceScopeAccess(scope, resourceScope)
  if (!RUN_STATES.has(String(record.state))) transportError('PublicRun.state is invalid.')
  return {
    schemaVersion: PUBLIC_RUN_SCHEMA_VERSION,
    runId: requiredString(record.runId, 'PublicRun.runId'),
    revision: nonNegative(record.revision, 'PublicRun.revision'),
    attempt: positive(record.attempt, 'PublicRun.attempt'),
    state: record.state as RunLifecycleState,
    scope: resourceScope,
    updatedAt: requiredTimestamp(record.updatedAt, 'PublicRun.updatedAt'),
    ...(record.reason === undefined ? {} : { reason: requiredString(record.reason, 'PublicRun.reason') }),
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
  return {
    schemaVersion: PUBLIC_RUN_EVENTS_SCHEMA_VERSION,
    scope: resourceScope,
    runId,
    items: structuredClone(response.items) as WebTaskEvent[],
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
  return {
    schemaVersion: PUBLIC_ARTIFACT_LIST_SCHEMA_VERSION,
    scope: resourceScope,
    runId,
    items: structuredClone(response.items) as ArtifactRef[],
  }
}

function publicApproval(value: unknown, scope: ServiceScope): PublicApproval {
  const approval = object(value, 'PublicApproval')
  if (approval.schemaVersion !== PUBLIC_APPROVAL_SCHEMA_VERSION) unsupported('PublicApproval')
  const resourceScope = validateServiceScope(approval.scope)
  assertServiceScopeAccess(scope, resourceScope)
  if (!APPROVAL_STATES.has(String(approval.status))) transportError('PublicApproval.status is invalid.')
  const action = object(approval.action, 'PublicApproval.action')
  return {
    schemaVersion: PUBLIC_APPROVAL_SCHEMA_VERSION,
    approvalId: requiredString(approval.approvalId, 'PublicApproval.approvalId'),
    runId: requiredString(approval.runId, 'PublicApproval.runId'),
    revision: nonNegative(approval.revision, 'PublicApproval.revision'),
    attempt: positive(approval.attempt, 'PublicApproval.attempt'),
    status: approval.status as PublicApproval['status'],
    scope: resourceScope,
    action: {
      actionId: requiredString(action.actionId, 'PublicApproval.action.actionId'),
      kind: requiredString(action.kind, 'PublicApproval.action.kind'),
      ...(action.sourceOrigin === undefined
        ? {}
        : { sourceOrigin: requiredString(action.sourceOrigin, 'PublicApproval.action.sourceOrigin') }),
      ...(action.destinationOrigin === undefined
        ? {}
        : { destinationOrigin: requiredString(action.destinationOrigin, 'PublicApproval.action.destinationOrigin') }),
    },
    requestedAt: requiredTimestamp(approval.requestedAt, 'PublicApproval.requestedAt'),
    expiresAt: requiredTimestamp(approval.expiresAt, 'PublicApproval.expiresAt'),
  }
}

function publicApprovalList(value: unknown, scope: ServiceScope): PublicApprovalList {
  const page = object(value, 'PublicApprovalList')
  if (page.schemaVersion !== PUBLIC_APPROVAL_LIST_SCHEMA_VERSION || !Array.isArray(page.items)) {
    transportError('PublicApprovalList response is invalid.')
  }
  return {
    schemaVersion: PUBLIC_APPROVAL_LIST_SCHEMA_VERSION,
    items: page.items.map((item) => publicApproval(item, scope)),
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
  if (!Number.isFinite(Date.parse(result))) transportError(`${label} must be a timestamp.`)
  return result
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
const APPROVAL_STATES = new Set<string>(['pending', 'approved', 'denied', 'expired', 'cancelled'])
