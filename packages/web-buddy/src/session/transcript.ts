import { appendFile, open, readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'

export function createTranscriptEntryId(prefix = 'entry'): string {
  return `${prefix}_${randomUUID()}`
}

export async function appendJsonLine(path: string, value: unknown): Promise<void> {
  await appendFile(path, `${JSON.stringify(value)}\n`, 'utf8')
}

/** Append and fsync an event that must survive before an external effect starts. */
export async function appendJsonLineDurably(path: string, value: unknown): Promise<void> {
  const handle = await open(path, 'a')
  try {
    await handle.write(`${JSON.stringify(value)}\n`)
    await handle.sync()
  } finally {
    await handle.close()
  }
}

export async function readJsonLines<T = unknown>(path: string): Promise<T[]> {
  const text = await readFile(path, 'utf8')
  const values: T[] = []
  for (const [index, rawLine] of text.split('\n').entries()) {
    const line = rawLine.trim()
    if (!line) continue
    try {
      values.push(JSON.parse(line) as T)
    } catch (cause) {
      throw new JsonLinesCorruptionError(path, index + 1, cause)
    }
  }
  return values
}

export class JsonLinesCorruptionError extends Error {
  readonly code = 'SESSION_JSONL_CORRUPT' as const

  constructor(
    readonly path: string,
    readonly lineNumber: number,
    cause: unknown,
  ) {
    super(`SESSION_JSONL_CORRUPT: invalid JSON in ${path} at line ${lineNumber}.`, { cause })
    this.name = 'JsonLinesCorruptionError'
  }
}

export function compactToolResult(result: unknown): unknown {
  if (!result || typeof result !== 'object') return result
  const value = result as {
    observation?: unknown
    pageChanged?: unknown
    done?: unknown
    risk?: unknown
    data?: unknown
  }
  return {
    observation: typeof value.observation === 'string' ? truncate(value.observation, 2000) : value.observation,
    pageChanged: value.pageChanged,
    done: value.done,
    risk: value.risk,
    data: summarizeData(value.data),
  }
}

export function compactAssistantContent(content: unknown): unknown {
  if (!content || typeof content !== 'object') {
    return typeof content === 'string' ? truncate(content, 4000) : content
  }
  if (Array.isArray(content)) return { kind: 'array', length: content.length }
  const compact: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(content as Record<string, unknown>)) {
    compact[key] = typeof value === 'string' ? truncate(value, 4000) : value
  }
  return compact
}

function summarizeData(data: unknown): unknown {
  if (!data || typeof data !== 'object') return data
  if (Array.isArray(data)) return { kind: 'array', length: data.length }
  const obj = data as Record<string, unknown>
  return {
    kind: 'object',
    keys: Object.keys(obj).slice(0, 20),
  }
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}...` : value
}
