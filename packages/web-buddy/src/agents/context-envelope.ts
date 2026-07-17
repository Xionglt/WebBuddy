import type {
  ActionBinding,
  BuiltInRoleEnvelopeBindingV1,
  ImmutableArtifactRef,
  ReadOnlyArtifactToolName,
  ReadOnlyLlmTaskKind,
  SanitizedTextProjectionV1,
  SensitiveDisclosureGrantRefV1,
  SubagentContextEnvelopeV1,
} from './async-task-contracts.js'
import {
  artifactRefsForContextUnit,
  assertArtifactOwnership,
  canonicalJson,
  normalizeActionBinding,
  normalizeContextUnit,
  normalizeImmutableArtifactRef,
  normalizeSanitizedTextProjection,
  policyViolation,
  sha256Hex,
  type ContextCatalogV1,
} from './context-catalog.js'
import { selectContext } from './context-selector.js'

export interface ContextEnvelopeTokenBudgetInput {
  maxInputTokens: number
  fixedEnvelopeTokens: number
  reservedOutputTokens: number
}

export interface BuildSubagentContextEnvelopeInput {
  envelopeId: string
  taskId: string
  taskKind: ReadOnlyLlmTaskKind
  parentRunId: string
  parentSessionId: string
  createdAt: string
  sourceGraphRevision: number
  currentActionBinding: ActionBinding
  objective: SanitizedTextProjectionV1
  outputSchemaRef: ImmutableArtifactRef<'schema'>
  builtInRole?: BuiltInRoleEnvelopeBindingV1
  allowedTools: readonly ReadOnlyArtifactToolName[]
  catalog: ContextCatalogV1
  relevanceText: string
  sensitiveDisclosureGrants?: readonly SensitiveDisclosureGrantRefV1[]
  tokenBudget: ContextEnvelopeTokenBudgetInput
}

const READ_ONLY_TOOL_ORDER: readonly ReadOnlyArtifactToolName[] = [
  'artifact_read_text',
  'artifact_read_json',
  'artifact_search_text',
  'artifact_list_refs',
]

const READ_ONLY_LLM_TASK_KINDS: readonly ReadOnlyLlmTaskKind[] = [
  'candidate_job_research',
  'trace_summarization',
]

export function buildSubagentContextEnvelope(
  input: BuildSubagentContextEnvelopeInput,
): SubagentContextEnvelopeV1 {
  validateBuildInputShape(input)
  requireNonEmptyString(input.envelopeId, 'envelopeId')
  requireNonEmptyString(input.taskId, 'taskId')
  requireNonEmptyString(input.parentRunId, 'parentRunId')
  requireNonEmptyString(input.parentSessionId, 'parentSessionId')
  if (!READ_ONLY_LLM_TASK_KINDS.includes(input.taskKind)) {
    throw policyViolation('LIVE_CAPABILITY_FORBIDDEN', 'Subagent envelope task kind must use the read-only LLM runner.')
  }
  requireNonNegativeInteger(input.sourceGraphRevision, 'sourceGraphRevision', 'MISSING_REQUIRED_CONTEXT')
  if (input.catalog.parentRunId !== input.parentRunId || input.catalog.parentSessionId !== input.parentSessionId) {
    throw policyViolation('MISSING_REQUIRED_CONTEXT', 'Context catalog ownership does not match the envelope parent.')
  }

  const currentActionBinding = normalizeActionBinding(input.currentActionBinding)
  const objective = normalizeSanitizedTextProjection(input.objective)
  for (const ref of objective.sourceArtifactRefs) {
    assertArtifactOwnership(ref, input.parentRunId, input.parentSessionId)
  }
  const outputSchemaRef = normalizeImmutableArtifactRef(input.outputSchemaRef)
  if (outputSchemaRef.artifactKind !== 'schema') {
    throw policyViolation('MISSING_REQUIRED_CONTEXT', 'Envelope output contract must be an immutable schema artifact.')
  }
  assertArtifactOwnership(outputSchemaRef, input.parentRunId, input.parentSessionId)
  const allowedTools = normalizeAllowedTools(input.allowedTools)
  const tokenBudgetInput = normalizeTokenBudget(input.tokenBudget)

  const selection = selectContext({
    catalog: input.catalog,
    taskId: input.taskId,
    taskKind: input.taskKind,
    createdAt: input.createdAt,
    currentActionBinding,
    relevanceText: input.relevanceText,
    maxInputTokens: tokenBudgetInput.maxInputTokens,
    fixedEnvelopeTokens: tokenBudgetInput.fixedEnvelopeTokens,
    sensitiveDisclosureGrants: input.sensitiveDisclosureGrants,
  })
  const selectedContext = selection.selectedContext.map((item) => ({
    ...item,
    freshness: { ...item.freshness },
    allowedTaskKinds: [...item.allowedTaskKinds],
    unit: normalizeContextUnit(item.unit),
  }))
  const omittedContext = selection.omittedContext.map((item) => ({ ...item }))
  const sensitiveDisclosureGrants = selection.sensitiveDisclosureGrants.map((grant) => ({
    ...grant,
    allowedContextItemIds: [...grant.allowedContextItemIds],
  }))
  const selectedContextTokens = selectedContext.reduce((sum, item) => sum + item.tokenEstimate, 0)
  const usedInputTokens = tokenBudgetInput.fixedEnvelopeTokens + selectedContextTokens

  const envelope: SubagentContextEnvelopeV1 = {
    schemaVersion: 'subagent-context-envelope/v1',
    envelopeId: input.envelopeId,
    taskId: input.taskId,
    taskKind: input.taskKind,
    parentRunId: input.parentRunId,
    parentSessionId: input.parentSessionId,
    createdAt: input.createdAt,
    sourceGraphRevision: input.sourceGraphRevision,
    currentActionBinding,
    objective,
    outputSchemaRef,
    ...(input.builtInRole ? { builtInRole: normalizeBuiltInRoleBinding(input.builtInRole, input.taskKind, allowedTools) } : {}),
    selectorPolicyVersion: 'context-selector-policy/v1',
    catalogManifest: {
      ...selection.catalogManifest,
      candidateItemIds: [...selection.catalogManifest.candidateItemIds],
    },
    allowedTools,
    authorityBoundary: {
      browserWrite: false,
      livePageAccess: false,
      authoritativeCompletionEvidence: false,
      requiresMainWorkflowVerification: true,
      gates: {
        login: false,
        captcha: false,
        upload: false,
        save: false,
        finalSubmit: false,
      },
    },
    sensitiveDisclosureGrants,
    selectedContext,
    omittedContext,
    tokenBudget: {
      estimator: 'web-buddy-token-estimator/v1',
      maxInputTokens: tokenBudgetInput.maxInputTokens,
      fixedEnvelopeTokens: tokenBudgetInput.fixedEnvelopeTokens,
      selectedContextTokens,
      usedInputTokens,
      reservedOutputTokens: tokenBudgetInput.reservedOutputTokens,
    },
    parentHistoryIncluded: false,
  }
  validateBuiltEnvelope(envelope)
  return envelope
}

function validateBuiltEnvelope(envelope: SubagentContextEnvelopeV1): void {
  if (
    envelope.schemaVersion !== 'subagent-context-envelope/v1'
    || envelope.selectorPolicyVersion !== 'context-selector-policy/v1'
    || envelope.parentHistoryIncluded !== false
    || envelope.authorityBoundary.browserWrite !== false
    || envelope.authorityBoundary.livePageAccess !== false
    || envelope.authorityBoundary.authoritativeCompletionEvidence !== false
    || envelope.authorityBoundary.requiresMainWorkflowVerification !== true
    || Object.values(envelope.authorityBoundary.gates).some((allowed) => allowed !== false)
  ) {
    throw policyViolation('LIVE_CAPABILITY_FORBIDDEN', 'Built envelope expands Subagent authority or parent history.')
  }
  if (envelope.builtInRole) {
    normalizeBuiltInRoleBinding(envelope.builtInRole, envelope.taskKind, envelope.allowedTools)
  }
  const selectedIds = envelope.selectedContext.map((item) => item.id)
  const omittedIds = envelope.omittedContext.map((item) => item.id)
  const auditIds = [...selectedIds, ...omittedIds]
  if (new Set(auditIds).size !== auditIds.length) {
    throw policyViolation('DUPLICATE_CONTEXT_ID', 'Envelope audit arrays contain duplicate context IDs.')
  }
  if (
    envelope.catalogManifest.canonicalization !== 'context-catalog-item-ids-jcs/v1'
    || envelope.catalogManifest.candidateCount !== envelope.catalogManifest.candidateItemIds.length
    || envelope.catalogManifest.catalogDigest !== sha256Hex(JSON.stringify(envelope.catalogManifest.candidateItemIds))
    || canonicalJson([...auditIds].sort()) !== canonicalJson([...envelope.catalogManifest.candidateItemIds].sort())
  ) {
    throw policyViolation('MISSING_REQUIRED_CONTEXT', 'Envelope selected and omitted arrays do not partition the catalog.')
  }
  const selectedTokens = envelope.selectedContext.reduce((sum, item) => sum + item.tokenEstimate, 0)
  if (
    selectedTokens !== envelope.tokenBudget.selectedContextTokens
    || envelope.tokenBudget.fixedEnvelopeTokens + selectedTokens !== envelope.tokenBudget.usedInputTokens
    || envelope.tokenBudget.usedInputTokens > envelope.tokenBudget.maxInputTokens
  ) {
    throw policyViolation('BUDGET_EXCEEDED', 'Envelope token arithmetic is inconsistent.')
  }
  const grants = new Map(envelope.sensitiveDisclosureGrants.map((grant) => [grant.grantId, grant]))
  const usedGrantIds = new Set<string>()
  for (const item of envelope.selectedContext) {
    if (item.sensitivity === 'sensitive') {
      const grant = grants.get(item.disclosureGrantId)
      if (!grant || !grant.allowedContextItemIds.includes(item.id)) {
        throw policyViolation('SENSITIVE_CONTEXT_NOT_AUTHORIZED', 'Sensitive selected context is not covered by its grant.')
      }
      usedGrantIds.add(item.disclosureGrantId)
    }
    if ((item as { sensitivity: string }).sensitivity === 'secret') {
      throw policyViolation('SECRET_CONTEXT_SELECTED', 'Secret context entered the selected envelope.')
    }
    for (const ref of artifactRefsForContextUnit(item.unit)) {
      assertArtifactOwnership(ref, envelope.parentRunId, envelope.parentSessionId)
    }
    if (item.unit.kind === 'tool_exchange') {
      if (item.unit.callArtifactRef.artifactKind !== 'tool_call' || item.unit.resultArtifactRef.artifactKind !== 'tool_result') {
        throw policyViolation('INCOMPLETE_TOOL_EXCHANGE', 'Envelope contains an incomplete tool exchange.')
      }
    }
  }
  if (usedGrantIds.size !== grants.size) {
    throw policyViolation('SENSITIVE_CONTEXT_NOT_AUTHORIZED', 'Envelope contains an unused sensitive disclosure grant.')
  }
  for (const ref of envelope.objective.sourceArtifactRefs) {
    assertArtifactOwnership(ref, envelope.parentRunId, envelope.parentSessionId)
  }
  assertArtifactOwnership(envelope.outputSchemaRef, envelope.parentRunId, envelope.parentSessionId)
}

function normalizeAllowedTools(values: readonly ReadOnlyArtifactToolName[]): ReadOnlyArtifactToolName[] {
  if (!Array.isArray(values)) {
    throw policyViolation('LIVE_CAPABILITY_FORBIDDEN', 'Allowed tools must be a closed artifact-tool array.')
  }
  if (values.some((value) => !READ_ONLY_TOOL_ORDER.includes(value))) {
    throw policyViolation('LIVE_CAPABILITY_FORBIDDEN', 'Envelope contains a browser, write, or unknown tool capability.')
  }
  const requested = new Set(values)
  return READ_ONLY_TOOL_ORDER.filter((tool) => requested.has(tool))
}

function normalizeBuiltInRoleBinding(
  value: BuiltInRoleEnvelopeBindingV1,
  taskKind: ReadOnlyLlmTaskKind,
  envelopeTools: readonly ReadOnlyArtifactToolName[],
): BuiltInRoleEnvelopeBindingV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw policyViolation('LIVE_CAPABILITY_FORBIDDEN', 'Built-in role binding must be a closed object.')
  }
  const expected = [
    'schemaVersion',
    'roleId',
    'roleVersion',
    'roleDigest',
    'authority',
    'runtimeTaskKind',
    'allowedTools',
    'outputArtifactKind',
    'outputPayloadSchemaVersion',
    'requiredOutputFields',
    'browserWrite',
    'livePageAccess',
    'canResolveApproval',
    'canWriteMemory',
    'authoritativeCompletionEvidence',
    'requiresMainWorkflowVerification',
  ]
  const keys = Object.keys(value)
  if (keys.length !== expected.length || keys.some((key) => !expected.includes(key))) {
    throw policyViolation('LIVE_CAPABILITY_FORBIDDEN', 'Built-in role binding has missing or forbidden fields.')
  }
  requireNonEmptyString(value.roleId, 'builtInRole.roleId')
  requireNonEmptyString(value.roleVersion, 'builtInRole.roleVersion')
  requireNonEmptyString(value.outputArtifactKind, 'builtInRole.outputArtifactKind')
  requireNonEmptyString(value.outputPayloadSchemaVersion, 'builtInRole.outputPayloadSchemaVersion')
  if (!/^[a-f0-9]{64}$/i.test(value.roleDigest)
    || (value.authority !== 'read_only' && value.authority !== 'recommend_only')
    || value.runtimeTaskKind !== taskKind
    || value.browserWrite !== false
    || value.livePageAccess !== false
    || value.canResolveApproval !== false
    || value.canWriteMemory !== false
    || value.authoritativeCompletionEvidence !== false
    || value.requiresMainWorkflowVerification !== true) {
    throw policyViolation('LIVE_CAPABILITY_FORBIDDEN', 'Built-in role binding expands authority or mismatches the task.')
  }
  const allowedTools = normalizeAllowedTools(value.allowedTools)
  if (canonicalJson(allowedTools) !== canonicalJson(normalizeAllowedTools(envelopeTools))) {
    throw policyViolation('LIVE_CAPABILITY_FORBIDDEN', 'Built-in role tools must exactly match the Context Envelope tools.')
  }
  if (!Array.isArray(value.requiredOutputFields) || value.requiredOutputFields.length === 0) {
    throw policyViolation('MISSING_REQUIRED_CONTEXT', 'Built-in role output fields must be non-empty.')
  }
  const requiredOutputFields = value.requiredOutputFields.map((field) => {
    requireNonEmptyString(field, 'builtInRole.requiredOutputFields')
    return field
  })
  if (new Set(requiredOutputFields).size !== requiredOutputFields.length) {
    throw policyViolation('MISSING_REQUIRED_CONTEXT', 'Built-in role output fields must not contain duplicates.')
  }
  return {
    ...value,
    allowedTools,
    requiredOutputFields,
  }
}

function normalizeTokenBudget(value: ContextEnvelopeTokenBudgetInput): ContextEnvelopeTokenBudgetInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw policyViolation('BUDGET_EXCEEDED', 'Envelope token budget must be a closed object.')
  }
  const expected = ['maxInputTokens', 'fixedEnvelopeTokens', 'reservedOutputTokens']
  const keys = Object.keys(value)
  if (keys.length !== expected.length || keys.some((key) => !expected.includes(key))) {
    throw policyViolation('BUDGET_EXCEEDED', 'Envelope token budget has missing or forbidden fields.')
  }
  requireNonNegativeInteger(value.maxInputTokens, 'maxInputTokens', 'BUDGET_EXCEEDED')
  requireNonNegativeInteger(value.fixedEnvelopeTokens, 'fixedEnvelopeTokens', 'BUDGET_EXCEEDED')
  requireNonNegativeInteger(value.reservedOutputTokens, 'reservedOutputTokens', 'BUDGET_EXCEEDED')
  if (value.fixedEnvelopeTokens > value.maxInputTokens) {
    throw policyViolation('BUDGET_EXCEEDED', 'Fixed envelope tokens exceed maximum input tokens.')
  }
  return {
    maxInputTokens: value.maxInputTokens,
    fixedEnvelopeTokens: value.fixedEnvelopeTokens,
    reservedOutputTokens: value.reservedOutputTokens,
  }
}

function validateBuildInputShape(input: BuildSubagentContextEnvelopeInput): void {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw policyViolation('MISSING_REQUIRED_CONTEXT', 'Envelope builder input must be a closed object.')
  }
  const expected = [
    'envelopeId',
    'taskId',
    'taskKind',
    'parentRunId',
    'parentSessionId',
    'createdAt',
    'sourceGraphRevision',
    'currentActionBinding',
    'objective',
    'outputSchemaRef',
    'builtInRole',
    'allowedTools',
    'catalog',
    'relevanceText',
    'sensitiveDisclosureGrants',
    'tokenBudget',
  ]
  const required = expected.filter((key) => key !== 'sensitiveDisclosureGrants' && key !== 'builtInRole')
  const keys = Object.keys(input)
  const fullHistoryKeys = new Set(['parentMessages', 'messages', 'history', 'reactHistory', 'transcript'])
  const liveKeys = new Set(['page', 'livePage', 'browser', 'browserContext'])
  if (keys.some((key) => fullHistoryKeys.has(key))) {
    throw policyViolation('FULL_HISTORY_FORBIDDEN', 'Parent messages and ReAct history are forbidden envelope inputs.')
  }
  if (keys.some((key) => liveKeys.has(key))) {
    throw policyViolation('LIVE_CAPABILITY_FORBIDDEN', 'Live Page or browser capability is a forbidden envelope input.')
  }
  if (keys.some((key) => !expected.includes(key)) || required.some((key) => !Object.prototype.hasOwnProperty.call(input, key))) {
    throw policyViolation('MISSING_REQUIRED_CONTEXT', 'Envelope builder input has missing or forbidden fields.')
  }
}

function requireNonEmptyString(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.includes('\0')) {
    throw policyViolation('MISSING_REQUIRED_CONTEXT', `${field} must be a non-empty string.`)
  }
}

function requireNonNegativeInteger(
  value: unknown,
  field: string,
  detail: 'BUDGET_EXCEEDED' | 'MISSING_REQUIRED_CONTEXT',
): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw policyViolation(detail, `${field} must be a non-negative safe integer.`)
  }
}
