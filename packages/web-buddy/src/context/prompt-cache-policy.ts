import type { TokenBudgetSnapshot } from '../kernel/token-budget.js'
import type { PromptCacheSnapshot } from '../sdk/prompt-cache.js'

export type PromptCacheState = 'disabled' | 'unknown' | 'warming' | 'hot' | 'cold' | 'expiring' | 'expired'

export interface PromptCacheCompactionOptions {
  /** Fraction of the normal compact threshold beyond which cache preservation stops. */
  hardPressureRatio?: number
  /** Override the model cache safety margin. */
  safetyMarginMs?: number
  /** Per-request cache-read ratio below which an eligible prefix is treated as a miss. */
  minimumHotCacheHitRatio?: number
  /** Consecutive low-hit requests required before declaring the cache cold. */
  coldAfterLowHitRequests?: number
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
  minimumHotCacheHitRatio: number
  lowCacheHitStreak: number
}

const DEFAULT_HARD_PRESSURE_RATIO = 0.9
const DEFAULT_MINIMUM_HOT_CACHE_HIT_RATIO = 0.2
const DEFAULT_COLD_AFTER_LOW_HIT_REQUESTS = 2
const MAX_TRACKED_LOW_HIT_REQUESTS = 10

export function evaluatePromptCacheCompaction(input: {
  promptCache?: PromptCacheCompactionInput
  tokenBudget: TokenBudgetSnapshot
}): PromptCacheCompactionDecision {
  const hardPressureRatio = normalizeRatio(
    input.promptCache?.hardPressureRatio,
    DEFAULT_HARD_PRESSURE_RATIO,
  )
  const minimumHotCacheHitRatio = normalizeRatio(
    input.promptCache?.minimumHotCacheHitRatio,
    DEFAULT_MINIMUM_HOT_CACHE_HIT_RATIO,
  )
  const coldAfterLowHitRequests = normalizePositiveInteger(
    input.promptCache?.coldAfterLowHitRequests,
    DEFAULT_COLD_AFTER_LOW_HIT_REQUESTS,
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
      minimumHotCacheHitRatio,
      lowCacheHitStreak: 0,
    }
  }

  const capability = snapshot.capability
  const lowCacheHitStreak = consecutiveLowCacheHitRequests(
    snapshot,
    minimumHotCacheHitRatio,
  )
  const cacheObservedCold = capability.requestEnabled
    && lowCacheHitStreak >= coldAfterLowHitRequests
  if (cacheObservedCold) {
    return {
      cacheState: 'cold',
      deferDestructiveMicroCompaction: false,
      reason: `Prompt-cache reads stayed below ${Math.round(minimumHotCacheHitRatio * 100)}% for ${lowCacheHitStreak} consecutive eligible requests.`,
      ...(snapshot.lastUsage ? { cacheHitRatio: snapshot.lastUsage.cacheHitRatio } : {}),
      cumulativeCacheHitRatio: snapshot.totals.cacheHitRatio,
      ...(snapshot.cacheActivityAt ? { cacheActivityAt: snapshot.cacheActivityAt } : {}),
      pressureRatio,
      hardPressureRatio,
      minimumHotCacheHitRatio,
      lowCacheHitStreak,
    }
  }
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
      minimumHotCacheHitRatio,
      lowCacheHitStreak,
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
  const cacheWasJustCreated = Boolean(
    snapshot.lastUsage
    && snapshot.lastUsage.cacheReadInputTokens === 0
    && (snapshot.lastUsage.cacheCreationInputTokens > 0 || snapshot.lastUsage.cacheWriteInferred),
  )
  const cacheState: PromptCacheState = now >= expiresAt
    ? 'expired'
    : now >= compactAt
      ? 'expiring'
      : cacheWasJustCreated
        ? 'warming'
        : 'hot'
  const hardPressureReached = input.tokenBudget.compactRecommended || pressureRatio >= hardPressureRatio
  const defer = (cacheState === 'hot' || cacheState === 'warming') && !hardPressureReached

  return {
    cacheState,
    deferDestructiveMicroCompaction: defer,
    reason: defer
      ? cacheState === 'warming'
        ? 'A new cached prefix was just created; defer destructive micro-compaction so the next request can reuse it.'
        : 'The cached prefix is still hot; defer destructive micro-compaction until the cache nears expiry.'
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
    minimumHotCacheHitRatio,
    lowCacheHitStreak,
  }
}

function consecutiveLowCacheHitRequests(
  snapshot: PromptCacheSnapshot,
  minimumHotCacheHitRatio: number,
): number {
  const recent = snapshot.recentUsages
    ?? (snapshot.lastUsage ? [snapshot.lastUsage] : [])
  const minimumCacheableTokens = snapshot.capability.minimumCacheableTokens ?? 1
  let streak = 0
  for (let index = recent.length - 1; index >= 0; index -= 1) {
    const usage = recent[index]
    const eligible = usage.inputTokens >= minimumCacheableTokens
    const cacheWasCreated = usage.cacheCreationInputTokens > 0 || usage.cacheWriteInferred
    if (!eligible || cacheWasCreated || usage.cacheHitRatio >= minimumHotCacheHitRatio) break
    streak += 1
  }
  return streak
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

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return fallback
  return Math.min(MAX_TRACKED_LOW_HIT_REQUESTS, Math.max(1, Math.floor(value)))
}

function normalizedSafetyMargin(value: number | undefined, ttlMs: number): number {
  if (value !== undefined && Number.isFinite(value) && value >= 0) {
    return Math.min(ttlMs, value)
  }
  return Math.min(60_000, Math.max(5_000, Math.floor(ttlMs * 0.1)))
}
