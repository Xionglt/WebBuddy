import type { ToolExecutionMetadata } from './tool-contract.js'
import type { NormalizedToolError } from './tool-errors.js'

export type ToolExecutionStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'timed_out'
  | 'blocked'

export interface ToolExecutionState {
  version: 1
  toolCallId: string
  name: string
  turnId: string
  step: number
  status: ToolExecutionStatus
  attempts: number
  queuedAt: string
  startedAt?: string
  completedAt?: string
  durationMs?: number
  timeoutMs?: number
  abortReason?: string
  error?: NormalizedToolError
  metadata?: ToolExecutionMetadata
}
