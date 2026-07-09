import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { MemoryKind, MemoryQuery, MemoryRecord, MemoryScope, MemorySearchResult } from './types.js'

export interface MemdirPaths {
  root: string
  index: string
  user: string
  project: string
  site: string
  topic: string
}

export function memdirPaths(root: string): MemdirPaths {
  return {
    root,
    index: join(root, 'MEMORY.md'),
    user: join(root, 'user.jsonl'),
    project: join(root, 'project.jsonl'),
    site: join(root, 'site.jsonl'),
    topic: join(root, 'topic.jsonl'),
  }
}

export async function ensureMemdir(root: string): Promise<MemdirPaths> {
  const paths = memdirPaths(root)
  await mkdir(root, { recursive: true })
  await Promise.all([
    ensureFile(paths.index, memoryIndex()),
    ensureFile(paths.user, ''),
    ensureFile(paths.project, ''),
    ensureFile(paths.site, ''),
    ensureFile(paths.topic, ''),
  ])
  return paths
}

export async function readMemdirRecords(root: string): Promise<MemoryRecord[]> {
  const paths = await ensureMemdir(root)
  const files = [paths.user, paths.project, paths.site, paths.topic]
  const records: MemoryRecord[] = []
  for (const file of files) {
    const raw = await readFile(file, 'utf8')
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      try {
        const parsed = JSON.parse(line)
        if (isMemoryRecord(parsed)) records.push(parsed)
      } catch {
        // Ignore corrupt lines; memdir is append-oriented and one bad line should not poison retrieval.
      }
    }
  }
  return records
}

export async function queryMemdir(root: string, query: MemoryQuery): Promise<MemorySearchResult> {
  const records = await readMemdirRecords(root)
  return {
    schemaVersion: 'memory-search-result/v1',
    query,
    generatedAt: new Date().toISOString(),
    records: records
      .map((record) => ({ record, score: scoreRecord(record, query), reason: reasonFor(record, query) }))
      .filter((item) => item.score > 0 && (query.includeSensitive || item.record.sensitivity !== 'secret'))
      .sort((a, b) => b.score - a.score)
      .slice(0, query.maxResults),
  }
}

export function renderMemorySearchResult(result: MemorySearchResult): string | undefined {
  if (result.records.length === 0) return undefined
  return result.records.map(({ record, reason }) => {
    if (record.kind === 'user_answer') {
      return `- user_answer field=${compact(record.field)} value=${compact(record.answer)} scope=${record.scope} reason=${reason}`
    }
    if (record.kind === 'permission_rule') {
      return `- permission_rule action=${record.action} tool=${record.subjectPattern.toolName ?? '(any)'} gate=${record.gateKind ?? '(none)'} scope=${record.rememberScope} reason=${reason}`
    }
    if (record.kind === 'episodic_recall') {
      return `- episodic_recall outcome=${record.outcome} summary=${compact(record.summary)} reason=${reason}`
    }
    return `- ${record.kind} ${compact(record.title)}: ${compact(record.body)} reason=${reason}`
  }).join('\n')
}

function scoreRecord(record: MemoryRecord, query: MemoryQuery): number {
  if (!query.scope.includes(record.scope)) return 0
  if (record.expiresAt && Date.parse(record.expiresAt) <= Date.now()) return 0
  if (query.kinds && !query.kinds.includes(record.kind)) return 0
  let score = record.confidence
  if (query.field && record.kind === 'user_answer' && same(query.field, record.field)) score += 2
  if (query.urlOrigin && record.kind === 'permission_rule' && record.subjectPattern.urlOrigin === query.urlOrigin) score += 1
  if (query.topics?.length) {
    const haystack = searchableText(record).toLowerCase()
    score += query.topics.filter((topic) => haystack.includes(topic.toLowerCase())).length * 0.5
  }
  return score
}

function reasonFor(record: MemoryRecord, query: MemoryQuery): string {
  if (query.field && record.kind === 'user_answer' && same(query.field, record.field)) return 'field match'
  if (query.urlOrigin && record.kind === 'permission_rule' && record.subjectPattern.urlOrigin === query.urlOrigin) return 'origin match'
  return 'scope/kind match'
}

function searchableText(record: MemoryRecord): string {
  if (record.kind === 'user_answer') return `${record.field} ${record.question}`
  if (record.kind === 'permission_rule') return `${record.subjectPattern.toolName ?? ''} ${record.gateKind ?? ''} ${record.policyCode ?? ''}`
  if (record.kind === 'episodic_recall') return `${record.summary} ${record.reusableLessons.join(' ')}`
  return `${record.title} ${record.body} ${record.topics.join(' ')}`
}

function same(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase()
}

async function ensureFile(file: string, content: string): Promise<void> {
  try {
    await readFile(file, 'utf8')
  } catch (error) {
    if (isFileNotFound(error)) {
      await writeFile(file, content, 'utf8')
      return
    }
    throw error
  }
}

function memoryIndex(): string {
  return [
    '# Web Buddy Memory',
    '',
    '- user.jsonl: user-scoped reusable facts and answers.',
    '- project.jsonl: project-scoped notes and recalls.',
    '- site.jsonl: site-specific facts and safe permission patterns.',
    '- topic.jsonl: reusable topic/skill/failure-pattern notes.',
    '',
    'Secret material such as passwords, tokens, cookies, captcha codes, and full identity numbers must not be stored here.',
    '',
  ].join('\n')
}

function compact(value: string): string {
  const text = value.replace(/\s+/g, ' ').trim()
  return text.length > 160 ? `${text.slice(0, 157)}...` : text
}

function isMemoryRecord(value: unknown): value is MemoryRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as { schemaVersion?: unknown; kind?: unknown; scope?: unknown; sensitivity?: unknown; confidence?: unknown }
  return record.schemaVersion === 'memory-record/v1' &&
    typeof record.kind === 'string' &&
    isScope(record.scope) &&
    (record.sensitivity === 'public' || record.sensitivity === 'internal' || record.sensitivity === 'personal' || record.sensitivity === 'secret') &&
    typeof record.confidence === 'number'
}

function isScope(value: unknown): value is MemoryScope {
  return value === 'run' || value === 'session' || value === 'project' || value === 'user'
}

function isFileNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as { code?: unknown }).code === 'ENOENT')
}

