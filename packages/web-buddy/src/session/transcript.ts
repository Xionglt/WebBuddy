import { appendFile, readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'

export function createTranscriptEntryId(prefix = 'entry'): string {
  return `${prefix}_${randomUUID()}`
}

export async function appendJsonLine(path: string, value: unknown): Promise<void> {
  await appendFile(path, `${JSON.stringify(value)}\n`, 'utf8')
}

export async function readJsonLines<T = unknown>(path: string): Promise<T[]> {
  const text = await readFile(path, 'utf8')
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T)
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
