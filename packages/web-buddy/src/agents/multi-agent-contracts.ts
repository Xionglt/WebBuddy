import { createHash } from 'node:crypto'
import type {
  ArtifactRef,
  ContentOrigin,
  ContentTrust,
  ContextItem,
  JsonObject,
  JsonValue,
  OwnerScope,
  SessionRef,
} from '../task/contracts.js'

export const MULTI_AGENT_ROLE_SCHEMA_VERSION = 'multi-agent-role/v1' as const
export const AGENT_ARTIFACT_CONTRACT_SCHEMA_VERSION = 'agent-artifact-contract/v1' as const
export const AGENT_CONTEXT_ENVELOPE_SCHEMA_VERSION = 'agent-context-envelope/v1' as const
export const AGENT_INVOCATION_RESULT_SCHEMA_VERSION = 'agent-invocation-result/v1' as const
export const AGENT_RESULT_NOTIFICATION_SCHEMA_VERSION = 'agent-result-notification/v1' as const

export type MultiAgentContractErrorCode =
  | 'INVALID_CONTRACT'
  | 'UNSUPPORTED_SCHEMA_VERSION'
  | 'AUTHORITY_VIOLATION'
  | 'CAPABILITY_VIOLATION'
  | 'BINDING_MISMATCH'
  | 'STALE_REVISION'
  | 'ARTIFACT_CONTRACT_VIOLATION'
  | 'BUDGET_EXCEEDED'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'IDEMPOTENCY_CONFLICT'

export class MultiAgentContractError extends Error {
  readonly code: MultiAgentContractErrorCode

  constructor(code: MultiAgentContractErrorCode, message: string) {
    super(message)
    this.name = 'MultiAgentContractError'
    this.code = code
  }
}

export type AgentAuthority = 'read_only' | 'recommend_only'

export type AgentCapability =
  | 'context.read'
  | 'artifact.read'
  | 'artifact.search'
  | 'plan.propose'
  | 'research.summarize'
  | 'comparison.propose'
  | 'form.plan'
  | 'safety.review'
  | 'evidence.assess'

export type AgentReadTool =
  | 'artifact_read_text'
  | 'artifact_read_json'
  | 'artifact_search_text'
  | 'artifact_list_refs'

export interface AgentArtifactContract {
  schemaVersion: typeof AGENT_ARTIFACT_CONTRACT_SCHEMA_VERSION
  contractId: string
  direction: 'input' | 'output'
  artifactKinds: string[]
  payloadSchemaVersions: string[]
  mediaTypes: string[]
  minCount: number
  maxCount: number
  immutableRequired: true
  freshness: 'current_run_revision'
  allowedOrigins?: ContentOrigin[]
  allowedTrust?: ContentTrust[]
  lineage?: 'none' | 'at_least_one_current_input'
  requiresMainWorkflowVerification: true
  authoritativeCompletionEvidence: false
}

export interface MultiAgentRole {
  schemaVersion: typeof MULTI_AGENT_ROLE_SCHEMA_VERSION
  id: string
  version: string
  capabilities: AgentCapability[]
  authority: AgentAuthority
  allowedTools: AgentReadTool[]
  inputArtifactContracts: AgentArtifactContract[]
  outputArtifactContracts: AgentArtifactContract[]
  livePageAccess: false
  browserWrite: false
  canResolveApproval: false
  canWriteMemory: false
  authoritativeCompletionEvidence: false
  requiresMainWorkflowVerification: true
}

export interface AgentInvocationBinding {
  schemaVersion: 'agent-invocation-binding/v1'
  invocationId: string
  taskId: string
  runId: string
  runRevision: number
  attempt: number
  parentActionSeq?: number
  sessionRef?: SessionRef
  ownerScope?: OwnerScope
}

export interface AgentExecutionBudget {
  schemaVersion: 'agent-execution-budget/v1'
  maxInputTokens: number
  maxOutputTokens: number
  maxTurns: number
  maxToolCalls: number
  timeoutMs: number
  deadlineAt: string
}

export interface AgentCancellationRequest {
  schemaVersion: 'agent-cancellation-request/v1'
  requestId: string
  requestedAt: string
  reason: 'user' | 'run_cancelled' | 'timeout' | 'superseded' | 'policy'
  runId: string
  runRevision: number
  attempt: number
  invocationId: string
}

export interface AgentContextEnvelope {
  schemaVersion: typeof AGENT_CONTEXT_ENVELOPE_SCHEMA_VERSION
  envelopeId: string
  role: MultiAgentRole
  binding: AgentInvocationBinding
  objective: ContextItem
  contextItems: ContextItem[]
  inputArtifacts: ArtifactRef[]
  allowedTools: AgentReadTool[]
  budget: AgentExecutionBudget
  createdAt: string
  expiresAt: string
  payloadDigest: string
  parentHistoryIncluded: false
  livePageIncluded: false
  browserWrite: false
  authoritativeCompletionEvidence: false
  requiresMainWorkflowVerification: true
}

export type SealAgentContextEnvelopeInput = Omit<AgentContextEnvelope, 'schemaVersion' | 'payloadDigest'>

interface AgentInvocationResultBase {
  schemaVersion: typeof AGENT_INVOCATION_RESULT_SCHEMA_VERSION
  resultId: string
  roleId: string
  roleVersion: string
  binding: AgentInvocationBinding
  startedAt: string
  finishedAt: string
  requiresMainWorkflowVerification: true
  authoritativeCompletionEvidence: false
}

export type AgentInvocationResult =
  | (AgentInvocationResultBase & {
      outcome: 'succeeded'
      outputArtifacts: ArtifactRef[]
      error?: never
      cancellationRequestId?: never
    })
  | (AgentInvocationResultBase & {
      outcome: 'failed'
      outputArtifacts: []
      error: { code: string; message: string; retryable: boolean }
      cancellationRequestId?: never
    })
  | (AgentInvocationResultBase & {
      outcome: 'cancelled'
      outputArtifacts: []
      error?: never
      cancellationRequestId: string
    })
  | (AgentInvocationResultBase & {
      outcome: 'timed_out'
      outputArtifacts: []
      error?: never
      cancellationRequestId?: never
    })

export interface AgentResultNotification {
  schemaVersion: typeof AGENT_RESULT_NOTIFICATION_SCHEMA_VERSION
  notificationId: string
  dedupeKey: string
  binding: AgentInvocationBinding
  resultId: string
  resultDigest: string
  createdAt: string
  requiresMainWorkflowVerification: true
  authoritativeCompletionEvidence: false
}

export type AgentNotificationAcceptance =
  | { status: 'accepted'; notificationId: string }
  | { status: 'duplicate'; notificationId: string }

/** Runtime-only cancellation transport. It must never enter a durable envelope. */
export interface AgentExecutionControl {
  readonly abortSignal: AbortSignal
}

export function sealAgentContextEnvelope(input: SealAgentContextEnvelopeInput): AgentContextEnvelope {
  closedObject(input, SEAL_INPUT_KEYS, 'SealAgentContextEnvelopeInput')
  assertJsonSafe(input)
  const unsigned = {
    schemaVersion: AGENT_CONTEXT_ENVELOPE_SCHEMA_VERSION,
    ...clone(input),
  }
  const envelope: AgentContextEnvelope = {
    ...unsigned,
    payloadDigest: multiAgentDigest(unsigned),
  }
  validateAgentContextEnvelope(envelope)
  return clone(envelope)
}

export function validateMultiAgentRole(role: MultiAgentRole): void {
  closedObject(role, ROLE_KEYS, 'MultiAgentRole')
  if (role.schemaVersion !== MULTI_AGENT_ROLE_SCHEMA_VERSION) unsupported('MultiAgentRole', role.schemaVersion)
  nonEmpty(role.id, 'role.id')
  nonEmpty(role.version, 'role.version')
  arrays(['role.capabilities', role.capabilities], ['role.allowedTools', role.allowedTools],
    ['role.inputArtifactContracts', role.inputArtifactContracts], ['role.outputArtifactContracts', role.outputArtifactContracts])
  if (role.authority !== 'read_only' && role.authority !== 'recommend_only') authority('Agent authority cannot write or decide.')
  if (role.livePageAccess !== false || role.browserWrite !== false || role.canResolveApproval !== false
    || role.canWriteMemory !== false || role.authoritativeCompletionEvidence !== false
    || role.requiresMainWorkflowVerification !== true) {
    authority('Role expands browser, approval, memory, or completion authority.')
  }
  if (!role.capabilities.length) capability('Role requires at least one bounded capability.')
  unique(role.capabilities, 'role.capabilities')
  unique(role.allowedTools, 'role.allowedTools')
  for (const capabilityName of role.capabilities) {
    if (!CAPABILITIES.has(capabilityName)) capability(`Unknown or write-capable capability: ${String(capabilityName)}`)
  }
  for (const tool of role.allowedTools) {
    if (!READ_TOOLS.has(tool)) capability(`Unknown or write-capable tool: ${String(tool)}`)
  }
  for (const contract of role.inputArtifactContracts) {
    validateArtifactContract(contract, 'input')
  }
  for (const contract of role.outputArtifactContracts) {
    validateArtifactContract(contract, 'output')
  }
  if (!role.outputArtifactContracts.length) invalid('Role requires an output Artifact Contract.')
  unique([...role.inputArtifactContracts, ...role.outputArtifactContracts].map((item) => item.contractId), 'Artifact Contract ids')
  assertJsonSafe(role)
}

export function validateAgentContextEnvelope(envelope: AgentContextEnvelope): void {
  closedObject(envelope, ENVELOPE_KEYS, 'AgentContextEnvelope')
  if (envelope.schemaVersion !== AGENT_CONTEXT_ENVELOPE_SCHEMA_VERSION) unsupported('AgentContextEnvelope', envelope.schemaVersion)
  nonEmpty(envelope.envelopeId, 'envelopeId')
  validateMultiAgentRole(envelope.role)
  validateInvocationBinding(envelope.binding)
  validateBudget(envelope.budget, envelope.createdAt)
  isoUtc(envelope.createdAt, 'createdAt')
  isoUtc(envelope.expiresAt, 'expiresAt')
  if (envelope.expiresAt !== envelope.budget.deadlineAt || envelope.expiresAt <= envelope.createdAt) {
    budget('Envelope expiry must equal its future budget deadline.')
  }
  if (envelope.parentHistoryIncluded !== false || envelope.livePageIncluded !== false
    || envelope.browserWrite !== false || envelope.authoritativeCompletionEvidence !== false
    || envelope.requiresMainWorkflowVerification !== true) {
    authority('Context Envelope includes live/browser/history/completion authority.')
  }
  arrays(['contextItems', envelope.contextItems], ['inputArtifacts', envelope.inputArtifacts], ['allowedTools', envelope.allowedTools])
  unique(envelope.contextItems.map((item) => item.id), 'context item ids')
  unique(envelope.inputArtifacts.map((item) => item.id), 'input Artifact ids')
  unique(envelope.allowedTools, 'allowedTools')
  for (const tool of envelope.allowedTools) {
    if (!READ_TOOLS.has(tool) || !envelope.role.allowedTools.includes(tool)) {
      capability(`Envelope tool ${String(tool)} is not allowed by the role.`)
    }
  }
  validateSubagentContextItem(envelope.objective, envelope.binding, 'objective')
  for (const item of envelope.contextItems) validateSubagentContextItem(item, envelope.binding, `contextItems.${item.id}`)
  validateArtifactsAgainstContracts(envelope.inputArtifacts, envelope.role.inputArtifactContracts, envelope.binding, 'input')
  const { payloadDigest: _ignored, ...unsigned } = envelope
  if (!SHA256.test(envelope.payloadDigest) || envelope.payloadDigest !== multiAgentDigest(unsigned)) {
    invalid('Context Envelope payloadDigest does not match canonical JSON.')
  }
  assertJsonSafe(envelope)
}

export function validateAgentInvocationResult(
  result: AgentInvocationResult,
  envelope: AgentContextEnvelope,
  cancellation?: AgentCancellationRequest,
): void {
  validateAgentContextEnvelope(envelope)
  closedObject(result, RESULT_KEYS_BY_OUTCOME[result.outcome] ?? [], 'AgentInvocationResult')
  if (result.schemaVersion !== AGENT_INVOCATION_RESULT_SCHEMA_VERSION) unsupported('AgentInvocationResult', result.schemaVersion)
  nonEmpty(result.resultId, 'resultId')
  if (result.roleId !== envelope.role.id || result.roleVersion !== envelope.role.version) {
    binding('Result role does not match the envelope role.')
  }
  validateInvocationBinding(result.binding)
  assertSameBinding(result.binding, envelope.binding)
  isoUtc(result.startedAt, 'startedAt')
  isoUtc(result.finishedAt, 'finishedAt')
  if (result.startedAt < envelope.createdAt || result.finishedAt < result.startedAt) invalid('Result timestamps are not monotonic.')
  if (result.requiresMainWorkflowVerification !== true || result.authoritativeCompletionEvidence !== false) {
    authority('Subagent result cannot become authoritative completion evidence.')
  }
  arrays(['outputArtifacts', result.outputArtifacts])
  if (result.finishedAt > envelope.budget.deadlineAt && result.outcome !== 'timed_out') {
    throw new MultiAgentContractError('TIMEOUT', 'A result completed after its deadline and cannot be accepted.')
  }
  if (cancellation) {
    validateCancellation(cancellation, envelope.binding)
    if (result.outcome !== 'cancelled' || result.cancellationRequestId !== cancellation.requestId) {
      throw new MultiAgentContractError('CANCELLED', 'A cancelled invocation cannot accept a later non-cancelled result.')
    }
  } else if (result.outcome === 'cancelled') {
    throw new MultiAgentContractError('CANCELLED', 'Cancelled result has no matching cancellation request.')
  }
  if (result.outcome === 'succeeded') {
    validateArtifactsAgainstContracts(
      result.outputArtifacts,
      envelope.role.outputArtifactContracts,
      envelope.binding,
      'output',
      envelope.role,
      envelope.inputArtifacts,
    )
  } else if (result.outputArtifacts.length !== 0) {
    artifactViolation('Non-success result cannot publish output Artifacts.')
  }
  assertJsonSafe(result)
}

export function acceptAgentResultNotification(
  notification: AgentResultNotification,
  result: AgentInvocationResult,
  envelope: AgentContextEnvelope,
  receipts: Map<string, string>,
  cancellation?: AgentCancellationRequest,
): AgentNotificationAcceptance {
  validateAgentInvocationResult(result, envelope, cancellation)
  closedObject(notification, NOTIFICATION_KEYS, 'AgentResultNotification')
  if (notification.schemaVersion !== AGENT_RESULT_NOTIFICATION_SCHEMA_VERSION) unsupported('AgentResultNotification', notification.schemaVersion)
  nonEmpty(notification.notificationId, 'notificationId')
  nonEmpty(notification.dedupeKey, 'dedupeKey')
  validateInvocationBinding(notification.binding)
  assertSameBinding(notification.binding, envelope.binding)
  if (notification.resultId !== result.resultId || notification.resultDigest !== multiAgentDigest(result)) {
    binding('Notification does not bind the exact result bytes.')
  }
  if (notification.requiresMainWorkflowVerification !== true || notification.authoritativeCompletionEvidence !== false) {
    authority('Notification cannot become completion evidence.')
  }
  isoUtc(notification.createdAt, 'notification.createdAt')
  const existing = receipts.get(notification.dedupeKey)
  const digest = multiAgentDigest(notification)
  if (existing) {
    if (existing !== digest) {
      throw new MultiAgentContractError('IDEMPOTENCY_CONFLICT', 'Notification dedupe key was replayed with different bytes.')
    }
    return { status: 'duplicate', notificationId: notification.notificationId }
  }
  receipts.set(notification.dedupeKey, digest)
  return { status: 'accepted', notificationId: notification.notificationId }
}

export function multiAgentDigest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

function validateArtifactContract(contract: AgentArtifactContract, direction: 'input' | 'output'): void {
  closedObject(contract, ARTIFACT_CONTRACT_KEYS, 'AgentArtifactContract')
  if (contract.schemaVersion !== AGENT_ARTIFACT_CONTRACT_SCHEMA_VERSION) unsupported('AgentArtifactContract', contract.schemaVersion)
  nonEmpty(contract.contractId, 'artifactContract.contractId')
  if (contract.direction !== direction) artifactViolation(`Expected ${direction} Artifact Contract.`)
  arrays(['artifactKinds', contract.artifactKinds], ['payloadSchemaVersions', contract.payloadSchemaVersions], ['mediaTypes', contract.mediaTypes])
  if (!contract.artifactKinds.length || !contract.payloadSchemaVersions.length || !contract.mediaTypes.length) {
    artifactViolation('Artifact Contract allowlists must be non-empty.')
  }
  unique(contract.artifactKinds, 'artifactKinds')
  unique(contract.payloadSchemaVersions, 'payloadSchemaVersions')
  unique(contract.mediaTypes, 'mediaTypes')
  if (contract.allowedOrigins !== undefined) {
    arrays(['allowedOrigins', contract.allowedOrigins])
    if (!contract.allowedOrigins.length) artifactViolation('Artifact Contract allowedOrigins must be non-empty when present.')
    unique(contract.allowedOrigins, 'allowedOrigins')
    for (const origin of contract.allowedOrigins) {
      if (!ARTIFACT_ORIGINS.has(origin)) artifactViolation(`Artifact Contract contains unsupported origin ${String(origin)}.`)
    }
  }
  if (contract.allowedTrust !== undefined) {
    arrays(['allowedTrust', contract.allowedTrust])
    if (!contract.allowedTrust.length) artifactViolation('Artifact Contract allowedTrust must be non-empty when present.')
    unique(contract.allowedTrust, 'allowedTrust')
    for (const trust of contract.allowedTrust) {
      if (!ARTIFACT_TRUST_LEVELS.has(trust)) artifactViolation(`Artifact Contract contains unsupported trust ${String(trust)}.`)
    }
  }
  if (contract.lineage !== undefined
    && contract.lineage !== 'none'
    && contract.lineage !== 'at_least_one_current_input') {
    artifactViolation(`Artifact Contract contains unsupported lineage policy ${String(contract.lineage)}.`)
  }
  integer(contract.minCount, 'minCount')
  positiveInteger(contract.maxCount, 'maxCount')
  if (contract.minCount > contract.maxCount) artifactViolation('Artifact Contract minCount exceeds maxCount.')
  if (contract.immutableRequired !== true || contract.freshness !== 'current_run_revision'
    || contract.requiresMainWorkflowVerification !== true || contract.authoritativeCompletionEvidence !== false) {
    artifactViolation('Artifact Contract weakens immutability, freshness, verification, or authority.')
  }
}

function validateArtifactsAgainstContracts(
  artifacts: ArtifactRef[],
  contracts: AgentArtifactContract[],
  bindingValue: AgentInvocationBinding,
  direction: 'input' | 'output',
  role?: MultiAgentRole,
  sourceArtifacts: readonly ArtifactRef[] = [],
): void {
  for (const artifact of artifacts) {
    const contract = contracts.find((candidate) => candidate.artifactKinds.includes(artifact.kind)
      && candidate.payloadSchemaVersions.includes(artifact.payloadSchemaVersion)
      && candidate.mediaTypes.includes(artifact.mediaType))
    if (!contract) artifactViolation(`Artifact ${artifact.id} is not allowed by a ${direction} contract.`)
    validateArtifactRefForAgent(artifact, contract, bindingValue, direction, role, sourceArtifacts)
  }
  for (const contract of contracts) {
    const count = artifacts.filter((artifact) => contract.artifactKinds.includes(artifact.kind)
      && contract.payloadSchemaVersions.includes(artifact.payloadSchemaVersion)
      && contract.mediaTypes.includes(artifact.mediaType)).length
    if (count < contract.minCount || count > contract.maxCount) {
      artifactViolation(`Artifact Contract ${contract.contractId} count ${count} is outside ${contract.minCount}..${contract.maxCount}.`)
    }
  }
}

function validateArtifactRefForAgent(
  artifact: ArtifactRef,
  contract: AgentArtifactContract,
  bindingValue: AgentInvocationBinding,
  direction: 'input' | 'output',
  role?: MultiAgentRole,
  sourceArtifacts: readonly ArtifactRef[] = [],
): void {
  closedObject(artifact, ARTIFACT_REF_KEYS, 'ArtifactRef')
  closedObject(artifact.producer, ARTIFACT_PRODUCER_KEYS, 'ArtifactRef.producer')
  closedObject(artifact.binding, ARTIFACT_BINDING_KEYS, 'ArtifactRef.binding')
  closedObject(artifact.retention, RETENTION_KEYS, 'ArtifactRef.retention')
  closedObject(artifact.redaction, REDACTION_KEYS, 'ArtifactRef.redaction')
  closedObject(artifact.scanner, SCANNER_KEYS, 'ArtifactRef.scanner')
  if (artifact.ownerScope !== undefined) validateOwnerScope(artifact.ownerScope, 'ArtifactRef.ownerScope')
  if (artifact.binding.sessionRef !== undefined) {
    validateSessionRef(artifact.binding.sessionRef, `${artifact.id}.binding.sessionRef`)
  }
  if (artifact.schemaVersion !== 'artifact-ref/v1') unsupported('ArtifactRef', artifact.schemaVersion)
  if (artifact.binding.runId !== bindingValue.runId) binding(`Artifact ${artifact.id} belongs to a foreign run.`)
  if (artifact.binding.revision !== bindingValue.runRevision) {
    throw new MultiAgentContractError('STALE_REVISION', `Artifact ${artifact.id} is not current for run revision ${bindingValue.runRevision}.`)
  }
  if (!sameOptionalJson(artifact.binding.sessionRef, bindingValue.sessionRef)) {
    binding(`Artifact ${artifact.id} session does not match the invocation.`)
  }
  if (artifact.binding.actionSeq !== bindingValue.parentActionSeq) {
    binding(`Artifact ${artifact.id} action epoch does not match the invocation.`)
  }
  nonEmpty(artifact.id, 'artifact.id')
  nonEmpty(artifact.kind, `${artifact.id}.kind`)
  nonEmpty(artifact.payloadSchemaVersion, `${artifact.id}.payloadSchemaVersion`)
  nonEmpty(artifact.mediaType, `${artifact.id}.mediaType`)
  nonEmpty(artifact.locator, `${artifact.id}.locator`)
  nonEmpty(artifact.producer.id, `${artifact.id}.producer.id`)
  nonEmpty(artifact.producer.version, `${artifact.id}.producer.version`)
  integer(artifact.byteLength, `${artifact.id}.byteLength`)
  isoUtc(artifact.createdAt, `${artifact.id}.createdAt`)
  if (!RETENTION_SCOPES.has(artifact.retention.scope)) {
    artifactViolation(`Artifact ${artifact.id} has unsupported retention scope ${String(artifact.retention.scope)}.`)
  }
  if (artifact.retention.expiresAt !== undefined) {
    isoUtc(artifact.retention.expiresAt, `${artifact.id}.retention.expiresAt`)
  }
  if (typeof artifact.retention.deleteWithSession !== 'boolean') {
    invalid(`${artifact.id}.retention.deleteWithSession must be boolean.`)
  }
  if (artifact.retention.audience !== undefined) {
    arrays([`${artifact.id}.retention.audience`, artifact.retention.audience])
    for (const audience of artifact.retention.audience) nonEmpty(audience, `${artifact.id}.retention.audience`)
    unique(artifact.retention.audience, `${artifact.id}.retention.audience`)
  }
  if (!REDACTION_STATUSES.has(artifact.redaction.status)) {
    artifactViolation(`Artifact ${artifact.id} has unsupported redaction status ${String(artifact.redaction.status)}.`)
  }
  nonEmpty(artifact.redaction.policyId, `${artifact.id}.redaction.policyId`)
  if (!SCANNER_STATUSES.has(artifact.scanner.status)) {
    artifactViolation(`Artifact ${artifact.id} has unsupported scanner status ${String(artifact.scanner.status)}.`)
  }
  nonEmpty(artifact.scanner.scannerId, `${artifact.id}.scanner.scannerId`)
  if (typeof artifact.requiresMainWorkflowVerification !== 'boolean'
    || typeof artifact.authoritativeCompletionEvidence !== 'boolean') {
    invalid(`Artifact ${artifact.id} verification flags must be boolean.`)
  }
  arrays(
    [`${artifact.id}.parentEvidenceIds`, artifact.parentEvidenceIds],
    [`${artifact.id}.parentArtifactIds`, artifact.parentArtifactIds],
  )
  for (const parentId of [...artifact.parentEvidenceIds, ...artifact.parentArtifactIds]) {
    nonEmpty(parentId, `${artifact.id}.parentId`)
  }
  unique(artifact.parentEvidenceIds, `${artifact.id}.parentEvidenceIds`)
  unique(artifact.parentArtifactIds, `${artifact.id}.parentArtifactIds`)
  if (artifact.parentArtifactIds.includes(artifact.id)) {
    artifactViolation(`Artifact ${artifact.id} cannot list itself as a parent.`)
  }
  if (!ARTIFACT_ORIGINS.has(artifact.origin)
    || !ARTIFACT_TRUST_LEVELS.has(artifact.trust)
    || !ARTIFACT_SENSITIVITY_LEVELS.has(artifact.sensitivity)) {
    artifactViolation(`Artifact ${artifact.id} has unknown security metadata.`)
  }
  if (!artifact.immutable || !SHA256.test(artifact.sha256)) artifactViolation(`Artifact ${artifact.id} is not immutable/integrity-addressed.`)
  if (isAbsoluteLocator(artifact.locator)) artifactViolation(`Artifact ${artifact.id} exposes an absolute locator.`)
  if (!sameOptionalJson(artifact.ownerScope, bindingValue.ownerScope)) binding(`Artifact ${artifact.id} owner scope does not match.`)
  const allowedOrigins = contract.allowedOrigins ?? DEFAULT_ARTIFACT_ORIGINS[direction]
  const allowedTrust = contract.allowedTrust ?? DEFAULT_ARTIFACT_TRUST[direction]
  if (!allowedOrigins.includes(artifact.origin)) {
    authority(`Artifact ${artifact.id} origin ${artifact.origin} is outside contract ${contract.contractId}.`)
  }
  if (!allowedTrust.includes(artifact.trust)) {
    authority(`Artifact ${artifact.id} trust ${artifact.trust} is outside contract ${contract.contractId}.`)
  }
  if (artifact.origin === 'subagent'
    && (artifact.trust !== 'non_authoritative'
      || artifact.requiresMainWorkflowVerification !== true
      || artifact.authoritativeCompletionEvidence !== false)) {
    authority(`Artifact ${artifact.id} attempts to expand subagent authority.`)
  }
  if (direction === 'input'
    && (artifact.origin === 'system' || artifact.origin === 'user' || !EXTERNAL_TRUST.has(artifact.trust))) {
    authority(`Input Artifact ${artifact.id} attempts to assert trusted instruction provenance.`)
  }
  if (direction === 'output') {
    if (!role || artifact.producer.id !== role.id || artifact.producer.version !== role.version) {
      binding(`Output Artifact ${artifact.id} producer does not match the invoked role.`)
    }
    if (artifact.origin !== 'subagent' || artifact.trust !== 'non_authoritative'
      || artifact.requiresMainWorkflowVerification !== true || artifact.authoritativeCompletionEvidence !== false) {
      authority(`Output Artifact ${artifact.id} attempts to expand subagent authority.`)
    }
    const sourceIds = new Set(sourceArtifacts.map((source) => source.id))
    const lineage = contract.lineage ?? 'at_least_one_current_input'
    if (lineage === 'at_least_one_current_input'
      && (artifact.parentArtifactIds.length === 0
        || artifact.parentArtifactIds.some((parentId) => !sourceIds.has(parentId)))) {
      artifactViolation(`Output Artifact ${artifact.id} does not retain current sealed-input lineage.`)
    }
  }
}

function validateSubagentContextItem(
  item: ContextItem,
  bindingValue: AgentInvocationBinding,
  path: string,
): void {
  if (item.schemaVersion !== 'context-item/v1') unsupported('ContextItem', item.schemaVersion)
  nonEmpty(item.id, `${path}.id`)
  if (item.sensitivity === 'secret' || item.sensitivity === 'auth') authority(`${path} cannot expose secret/auth content to a subagent.`)
  if (item.instructionAuthority === 'system_policy' || item.instructionAuthority === 'user_goal') {
    authority(`${path} cannot delegate instruction authority to a subagent.`)
  }
  if (!item.allowedUses.includes('subagent')) authority(`${path} is not allowed for subagent use.`)
  if (item.provenance.runId && item.provenance.runId !== bindingValue.runId) {
    binding(`${path} provenance belongs to a foreign run.`)
  }
  if (item.freshness.validity !== 'current' || item.freshness.revision !== bindingValue.runRevision) {
    throw new MultiAgentContractError('STALE_REVISION', `${path} is not current for run revision ${bindingValue.runRevision}.`)
  }
  if (item.origin === 'subagent' && item.trust !== 'non_authoritative') authority(`${path} subagent origin must remain non_authoritative.`)
  if (EXTERNAL_ORIGINS.has(item.origin) && !EXTERNAL_TRUST.has(item.trust)) {
    authority(`${path} external content attempts a trust upgrade.`)
  }
  assertJsonSafe(item)
}

function validateInvocationBinding(bindingValue: AgentInvocationBinding): void {
  closedObject(bindingValue, BINDING_KEYS, 'AgentInvocationBinding')
  if (bindingValue.schemaVersion !== 'agent-invocation-binding/v1') unsupported('AgentInvocationBinding', bindingValue.schemaVersion)
  nonEmpty(bindingValue.invocationId, 'binding.invocationId')
  nonEmpty(bindingValue.taskId, 'binding.taskId')
  nonEmpty(bindingValue.runId, 'binding.runId')
  integer(bindingValue.runRevision, 'binding.runRevision')
  positiveInteger(bindingValue.attempt, 'binding.attempt')
  if (bindingValue.parentActionSeq !== undefined) integer(bindingValue.parentActionSeq, 'binding.parentActionSeq')
  if (bindingValue.sessionRef) {
    validateSessionRef(bindingValue.sessionRef, 'binding.sessionRef')
    if (bindingValue.sessionRef.schemaVersion !== 'session-ref/v1'
      || bindingValue.sessionRef.runId !== bindingValue.runId
      || bindingValue.sessionRef.attempt !== bindingValue.attempt) {
      binding('SessionRef does not match invocation run/attempt.')
    }
  }
  if (bindingValue.ownerScope !== undefined) validateOwnerScope(bindingValue.ownerScope, 'binding.ownerScope')
  assertJsonSafe(bindingValue)
}

function validateSessionRef(value: SessionRef, path: string): void {
  closedObject(value, SESSION_REF_KEYS, path)
  if (value.schemaVersion !== 'session-ref/v1') unsupported('SessionRef', value.schemaVersion)
  nonEmpty(value.provider, `${path}.provider`)
  nonEmpty(value.id, `${path}.id`)
  nonEmpty(value.runId, `${path}.runId`)
  positiveInteger(value.attempt, `${path}.attempt`)
  if (value.checkpointRef !== undefined) {
    closedObject(value.checkpointRef, CHECKPOINT_REF_KEYS, `${path}.checkpointRef`)
    if (value.checkpointRef.schemaVersion !== 'checkpoint-ref/v1') {
      unsupported('CheckpointRef', value.checkpointRef.schemaVersion)
    }
    nonEmpty(value.checkpointRef.provider, `${path}.checkpointRef.provider`)
    nonEmpty(value.checkpointRef.id, `${path}.checkpointRef.id`)
  }
}

function validateOwnerScope(value: OwnerScope, path: string): void {
  closedObject(value, OWNER_SCOPE_KEYS, path)
  if (value.schemaVersion !== 'owner-scope/v1') unsupported('OwnerScope', value.schemaVersion)
  if (value.tenantId !== undefined) nonEmpty(value.tenantId, `${path}.tenantId`)
  if (value.userId !== undefined) nonEmpty(value.userId, `${path}.userId`)
  if (value.projectId !== undefined) nonEmpty(value.projectId, `${path}.projectId`)
}

function validateBudget(value: AgentExecutionBudget, createdAt: string): void {
  closedObject(value, BUDGET_KEYS, 'AgentExecutionBudget')
  if (value.schemaVersion !== 'agent-execution-budget/v1') unsupported('AgentExecutionBudget', value.schemaVersion)
  positiveInteger(value.maxInputTokens, 'budget.maxInputTokens')
  positiveInteger(value.maxOutputTokens, 'budget.maxOutputTokens')
  positiveInteger(value.maxTurns, 'budget.maxTurns')
  integer(value.maxToolCalls, 'budget.maxToolCalls')
  positiveInteger(value.timeoutMs, 'budget.timeoutMs')
  isoUtc(createdAt, 'createdAt')
  isoUtc(value.deadlineAt, 'budget.deadlineAt')
  const duration = Date.parse(value.deadlineAt) - Date.parse(createdAt)
  if (duration <= 0 || duration > value.timeoutMs) budget('Budget deadline exceeds timeoutMs or is not in the future.')
}

function validateCancellation(value: AgentCancellationRequest, bindingValue: AgentInvocationBinding): void {
  closedObject(value, CANCELLATION_KEYS, 'AgentCancellationRequest')
  if (value.schemaVersion !== 'agent-cancellation-request/v1') unsupported('AgentCancellationRequest', value.schemaVersion)
  nonEmpty(value.requestId, 'cancellation.requestId')
  isoUtc(value.requestedAt, 'cancellation.requestedAt')
  if (value.runId !== bindingValue.runId || value.runRevision !== bindingValue.runRevision
    || value.attempt !== bindingValue.attempt || value.invocationId !== bindingValue.invocationId) {
    binding('Cancellation request does not match invocation run/revision/attempt.')
  }
}

function assertSameBinding(left: AgentInvocationBinding, right: AgentInvocationBinding): void {
  if (multiAgentDigest(left) !== multiAgentDigest(right)) binding('Invocation binding changed or is stale.')
}

function closedObject(value: unknown, allowedKeys: readonly string[], label: string): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`${label} must be an object.`)
  const keys = Object.keys(value as object)
  const unknown = keys.find((key) => !allowedKeys.includes(key))
  if (unknown) invalid(`${label} contains forbidden field ${unknown}.`)
}

function assertJsonSafe(value: unknown): void {
  canonicalize(value, new WeakSet<object>(), '$')
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value, new WeakSet<object>(), '$'))
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
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) invalid(`${path} contains a non-plain object.`)
    const output = Object.create(null) as JsonObject
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const nested = (value as Record<string, unknown>)[key]
      if (nested === undefined) invalid(`${path}.${key} is undefined; omit it.`)
      output[key] = canonicalize(nested, seen, `${path}.${key}`)
    }
    return output
  } finally {
    seen.delete(object)
  }
}

function clone<T>(value: T): T { return structuredClone(value) }

function sameOptionalJson(left: unknown, right: unknown): boolean {
  if (left === undefined || right === undefined) return left === right
  return multiAgentDigest(left) === multiAgentDigest(right)
}

function arrays(...entries: Array<readonly [string, unknown]>): void {
  for (const [path, value] of entries) if (!Array.isArray(value)) invalid(`${path} must be an array.`)
}

function unique(values: readonly string[], path: string): void {
  if (new Set(values).size !== values.length) invalid(`${path} must not contain duplicates.`)
}

function nonEmpty(value: unknown, path: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) invalid(`${path} must be a non-empty string.`)
}

function integer(value: unknown, path: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) invalid(`${path} must be a non-negative safe integer.`)
}

function positiveInteger(value: unknown, path: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) invalid(`${path} must be a positive safe integer.`)
}

function isoUtc(value: unknown, path: string): asserts value is string {
  if (typeof value !== 'string') invalid(`${path} must be canonical ISO UTC.`)
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) invalid(`${path} must be canonical ISO UTC with milliseconds.`)
}

function isAbsoluteLocator(value: string): boolean { return /^(?:file:|\/|[A-Za-z]:[\\/])/.test(value) }
function unsupported(kind: string, version: unknown): never { throw new MultiAgentContractError('UNSUPPORTED_SCHEMA_VERSION', `${kind} schema is unsupported: ${String(version)}`) }
function invalid(message: string): never { throw new MultiAgentContractError('INVALID_CONTRACT', message) }
function authority(message: string): never { throw new MultiAgentContractError('AUTHORITY_VIOLATION', message) }
function capability(message: string): never { throw new MultiAgentContractError('CAPABILITY_VIOLATION', message) }
function binding(message: string): never { throw new MultiAgentContractError('BINDING_MISMATCH', message) }
function artifactViolation(message: string): never { throw new MultiAgentContractError('ARTIFACT_CONTRACT_VIOLATION', message) }
function budget(message: string): never { throw new MultiAgentContractError('BUDGET_EXCEEDED', message) }

const SHA256 = /^[a-f0-9]{64}$/i
const CAPABILITIES = new Set<AgentCapability>(['context.read', 'artifact.read', 'artifact.search', 'plan.propose', 'research.summarize', 'comparison.propose', 'form.plan', 'safety.review', 'evidence.assess'])
const READ_TOOLS = new Set<AgentReadTool>(['artifact_read_text', 'artifact_read_json', 'artifact_search_text', 'artifact_list_refs'])
const EXTERNAL_ORIGINS = new Set(['web', 'tool', 'download', 'memory', 'subagent', 'artifact', 'derived'])
const EXTERNAL_TRUST = new Set(['untrusted_external', 'derived_untrusted', 'non_authoritative'])
const ARTIFACT_ORIGINS = new Set(['system', 'user', 'web', 'tool', 'download', 'artifact', 'memory', 'subagent', 'derived'])
const ARTIFACT_TRUST_LEVELS = new Set(['trusted_runtime', 'user_authorized', 'untrusted_external', 'derived_untrusted', 'non_authoritative'])
const ARTIFACT_SENSITIVITY_LEVELS = new Set(['public', 'internal', 'personal', 'auth', 'secret'])
const RETENTION_SCOPES = new Set(['turn', 'run', 'session', 'project'])
const REDACTION_STATUSES = new Set(['not_required', 'redacted', 'rejected'])
const SCANNER_STATUSES = new Set(['clean', 'quarantined', 'rejected', 'not_scanned'])
const DEFAULT_ARTIFACT_ORIGINS: Record<'input' | 'output', ContentOrigin[]> = {
  input: ['web', 'tool', 'download', 'artifact', 'memory', 'subagent', 'derived'],
  output: ['subagent'],
}
const DEFAULT_ARTIFACT_TRUST: Record<'input' | 'output', ContentTrust[]> = {
  input: ['untrusted_external', 'derived_untrusted', 'non_authoritative'],
  output: ['non_authoritative'],
}
const ROLE_KEYS = ['schemaVersion', 'id', 'version', 'capabilities', 'authority', 'allowedTools', 'inputArtifactContracts', 'outputArtifactContracts', 'livePageAccess', 'browserWrite', 'canResolveApproval', 'canWriteMemory', 'authoritativeCompletionEvidence', 'requiresMainWorkflowVerification']
const ARTIFACT_CONTRACT_KEYS = ['schemaVersion', 'contractId', 'direction', 'artifactKinds', 'payloadSchemaVersions', 'mediaTypes', 'minCount', 'maxCount', 'immutableRequired', 'freshness', 'allowedOrigins', 'allowedTrust', 'lineage', 'requiresMainWorkflowVerification', 'authoritativeCompletionEvidence']
const ARTIFACT_REF_KEYS = ['schemaVersion', 'id', 'kind', 'payloadSchemaVersion', 'mediaType', 'byteLength', 'sha256', 'createdAt', 'immutable', 'locator', 'producer', 'parentEvidenceIds', 'parentArtifactIds', 'origin', 'trust', 'sensitivity', 'retention', 'ownerScope', 'binding', 'requiresMainWorkflowVerification', 'authoritativeCompletionEvidence', 'redaction', 'scanner']
const ARTIFACT_PRODUCER_KEYS = ['id', 'version']
const ARTIFACT_BINDING_KEYS = ['runId', 'revision', 'sessionRef', 'actionSeq']
const RETENTION_KEYS = ['scope', 'expiresAt', 'deleteWithSession', 'audience']
const REDACTION_KEYS = ['status', 'policyId']
const SCANNER_KEYS = ['status', 'scannerId']
const SESSION_REF_KEYS = ['schemaVersion', 'provider', 'id', 'runId', 'attempt', 'checkpointRef']
const CHECKPOINT_REF_KEYS = ['schemaVersion', 'provider', 'id']
const OWNER_SCOPE_KEYS = ['schemaVersion', 'tenantId', 'userId', 'projectId']
const BINDING_KEYS = ['schemaVersion', 'invocationId', 'taskId', 'runId', 'runRevision', 'attempt', 'parentActionSeq', 'sessionRef', 'ownerScope']
const BUDGET_KEYS = ['schemaVersion', 'maxInputTokens', 'maxOutputTokens', 'maxTurns', 'maxToolCalls', 'timeoutMs', 'deadlineAt']
const CANCELLATION_KEYS = ['schemaVersion', 'requestId', 'requestedAt', 'reason', 'runId', 'runRevision', 'attempt', 'invocationId']
const ENVELOPE_KEYS = ['schemaVersion', 'envelopeId', 'role', 'binding', 'objective', 'contextItems', 'inputArtifacts', 'allowedTools', 'budget', 'createdAt', 'expiresAt', 'payloadDigest', 'parentHistoryIncluded', 'livePageIncluded', 'browserWrite', 'authoritativeCompletionEvidence', 'requiresMainWorkflowVerification']
const SEAL_INPUT_KEYS = ENVELOPE_KEYS.filter((key) => key !== 'schemaVersion' && key !== 'payloadDigest')
const RESULT_BASE_KEYS = ['schemaVersion', 'resultId', 'roleId', 'roleVersion', 'binding', 'startedAt', 'finishedAt', 'outcome', 'outputArtifacts', 'requiresMainWorkflowVerification', 'authoritativeCompletionEvidence']
const RESULT_KEYS_BY_OUTCOME: Record<string, string[]> = {
  succeeded: RESULT_BASE_KEYS,
  failed: [...RESULT_BASE_KEYS, 'error'],
  cancelled: [...RESULT_BASE_KEYS, 'cancellationRequestId'],
  timed_out: RESULT_BASE_KEYS,
}
const NOTIFICATION_KEYS = ['schemaVersion', 'notificationId', 'dedupeKey', 'binding', 'resultId', 'resultDigest', 'createdAt', 'requiresMainWorkflowVerification', 'authoritativeCompletionEvidence']
