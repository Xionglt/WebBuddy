export type AgentKernelStatus =
  | 'idle'
  | 'running'
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'aborted'

export interface AgentRunController {
  readonly signal: AbortSignal
  readonly status: AgentKernelStatus
  readonly reason?: string
  abort(reason?: string): void
  markRunning(): void
  markBlocked(reason?: string): void
  markCompleted(): void
  markFailed(error: Error | string): void
}

export class DefaultAgentRunController implements AgentRunController {
  private readonly controller = new AbortController()
  private currentStatus: AgentKernelStatus = 'idle'
  private currentReason: string | undefined

  get signal(): AbortSignal {
    return this.controller.signal
  }

  get status(): AgentKernelStatus {
    return this.currentStatus
  }

  get reason(): string | undefined {
    return this.currentReason
  }

  abort(reason = 'Abort requested.'): void {
    this.currentStatus = 'aborted'
    this.currentReason = reason
    if (!this.controller.signal.aborted) {
      this.controller.abort(reason)
    }
  }

  markRunning(): void {
    if (this.currentStatus === 'aborted') return
    this.currentStatus = 'running'
    this.currentReason = undefined
  }

  markBlocked(reason?: string): void {
    if (this.currentStatus === 'aborted') return
    this.currentStatus = 'blocked'
    this.currentReason = reason
  }

  markCompleted(): void {
    if (this.currentStatus === 'aborted') return
    this.currentStatus = 'completed'
    this.currentReason = undefined
  }

  markFailed(error: Error | string): void {
    if (this.currentStatus === 'aborted') return
    this.currentStatus = 'failed'
    this.currentReason = error instanceof Error ? error.message : error
  }
}

export function createAgentRunController(): AgentRunController {
  return new DefaultAgentRunController()
}

export function abortReason(signal: AbortSignal, fallback = 'Abort requested.'): string {
  const reason = (signal as AbortSignal & { reason?: unknown }).reason
  if (reason instanceof Error) return reason.message
  if (typeof reason === 'string' && reason.trim()) return reason
  if (reason !== undefined) return String(reason)
  return fallback
}
