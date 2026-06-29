import type { KernelEvent } from '../kernel/kernel-events.js'
import type { LocalToolContext } from './local-adapter.js'
import type { ToolExecutionState } from './tool-progress.js'

export interface ToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
}

export interface ToolExecutionMetadata {
  step?: number
  riskLevel?: string
  category?: string
  argBrief?: string
  policyAction?: string
  policyCode?: string
  policyRuleId?: string
  policyGateKind?: string
}

export interface ToolUseContext {
  schemaVersion: 'tool-use-context/v1'
  runId: string
  sessionId: string
  turnId: string
  step: number
  toolCallId: string
  local: LocalToolContext
  abortSignal?: AbortSignal
  timeoutMs?: number
  metadata?: ToolExecutionMetadata
  emit?: (event: KernelEvent) => void
  onStateChange?: (state: ToolExecutionState) => void
  now?: () => Date
}
