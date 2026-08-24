import {
  appendFile,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { JsonObject, OwnerScope } from '../task/contracts.js'
import {
  APPROVAL_EVENT_SCHEMA_VERSION,
  APPROVAL_RECORD_SCHEMA_VERSION,
  ControlStoreError,
  RUN_EVENT_SCHEMA_VERSION,
  controlRecordDigest,
  decodeApprovalRecord,
  decodeRunRecord,
  validateApprovalCreate,
  validateApprovalMutation,
  validateApprovalRecord,
  validateApprovalResolve,
  validateRunCreate,
  validateRunMutation,
  type ApprovalEventQuery,
  type ApprovalListQuery,
  type ApprovalRecord,
  type ApprovalResolveCommand,
  type ApprovalStore,
  type ApprovalStoreCreate,
  type ApprovalStoreEvent,
  type ApprovalStoreMutation,
  type RunEventQuery,
  type RunListQuery,
  type RunRecord,
  type RunStore,
  type RunStoreCreate,
  type RunStoreEvent,
  type RunStoreMutation,
  type ScopedStoreQuery,
  type StoreCommit,
  type StorePage,
} from './store-contracts.js'

export type FileControlStoreFaultPoint =
  | 'after_wal'
  | 'after_record'
  | 'after_event'
  | 'after_idempotency'

export interface FileControlStoreOptions {
  rootDir: string
  faultInjector?: (point: FileControlStoreFaultPoint, entity: {
    kind: 'run' | 'approval'
    id: string
  }) => void | Promise<void>
}

interface IdempotencyEntry<TRecord, TEvent> {
  requestDigest: string
  record: TRecord
  event: TEvent
}

interface IdempotencyFile<TRecord, TEvent> {
  schemaVersion: 'control-idempotency/v1'
  entries: Record<string, IdempotencyEntry<TRecord, TEvent>>
}

interface WalEntry<TRecord, TEvent> {
  schemaVersion: 'control-store-wal/v1'
  kind: 'run' | 'approval'
  id: string
  idempotencyKey: string
  requestDigest: string
  payloadDigest: string
  record: TRecord
  event: TEvent
  writtenAt: string
}

interface EntityPaths {
  dir: string
  record: string
  events: string
  idempotency: string
  wal: string
  lock: string
}

const processLocks = new Map<string, Promise<void>>()

export class FileRunStore implements RunStore {
  private readonly options: FileControlStoreOptions

  constructor(options: FileControlStoreOptions) {
    this.options = options
  }

  async create(input: RunStoreCreate): Promise<StoreCommit<RunRecord, RunStoreEvent>> {
    const paths = fileControlStorePaths(this.options.rootDir, 'run', input.record.runId, input.record.ownerScope)
    return withEntityLock(paths, async () => {
      await recoverEntity(paths, 'run', input.record.runId, decodeRunRecord)
      const requestDigest = controlRecordDigest(input)
      const replay = await replayFor<RunRecord, RunStoreEvent>(paths, input.options.idempotencyKey, requestDigest)
      if (replay) return replay
      if (await readRecord(paths, decodeRunRecord)) {
        throw new ControlStoreError('RUN_ALREADY_EXISTS', `Run already exists: ${input.record.runId}`)
      }
      validateRunCreate(input)
      return commitEntity(
        this.options,
        paths,
        'run',
        input.record.runId,
        input.options.idempotencyKey,
        requestDigest,
        input.record,
        input.event,
      )
    })
  }

  async get(runId: string, scope?: ScopedStoreQuery): Promise<RunRecord | undefined> {
    const paths = fileControlStorePaths(this.options.rootDir, 'run', runId, scope?.ownerScope)
    return withEntityLock(paths, async () => {
      await recoverEntity(paths, 'run', runId, decodeRunRecord)
      return readRecord(paths, decodeRunRecord)
    })
  }

  async list(query: RunListQuery = {}): Promise<StorePage<RunRecord>> {
    const records = await listRecords(
      this.options.rootDir,
      'run',
      query.ownerScope,
      decodeRunRecord,
    )
    const filtered = query.states?.length
      ? records.filter((record) => query.states!.includes(record.state))
      : records
    return page(filtered, query.limit, query.cursor)
  }

  async listOwnerScopes(): Promise<OwnerScope[]> {
    const scopesRoot = join(this.options.rootDir, 'scopes')
    let scopeEntries
    try {
      scopeEntries = await readdir(scopesRoot, { withFileTypes: true })
    } catch (error) {
      if (isNotFound(error)) return []
      throw error
    }
    const discovered = new Map<string, OwnerScope>()
    for (const scopeEntry of scopeEntries) {
      if (!scopeEntry.isDirectory() || !scopeEntry.name.startsWith('scope-')) continue
      const runsDir = join(scopesRoot, scopeEntry.name, 'runs')
      let runEntries
      try {
        runEntries = await readdir(runsDir, { withFileTypes: true })
      } catch (error) {
        if (isNotFound(error)) continue
        throw error
      }
      for (const runEntry of runEntries) {
        if (!runEntry.isDirectory()) continue
        try {
          const record = decodeRunRecord(JSON.parse(
            await readFile(join(runsDir, runEntry.name, 'record.json'), 'utf8'),
          ))
          if (record.ownerScope) {
            discovered.set(controlRecordDigest(record.ownerScope), record.ownerScope)
            break
          }
        } catch {
          // A corrupt entity is handled by its normal scoped recovery path.
        }
      }
    }
    return [...discovered.values()].map((scope) => structuredClone(scope))
  }

  async transact(
    runId: string,
    mutation: RunStoreMutation,
  ): Promise<StoreCommit<RunRecord, RunStoreEvent>> {
    const paths = fileControlStorePaths(this.options.rootDir, 'run', runId, mutation.record.ownerScope)
    return withEntityLock(paths, async () => {
      await recoverEntity(paths, 'run', runId, decodeRunRecord)
      const requestDigest = controlRecordDigest(mutation)
      const replay = await replayFor<RunRecord, RunStoreEvent>(paths, mutation.idempotencyKey, requestDigest)
      if (replay) return replay
      const current = await readRecord(paths, decodeRunRecord)
      if (!current) throw new ControlStoreError('RUN_NOT_FOUND', `Run not found: ${runId}`)
      validateRunMutation(current, mutation)
      return commitEntity(
        this.options,
        paths,
        'run',
        runId,
        mutation.idempotencyKey,
        requestDigest,
        mutation.record,
        mutation.event,
      )
    })
  }

  async readEvents(runId: string, query: RunEventQuery = {}): Promise<StorePage<RunStoreEvent>> {
    const paths = fileControlStorePaths(this.options.rootDir, 'run', runId, query.ownerScope)
    return withEntityLock(paths, async () => {
      await recoverEntity(paths, 'run', runId, decodeRunRecord)
      const events = await readEvents<RunStoreEvent>(paths, isRunEvent)
      const filtered = query.afterSequence === undefined
        ? events
        : events.filter((event) => event.eventSequence > query.afterSequence!)
      return page(filtered, query.limit)
    })
  }
}

export class FileApprovalStore implements ApprovalStore {
  private readonly options: FileControlStoreOptions

  constructor(options: FileControlStoreOptions) {
    this.options = options
  }

  async create(input: ApprovalStoreCreate): Promise<StoreCommit<ApprovalRecord, ApprovalStoreEvent>> {
    const paths = fileControlStorePaths(this.options.rootDir, 'approval', input.record.approvalId, input.record.ownerScope)
    return withEntityLock(paths, async () => {
      await recoverEntity(paths, 'approval', input.record.approvalId, decodeApprovalRecord)
      const requestDigest = controlRecordDigest(input)
      const replay = await replayFor<ApprovalRecord, ApprovalStoreEvent>(paths, input.options.idempotencyKey, requestDigest)
      if (replay) return replay
      if (await readRecord(paths, decodeApprovalRecord)) {
        throw new ControlStoreError('APPROVAL_ALREADY_EXISTS', `Approval already exists: ${input.record.approvalId}`)
      }
      validateApprovalCreate(input)
      return commitEntity(
        this.options,
        paths,
        'approval',
        input.record.approvalId,
        input.options.idempotencyKey,
        requestDigest,
        input.record,
        input.event,
      )
    })
  }

  async get(approvalId: string, scope?: ScopedStoreQuery): Promise<ApprovalRecord | undefined> {
    const paths = fileControlStorePaths(this.options.rootDir, 'approval', approvalId, scope?.ownerScope)
    return withEntityLock(paths, async () => {
      await recoverEntity(paths, 'approval', approvalId, decodeApprovalRecord)
      return readRecord(paths, decodeApprovalRecord)
    })
  }

  async list(query: ApprovalListQuery = {}): Promise<StorePage<ApprovalRecord>> {
    const records = await listRecords(
      this.options.rootDir,
      'approval',
      query.ownerScope,
      decodeApprovalRecord,
    )
    const filtered = records.filter((record) =>
      (!query.statuses?.length || query.statuses.includes(record.status))
      && (!query.runId || record.runId === query.runId))
    return page(filtered, query.limit, query.cursor)
  }

  async transact(
    approvalId: string,
    mutation: ApprovalStoreMutation,
  ): Promise<StoreCommit<ApprovalRecord, ApprovalStoreEvent>> {
    const paths = fileControlStorePaths(this.options.rootDir, 'approval', approvalId, mutation.record.ownerScope)
    return withEntityLock(paths, async () => {
      await recoverEntity(paths, 'approval', approvalId, decodeApprovalRecord)
      const requestDigest = controlRecordDigest(mutation)
      const replay = await replayFor<ApprovalRecord, ApprovalStoreEvent>(paths, mutation.idempotencyKey, requestDigest)
      if (replay) return replay
      const current = await readRecord(paths, decodeApprovalRecord)
      if (!current) throw new ControlStoreError('APPROVAL_NOT_FOUND', `Approval not found: ${approvalId}`)
      validateApprovalMutation(current, mutation)
      return commitEntity(
        this.options,
        paths,
        'approval',
        approvalId,
        mutation.idempotencyKey,
        requestDigest,
        mutation.record,
        mutation.event,
      )
    })
  }

  async resolveOnce(
    command: ApprovalResolveCommand,
  ): Promise<StoreCommit<ApprovalRecord, ApprovalStoreEvent>> {
    const paths = fileControlStorePaths(
      this.options.rootDir,
      'approval',
      command.approvalId,
      command.ownerScope,
    )
    return withEntityLock(paths, async () => {
      await recoverEntity(paths, 'approval', command.approvalId, decodeApprovalRecord)
      const requestDigest = approvalResolutionRequestDigest(command)
      const replay = await replayFor<ApprovalRecord, ApprovalStoreEvent>(paths, command.idempotencyKey, requestDigest)
      if (replay) return replay
      const current = await readRecord(paths, decodeApprovalRecord)
      if (!current) throw new ControlStoreError('APPROVAL_NOT_FOUND', `Approval not found: ${command.approvalId}`)
      validateApprovalResolve(current, command)
      const record: ApprovalRecord = {
        ...current,
        recordRevision: current.recordRevision + 1,
        status: command.resolution.decision,
        resolution: command.resolution,
        terminal: {
          status: command.resolution.decision,
          source: 'user',
          occurredAt: command.resolvedAt,
        },
        nextEventSequence: current.nextEventSequence + 1,
        updatedAt: command.resolvedAt,
      }
      validateApprovalRecord(record)
      const event: ApprovalStoreEvent = {
        schemaVersion: APPROVAL_EVENT_SCHEMA_VERSION,
        eventId: `${command.approvalId}:event:${current.nextEventSequence}`,
        eventSequence: current.nextEventSequence,
        eventType: 'approval_resolved',
        approvalId: command.approvalId,
        runId: current.runId,
        recordRevisionBefore: current.recordRevision,
        recordRevisionAfter: record.recordRevision,
        runRevision: current.runRevision,
        attempt: current.attempt,
        actionId: current.actionBinding.actionId,
        occurredAt: command.resolvedAt,
        idempotencyKey: command.idempotencyKey,
        ...(current.ownerScope ? { ownerScope: current.ownerScope } : {}),
        data: { decision: command.resolution.decision },
      }
      return commitEntity(
        this.options,
        paths,
        'approval',
        command.approvalId,
        command.idempotencyKey,
        requestDigest,
        record,
        event,
      )
    })
  }

  async readEvents(
    approvalId: string,
    query: ApprovalEventQuery = {},
  ): Promise<StorePage<ApprovalStoreEvent>> {
    const paths = fileControlStorePaths(this.options.rootDir, 'approval', approvalId, query.ownerScope)
    return withEntityLock(paths, async () => {
      await recoverEntity(paths, 'approval', approvalId, decodeApprovalRecord)
      const events = await readEvents<ApprovalStoreEvent>(paths, isApprovalEvent)
      const filtered = query.afterSequence === undefined
        ? events
        : events.filter((event) => event.eventSequence > query.afterSequence!)
      return page(filtered, query.limit)
    })
  }
}

export function fileControlStorePaths(
  rootDir: string,
  kind: 'run' | 'approval',
  id: string,
  ownerScope?: OwnerScope,
): EntityPaths {
  const collection = kind === 'run' ? 'runs' : 'approvals'
  const dir = join(rootDir, 'scopes', scopeKey(ownerScope), collection, encodeId(id))
  return {
    dir,
    record: join(dir, 'record.json'),
    events: join(dir, 'events.jsonl'),
    idempotency: join(dir, 'idempotency.json'),
    wal: join(dir, 'transaction.wal.json'),
    lock: join(dir, 'writer.lock'),
  }
}

function approvalResolutionRequestDigest(command: ApprovalResolveCommand): string {
  const {
    resolvedAt: _resolvedAt,
    resolution,
    ...stableCommand
  } = command
  const {
    issuedAt: _issuedAt,
    nonce: _nonce,
    consumedAt: _consumedAt,
    ...stableResolution
  } = resolution
  return controlRecordDigest({
    ...stableCommand,
    resolution: stableResolution,
  })
}

async function commitEntity<TRecord, TEvent>(
  options: FileControlStoreOptions,
  paths: EntityPaths,
  kind: 'run' | 'approval',
  id: string,
  idempotencyKey: string,
  requestDigest: string,
  record: TRecord,
  event: TEvent,
): Promise<StoreCommit<TRecord, TEvent>> {
  const wal: WalEntry<TRecord, TEvent> = {
    schemaVersion: 'control-store-wal/v1',
    kind,
    id,
    idempotencyKey,
    requestDigest,
    payloadDigest: controlRecordDigest({ record, event, idempotencyKey }),
    record,
    event,
    writtenAt: new Date().toISOString(),
  }
  await mkdir(paths.dir, { recursive: true })
  await atomicWriteJson(paths.wal, wal)
  await options.faultInjector?.('after_wal', { kind, id })
  await atomicWriteJson(paths.record, record)
  await options.faultInjector?.('after_record', { kind, id })
  await appendEventOnce(paths, event)
  await options.faultInjector?.('after_event', { kind, id })
  const idempotency = await readIdempotency<TRecord, TEvent>(paths)
  idempotency.entries[idempotencySlot(idempotencyKey)] = { requestDigest, record, event }
  await atomicWriteJson(paths.idempotency, idempotency)
  await options.faultInjector?.('after_idempotency', { kind, id })
  await rm(paths.wal, { force: true })
  return {
    record: structuredClone(record),
    event: structuredClone(event),
    replayed: false,
  }
}

async function recoverEntity<TRecord extends { schemaVersion: string }>(
  paths: EntityPaths,
  kind: 'run' | 'approval',
  id: string,
  decode: (value: unknown) => TRecord,
): Promise<void> {
  const raw = await readJsonIfExists(paths.wal)
  if (!raw) return
  if (!isObject(raw)
    || raw.schemaVersion !== 'control-store-wal/v1'
    || raw.kind !== kind
    || raw.id !== id
    || typeof raw.idempotencyKey !== 'string'
    || typeof raw.requestDigest !== 'string'
    || typeof raw.payloadDigest !== 'string'
    || raw.payloadDigest !== controlRecordDigest({
      record: raw.record,
      event: raw.event,
      idempotencyKey: raw.idempotencyKey,
    })
    || (kind === 'run' ? !isRunEvent(raw.event) : !isApprovalEvent(raw.event))) {
    await quarantineFile(paths.wal, 'invalid-wal')
    throw new ControlStoreError('INVALID_RECORD', `Invalid ${kind} WAL for ${id}.`)
  }
  const wal = raw as unknown as WalEntry<TRecord, unknown>
  const record = decode(wal.record)
  await atomicWriteJson(paths.record, record)
  await appendEventOnce(paths, wal.event)
  const idempotency = await readIdempotency<TRecord, unknown>(paths)
  idempotency.entries[idempotencySlot(wal.idempotencyKey)] = {
    requestDigest: wal.requestDigest,
    record,
    event: wal.event,
  }
  await atomicWriteJson(paths.idempotency, idempotency)
  await rm(paths.wal, { force: true })
}

async function replayFor<TRecord, TEvent>(
  paths: EntityPaths,
  idempotencyKey: string,
  requestDigest: string,
): Promise<StoreCommit<TRecord, TEvent> | undefined> {
  const entry = (await readIdempotency<TRecord, TEvent>(paths)).entries[idempotencySlot(idempotencyKey)]
  if (!entry) return undefined
  if (entry.requestDigest !== requestDigest) {
    throw new ControlStoreError('IDEMPOTENCY_CONFLICT', `Idempotency key was reused with different bytes: ${idempotencyKey}`)
  }
  return {
    record: structuredClone(entry.record),
    event: structuredClone(entry.event),
    replayed: true,
  }
}

async function readRecord<TRecord>(
  paths: EntityPaths,
  decode: (value: unknown) => TRecord,
): Promise<TRecord | undefined> {
  const raw = await readJsonIfExists(paths.record)
  return raw === undefined ? undefined : decode(raw)
}

async function listRecords<TRecord extends { schemaVersion: string }>(
  rootDir: string,
  kind: 'run' | 'approval',
  ownerScope: OwnerScope | undefined,
  decode: (value: unknown) => TRecord,
): Promise<TRecord[]> {
  const collection = kind === 'run' ? 'runs' : 'approvals'
  const dir = join(rootDir, 'scopes', scopeKey(ownerScope), collection)
  const entries = await safeReadDir(dir)
  const records: TRecord[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const id = decodeId(entry.name)
    const paths: EntityPaths = {
      dir: join(dir, entry.name),
      record: join(dir, entry.name, 'record.json'),
      events: join(dir, entry.name, 'events.jsonl'),
      idempotency: join(dir, entry.name, 'idempotency.json'),
      wal: join(dir, entry.name, 'transaction.wal.json'),
      lock: join(dir, entry.name, 'writer.lock'),
    }
    const recordPath = join(dir, entry.name, 'record.json')
    try {
      await withEntityLock(paths, () => recoverEntity(paths, kind, id, decode))
      const raw = await readJsonIfExists(recordPath)
      if (raw !== undefined) records.push(decode(raw))
    } catch (error) {
      await quarantineFile(recordPath, `invalid-${kind}-record`)
    }
  }
  return records.sort((left, right) => recordId(left).localeCompare(recordId(right)))
}

async function appendEventOnce<TEvent>(paths: EntityPaths, event: TEvent): Promise<void> {
  const existing = await readEvents<Record<string, unknown>>(paths, isGenericEvent)
  const candidate = event as Record<string, unknown>
  const duplicate = existing.find((item) =>
    item.eventId === candidate.eventId
    || item.eventSequence === candidate.eventSequence)
  if (duplicate) {
    if (controlRecordDigest(duplicate) === controlRecordDigest(candidate)) return
    throw new ControlStoreError(
      'EVENT_SEQUENCE_CONFLICT',
      `Event identity/sequence already contains different bytes: ${String(candidate.eventId)}`,
    )
  }
  await mkdir(paths.dir, { recursive: true })
  const handle = await open(paths.events, 'a')
  try {
    await handle.write(`${JSON.stringify(event)}\n`)
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function readEvents<TEvent>(
  paths: EntityPaths,
  validate: (value: unknown) => value is TEvent,
): Promise<TEvent[]> {
  let raw: string
  try {
    raw = await readFile(paths.events, 'utf8')
  } catch (error) {
    if (isNotFound(error)) return []
    throw error
  }
  const lines = raw.split('\n')
  const events: TEvent[] = []
  let corruptAt: number | undefined
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (!line.trim()) continue
    try {
      const parsed = JSON.parse(line)
      if (!validate(parsed)) throw new Error('event shape invalid')
      events.push(parsed)
    } catch {
      corruptAt = index
      break
    }
  }
  if (corruptAt !== undefined) {
    const corrupt = lines.slice(corruptAt).join('\n')
    const quarantine = join(paths.dir, `events.corrupt.${Date.now()}.jsonl`)
    await writeFile(quarantine, corrupt, 'utf8')
    await atomicWriteText(paths.events, events.map((event) => JSON.stringify(event)).join('\n') + (events.length ? '\n' : ''))
  }
  return events
}

async function readIdempotency<TRecord, TEvent>(
  paths: EntityPaths,
): Promise<IdempotencyFile<TRecord, TEvent>> {
  const raw = await readJsonIfExists(paths.idempotency)
  if (raw === undefined) {
    return { schemaVersion: 'control-idempotency/v1', entries: {} }
  }
  if (!isObject(raw)
    || raw.schemaVersion !== 'control-idempotency/v1'
    || !isObject(raw.entries)) {
    throw new ControlStoreError('INVALID_RECORD', `Invalid idempotency registry: ${paths.idempotency}`)
  }
  return raw as unknown as IdempotencyFile<TRecord, TEvent>
}

async function withEntityLock<T>(paths: EntityPaths, operation: () => Promise<T>): Promise<T> {
  const previous = processLocks.get(paths.dir) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((resolve) => { release = resolve })
  const queued = previous.then(() => current)
  processLocks.set(paths.dir, queued)
  await previous
  let lock: Awaited<ReturnType<typeof acquireFileLock>> | undefined
  try {
    await mkdir(paths.dir, { recursive: true })
    lock = await acquireFileLock(paths.lock)
    return await operation()
  } finally {
    if (lock) {
      await lock.close()
      await rm(paths.lock, { force: true })
    }
    release()
    if (processLocks.get(paths.dir) === queued) processLocks.delete(paths.dir)
  }
}

async function acquireFileLock(path: string) {
  try {
    const handle = await open(path, 'wx')
    await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }))
    await handle.sync()
    return handle
  } catch (error) {
    if (!isAlreadyExists(error)) throw error
    const stale = await staleLock(path)
    if (stale) {
      await rm(path, { force: true })
      return acquireFileLock(path)
    }
    throw new ControlStoreError('REVISION_CONFLICT', `Control Store entity is locked: ${path}`)
  }
}

async function staleLock(path: string): Promise<boolean> {
  try {
    const raw = JSON.parse(await readFile(path, 'utf8')) as { pid?: unknown }
    if (!Number.isSafeInteger(raw.pid)) return true
    try {
      process.kill(raw.pid as number, 0)
      return false
    } catch {
      return true
    }
  } catch {
    return true
  }
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await atomicWriteText(path, `${JSON.stringify(value, null, 2)}\n`)
}

async function atomicWriteText(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`
  const handle = await open(temp, 'wx')
  try {
    await handle.writeFile(value, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(temp, path)
  const directory = await open(dirname(path), 'r')
  try {
    await directory.sync()
  } finally {
    await directory.close()
  }
}

async function readJsonIfExists(path: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if (isNotFound(error)) return undefined
    throw error
  }
}

async function quarantineFile(path: string, reason: string): Promise<void> {
  if (!await exists(path)) return
  const target = `${path}.quarantine.${reason}.${Date.now()}`
  await rename(path, target)
}

function page<T>(items: T[], limit?: number, cursor?: string): StorePage<T> {
  const start = cursor === undefined ? 0 : decodeCursor(cursor)
  const size = Math.max(1, Math.min(limit ?? 100, 500))
  const selected = items.slice(start, start + size)
  const next = start + selected.length
  return {
    items: structuredClone(selected),
    ...(next < items.length ? { nextCursor: encodeCursor(next) } : {}),
  }
}

function scopeKey(scope: OwnerScope | undefined): string {
  return scope ? `scope-${controlRecordDigest(scope).slice(0, 32)}` : 'local-default'
}

function encodeId(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url')
}

function decodeId(value: string): string {
  return Buffer.from(value, 'base64url').toString('utf8')
}

function idempotencySlot(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url')
}

function encodeCursor(value: number): string {
  return Buffer.from(String(value), 'utf8').toString('base64url')
}

function decodeCursor(value: string): number {
  const parsed = Number(Buffer.from(value, 'base64url').toString('utf8'))
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new ControlStoreError('INVALID_RECORD', 'Invalid Store cursor.')
  }
  return parsed
}

function isRunEvent(value: unknown): value is RunStoreEvent {
  return isObject(value)
    && value.schemaVersion === RUN_EVENT_SCHEMA_VERSION
    && typeof value.eventId === 'string'
    && Number.isSafeInteger(value.eventSequence)
}

function isApprovalEvent(value: unknown): value is ApprovalStoreEvent {
  return isObject(value)
    && value.schemaVersion === APPROVAL_EVENT_SCHEMA_VERSION
    && typeof value.eventId === 'string'
    && Number.isSafeInteger(value.eventSequence)
}

function isGenericEvent(value: unknown): value is Record<string, unknown> {
  return isObject(value)
    && typeof value.eventId === 'string'
    && Number.isSafeInteger(value.eventSequence)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function recordId(value: unknown): string {
  if (!isObject(value)) return ''
  return String(value.runId ?? value.approvalId ?? '')
}

async function safeReadDir(path: string) {
  try {
    return await readdir(path, { withFileTypes: true })
  } catch (error) {
    if (isNotFound(error)) return []
    throw error
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path)
    return true
  } catch (error) {
    if (isNotFound(error)) return false
    throw error
  }
}

function isNotFound(error: unknown): boolean {
  return Boolean(isObject(error) && error.code === 'ENOENT')
}

function isAlreadyExists(error: unknown): boolean {
  return Boolean(isObject(error) && error.code === 'EEXIST')
}
