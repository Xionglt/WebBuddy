import { createHash } from 'node:crypto'
import type {
  ActionBinding,
  AgentTaskKind,
  CatalogSensitivity,
  ContextCatalogManifestV1,
  ContextUnit,
  ImmutableArtifactKind,
  ImmutableArtifactRef,
  JsonValue,
  OmittedContextReason,
  ReadOnlyArtifactToolName,
  ReadOnlyLlmTaskKind,
  SanitizedTextProjectionV1,
} from './async-task-contracts.js'
import {
  multiAgentDigest,
  validateMultiAgentRole,
  type MultiAgentRole,
} from './multi-agent-contracts.js'

export type ContextOriginKind = 'tool' | 'skill' | 'mcp' | 'trace' | 'memory' | 'workflow'

export type ContextRetention =
  | 'task_contract'
  | 'task_input'
  | 'structured_state'
  | 'output_contract'
  | 'safety_policy'
  | 'causal_slice'
  | 'optional'

export type ContextPolicySafeDetailCode =
  | 'LIVE_CAPABILITY_FORBIDDEN'
  | 'FULL_HISTORY_FORBIDDEN'
  | 'SECRET_CONTEXT_SELECTED'
  | 'SENSITIVE_CONTEXT_NOT_AUTHORIZED'
  | 'INCOMPLETE_TOOL_EXCHANGE'
  | 'INVALID_ARTIFACT_REF'
  | 'BUDGET_EXCEEDED'
  | 'INVALID_SOURCE_ACTION_SEQ'
  | 'MISSING_REQUIRED_CONTEXT'
  | 'DUPLICATE_CONTEXT_ID'

export class ContextContractViolation extends Error {
  readonly code: 'CONTEXT_POLICY_VIOLATION' | 'ARTIFACT_INTEGRITY_FAILED'
  readonly safeDetailCode: ContextPolicySafeDetailCode

  constructor(
    code: 'CONTEXT_POLICY_VIOLATION' | 'ARTIFACT_INTEGRITY_FAILED',
    safeDetailCode: ContextPolicySafeDetailCode,
    message: string,
  ) {
    super(message)
    this.name = 'ContextContractViolation'
    this.code = code
    this.safeDetailCode = safeDetailCode
  }
}

export interface ToolContextProvenance {
  kind: 'tool'
  toolName: ReadOnlyArtifactToolName
  toolCallId: string
  callArtifactRef?: ImmutableArtifactRef<'tool_call'>
  resultArtifactRef?: ImmutableArtifactRef<'tool_result'>
}

export interface SkillContextProvenance {
  kind: 'skill'
  packageName: string
  skillName: string
  skillVersion: string
  invocationId: string
  resultArtifactRef: ImmutableArtifactRef
}

export interface McpContextProvenance {
  kind: 'mcp'
  server: string
  operationKind: 'method' | 'resource'
  operation: string
  requestId: string
  resultArtifactRef: ImmutableArtifactRef
}

export interface TraceContextProvenance {
  kind: 'trace'
  traceId: string
  artifactRef: ImmutableArtifactRef<'trace'>
}

export interface MemoryContextProvenance {
  kind: 'memory'
  namespace: string
  recordId: string
  recordVersion: string
  artifactRef: ImmutableArtifactRef<'memory'>
}

export interface WorkflowContextProvenance {
  kind: 'workflow'
  workflowId: string
  workflowRunId: string
  stateRevision: number
  evidenceRefs: ImmutableArtifactRef[]
  actionBinding: ActionBinding
}

export type ContextProvenance =
  | ToolContextProvenance
  | SkillContextProvenance
  | McpContextProvenance
  | TraceContextProvenance
  | MemoryContextProvenance
  | WorkflowContextProvenance

export type DeniedCatalogReason = Extract<
  OmittedContextReason,
  | 'capability_denied'
  | 'live_page_denied'
  | 'full_history_denied'
  | 'mutable_ref_denied'
  | 'incomplete_tool_exchange'
>

export type ContextCatalogContentInput =
  | { kind: 'context_unit'; unit: ContextUnit }
  | { kind: 'denied'; reason: DeniedCatalogReason }

export interface ContextCatalogItemInput {
  provenance: ContextProvenance
  sensitivity: CatalogSensitivity
  allowedTaskKinds: readonly AgentTaskKind[]
  tokenEstimate: number
  retention: ContextRetention
  actionBinding: ActionBinding
  relevanceTerms?: readonly string[]
  maxActionLag?: number
  allowStale?: boolean
  content: ContextCatalogContentInput
}

interface ContextCatalogItemBase {
  id: string
  originKind: ContextOriginKind
  provenance: ContextProvenance
  provenanceDigest: string
  sensitivity: CatalogSensitivity
  allowedTaskKinds: AgentTaskKind[]
  tokenEstimate: number
  retention: ContextRetention
  actionBinding: ActionBinding
  relevanceTerms: string[]
  maxActionLag: number
  allowStale: boolean
}

export type ContextCatalogItem =
  | (ContextCatalogItemBase & { availability: 'selectable'; unit: ContextUnit })
  | (ContextCatalogItemBase & { availability: 'denied'; deniedReason: DeniedCatalogReason; unit?: never })

export interface ContextCatalogV1 {
  schemaVersion: 'context-catalog/v1'
  parentRunId: string
  parentSessionId: string
  catalogRevision: number
  items: ContextCatalogItem[]
  manifest: ContextCatalogManifestV1
}

export interface CreateContextCatalogInput {
  parentRunId: string
  parentSessionId: string
  catalogRevision: number
  candidates: readonly ContextCatalogItemInput[]
}

export interface RoleScopedContextCatalogV1 {
  schemaVersion: 'role-scoped-context-catalog/v1'
  roleId: string
  roleVersion: string
  roleDigest: string
  runtimeTaskKind: ReadOnlyLlmTaskKind
  catalog: ContextCatalogV1
}

export interface CreateRoleScopedContextCatalogInput extends CreateContextCatalogInput {
  role: MultiAgentRole
  runtimeTaskKind: ReadOnlyLlmTaskKind
}

const TASK_KINDS: readonly AgentTaskKind[] = [
  'main_browser_step',
  'candidate_job_research',
  'trace_summarization',
  'memory_retrieval',
  'workflow_evaluation',
  'delivery_probe',
]

const READ_ONLY_TOOLS: readonly ReadOnlyArtifactToolName[] = [
  'artifact_read_text',
  'artifact_read_json',
  'artifact_search_text',
  'artifact_list_refs',
]

const ARTIFACT_KINDS: readonly ImmutableArtifactKind[] = [
  'trace',
  'page_snapshot',
  'memory',
  'tool_call',
  'tool_result',
  'runner_result',
  'sidechain_transcript',
  'context_envelope',
  'task_graph_checkpoint',
  'schema',
  'plan_proposal',
  'research_report',
  'comparison_report',
  'form_field_plan',
  'safety_verdict',
  'evidence_assessment',
]

const RETENTION_KINDS: readonly ContextRetention[] = [
  'task_contract',
  'task_input',
  'structured_state',
  'output_contract',
  'safety_policy',
  'causal_slice',
  'optional',
]

const DENIED_REASONS: readonly DeniedCatalogReason[] = [
  'capability_denied',
  'live_page_denied',
  'full_history_denied',
  'mutable_ref_denied',
  'incomplete_tool_exchange',
]

const SHA256_PATTERN = /^[a-f0-9]{64}$/
const REACT_HISTORY_PATTERN = /"role"\s*:\s*"(assistant|tool|user)"|tool_calls|chain.of.thought/i

export function createContextCatalog(input: CreateContextCatalogInput): ContextCatalogV1 {
  assertExactKeys(input, ['parentRunId', 'parentSessionId', 'catalogRevision', 'candidates'], 'MISSING_REQUIRED_CONTEXT')
  requireNonEmptyString(input.parentRunId, 'parentRunId')
  requireNonEmptyString(input.parentSessionId, 'parentSessionId')
  requireNonNegativeInteger(input.catalogRevision, 'catalogRevision', 'MISSING_REQUIRED_CONTEXT')
  if (!Array.isArray(input.candidates)) {
    throw policyViolation('MISSING_REQUIRED_CONTEXT', 'Context catalog candidates must be an array.')
  }

  const items = input.candidates.map(createContextCatalogItem).sort((left, right) => left.id.localeCompare(right.id))
  const seen = new Set<string>()
  for (const item of items) {
    if (seen.has(item.id)) {
      throw policyViolation('DUPLICATE_CONTEXT_ID', `Duplicate context candidate ${item.id}.`)
    }
    seen.add(item.id)
    for (const ref of artifactRefsForCatalogItem(item)) {
      assertArtifactOwnership(ref, input.parentRunId, input.parentSessionId)
    }
  }

  const candidateItemIds = items.map((item) => item.id)
  const manifest: ContextCatalogManifestV1 = {
    schemaVersion: 'context-catalog-manifest/v1',
    catalogRevision: input.catalogRevision,
    catalogDigest: sha256Hex(JSON.stringify(candidateItemIds)),
    canonicalization: 'context-catalog-item-ids-jcs/v1',
    candidateItemIds,
    candidateCount: candidateItemIds.length,
  }
  return {
    schemaVersion: 'context-catalog/v1',
    parentRunId: input.parentRunId,
    parentSessionId: input.parentSessionId,
    catalogRevision: input.catalogRevision,
    items,
    manifest,
  }
}

/**
 * Produces an auditable role view without adding live Page or parent history.
 * Candidates not admitted for the compatibility task kind remain represented
 * as capability-denied entries instead of disappearing from the manifest.
 */
export function createRoleScopedContextCatalog(
  input: CreateRoleScopedContextCatalogInput,
): RoleScopedContextCatalogV1 {
  validateMultiAgentRole(input.role)
  if (input.runtimeTaskKind !== 'candidate_job_research' && input.runtimeTaskKind !== 'trace_summarization') {
    throw policyViolation('LIVE_CAPABILITY_FORBIDDEN', 'Built-in roles must use the read-only LLM task runtime.')
  }
  if (input.role.browserWrite !== false || input.role.livePageAccess !== false
    || input.role.canResolveApproval !== false || input.role.canWriteMemory !== false
    || input.role.authoritativeCompletionEvidence !== false
    || input.role.requiresMainWorkflowVerification !== true) {
    throw policyViolation('LIVE_CAPABILITY_FORBIDDEN', `Role ${input.role.id} expands Main Agent authority.`)
  }

  const candidates = input.candidates.map((candidate): ContextCatalogItemInput => ({
    ...candidate,
    allowedTaskKinds: [input.runtimeTaskKind],
    content: candidate.allowedTaskKinds.includes(input.runtimeTaskKind)
      ? candidate.content
      : { kind: 'denied', reason: 'capability_denied' },
  }))
  const catalog = createContextCatalog({
    parentRunId: input.parentRunId,
    parentSessionId: input.parentSessionId,
    catalogRevision: input.catalogRevision,
    candidates,
  })
  return {
    schemaVersion: 'role-scoped-context-catalog/v1',
    roleId: input.role.id,
    roleVersion: input.role.version,
    roleDigest: multiAgentDigest(input.role),
    runtimeTaskKind: input.runtimeTaskKind,
    catalog,
  }
}

export function createContextCatalogItem(input: ContextCatalogItemInput): ContextCatalogItem {
  assertExactKeys(
    input,
    [
      'provenance',
      'sensitivity',
      'allowedTaskKinds',
      'tokenEstimate',
      'retention',
      'actionBinding',
      'relevanceTerms',
      'maxActionLag',
      'allowStale',
      'content',
    ],
    'MISSING_REQUIRED_CONTEXT',
    'CONTEXT_POLICY_VIOLATION',
    false,
  )
  const provenance = normalizeContextProvenance(input.provenance)
  const sensitivity = normalizeSensitivity(input.sensitivity)
  const allowedTaskKinds = normalizeTaskKinds(input.allowedTaskKinds)
  requireNonNegativeInteger(input.tokenEstimate, 'tokenEstimate', 'BUDGET_EXCEEDED')
  if (!RETENTION_KINDS.includes(input.retention)) {
    throw policyViolation('MISSING_REQUIRED_CONTEXT', 'Context retention classification is invalid.')
  }
  const actionBinding = normalizeActionBinding(input.actionBinding)
  const relevanceTerms = normalizeRelevanceTerms(input.relevanceTerms ?? [])
  const maxActionLag = input.maxActionLag ?? 0
  requireNonNegativeInteger(maxActionLag, 'maxActionLag', 'INVALID_SOURCE_ACTION_SEQ')
  const allowStale = input.allowStale ?? input.retention === 'causal_slice'
  if (typeof allowStale !== 'boolean') {
    throw policyViolation('MISSING_REQUIRED_CONTEXT', 'allowStale must be boolean.')
  }

  const provenanceJson = canonicalJson(canonicalProvenanceTuple(provenance))
  const provenanceDigest = sha256Hex(provenanceJson)
  const id = `ctx:${provenance.kind}:sha256:${provenanceDigest}`
  const base: ContextCatalogItemBase = {
    id,
    originKind: provenance.kind,
    provenance,
    provenanceDigest,
    sensitivity,
    allowedTaskKinds,
    tokenEstimate: input.tokenEstimate,
    retention: input.retention,
    actionBinding,
    relevanceTerms,
    maxActionLag,
    allowStale,
  }

  if (!input.content || typeof input.content !== 'object' || Array.isArray(input.content)) {
    throw policyViolation('MISSING_REQUIRED_CONTEXT', 'Context candidate content is missing.')
  }
  if (input.content.kind === 'denied') {
    assertExactKeys(input.content, ['kind', 'reason'], 'LIVE_CAPABILITY_FORBIDDEN')
    if (!DENIED_REASONS.includes(input.content.reason)) {
      throw policyViolation('LIVE_CAPABILITY_FORBIDDEN', 'Denied context capability reason is invalid.')
    }
    if (input.content.reason === 'incomplete_tool_exchange' && provenance.kind !== 'tool') {
      throw policyViolation('INCOMPLETE_TOOL_EXCHANGE', 'Only a tool candidate can be an incomplete tool exchange.')
    }
    return { ...base, availability: 'denied', deniedReason: input.content.reason }
  }
  if (input.content.kind !== 'context_unit') {
    throw policyViolation('LIVE_CAPABILITY_FORBIDDEN', 'Raw or live context content is forbidden.')
  }
  assertExactKeys(input.content, ['kind', 'unit'], 'LIVE_CAPABILITY_FORBIDDEN')
  const unit = normalizeContextUnit(input.content.unit)
  validateUnitProvenance(unit, provenance, actionBinding)
  return { ...base, availability: 'selectable', unit }
}

export function adaptArtifactSensitivity(value: unknown): CatalogSensitivity {
  switch (value) {
    case 'public': return 'public'
    case 'personal':
    case 'internal': return 'sensitive'
    case 'secret': return 'secret'
    default:
      throw policyViolation('SENSITIVE_CONTEXT_NOT_AUTHORIZED', 'Unknown artifact sensitivity is rejected.')
  }
}

export function normalizeActionBinding(binding: ActionBinding): ActionBinding {
  if (!binding || typeof binding !== 'object' || Array.isArray(binding)) {
    throw policyViolation('INVALID_SOURCE_ACTION_SEQ', 'Action binding must be a closed object.')
  }
  if (binding.kind === 'not_action_bound') {
    assertExactKeys(binding, ['kind'], 'INVALID_SOURCE_ACTION_SEQ')
    return { kind: 'not_action_bound' }
  }
  if (binding.kind === 'browser_action') {
    assertExactKeys(binding, ['kind', 'sourceActionSeq'], 'INVALID_SOURCE_ACTION_SEQ')
    requireNonNegativeInteger(binding.sourceActionSeq, 'sourceActionSeq', 'INVALID_SOURCE_ACTION_SEQ')
    return { kind: 'browser_action', sourceActionSeq: binding.sourceActionSeq }
  }
  throw policyViolation('INVALID_SOURCE_ACTION_SEQ', 'Unknown action binding kind.')
}

export function normalizeImmutableArtifactRef<TKind extends ImmutableArtifactKind>(
  ref: ImmutableArtifactRef<TKind>,
): ImmutableArtifactRef<TKind> {
  if (!ref || typeof ref !== 'object' || Array.isArray(ref)) {
    throw artifactViolation('INVALID_ARTIFACT_REF', 'Artifact ref must be a closed object.')
  }
  assertExactKeys(
    ref,
    [
      'schemaVersion',
      'artifactId',
      'artifactKind',
      'runId',
      'sessionId',
      'storage',
      'mediaType',
      'byteLength',
      'sha256',
      'createdAt',
      'actionBinding',
      'immutable',
    ],
    'INVALID_ARTIFACT_REF',
    'ARTIFACT_INTEGRITY_FAILED',
  )
  if (ref.schemaVersion !== 'immutable-artifact-ref/v1' || ref.immutable !== true) {
    throw artifactViolation('INVALID_ARTIFACT_REF', 'Only immutable artifact ref v1 is accepted.')
  }
  requireNonEmptyString(ref.artifactId, 'artifactId', true)
  requireNonEmptyString(ref.runId, 'runId', true)
  requireNonEmptyString(ref.sessionId, 'sessionId', true)
  requireNonEmptyString(ref.mediaType, 'mediaType', true)
  if (!ARTIFACT_KINDS.includes(ref.artifactKind)) {
    throw artifactViolation('INVALID_ARTIFACT_REF', 'Unknown artifact kind.')
  }
  requireNonNegativeInteger(ref.byteLength, 'byteLength', 'INVALID_ARTIFACT_REF', true)
  if (!SHA256_PATTERN.test(ref.sha256)) {
    throw artifactViolation('INVALID_ARTIFACT_REF', 'Artifact digest must be lowercase SHA-256.')
  }
  requireIsoTimestamp(ref.createdAt, 'createdAt', true)
  if (!ref.storage || typeof ref.storage !== 'object' || Array.isArray(ref.storage)) {
    throw artifactViolation('INVALID_ARTIFACT_REF', 'Artifact storage metadata is invalid.')
  }
  assertExactKeys(ref.storage, ['store', 'relativeSegments'], 'INVALID_ARTIFACT_REF', 'ARTIFACT_INTEGRITY_FAILED')
  if (ref.storage.store !== 'session_artifacts' || !Array.isArray(ref.storage.relativeSegments) || ref.storage.relativeSegments.length === 0) {
    throw artifactViolation('INVALID_ARTIFACT_REF', 'Artifact storage must use non-empty session-relative segments.')
  }
  const relativeSegments = ref.storage.relativeSegments.map((segment) => {
    if (
      typeof segment !== 'string'
      || segment.length === 0
      || segment === '.'
      || segment === '..'
      || segment.includes('/')
      || segment.includes('\\')
      || segment.includes('\0')
      || /^[a-z][a-z0-9+.-]*:/i.test(segment)
    ) {
      throw artifactViolation('INVALID_ARTIFACT_REF', 'Artifact storage contains an unsafe path segment.')
    }
    return segment
  })
  return {
    schemaVersion: 'immutable-artifact-ref/v1',
    artifactId: ref.artifactId,
    artifactKind: ref.artifactKind,
    runId: ref.runId,
    sessionId: ref.sessionId,
    storage: { store: 'session_artifacts', relativeSegments },
    mediaType: ref.mediaType,
    byteLength: ref.byteLength,
    sha256: ref.sha256,
    createdAt: ref.createdAt,
    actionBinding: normalizeActionBinding(ref.actionBinding),
    immutable: true,
  }
}

export function normalizeSanitizedTextProjection(projection: SanitizedTextProjectionV1): SanitizedTextProjectionV1 {
  if (!projection || typeof projection !== 'object' || Array.isArray(projection)) {
    throw policyViolation('FULL_HISTORY_FORBIDDEN', 'Sanitized projection must be a closed object.')
  }
  assertExactKeys(
    projection,
    ['schemaVersion', 'text', 'projectionPolicy', 'sourceArtifactRefs', 'sourceItemCount', 'maxChars', 'contentDigest'],
    'FULL_HISTORY_FORBIDDEN',
  )
  if (projection.schemaVersion !== 'sanitized-text-projection/v1' || projection.projectionPolicy !== 'no_react_history/v1') {
    throw policyViolation('FULL_HISTORY_FORBIDDEN', 'Projection policy must exclude ReAct history.')
  }
  if (typeof projection.text !== 'string' || REACT_HISTORY_PATTERN.test(projection.text)) {
    throw policyViolation('FULL_HISTORY_FORBIDDEN', 'Projection contains parent message or reasoning history syntax.')
  }
  requireNonNegativeInteger(projection.sourceItemCount, 'sourceItemCount', 'FULL_HISTORY_FORBIDDEN')
  if (projection.sourceItemCount > 5) {
    throw policyViolation('FULL_HISTORY_FORBIDDEN', 'Projection source item count exceeds the bounded slice.')
  }
  requireNonNegativeInteger(projection.maxChars, 'maxChars', 'FULL_HISTORY_FORBIDDEN')
  if (projection.maxChars < 1 || projection.maxChars > 2000 || projection.text.length > projection.maxChars) {
    throw policyViolation('FULL_HISTORY_FORBIDDEN', 'Projection character bound is invalid.')
  }
  if (projection.contentDigest !== sha256Hex(projection.text)) {
    throw policyViolation('FULL_HISTORY_FORBIDDEN', 'Projection digest does not match its sanitized text.')
  }
  if (!Array.isArray(projection.sourceArtifactRefs)) {
    throw artifactViolation('INVALID_ARTIFACT_REF', 'Projection source refs must be an array.')
  }
  const sourceArtifactRefs = projection.sourceArtifactRefs.map((ref) => rejectTranscriptRef(normalizeImmutableArtifactRef(ref)))
  return {
    schemaVersion: 'sanitized-text-projection/v1',
    text: projection.text,
    projectionPolicy: 'no_react_history/v1',
    sourceArtifactRefs,
    sourceItemCount: projection.sourceItemCount,
    maxChars: projection.maxChars,
    contentDigest: projection.contentDigest,
  }
}

export function normalizeContextUnit(unit: ContextUnit): ContextUnit {
  if (!unit || typeof unit !== 'object' || Array.isArray(unit)) {
    throw policyViolation('LIVE_CAPABILITY_FORBIDDEN', 'Context unit must be a closed immutable projection.')
  }
  if (unit.kind === 'artifact') {
    assertExactKeys(unit, ['kind', 'artifactRef', 'sanitizedSummary'], 'LIVE_CAPABILITY_FORBIDDEN')
    return {
      kind: 'artifact',
      artifactRef: rejectTranscriptRef(normalizeImmutableArtifactRef(unit.artifactRef)),
      sanitizedSummary: normalizeSanitizedTextProjection(unit.sanitizedSummary),
    }
  }
  if (unit.kind === 'structured_projection') {
    assertExactKeys(unit, ['kind', 'projectionKind', 'sanitizedSummary', 'evidenceRefs'], 'LIVE_CAPABILITY_FORBIDDEN')
    if (!['goal', 'workflow_state', 'memory_summary', 'causal_action'].includes(unit.projectionKind)) {
      throw policyViolation('MISSING_REQUIRED_CONTEXT', 'Structured projection kind is invalid.')
    }
    if (!Array.isArray(unit.evidenceRefs)) {
      throw artifactViolation('INVALID_ARTIFACT_REF', 'Structured evidence refs must be an array.')
    }
    return {
      kind: 'structured_projection',
      projectionKind: unit.projectionKind,
      sanitizedSummary: normalizeSanitizedTextProjection(unit.sanitizedSummary),
      evidenceRefs: unit.evidenceRefs.map((ref) => rejectTranscriptRef(normalizeImmutableArtifactRef(ref))),
    }
  }
  if (unit.kind === 'tool_exchange') {
    assertExactKeys(
      unit,
      ['kind', 'toolCallId', 'toolName', 'callArtifactRef', 'resultArtifactRef', 'sanitizedSummary'],
      'INCOMPLETE_TOOL_EXCHANGE',
    )
    requireNonEmptyString(unit.toolCallId, 'toolCallId')
    if (!READ_ONLY_TOOLS.includes(unit.toolName)) {
      throw policyViolation('LIVE_CAPABILITY_FORBIDDEN', 'Tool exchange contains a non-artifact tool.')
    }
    const callArtifactRef = normalizeImmutableArtifactRef(unit.callArtifactRef)
    const resultArtifactRef = normalizeImmutableArtifactRef(unit.resultArtifactRef)
    if (callArtifactRef.artifactKind !== 'tool_call' || resultArtifactRef.artifactKind !== 'tool_result') {
      throw policyViolation('INCOMPLETE_TOOL_EXCHANGE', 'Tool exchange requires call and result artifact refs.')
    }
    if (canonicalJson(callArtifactRef.actionBinding) !== canonicalJson(resultArtifactRef.actionBinding)) {
      throw policyViolation('INCOMPLETE_TOOL_EXCHANGE', 'Tool call and result must share one action binding.')
    }
    return {
      kind: 'tool_exchange',
      toolCallId: unit.toolCallId,
      toolName: unit.toolName,
      callArtifactRef,
      resultArtifactRef,
      sanitizedSummary: normalizeSanitizedTextProjection(unit.sanitizedSummary),
    }
  }
  throw policyViolation('LIVE_CAPABILITY_FORBIDDEN', 'Unknown or live context unit kind.')
}

export function assertArtifactOwnership(
  ref: ImmutableArtifactRef,
  expectedRunId: string,
  expectedSessionId: string,
): void {
  if (ref.runId !== expectedRunId || ref.sessionId !== expectedSessionId) {
    throw artifactViolation('INVALID_ARTIFACT_REF', 'Artifact ref does not belong to the parent run and session.')
  }
}

export function artifactRefsForContextUnit(unit: ContextUnit): ImmutableArtifactRef[] {
  if (unit.kind === 'artifact') return [unit.artifactRef, ...unit.sanitizedSummary.sourceArtifactRefs]
  if (unit.kind === 'structured_projection') return [...unit.evidenceRefs, ...unit.sanitizedSummary.sourceArtifactRefs]
  return [unit.callArtifactRef, unit.resultArtifactRef, ...unit.sanitizedSummary.sourceArtifactRefs]
}

export function canonicalJson(value: JsonValue): string {
  if (value === null) return 'null'
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw policyViolation('MISSING_REQUIRED_CONTEXT', 'Canonical JSON rejects non-finite numbers.')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`
}

export function sha256Hex(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

export function policyViolation(detail: ContextPolicySafeDetailCode, message: string): ContextContractViolation {
  return new ContextContractViolation('CONTEXT_POLICY_VIOLATION', detail, message)
}

export function artifactViolation(detail: ContextPolicySafeDetailCode, message: string): ContextContractViolation {
  return new ContextContractViolation('ARTIFACT_INTEGRITY_FAILED', detail, message)
}

function normalizeContextProvenance(provenance: ContextProvenance): ContextProvenance {
  if (!provenance || typeof provenance !== 'object' || Array.isArray(provenance)) {
    throw policyViolation('MISSING_REQUIRED_CONTEXT', 'Context provenance must be a closed object.')
  }
  switch (provenance.kind) {
    case 'tool': {
      const keys = ['kind', 'toolName', 'toolCallId']
      if (provenance.callArtifactRef !== undefined) keys.push('callArtifactRef')
      if (provenance.resultArtifactRef !== undefined) keys.push('resultArtifactRef')
      assertExactKeys(provenance, keys, 'INCOMPLETE_TOOL_EXCHANGE')
      requireNonEmptyString(provenance.toolCallId, 'toolCallId')
      if (!READ_ONLY_TOOLS.includes(provenance.toolName)) {
        throw policyViolation('LIVE_CAPABILITY_FORBIDDEN', 'Tool provenance contains a non-artifact tool.')
      }
      const callArtifactRef = provenance.callArtifactRef === undefined
        ? undefined
        : normalizeImmutableArtifactRef(provenance.callArtifactRef)
      const resultArtifactRef = provenance.resultArtifactRef === undefined
        ? undefined
        : normalizeImmutableArtifactRef(provenance.resultArtifactRef)
      if (callArtifactRef && callArtifactRef.artifactKind !== 'tool_call') {
        throw policyViolation('INCOMPLETE_TOOL_EXCHANGE', 'Tool call provenance ref has the wrong artifact kind.')
      }
      if (resultArtifactRef && resultArtifactRef.artifactKind !== 'tool_result') {
        throw policyViolation('INCOMPLETE_TOOL_EXCHANGE', 'Tool result provenance ref has the wrong artifact kind.')
      }
      return {
        kind: 'tool',
        toolName: provenance.toolName,
        toolCallId: provenance.toolCallId,
        ...(callArtifactRef ? { callArtifactRef } : {}),
        ...(resultArtifactRef ? { resultArtifactRef } : {}),
      }
    }
    case 'skill':
      assertExactKeys(provenance, ['kind', 'packageName', 'skillName', 'skillVersion', 'invocationId', 'resultArtifactRef'], 'MISSING_REQUIRED_CONTEXT')
      requireNonEmptyStrings(provenance, ['packageName', 'skillName', 'skillVersion', 'invocationId'])
      return { ...provenance, resultArtifactRef: rejectTranscriptRef(normalizeImmutableArtifactRef(provenance.resultArtifactRef)) }
    case 'mcp':
      assertExactKeys(provenance, ['kind', 'server', 'operationKind', 'operation', 'requestId', 'resultArtifactRef'], 'MISSING_REQUIRED_CONTEXT')
      requireNonEmptyStrings(provenance, ['server', 'operation', 'requestId'])
      if (!['method', 'resource'].includes(provenance.operationKind)) {
        throw policyViolation('MISSING_REQUIRED_CONTEXT', 'MCP operation kind is invalid.')
      }
      return { ...provenance, resultArtifactRef: rejectTranscriptRef(normalizeImmutableArtifactRef(provenance.resultArtifactRef)) }
    case 'trace': {
      assertExactKeys(provenance, ['kind', 'traceId', 'artifactRef'], 'MISSING_REQUIRED_CONTEXT')
      requireNonEmptyString(provenance.traceId, 'traceId')
      const artifactRef = normalizeImmutableArtifactRef(provenance.artifactRef)
      if (artifactRef.artifactKind !== 'trace') throw artifactViolation('INVALID_ARTIFACT_REF', 'Trace provenance requires a trace artifact.')
      return { kind: 'trace', traceId: provenance.traceId, artifactRef }
    }
    case 'memory': {
      assertExactKeys(provenance, ['kind', 'namespace', 'recordId', 'recordVersion', 'artifactRef'], 'MISSING_REQUIRED_CONTEXT')
      requireNonEmptyStrings(provenance, ['namespace', 'recordId', 'recordVersion'])
      const artifactRef = normalizeImmutableArtifactRef(provenance.artifactRef)
      if (artifactRef.artifactKind !== 'memory') throw artifactViolation('INVALID_ARTIFACT_REF', 'Memory provenance requires a memory artifact.')
      return { ...provenance, artifactRef }
    }
    case 'workflow':
      assertExactKeys(provenance, ['kind', 'workflowId', 'workflowRunId', 'stateRevision', 'evidenceRefs', 'actionBinding'], 'MISSING_REQUIRED_CONTEXT')
      requireNonEmptyStrings(provenance, ['workflowId', 'workflowRunId'])
      requireNonNegativeInteger(provenance.stateRevision, 'stateRevision', 'MISSING_REQUIRED_CONTEXT')
      if (!Array.isArray(provenance.evidenceRefs)) throw artifactViolation('INVALID_ARTIFACT_REF', 'Workflow evidence refs must be an array.')
      return {
        kind: 'workflow',
        workflowId: provenance.workflowId,
        workflowRunId: provenance.workflowRunId,
        stateRevision: provenance.stateRevision,
        evidenceRefs: provenance.evidenceRefs.map((ref) => rejectTranscriptRef(normalizeImmutableArtifactRef(ref))),
        actionBinding: normalizeActionBinding(provenance.actionBinding),
      }
    default:
      throw policyViolation('MISSING_REQUIRED_CONTEXT', 'Unknown context provenance origin.')
  }
}

function canonicalProvenanceTuple(provenance: ContextProvenance): JsonValue {
  switch (provenance.kind) {
    case 'tool':
      return {
        kind: 'tool',
        toolName: provenance.toolName,
        toolCallId: provenance.toolCallId,
        callArtifactRef: provenance.callArtifactRef ? artifactIdentity(provenance.callArtifactRef) : null,
        resultArtifactRef: provenance.resultArtifactRef ? artifactIdentity(provenance.resultArtifactRef) : null,
      }
    case 'skill':
      return {
        kind: 'skill',
        packageName: provenance.packageName,
        skillName: provenance.skillName,
        skillVersion: provenance.skillVersion,
        invocationId: provenance.invocationId,
        resultArtifactRef: artifactIdentity(provenance.resultArtifactRef),
      }
    case 'mcp':
      return {
        kind: 'mcp',
        server: provenance.server,
        operationKind: provenance.operationKind,
        operation: provenance.operation,
        requestId: provenance.requestId,
        resultArtifactRef: artifactIdentity(provenance.resultArtifactRef),
      }
    case 'trace':
      return { kind: 'trace', traceId: provenance.traceId, artifactRef: artifactIdentity(provenance.artifactRef) }
    case 'memory':
      return {
        kind: 'memory',
        namespace: provenance.namespace,
        recordId: provenance.recordId,
        recordVersion: provenance.recordVersion,
        artifactRef: artifactIdentity(provenance.artifactRef),
      }
    case 'workflow':
      return {
        kind: 'workflow',
        workflowId: provenance.workflowId,
        workflowRunId: provenance.workflowRunId,
        stateRevision: provenance.stateRevision,
        evidenceRefs: provenance.evidenceRefs.map(artifactIdentity),
        actionBinding: provenance.actionBinding,
      }
  }
}

function artifactIdentity(ref: ImmutableArtifactRef): JsonValue {
  return {
    schemaVersion: ref.schemaVersion,
    artifactId: ref.artifactId,
    artifactKind: ref.artifactKind,
    runId: ref.runId,
    sessionId: ref.sessionId,
    storage: { store: ref.storage.store, relativeSegments: [...ref.storage.relativeSegments] },
    byteLength: ref.byteLength,
    mediaType: ref.mediaType,
    sha256: ref.sha256,
    createdAt: ref.createdAt,
    actionBinding: ref.actionBinding,
    immutable: true,
  }
}

function validateUnitProvenance(unit: ContextUnit, provenance: ContextProvenance, actionBinding: ActionBinding): void {
  if (unit.kind === 'tool_exchange') {
    if (
      provenance.kind !== 'tool'
      || provenance.toolCallId !== unit.toolCallId
      || provenance.toolName !== unit.toolName
      || !provenance.callArtifactRef
      || !provenance.resultArtifactRef
      || !sameArtifact(provenance.callArtifactRef, unit.callArtifactRef)
      || !sameArtifact(provenance.resultArtifactRef, unit.resultArtifactRef)
    ) {
      throw policyViolation('INCOMPLETE_TOOL_EXCHANGE', 'Tool exchange provenance must match both immutable halves.')
    }
  } else if (provenance.kind === 'tool') {
    throw policyViolation('INCOMPLETE_TOOL_EXCHANGE', 'Tool provenance cannot be represented as a partial context unit.')
  }

  const unitRefs = new Set(artifactRefsForContextUnit(unit).map(artifactKey))
  for (const ref of primaryProvenanceRefs(provenance)) {
    if (!unitRefs.has(artifactKey(ref))) {
      throw artifactViolation('INVALID_ARTIFACT_REF', 'Context unit does not carry its provenance artifact ref.')
    }
  }

  const expectedBinding = provenanceActionBinding(provenance)
  if (expectedBinding && canonicalJson(expectedBinding) !== canonicalJson(actionBinding)) {
    throw policyViolation('INVALID_SOURCE_ACTION_SEQ', 'Candidate action binding does not match source provenance.')
  }
  if (unit.kind === 'artifact' && canonicalJson(unit.artifactRef.actionBinding) !== canonicalJson(actionBinding)) {
    throw policyViolation('INVALID_SOURCE_ACTION_SEQ', 'Artifact unit action binding does not match the candidate.')
  }
  if (unit.kind === 'tool_exchange' && canonicalJson(unit.callArtifactRef.actionBinding) !== canonicalJson(actionBinding)) {
    throw policyViolation('INVALID_SOURCE_ACTION_SEQ', 'Tool exchange action binding does not match the candidate.')
  }
}

function provenanceActionBinding(provenance: ContextProvenance): ActionBinding | undefined {
  switch (provenance.kind) {
    case 'tool': return provenance.callArtifactRef?.actionBinding ?? provenance.resultArtifactRef?.actionBinding
    case 'skill': return provenance.resultArtifactRef.actionBinding
    case 'mcp': return provenance.resultArtifactRef.actionBinding
    case 'trace': return provenance.artifactRef.actionBinding
    case 'memory': return provenance.artifactRef.actionBinding
    case 'workflow': return provenance.actionBinding
  }
}

function primaryProvenanceRefs(provenance: ContextProvenance): ImmutableArtifactRef[] {
  switch (provenance.kind) {
    case 'tool':
      return [provenance.callArtifactRef, provenance.resultArtifactRef].filter(
        (ref): ref is ImmutableArtifactRef<'tool_call'> | ImmutableArtifactRef<'tool_result'> => ref !== undefined,
      )
    case 'skill': return [provenance.resultArtifactRef]
    case 'mcp': return [provenance.resultArtifactRef]
    case 'trace': return [provenance.artifactRef]
    case 'memory': return [provenance.artifactRef]
    case 'workflow': return provenance.evidenceRefs
  }
}

function artifactRefsForCatalogItem(item: ContextCatalogItem): ImmutableArtifactRef[] {
  const refs = [...primaryProvenanceRefs(item.provenance)]
  if (item.availability === 'selectable') refs.push(...artifactRefsForContextUnit(item.unit))
  return refs
}

function normalizeSensitivity(value: CatalogSensitivity): CatalogSensitivity {
  if (value === 'public' || value === 'user' || value === 'sensitive' || value === 'secret') return value
  throw policyViolation('SENSITIVE_CONTEXT_NOT_AUTHORIZED', 'Unknown context sensitivity is rejected.')
}

function normalizeTaskKinds(values: readonly AgentTaskKind[]): AgentTaskKind[] {
  if (!Array.isArray(values) || values.length === 0 || values.some((value) => !TASK_KINDS.includes(value))) {
    throw policyViolation('MISSING_REQUIRED_CONTEXT', 'Context candidate must have a non-empty task-kind allowlist.')
  }
  return [...new Set(values)].sort((left, right) => left.localeCompare(right))
}

function normalizeRelevanceTerms(values: readonly string[]): string[] {
  if (!Array.isArray(values) || values.some((value) => typeof value !== 'string')) {
    throw policyViolation('MISSING_REQUIRED_CONTEXT', 'Relevance terms must be strings.')
  }
  return [...new Set(values.map((value) => value.trim().toLowerCase()).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right))
}

function rejectTranscriptRef<TKind extends ImmutableArtifactKind>(ref: ImmutableArtifactRef<TKind>): ImmutableArtifactRef<TKind> {
  if (ref.artifactKind === 'sidechain_transcript') {
    throw policyViolation('FULL_HISTORY_FORBIDDEN', 'Transcript artifacts cannot be context units or projection sources.')
  }
  return ref
}

function sameArtifact(left: ImmutableArtifactRef, right: ImmutableArtifactRef): boolean {
  return canonicalJson(artifactIdentity(left)) === canonicalJson(artifactIdentity(right))
}

function artifactKey(ref: ImmutableArtifactRef): string {
  return `${ref.artifactId}\0${ref.sha256}`
}

function requireNonEmptyStrings<T extends object>(value: T, keys: readonly (keyof T)[]): void {
  for (const key of keys) requireNonEmptyString(value[key], String(key))
}

function requireNonEmptyString(value: unknown, field: string, artifact = false): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.includes('\0')) {
    if (artifact) throw artifactViolation('INVALID_ARTIFACT_REF', `${field} must be a non-empty string.`)
    throw policyViolation('MISSING_REQUIRED_CONTEXT', `${field} must be a non-empty string.`)
  }
}

function requireNonNegativeInteger(
  value: unknown,
  field: string,
  detail: ContextPolicySafeDetailCode,
  artifact = false,
): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    if (artifact) throw artifactViolation(detail, `${field} must be a non-negative safe integer.`)
    throw policyViolation(detail, `${field} must be a non-negative safe integer.`)
  }
}

function requireIsoTimestamp(value: unknown, field: string, artifact = false): asserts value is string {
  const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    if (artifact) throw artifactViolation('INVALID_ARTIFACT_REF', `${field} must be an ISO UTC timestamp.`)
    throw policyViolation('MISSING_REQUIRED_CONTEXT', `${field} must be an ISO UTC timestamp.`)
  }
}

function assertExactKeys(
  value: object,
  allowedKeys: readonly string[],
  detail: ContextPolicySafeDetailCode,
  contractCode: 'CONTEXT_POLICY_VIOLATION' | 'ARTIFACT_INTEGRITY_FAILED' = 'CONTEXT_POLICY_VIOLATION',
  requireAll = true,
): void {
  const allowed = new Set(allowedKeys)
  const actual = Object.keys(value)
  if (actual.some((key) => !allowed.has(key)) || (requireAll && allowedKeys.some((key) => !Object.prototype.hasOwnProperty.call(value, key)))) {
    const message = 'Object contains missing or forbidden fields.'
    if (contractCode === 'ARTIFACT_INTEGRITY_FAILED') throw artifactViolation(detail, message)
    throw policyViolation(detail, message)
  }
}
