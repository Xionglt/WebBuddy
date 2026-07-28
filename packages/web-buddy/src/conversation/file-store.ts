import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { digestCanonicalJson, type OwnerScope } from '../task/contracts.js'
import {
  CONVERSATION_RECORD_SCHEMA_VERSION,
  CONVERSATION_TURN_RECORD_SCHEMA_VERSION,
  ConversationStoreError,
  MAX_CONVERSATION_TURNS,
  decodeConversationRecord,
  type ConversationAppendTurnInput,
  type ConversationCreateInput,
  type ConversationRecord,
  type ConversationTurnRecord,
} from './contracts.js'

export interface FileConversationStoreOptions {
  rootDir: string
}

interface ConversationPaths {
  dir: string
  record: string
  lock: string
}

const processLocks = new Map<string, Promise<void>>()

export class FileConversationStore {
  constructor(private readonly options: FileConversationStoreOptions) {}

  async create(input: ConversationCreateInput): Promise<{ record: ConversationRecord; replayed: boolean }> {
    const paths = conversationPaths(this.options.rootDir, input.conversationId, input.ownerScope)
    return withConversationLock(paths, async () => {
      const existing = await readRecord(paths)
      const requestDigest = createRequestDigest(input)
      if (existing) {
        if (existing.createIdempotencyKey === input.idempotencyKey) {
          if (existing.createRequestDigest !== requestDigest) {
            throw new ConversationStoreError(
              'IDEMPOTENCY_CONFLICT',
              'Conversation create idempotency key was reused with different input.',
            )
          }
          return { record: structuredClone(existing), replayed: true }
        }
        throw new ConversationStoreError(
          'CONVERSATION_ALREADY_EXISTS',
          `Conversation already exists: ${input.conversationId}`,
        )
      }
      const record = decodeConversationRecord({
        schemaVersion: CONVERSATION_RECORD_SCHEMA_VERSION,
        conversationId: input.conversationId,
        goal: input.goal,
        startUrl: input.startUrl,
        headless: input.headless,
        ...(input.ownerScope ? { ownerScope: structuredClone(input.ownerScope) } : {}),
        recordRevision: 0,
        turns: [],
        createIdempotencyKey: input.idempotencyKey,
        createRequestDigest: requestDigest,
        createdAt: input.createdAt,
        updatedAt: input.createdAt,
      })
      await atomicWriteJson(paths.record, record)
      return { record: structuredClone(record), replayed: false }
    })
  }

  async get(conversationId: string, ownerScope?: OwnerScope): Promise<ConversationRecord | undefined> {
    const paths = conversationPaths(this.options.rootDir, conversationId, ownerScope)
    return withConversationLock(paths, async () => {
      const record = await readRecord(paths)
      return record ? structuredClone(record) : undefined
    })
  }

  async list(ownerScope?: OwnerScope): Promise<ConversationRecord[]> {
    const collection = collectionDir(this.options.rootDir, ownerScope)
    const entries = await safeReadDir(collection)
    const records: ConversationRecord[] = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const paths = pathsForDir(join(collection, entry.name))
      try {
        const record = await withConversationLock(paths, () => readRecord(paths))
        if (record) records.push(record)
      } catch (error) {
        if (error instanceof ConversationStoreError) continue
        throw error
      }
    }
    return records
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)
        || left.conversationId.localeCompare(right.conversationId))
      .map((record) => structuredClone(record))
  }

  async appendTurn(
    input: ConversationAppendTurnInput,
    provisionRun: () => Promise<string>,
  ): Promise<{ record: ConversationRecord; turn: ConversationTurnRecord; replayed: boolean }> {
    const paths = conversationPaths(this.options.rootDir, input.conversationId, input.ownerScope)
    return withConversationLock(paths, async () => {
      const current = await readRecord(paths)
      if (!current) {
        throw new ConversationStoreError(
          'CONVERSATION_NOT_FOUND',
          `Conversation not found: ${input.conversationId}`,
        )
      }
      const requestDigest = turnRequestDigest(input)
      const replay = current.turns.find((turn) => turn.idempotencyKey === input.idempotencyKey)
      if (replay) {
        if (replay.requestDigest !== requestDigest) {
          throw new ConversationStoreError(
            'IDEMPOTENCY_CONFLICT',
            'Conversation Turn idempotency key was reused with different input.',
          )
        }
        return {
          record: structuredClone(current),
          turn: structuredClone(replay),
          replayed: true,
        }
      }
      if (current.turns.some((turn) => turn.turnId === input.turnId)) {
        throw new ConversationStoreError('IDEMPOTENCY_CONFLICT', `Turn already exists: ${input.turnId}`)
      }
      if (current.recordRevision !== input.expectedRecordRevision) {
        throw new ConversationStoreError(
          'REVISION_CONFLICT',
          `Conversation revision ${current.recordRevision} does not match ${input.expectedRecordRevision}.`,
        )
      }
      if (current.turns.length >= MAX_CONVERSATION_TURNS) {
        throw new ConversationStoreError(
          'CONVERSATION_LIMIT_EXCEEDED',
          `Conversation cannot contain more than ${MAX_CONVERSATION_TURNS} Turns.`,
        )
      }
      const runId = await provisionRun()
      if (!runId.trim()) throw new ConversationStoreError('INVALID_RECORD', 'Provisioned Run ID is empty.')
      const turn = {
        schemaVersion: CONVERSATION_TURN_RECORD_SCHEMA_VERSION,
        turnId: input.turnId,
        sequence: current.turns.length + 1,
        userMessage: input.userMessage,
        runId,
        idempotencyKey: input.idempotencyKey,
        requestDigest,
        createdAt: input.createdAt,
      } satisfies ConversationTurnRecord
      const record = decodeConversationRecord({
        ...current,
        recordRevision: current.recordRevision + 1,
        turns: [...current.turns, turn],
        updatedAt: input.createdAt,
      })
      await atomicWriteJson(paths.record, record)
      return {
        record: structuredClone(record),
        turn: structuredClone(turn),
        replayed: false,
      }
    })
  }
}

function createRequestDigest(input: ConversationCreateInput): string {
  return digestCanonicalJson({
    conversationId: input.conversationId,
    goal: input.goal,
    startUrl: input.startUrl,
    headless: input.headless,
    ownerScope: input.ownerScope ?? null,
  })
}

function turnRequestDigest(input: ConversationAppendTurnInput): string {
  return digestCanonicalJson({
    conversationId: input.conversationId,
    turnId: input.turnId,
    userMessage: input.userMessage,
    expectedRecordRevision: input.expectedRecordRevision,
    ownerScope: input.ownerScope ?? null,
  })
}

function conversationPaths(rootDir: string, conversationId: string, ownerScope?: OwnerScope): ConversationPaths {
  const dir = join(collectionDir(rootDir, ownerScope), Buffer.from(conversationId, 'utf8').toString('base64url'))
  return pathsForDir(dir)
}

function collectionDir(rootDir: string, ownerScope?: OwnerScope): string {
  const scope = ownerScope ? `scope-${digestCanonicalJson(ownerScope).slice(0, 32)}` : 'local-default'
  return join(rootDir, 'scopes', scope, 'conversations')
}

function pathsForDir(dir: string): ConversationPaths {
  return {
    dir,
    record: join(dir, 'record.json'),
    lock: join(dir, 'writer.lock'),
  }
}

async function readRecord(paths: ConversationPaths): Promise<ConversationRecord | undefined> {
  try {
    return decodeConversationRecord(JSON.parse(await readFile(paths.record, 'utf8')))
  } catch (error) {
    if (isCode(error, 'ENOENT')) return undefined
    if (error instanceof ConversationStoreError) throw error
    throw new ConversationStoreError('INVALID_RECORD', `Invalid Conversation record: ${paths.record}`)
  }
}

async function withConversationLock<T>(paths: ConversationPaths, operation: () => Promise<T>): Promise<T> {
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
    if (!isCode(error, 'EEXIST')) throw error
    if (await staleLock(path)) {
      await rm(path, { force: true })
      return acquireFileLock(path)
    }
    throw new ConversationStoreError('REVISION_CONFLICT', `Conversation is locked: ${path}`)
  }
}

async function staleLock(path: string): Promise<boolean> {
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as { pid?: unknown }
    if (!Number.isSafeInteger(value.pid)) return true
    try {
      process.kill(value.pid as number, 0)
      return false
    } catch {
      return true
    }
  } catch {
    return true
  }
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  const handle = await open(temporary, 'wx')
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(temporary, path)
  const directory = await open(dirname(path), 'r')
  try {
    await directory.sync()
  } finally {
    await directory.close()
  }
}

async function safeReadDir(path: string) {
  try {
    return await readdir(path, { withFileTypes: true })
  } catch (error) {
    if (isCode(error, 'ENOENT')) return []
    throw error
  }
}

function isCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === code)
}
