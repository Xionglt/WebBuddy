import type { RunStoreEvent } from '../control/store-contracts.js'

export const CONTINUATION_METRICS_SCHEMA_VERSION = 'continuation-metrics/v1' as const

export interface ContinuationLatencySummary {
  count: number
  p50Ms: number
  p95Ms: number
}

export interface ContinuationMetrics {
  schemaVersion: typeof CONTINUATION_METRICS_SCHEMA_VERSION
  requested: number
  answered: number
  resumed: number
  liveResumed: number
  coldResumed: number
  activeAfterResume: number
  completedAfterResume: number
  failedAfterResume: number
  cancelledAfterResume: number
  reblockedAfterResume: number
  lateAttemptResultsRejected: number
  answerRate: number
  resumeRate: number
  settledSuccessRate: number
  reblockRate: number
  answerLatency: ContinuationLatencySummary
  answerToResumeLatency: ContinuationLatencySummary
}

interface MutableContinuationSample {
  runId: string
  continuationId: string
  requestedSequence: number
  requestedAt: string
  answeredAt?: string
  resumedAt?: string
  resumeMode?: 'live' | 'cold'
  outcome?: 'active' | 'completed' | 'failed' | 'cancelled' | 'reblocked'
}

export function buildContinuationMetrics(
  events: readonly RunStoreEvent[],
): ContinuationMetrics {
  const ordered = [...events].sort((left, right) => (
    left.occurredAt.localeCompare(right.occurredAt)
      || left.runId.localeCompare(right.runId)
      || left.eventSequence - right.eventSequence
  ))
  const samples = new Map<string, MutableContinuationSample>()

  for (const event of ordered) {
    const continuationId = stringData(event, 'continuationId')
    if (!continuationId) continue
    const key = sampleKey(event.runId, continuationId)
    if (event.eventType === 'continuation_requested') {
      samples.set(key, {
        runId: event.runId,
        continuationId,
        requestedSequence: event.eventSequence,
        requestedAt: event.occurredAt,
      })
      continue
    }
    const sample = samples.get(key)
    if (!sample) continue
    if (event.eventType === 'continuation_answered') sample.answeredAt = event.occurredAt
    if (event.eventType === 'continuation_resumed') {
      sample.resumedAt = event.occurredAt
      const mode = stringData(event, 'mode')
      if (mode === 'live' || mode === 'cold') sample.resumeMode = mode
    }
  }

  for (const sample of samples.values()) {
    if (!sample.resumedAt) continue
    sample.outcome = outcomeAfterResume(sample, ordered)
  }

  const values = [...samples.values()]
  const resumed = values.filter((sample) => sample.resumedAt)
  const settled = resumed.filter((sample) => (
    sample.outcome !== undefined && sample.outcome !== 'active'
  ))
  const completed = resumed.filter((sample) => sample.outcome === 'completed').length
  const reblocked = resumed.filter((sample) => sample.outcome === 'reblocked').length

  return {
    schemaVersion: CONTINUATION_METRICS_SCHEMA_VERSION,
    requested: values.length,
    answered: values.filter((sample) => sample.answeredAt).length,
    resumed: resumed.length,
    liveResumed: resumed.filter((sample) => sample.resumeMode === 'live').length,
    coldResumed: resumed.filter((sample) => sample.resumeMode === 'cold').length,
    activeAfterResume: resumed.filter((sample) => sample.outcome === 'active').length,
    completedAfterResume: completed,
    failedAfterResume: resumed.filter((sample) => sample.outcome === 'failed').length,
    cancelledAfterResume: resumed.filter((sample) => sample.outcome === 'cancelled').length,
    reblockedAfterResume: reblocked,
    lateAttemptResultsRejected: ordered.filter((event) => event.eventType === 'late_result_rejected').length,
    answerRate: ratio(values.filter((sample) => sample.answeredAt).length, values.length),
    resumeRate: ratio(resumed.length, values.filter((sample) => sample.answeredAt).length),
    settledSuccessRate: ratio(completed, settled.length),
    reblockRate: ratio(reblocked, resumed.length),
    answerLatency: latencySummary(values.flatMap((sample) => (
      sample.answeredAt ? [duration(sample.requestedAt, sample.answeredAt)] : []
    ))),
    answerToResumeLatency: latencySummary(values.flatMap((sample) => (
      sample.answeredAt && sample.resumedAt
        ? [duration(sample.answeredAt, sample.resumedAt)]
        : []
    ))),
  }
}

function outcomeAfterResume(
  sample: MutableContinuationSample,
  events: readonly RunStoreEvent[],
): NonNullable<MutableContinuationSample['outcome']> {
  const resumedAt = sample.resumedAt
  if (!resumedAt) return 'active'
  for (const event of events) {
    if (event.runId !== sample.runId) continue
    if (event.occurredAt < resumedAt) continue
    if (event.occurredAt === resumedAt && event.eventSequence <= sample.requestedSequence) continue
    if (event.eventType === 'continuation_requested'
      && stringData(event, 'continuationId') !== sample.continuationId) {
      return 'reblocked'
    }
    if (event.eventType !== 'state_transitioned') continue
    const state = stringData(event, 'to')
    if (state === 'completed' || state === 'failed' || state === 'cancelled') return state
  }
  return 'active'
}

function latencySummary(values: readonly number[]): ContinuationLatencySummary {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right)
  return {
    count: sorted.length,
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
  }
}

function percentile(values: readonly number[], percentileValue: number): number {
  if (!values.length) return 0
  const index = Math.max(0, Math.ceil(values.length * percentileValue) - 1)
  return Math.round(values[index] ?? 0)
}

function duration(start: string, end: string): number {
  return Math.max(0, Date.parse(end) - Date.parse(start))
}

function ratio(numerator: number, denominator: number): number {
  if (denominator === 0) return 0
  return Number((numerator / denominator).toFixed(4))
}

function stringData(event: RunStoreEvent, key: string): string | undefined {
  const value = event.data?.[key]
  return typeof value === 'string' ? value : undefined
}

function sampleKey(runId: string, continuationId: string): string {
  return `${runId}\u0000${continuationId}`
}
