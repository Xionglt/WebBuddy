import { createHash } from 'node:crypto'
import type { ModelConfig, PromptCacheTtl } from './config.js'

export type PromptCacheRequestMode =
  | 'anthropic_explicit'
  | 'openai_automatic'
  | 'observe_only'
  | 'disabled'

export type PromptCacheTtlSource = 'configured' | 'provider_default' | 'unknown'

export interface PromptCacheCapability {
  provider: ModelConfig['provider']
  model: string
  requestMode: PromptCacheRequestMode
  requestEnabled: boolean
  usageSupported: boolean
  ttlMs?: number
  ttlSource: PromptCacheTtlSource
  ttl?: PromptCacheTtl
  safetyMarginMs?: number
  minimumCacheableTokens?: number
}

export interface PromptCacheUsage {
  provider: ModelConfig['provider']
  model: string
  namespace: string
  inputTokens: number
  outputTokens: number
  totalTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
  uncachedInputTokens: number
  cacheHitRatio: number
  cacheWriteInferred: boolean
  requestStartedAt: string
  firstTokenAt?: string
  ttftMs?: number
  completedAt: string
  durationMs: number
}

export interface PromptCacheTotals {
  requests: number
  inputTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
  uncachedInputTokens: number
  cacheHitRatio: number
}

export interface PromptCacheSnapshot {
  capability: PromptCacheCapability
  namespace: string
  lastUsage?: PromptCacheUsage
  /** Bounded recent history used to distinguish a transient miss from a cold cache. */
  recentUsages?: PromptCacheUsage[]
  cacheActivityAt?: string
  totals: PromptCacheTotals
}

export interface OpenAiUsagePayload {
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
  prompt_tokens_details?: {
    cached_tokens?: number
    cache_write_tokens?: number
  }
}

export interface AnthropicUsagePayload {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

const TTL_MS: Record<PromptCacheTtl, number> = {
  '5m': 5 * 60_000,
  '30m': 30 * 60_000,
  '1h': 60 * 60_000,
  '24h': 24 * 60 * 60_000,
}
const MAX_RECENT_CACHE_USAGES = 10

export function resolvePromptCacheCapability(model: ModelConfig): PromptCacheCapability {
  if (model.promptCache?.enabled === false) {
    return {
      provider: model.provider,
      model: model.name,
      requestMode: 'disabled',
      requestEnabled: false,
      usageSupported: true,
      ttlSource: 'unknown',
    }
  }

  const officialHost = isOfficialProviderHost(model)
  const explicitlyEnabled = model.promptCache?.enabled === true
  const requestEnabled = officialHost || explicitlyEnabled
  validatePromptCacheTtl(model)

  if (model.provider === 'anthropic') {
    const configuredTtl = model.promptCache?.ttl
    const ttl = configuredTtl === '1h' || configuredTtl === '5m'
      ? configuredTtl
      : '5m'
    return {
      provider: model.provider,
      model: model.name,
      requestMode: requestEnabled ? 'anthropic_explicit' : 'observe_only',
      requestEnabled,
      usageSupported: true,
      ...(requestEnabled ? { ttl, ttlMs: TTL_MS[ttl] } : {}),
      ...(model.promptCache?.safetyMarginMs !== undefined
        ? { safetyMarginMs: Math.max(0, model.promptCache.safetyMarginMs) }
        : {}),
      ttlSource: requestEnabled
        ? (configuredTtl ? 'configured' : 'provider_default')
        : 'unknown',
    }
  }

  const configuredTtl = model.promptCache?.ttl
  const gpt56OrNewer = isGpt56OrNewer(model.name)
  const ttl = configuredTtl ?? (officialHost && gpt56OrNewer ? '30m' : undefined)
  return {
    provider: model.provider,
    model: model.name,
    requestMode: requestEnabled ? 'openai_automatic' : 'observe_only',
    requestEnabled,
    usageSupported: true,
    ...(ttl ? { ttl, ttlMs: TTL_MS[ttl] } : {}),
    ...(model.promptCache?.safetyMarginMs !== undefined
      ? { safetyMarginMs: Math.max(0, model.promptCache.safetyMarginMs) }
      : {}),
    ttlSource: ttl
      ? (configuredTtl ? 'configured' : 'provider_default')
      : 'unknown',
    minimumCacheableTokens: 1024,
  }
}

export function anthropicCacheControl(
  capability: PromptCacheCapability,
): Record<string, unknown> | undefined {
  if (capability.requestMode !== 'anthropic_explicit' || !capability.requestEnabled) return undefined
  return {
    type: 'ephemeral',
    ...(capability.ttl === '1h' ? { ttl: '1h' } : {}),
  }
}

export function applyOpenAiPromptCacheFields(
  body: Record<string, unknown>,
  input: {
    capability: PromptCacheCapability
    promptCacheKey?: string
  },
): void {
  if (input.capability.requestMode !== 'openai_automatic' || !input.capability.requestEnabled) return
  if (input.promptCacheKey) body.prompt_cache_key = input.promptCacheKey

  if (input.capability.ttl === '30m' && isGpt56OrNewer(input.capability.model)) {
    body.prompt_cache_options = { ttl: '30m' }
    return
  }
  if (input.capability.ttl === '5m') {
    body.prompt_cache_retention = 'in_memory'
    return
  }
  if (input.capability.ttl === '24h') {
    body.prompt_cache_retention = '24h'
  }
}

export function normalizeOpenAiPromptCacheUsage(input: {
  usage?: OpenAiUsagePayload
  capability: PromptCacheCapability
  namespace: string
  requestStartedAt: Date
  firstTokenAt?: Date
  completedAt: Date
}): PromptCacheUsage {
  const promptTokens = nonNegative(input.usage?.prompt_tokens)
  const outputTokens = nonNegative(input.usage?.completion_tokens)
  const cacheRead = Math.min(promptTokens, nonNegative(input.usage?.prompt_tokens_details?.cached_tokens))
  const cacheCreation = Math.min(
    Math.max(0, promptTokens - cacheRead),
    nonNegative(input.usage?.prompt_tokens_details?.cache_write_tokens),
  )
  const cacheWriteInferred = input.capability.requestEnabled
    && !isGpt56OrNewer(input.capability.model)
    && promptTokens >= (input.capability.minimumCacheableTokens ?? Number.POSITIVE_INFINITY)
    && cacheRead === 0
    && cacheCreation === 0
  return usageResult({
    capability: input.capability,
    namespace: input.namespace,
    inputTokens: promptTokens,
    outputTokens,
    cacheReadInputTokens: cacheRead,
    cacheCreationInputTokens: cacheCreation,
    cacheWriteInferred,
    requestStartedAt: input.requestStartedAt,
    firstTokenAt: input.firstTokenAt,
    completedAt: input.completedAt,
  })
}

export function normalizeAnthropicPromptCacheUsage(input: {
  usage?: AnthropicUsagePayload
  capability: PromptCacheCapability
  namespace: string
  requestStartedAt: Date
  firstTokenAt?: Date
  completedAt: Date
}): PromptCacheUsage {
  const uncachedInput = nonNegative(input.usage?.input_tokens)
  const cacheRead = nonNegative(input.usage?.cache_read_input_tokens)
  const cacheCreation = nonNegative(input.usage?.cache_creation_input_tokens)
  return usageResult({
    capability: input.capability,
    namespace: input.namespace,
    inputTokens: uncachedInput + cacheRead + cacheCreation,
    outputTokens: nonNegative(input.usage?.output_tokens),
    cacheReadInputTokens: cacheRead,
    cacheCreationInputTokens: cacheCreation,
    cacheWriteInferred: false,
    requestStartedAt: input.requestStartedAt,
    firstTokenAt: input.firstTokenAt,
    completedAt: input.completedAt,
  })
}

export function accumulatePromptCacheSnapshot(
  previous: PromptCacheSnapshot | undefined,
  capability: PromptCacheCapability,
  usage: PromptCacheUsage,
): PromptCacheSnapshot {
  const totals = previous?.totals ?? emptyPromptCacheTotals()
  const nextInputTokens = totals.inputTokens + usage.inputTokens
  const nextCacheRead = totals.cacheReadInputTokens + usage.cacheReadInputTokens
  const nextCacheCreation = totals.cacheCreationInputTokens + usage.cacheCreationInputTokens
  const nextUncached = totals.uncachedInputTokens + usage.uncachedInputTokens
  const hasCacheActivity = usage.cacheReadInputTokens > 0
    || usage.cacheCreationInputTokens > 0
    || usage.cacheWriteInferred
  const recentUsages = [...(previous?.recentUsages ?? []), usage].slice(-MAX_RECENT_CACHE_USAGES)
  return {
    capability,
    namespace: usage.namespace,
    lastUsage: usage,
    recentUsages,
    ...(hasCacheActivity
      ? { cacheActivityAt: usage.completedAt }
      : previous?.cacheActivityAt
        ? { cacheActivityAt: previous.cacheActivityAt }
        : {}),
    totals: {
      requests: totals.requests + 1,
      inputTokens: nextInputTokens,
      cacheReadInputTokens: nextCacheRead,
      cacheCreationInputTokens: nextCacheCreation,
      uncachedInputTokens: nextUncached,
      cacheHitRatio: ratio(nextCacheRead, nextInputTokens),
    },
  }
}

export function emptyPromptCacheSnapshot(
  capability: PromptCacheCapability,
  namespace: string,
): PromptCacheSnapshot {
  return {
    capability,
    namespace,
    totals: emptyPromptCacheTotals(),
  }
}

export function promptCacheKeyForScope(scope: string): string {
  return `web-buddy-${createHash('sha256').update(scope).digest('hex').slice(0, 32)}`
}

export function promptCacheTtlMs(ttl: PromptCacheTtl): number {
  return TTL_MS[ttl]
}

function usageResult(input: {
  capability: PromptCacheCapability
  namespace: string
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
  cacheWriteInferred: boolean
  requestStartedAt: Date
  firstTokenAt?: Date
  completedAt: Date
}): PromptCacheUsage {
  const uncachedInputTokens = Math.max(0, input.inputTokens - input.cacheReadInputTokens)
  return {
    provider: input.capability.provider,
    model: input.capability.model,
    namespace: input.namespace,
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
    totalTokens: input.inputTokens + input.outputTokens,
    cacheReadInputTokens: input.cacheReadInputTokens,
    cacheCreationInputTokens: input.cacheCreationInputTokens,
    uncachedInputTokens,
    cacheHitRatio: ratio(input.cacheReadInputTokens, input.inputTokens),
    cacheWriteInferred: input.cacheWriteInferred,
    requestStartedAt: input.requestStartedAt.toISOString(),
    ...(input.firstTokenAt
      ? {
          firstTokenAt: input.firstTokenAt.toISOString(),
          ttftMs: Math.max(0, input.firstTokenAt.getTime() - input.requestStartedAt.getTime()),
        }
      : {}),
    completedAt: input.completedAt.toISOString(),
    durationMs: Math.max(0, input.completedAt.getTime() - input.requestStartedAt.getTime()),
  }
}

function emptyPromptCacheTotals(): PromptCacheTotals {
  return {
    requests: 0,
    inputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    uncachedInputTokens: 0,
    cacheHitRatio: 0,
  }
}

function ratio(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0
}

function nonNegative(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : 0
}

function isOfficialProviderHost(model: ModelConfig): boolean {
  try {
    const hostname = new URL(model.baseUrl).hostname.toLowerCase()
    return model.provider === 'anthropic'
      ? hostname === 'api.anthropic.com'
      : hostname === 'api.openai.com'
  } catch {
    return false
  }
}

function isGpt56OrNewer(modelName: string): boolean {
  const match = modelName.toLowerCase().match(/\bgpt-(\d+)(?:\.(\d+))?/)
  if (!match) return false
  const major = Number(match[1])
  const minor = Number(match[2] ?? 0)
  return major > 5 || (major === 5 && minor >= 6)
}

function validatePromptCacheTtl(model: ModelConfig): void {
  const ttl = model.promptCache?.ttl
  if (!ttl) return
  if (model.provider === 'anthropic') {
    if (ttl === '5m' || ttl === '1h') return
    throw new Error(`Anthropic prompt caching supports ttl=5m or ttl=1h, received "${ttl}".`)
  }
  if (ttl === '1h') {
    throw new Error('OpenAI prompt caching does not expose a 1h retention option.')
  }
  if (isGpt56OrNewer(model.name)) {
    if (ttl === '30m') return
    throw new Error(`OpenAI ${model.name} prompt_cache_options currently supports ttl=30m, received "${ttl}".`)
  }
  if (ttl === '5m' || ttl === '24h') return
  throw new Error(`OpenAI ${model.name} uses in_memory (configured as 5m) or 24h retention, received "${ttl}".`)
}
