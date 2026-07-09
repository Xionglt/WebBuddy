import type { ChatMessage } from '../sdk/llm.js'

export interface TokenBudgetSnapshot {
  version: 1
  maxInputTokens: number
  modelName?: string
  compactThresholdRatio?: number
  compactThresholdTokens: number
  estimatedInputTokens?: number
  estimatedToolResultTokens?: number
  estimatedTotalTokens?: number
  compactRecommended: boolean
  usingDefaultMaxInputTokens?: boolean
  warnings?: string[]
}

export interface TokenBudgetOptions {
  maxInputTokens?: number
  modelName?: string
  modelMaxInputTokens?: number
  compactThresholdRatio?: number
}

export interface TokenBudgetEstimate {
  inputTokens: number
  toolResultTokens: number
  totalTokens: number
}

const DEFAULT_COMPACT_THRESHOLD_RATIO = 0.8
export const DEFAULT_MAX_INPUT_TOKENS = 32_000
const MESSAGE_OVERHEAD_TOKENS = 4
const TOOL_CALL_OVERHEAD_TOKENS = 8
const MODEL_MAX_INPUT_TOKENS: Array<{ pattern: RegExp; maxInputTokens: number }> = [
  { pattern: /gpt-5|gpt-4\.1|gpt-4o|o3|o4/i, maxInputTokens: 120_000 },
  { pattern: /claude-3\.7|claude-sonnet-4|claude-opus-4|claude-4/i, maxInputTokens: 180_000 },
  { pattern: /glm-4\.7|glm-4\.5|qwen3|qwen-?max|deepseek/i, maxInputTokens: 120_000 },
  { pattern: /llama|mistral|mixtral/i, maxInputTokens: 32_000 },
]

export class TokenBudget {
  private estimatedInputTokens = 0
  private estimatedToolResultTokens = 0
  private readonly compactThresholdRatio: number

  constructor(private readonly options: TokenBudgetOptions = {}) {
    this.compactThresholdRatio = normalizeCompactThresholdRatio(options.compactThresholdRatio)
  }

  recordInputText(text: string): void {
    this.estimatedInputTokens += estimateTokens(text)
  }

  recordToolResultText(text: string): void {
    this.estimatedToolResultTokens += estimateTokens(text)
  }

  recordToolObservation(observation: unknown): void {
    this.estimatedToolResultTokens += estimateToolObservationTokens(observation)
  }

  recordChatMessages(messages: ChatMessage[]): void {
    const estimate = estimateChatMessages(messages)
    this.estimatedInputTokens += estimate.inputTokens
    this.estimatedToolResultTokens += estimate.toolResultTokens
  }

  snapshot(): TokenBudgetSnapshot {
    return createSnapshot({
      inputTokens: this.estimatedInputTokens,
      toolResultTokens: this.estimatedToolResultTokens,
      totalTokens: this.estimatedInputTokens + this.estimatedToolResultTokens,
    }, {
      maxInputTokens: this.options.maxInputTokens,
      compactThresholdRatio: this.compactThresholdRatio,
    })
  }
}

export function createTokenBudgetSnapshot(options: TokenBudgetOptions = {}): TokenBudgetSnapshot {
  return new TokenBudget(options).snapshot()
}

export function estimateTokenBudget(messages: ChatMessage[], options: TokenBudgetOptions = {}): TokenBudgetSnapshot {
  return createSnapshot(estimateChatMessages(messages), options)
}

export function estimateChatMessages(messages: ChatMessage[]): TokenBudgetEstimate {
  const estimate: TokenBudgetEstimate = {
    inputTokens: 0,
    toolResultTokens: 0,
    totalTokens: 0,
  }

  for (const message of messages) {
    const messageTokens = estimateChatMessageTokens(message)
    if (message.role === 'tool') estimate.toolResultTokens += messageTokens
    else estimate.inputTokens += messageTokens
  }

  estimate.totalTokens = estimate.inputTokens + estimate.toolResultTokens
  return estimate
}

export function estimateToolObservationTokens(observation: unknown): number {
  return estimateTokens(stringifyForTokenEstimate(observation))
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

function estimateChatMessageTokens(message: ChatMessage): number {
  let tokens = MESSAGE_OVERHEAD_TOKENS + estimateTokens(message.content)

  if (message.name) tokens += estimateTokens(message.name)
  if (message.tool_call_id) tokens += estimateTokens(message.tool_call_id)

  for (const toolCall of message.tool_calls ?? []) {
    tokens += TOOL_CALL_OVERHEAD_TOKENS
    tokens += estimateTokens(toolCall.id)
    tokens += estimateTokens(toolCall.function.name)
    tokens += estimateTokens(toolCall.function.arguments)
  }

  return tokens
}

function createSnapshot(estimate: TokenBudgetEstimate, options: TokenBudgetOptions): TokenBudgetSnapshot {
  const compactThresholdRatio = normalizeCompactThresholdRatio(options.compactThresholdRatio)
  const resolved = resolveMaxInputTokens(options)
  const max = resolved.maxInputTokens
  const compactThresholdTokens = Math.ceil(max * compactThresholdRatio)
  return {
    version: 1,
    maxInputTokens: max,
    ...(resolved.modelName ? { modelName: resolved.modelName } : {}),
    compactThresholdRatio,
    compactThresholdTokens,
    estimatedInputTokens: estimate.inputTokens,
    estimatedToolResultTokens: estimate.toolResultTokens,
    estimatedTotalTokens: estimate.totalTokens,
    compactRecommended: estimate.totalTokens >= compactThresholdTokens,
    ...(resolved.usingDefaultMaxInputTokens ? { usingDefaultMaxInputTokens: true } : {}),
    ...(resolved.warnings.length ? { warnings: resolved.warnings } : {}),
  }
}

function resolveMaxInputTokens(options: TokenBudgetOptions): {
  maxInputTokens: number
  modelName?: string
  usingDefaultMaxInputTokens: boolean
  warnings: string[]
} {
  if (isPositiveFinite(options.maxInputTokens)) {
    return {
      maxInputTokens: Math.floor(options.maxInputTokens),
      ...(options.modelName ? { modelName: options.modelName } : {}),
      usingDefaultMaxInputTokens: false,
      warnings: [],
    }
  }

  if (isPositiveFinite(options.modelMaxInputTokens)) {
    return {
      maxInputTokens: Math.floor(options.modelMaxInputTokens),
      ...(options.modelName ? { modelName: options.modelName } : {}),
      usingDefaultMaxInputTokens: false,
      warnings: [],
    }
  }

  const modelName = options.modelName?.trim()
  if (modelName) {
    const known = MODEL_MAX_INPUT_TOKENS.find((entry) => entry.pattern.test(modelName))
    if (known) {
      return {
        maxInputTokens: known.maxInputTokens,
        modelName,
        usingDefaultMaxInputTokens: false,
        warnings: [],
      }
    }
    return {
      maxInputTokens: DEFAULT_MAX_INPUT_TOKENS,
      modelName,
      usingDefaultMaxInputTokens: true,
      warnings: [
        `Unknown model context window for "${modelName}"; using conservative default ${DEFAULT_MAX_INPUT_TOKENS} input tokens.`,
      ],
    }
  }

  return {
    maxInputTokens: DEFAULT_MAX_INPUT_TOKENS,
    usingDefaultMaxInputTokens: true,
    warnings: [
      `No model context window configured; using conservative default ${DEFAULT_MAX_INPUT_TOKENS} input tokens.`,
    ],
  }
}

function isPositiveFinite(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value > 0
}

function normalizeCompactThresholdRatio(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) && value > 0
    ? value
    : DEFAULT_COMPACT_THRESHOLD_RATIO
}

function stringifyForTokenEstimate(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === undefined) return ''
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}
