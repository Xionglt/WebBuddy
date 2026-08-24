export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[]
export interface JsonObject { [key: string]: JsonValue }
export type MaybePromise<T> = T | Promise<T>

export type ContentOrigin =
  | 'system'
  | 'user'
  | 'web'
  | 'tool'
  | 'download'
  | 'artifact'
  | 'memory'
  | 'subagent'
  | 'derived'
export type ContentTrust =
  | 'trusted_runtime'
  | 'user_authorized'
  | 'untrusted_external'
  | 'derived_untrusted'
  | 'non_authoritative'
export type InstructionAuthority = 'system_policy' | 'user_goal' | 'advisory' | 'data_only'
export type ContentSensitivity = 'public' | 'internal' | 'personal' | 'auth' | 'secret'
export type SensitiveDataClass =
  | 'cookie'
  | 'token'
  | 'password'
  | 'otp'
  | 'captcha'
  | 'identity'
  | 'payment'
  | 'file_path'
export type ContextUse = 'prompt' | 'trace' | 'artifact' | 'memory' | 'subagent' | 'sink'
export type SensitiveActionKind =
  | 'navigate'
  | 'type_or_paste'
  | 'upload'
  | 'send'
  | 'publish'
  | 'submit'
  | 'payment'
  | 'memory_write'
  | 'permission_write'
export type EvidenceAuthority = 'main_runtime' | 'user' | 'page_claim' | 'subagent_advisory'

export interface OwnerScope {
  schemaVersion: 'owner-scope/v1'
  tenantId?: string
  userId?: string
  projectId?: string
}

export interface CheckpointRef {
  schemaVersion: 'checkpoint-ref/v1'
  provider: string
  id: string
}

export interface SessionRef {
  schemaVersion: 'session-ref/v1'
  provider: string
  id: string
  runId: string
  attempt: number
  checkpointRef?: CheckpointRef
}

export interface Provenance {
  capturedAt: string
  parentContentIds: string[]
  runId?: string
  sessionId?: string
  sourceUrl?: string
  sourceOrigin?: string
  toolCallId?: string
  artifactId?: string
  sha256?: string
}

export interface FreshnessBinding {
  validity: 'current' | 'stale' | 'unverified' | 'not_applicable'
  revision?: number
  actionSeq?: number
  pageRevision?: number
  workflowRevision?: number
  expiresAt?: string
}

export interface RetentionPolicy {
  scope: 'turn' | 'run' | 'session' | 'project'
  expiresAt?: string
  deleteWithSession: boolean
  audience?: string[]
}

export interface SanitizationVerdict {
  policyId: string
  status: 'unchanged' | 'redacted' | 'quarantined' | 'rejected'
  redactedFields: string[]
  instructionNeutralized: boolean
  transformedFrom: string[]
}

export interface IntegrityVerdict {
  immutable: boolean
  digestVerified: boolean
}

export interface MemoryBinding {
  schemaVersion: 'memory-binding/v1'
  memoryId: string
  revision: number
  scope: 'run' | 'session' | 'project' | 'user'
  status: 'active' | 'superseded' | 'conflicted' | 'forgotten'
  expiresAt?: string
  supersedesIds: string[]
  conflictIds: string[]
  tombstoneAt?: string
}

export interface ContextItem {
  schemaVersion: 'context-item/v1'
  id: string
  kind: string
  content: JsonValue
  origin: ContentOrigin
  trust: ContentTrust
  instructionAuthority: InstructionAuthority
  sensitivity: ContentSensitivity
  sensitiveClasses?: SensitiveDataClass[]
  provenance: Provenance
  allowedUses: ContextUse[]
  freshness: FreshnessBinding
  retention: RetentionPolicy
  sanitization: SanitizationVerdict
  integrity: IntegrityVerdict
  memory?: MemoryBinding
}

export interface ContextProviderRequest {
  schemaVersion: 'context-provider-request/v1'
  goal: TaskGoal
  runId: string
  revision: number
  sessionRef?: SessionRef
  ownerScope?: OwnerScope
}

export interface ContextProvider {
  id: string
  version: string
  provide(request: Readonly<ContextProviderRequest>): MaybePromise<ContextItem[]>
}

export interface ContextProviderDescriptor {
  id: string
  version: string
}

export interface TaskGoal {
  instruction: string
  scenario?: string
  metadata?: JsonObject
}

export interface CompletionCriterionBase {
  id: string
  description: string
  required?: boolean
}

export interface EvidencePresentCriterion extends CompletionCriterionBase {
  kind: 'evidence_present'
  evidenceKinds: string[]
  minCount: number
  allowedAuthorities: EvidenceAuthority[]
  maxAgeMs?: number
}

export interface ArtifactPresentCriterion extends CompletionCriterionBase {
  kind: 'artifact_present'
  artifactKinds: string[]
  minCount: number
  schemaVersions?: string[]
}

export interface FormStateCriterion extends CompletionCriterionBase {
  kind: 'form_state'
  requireFullAudit: boolean
  requiredFieldCoverage: number
  allowVisibleErrors: boolean
  requireDraftOnly: boolean
}

export interface HumanConfirmationCriterion extends CompletionCriterionBase {
  kind: 'human_confirmation'
  confirmationKind: string
  actionId?: string
}

export interface ActionBoundaryCriterion extends CompletionCriterionBase {
  kind: 'action_boundary'
  actionKinds: SensitiveActionKind[]
  outcome: 'not_performed' | 'approved' | 'performed'
}

export type CompletionCriterion =
  | EvidencePresentCriterion
  | ArtifactPresentCriterion
  | FormStateCriterion
  | HumanConfirmationCriterion
  | ActionBoundaryCriterion

export interface EvidenceRequirement {
  id: string
  kinds: string[]
  minCount: number
  allowedAuthorities: EvidenceAuthority[]
  origins?: ContentOrigin[]
  maxAgeMs?: number
  independentlyObserved?: boolean
}

export interface SensitiveActionRule {
  id: string
  actionKinds: SensitiveActionKind[]
  decision: 'ask' | 'deny'
  sourceSensitivities?: ContentSensitivity[]
  destinationOrigins?: string[]
  requireApprovalBinding: boolean
}

export interface TaskPolicy {
  schemaVersion: 'task-policy/v1'
  defaultSensitiveAction: 'ask' | 'deny'
  rules: SensitiveActionRule[]
}

export interface TaskContract {
  schemaVersion: 'web-task-contract/v1'
  contractId: string
  revision: number
  criteria: CompletionCriterion[]
  requiredEvidence?: EvidenceRequirement[]
  sensitiveActions?: SensitiveActionRule[]
}

export interface ActionBinding {
  schemaVersion: 'action-binding/v1'
  contractId: string
  contractRevision: number
  runId: string
  sessionRef?: SessionRef
  actionId: string
  toolName: string
  argsSha256: string
  sourceContentIds: string[]
  sourceSensitiveClasses: SensitiveDataClass[]
  sourceOrigin?: string
  destinationOrigin?: string
  targetFingerprint?: string
  actionSeq: number
  pageRevision?: number
  workflowRevision?: number
  expiresAt: string
}

export interface ApprovalBinding {
  schemaVersion: 'approval-binding/v1'
  approvalId: string
  actionBindingSha256: string
  decision: 'approved' | 'denied'
  issuedAt: string
  expiresAt: string
  nonce: string
  consumedAt?: string
}

export interface EvidenceRef {
  schemaVersion: 'evidence-ref/v1'
  id: string
  kind: string
  summary: string
  authority: EvidenceAuthority
  origin: ContentOrigin
  trust: ContentTrust
  sensitivity: ContentSensitivity
  provenance: Provenance
  freshness: FreshnessBinding
  independentlyObserved: boolean
  spoofableTextOnly: boolean
  binding: {
    runId: string
    revision: number
    sessionRef?: SessionRef
    actionSeq?: number
    pageRevision?: number
    workflowRevision?: number
  }
  verifier: string
  verificationStatus: 'verified' | 'unverified' | 'rejected'
  createdAt: string
  expiresAt?: string
  artifactSha256?: string
  actionBinding?: ActionBinding
  approvalBinding?: ApprovalBinding
}

export interface ArtifactRef {
  schemaVersion: 'artifact-ref/v1'
  id: string
  kind: string
  payloadSchemaVersion: string
  mediaType: string
  byteLength: number
  sha256: string
  createdAt: string
  immutable: true
  locator: string
  producer: { id: string; version: string }
  parentEvidenceIds: string[]
  parentArtifactIds: string[]
  origin: ContentOrigin
  trust: ContentTrust
  sensitivity: ContentSensitivity
  retention: RetentionPolicy
  ownerScope?: OwnerScope
  binding: { runId: string; revision: number; sessionRef?: SessionRef; actionSeq?: number }
  requiresMainWorkflowVerification: boolean
  authoritativeCompletionEvidence: boolean
  redaction: { status: 'not_required' | 'redacted' | 'rejected'; policyId: string }
  scanner: { status: 'clean' | 'quarantined' | 'rejected' | 'not_scanned'; scannerId: string }
}

export interface CompletionFormState {
  audited: boolean
  requiredFieldCoverage: number
  visibleErrorCount: number
  submitted: boolean
}

export interface ActionOutcome {
  actionKind: SensitiveActionKind
  outcome: 'not_performed' | 'approved' | 'performed'
  actionId?: string
}

export type RunLifecycleState =
  | 'queued'
  | 'running'
  | 'pausing'
  | 'paused'
  | 'blocked_on_human'
  | 'resuming'
  | 'cancelling'
  | 'cancelled'
  | 'completed'
  | 'failed'
  | 'interrupted'
  | 'recoverable'

export interface RunSnapshot {
  schemaVersion: 'run-snapshot/v1'
  runId: string
  sessionRef?: SessionRef
  revision: number
  attempt: number
  state: RunLifecycleState
  checkpointRef?: CheckpointRef
  updatedAt: string
  reason?: string
}

export interface WebTaskEvent {
  schemaVersion: 'web-task-event/v1'
  sequence: number
  type: string
  timestamp: string
  runId: string
  revision: number
  snapshot?: RunSnapshot
  data?: JsonObject
}

export interface AgentRole {
  schemaVersion: 'agent-role/v1'
  id: string
  version: string
  capabilities: string[]
  authority: 'read_only' | 'recommend_only'
  inputArtifactKinds: string[]
  outputArtifactKind: string
}

/**
 * Stable telemetry projection. Internal filesystem locations and runtime-only
 * counter taxonomies are intentionally absent from the public contract.
 */
export interface RunMetrics {
  schemaVersion: 'run-metrics/v1'
  generatedAt: string
  runId?: string
  sessionId?: string
  source: string
  scenario?: string
  profile?: string
  status: 'completed' | 'blocked' | 'incomplete' | 'failed' | 'unknown'
  durationMs: number
  llmCalls: number
  toolCalls: number
  warnings: string[]
}

export interface WebTaskInputSnapshot {
  schemaVersion: 'web-task-input-snapshot/v1'
  inputSchemaVersion: 'web-task-input/v1'
  goal: TaskGoal
  contract: TaskContract
  startUrl?: string
  contextItems: ContextItem[]
  contextProviders: ContextProviderDescriptor[]
  policy?: TaskPolicy
  runId: string
  sessionRef?: SessionRef
  revision: number
  ownerScope?: OwnerScope
  sha256: string
}

export interface WebTaskResult {
  schemaVersion: 'web-task-result/v1'
  runId: string
  revision: number
  status: 'completed' | 'blocked' | 'failed' | 'cancelled'
  summary: string
  evidence: EvidenceRef[]
  artifacts: ArtifactRef[]
  formState?: CompletionFormState
  actions?: ActionOutcome[]
  metrics: RunMetrics
  sessionRef?: SessionRef
  checkpointRef?: CheckpointRef
  ownerScope?: OwnerScope
}
