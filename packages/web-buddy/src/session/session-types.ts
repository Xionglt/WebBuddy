import type { KernelEvent } from '../kernel/kernel-events.js'
import type { ToolResultArtifactRef } from '../tools/tool-result-store.js'

export type AgentSessionSource = 'cli' | 'web' | 'sdk' | 'benchmark' | 'test'

export type AgentSessionStatus =
  | 'created'
  | 'running'
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'aborted'

export interface AgentSession {
  version: 1
  sessionId: string
  runId: string
  source: AgentSessionSource
  status: AgentSessionStatus
  goal: string
  mode?: string
  createdAt: string
  updatedAt: string
  completedAt?: string
  blockedReason?: string
  error?: string
  outputDir: string
  transcriptPath: string
  eventsPath: string
  workflowPath: string
  traceRunId?: string
}

export interface TranscriptEntryBase {
  version: 1
  sessionId: string
  runId: string
  entryId: string
  ts: string
  turnId?: string
}

export interface UserMessageEntry extends TranscriptEntryBase {
  type: 'user_message'
  content: string
}

export interface AssistantMessageEntry extends TranscriptEntryBase {
  type: 'assistant_message'
  content: unknown
}

export interface ToolCallEntry extends TranscriptEntryBase {
  type: 'tool_call'
  toolCallId: string
  name: string
  args: unknown
}

export interface ToolResultEntry extends TranscriptEntryBase {
  type: 'tool_result'
  toolCallId: string
  name: string
  ok: boolean
  result?: unknown
  artifacts?: ToolResultArtifactRef[]
  error?: string
}

export interface PolicyDecisionEntry extends TranscriptEntryBase {
  type: 'policy_decision'
  toolCallId?: string
  toolName?: string
  decision: unknown
}

export interface PermissionDecisionEntry extends TranscriptEntryBase {
  type: 'permission_decision'
  permissionRequestId: string
  toolCallId?: string
  toolName?: string
  request: unknown
  decision: unknown
}

export interface ApprovalRequestEntry extends TranscriptEntryBase {
  type: 'approval_request'
  approvalId: string
  permissionRequestId: string
  toolCallId?: string
  status: 'pending'
  request: unknown
}

export interface ApprovalDecisionEntry extends TranscriptEntryBase {
  type: 'approval_decision'
  approvalId: string
  permissionRequestId: string
  toolCallId?: string
  decision: unknown
}

export interface SkillContextEntry extends TranscriptEntryBase {
  type: 'skill_context'
  context: unknown
  reason?: string
}

export interface WorkflowSnapshotEntry extends TranscriptEntryBase {
  type: 'workflow_snapshot'
  workflowState: unknown
}

export interface MemorySnapshotEntry extends TranscriptEntryBase {
  type: 'memory_snapshot'
  memory: unknown
  reason?: string
}

export interface WorkflowEvidenceEntry extends TranscriptEntryBase {
  type: 'workflow_evidence'
  evidence: unknown
}

export interface UserConfirmationEntry extends TranscriptEntryBase {
  type: 'user_confirmation'
  confirmation: unknown
}

export interface UserAnswerEntry extends TranscriptEntryBase {
  type: 'user_answer'
  toolCallId?: string
  field: string
  question: string
  answer: string
  source: 'ask_user'
  data?: unknown
}

export interface WorkflowEvaluationEntry extends TranscriptEntryBase {
  type: 'workflow_evaluation'
  evaluation: unknown
}

export interface CompletionGateEntry extends TranscriptEntryBase {
  type: 'completion_gate'
  decision: unknown
}

export interface ContextCompactionEntry extends TranscriptEntryBase {
  type: 'context_compaction'
  summaryId: string
  reason: string
  tokenBudget: unknown
  postCompactionTokenBudget?: unknown
  mode?: string
  microCompaction?: unknown
  semanticError?: string
  summary: unknown
}

export interface FinalResultEntry extends TranscriptEntryBase {
  type: 'final_result'
  status: 'completed' | 'blocked' | 'failed' | 'aborted'
  result?: unknown
  reason?: string
}

export interface ErrorEntry extends TranscriptEntryBase {
  type: 'error'
  message: string
  stack?: string
}

export type TranscriptEntry =
  | UserMessageEntry
  | AssistantMessageEntry
  | ToolCallEntry
  | ToolResultEntry
  | PolicyDecisionEntry
  | PermissionDecisionEntry
  | ApprovalRequestEntry
  | ApprovalDecisionEntry
  | SkillContextEntry
  | WorkflowSnapshotEntry
  | MemorySnapshotEntry
  | WorkflowEvidenceEntry
  | UserConfirmationEntry
  | UserAnswerEntry
  | WorkflowEvaluationEntry
  | CompletionGateEntry
  | ContextCompactionEntry
  | FinalResultEntry
  | ErrorEntry

export interface CreateSessionInput {
  sessionId?: string
  runId?: string
  source: AgentSessionSource
  goal: string
  mode?: string
  traceRunId?: string
  now?: string
}

export interface SessionStore {
  create(input: CreateSessionInput): Promise<AgentSession>
  get(sessionId: string): Promise<AgentSession | undefined>
  update(sessionId: string, patch: Partial<AgentSession>): Promise<AgentSession>
  appendTranscript(entry: TranscriptEntry): Promise<void>
  appendEvent(event: KernelEvent): Promise<void>
  writeWorkflowSnapshot(sessionId: string, workflowState: unknown): Promise<void>
  list(options?: { limit?: number; status?: AgentSessionStatus }): Promise<AgentSession[]>
}
