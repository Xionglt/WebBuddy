import type { LocalToolRunResult } from '../tools/local-adapter.js'

export interface RunCandidateJob {
  id: string
  title: string
  reason: string
  source: 'tool_observation' | 'model_summary'
  url?: string
  evidence?: string
  lastSeenAt: string
}

export interface RunExcludedCandidate {
  title: string
  reason: string
  source: 'tool_observation' | 'model_summary'
  lastSeenAt: string
}

export interface RunMemory {
  schemaVersion: 'run-memory/v1'
  searchedKeywords: string[]
  emptyResultKeywords: string[]
  candidateJobs: RunCandidateJob[]
  excludedCandidates: RunExcludedCandidate[]
  currentBestCandidate?: RunCandidateJob
  handoffReason?: string
  updatedAt: string
}

export interface RunMemoryToolUpdateInput {
  memory: RunMemory
  toolName: string
  args: Record<string, unknown>
  result: LocalToolRunResult
  ok: boolean
  currentUrl?: string
  now?: string
}

export interface RunMemoryModelUpdateInput {
  memory: RunMemory
  content: string
  toolCalls?: Array<{ name: string; arguments: Record<string, unknown> }>
  now?: string
}

const MAX_KEYWORDS = 16
const MAX_CANDIDATES = 8
const MAX_EXCLUDED = 12
const EMPTY_RESULT_RE = /(no\s+(results?|matches?)|0\s+(results?|matches?)|nothing\s+found|未找到|没有找到|暂无|无结果|没有结果|未搜索到|空空如也)/i
const EXCLUDED_RE = /(exclude|excluded|skip|skipped|not\s+a\s+fit|不匹配|排除|跳过|不适合|不符合)/i
const BEST_RE = /(best|top|current\s+best|selected|prefer|推荐|最佳|最匹配|首选|候选)/i
const JOB_HINT_RE = /(job|position|role|opening|岗位|职位|职缺|招聘)/i
const TITLE_JOB_RE = /(engineer|developer|architect|scientist|analyst|researcher|manager|工程师|开发|架构师|算法|研发|研究员|产品经理|数据|前端|后端|全栈|客户端|服务端|专家)/i
const ANSI_RE = /\x1B\[[0-?]*[ -/]*[@-~]/g
const NON_CANDIDATE_LINE_RE = /\b(?:FAILED|Timeout|locator\.|Call log|Clicked visible text|Typed into|Uploaded file|Ref .* stale)\b|intercepts pointer events|role=dialog|alertdialog|温馨提示|提示|对话框|弹窗|申请名额|需要用户确认|当前状态|点击.*按钮|投递取消|已勾选|已导航|已完成投递前|简历上传成功|页面已加载|page has loaded|navigation includes|共\d+个岗位/i

export function createRunMemory(now = new Date().toISOString()): RunMemory {
  return {
    schemaVersion: 'run-memory/v1',
    searchedKeywords: [],
    emptyResultKeywords: [],
    candidateJobs: [],
    excludedCandidates: [],
    updatedAt: now,
  }
}

export function updateRunMemoryFromTool(input: RunMemoryToolUpdateInput): boolean {
  const now = input.now ?? new Date().toISOString()
  let changed = false
  const keyword = extractKeywordFromToolArgs(input.toolName, input.args)
  if (keyword) {
    changed = addUnique(input.memory.searchedKeywords, keyword, MAX_KEYWORDS) || changed
  }

  const observation = truncateText(input.result.observation, 4000)
  const emptyResultKeyword = keyword ?? input.memory.searchedKeywords[input.memory.searchedKeywords.length - 1]
  if (input.ok && emptyResultKeyword && isEmptyResultObservation(observation)) {
    changed = addUnique(input.memory.emptyResultKeywords, emptyResultKeyword, MAX_KEYWORDS) || changed
  }

  if (input.ok) {
    for (const candidate of extractCandidatesFromText(observation, 'tool_observation', input.currentUrl, now)) {
      changed = rememberCandidate(input.memory, candidate) || changed
    }

    for (const excluded of extractExcludedFromText(observation, 'tool_observation', now)) {
      changed = rememberExcluded(input.memory, excluded) || changed
    }
  }

  if (input.toolName === 'agent_done') {
    const summary = stringValue(input.args.summary) || observation
    const handoffReason = stringValue(input.args.blocked) === 'true' || input.args.blocked === true
      ? compactText(summary, 260)
      : undefined
    if (handoffReason && input.memory.handoffReason !== handoffReason) {
      input.memory.handoffReason = handoffReason
      changed = true
    }
    const best = bestCandidateFromText(summary, input.currentUrl, now)
    if (best) changed = setCurrentBest(input.memory, best) || changed
  }

  if (changed) input.memory.updatedAt = now
  return changed
}

export function updateRunMemoryFromModel(input: RunMemoryModelUpdateInput): boolean {
  const now = input.now ?? new Date().toISOString()
  let changed = false
  const text = truncateText(input.content, 4000)

  for (const call of input.toolCalls ?? []) {
    const keyword = extractKeywordFromToolArgs(call.name, call.arguments)
    if (keyword) changed = addUnique(input.memory.searchedKeywords, keyword, MAX_KEYWORDS) || changed
  }

  for (const candidate of extractCandidatesFromText(text, 'model_summary', undefined, now)) {
    changed = rememberCandidate(input.memory, candidate) || changed
  }
  for (const excluded of extractExcludedFromText(text, 'model_summary', now)) {
    changed = rememberExcluded(input.memory, excluded) || changed
  }
  const best = bestCandidateFromText(text, undefined, now)
  if (best) changed = setCurrentBest(input.memory, best) || changed

  if (changed) input.memory.updatedAt = now
  return changed
}

export function compactRunMemory(memory: RunMemory): RunMemory {
  return {
    ...memory,
    searchedKeywords: memory.searchedKeywords.slice(-MAX_KEYWORDS),
    emptyResultKeywords: memory.emptyResultKeywords.slice(-MAX_KEYWORDS),
    candidateJobs: memory.candidateJobs.slice(0, MAX_CANDIDATES),
    excludedCandidates: memory.excludedCandidates.slice(0, MAX_EXCLUDED),
    currentBestCandidate: memory.currentBestCandidate,
  }
}

export function renderRunMemory(memory: RunMemory | undefined): string {
  if (!memory) return '(no run memory yet)'
  const lines = [
    `schemaVersion: ${memory.schemaVersion}`,
    `searchedKeywords: ${memory.searchedKeywords.length ? memory.searchedKeywords.join(', ') : '(none)'}`,
    `emptyResultKeywords: ${memory.emptyResultKeywords.length ? memory.emptyResultKeywords.join(', ') : '(none)'}`,
    'candidateJobs:',
    ...(memory.candidateJobs.length
      ? memory.candidateJobs.slice(0, 3).map((job, index) => `- #${index + 1} ${job.title} | reason=${job.reason}${job.url ? ` | url=${job.url}` : ''}`)
      : ['- (none yet)']),
    'excludedCandidates:',
    ...(memory.excludedCandidates.length
      ? memory.excludedCandidates.slice(0, 5).map((item) => `- ${item.title} | reason=${item.reason}`)
      : ['- (none)']),
    memory.currentBestCandidate
      ? `currentBestCandidate: ${memory.currentBestCandidate.title} | reason=${memory.currentBestCandidate.reason}`
      : 'currentBestCandidate: (none yet)',
    memory.handoffReason ? `handoffReason: ${memory.handoffReason}` : undefined,
    `updatedAt: ${memory.updatedAt}`,
  ].filter(Boolean)
  return lines.join('\n')
}

function extractKeywordFromToolArgs(toolName: string, args: Record<string, unknown>): string | undefined {
  if (!['browser_type', 'browser_fill_by_label', 'browser_set_field'].includes(toolName)) return undefined
  const label = compactText([
    stringValue(args.label),
    stringValue(args.fieldKey),
    stringValue(args.ref),
  ].filter(Boolean).join(' '), 160)
  const value = stringValue(args.text) ?? stringValue(args.intendedValue)
  if (!value) return undefined
  const keyword = compactText(value, 80)
  if (!keyword || keyword.length > 80 || looksSensitive(keyword)) return undefined
  if (/search|keyword|query|职位|岗位|搜索|关键/.test(label.toLowerCase())) return keyword
  if (toolName === 'browser_type' && keyword.length <= 40 && !/\n/.test(keyword)) return keyword
  return undefined
}

function extractCandidatesFromText(
  text: string,
  source: RunCandidateJob['source'],
  url: string | undefined,
  now: string,
): RunCandidateJob[] {
  if (!text || !JOB_HINT_RE.test(text)) return []
  return candidateLines(text)
    .filter((line) => !EXCLUDED_RE.test(line))
    .map((line) => candidateFromLine(line, source, url, now))
    .filter((candidate): candidate is RunCandidateJob => Boolean(candidate))
    .slice(0, MAX_CANDIDATES)
}

function extractExcludedFromText(
  text: string,
  source: RunExcludedCandidate['source'],
  now: string,
): RunExcludedCandidate[] {
  if (!text || !EXCLUDED_RE.test(text)) return []
  return candidateLines(text)
    .filter((line) => EXCLUDED_RE.test(line))
    .map((line) => ({
      title: titleFromLine(line) || compactText(line, 120),
      reason: compactText(line, 220),
      source,
      lastSeenAt: now,
    }))
    .filter((item) => item.title)
    .slice(0, MAX_EXCLUDED)
}

function bestCandidateFromText(text: string, url: string | undefined, now: string): RunCandidateJob | undefined {
  if (!BEST_RE.test(text)) return undefined
  return extractCandidatesFromText(text, 'model_summary', url, now)[0]
}

function candidateFromLine(
  line: string,
  source: RunCandidateJob['source'],
  url: string | undefined,
  now: string,
): RunCandidateJob | undefined {
  const title = titleFromLine(line)
  if (!title || title.length < 3) return undefined
  if (!looksLikeCandidateJob(title, line)) return undefined
  return {
    id: stableCandidateId(title),
    title,
    reason: compactText(line, 220),
    source,
    ...(url ? { url } : {}),
    evidence: compactText(line, 260),
    lastSeenAt: now,
  }
}

function candidateLines(text: string): string[] {
  return text
    .split(/\n|[。；;]/)
    .map((line) => compactText(line.replace(/^[\s*\-•\d.、#]+/, ''), 320))
    .filter((line) => line.length >= 6 && !NON_CANDIDATE_LINE_RE.test(line) && (JOB_HINT_RE.test(line) || TITLE_JOB_RE.test(line)))
}

function titleFromLine(line: string): string | undefined {
  const withoutRef = line.replace(/\[[a-z]\d+\]/gi, '').replace(/\bhttps?:\/\/\S+/g, '').trim()
  const colonSplit = withoutRef.split(/[:：]/).map((part) => part.trim()).filter(Boolean)
  const candidate = colonSplit.length > 1 && colonSplit[0].length < 24 ? colonSplit.slice(1).join(': ') : withoutRef
  const title = candidate.split(/\s+[|(-]\s+|，|,|理由|reason=/i)[0]?.trim()
  return title ? compactText(title, 120) : undefined
}

function looksLikeCandidateJob(title: string, line: string): boolean {
  if (NON_CANDIDATE_LINE_RE.test(title) || NON_CANDIDATE_LINE_RE.test(line)) return false
  if (TITLE_JOB_RE.test(title)) return true
  if (/(候选岗位|current\s+best\s+candidate|best\s+candidate|搜索到.*岗位|找到.*岗位)/i.test(line) && TITLE_JOB_RE.test(line)) return true
  return false
}

function rememberCandidate(memory: RunMemory, candidate: RunCandidateJob): boolean {
  const existingIndex = memory.candidateJobs.findIndex((item) => item.id === candidate.id || item.title === candidate.title)
  if (existingIndex >= 0) {
    memory.candidateJobs[existingIndex] = { ...memory.candidateJobs[existingIndex], ...candidate }
  } else {
    memory.candidateJobs.unshift(candidate)
    if (memory.candidateJobs.length > MAX_CANDIDATES) memory.candidateJobs.length = MAX_CANDIDATES
  }
  if (!memory.currentBestCandidate && BEST_RE.test(candidate.reason)) {
    memory.currentBestCandidate = candidate
  }
  return true
}

function rememberExcluded(memory: RunMemory, excluded: RunExcludedCandidate): boolean {
  const existingIndex = memory.excludedCandidates.findIndex((item) => item.title === excluded.title)
  if (existingIndex >= 0) memory.excludedCandidates[existingIndex] = excluded
  else memory.excludedCandidates.unshift(excluded)
  if (memory.excludedCandidates.length > MAX_EXCLUDED) memory.excludedCandidates.length = MAX_EXCLUDED
  return true
}

function setCurrentBest(memory: RunMemory, candidate: RunCandidateJob): boolean {
  rememberCandidate(memory, candidate)
  memory.currentBestCandidate = candidate
  return true
}

function addUnique(items: string[], value: string, max: number): boolean {
  const normalized = compactText(value, 80)
  if (!normalized || items.includes(normalized)) return false
  items.push(normalized)
  if (items.length > max) items.splice(0, items.length - max)
  return true
}

function isEmptyResultObservation(text: string): boolean {
  return EMPTY_RESULT_RE.test(text)
}

function looksSensitive(value: string): boolean {
  return /@|(?:\+?\d[\d\s-]{7,})|api[_-]?key|token|cookie|password|密码|简历全文/i.test(value)
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function compactText(value: string, max: number): string {
  const compact = value.replace(ANSI_RE, '').replace(/\s+/g, ' ').trim()
  return compact.length > max ? `${compact.slice(0, Math.max(0, max - 3))}...` : compact
}

function truncateText(value: string, max: number): string {
  const trimmed = value.replace(ANSI_RE, '').trim()
  return trimmed.length > max ? `${trimmed.slice(0, Math.max(0, max - 3))}...` : trimmed
}

function stableCandidateId(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 96)
}
