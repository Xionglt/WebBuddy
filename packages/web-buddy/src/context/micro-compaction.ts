import type { ChatMessage } from '../sdk/llm.js'
import { estimateChatMessages, type TokenBudgetSnapshot } from '../kernel/token-budget.js'

export interface MicroCompactionOptions {
  keepRecentToolResults?: number
  maxToolResultChars?: number
  maxSnapshotResultChars?: number
  minToolResultChars?: number
  toolResultPressureRatio?: number
  totalPressureRatio?: number
}

export interface MicroCompactionStats {
  inputMessageCount: number
  outputMessageCount: number
  compactedToolResultCount: number
  compactedSnapshotCount: number
  estimatedTokensBefore: number
  estimatedTokensAfter: number
  estimatedTokensSaved: number
}

export interface MicroCompactionResult {
  applied: boolean
  reason?: string
  messages: ChatMessage[]
  stats: MicroCompactionStats
}

const DEFAULT_KEEP_RECENT_TOOL_RESULTS = 1
const DEFAULT_MAX_TOOL_RESULT_CHARS = 1800
const DEFAULT_MAX_SNAPSHOT_RESULT_CHARS = 1400
const DEFAULT_MIN_TOOL_RESULT_CHARS = 2600
const DEFAULT_TOOL_RESULT_PRESSURE_RATIO = 0.4
const DEFAULT_TOTAL_PRESSURE_RATIO = 0.55

const SNAPSHOT_TOOL_RE = /browser_(?:form_)?snapshot/i
const SNAPSHOT_TEXT_RE = /\b(?:CURRENT_BROWSER_SNAPSHOT_REFS|updated page|element refs?|browser snapshot|form snapshot)\b/i

export function shouldMicroCompact(
  messages: ChatMessage[],
  tokenBudget: TokenBudgetSnapshot,
  options: MicroCompactionOptions = {},
): { compact: boolean; reason?: string } {
  const total = tokenBudget.estimatedTotalTokens ?? 0
  const tool = tokenBudget.estimatedToolResultTokens ?? 0
  const threshold = tokenBudget.compactThresholdTokens
  const toolPressureRatio = normalizeRatio(options.toolResultPressureRatio, DEFAULT_TOOL_RESULT_PRESSURE_RATIO)
  const totalPressureRatio = normalizeRatio(options.totalPressureRatio, DEFAULT_TOTAL_PRESSURE_RATIO)

  if (messages.some((message) => message.role === 'tool' && message.content.length > minToolResultChars(options))) {
    return { compact: true, reason: 'A large tool result exceeded the micro-compaction threshold.' }
  }
  if (total > 0 && tool / total >= toolPressureRatio) {
    return { compact: true, reason: `Tool results account for ${Math.round((tool / total) * 100)}% of context.` }
  }
  if (threshold > 0 && total >= threshold * totalPressureRatio) {
    return { compact: true, reason: `Estimated context reached ${Math.round(totalPressureRatio * 100)}% of compact threshold.` }
  }
  return { compact: false }
}

export function microCompactMessages(
  messages: ChatMessage[],
  options: MicroCompactionOptions = {},
): MicroCompactionResult {
  const before = estimateChatMessages(messages).totalTokens
  const keepRecentToolResults = normalizeCount(options.keepRecentToolResults, DEFAULT_KEEP_RECENT_TOOL_RESULTS)
  const retainToolIds = recentToolMessageIds(messages, keepRecentToolResults)
  let compactedToolResultCount = 0
  let compactedSnapshotCount = 0

  const compacted = messages.map((message) => {
    if (message.role !== 'tool') return message
    const id = message.tool_call_id ?? ''
    if (id && retainToolIds.has(id)) return message

    const isSnapshot = isSnapshotToolResult(message)
    const maxChars = isSnapshot
      ? normalizeCount(options.maxSnapshotResultChars, DEFAULT_MAX_SNAPSHOT_RESULT_CHARS)
      : normalizeCount(options.maxToolResultChars, DEFAULT_MAX_TOOL_RESULT_CHARS)
    if (message.content.length <= Math.max(maxChars, minToolResultChars(options))) return message

    compactedToolResultCount += 1
    if (isSnapshot) compactedSnapshotCount += 1
    return {
      ...message,
      content: compactToolMessageContent(message, maxChars, isSnapshot),
    }
  })

  const after = estimateChatMessages(compacted).totalTokens
  return {
    applied: compactedToolResultCount > 0,
    ...(compactedToolResultCount > 0 ? { reason: `Micro-compacted ${compactedToolResultCount} old tool result(s).` } : {}),
    messages: compacted,
    stats: {
      inputMessageCount: messages.length,
      outputMessageCount: compacted.length,
      compactedToolResultCount,
      compactedSnapshotCount,
      estimatedTokensBefore: before,
      estimatedTokensAfter: after,
      estimatedTokensSaved: Math.max(0, before - after),
    },
  }
}

function recentToolMessageIds(messages: ChatMessage[], keepRecentToolResults: number): Set<string> {
  const ids: string[] = []
  for (let index = messages.length - 1; index >= 0 && ids.length < keepRecentToolResults; index -= 1) {
    const message = messages[index]
    if (message.role !== 'tool' || !message.tool_call_id) continue
    ids.push(message.tool_call_id)
  }
  return new Set(ids)
}

function compactToolMessageContent(message: ChatMessage, maxChars: number, isSnapshot: boolean): string {
  const head = message.content.slice(0, maxChars).trimEnd()
  const lines = [
    head,
    '',
    `[micro_compacted_tool_result originalChars=${message.content.length}]`,
  ]
  if (isSnapshot) {
    lines.push('Older browser/form snapshot refs are stale historical evidence. Refresh the page/form snapshot before using element refs.')
  }
  return lines.join('\n')
}

function isSnapshotToolResult(message: ChatMessage): boolean {
  return Boolean(
    (message.name && SNAPSHOT_TOOL_RE.test(message.name)) ||
    SNAPSHOT_TEXT_RE.test(message.content),
  )
}

function minToolResultChars(options: MicroCompactionOptions): number {
  return normalizeCount(options.minToolResultChars, DEFAULT_MIN_TOOL_RESULT_CHARS)
}

function normalizeCount(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : fallback
}

function normalizeRatio(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0
    ? value
    : fallback
}
