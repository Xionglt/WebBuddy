import type { TokenBudgetSnapshot } from '../kernel/token-budget.js'
import type { PromptCacheSnapshot } from '../sdk/prompt-cache.js'

export type PromptCacheState = 'disabled' | 'unknown' | 'hot' | 'expiring' | 'expired'

export interface PromptCacheCompactionOptions {
  /** Fraction of the normal compact threshold beyond which cache preservation stops. */
  hardPressureRatio?: number
  /** Override the model cache safety margin. */
  safetyMarginMs?: number
  /** Deterministic clock override for tests. */
  now?: Date
}

export interface PromptCacheCompactionInput extends PromptCacheCompactionOptions {
  snapshot?: PromptCacheSnapshot
}

export interface PromptCacheCompactionDecision {
  cacheState: PromptCacheState
  deferDestructiveMicroCompaction: boolean
  reason: string
  cacheHitRatio?: number
  cumulativeCacheHitRatio?: number
  cacheActivityAt?: string
  expiresAt?: string
  compactAt?: string
  pressureRatio: number
  hardPressureRatio: number
}

const DEFAULT_HARD_PRESSURE_RATIO = 0.9

export function evaluatePromptCacheCompaction(input: {
  promptCache?: PromptCacheCompactionInput
  tokenBudget: TokenBudgetSnapshot
}): PromptCacheCompactionDecision {
  const hardPressureRatio = normalizeRatio(
    input.promptCache?.hardPressureRatio,
    DEFAULT_HARD_PRESSURE_RATIO,
  )
  const totalTokens = input.tokenBudget.estimatedTotalTokens ?? 0
  const compactThreshold = input.tokenBudget.compactThresholdTokens
  const pressureRatio = compactThreshold > 0 ? totalTokens / compactThreshold : 0
  const snapshot = input.promptCache?.snapshot

  if (!snapshot || snapshot.capability.requestMode === 'disabled') {
    return {
      cacheState: 'disabled',
      deferDestructiveMicroCompaction: false,
      reason: 'Prompt-cache-aware compaction is disabled.',
      pressureRatio,
      hardPressureRatio,
    }
  }

  const capability = snapshot.capability
  const ttlMs = capability.ttlMs
  const cacheActivityAt = parseDate(snapshot.cacheActivityAt)
  if (!capability.requestEnabled || !ttlMs || !cacheActivityAt) {
    return {
      cacheState: 'unknown',
      deferDestructiveMicroCompaction: false,
      reason: !capability.requestEnabled
        ? 'The endpoint is observe-only; request-side cache semantics were not assumed.'
        : !ttlMs
          ? 'The provider/model cache TTL is unknown.'
          : 'No cache read or cache creation has been observed yet.',
      ...(snapshot.lastUsage ? { cacheHitRatio: snapshot.lastUsage.cacheHitRatio } : {}),
      cumulativeCacheHitRatio: snapshot.totals.cacheHitRatio,
      pressureRatio,
      hardPressureRatio,
    }
  }

  const now = input.promptCache?.now ?? new Date()
  const safetyMarginMs = normalizedSafetyMargin(
    input.promptCache?.safetyMarginMs
      ?? capability.safetyMarginMs,
    ttlMs,
  )
  const expiresAt = new Date(cacheActivityAt.getTime() + ttlMs)
  const compactAt = new Date(Math.max(cacheActivityAt.getTime(), expiresAt.getTime() - safetyMarginMs))
  const cacheState: PromptCacheState = now >= expiresAt
    ? 'expired'
    : now >= compactAt
      ? 'expiring'
      : 'hot'
  const hardPressureReached = input.tokenBudget.compactRecommended || pressureRatio >= hardPressureRatio
  const defer = cacheState === 'hot' && !hardPressureReached

  return {
    cacheState,
    deferDestructiveMicroCompaction: defer,
    reason: defer
      ? 'The cached prefix is still hot; defer destructive micro-compaction until the cache nears expiry.'
      : hardPressureReached
        ? 'Context pressure reached the cache-deferral ceiling; compact even if the prefix cache is hot.'
        : cacheState === 'expiring'
          ? 'The cache horizon is inside its expiry safety margin; compact now so the next request can establish a new prefix.'
          : 'The configured cache scheduling horizon has elapsed; compact before rebuilding the prefix.',
    ...(snapshot.lastUsage ? { cacheHitRatio: snapshot.lastUsage.cacheHitRatio } : {}),
    cumulativeCacheHitRatio: snapshot.totals.cacheHitRatio,
    cacheActivityAt: cacheActivityAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    compactAt: compactAt.toISOString(),
    pressureRatio,
    hardPressureRatio,
  }
}

function parseDate(value: string | undefined): Date | undefined {
  if (!value) return undefined
  const parsed = new Date(value)
  return Number.isFinite(parsed.getTime()) ? parsed : undefined
}

function normalizeRatio(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return fallback
  return Math.min(1, value)
}

function normalizedSafetyMargin(value: number | undefined, ttlMs: number): number {
  if (value !== undefined && Number.isFinite(value) && value >= 0) {
    return Math.min(ttlMs, value)
  }
  return Math.min(60_000, Math.max(5_000, Math.floor(ttlMs * 0.1)))
}
