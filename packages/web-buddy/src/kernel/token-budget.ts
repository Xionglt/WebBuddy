export interface TokenBudgetSnapshot {
  version: 1
  maxInputTokens?: number
  estimatedInputTokens?: number
  estimatedToolResultTokens?: number
  compactRecommended: boolean
}

export interface TokenBudgetOptions {
  maxInputTokens?: number
  compactThresholdRatio?: number
}

export class TokenBudget {
  private estimatedInputTokens = 0
  private estimatedToolResultTokens = 0
  private readonly compactThresholdRatio: number

  constructor(private readonly options: TokenBudgetOptions = {}) {
    this.compactThresholdRatio = options.compactThresholdRatio ?? 0.8
  }

  recordInputText(text: string): void {
    this.estimatedInputTokens += estimateTokens(text)
  }

  recordToolResultText(text: string): void {
    this.estimatedToolResultTokens += estimateTokens(text)
  }

  snapshot(): TokenBudgetSnapshot {
    const total = this.estimatedInputTokens + this.estimatedToolResultTokens
    const max = this.options.maxInputTokens
    return {
      version: 1,
      ...(max !== undefined ? { maxInputTokens: max } : {}),
      estimatedInputTokens: this.estimatedInputTokens,
      estimatedToolResultTokens: this.estimatedToolResultTokens,
      compactRecommended: max !== undefined ? total >= max * this.compactThresholdRatio : false,
    }
  }
}

export function createTokenBudgetSnapshot(options: TokenBudgetOptions = {}): TokenBudgetSnapshot {
  return new TokenBudget(options).snapshot()
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}
