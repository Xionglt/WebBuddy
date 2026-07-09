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
import { estimateTokenBudget, type TokenBudgetOptions, type TokenBudgetSnapshot } from '../kernel/token-budget.js'
import type { ChatMessage } from '../sdk/llm.js'

export interface ContextCompactionPipelineInput extends Omit<ContextCompactionInput, 'messages' | 'semanticSummary' | 'compactMode'> {
  messages: ChatMessage[]
  systemContent: string
  tokenBudgetOptions?: TokenBudgetOptions
  keepRecentMessages?: number
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
  reason?: string
  semanticError?: string
}

export interface AgentLoopContextCompactorLike {
  compact(input: ContextCompactionInput): ContextCompactionResult | Promise<ContextCompactionResult>
}

export const DEFAULT_KEEP_RECENT_MESSAGES = 6

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
        messages: workingMessages,
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
            messages: workingMessages,
            createdAt: structuredOnly.summary.createdAt,
          }),
        }))
      }
    }
  }

  const compactedMessages = compactedMessageSet(workingMessages, {
    systemContent: input.systemContent,
    compactedMessage: finalCompaction.compactedMessage,
    keepRecentMessages: input.keepRecentMessages ?? DEFAULT_KEEP_RECENT_MESSAGES,
  })
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
    reason,
    ...(semanticError ? { semanticError } : {}),
  }
}

export function compactedMessageSet(
  messages: ChatMessage[],
  input: {
    systemContent: string
    compactedMessage: ChatMessage
    keepRecentMessages: number
  },
): ChatMessage[] {
  return [
    { role: 'system', content: input.systemContent },
    input.compactedMessage,
    ...recentMessagesForCompaction(messages, input.keepRecentMessages),
  ]
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

function recentMessagesForCompaction(messages: ChatMessage[], keepRecentMessages: number): ChatMessage[] {
  const keep = normalizeKeepRecentMessages(keepRecentMessages)
  if (keep === 0) return []
  const candidates = messages.filter((message) => (
    message.role !== 'system' && !isCompactedRunContextMessage(message)
  ))
  return boundedMessageTail(candidates, keep)
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
