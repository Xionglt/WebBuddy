import {
  contextCompactor,
  type ContextCompactionInput,
  type ContextCompactor,
} from './compaction.js'
import type { ContextCompactionResult } from './run-summary.js'
import { COMPACTED_RUN_CONTEXT_PREFIX } from './run-summary.js'
import {
  microCompactMessages,
  shouldMicroCompact,
  type MicroCompactionOptions,
  type MicroCompactionResult,
} from './micro-compaction.js'
import {
  fallbackSemanticSummary,
  semanticCompactor,
  type SemanticCompactionLlm,
  type SemanticCompactor,
} from './semantic-compactor.js'
import {
  estimateChatMessages,
  estimateTokenBudget,
  type TokenBudgetOptions,
  type TokenBudgetSnapshot,
} from '../kernel/token-budget.js'
import type { ChatMessage } from '../sdk/llm.js'

export interface ContextCompactionPipelineInput extends Omit<ContextCompactionInput, 'messages' | 'semanticSummary' | 'compactMode'> {
  messages: ChatMessage[]
  systemContent: string
  tokenBudgetOptions?: TokenBudgetOptions
  /** Legacy fixed-count override. The default path retains a token-budgeted raw tail. */
  keepRecentMessages?: number
  /** Fraction of the model input window reserved for verbatim recent history after full compaction. */
  recentRawTokenRatio?: number
  compactor?: AgentLoopContextCompactorLike
  semanticLlm?: SemanticCompactionLlm
  semanticCompaction?: SemanticCompactionPipelineOptions
  microCompaction?: MicroCompactionOptions
}

export interface SemanticCompactionPipelineOptions {
  enabled?: boolean
  includeFallbackSummary?: boolean
  compactor?: SemanticCompactor
}

export interface ContextCompactionPipelineResult {
  messages: ChatMessage[]
  changed: boolean
  fullCompactionApplied: boolean
  microCompaction?: MicroCompactionResult
  compaction?: ContextCompactionResult
  tokenBudget: TokenBudgetSnapshot
  postMicroTokenBudget?: TokenBudgetSnapshot
  postCompactionTokenBudget?: TokenBudgetSnapshot
  recentRawRetention?: RecentRawRetentionStats
  reason?: string
  semanticError?: string
}

export interface RecentRawRetentionStats {
  selectionMode: 'token_ratio' | 'message_count'
  sourceMessageCount: number
  sourceTokens: number
  retainedMessageCount: number
  retainedBoundaryGroupCount: number
  retainedTokens: number
  compactedHistoryTokens: number
  maxInputTokens?: number
  targetTokens?: number
  recentRawTokenRatio?: number
  keepRecentMessages?: number
}

export interface AgentLoopContextCompactorLike {
  compact(input: ContextCompactionInput): ContextCompactionResult | Promise<ContextCompactionResult>
}

export const DEFAULT_KEEP_RECENT_MESSAGES = 6
export const DEFAULT_RECENT_RAW_TOKEN_RATIO = 0.2

export async function compactContextIfNeeded(
  input: ContextCompactionPipelineInput,
): Promise<ContextCompactionPipelineResult> {
  const tokenBudget = estimateTokenBudget(input.messages, input.tokenBudgetOptions)
  let workingMessages = input.messages
  let microCompaction: MicroCompactionResult | undefined
  let postMicroTokenBudget: TokenBudgetSnapshot | undefined
  const microDecision = shouldMicroCompact(workingMessages, tokenBudget, input.microCompaction)
  if (microDecision.compact) {
    microCompaction = microCompactMessages(workingMessages, input.microCompaction)
    if (microCompaction.applied) {
      workingMessages = microCompaction.messages
      postMicroTokenBudget = estimateTokenBudget(workingMessages, input.tokenBudgetOptions)
    }
  }

  const budgetForFullCompact = postMicroTokenBudget ?? tokenBudget
  if (!budgetForFullCompact.compactRecommended) {
    return {
      messages: workingMessages,
      changed: workingMessages !== input.messages,
      fullCompactionApplied: false,
      ...(microCompaction ? { microCompaction } : {}),
      tokenBudget,
      ...(postMicroTokenBudget ? { postMicroTokenBudget } : {}),
      ...(microCompaction?.reason ?? microDecision.reason ? { reason: microCompaction?.reason ?? microDecision.reason } : {}),
    }
  }

  const reason = compactReason(budgetForFullCompact)
  const recent = recentMessagesForCompaction(workingMessages, {
    maxInputTokens: budgetForFullCompact.maxInputTokens,
    ...(input.keepRecentMessages !== undefined ? { keepRecentMessages: input.keepRecentMessages } : {}),
    recentRawTokenRatio: input.recentRawTokenRatio ?? DEFAULT_RECENT_RAW_TOKEN_RATIO,
  })
  const baseCompactionInput: ContextCompactionInput = {
    ...input,
    messages: workingMessages,
    trigger: input.trigger ?? triggerFromBudget(tokenBudget, microCompaction),
    compactMode: 'structured',
  }
  const selectedCompactor = input.compactor ?? contextCompactor
  const structuredOnly = await Promise.resolve(selectedCompactor.compact(baseCompactionInput))

  let finalCompaction = structuredOnly
  let semanticError: string | undefined
  if (input.semanticCompaction?.enabled !== false) {
    try {
      const llm = input.semanticLlm
      if (!llm || typeof llm.chat !== 'function') {
        throw new Error('Semantic compaction skipped because no chat-capable LLM is available.')
      }
      const semantic = await (input.semanticCompaction?.compactor ?? semanticCompactor).summarize({
        llm,
        messages: recent.historyMessages,
        structuredSummary: structuredOnly.summary,
        createdAt: structuredOnly.summary.createdAt,
      })
      finalCompaction = await Promise.resolve(selectedCompactor.compact({
        ...baseCompactionInput,
        compactMode: 'structured_semantic',
        semanticSummary: semantic,
      }))
    } catch (error) {
      semanticError = error instanceof Error ? error.message : String(error)
      if (input.semanticCompaction?.includeFallbackSummary === true) {
        finalCompaction = await Promise.resolve(selectedCompactor.compact({
          ...baseCompactionInput,
          compactMode: 'structured_semantic',
          semanticSummary: fallbackSemanticSummary({
            error,
            messages: recent.historyMessages,
            createdAt: structuredOnly.summary.createdAt,
          }),
        }))
      }
    }
  }

  const compactedMessages: ChatMessage[] = [
    { role: 'system', content: input.systemContent },
    finalCompaction.compactedMessage,
    ...recent.messages,
  ]
  const postCompactionTokenBudget = estimateTokenBudget(compactedMessages, input.tokenBudgetOptions)
  return {
    messages: compactedMessages,
    changed: true,
    fullCompactionApplied: true,
    ...(microCompaction ? { microCompaction } : {}),
    compaction: finalCompaction,
    tokenBudget,
    ...(postMicroTokenBudget ? { postMicroTokenBudget } : {}),
    postCompactionTokenBudget,
    recentRawRetention: recent.stats,
    reason,
    ...(semanticError ? { semanticError } : {}),
  }
}

export function compactedMessageSet(
  messages: ChatMessage[],
  input: {
    systemContent: string
    compactedMessage: ChatMessage
    keepRecentMessages?: number
    maxInputTokens?: number
    recentRawTokenRatio?: number
  },
): ChatMessage[] {
  return createCompactedMessageSet(messages, input).messages
}

export function createCompactedMessageSet(
  messages: ChatMessage[],
  input: {
    systemContent: string
    compactedMessage: ChatMessage
    keepRecentMessages?: number
    maxInputTokens?: number
    recentRawTokenRatio?: number
  },
): { messages: ChatMessage[]; recentRawRetention: RecentRawRetentionStats } {
  const recent = recentMessagesForCompaction(messages, input)
  return {
    messages: [
      { role: 'system', content: input.systemContent },
      input.compactedMessage,
      ...recent.messages,
    ],
    recentRawRetention: recent.stats,
  }
}

export function sanitizeMessageBoundary(messages: ChatMessage[]): ChatMessage[] {
  return messageBoundaryGroups(messages).flat()
}

export function isCompactedRunContextMessage(message: ChatMessage): boolean {
  return message.role === 'user' && message.content.startsWith(COMPACTED_RUN_CONTEXT_PREFIX)
}

export function isCompactedRunContextSystemMarker(message: ChatMessage): boolean {
  return message.role === 'system' && message.content === 'RESTORED_COMPACTED_RUN_CONTEXT'
}

function recentMessagesForCompaction(
  messages: ChatMessage[],
  input: {
    keepRecentMessages?: number
    maxInputTokens?: number
    recentRawTokenRatio?: number
  },
): { messages: ChatMessage[]; historyMessages: ChatMessage[]; stats: RecentRawRetentionStats } {
  const candidates = messages.filter((message) => (
    message.role !== 'system' && !isCompactedRunContextMessage(message)
  ))

  if (input.keepRecentMessages !== undefined) {
    const keep = normalizeKeepRecentMessages(input.keepRecentMessages)
    const selected = keep === 0 ? [] : boundedMessageTail(candidates, keep)
    return recentMessageSelection(messages, selected, {
      selectionMode: 'message_count',
      keepRecentMessages: keep,
    })
  }

  if (isPositiveFinite(input.maxInputTokens)) {
    const ratio = normalizeRecentRawTokenRatio(input.recentRawTokenRatio)
    const targetTokens = Math.max(1, Math.floor(input.maxInputTokens * ratio))
    const groups = messageBoundaryGroups(candidates)
    const selected: ChatMessage[][] = []
    let retainedTokens = 0

    for (let index = groups.length - 1; index >= 0; index -= 1) {
      const group = groups[index]
      const groupTokens = estimateChatMessages(group).totalTokens
      if (selected.length > 0 && retainedTokens + groupTokens > targetTokens) break
      selected.unshift(group)
      retainedTokens += groupTokens
    }

    const retained = sanitizeMessageBoundary(selected.flat())
    return recentMessageSelection(messages, retained, {
      selectionMode: 'token_ratio',
      maxInputTokens: Math.floor(input.maxInputTokens),
      targetTokens,
      recentRawTokenRatio: ratio,
    })
  }

  const keep = DEFAULT_KEEP_RECENT_MESSAGES
  const selected = boundedMessageTail(candidates, keep)
  return recentMessageSelection(messages, selected, {
    selectionMode: 'message_count',
    keepRecentMessages: keep,
  })
}

function recentMessageSelection(
  sourceMessages: ChatMessage[],
  selected: ChatMessage[],
  mode: Pick<
    RecentRawRetentionStats,
    'selectionMode' | 'keepRecentMessages' | 'maxInputTokens' | 'targetTokens' | 'recentRawTokenRatio'
  >,
): { messages: ChatMessage[]; historyMessages: ChatMessage[]; stats: RecentRawRetentionStats } {
  const retained = sanitizeMessageBoundary(selected)
  const retainedSet = new Set(retained)
  const source = sourceMessages.filter((message) => message.role !== 'system')
  const historyMessages = sanitizeMessageBoundary(source.filter((message) => !retainedSet.has(message)))
  const sourceTokens = estimateChatMessages(source).totalTokens
  const retainedTokens = estimateChatMessages(retained).totalTokens
  const compactedHistoryTokens = estimateChatMessages(historyMessages).totalTokens
  return {
    messages: retained,
    historyMessages,
    stats: {
      selectionMode: mode.selectionMode,
      sourceMessageCount: source.length,
      sourceTokens,
      retainedMessageCount: retained.length,
      retainedBoundaryGroupCount: messageBoundaryGroups(retained).length,
      retainedTokens,
      compactedHistoryTokens,
      ...(mode.maxInputTokens !== undefined ? { maxInputTokens: mode.maxInputTokens } : {}),
      ...(mode.targetTokens !== undefined ? { targetTokens: mode.targetTokens } : {}),
      ...(mode.recentRawTokenRatio !== undefined ? { recentRawTokenRatio: mode.recentRawTokenRatio } : {}),
      ...(mode.keepRecentMessages !== undefined ? { keepRecentMessages: mode.keepRecentMessages } : {}),
    },
  }
}

function boundedMessageTail(messages: ChatMessage[], keepRecentMessages: number): ChatMessage[] {
  const groups = messageBoundaryGroups(messages)
  const selected: ChatMessage[][] = []
  let selectedCount = 0

  for (let index = groups.length - 1; index >= 0 && selectedCount < keepRecentMessages; index -= 1) {
    selected.unshift(groups[index])
    selectedCount += groups[index].length
  }

  return sanitizeMessageBoundary(selected.flat())
}

function messageBoundaryGroups(messages: ChatMessage[]): ChatMessage[][] {
  const groups: ChatMessage[][] = []
  let index = 0
  while (index < messages.length) {
    const message = messages[index]
    if (message.role === 'tool') {
      index += 1
      continue
    }

    if (message.role === 'assistant' && message.tool_calls?.length) {
      const expectedToolCallIds = new Set(message.tool_calls.map((toolCall) => toolCall.id))
      const group: ChatMessage[] = [message]
      let cursor = index + 1
      while (cursor < messages.length && messages[cursor].role === 'tool') {
        const toolMessage = messages[cursor]
        if (toolMessage.tool_call_id && expectedToolCallIds.has(toolMessage.tool_call_id)) {
          group.push(toolMessage)
          expectedToolCallIds.delete(toolMessage.tool_call_id)
        }
        cursor += 1
      }
      if (expectedToolCallIds.size === 0) groups.push(group)
      index = cursor
      continue
    }

    groups.push([message])
    index += 1
  }
  return groups
}

function normalizeKeepRecentMessages(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_KEEP_RECENT_MESSAGES
  return Math.max(0, Math.floor(value))
}

function normalizeRecentRawTokenRatio(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) && value > 0 && value < 1
    ? value
    : DEFAULT_RECENT_RAW_TOKEN_RATIO
}

function isPositiveFinite(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value > 0
}

function compactReason(tokenBudget: TokenBudgetSnapshot): string {
  const estimated = tokenBudget.estimatedTotalTokens ?? 0
  const threshold = tokenBudget.compactThresholdTokens
  if (threshold !== undefined) {
    return `Estimated context ${estimated} tokens reached compaction threshold ${threshold}.`
  }
  return `Estimated context ${estimated} tokens reached compaction threshold.`
}

function triggerFromBudget(
  tokenBudget: TokenBudgetSnapshot,
  microCompaction: MicroCompactionResult | undefined,
): ContextCompactionInput['trigger'] {
  if (microCompaction?.applied) return 'tool_result_pressure'
  return tokenBudget.compactRecommended ? 'token_threshold' : 'token_threshold'
}
