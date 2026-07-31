export type ToolCircuitState = 'closed' | 'open' | 'half_open'

export interface ToolCircuitBreakerOptions {
  failureThreshold: number
  resetTimeoutMs: number
}

export type ToolCircuitDecision =
  | { allowed: true; state: Extract<ToolCircuitState, 'closed' | 'half_open'> }
  | { allowed: false; state: 'open'; retryAfterMs: number }

export interface ToolCircuitSnapshot {
  key: string
  state: ToolCircuitState
  consecutiveFailures: number
  openedAt?: number
}

interface CircuitRecord {
  state: ToolCircuitState
  consecutiveFailures: number
  openedAt?: number
  halfOpenProbeInFlight: boolean
}

const DEFAULT_OPTIONS: ToolCircuitBreakerOptions = Object.freeze({
  failureThreshold: 3,
  resetTimeoutMs: 30_000,
})

/**
 * Small dependency-keyed closed/open/half-open circuit breaker. A dependency
 * key is explicit; ordinary browser and local tools never share a circuit by
 * accident.
 */
export class ToolCircuitBreaker {
  private readonly options: ToolCircuitBreakerOptions
  private readonly records = new Map<string, CircuitRecord>()

  constructor(options: Partial<ToolCircuitBreakerOptions> = {}) {
    this.options = {
      failureThreshold: positiveInteger(options.failureThreshold, DEFAULT_OPTIONS.failureThreshold),
      resetTimeoutMs: positiveInteger(options.resetTimeoutMs, DEFAULT_OPTIONS.resetTimeoutMs),
    }
  }

  beforeRequest(key: string, now = Date.now()): ToolCircuitDecision {
    const record = this.recordFor(key)
    if (record.state === 'closed') return { allowed: true, state: 'closed' }

    const retryAfterMs = Math.max(0, this.options.resetTimeoutMs - (now - (record.openedAt ?? now)))
    if (record.state === 'open' && retryAfterMs > 0) {
      return { allowed: false, state: 'open', retryAfterMs }
    }

    if (record.state === 'open') {
      record.state = 'half_open'
      record.halfOpenProbeInFlight = false
    }
    if (record.halfOpenProbeInFlight) {
      return { allowed: false, state: 'open', retryAfterMs: this.options.resetTimeoutMs }
    }

    record.halfOpenProbeInFlight = true
    return { allowed: true, state: 'half_open' }
  }

  recordSuccess(key: string): void {
    this.records.set(key, {
      state: 'closed',
      consecutiveFailures: 0,
      halfOpenProbeInFlight: false,
    })
  }

  recordFailure(key: string, now = Date.now()): void {
    const record = this.recordFor(key)
    record.halfOpenProbeInFlight = false
    record.consecutiveFailures += 1
    if (record.state === 'half_open' || record.consecutiveFailures >= this.options.failureThreshold) {
      record.state = 'open'
      record.openedAt = now
    }
  }

  recordIgnored(key: string, now = Date.now()): void {
    const record = this.recordFor(key)
    if (record.state !== 'half_open') return
    record.state = 'open'
    record.openedAt = now
    record.halfOpenProbeInFlight = false
  }

  snapshot(key: string): ToolCircuitSnapshot {
    const record = this.recordFor(key)
    return {
      key,
      state: record.state,
      consecutiveFailures: record.consecutiveFailures,
      ...(record.openedAt !== undefined ? { openedAt: record.openedAt } : {}),
    }
  }

  private recordFor(key: string): CircuitRecord {
    const existing = this.records.get(key)
    if (existing) return existing
    const created: CircuitRecord = {
      state: 'closed',
      consecutiveFailures: 0,
      halfOpenProbeInFlight: false,
    }
    this.records.set(key, created)
    return created
  }
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && (value ?? 0) > 0 ? value! : fallback
}
