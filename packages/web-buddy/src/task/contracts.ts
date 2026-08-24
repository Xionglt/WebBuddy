import { createHash } from 'node:crypto'
import type { RunMetrics } from '../metrics/schema.js'
import { isSafeStorageIdentity } from '../security/storage-identity.js'

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[]
export interface JsonObject { [key: string]: JsonValue }
export type MaybePromise<T> = T | Promise<T>

export type ContentOrigin = 'system' | 'user' | 'web' | 'tool' | 'download' | 'artifact' | 'memory' | 'subagent' | 'derived'
export type ContentTrust = 'trusted_runtime' | 'user_authorized' | 'untrusted_external' | 'derived_untrusted' | 'non_authoritative'
export type InstructionAuthority = 'system_policy' | 'user_goal' | 'advisory' | 'data_only'
export type ContentSensitivity = 'public' | 'internal' | 'personal' | 'auth' | 'secret'
export type SensitiveDataClass = 'cookie' | 'token' | 'password' | 'otp' | 'captcha' | 'identity' | 'payment' | 'file_path'
export type ContextUse = 'prompt' | 'trace' | 'artifact' | 'memory' | 'subagent' | 'sink'
export type SensitiveActionKind = 'navigate' | 'type_or_paste' | 'upload' | 'send' | 'publish' | 'submit' | 'payment' | 'memory_write' | 'permission_write'
export type EvidenceAuthority = 'main_runtime' | 'user' | 'page_claim' | 'subagent_advisory'

const CONTEXT_ORIGINS = ['system', 'user', 'web', 'tool', 'download', 'artifact', 'memory', 'subagent', 'derived'] as const satisfies readonly ContentOrigin[]
const CONTEXT_TRUST_LEVELS = ['trusted_runtime', 'user_authorized', 'untrusted_external', 'derived_untrusted', 'non_authoritative'] as const satisfies readonly ContentTrust[]
const CONTEXT_SENSITIVITY_LEVELS = ['public', 'internal', 'personal', 'auth', 'secret'] as const satisfies readonly ContentSensitivity[]
const INSTRUCTION_AUTHORITIES = ['system_policy', 'user_goal', 'advisory', 'data_only'] as const satisfies readonly InstructionAuthority[]
const CONTEXT_USES = ['prompt', 'trace', 'artifact', 'memory', 'subagent', 'sink'] as const satisfies readonly ContextUse[]

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
  /** When present, each external business key must have its own matching artifact. */
  businessKeys?: string[]
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
  /** When present, every listed domain action must independently satisfy the outcome. */
  businessKeys?: string[]
}

export type CompletionCriterion = EvidencePresentCriterion | ArtifactPresentCriterion | FormStateCriterion | HumanConfirmationCriterion | ActionBoundaryCriterion

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
  decision: 'allow' | 'ask' | 'deny'
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
  /** Stable external effect identity covered by the approval digest. */
  externalBusinessKey?: string
  externalEffectDigest?: string
  externalProbeId?: string
  /** Trusted semantic effect kind, distinct from the low-level browser tool name. */
  externalActionKind?: Extract<SensitiveActionKind, 'upload' | 'send' | 'publish' | 'submit' | 'payment'>
  /** Bounded, redacted canonical effect JSON shown to the approver and covered by this binding. */
  externalEffectPreview?: string
  actionSeq: number
  pageRevision?: number
  workflowRevision?: number
  expiresAt: string
}

interface ApprovalBindingBase {
  approvalId: string
  actionBindingSha256: string
  issuedAt: string
  expiresAt: string
  nonce: string
  consumedAt?: string
}

export interface ApprovalBindingV1 extends ApprovalBindingBase {
  schemaVersion: 'approval-binding/v1'
  /** `approved` is awareness/ordinary approval; a reconciled external effect requires the explicit execution decision. */
  decision: 'approved' | 'denied'
}

export interface ApprovalBindingV2 extends ApprovalBindingBase {
  schemaVersion: 'approval-binding/v2'
  decision: 'approved' | 'approved_and_execute' | 'denied'
}

export type ApprovalBinding = ApprovalBindingV1 | ApprovalBindingV2

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
  binding: { runId: string; revision: number; sessionRef?: SessionRef; actionSeq?: number; pageRevision?: number; workflowRevision?: number }
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
  binding: {
    runId: string
    revision: number
    sessionRef?: SessionRef
    actionSeq?: number
    externalBusinessKey?: string
  }
  requiresMainWorkflowVerification: boolean
  authoritativeCompletionEvidence: boolean
  redaction: { status: 'not_required' | 'redacted' | 'rejected'; policyId: string }
  scanner: { status: 'clean' | 'quarantined' | 'rejected' | 'not_scanned'; scannerId: string }
}

export type RunLifecycleState = 'queued' | 'running' | 'pausing' | 'paused' | 'blocked_on_human' | 'resuming' | 'cancelling' | 'cancelled' | 'completed' | 'failed' | 'interrupted' | 'recoverable'

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

export interface WebTaskRuntimeRequest {
  schemaVersion: 'web-task-runtime-request/v1'
  input: WebTaskInputSnapshot
  contextItems: ContextItem[]
  runtime?: Omit<RuntimeOptions, 'driver'>
  emit(event: Omit<WebTaskEvent, 'schemaVersion' | 'sequence' | 'timestamp'>): void
}

export interface WebTaskRuntimeOutcome {
  status: 'completed' | 'blocked' | 'failed' | 'cancelled'
  summary: string
  evidence: EvidenceRef[]
  artifacts: ArtifactRef[]
  metrics: RunMetrics
  sessionRef?: SessionRef
  checkpointRef?: CheckpointRef
  formState?: CompletionFormState
  actions?: ActionOutcome[]
}

export interface WebTaskRuntimeDriver {
  execute(request: WebTaskRuntimeRequest): Promise<WebTaskRuntimeOutcome>
}

export interface RunExecutionContext {
  schemaVersion: 'run-execution-context/v1'
  runRevision: number
  attempt: number
  sessionRef?: SessionRef
  recoveryMode?: 'read_only_reobserve/v1' | 'continuation_reobserve/v1'
}

export interface RuntimeOptions {
  maxSteps?: number
  traceOutDir?: string
  headless?: boolean
  executionContext?: RunExecutionContext
  driver?: WebTaskRuntimeDriver
}

export interface WebTaskInput {
  schemaVersion: 'web-task-input/v1'
  goal: TaskGoal
  contract: TaskContract
  startUrl?: string
  contextItems?: ContextItem[]
  contextProviders?: ContextProvider[]
  policy?: TaskPolicy
  runtime?: RuntimeOptions
  runId?: string
  sessionRef?: SessionRef
  revision?: number
  ownerScope?: OwnerScope
  onEvent?: (event: WebTaskEvent) => void
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

export interface CompletionFormState {
  audited: boolean
  requiredFieldCoverage: number
  visibleErrorCount: number
  submitted: boolean
}

export interface ActionOutcome {
  actionKind: SensitiveActionKind
  outcome: 'not_performed' | 'approved' | 'performed' | 'indeterminate'
  actionId?: string
  businessKey?: string
  /** Distinguishes a local execution attempt from an effect found only by authoritative read-back. */
  localExecutionAttempted?: boolean
}

export type WebTaskContractErrorCode = 'INVALID_CONTRACT' | 'UNSUPPORTED_SCHEMA_VERSION' | 'STALE_REVISION' | 'BINDING_MISMATCH' | 'PROVIDER_FAILED' | 'IDEMPOTENCY_CONFLICT'

export class WebTaskContractError extends Error {
  constructor(readonly code: WebTaskContractErrorCode, message: string) {
    super(message)
    this.name = 'WebTaskContractError'
  }
}

export function validateWebTaskInput(input: WebTaskInput): void {
  if (input.schemaVersion !== 'web-task-input/v1') unsupported('WebTaskInput', input.schemaVersion)
  validateTaskGoal(input.goal, 'goal')
  validateTaskContract(input.contract)
  if (input.startUrl) validateStartUrl(input.startUrl)
  integer(input.revision ?? 0, 'revision')
  if (input.runId !== undefined && !isSafeStorageIdentity(input.runId)) {
    invalid('runId must be a canonical storage-safe identity.')
  }
  input.contextItems?.forEach(validateContextItem)
  unique(input.contextItems?.map((item) => item.id) ?? [], 'context item id')
  for (const provider of input.contextProviders ?? []) {
    nonEmpty(provider.id, 'contextProvider.id')
    nonEmpty(provider.version, 'contextProvider.version')
    if (typeof provider.provide !== 'function') invalid(`Context provider ${provider.id} has no provide() function.`)
  }
  unique((input.contextProviders ?? []).map((provider) => provider.id), 'context provider id')
  if (input.policy) validateTaskPolicy(input.policy)
  if (input.sessionRef) validateSessionRef(input.sessionRef, input.runId ?? input.sessionRef.runId)
}

export function validateWebTaskInputSnapshot(
  input: WebTaskInputSnapshot,
): void {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid('WebTaskInputSnapshot must be an object.')
  if (input.schemaVersion !== 'web-task-input-snapshot/v1') unsupported('WebTaskInputSnapshot', input.schemaVersion)
  if (input.inputSchemaVersion !== 'web-task-input/v1') unsupported('WebTaskInput', input.inputSchemaVersion)
  exactKeys(input as unknown as Record<string, unknown>, [
    'schemaVersion',
    'inputSchemaVersion',
    'goal',
    'contract',
    'startUrl',
    'contextItems',
    'contextProviders',
    'policy',
    'runId',
    'sessionRef',
    'revision',
    'ownerScope',
    'sha256',
  ], 'WebTaskInputSnapshot')
  if (!isSafeStorageIdentity(input.runId)) invalid('snapshot.runId must be a canonical storage-safe identity.')
  validateTaskGoal(input.goal, 'snapshot.goal')
  validateTaskContract(input.contract)
  if (input.startUrl) validateStartUrl(input.startUrl)
  if (!Array.isArray(input.contextItems)) invalid('snapshot.contextItems must be an array.')
  input.contextItems.forEach(validateContextItem)
  unique(input.contextItems.map((item) => item.id), 'snapshot context item id')
  if (!Array.isArray(input.contextProviders)) invalid('snapshot.contextProviders must be an array.')
  for (const provider of input.contextProviders) {
    nonEmpty(provider.id, 'snapshot.contextProvider.id')
    nonEmpty(provider.version, `snapshot.contextProvider(${provider.id}).version`)
  }
  unique(input.contextProviders.map((provider) => provider.id), 'snapshot context provider id')
  if (input.policy) validateTaskPolicy(input.policy)
  integer(input.revision, 'snapshot.revision')
  if (input.revision !== input.contract.revision) {
    throw new WebTaskContractError('BINDING_MISMATCH', 'Snapshot revision must match TaskContract revision.')
  }
  if (input.sessionRef) validateSessionRef(input.sessionRef, input.runId)
  validateOwnerScope(input.ownerScope)
  if (!/^[a-f0-9]{64}$/i.test(input.sha256)) invalid('snapshot.sha256 must be a SHA-256 hex digest.')
  const { sha256: _sha256, ...unsigned } = input
  if (digestCanonicalJson(unsigned) !== input.sha256) {
    throw new WebTaskContractError('BINDING_MISMATCH', 'Snapshot sha256 does not match its canonical payload.')
  }
}

function validateTaskGoal(goal: TaskGoal, path: string): void {
  exactKeys(goal as unknown as Record<string, unknown>, [
    'instruction',
    'scenario',
    'metadata',
  ], path)
  nonEmpty(goal?.instruction, `${path}.instruction`)
  if (goal?.scenario !== undefined) nonEmpty(goal.scenario, `${path}.scenario`)
  validateJsonValue(goal?.metadata, `${path}.metadata`)
}

export function validateTaskContract(contract: TaskContract): void {
  if (contract?.schemaVersion !== 'web-task-contract/v1') unsupported('TaskContract', contract?.schemaVersion)
  exactKeys(contract as unknown as Record<string, unknown>, [
    'schemaVersion',
    'contractId',
    'revision',
    'criteria',
    'requiredEvidence',
    'sensitiveActions',
  ], 'TaskContract')
  nonEmpty(contract.contractId, 'contract.contractId')
  integer(contract.revision, 'contract.revision')
  if (!Array.isArray(contract.criteria) || contract.criteria.length === 0) invalid('contract.criteria must be non-empty.')
  unique(contract.criteria.map((criterion) => criterion.id), 'criterion id')
  for (const criterion of contract.criteria) {
    const baseKeys = ['id', 'kind', 'description', 'required']
    nonEmpty(criterion.id, 'criterion.id')
    nonEmpty(criterion.description, `criterion(${criterion.id}).description`)
    if (criterion.kind === 'evidence_present') {
      exactKeys(criterion as unknown as Record<string, unknown>, [
        ...baseKeys,
        'evidenceKinds',
        'minCount',
        'allowedAuthorities',
        'maxAgeMs',
      ], `criterion(${criterion.id})`)
      nonEmptyArray(criterion.evidenceKinds, `${criterion.id}.evidenceKinds`)
      positiveInteger(criterion.minCount, `${criterion.id}.minCount`)
      nonEmptyArray(criterion.allowedAuthorities, `${criterion.id}.allowedAuthorities`)
      if (criterion.maxAgeMs !== undefined) nonNegativeInteger(criterion.maxAgeMs, `${criterion.id}.maxAgeMs`)
    } else if (criterion.kind === 'artifact_present') {
      exactKeys(criterion as unknown as Record<string, unknown>, [
        ...baseKeys,
        'artifactKinds',
        'minCount',
        'schemaVersions',
        'businessKeys',
      ], `criterion(${criterion.id})`)
      nonEmptyArray(criterion.artifactKinds, `${criterion.id}.artifactKinds`)
      positiveInteger(criterion.minCount, `${criterion.id}.minCount`)
      if (criterion.businessKeys !== undefined) {
        nonEmptyArray(criterion.businessKeys, `${criterion.id}.businessKeys`)
        for (const key of criterion.businessKeys) nonEmpty(key, `${criterion.id}.businessKeys[]`)
        unique(criterion.businessKeys, `${criterion.id}.businessKeys`)
      }
    } else if (criterion.kind === 'form_state') {
      exactKeys(criterion as unknown as Record<string, unknown>, [
        ...baseKeys,
        'requireFullAudit',
        'requiredFieldCoverage',
        'allowVisibleErrors',
        'requireDraftOnly',
      ], `criterion(${criterion.id})`)
      if (!Number.isFinite(criterion.requiredFieldCoverage) || criterion.requiredFieldCoverage < 0 || criterion.requiredFieldCoverage > 1) invalid(`${criterion.id}.requiredFieldCoverage must be between 0 and 1.`)
    } else if (criterion.kind === 'human_confirmation') {
      exactKeys(criterion as unknown as Record<string, unknown>, [
        ...baseKeys,
        'confirmationKind',
        'actionId',
      ], `criterion(${criterion.id})`)
      nonEmpty(criterion.confirmationKind, `${criterion.id}.confirmationKind`)
    } else if (criterion.kind === 'action_boundary') {
      exactKeys(criterion as unknown as Record<string, unknown>, [
        ...baseKeys,
        'actionKinds',
        'outcome',
        'businessKeys',
      ], `criterion(${criterion.id})`)
      nonEmptyArray(criterion.actionKinds, `${criterion.id}.actionKinds`)
      if (criterion.businessKeys !== undefined) {
        nonEmptyArray(criterion.businessKeys, `${criterion.id}.businessKeys`)
        for (const key of criterion.businessKeys) nonEmpty(key, `${criterion.id}.businessKeys[]`)
        unique(criterion.businessKeys, `${criterion.id}.businessKeys`)
      }
    } else {
      invalid(`Unknown completion criterion kind: ${(criterion as { kind?: unknown }).kind}`)
    }
  }
  for (const requirement of contract.requiredEvidence ?? []) {
    exactKeys(requirement as unknown as Record<string, unknown>, [
      'id',
      'kinds',
      'minCount',
      'allowedAuthorities',
      'origins',
      'maxAgeMs',
      'independentlyObserved',
    ], `evidenceRequirement(${requirement.id})`)
    nonEmpty(requirement.id, 'evidenceRequirement.id')
    nonEmptyArray(requirement.kinds, `${requirement.id}.kinds`)
    nonEmptyArray(requirement.allowedAuthorities, `${requirement.id}.allowedAuthorities`)
    positiveInteger(requirement.minCount, `${requirement.id}.minCount`)
    if (requirement.maxAgeMs !== undefined) nonNegativeInteger(requirement.maxAgeMs, `${requirement.id}.maxAgeMs`)
  }
  validateSensitiveActionRules(contract.sensitiveActions ?? [], 'TaskContract.sensitiveActions')
}

export function validateAgentRole(role: AgentRole): void {
  if (role.schemaVersion !== 'agent-role/v1') unsupported('AgentRole', role.schemaVersion)
  nonEmpty(role.id, 'agentRole.id')
  nonEmpty(role.version, 'agentRole.version')
  nonEmptyArray(role.capabilities, 'agentRole.capabilities')
  nonEmptyArray(role.inputArtifactKinds, 'agentRole.inputArtifactKinds')
  nonEmpty(role.outputArtifactKind, 'agentRole.outputArtifactKind')
  if (role.authority !== 'read_only' && role.authority !== 'recommend_only') invalid('AgentRole authority cannot write browser state.')
}

export function validateTaskPolicy(policy: TaskPolicy): void {
  if (policy.schemaVersion !== 'task-policy/v1') unsupported('TaskPolicy', policy.schemaVersion)
  exactKeys(policy as unknown as Record<string, unknown>, [
    'schemaVersion',
    'defaultSensitiveAction',
    'rules',
  ], 'TaskPolicy')
  enumValue(policy.defaultSensitiveAction, ['ask', 'deny'], 'TaskPolicy.defaultSensitiveAction')
  validateSensitiveActionRules(policy.rules, 'TaskPolicy.rules')
}

function validateSensitiveActionRules(
  rules: readonly SensitiveActionRule[],
  path: string,
): void {
  if (!Array.isArray(rules)) invalid(`${path} must be an array.`)
  unique(rules.map((rule) => rule.id), 'sensitive action rule id')
  for (const rule of rules) {
    exactKeys(rule as unknown as Record<string, unknown>, [
      'id',
      'actionKinds',
      'decision',
      'sourceSensitivities',
      'destinationOrigins',
      'requireApprovalBinding',
    ], `sensitiveActionRule(${rule.id})`)
    nonEmpty(rule.id, 'sensitiveActionRule.id')
    nonEmptyArray(rule.actionKinds, `${rule.id}.actionKinds`)
    enumValue(rule.decision, ['allow', 'ask', 'deny'], `${rule.id}.decision`)
    if (rule.decision === 'allow') {
      if (rule.requireApprovalBinding) invalid(`${rule.id}.requireApprovalBinding must be false for an allow rule.`)
      if (rule.actionKinds.some((actionKind: SensitiveActionKind) => actionKind !== 'navigate')) {
        invalid(`${rule.id}.allow may only cover read-only navigation.`)
      }
    }
    for (const origin of rule.destinationOrigins ?? []) validateFullOrigin(origin, `${rule.id}.destinationOrigins`)
  }
}

export function validateEvidenceRef(evidence: EvidenceRef, runId: string, revision: number): void {
  if (evidence.schemaVersion !== 'evidence-ref/v1') unsupported('EvidenceRef', evidence.schemaVersion)
  exactKeys(evidence as unknown as Record<string, unknown>, [
    'schemaVersion',
    'id',
    'kind',
    'summary',
    'authority',
    'origin',
    'trust',
    'sensitivity',
    'provenance',
    'freshness',
    'independentlyObserved',
    'spoofableTextOnly',
    'binding',
    'verifier',
    'verificationStatus',
    'createdAt',
    'expiresAt',
    'artifactSha256',
    'actionBinding',
    'approvalBinding',
  ], 'EvidenceRef')
  exactKeys(evidence.provenance as unknown as Record<string, unknown>, [
    'capturedAt',
    'parentContentIds',
    'runId',
    'sessionId',
    'sourceUrl',
    'sourceOrigin',
    'toolCallId',
    'artifactId',
    'sha256',
  ], `${evidence.id}.provenance`)
  exactKeys(evidence.freshness as unknown as Record<string, unknown>, [
    'validity', 'revision', 'actionSeq', 'pageRevision', 'workflowRevision', 'expiresAt',
  ], `${evidence.id}.freshness`)
  exactKeys(evidence.binding as unknown as Record<string, unknown>, [
    'runId', 'revision', 'sessionRef', 'actionSeq', 'pageRevision', 'workflowRevision',
  ], `${evidence.id}.binding`)
  nonEmpty(evidence.id, 'evidence.id')
  nonEmpty(evidence.kind, `${evidence.id}.kind`)
  nonEmpty(evidence.summary, `${evidence.id}.summary`)
  nonEmpty(evidence.verifier, `${evidence.id}.verifier`)
  enumValue(evidence.authority, [
    'main_runtime', 'user', 'page_claim', 'subagent_advisory',
  ], `${evidence.id}.authority`)
  enumValue(evidence.origin, CONTEXT_ORIGINS, `${evidence.id}.origin`)
  enumValue(evidence.trust, CONTEXT_TRUST_LEVELS, `${evidence.id}.trust`)
  enumValue(evidence.sensitivity, CONTEXT_SENSITIVITY_LEVELS, `${evidence.id}.sensitivity`)
  enumValue(evidence.freshness.validity, [
    'current', 'stale', 'unverified', 'not_applicable',
  ], `${evidence.id}.freshness.validity`)
  enumValue(evidence.verificationStatus, [
    'verified', 'unverified', 'rejected',
  ], `${evidence.id}.verificationStatus`)
  if (typeof evidence.independentlyObserved !== 'boolean'
    || typeof evidence.spoofableTextOnly !== 'boolean') {
    invalid(`${evidence.id} observation flags must be boolean.`)
  }
  isoTimestamp(evidence.createdAt, `${evidence.id}.createdAt`)
  if (evidence.expiresAt !== undefined) isoTimestamp(evidence.expiresAt, `${evidence.id}.expiresAt`)
  if (evidence.expiresAt !== undefined
    && Date.parse(evidence.expiresAt) <= Date.parse(evidence.createdAt)) {
    invalid(`${evidence.id}.expiresAt must follow createdAt.`)
  }
  isoTimestamp(evidence.provenance.capturedAt, `${evidence.id}.provenance.capturedAt`)
  if (!Array.isArray(evidence.provenance.parentContentIds)
    || evidence.provenance.parentContentIds.some((value) => typeof value !== 'string' || value.trim() === '')) {
    invalid(`${evidence.id}.provenance.parentContentIds must contain only non-empty strings.`)
  }
  unique(evidence.provenance.parentContentIds, `${evidence.id}.provenance.parentContentIds`)
  if (evidence.provenance.sha256 !== undefined
    && !/^[a-f0-9]{64}$/i.test(evidence.provenance.sha256)) {
    invalid(`${evidence.id}.provenance.sha256 must be a SHA-256 hex digest.`)
  }
  for (const [key, value] of Object.entries(evidence.provenance)) {
    if (key !== 'parentContentIds' && key !== 'capturedAt' && key !== 'sha256' && value !== undefined) {
      nonEmpty(value, `${evidence.id}.provenance.${key}`)
    }
  }
  if (evidence.freshness.expiresAt !== undefined) {
    isoTimestamp(evidence.freshness.expiresAt, `${evidence.id}.freshness.expiresAt`)
  }
  for (const [key, value] of Object.entries(evidence.freshness)) {
    if (['revision', 'actionSeq', 'pageRevision', 'workflowRevision'].includes(key)
      && value !== undefined) {
      nonNegativeInteger(value as number, `${evidence.id}.freshness.${key}`)
    }
  }
  nonNegativeInteger(evidence.binding.revision, `${evidence.id}.binding.revision`)
  if (evidence.binding.runId !== runId || evidence.binding.revision !== revision) throw new WebTaskContractError('BINDING_MISMATCH', `${evidence.id} does not match the current run/revision.`)
  if (evidence.binding.sessionRef) validateSessionRef(evidence.binding.sessionRef, runId)
  if (evidence.binding.actionSeq !== undefined) nonNegativeInteger(evidence.binding.actionSeq, `${evidence.id}.binding.actionSeq`)
  if (evidence.binding.pageRevision !== undefined) nonNegativeInteger(evidence.binding.pageRevision, `${evidence.id}.binding.pageRevision`)
  if (evidence.binding.workflowRevision !== undefined) nonNegativeInteger(evidence.binding.workflowRevision, `${evidence.id}.binding.workflowRevision`)
  if (evidence.artifactSha256 !== undefined && !/^[a-f0-9]{64}$/i.test(evidence.artifactSha256)) {
    invalid(`${evidence.id}.artifactSha256 must be a SHA-256 hex digest.`)
  }
  if (evidence.authority === 'subagent_advisory' && evidence.trust !== 'non_authoritative') invalid(`${evidence.id}: subagent evidence must be non_authoritative.`)
  if (evidence.actionBinding) {
    validateActionBinding(evidence.actionBinding, runId, revision)
    if (evidence.binding.actionSeq !== undefined && evidence.binding.actionSeq !== evidence.actionBinding.actionSeq) {
      throw new WebTaskContractError('BINDING_MISMATCH', `${evidence.id}.binding.actionSeq does not match its ActionBinding.`)
    }
    if (evidence.binding.sessionRef && evidence.actionBinding.sessionRef
      && digestCanonicalJson(evidence.binding.sessionRef) !== digestCanonicalJson(evidence.actionBinding.sessionRef)) {
      throw new WebTaskContractError('BINDING_MISMATCH', `${evidence.id}.binding.sessionRef does not match its ActionBinding.`)
    }
  }
  if (evidence.approvalBinding) {
    validateApprovalBinding(evidence.approvalBinding)
    if (!evidence.actionBinding
      || evidence.approvalBinding.actionBindingSha256 !== digestCanonicalJson(evidence.actionBinding)) {
      throw new WebTaskContractError(
        'BINDING_MISMATCH',
        `${evidence.id}.approvalBinding does not bind its exact ActionBinding.`,
      )
    }
  }
}

export function validateArtifactRef(artifact: ArtifactRef, runId: string, revision: number): void {
  if (artifact.schemaVersion !== 'artifact-ref/v1') unsupported('ArtifactRef', artifact.schemaVersion)
  exactKeys(artifact as unknown as Record<string, unknown>, [
    'schemaVersion',
    'id',
    'kind',
    'payloadSchemaVersion',
    'mediaType',
    'byteLength',
    'sha256',
    'createdAt',
    'immutable',
    'locator',
    'producer',
    'parentEvidenceIds',
    'parentArtifactIds',
    'origin',
    'trust',
    'sensitivity',
    'retention',
    'ownerScope',
    'binding',
    'requiresMainWorkflowVerification',
    'authoritativeCompletionEvidence',
    'redaction',
    'scanner',
  ], 'ArtifactRef')
  exactKeys(artifact.producer as unknown as Record<string, unknown>, ['id', 'version'], `${artifact.id}.producer`)
  exactKeys(artifact.retention as unknown as Record<string, unknown>, [
    'scope', 'expiresAt', 'deleteWithSession', 'audience',
  ], `${artifact.id}.retention`)
  exactKeys(artifact.binding as unknown as Record<string, unknown>, [
    'runId', 'revision', 'sessionRef', 'actionSeq', 'externalBusinessKey',
  ], `${artifact.id}.binding`)
  exactKeys(artifact.redaction as unknown as Record<string, unknown>, ['status', 'policyId'], `${artifact.id}.redaction`)
  exactKeys(artifact.scanner as unknown as Record<string, unknown>, ['status', 'scannerId'], `${artifact.id}.scanner`)
  nonEmpty(artifact.id, 'artifact.id')
  nonEmpty(artifact.kind, `${artifact.id}.kind`)
  nonEmpty(artifact.payloadSchemaVersion, `${artifact.id}.payloadSchemaVersion`)
  nonEmpty(artifact.mediaType, `${artifact.id}.mediaType`)
  nonEmpty(artifact.locator, `${artifact.id}.locator`)
  nonEmpty(artifact.producer.id, `${artifact.id}.producer.id`)
  nonEmpty(artifact.producer.version, `${artifact.id}.producer.version`)
  nonEmpty(artifact.redaction.policyId, `${artifact.id}.redaction.policyId`)
  nonEmpty(artifact.scanner.scannerId, `${artifact.id}.scanner.scannerId`)
  isoTimestamp(artifact.createdAt, `${artifact.id}.createdAt`)
  nonNegativeInteger(artifact.binding.revision, `${artifact.id}.binding.revision`)
  if (artifact.binding.runId !== runId || artifact.binding.revision !== revision) throw new WebTaskContractError('BINDING_MISMATCH', `${artifact.id} does not match the current run/revision.`)
  if (artifact.binding.sessionRef) validateSessionRef(artifact.binding.sessionRef, runId)
  if (artifact.binding.actionSeq !== undefined) nonNegativeInteger(artifact.binding.actionSeq, `${artifact.id}.binding.actionSeq`)
  if (artifact.binding.externalBusinessKey !== undefined) {
    nonEmpty(artifact.binding.externalBusinessKey, `${artifact.id}.binding.externalBusinessKey`)
    if (artifact.binding.externalBusinessKey !== artifact.binding.externalBusinessKey.trim()) {
      invalid(`${artifact.id}.binding.externalBusinessKey must be canonical.`)
    }
  }
  if (!Number.isSafeInteger(artifact.byteLength) || artifact.byteLength < 0) invalid(`${artifact.id}.byteLength must be a non-negative integer.`)
  if (!/^[a-f0-9]{64}$/i.test(artifact.sha256)) invalid(`${artifact.id}.sha256 must be a SHA-256 hex digest.`)
  if (!artifact.immutable) invalid(`${artifact.id} must be immutable.`)
  if (/^(?:file:|\/|[A-Za-z]:[\\/])/.test(artifact.locator)) invalid(`${artifact.id}.locator must be opaque and must not expose an absolute path.`)
  if (!Array.isArray(artifact.parentEvidenceIds)
    || artifact.parentEvidenceIds.some((value) => typeof value !== 'string' || value.trim() === '')) {
    invalid(`${artifact.id}.parentEvidenceIds must contain only non-empty strings.`)
  }
  if (!Array.isArray(artifact.parentArtifactIds)
    || artifact.parentArtifactIds.some((value) => typeof value !== 'string' || value.trim() === '')) {
    invalid(`${artifact.id}.parentArtifactIds must contain only non-empty strings.`)
  }
  unique(artifact.parentEvidenceIds, `${artifact.id}.parentEvidenceIds`)
  unique(artifact.parentArtifactIds, `${artifact.id}.parentArtifactIds`)
  enumValue(artifact.origin, CONTEXT_ORIGINS, `${artifact.id}.origin`)
  enumValue(artifact.trust, CONTEXT_TRUST_LEVELS, `${artifact.id}.trust`)
  enumValue(artifact.sensitivity, CONTEXT_SENSITIVITY_LEVELS, `${artifact.id}.sensitivity`)
  enumValue(artifact.retention.scope, ['turn', 'run', 'session', 'project'], `${artifact.id}.retention.scope`)
  if (typeof artifact.retention.deleteWithSession !== 'boolean') {
    invalid(`${artifact.id}.retention.deleteWithSession must be boolean.`)
  }
  if (artifact.retention.expiresAt !== undefined) {
    isoTimestamp(artifact.retention.expiresAt, `${artifact.id}.retention.expiresAt`)
  }
  if (artifact.retention.audience !== undefined) {
    if (!Array.isArray(artifact.retention.audience)
      || artifact.retention.audience.some((value) => typeof value !== 'string' || value.trim() === '')) {
      invalid(`${artifact.id}.retention.audience must contain only non-empty strings.`)
    }
    unique(artifact.retention.audience, `${artifact.id}.retention.audience`)
  }
  validateOwnerScope(artifact.ownerScope)
  if (typeof artifact.requiresMainWorkflowVerification !== 'boolean'
    || typeof artifact.authoritativeCompletionEvidence !== 'boolean') {
    invalid(`${artifact.id} completion authority flags must be boolean.`)
  }
  enumValue(artifact.redaction.status, ['not_required', 'redacted', 'rejected'], `${artifact.id}.redaction.status`)
  enumValue(artifact.scanner.status, ['clean', 'quarantined', 'rejected', 'not_scanned'], `${artifact.id}.scanner.status`)
  if (artifact.origin === 'subagent' || artifact.trust === 'non_authoritative') {
    if (!artifact.requiresMainWorkflowVerification || artifact.authoritativeCompletionEvidence) invalid(`${artifact.id}: subagent artifacts must require Main verification and cannot be authoritative.`)
  }
}

export function validateActionBinding(binding: ActionBinding, runId = binding.runId, revision = binding.contractRevision): void {
  if (binding.schemaVersion !== 'action-binding/v1') unsupported('ActionBinding', binding.schemaVersion)
  exactKeys(binding as unknown as Record<string, unknown>, [
    'schemaVersion',
    'contractId',
    'contractRevision',
    'runId',
    'sessionRef',
    'actionId',
    'toolName',
    'argsSha256',
    'sourceContentIds',
    'sourceSensitiveClasses',
    'sourceOrigin',
    'destinationOrigin',
    'targetFingerprint',
    'externalBusinessKey',
    'externalEffectDigest',
    'externalProbeId',
    'externalActionKind',
    'externalEffectPreview',
    'actionSeq',
    'pageRevision',
    'workflowRevision',
    'expiresAt',
  ], 'ActionBinding')
  nonEmpty(binding.contractId, 'actionBinding.contractId')
  nonNegativeInteger(binding.contractRevision, 'actionBinding.contractRevision')
  nonEmpty(binding.runId, 'actionBinding.runId')
  if (binding.runId !== runId || binding.contractRevision !== revision) throw new WebTaskContractError('BINDING_MISMATCH', 'Action binding does not match the current run/revision.')
  nonEmpty(binding.actionId, 'actionBinding.actionId')
  nonEmpty(binding.toolName, 'actionBinding.toolName')
  if (binding.sessionRef) validateSessionRef(binding.sessionRef, runId)
  nonNegativeInteger(binding.actionSeq, 'actionBinding.actionSeq')
  if (binding.pageRevision !== undefined) nonNegativeInteger(binding.pageRevision, 'actionBinding.pageRevision')
  if (binding.workflowRevision !== undefined) nonNegativeInteger(binding.workflowRevision, 'actionBinding.workflowRevision')
  isoTimestamp(binding.expiresAt, 'actionBinding.expiresAt')
  if (!/^[a-f0-9]{64}$/i.test(binding.argsSha256)) invalid('actionBinding.argsSha256 must be a SHA-256 hex digest.')
  if (!Array.isArray(binding.sourceContentIds)
    || binding.sourceContentIds.some((value) => typeof value !== 'string' || value.trim() === '')) {
    invalid('actionBinding.sourceContentIds must contain only non-empty strings.')
  }
  unique(binding.sourceContentIds, 'actionBinding.sourceContentIds')
  if (!Array.isArray(binding.sourceSensitiveClasses)
    || binding.sourceSensitiveClasses.some((value) => ![
      'cookie', 'token', 'password', 'otp', 'captcha', 'identity', 'payment', 'file_path',
    ].includes(value))) {
    invalid('actionBinding.sourceSensitiveClasses contains an unsupported sensitive data class.')
  }
  unique(binding.sourceSensitiveClasses, 'actionBinding.sourceSensitiveClasses')
  if (binding.sourceOrigin) validateFullOrigin(binding.sourceOrigin, 'actionBinding.sourceOrigin')
  if (binding.destinationOrigin) validateFullOrigin(binding.destinationOrigin, 'actionBinding.destinationOrigin')
  if (binding.targetFingerprint !== undefined) nonEmpty(binding.targetFingerprint, 'actionBinding.targetFingerprint')
  const externalFields = [binding.externalBusinessKey, binding.externalEffectDigest, binding.externalProbeId]
  if (externalFields.some((value) => value !== undefined)) {
    if (externalFields.some((value) => (
      typeof value !== 'string' || value.trim() === '' || value !== value.trim()
    ))) {
      invalid('actionBinding external effect identity must include business key, digest and probe id together.')
    }
    if (!/^[a-f0-9]{64}$/i.test(binding.externalEffectDigest!)) {
      invalid('actionBinding.externalEffectDigest must be a SHA-256 hex digest.')
    }
    if (binding.externalBusinessKey!.length > 1_024) {
      invalid('actionBinding.externalBusinessKey exceeds the maximum length.')
    }
    if (binding.externalProbeId!.length > 256) {
      invalid('actionBinding.externalProbeId exceeds the maximum length.')
    }
    if (binding.externalEffectPreview !== undefined
      && (typeof binding.externalEffectPreview !== 'string'
        || binding.externalEffectPreview.length === 0
        || binding.externalEffectPreview.length > 1_024
        || binding.externalEffectPreview !== binding.externalEffectPreview.trim())) {
      invalid('actionBinding.externalEffectPreview must be bounded canonical review text for an external effect.')
    }
    if (binding.externalEffectPreview !== undefined) {
      let parsedPreview: unknown
      try {
        parsedPreview = JSON.parse(binding.externalEffectPreview)
      } catch {
        invalid('actionBinding.externalEffectPreview must be canonical JSON.')
      }
      if (canonicalJson(parsedPreview) !== binding.externalEffectPreview) {
        invalid('actionBinding.externalEffectPreview must be canonical JSON.')
      }
    }
  } else if (binding.externalEffectPreview !== undefined) {
    invalid('actionBinding.externalEffectPreview requires the complete external effect identity.')
  }
  if (binding.externalActionKind !== undefined
    && (!externalFields.every((value) => value !== undefined)
      || !['upload', 'send', 'publish', 'submit', 'payment'].includes(binding.externalActionKind))) {
    invalid('actionBinding.externalActionKind must be a supported external effect with complete identity.')
  }
}

export function validateSessionRef(ref: SessionRef, runId: string, expectedAttempt?: number): void {
  if (ref.schemaVersion !== 'session-ref/v1') unsupported('SessionRef', ref.schemaVersion)
  exactKeys(ref as unknown as Record<string, unknown>, [
    'schemaVersion',
    'provider',
    'id',
    'runId',
    'attempt',
    'checkpointRef',
  ], 'SessionRef')
  if (ref.runId !== runId || (expectedAttempt !== undefined && ref.attempt !== expectedAttempt)) {
    throw new WebTaskContractError('BINDING_MISMATCH', 'SessionRef does not match the current run/attempt.')
  }
  nonEmpty(ref.provider, 'sessionRef.provider')
  if (!isSafeStorageIdentity(ref.id)) invalid('sessionRef.id must be a canonical storage-safe identity.')
  if (!isSafeStorageIdentity(ref.runId)) invalid('sessionRef.runId must be a canonical storage-safe identity.')
  positiveInteger(ref.attempt, 'sessionRef.attempt')
  if (ref.checkpointRef) validateCheckpointRef(ref.checkpointRef)
}

export function validateRunExecutionContext(
  context: RunExecutionContext,
  runId: string,
  taskRevision: number,
): void {
  if (!context || typeof context !== 'object' || Array.isArray(context)) {
    invalid('RunExecutionContext must be an object.')
  }
  if (context.schemaVersion !== 'run-execution-context/v1') {
    unsupported('RunExecutionContext', context.schemaVersion)
  }
  exactKeys(context as unknown as Record<string, unknown>, [
    'schemaVersion',
    'runRevision',
    'attempt',
    'sessionRef',
    'recoveryMode',
  ], 'RunExecutionContext')
  integer(context.runRevision, 'executionContext.runRevision')
  if (context.runRevision < taskRevision) {
    throw new WebTaskContractError(
      'STALE_REVISION',
      'Lifecycle run revision cannot precede the immutable task revision.',
    )
  }
  positiveInteger(context.attempt, 'executionContext.attempt')
  if (context.sessionRef) validateSessionRef(context.sessionRef, runId, context.attempt)
  if (context.recoveryMode !== undefined
    && context.recoveryMode !== 'read_only_reobserve/v1'
    && context.recoveryMode !== 'continuation_reobserve/v1') {
    unsupported('RunExecutionContext recovery mode', context.recoveryMode)
  }
  if (context.recoveryMode && !context.sessionRef) {
    invalid('Recovery execution requires an exact SessionRef.')
  }
}

export function validateCheckpointRef(ref: CheckpointRef): void {
  if (ref.schemaVersion !== 'checkpoint-ref/v1') unsupported('CheckpointRef', ref.schemaVersion)
  exactKeys(ref as unknown as Record<string, unknown>, [
    'schemaVersion',
    'provider',
    'id',
  ], 'CheckpointRef')
  nonEmpty(ref.provider, 'checkpointRef.provider')
  nonEmpty(ref.id, 'checkpointRef.id')
}

export function consumeApprovalBinding(
  action: ActionBinding,
  approval: ApprovalBinding,
  consumedNonces: Set<string>,
  now = new Date(),
  requiredDecision: Extract<ApprovalBinding['decision'], 'approved' | 'approved_and_execute'> = 'approved',
): ApprovalBinding {
  validateActionBinding(action)
  validateApprovalBinding(approval)
  const issuedAtMs = Date.parse(approval.issuedAt)
  const expiresAtMs = Date.parse(approval.expiresAt)
  if (issuedAtMs > now.getTime()) {
    throw new WebTaskContractError('BINDING_MISMATCH', 'Approval binding cannot be issued in the future.')
  }
  if (approval.decision !== requiredDecision) {
    throw new WebTaskContractError(
      'BINDING_MISMATCH',
      `Approval decision must be ${requiredDecision}, received ${approval.decision}.`,
    )
  }
  if (approval.actionBindingSha256 !== digestCanonicalJson(action)) throw new WebTaskContractError('BINDING_MISMATCH', 'Approval does not bind the exact canonical action.')
  if (expiresAtMs <= now.getTime() || Date.parse(action.expiresAt) <= now.getTime()) throw new WebTaskContractError('BINDING_MISMATCH', 'Approval or action binding has expired.')
  if (approval.consumedAt || consumedNonces.has(approval.nonce)) throw new WebTaskContractError('BINDING_MISMATCH', 'Approval nonce has already been consumed.')
  consumedNonces.add(approval.nonce)
  return { ...approval, consumedAt: now.toISOString() }
}

function validateApprovalBinding(approval: ApprovalBinding): void {
  const approvalSchemaVersion = (approval as { schemaVersion?: unknown }).schemaVersion
  if (approvalSchemaVersion !== 'approval-binding/v1'
    && approvalSchemaVersion !== 'approval-binding/v2') {
    unsupported('ApprovalBinding', approvalSchemaVersion)
  }
  exactKeys(approval as unknown as Record<string, unknown>, [
    'schemaVersion',
    'approvalId',
    'actionBindingSha256',
    'decision',
    'issuedAt',
    'expiresAt',
    'nonce',
    'consumedAt',
  ], 'ApprovalBinding')
  nonEmpty(approval.approvalId, 'approvalBinding.approvalId')
  nonEmpty(approval.nonce, 'approvalBinding.nonce')
  if (!/^[a-f0-9]{64}$/i.test(approval.actionBindingSha256)) {
    invalid('approvalBinding.actionBindingSha256 must be a SHA-256 hex digest.')
  }
  enumValue(approval.decision, [
    'approved', 'approved_and_execute', 'denied',
  ], 'approvalBinding.decision')
  if (approval.decision === 'approved_and_execute'
    && approvalSchemaVersion !== 'approval-binding/v2') {
    throw new WebTaskContractError(
      'BINDING_MISMATCH',
      'approved_and_execute requires approval-binding/v2.',
    )
  }
  isoTimestamp(approval.issuedAt, 'approvalBinding.issuedAt')
  isoTimestamp(approval.expiresAt, 'approvalBinding.expiresAt')
  if (approval.consumedAt !== undefined) {
    isoTimestamp(approval.consumedAt, 'approvalBinding.consumedAt')
  }
  if (Date.parse(approval.expiresAt) <= Date.parse(approval.issuedAt)) {
    invalid('approvalBinding.expiresAt must follow approvalBinding.issuedAt.')
  }
}

export function validateContextItem(item: ContextItem): void {
  if (item.schemaVersion !== 'context-item/v1') unsupported('ContextItem', item.schemaVersion)
  exactKeys(item as unknown as Record<string, unknown>, [
    'schemaVersion',
    'id',
    'kind',
    'content',
    'origin',
    'trust',
    'instructionAuthority',
    'sensitivity',
    'sensitiveClasses',
    'provenance',
    'allowedUses',
    'freshness',
    'retention',
    'sanitization',
    'integrity',
    'memory',
  ], `ContextItem(${item.id})`)
  exactKeys(item.provenance as unknown as Record<string, unknown>, [
    'capturedAt',
    'parentContentIds',
    'runId',
    'sessionId',
    'sourceUrl',
    'sourceOrigin',
    'toolCallId',
    'artifactId',
    'sha256',
  ], `${item.id}.provenance`)
  exactKeys(item.freshness as unknown as Record<string, unknown>, [
    'validity',
    'revision',
    'actionSeq',
    'pageRevision',
    'workflowRevision',
    'expiresAt',
  ], `${item.id}.freshness`)
  exactKeys(item.retention as unknown as Record<string, unknown>, [
    'scope',
    'expiresAt',
    'deleteWithSession',
    'audience',
  ], `${item.id}.retention`)
  exactKeys(item.sanitization as unknown as Record<string, unknown>, [
    'policyId',
    'status',
    'redactedFields',
    'instructionNeutralized',
    'transformedFrom',
  ], `${item.id}.sanitization`)
  exactKeys(item.integrity as unknown as Record<string, unknown>, [
    'immutable',
    'digestVerified',
  ], `${item.id}.integrity`)
  nonEmpty(item.id, 'contextItem.id')
  nonEmpty(item.kind, 'contextItem.kind')
  validateJsonValue(item.content, `${item.id}.content`)
  enumValue(item.origin, CONTEXT_ORIGINS, `${item.id}.origin`)
  enumValue(item.trust, CONTEXT_TRUST_LEVELS, `${item.id}.trust`)
  enumValue(item.instructionAuthority, INSTRUCTION_AUTHORITIES, `${item.id}.instructionAuthority`)
  enumValue(item.sensitivity, CONTEXT_SENSITIVITY_LEVELS, `${item.id}.sensitivity`)
  isoTimestamp(item.provenance.capturedAt, `${item.id}.provenance.capturedAt`)
  if (item.freshness.expiresAt !== undefined) {
    isoTimestamp(item.freshness.expiresAt, `${item.id}.freshness.expiresAt`)
  }
  if (item.retention.expiresAt !== undefined) {
    isoTimestamp(item.retention.expiresAt, `${item.id}.retention.expiresAt`)
  }
  if (!Array.isArray(item.allowedUses) || !item.allowedUses.length) invalid(`${item.id}.allowedUses must be non-empty.`)
  for (const use of item.allowedUses) enumValue(use, CONTEXT_USES, `${item.id}.allowedUses`)
  unique(item.allowedUses, `${item.id} allowed use`)
  if (item.origin === 'subagent' && item.trust !== 'non_authoritative') invalid(`${item.id}: subagent context must be non_authoritative.`)
  if (!isTrustAllowedForContextOrigin(item.origin, item.trust)) invalid(`${item.id}: trust is invalid for origin ${item.origin}.`)
  if (item.origin === 'memory' && !item.memory) invalid(`${item.id}.memory is required for memory-origin context.`)
  if (item.origin !== 'memory' && item.memory) invalid(`${item.id}.memory is only valid for memory-origin context.`)
  if (item.sensitivity === 'secret' && item.allowedUses.includes('prompt')) invalid(`${item.id}: secret context cannot allow prompt use.`)
  if (item.sensitivity === 'secret' && item.retention.scope === 'project') invalid(`${item.id}: secret context cannot use project retention.`)
  if (['web', 'tool', 'download', 'memory', 'subagent'].includes(item.origin) && ['system_policy', 'user_goal'].includes(item.instructionAuthority)) invalid(`${item.id}: untrusted/data origins cannot have instruction authority.`)
  if (item.sanitization.status === 'quarantined' || item.sanitization.status === 'rejected') {
    if (item.allowedUses.includes('prompt') || item.allowedUses.includes('sink')) invalid(`${item.id}: quarantined/rejected context cannot enter prompt or sink.`)
  }
  if (item.memory) validateMemoryBinding(item.memory, item.id)
}

export function snapshotWebTaskInput(input: WebTaskInput, resolvedRunId = input.runId ?? createRunId()): WebTaskInputSnapshot {
  validateWebTaskInput(input)
  const revision = input.revision ?? input.contract.revision
  if (revision !== input.contract.revision) throw new WebTaskContractError('BINDING_MISMATCH', 'Input revision must match TaskContract revision.')
  if (input.sessionRef && input.sessionRef.runId !== resolvedRunId) throw new WebTaskContractError('BINDING_MISMATCH', 'sessionRef.runId must match resolved runId.')
  const unsigned = {
    schemaVersion: 'web-task-input-snapshot/v1' as const,
    inputSchemaVersion: input.schemaVersion,
    goal: input.goal,
    contract: input.contract,
    ...(input.startUrl ? { startUrl: input.startUrl } : {}),
    contextItems: input.contextItems ?? [],
    contextProviders: (input.contextProviders ?? []).map(({ id, version }) => ({ id, version })),
    ...(input.policy ? { policy: input.policy } : {}),
    runId: resolvedRunId,
    ...(input.sessionRef ? { sessionRef: input.sessionRef } : {}),
    revision,
    ...(input.ownerScope ? { ownerScope: input.ownerScope } : {}),
  }
  // A snapshot is an execution boundary, not a view over caller-owned input.
  // Detach every durable field before hashing so an async caller cannot mutate
  // the TaskContract/Policy seen by approval and execution after validation.
  const detached = structuredClone(unsigned)
  const sha256 = digestCanonicalJson(detached)
  return { ...detached, sha256 }
}

export function digestCanonicalJson(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value, new WeakSet<object>(), '$'))
}

export function isContextItemEligible(item: ContextItem, now = new Date()): boolean {
  if (item.sanitization.status === 'quarantined' || item.sanitization.status === 'rejected') return false
  if (item.freshness.validity === 'stale' || item.freshness.validity === 'unverified') return false
  const capturedAt = Date.parse(item.provenance.capturedAt)
  if (!Number.isFinite(capturedAt) || capturedAt > now.getTime()) return false
  if (expired(item.freshness.expiresAt, now) || expired(item.retention.expiresAt, now)) return false
  if (item.origin === 'memory') {
    if (!item.memory || item.memory.status !== 'active') return false
    if (expired(item.memory.expiresAt, now) || item.memory.tombstoneAt !== undefined) return false
  }
  return true
}

export function createRunId(now = new Date()): string {
  return `run-${now.toISOString().replace(/[:.]/g, '-').replace(/Z$/, '')}`
}

function canonicalize(value: unknown, seen: WeakSet<object>, path: string): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) invalid(`${path} contains a non-finite number.`)
    return value
  }
  if (typeof value !== 'object') invalid(`${path} is not JSON-safe.`)
  const object = value as object
  if (seen.has(object)) invalid(`${path} contains a cycle.`)
  seen.add(object)
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype
        || Object.keys(value).length !== value.length
        || Object.keys(value).some((key, index) => key !== String(index))) {
        invalid(`${path} contains a sparse or extended array.`)
      }
      return value.map((item, index) => canonicalize(item, seen, `${path}[${index}]`))
    }
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      invalid(`${path} contains a non-plain object.`)
    }
    const output = Object.create(null) as JsonObject
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const nested = (value as Record<string, unknown>)[key]
      if (nested === undefined) invalid(`${path}.${key} is undefined; omit it explicitly.`)
      output[key] = canonicalize(nested, seen, `${path}.${key}`)
    }
    return output
  } finally {
    seen.delete(object)
  }
}

function validateJsonValue(value: unknown, path: string): void {
  if (value === undefined) return
  canonicalize(value, new WeakSet<object>(), path)
}

function validateMemoryBinding(memory: MemoryBinding, id: string): void {
  if (memory.schemaVersion !== 'memory-binding/v1') unsupported('MemoryBinding', memory.schemaVersion)
  exactKeys(memory as unknown as Record<string, unknown>, [
    'schemaVersion',
    'memoryId',
    'revision',
    'scope',
    'status',
    'expiresAt',
    'supersedesIds',
    'conflictIds',
    'tombstoneAt',
  ], `${id}.memory`)
  nonEmpty(memory.memoryId, `${id}.memory.memoryId`)
  integer(memory.revision, `${id}.memory.revision`)
  if (memory.expiresAt !== undefined) isoTimestamp(memory.expiresAt, `${id}.memory.expiresAt`)
  if (memory.tombstoneAt !== undefined) isoTimestamp(memory.tombstoneAt, `${id}.memory.tombstoneAt`)
}

function validateOwnerScope(scope: OwnerScope | undefined): void {
  if (!scope) return
  if (scope.schemaVersion !== 'owner-scope/v1') unsupported('OwnerScope', scope.schemaVersion)
  exactKeys(scope as unknown as Record<string, unknown>, [
    'schemaVersion',
    'tenantId',
    'userId',
    'projectId',
  ], 'OwnerScope')
  if (!scope.tenantId && !scope.userId && !scope.projectId) {
    invalid('ownerScope must identify at least one tenant, user or project.')
  }
  for (const value of [scope.tenantId, scope.userId, scope.projectId]) {
    if (value !== undefined) nonEmpty(value, 'ownerScope value')
  }
}

function isTrustAllowedForContextOrigin(origin: ContentOrigin, trust: ContentTrust): boolean {
  if (origin === 'system') return trust === 'trusted_runtime'
  if (origin === 'user') return trust === 'user_authorized'
  if (origin === 'subagent') return trust === 'non_authoritative'
  if (origin === 'web' || origin === 'tool' || origin === 'download' || origin === 'memory') {
    return trust === 'untrusted_external' || trust === 'derived_untrusted' || trust === 'non_authoritative'
  }
  return trust === 'derived_untrusted' || trust === 'non_authoritative'
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], path: string): asserts value is T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) invalid(`${path} is unsupported: ${String(value)}.`)
}

function validateStartUrl(value: string): void {
  let url: URL
  try { url = new URL(value) } catch { invalid('startUrl must be an absolute URL.') }
  if (!['http:', 'https:'].includes(url!.protocol)) invalid('startUrl must use HTTP(S).')
}

function validateFullOrigin(value: string, path: string): void {
  let parsed: URL
  try { parsed = new URL(value) } catch { invalid(`${path} must contain full URL origins.`) }
  if (!['http:', 'https:'].includes(parsed!.protocol) || parsed!.origin !== value.replace(/\/$/, '')) invalid(`${path} must use scheme://host:port origin form without a path.`)
}

function expired(value: string | undefined, now: Date): boolean {
  if (value === undefined) return false
  const parsed = Date.parse(value)
  return !Number.isFinite(parsed) || parsed <= now.getTime()
}

function nonEmpty(value: unknown, path: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) invalid(`${path} must be a non-empty string.`)
}

function nonEmptyArray(value: readonly unknown[], path: string): void {
  if (!Array.isArray(value) || value.length === 0) invalid(`${path} must be a non-empty array.`)
}

function integer(value: number, path: string): void {
  if (!Number.isSafeInteger(value) || value < 0) invalid(`${path} must be a non-negative safe integer.`)
}

function positiveInteger(value: number, path: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) invalid(`${path} must be a positive safe integer.`)
}

function nonNegativeInteger(value: number, path: string): void {
  if (!Number.isSafeInteger(value) || value < 0) invalid(`${path} must be a non-negative safe integer.`)
}

function isoTimestamp(value: string, path: string): void {
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    invalid(`${path} must be a canonical UTC ISO timestamp.`)
  }
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`${path} must be an object.`)
  const allowedKeys = new Set(allowed)
  const unknown = Object.keys(value).filter((key) => !allowedKeys.has(key))
  if (unknown.length) invalid(`${path} contains unsupported field(s): ${unknown.sort().join(', ')}.`)
}

function unique(values: string[], description: string): void {
  if (new Set(values).size !== values.length) invalid(`Duplicate ${description}.`)
}

function unsupported(name: string, version: unknown): never {
  throw new WebTaskContractError('UNSUPPORTED_SCHEMA_VERSION', `${name} schema version is unsupported: ${String(version)}`)
}

function invalid(message: string): never {
  throw new WebTaskContractError('INVALID_CONTRACT', message)
}
