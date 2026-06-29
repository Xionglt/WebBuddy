export type KernelEventType =
  | 'session_created'
  | 'session_started'
  | 'turn_started'
  | 'turn_completed'
  | 'model_message'
  | 'tool_call_created'
  | 'tool_started'
  | 'tool_completed'
  | 'tool_failed'
  | 'policy_evaluated'
  | 'token_budget_updated'
  | 'context_compacted'
  | 'workflow_updated'
  | 'human_gate_requested'
  | 'human_gate_resolved'
  | 'session_blocked'
  | 'session_completed'
  | 'session_failed'
  | 'session_aborted'

export interface KernelEvent {
  version: 1
  type: KernelEventType
  sessionId: string
  runId: string
  ts: string
  turnId?: string
  toolCallId?: string
  message?: string
  data?: Record<string, unknown>
}
