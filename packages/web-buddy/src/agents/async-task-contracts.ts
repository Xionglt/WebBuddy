/**
 * Frozen cross-module type surface for Web Buddy async task orchestration.
 * Contract IDs and versions are recorded in freeze-record.md.
 * The runtime copy under packages/web-buddy/src/agents/async-task-contracts.ts
 * must remain byte-identical; changes require a new contract revision.
 */

export type IsoUtcTimestamp = string
export type Sha256Hex = string
export type JsonValue = null | boolean | number | string | JsonValue[] | { readonly [key: string]: JsonValue }

export interface SanitizedTextProjectionV1 {
  schemaVersion: 'sanitized-text-projection/v1'
  text: string
  projectionPolicy: 'no_react_history/v1'
  sourceArtifactRefs: ImmutableArtifactRef[]
  sourceItemCount: number
  maxChars: number
  contentDigest: Sha256Hex
}

export type ActionBinding =
  | { kind: 'browser_action'; sourceActionSeq: number }
  | { kind: 'not_action_bound' }

export type ResultFreshnessVerdict =
  | { kind: 'not_action_bound'; validity: 'not_applicable' }
  | {
      kind: 'assessed'
      sourceActionSeq: number
      assessedAgainstActionSeq: number
      validity: 'unverified' | 'stale'
    }

export interface BrowserActionClockV1 {
  schemaVersion: 'browser-action-clock/v1'
  sessionId: string
  runId: string
  currentActionSeq: number
  updatedAt: IsoUtcTimestamp
  authority: 'main_agent_runtime'
}

export interface BrowserActionSourceV1 {
  kind: 'main_agent_browser_tool_started'
  turnId: string
  toolCallId: string
  toolName: string
}

export type ImmutableArtifactKind =
  | 'trace'
  | 'page_snapshot'
  | 'memory'
  | 'tool_call'
  | 'tool_result'
  | 'runner_result'
  | 'sidechain_transcript'
  | 'context_envelope'
  | 'task_graph_checkpoint'
  | 'schema'
  | 'plan_proposal'
  | 'research_report'
  | 'comparison_report'
  | 'form_field_plan'
  | 'safety_verdict'
  | 'evidence_assessment'

export interface ImmutableArtifactRef<TKind extends ImmutableArtifactKind = ImmutableArtifactKind> {
  schemaVersion: 'immutable-artifact-ref/v1'
  artifactId: string
  artifactKind: TKind
  runId: string
  sessionId: string
  storage: {
    store: 'session_artifacts'
    relativeSegments: string[]
  }
  mediaType: string
  byteLength: number
  sha256: Sha256Hex
  createdAt: IsoUtcTimestamp
  actionBinding: ActionBinding
  immutable: true
}

export type TaskContractErrorCode =
  | 'UNSUPPORTED_SCHEMA_VERSION'
  | 'GRAPH_NOT_FOUND'
  | 'GRAPH_ALREADY_EXISTS'
  | 'REVISION_CONFLICT'
  | 'TASK_NOT_FOUND'
  | 'INVALID_TRANSITION'
  | 'DEPENDENCY_UNRESOLVED'
  | 'DAG_CYCLE'
  | 'QUEUE_CAPACITY_EXCEEDED'
  | 'RUNNER_NOT_FOUND'
  | 'RUNNER_KIND_CONFLICT'
  | 'STALE_LEASE'
  | 'LEASE_EXPIRED'
  | 'MAX_ATTEMPTS_EXCEEDED'
  | 'IDEMPOTENCY_CONFLICT'
  | 'POLICY_VIOLATION'
  | 'RESULT_SCHEMA_INVALID'
  | 'CANCELLED'
  | 'SESSION_ABORTED'
  | 'NOTIFICATION_ACK_CONFLICT'
  | 'EVENT_SEQUENCE_CONFLICT'
  | 'ARTIFACT_NOT_READY'
  | 'ARTIFACT_INTEGRITY_FAILED'
  | 'CONTEXT_POLICY_VIOLATION'

export interface TaskContractError {
  schemaVersion: 'async-task-contract-error/v1'
  code: TaskContractErrorCode
  category: 'conflict' | 'validation' | 'policy' | 'transient' | 'cancelled' | 'internal'
  retryDisposition: 'retry_same_task' | 'new_task_required' | 'never_retry'
  message: string
  occurredAt: IsoUtcTimestamp
  taskId?: string
  attempt?: number
  leaseId?: string
  expectedRevision?: number
  actualRevision?: number
  safeDetails?: Readonly<Record<string, string | number | boolean | null>>
  causeArtifactRef?: ImmutableArtifactRef
}

export type AgentTaskStatus = 'pending' | 'blocked' | 'running' | 'completed' | 'failed' | 'killed'
export type AgentTaskKind =
  | 'main_browser_step'
  | 'candidate_job_research'
  | 'trace_summarization'
  | 'memory_retrieval'
  | 'workflow_evaluation'
  | 'delivery_probe'
export type AgentTaskAccessMode = 'read_only' | 'browser_write' | 'analysis_only'
export type AgentTaskRole =
  | { kind: 'main_browser_step'; accessMode: 'browser_write'; capacityClass: 'main_agent_only' }
  | { kind: 'candidate_job_research' | 'trace_summarization'; accessMode: 'read_only'; capacityClass: 'read_only_llm' }
  | { kind: 'memory_retrieval'; accessMode: 'read_only'; capacityClass: 'deterministic' }
  | { kind: 'workflow_evaluation' | 'delivery_probe'; accessMode: 'analysis_only'; capacityClass: 'deterministic' }

export interface TaskLease {
  schemaVersion: 'agent-task-lease/v1'
  leaseId: string
  ownerId: string
  acquiredAt: IsoUtcTimestamp
  expiresAt: IsoUtcTimestamp
  attempt: number
  claimedAtGraphRevision: number
}

export interface TaskIdempotency {
  schemaVersion: 'agent-task-idempotency/v1'
  scope: 'session'
  key: string
  canonicalization: 'web-buddy-task-input-jcs/v1'
  digestAlgorithm: 'sha256'
  inputDigest: Sha256Hex
}

export interface TaskDependencyBlock {
  kind: 'dependency_wait'
  unresolvedTaskIds: string[]
}

export interface TaskManualBlock {
  kind: 'manual'
  code: string
  reason: string
}

export type TaskBlockReason = TaskDependencyBlock | TaskManualBlock

export type AgentTaskInput =
  | { kind: 'goal' | 'workflow_state'; structuredValue: JsonValue; artifactRef?: never }
  | {
      kind: 'memory_artifact' | 'trace_artifact' | 'page_snapshot_artifact'
      artifactRef: ImmutableArtifactRef
      structuredValue?: never
    }

export interface AgentTaskOutput {
  schemaVersion: 'agent-task-output/v1'
  outputId: string
  kind:
    | 'recommendation'
    | 'candidate_jobs'
    | 'trace_summary'
    | 'memory_result'
    | 'artifact_ref'
    | 'transcript_ref'
    | 'workflow_patch_proposal'
  artifactRef: ImmutableArtifactRef
  attempt: number
  leaseId: string
  freshness: ResultFreshnessVerdict
  appendToMainTranscript: false
  requiresMainWorkflowVerification: true
  authoritativeCompletionEvidence: false
}

export type TaskCompletionRequirement =
  | { requiredForCompletion: true; terminalPolicy: 'must_complete_successfully' | 'terminal_is_sufficient' }
  | { requiredForCompletion: false; terminalPolicy: 'does_not_block' }

export interface AgentTaskAttemptRecordBaseV1 {
  schemaVersion: 'agent-task-attempt-record/v1'
  runIdentity: TaskRunIdentity
  startedAt: IsoUtcTimestamp
}

export type AgentTaskAttemptExecutionV1 =
  | {
      runnerKind: 'read_only_llm'
      envelopeRef: ImmutableArtifactRef<'context_envelope'>
      sidechainTranscriptRef?: ImmutableArtifactRef<'sidechain_transcript'>
    }
  | {
      runnerKind: 'deterministic'
      envelopeRef?: never
      sidechainTranscriptRef?: never
    }
  | {
      runnerKind: 'main_agent'
      envelopeRef?: never
      sidechainTranscriptRef?: never
    }

export type AgentTaskAttemptStateV1 =
  | { outcome: 'running'; finishedAt?: never; error?: never }
  | { outcome: 'succeeded'; finishedAt: IsoUtcTimestamp; error?: never }
  | { outcome: 'failed' | 'aborted' | 'lease_expired'; finishedAt: IsoUtcTimestamp; error: TaskContractError }

export type AgentTaskAttemptRecordV1 = AgentTaskAttemptRecordBaseV1 & AgentTaskAttemptExecutionV1 & AgentTaskAttemptStateV1

export interface AgentTaskCore {
  schemaVersion: 'agent-task/v2'
  id: string
  title: string
  priority: number
  blockedBy: string[]
  blocks: string[]
  inputs: AgentTaskInput[]
  outputs: AgentTaskOutput[]
  attempts: AgentTaskAttemptRecordV1[]
  actionBinding: ActionBinding
  idempotency: TaskIdempotency
  attempt: number
  maxAttempts: number
  timeoutMs: number
  leaseDurationMs: number
  cancellation?: {
    requestId: string
    requestedAt: IsoUtcTimestamp
    reason: 'user' | 'session_abort' | 'timeout' | 'superseded' | 'policy'
  }
  createdAt: IsoUtcTimestamp
  updatedAt: IsoUtcTimestamp
  firstStartedAt?: IsoUtcTimestamp
  lastStartedAt?: IsoUtcTimestamp
  lastError?: TaskContractError
  requiresMainWorkflowVerification: true
  authoritativeCompletionEvidence: false
}

export type PendingAgentTask = AgentTaskCore & AgentTaskRole & TaskCompletionRequirement & {
  status: 'pending'
  lease?: never
  blockReason?: never
  terminalAt?: never
  nextAttemptAt?: IsoUtcTimestamp
}

export type BlockedAgentTask = AgentTaskCore & AgentTaskRole & TaskCompletionRequirement & {
  status: 'blocked'
  lease?: never
  blockReason: TaskBlockReason
  terminalAt?: never
  nextAttemptAt?: never
}

export type RunningAgentTask = AgentTaskCore & AgentTaskRole & TaskCompletionRequirement & {
  status: 'running'
  lease: TaskLease
  blockReason?: never
  terminalAt?: never
  nextAttemptAt?: never
  lastStartedAt: IsoUtcTimestamp
}

export type TerminalAgentTask = AgentTaskCore & AgentTaskRole & TaskCompletionRequirement & {
  status: 'completed' | 'failed' | 'killed'
  lease?: never
  blockReason?: never
  terminalAt: IsoUtcTimestamp
  nextAttemptAt?: never
}

export type AgentTask = PendingAgentTask | BlockedAgentTask | RunningAgentTask | TerminalAgentTask

export interface AgentTaskLock {
  id: string
  ownerTaskId: string
  resource: 'browser_page' | 'session_transcript' | 'workflow_state' | 'memory_store' | 'trace_store'
  resourceId?: string
  mode: 'read' | 'write'
  acquiredAt: IsoUtcTimestamp
  releasedAt?: IsoUtcTimestamp
}

export interface AgentTaskGraphSafety {
  browserWriteOwnership: {
    owner: 'main_agent_runtime'
    activeTaskId?: string
  }
  subagentCapabilityPolicy: 'immutable_artifact_read_only'
  subagentDefaultAccessMode: 'read_only'
  allowedReadOnlyTaskKinds: readonly ['candidate_job_research', 'trace_summarization', 'memory_retrieval']
  allowedReadOnlyTools: readonly [
    'artifact_read_text',
    'artifact_read_json',
    'artifact_search_text',
    'artifact_list_refs',
  ]
  disallowedSubagentGateKinds: readonly ['login', 'captcha', 'upload_resume', 'save_resume', 'final_submit']
  disallowedSubagentToolNames: readonly [
    'browser_open',
    'browser_click',
    'browser_click_text',
    'browser_type',
    'browser_fill_by_label',
    'browser_select',
    'browser_select_by_text',
    'browser_set_field',
    'browser_press_key',
    'browser_upload_file',
    'agent_done',
    'ask_user',
  ]
  finalDecisionOwner: 'main_agent_runtime'
  completionEvidenceRequiresMainVerification: true
}

export type TaskNotificationOutboxEntryV1 =
  | {
      schemaVersion: 'agent-task-notification-outbox-entry/v1'
      sourceEventId: string
      sourceEventSeq: number
      notification: TaskNotificationV1
      state: 'pending_delivery'
      acknowledgedReceipt?: never
    }
  | {
      schemaVersion: 'agent-task-notification-outbox-entry/v1'
      sourceEventId: string
      sourceEventSeq: number
      notification: TaskNotificationV1
      state: 'acknowledged'
      acknowledgedReceipt: TaskNotificationAcknowledgementV1
    }

export interface AgentTaskGraphV2 {
  schemaVersion: 'agent-task-graph/v2'
  revision: number
  nextEventSeq: number
  graphId: string
  runId: string
  sessionId: string
  createdAt: IsoUtcTimestamp
  updatedAt: IsoUtcTimestamp
  owner: 'runtime_orchestrator'
  actionClock: BrowserActionClockV1
  tasks: AgentTask[]
  locks: AgentTaskLock[]
  notificationOutbox: TaskNotificationOutboxEntryV1[]
  safety: AgentTaskGraphSafety
}

export interface TaskRunIdentity {
  taskId: string
  attempt: number
  leaseId: string
  leaseOwnerId: string
}

export type AgentTaskEvent =
  | GraphScopedTaskEvent<'browser_action_advanced', {
      actionId: string
      previousActionSeq: number
      currentActionSeq: number
      source: BrowserActionSourceV1
    }>
  | ControlTaskEvent<'task_created', { idempotency: TaskIdempotency }>
  | RunScopedTaskEvent<'task_claimed', { lease: TaskLease }>
  | RunScopedTaskEvent<'task_progressed', { progressSeq: number; phase: RunnerProgressPhase; summary: string }>
  | RunScopedTaskEvent<'task_retry_scheduled', { nextAttemptAt: IsoUtcTimestamp; error: TaskContractError }>
  | RunScopedTaskEvent<'task_cancel_requested', {
      requestId: string
      requestedAt: IsoUtcTimestamp
      reason: 'user' | 'session_abort' | 'timeout' | 'superseded' | 'policy'
    }>
  | ControlTaskEvent<'task_cancelled_before_run', { requestId: string; reason: 'user' | 'session_abort' | 'superseded' }>
  | RunScopedTaskEvent<'task_completed', {
      outputRefs: [ImmutableArtifactRef, ...ImmutableArtifactRef[]]
      freshness: ResultFreshnessVerdict
    }>
  | RunScopedTaskEvent<'task_failed', { error: TaskContractError }>
  | RunScopedTaskEvent<'task_killed', { error: TaskContractError }>
  | RunScopedTaskEvent<'task_lease_expired', {
      expiredLeaseId: string
      recovery: TaskLeaseRecoveryDecisionV1
    }>
  | RunScopedTaskEvent<'task_result_stale', {
      resultRef: ImmutableArtifactRef
      freshness: Extract<ResultFreshnessVerdict, { kind: 'assessed' }> & { validity: 'stale' }
    }>
  | ControlTaskEvent<'task_notification_acknowledged', {
      notificationId: string
      acknowledgement: TaskNotificationAcknowledgementV1
    }>
  | GraphScopedTaskEvent<'graph_migrated', {
      fromSchemaVersion: 'agent-task-graph/v1'
      warnings: ContractMigrationWarning[]
    }>

export interface TaskEventBase<TType extends string, TPayload> {
  schemaVersion: 'agent-task-event/v1'
  eventId: string
  eventSeq: number
  eventType: TType
  sessionId: string
  graphId: string
  taskId: string
  occurredAt: IsoUtcTimestamp
  revisionBefore: number
  revisionAfter: number
  actionBinding: ActionBinding
  correlationId: string
  causationEventId?: string
  payload: TPayload
  authoritativeTaskState: true
  authoritativeCompletionEvidence: false
}

export type ControlTaskEvent<TType extends string, TPayload> = TaskEventBase<TType, TPayload> & {
  runIdentity?: never
}

export type RunScopedTaskEvent<TType extends string, TPayload> = TaskEventBase<TType, TPayload> & {
  runIdentity: TaskRunIdentity
}

export type GraphScopedTaskEvent<TType extends string, TPayload> = Omit<TaskEventBase<TType, TPayload>, 'taskId'> & {
  scope: 'graph'
  taskId?: never
  runIdentity?: never
}

export type ReadOnlyArtifactToolName =
  | 'artifact_read_text'
  | 'artifact_read_json'
  | 'artifact_search_text'
  | 'artifact_list_refs'

export type BackgroundAgentTaskKind = Exclude<AgentTaskKind, 'main_browser_step'>
export type ReadOnlyLlmTaskKind = 'candidate_job_research' | 'trace_summarization'
export type DeterministicTaskKind = 'memory_retrieval' | 'workflow_evaluation' | 'delivery_probe'
export type RunningBackgroundAgentTask = Extract<RunningAgentTask, { accessMode: 'read_only' | 'analysis_only' }>
export type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer U)[]
    ? readonly DeepReadonly<U>[]
    : T extends object
      ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
      : T

export interface RunnerLimits {
  maxTurns: number
  maxToolCalls: number
  maxInputTokens: number
  maxOutputTokens: number
  perRequestTimeoutMs: number
  overallTimeoutMs: number
}

export type RunnerProgressPhase = 'initializing' | 'reading_artifacts' | 'reasoning' | 'validating_output'

export interface RunnerProgress {
  schemaVersion: 'agent-task-runner-progress/v1'
  runIdentity: TaskRunIdentity
  progressSeq: number
  phase: RunnerProgressPhase
  summary: string
  occurredAt: IsoUtcTimestamp
  authoritativeCompletionEvidence: false
}

export interface AgentTaskRunRequestBaseV1 {
  schemaVersion: 'agent-task-run-input/v1'
  runIdentity: TaskRunIdentity
  runnerId: string
  runnerVersion: string
  graphRevision: number
  task: DeepReadonly<RunningBackgroundAgentTask>
  limits: RunnerLimits
}

export type AgentTaskRunRequestV1 =
  | (AgentTaskRunRequestBaseV1 & {
      runnerKind: 'read_only_llm'
      task: DeepReadonly<Extract<RunningBackgroundAgentTask, { kind: ReadOnlyLlmTaskKind }>>
      contextEnvelope: DeepReadonly<SubagentContextEnvelopeV1>
    })
  | (AgentTaskRunRequestBaseV1 & {
      runnerKind: 'deterministic'
      task: DeepReadonly<Extract<RunningBackgroundAgentTask, { kind: DeterministicTaskKind }>>
      inputArtifactRefs: readonly ImmutableArtifactRef[]
    })

export interface AgentTaskRunControlV1 {
  abortSignal: AbortSignal
  reportProgress(progress: RunnerProgress): Promise<void>
}

export type RunnerErrorCode =
  | 'LLM_TIMEOUT'
  | 'LLM_TRANSIENT'
  | 'ARTIFACT_NOT_READY'
  | 'ARTIFACT_INTEGRITY_FAILED'
  | 'OUTPUT_SCHEMA_INVALID'
  | 'TOOL_DENIED'
  | 'POLICY_VIOLATION'
  | 'BUDGET_EXHAUSTED'
  | 'SESSION_ABORTED'
  | 'STALE_SOURCE'
  | 'INTERNAL'

export interface RunnerError {
  schemaVersion: 'agent-task-runner-error/v1'
  code: RunnerErrorCode
  category: 'transient' | 'validation' | 'policy' | 'cancelled' | 'internal'
  retryDisposition: 'retry_same_task' | 'never_retry'
  message: string
  safeDetails?: Readonly<Record<string, string | number | boolean | null>>
  causeArtifactRef?: ImmutableArtifactRef
}

export interface BuiltInRoleOutputV1 {
  schemaVersion: 'built-in-role-output/v1'
  roleId: string
  roleVersion: string
  roleDigest: Sha256Hex
  artifactKind: string
  payloadSchemaVersion: string
  payload: JsonValue
  requiresMainWorkflowVerification: true
  authoritativeCompletionEvidence: false
}

export interface ReadOnlySubagentResult {
  schemaVersion: 'read-only-subagent-result/v1'
  runIdentity: TaskRunIdentity
  runnerId: string
  runnerVersion: string
  envelopeId: string
  sourceGraphRevision: number
  freshness: ResultFreshnessVerdict
  summary: string
  recommendations: string[]
  evidenceRefs: Array<
    | { kind: 'context_item'; contextItemId: string }
    | { kind: 'artifact'; artifactRef: ImmutableArtifactRef }
  >
  uncertainties: string[]
  roleOutput?: BuiltInRoleOutputV1
  sidechainTranscriptRef: ImmutableArtifactRef
  requiresMainWorkflowVerification: true
  authoritativeCompletionEvidence: false
}

export type AgentTaskRunOutcome =
  | { schemaVersion: 'agent-task-run-outcome/v1'; outcome: 'succeeded'; result: ReadOnlySubagentResult }
  | {
      schemaVersion: 'agent-task-run-outcome/v1'
      outcome: 'succeeded_deterministic'
      result: {
        schemaVersion: 'deterministic-task-result/v1'
        runIdentity: TaskRunIdentity
        outputRefs: [ImmutableArtifactRef, ...ImmutableArtifactRef[]]
        freshness: ResultFreshnessVerdict
        requiresMainWorkflowVerification: true
        authoritativeCompletionEvidence: false
      }
    }
  | { schemaVersion: 'agent-task-run-outcome/v1'; outcome: 'failed'; error: RunnerError; rawResponseRef?: ImmutableArtifactRef }
  | { schemaVersion: 'agent-task-run-outcome/v1'; outcome: 'aborted'; reason: 'signal' | 'lease_lost' | 'session_abort' | 'timeout' }

export interface ReadOnlyLlmTaskRunnerV1 {
  readonly contractVersion: 'agent-task-runner/v1'
  readonly runnerId: string
  readonly runnerVersion: string
  readonly kinds: readonly ReadOnlyLlmTaskKind[]
  readonly capacityClass: 'read_only_llm'
  readonly runnerKind: 'read_only_llm'
  run(
    request: Extract<AgentTaskRunRequestV1, { runnerKind: 'read_only_llm' }>,
    control: AgentTaskRunControlV1,
  ): Promise<Exclude<AgentTaskRunOutcome, { outcome: 'succeeded_deterministic' }>>
}

export interface DeterministicTaskRunnerV1 {
  readonly contractVersion: 'agent-task-runner/v1'
  readonly runnerId: string
  readonly runnerVersion: string
  readonly kinds: readonly DeterministicTaskKind[]
  readonly capacityClass: 'deterministic'
  readonly runnerKind: 'deterministic'
  run(
    request: Extract<AgentTaskRunRequestV1, { runnerKind: 'deterministic' }>,
    control: AgentTaskRunControlV1,
  ): Promise<Exclude<AgentTaskRunOutcome, { outcome: 'succeeded' }>>
}

export type AgentTaskRunnerV1 = ReadOnlyLlmTaskRunnerV1 | DeterministicTaskRunnerV1

export type ContextSensitivity = 'public' | 'user' | 'sensitive'
export type CatalogSensitivity = ContextSensitivity | 'secret'

export type FreshnessAssessment =
  | { state: 'not_action_bound' }
  | { state: 'current' | 'historical' | 'stale'; sourceActionSeq: number; assessedAgainstActionSeq: number }

export type SelectedContextReason =
  | 'required_task_input'
  | 'required_output_contract'
  | 'required_safety_policy'
  | 'relevant_task_kind'
  | 'relevant_action'
  | 'bounded_causal_slice'

export type OmittedContextReason =
  | 'capability_denied'
  | 'secret_denied'
  | 'sensitive_not_authorized'
  | 'live_page_denied'
  | 'full_history_denied'
  | 'mutable_ref_denied'
  | 'task_kind_mismatch'
  | 'stale_not_allowed'
  | 'incomplete_tool_exchange'
  | 'budget_exceeded'
  | 'duplicate_context_id'

export type ContextUnit =
  | {
      kind: 'artifact'
      artifactRef: ImmutableArtifactRef
      sanitizedSummary: SanitizedTextProjectionV1
    }
  | {
      kind: 'structured_projection'
      projectionKind: 'goal' | 'workflow_state' | 'memory_summary' | 'causal_action'
      sanitizedSummary: SanitizedTextProjectionV1
      evidenceRefs: ImmutableArtifactRef[]
    }
  | {
      kind: 'tool_exchange'
      toolCallId: string
      toolName: ReadOnlyArtifactToolName
      callArtifactRef: ImmutableArtifactRef
      resultArtifactRef: ImmutableArtifactRef
      sanitizedSummary: SanitizedTextProjectionV1
    }

export interface SelectedContextItemBase {
  id: string
  freshness: FreshnessAssessment
  allowedTaskKinds: AgentTaskKind[]
  tokenEstimate: number
  selectedReason: SelectedContextReason
  unit: ContextUnit
}

export type SelectedContextItem =
  | (SelectedContextItemBase & { sensitivity: 'public' | 'user' })
  | (SelectedContextItemBase & { sensitivity: 'sensitive'; disclosureGrantId: string })

export interface SensitiveDisclosureGrantRefV1 {
  schemaVersion: 'sensitive-disclosure-grant/v1'
  grantId: string
  sessionId: string
  taskId: string
  allowedContextItemIds: string[]
  purpose: 'async_task_context'
  issuedBy: 'main_agent_runtime_policy'
  issuedAt: IsoUtcTimestamp
  expiresAt: IsoUtcTimestamp
  grantDigest: Sha256Hex
}

export interface ContextCatalogManifestV1 {
  schemaVersion: 'context-catalog-manifest/v1'
  catalogRevision: number
  catalogDigest: Sha256Hex
  canonicalization: 'context-catalog-item-ids-jcs/v1'
  candidateItemIds: string[]
  candidateCount: number
}

export interface OmittedContextItem {
  id: string
  sensitivity: CatalogSensitivity
  reason: OmittedContextReason
}

export interface SubagentAuthorityBoundary {
  browserWrite: false
  livePageAccess: false
  authoritativeCompletionEvidence: false
  requiresMainWorkflowVerification: true
  gates: {
    login: false
    captcha: false
    upload: false
    save: false
    finalSubmit: false
  }
}

export interface BuiltInRoleEnvelopeBindingV1 {
  schemaVersion: 'built-in-role-envelope-binding/v1'
  roleId: string
  roleVersion: string
  roleDigest: Sha256Hex
  authority: 'read_only' | 'recommend_only'
  runtimeTaskKind: ReadOnlyLlmTaskKind
  allowedTools: ReadOnlyArtifactToolName[]
  outputArtifactKind: string
  outputPayloadSchemaVersion: string
  requiredOutputFields: string[]
  browserWrite: false
  livePageAccess: false
  canResolveApproval: false
  canWriteMemory: false
  authoritativeCompletionEvidence: false
  requiresMainWorkflowVerification: true
}

export interface SubagentContextEnvelopeV1 {
  schemaVersion: 'subagent-context-envelope/v1'
  envelopeId: string
  taskId: string
  taskKind: ReadOnlyLlmTaskKind
  parentRunId: string
  parentSessionId: string
  createdAt: IsoUtcTimestamp
  sourceGraphRevision: number
  currentActionBinding: ActionBinding
  objective: SanitizedTextProjectionV1
  outputSchemaRef: ImmutableArtifactRef
  builtInRole?: BuiltInRoleEnvelopeBindingV1
  selectorPolicyVersion: 'context-selector-policy/v1'
  catalogManifest: ContextCatalogManifestV1
  allowedTools: ReadOnlyArtifactToolName[]
  authorityBoundary: SubagentAuthorityBoundary
  sensitiveDisclosureGrants: SensitiveDisclosureGrantRefV1[]
  selectedContext: SelectedContextItem[]
  omittedContext: OmittedContextItem[]
  tokenBudget: {
    estimator: 'web-buddy-token-estimator/v1'
    maxInputTokens: number
    fixedEnvelopeTokens: number
    selectedContextTokens: number
    usedInputTokens: number
    reservedOutputTokens: number
  }
  parentHistoryIncluded: false
}

export interface TaskNotificationBaseV1 {
  schemaVersion: 'agent-task-notification/v1'
  notificationId: string
  sourceEventId: string
  dedupeKey: string
  sessionId: string
  graphId: string
  graphRevision: number
  sourceEventSeq: number
  taskId: string
  taskKind: AgentTaskKind
  summary: string
  createdAt: IsoUtcTimestamp
  requiresMainWorkflowVerification: true
  authoritativeCompletionEvidence: false
}

export type TaskNotificationV1 =
  | (TaskNotificationBaseV1 & {
      terminalStatus: 'completed'
      terminalIdentity: { kind: 'run'; runIdentity: TaskRunIdentity }
      outputRefs: [ImmutableArtifactRef, ...ImmutableArtifactRef[]]
      freshness: ResultFreshnessVerdict
      error?: never
    })
  | (TaskNotificationBaseV1 & {
      terminalStatus: 'failed' | 'killed'
      terminalIdentity:
        | { kind: 'run'; runIdentity: TaskRunIdentity }
        | { kind: 'before_run'; cancellationRequestId: string }
      outputRefs: readonly []
      freshness?: never
      error: TaskContractError
    })

export interface TaskNotificationAcknowledgementV1 {
  schemaVersion: 'agent-task-notification-ack/v1'
  acknowledgementId: string
  notificationId: string
  deliveryId: string
  claimId: string
  injectedPromptMessageId: string
  acknowledgedAt: IsoUtcTimestamp
}

export interface TaskNotificationPromptAttachmentV1 {
  schemaVersion: 'task-notification-prompt-attachment/v1'
  sessionId: string
  promptMessageId: string
  notificationIds: string[]
  persistedAt: IsoUtcTimestamp
  authoritativeCompletionEvidence: false
}

export type TaskNotificationDelivery =
  | {
      schemaVersion: 'agent-task-notification-delivery/v1'
      deliveryId: string
      notificationId: string
      sessionId: string
      state: 'available'
    }
  | {
      schemaVersion: 'agent-task-notification-delivery/v1'
      deliveryId: string
      notificationId: string
      sessionId: string
      state: 'claimed'
      claimId: string
      claimantId: string
      claimedAt: IsoUtcTimestamp
      claimExpiresAt: IsoUtcTimestamp
    }
  | {
      schemaVersion: 'agent-task-notification-delivery/v1'
      deliveryId: string
      notificationId: string
      sessionId: string
      state: 'acknowledged'
      acknowledgement: TaskNotificationAcknowledgementV1
    }

export type TaskLeaseRecoveryDecisionV1 =
  | {
      schemaVersion: 'task-lease-recovery-decision/v1'
      disposition: 'requeue_read_only'
      expiredRunIdentity: TaskRunIdentity
      releasedLockIds: string[]
    }
  | {
      schemaVersion: 'task-lease-recovery-decision/v1'
      disposition: 'fail_browser_write'
      expiredRunIdentity: TaskRunIdentity
      releasedLockIds: string[]
      error: TaskContractError
    }
  | {
      schemaVersion: 'task-lease-recovery-decision/v1'
      disposition: 'fail_max_attempts'
      expiredRunIdentity: TaskRunIdentity
      releasedLockIds: string[]
      error: TaskContractError
    }

export interface AgentTaskCompactFactV1 {
  schemaVersion: 'agent-task-compact-fact/v1'
  graphRevision: number
  taskId: string
  taskKind: AgentTaskKind
  status: AgentTaskStatus
  completionRequirement: TaskCompletionRequirement
  actionBinding: ActionBinding
  outputs: AgentTaskOutput[]
  attemptRecords: AgentTaskAttemptRecordV1[]
  requiresMainWorkflowVerification: true
  authoritativeCompletionEvidence: false
}

export interface TaskGraphCheckpointRefV1 {
  schemaVersion: 'task-graph-checkpoint-ref/v1'
  graphRevision: number
  graphSnapshotRef: ImmutableArtifactRef
  lastEventSeq: number
  unacknowledgedNotificationIds: string[]
}

export interface AgentTaskResumeAttachmentV1 {
  schemaVersion: 'agent-task-resume-attachment/v1'
  sessionId: string
  runId: string
  resumedAt: IsoUtcTimestamp
  checkpoint: TaskGraphCheckpointRefV1
  actionClock: BrowserActionClockV1
  taskFacts: AgentTaskCompactFactV1[]
  leaseRecoveryDecisions: TaskLeaseRecoveryDecisionV1[]
  notificationReplayIds: string[]
  persistedPromptAttachments: TaskNotificationPromptAttachmentV1[]
  sidechainHistoryMergedIntoParent: false
}

export interface TaskTerminalCommitBaseV1 {
  schemaVersion: 'task-terminal-commit/v1'
  expectedGraphRevision: number
  committedAt: IsoUtcTimestamp
  actionClock: BrowserActionClockV1
  task: RunningBackgroundAgentTask
  runIdentity: TaskRunIdentity
  outboxEntry: TaskNotificationOutboxEntryV1
}

export type TaskTerminalCommitV1 =
  | (TaskTerminalCommitBaseV1 & {
      outcome: Extract<AgentTaskRunOutcome, { outcome: 'succeeded' | 'succeeded_deterministic' }>
      terminalEvent: Extract<AgentTaskEvent, { eventType: 'task_completed' }>
      notification: Extract<TaskNotificationV1, { terminalStatus: 'completed' }>
    })
  | (TaskTerminalCommitBaseV1 & {
      outcome: Extract<AgentTaskRunOutcome, { outcome: 'failed' | 'aborted' }>
      terminalEvent: Extract<AgentTaskEvent, { eventType: 'task_failed' | 'task_killed' }>
      notification: Extract<TaskNotificationV1, { terminalStatus: 'failed' | 'killed' }>
    })

export type TaskSpawnResolutionV1 =
  | { schemaVersion: 'task-spawn-resolution/v1'; outcome: 'created'; task: AgentTask }
  | { schemaVersion: 'task-spawn-resolution/v1'; outcome: 'existing_same_digest'; task: AgentTask }
  | { schemaVersion: 'task-spawn-resolution/v1'; outcome: 'conflict'; error: TaskContractError & { code: 'IDEMPOTENCY_CONFLICT' } }

export interface KernelTaskEventProjectionV1 {
  schemaVersion: 'kernel-task-event-projection/v1'
  kernelEventKind: 'agent_task_event_ref'
  sessionId: string
  runId: string
  taskEventId: string
  taskEventSeq: number
  taskEventArtifactRef: ImmutableArtifactRef
  authoritativeCompletionEvidence: false
}

export type MainCompletionReadinessV1 =
  | {
      schemaVersion: 'main-completion-readiness/v1'
      state: 'blocked_required_tasks'
      pendingOrRunningTaskIds: string[]
      failedOrKilledTaskIds: string[]
    }
  | {
      schemaVersion: 'main-completion-readiness/v1'
      state: 'eligible_for_main_verification'
      mainWorkflowEvidenceRefs: [ImmutableArtifactRef, ...ImmutableArtifactRef[]]
      verifiedAgainstActionSeq: number
    }

/* Runtime-only queue control surface; delivery records above are JSON-safe. */
export interface TaskNotificationQueueV1 {
  readonly contractVersion: 'agent-task-notification-queue/v1'
  claimAvailable(
    sessionId: string,
    claimantId: string,
    claimLeaseMs: number,
  ): Promise<Array<{ notification: TaskNotificationV1; delivery: Extract<TaskNotificationDelivery, { state: 'claimed' }> }>>
  acknowledge(acknowledgement: TaskNotificationAcknowledgementV1): Promise<void>
  reconcilePersistedPromptAttachments(attachments: readonly TaskNotificationPromptAttachmentV1[]): Promise<number>
  releaseExpiredClaims(now: IsoUtcTimestamp): Promise<number>
  waitForChange(sessionId: string, signal: AbortSignal, timeoutMs: number): Promise<'changed' | 'timeout' | 'aborted'>
}

export type ContractMigrationResult<T> =
  | { status: 'migrated'; value: T; warnings: ContractMigrationWarning[] }
  | { status: 'rebuild_required'; reason: string; warnings: ContractMigrationWarning[] }
  | { status: 'rejected'; error: TaskContractError }

export interface ContractMigrationWarning {
  code:
    | 'LEGACY_IDEMPOTENCY_DERIVED'
    | 'LEGACY_ACTION_BINDING_UNKNOWN'
    | 'LEGACY_RUNNING_READ_ONLY_REQUEUED'
    | 'LEGACY_RUNNING_BROWSER_WRITE_FAILED'
    | 'LEGACY_CONTEXT_DISCARDED'
  message: string
}

export interface LegacyAgentTaskGraphV1MigrationInput {
  schemaVersion: 'agent-task-graph/v1'
  graphId: string
  runId: string
  sessionId: string
  createdAt: IsoUtcTimestamp
  updatedAt: IsoUtcTimestamp
  owner: 'runtime_orchestrator'
  tasks: Array<{
    id: string
    kind: AgentTaskKind
    status: AgentTaskStatus
    accessMode: AgentTaskAccessMode
    inputs: JsonValue[]
    outputs: JsonValue[]
  }>
  locks: AgentTaskLock[]
  safety: JsonValue
}

export interface AgentTaskGraphV1MigrationOptions {
  schemaVersion: 'agent-task-graph-v1-migration-options/v1'
  migratedAt: IsoUtcTimestamp
  defaultMaxAttempts: number
  defaultTimeoutMs: number
  defaultLeaseDurationMs: number
}

export type MigrateAgentTaskGraphV1 = (
  input: LegacyAgentTaskGraphV1MigrationInput,
  options: AgentTaskGraphV1MigrationOptions,
) => ContractMigrationResult<AgentTaskGraphV2>
