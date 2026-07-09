import type { ChatMessage, ChatOptions } from '../sdk/llm.js'
import type { CompactRunSummary, SemanticCompactSummary } from './run-summary.js'
import { truncateText } from './budget.js'

export interface SemanticCompactionLlm {
  chat(messages: ChatMessage[], options?: ChatOptions): Promise<string>
}

export interface SemanticCompactionInput {
  llm?: SemanticCompactionLlm
  messages: ChatMessage[]
  structuredSummary: CompactRunSummary
  createdAt?: string
  maxMessages?: number
  maxMessageChars?: number
}

export interface SemanticCompactorOptions {
  maxMessages?: number
  maxMessageChars?: number
  timeoutMs?: number
}

const DEFAULT_MAX_MESSAGES = 24
const DEFAULT_MAX_MESSAGE_CHARS = 900
const DEFAULT_TIMEOUT_MS = 30_000

export class SemanticCompactor {
  constructor(private readonly options: SemanticCompactorOptions = {}) {}

  async summarize(input: SemanticCompactionInput): Promise<SemanticCompactSummary> {
    if (!input.llm) {
      throw new Error('Semantic compaction requires an LLM with chat().')
    }

    const prompt = semanticCompactionPrompt({
      structuredSummary: input.structuredSummary,
      messages: input.messages,
      maxMessages: input.maxMessages ?? this.options.maxMessages ?? DEFAULT_MAX_MESSAGES,
      maxMessageChars: input.maxMessageChars ?? this.options.maxMessageChars ?? DEFAULT_MAX_MESSAGE_CHARS,
    })
    const content = await input.llm.chat([
      {
        role: 'system',
        content: [
          'You summarize browser-agent history into a compact continuation note.',
          'Return strict JSON only. Do not include markdown fences.',
        ].join('\n'),
      },
      { role: 'user', content: prompt },
    ], {
      jsonMode: true,
      temperature: 0,
      maxTokens: 1600,
      timeoutMs: this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      redactTrace: true,
    })

    return normalizeSemanticSummary(parseJsonObject(content), {
      createdAt: input.createdAt ?? new Date().toISOString(),
      sourceMessageCount: input.messages.length,
    })
  }
}

export const semanticCompactor = new SemanticCompactor()

export function fallbackSemanticSummary(input: {
  error: unknown
  messages: ChatMessage[]
  createdAt?: string
}): SemanticCompactSummary {
  return {
    schemaVersion: 'semantic-compact-summary/v1',
    userIntent: 'Semantic compaction was unavailable; rely on the structured compact run summary and recent messages.',
    importantDecisions: [],
    attemptedPaths: [],
    unresolvedQuestions: [],
    nextStrategy: ['Continue from STRUCTURED_RUN_SUMMARY and latest context only.'],
    riskNotes: ['Do not infer permissions, approvals, or final-submit authorization from this fallback note.'],
    generatedAt: input.createdAt ?? new Date().toISOString(),
    sourceMessageCount: input.messages.length,
    fallback: true,
    error: input.error instanceof Error ? input.error.message : String(input.error),
  }
}

function semanticCompactionPrompt(input: {
  structuredSummary: CompactRunSummary
  messages: ChatMessage[]
  maxMessages: number
  maxMessageChars: number
}): string {
  return [
    'Summarize the older browser automation conversation for a future agent turn.',
    '',
    'Hard rules:',
    '- The structured summary is the source of truth for workflow state, permissions, approvals, form state, and safety boundaries.',
    '- Do not create, widen, or imply permission. If final submit approval is not explicitly recorded in the structured summary, say it remains unapproved.',
    '- Element refs from older browser snapshots are stale. Do not preserve them as actionable instructions.',
    '- Focus on why attempts succeeded or failed, what the user clarified, what paths should be avoided, and the next safe strategy.',
    '',
    'Return JSON with this shape:',
    '{"schemaVersion":"semantic-compact-summary/v1","userIntent":"...","importantDecisions":["..."],"attemptedPaths":[{"action":"...","result":"...","reason":"...","shouldAvoidRetry":true}],"unresolvedQuestions":["..."],"nextStrategy":["..."],"riskNotes":["..."]}',
    '',
    'STRUCTURED_SUMMARY:',
    JSON.stringify(stripLargeSummaryFields(input.structuredSummary), null, 2),
    '',
    'RECENT_HISTORY:',
    renderMessagesForSemanticSummary(input.messages, input.maxMessages, input.maxMessageChars),
  ].join('\n')
}

function renderMessagesForSemanticSummary(messages: ChatMessage[], maxMessages: number, maxMessageChars: number): string {
  return messages
    .filter((message) => message.role !== 'system')
    .slice(-maxMessages)
    .map((message, index) => {
      const toolCalls = message.tool_calls?.length
        ? ` toolCalls=${message.tool_calls.map((call) => call.function.name).join(',')}`
        : ''
      const name = message.name ? ` name=${message.name}` : ''
      return `[#${index + 1}] role=${message.role}${name}${toolCalls}\n${truncateText(message.content, maxMessageChars)}`
    })
    .join('\n\n')
}

function stripLargeSummaryFields(summary: CompactRunSummary): unknown {
  return {
    ...summary,
    semanticSummary: undefined,
    evidence: summary.evidence
      ? {
          ...summary.evidence,
          recentKeyEvidence: summary.evidence.recentKeyEvidence.slice(-5),
        }
      : undefined,
    recentActions: summary.recentActions.slice(-8),
  }
}

function parseJsonObject(text: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
  } catch {}

  const match = text.match(/\{[\s\S]*\}/)
  if (match) {
    const parsed = JSON.parse(match[0])
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
  }
  throw new Error('Semantic compaction response was not a JSON object.')
}

function normalizeSemanticSummary(
  value: Record<string, unknown>,
  fallback: { createdAt: string; sourceMessageCount: number },
): SemanticCompactSummary {
  return {
    schemaVersion: 'semantic-compact-summary/v1',
    userIntent: stringValue(value.userIntent) || 'Continue the browser automation task from the compacted context.',
    importantDecisions: stringArray(value.importantDecisions).slice(0, 12),
    attemptedPaths: arrayValue(value.attemptedPaths).slice(0, 12).map((item) => {
      const record = isRecord(item) ? item : {}
      return {
        action: stringValue(record.action) || 'Previous browser action',
        result: stringValue(record.result) || 'Result not specified',
        ...(stringValue(record.reason) ? { reason: stringValue(record.reason) } : {}),
        ...(typeof record.shouldAvoidRetry === 'boolean' ? { shouldAvoidRetry: record.shouldAvoidRetry } : {}),
      }
    }),
    unresolvedQuestions: stringArray(value.unresolvedQuestions).slice(0, 12),
    nextStrategy: stringArray(value.nextStrategy).slice(0, 12),
    riskNotes: stringArray(value.riskNotes).slice(0, 12),
    generatedAt: stringValue(value.generatedAt) || fallback.createdAt,
    sourceMessageCount: numberValue(value.sourceMessageCount) ?? fallback.sourceMessageCount,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : []
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}
