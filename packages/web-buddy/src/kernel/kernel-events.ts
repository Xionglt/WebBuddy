export type KernelEventType =
  | 'session_created'
  | 'session_started'
  | 'turn_started'
  | 'turn_completed'
  | 'model_message'
  /** Non-canonical shadow-only scheduling projection; never a tool lifecycle event. */
  | 'tool_orchestration_plan'
  | 'tool_call_created'
  | 'tool_started'
  | 'tool_completed'
  | 'tool_failed'
  | 'tool_result_artifact'
  | 'policy_evaluated'
  | 'permission_evaluated'
  | 'action_ledger_updated'
  | 'external_action_preflight'
  | 'approval_requested'
  | 'approval_resolved'
  | 'skill_resolved'
  | 'token_budget_updated'
  | 'context_compacted'
  | 'agent_task_notifications_injected'
  | 'agent_task_action_clock_advanced'
  | 'agent_task_background_error'
  | 'workflow_updated'
  | 'memory_updated'
  | 'memory_retrieved'
  | 'workflow_evidence_recorded'
  | 'workflow_evaluated'
  | 'completion_gate_evaluated'
  | 'user_answer_recorded'
  | 'session_restored'
  | 'user_confirmed'
  | 'session_completion_rechecked'
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
