import { createHash } from 'node:crypto'
import type { RunMetrics } from '../metrics/schema.js'

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
  binding: { runId: string; revision: number; sessionRef?: SessionRef; actionSeq?: number }
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

export interface RuntimeOptions {
  maxSteps?: number
  traceOutDir?: string
  headless?: boolean
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
  outcome: 'not_performed' | 'approved' | 'performed'
  actionId?: string
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
  nonEmpty(input.goal?.instruction, 'goal.instruction')
  validateJsonValue(input.goal.metadata, 'goal.metadata')
  validateTaskContract(input.contract)
  if (input.startUrl) validateStartUrl(input.startUrl)
  integer(input.revision ?? 0, 'revision')
  input.contextItems?.forEach(validateContextItem)
  unique(input.contextItems?.map((item) => item.id) ?? [], 'context item id')
  for (const provider of input.contextProviders ?? []) {
    nonEmpty(provider.id, 'contextProvider.id')
    nonEmpty(provider.version, 'contextProvider.version')
    if (typeof provider.provide !== 'function') invalid(`Context provider ${provider.id} has no provide() function.`)
  }
  unique((input.contextProviders ?? []).map((provider) => provider.id), 'context provider id')
  if (input.policy) validateTaskPolicy(input.policy)
  if (input.sessionRef && input.runId && input.sessionRef.runId !== input.runId) {
    throw new WebTaskContractError('BINDING_MISMATCH', 'sessionRef.runId must match input.runId.')
  }
}

export function validateTaskContract(contract: TaskContract): void {
  if (contract?.schemaVersion !== 'web-task-contract/v1') unsupported('TaskContract', contract?.schemaVersion)
  nonEmpty(contract.contractId, 'contract.contractId')
  integer(contract.revision, 'contract.revision')
  if (!Array.isArray(contract.criteria) || contract.criteria.length === 0) invalid('contract.criteria must be non-empty.')
  unique(contract.criteria.map((criterion) => criterion.id), 'criterion id')
  for (const criterion of contract.criteria) {
    nonEmpty(criterion.id, 'criterion.id')
    nonEmpty(criterion.description, `criterion(${criterion.id}).description`)
    if (criterion.kind === 'evidence_present') {
      nonEmptyArray(criterion.evidenceKinds, `${criterion.id}.evidenceKinds`)
      positiveInteger(criterion.minCount, `${criterion.id}.minCount`)
      nonEmptyArray(criterion.allowedAuthorities, `${criterion.id}.allowedAuthorities`)
    } else if (criterion.kind === 'artifact_present') {
      nonEmptyArray(criterion.artifactKinds, `${criterion.id}.artifactKinds`)
      positiveInteger(criterion.minCount, `${criterion.id}.minCount`)
    } else if (criterion.kind === 'form_state') {
      if (!Number.isFinite(criterion.requiredFieldCoverage) || criterion.requiredFieldCoverage < 0 || criterion.requiredFieldCoverage > 1) invalid(`${criterion.id}.requiredFieldCoverage must be between 0 and 1.`)
    } else if (criterion.kind === 'human_confirmation') {
      nonEmpty(criterion.confirmationKind, `${criterion.id}.confirmationKind`)
    } else if (criterion.kind === 'action_boundary') {
      nonEmptyArray(criterion.actionKinds, `${criterion.id}.actionKinds`)
    } else {
      invalid(`Unknown completion criterion kind: ${(criterion as { kind?: unknown }).kind}`)
    }
  }
  for (const requirement of contract.requiredEvidence ?? []) {
    nonEmpty(requirement.id, 'evidenceRequirement.id')
    nonEmptyArray(requirement.kinds, `${requirement.id}.kinds`)
    nonEmptyArray(requirement.allowedAuthorities, `${requirement.id}.allowedAuthorities`)
    positiveInteger(requirement.minCount, `${requirement.id}.minCount`)
  }
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
  unique(policy.rules.map((rule) => rule.id), 'sensitive action rule id')
  for (const rule of policy.rules) {
    nonEmpty(rule.id, 'sensitiveActionRule.id')
    nonEmptyArray(rule.actionKinds, `${rule.id}.actionKinds`)
    for (const origin of rule.destinationOrigins ?? []) validateFullOrigin(origin, `${rule.id}.destinationOrigins`)
  }
}

export function validateEvidenceRef(evidence: EvidenceRef, runId: string, revision: number): void {
  if (evidence.schemaVersion !== 'evidence-ref/v1') unsupported('EvidenceRef', evidence.schemaVersion)
  nonEmpty(evidence.id, 'evidence.id')
  nonEmpty(evidence.kind, `${evidence.id}.kind`)
  nonEmpty(evidence.verifier, `${evidence.id}.verifier`)
  if (evidence.binding.runId !== runId || evidence.binding.revision !== revision) throw new WebTaskContractError('BINDING_MISMATCH', `${evidence.id} does not match the current run/revision.`)
  if (evidence.authority === 'subagent_advisory' && evidence.trust !== 'non_authoritative') invalid(`${evidence.id}: subagent evidence must be non_authoritative.`)
  if (evidence.actionBinding) validateActionBinding(evidence.actionBinding, runId, revision)
}

export function validateArtifactRef(artifact: ArtifactRef, runId: string, revision: number): void {
  if (artifact.schemaVersion !== 'artifact-ref/v1') unsupported('ArtifactRef', artifact.schemaVersion)
  nonEmpty(artifact.id, 'artifact.id')
  nonEmpty(artifact.kind, `${artifact.id}.kind`)
  if (artifact.binding.runId !== runId || artifact.binding.revision !== revision) throw new WebTaskContractError('BINDING_MISMATCH', `${artifact.id} does not match the current run/revision.`)
  if (!Number.isSafeInteger(artifact.byteLength) || artifact.byteLength < 0) invalid(`${artifact.id}.byteLength must be a non-negative integer.`)
  if (!/^[a-f0-9]{64}$/i.test(artifact.sha256)) invalid(`${artifact.id}.sha256 must be a SHA-256 hex digest.`)
  if (!artifact.immutable) invalid(`${artifact.id} must be immutable.`)
  if (/^(?:file:|\/|[A-Za-z]:[\\/])/.test(artifact.locator)) invalid(`${artifact.id}.locator must be opaque and must not expose an absolute path.`)
  if (artifact.origin === 'subagent' || artifact.trust === 'non_authoritative') {
    if (!artifact.requiresMainWorkflowVerification || artifact.authoritativeCompletionEvidence) invalid(`${artifact.id}: subagent artifacts must require Main verification and cannot be authoritative.`)
  }
}

export function validateActionBinding(binding: ActionBinding, runId = binding.runId, revision = binding.contractRevision): void {
  if (binding.schemaVersion !== 'action-binding/v1') unsupported('ActionBinding', binding.schemaVersion)
  if (binding.runId !== runId || binding.contractRevision !== revision) throw new WebTaskContractError('BINDING_MISMATCH', 'Action binding does not match the current run/revision.')
  nonEmpty(binding.actionId, 'actionBinding.actionId')
  nonEmpty(binding.toolName, 'actionBinding.toolName')
  if (!/^[a-f0-9]{64}$/i.test(binding.argsSha256)) invalid('actionBinding.argsSha256 must be a SHA-256 hex digest.')
  if (binding.sourceOrigin) validateFullOrigin(binding.sourceOrigin, 'actionBinding.sourceOrigin')
  if (binding.destinationOrigin) validateFullOrigin(binding.destinationOrigin, 'actionBinding.destinationOrigin')
}

export function consumeApprovalBinding(
  action: ActionBinding,
  approval: ApprovalBinding,
  consumedNonces: Set<string>,
  now = new Date(),
): ApprovalBinding {
  validateActionBinding(action)
  if (approval.schemaVersion !== 'approval-binding/v1') unsupported('ApprovalBinding', approval.schemaVersion)
  if (approval.decision !== 'approved') throw new WebTaskContractError('BINDING_MISMATCH', 'Approval decision is not approved.')
  if (approval.actionBindingSha256 !== digestCanonicalJson(action)) throw new WebTaskContractError('BINDING_MISMATCH', 'Approval does not bind the exact canonical action.')
  if (Date.parse(approval.expiresAt) <= now.getTime() || Date.parse(action.expiresAt) <= now.getTime()) throw new WebTaskContractError('BINDING_MISMATCH', 'Approval or action binding has expired.')
  if (approval.consumedAt || consumedNonces.has(approval.nonce)) throw new WebTaskContractError('BINDING_MISMATCH', 'Approval nonce has already been consumed.')
  nonEmpty(approval.nonce, 'approvalBinding.nonce')
  consumedNonces.add(approval.nonce)
  return { ...approval, consumedAt: now.toISOString() }
}

export function validateContextItem(item: ContextItem): void {
  if (item.schemaVersion !== 'context-item/v1') unsupported('ContextItem', item.schemaVersion)
  nonEmpty(item.id, 'contextItem.id')
  nonEmpty(item.kind, 'contextItem.kind')
  validateJsonValue(item.content, `${item.id}.content`)
  enumValue(item.origin, CONTEXT_ORIGINS, `${item.id}.origin`)
  enumValue(item.trust, CONTEXT_TRUST_LEVELS, `${item.id}.trust`)
  enumValue(item.instructionAuthority, INSTRUCTION_AUTHORITIES, `${item.id}.instructionAuthority`)
  enumValue(item.sensitivity, CONTEXT_SENSITIVITY_LEVELS, `${item.id}.sensitivity`)
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
  const sha256 = digestCanonicalJson(unsigned)
  return { ...unsigned, sha256 }
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
  if (expired(item.freshness.expiresAt, now) || expired(item.retention.expiresAt, now)) return false
  if (item.origin === 'memory') {
    if (!item.memory || item.memory.status !== 'active') return false
    if (expired(item.memory.expiresAt, now) || item.memory.tombstoneAt) return false
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
    if (Array.isArray(value)) return value.map((item, index) => canonicalize(item, seen, `${path}[${index}]`))
    const output: JsonObject = {}
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
  nonEmpty(memory.memoryId, `${id}.memory.memoryId`)
  integer(memory.revision, `${id}.memory.revision`)
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
  return Boolean(value && Date.parse(value) <= now.getTime())
}

function nonEmpty(value: string | undefined, path: string): void {
  if (!value?.trim()) invalid(`${path} must be a non-empty string.`)
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

function unique(values: string[], description: string): void {
  if (new Set(values).size !== values.length) invalid(`Duplicate ${description}.`)
}

function unsupported(name: string, version: unknown): never {
  throw new WebTaskContractError('UNSUPPORTED_SCHEMA_VERSION', `${name} schema version is unsupported: ${String(version)}`)
}

function invalid(message: string): never {
  throw new WebTaskContractError('INVALID_CONTRACT', message)
}
