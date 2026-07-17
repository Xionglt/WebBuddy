import type { JsonObject, JsonValue } from '../task/contracts.js'
import type {
  BuiltInRoleEnvelopeBindingV1,
  ReadOnlyLlmTaskKind,
} from './async-task-contracts.js'
import {
  AGENT_ARTIFACT_CONTRACT_SCHEMA_VERSION,
  MULTI_AGENT_ROLE_SCHEMA_VERSION,
  multiAgentDigest,
  validateMultiAgentRole,
  type AgentArtifactContract,
  type MultiAgentRole,
} from './multi-agent-contracts.js'

export const BUILT_IN_ROLE_TASK_SCHEMA_VERSION = 'built-in-role-task/v1' as const
export const BUILT_IN_ROLE_RUNTIME_BINDING_SCHEMA_VERSION = 'built-in-role-runtime-binding/v1' as const

export const BUILT_IN_AGENT_ROLE_IDS = [
  'planner',
  'researcher',
  'comparison',
  'form-planner',
  'safety-reviewer',
  'verification',
] as const

export type BuiltInAgentRoleId = typeof BUILT_IN_AGENT_ROLE_IDS[number]

export type BuiltInRoleOutputArtifactKind =
  | 'plan_proposal'
  | 'research_report'
  | 'comparison_report'
  | 'form_field_plan'
  | 'safety_verdict'
  | 'evidence_assessment'

export interface BuiltInRoleOutputDescriptor {
  artifactKind: BuiltInRoleOutputArtifactKind
  payloadSchemaVersion: string
  requiredFields: string[]
  description: string
}

export interface BuiltInRoleRuntimeBinding {
  schemaVersion: typeof BUILT_IN_ROLE_RUNTIME_BINDING_SCHEMA_VERSION
  role: MultiAgentRole
  roleDigest: string
  runtimeTaskKind: ReadOnlyLlmTaskKind
  output: BuiltInRoleOutputDescriptor
}

export interface BuiltInRoleTaskMetadata extends JsonObject {
  schemaVersion: typeof BUILT_IN_ROLE_TASK_SCHEMA_VERSION
  roleId: BuiltInAgentRoleId
  roleVersion: string
  roleDigest: string
  runtimeTaskKind: ReadOnlyLlmTaskKind
  outputArtifactKind: BuiltInRoleOutputArtifactKind
  outputPayloadSchemaVersion: string
  goal: string
  requestedArtifactIds: string[]
}

interface RoleDefinition {
  role: MultiAgentRole
  runtimeTaskKind: ReadOnlyLlmTaskKind
  output: BuiltInRoleOutputDescriptor
}

const INPUT_ORIGINS = ['web', 'tool', 'download', 'artifact', 'memory', 'subagent', 'derived'] as const
const INPUT_TRUST = ['untrusted_external', 'derived_untrusted', 'non_authoritative'] as const

const DEFINITIONS: Readonly<Record<BuiltInAgentRoleId, RoleDefinition>> = {
  planner: definition({
    id: 'planner',
    authority: 'recommend_only',
    capabilities: ['context.read', 'artifact.read', 'artifact.search', 'plan.propose'],
    allowedTools: ['artifact_read_json', 'artifact_search_text', 'artifact_list_refs'],
    inputKinds: ['task_context', 'workflow_snapshot', 'page_snapshot'],
    outputKind: 'plan_proposal',
    outputSchema: 'plan-proposal/v1',
    requiredFields: ['steps', 'assumptions', 'blockers'],
    description: 'A bounded execution proposal. It cannot execute or approve any step.',
    runtimeTaskKind: 'trace_summarization',
  }),
  researcher: definition({
    id: 'researcher',
    authority: 'read_only',
    capabilities: ['context.read', 'artifact.read', 'artifact.search', 'research.summarize'],
    allowedTools: ['artifact_read_text', 'artifact_read_json', 'artifact_search_text', 'artifact_list_refs'],
    inputKinds: ['page_snapshot', 'source_bundle', 'prior_research'],
    outputKind: 'research_report',
    outputSchema: 'research-report/v1',
    requiredFields: ['findings', 'sources', 'uncertainties'],
    description: 'A source-linked research report with explicit uncertainty.',
    runtimeTaskKind: 'candidate_job_research',
  }),
  comparison: definition({
    id: 'comparison',
    authority: 'recommend_only',
    capabilities: ['context.read', 'artifact.read', 'artifact.search', 'comparison.propose'],
    allowedTools: ['artifact_read_json', 'artifact_search_text', 'artifact_list_refs'],
    inputKinds: ['research_report', 'comparison_candidate', 'task_context'],
    outputKind: 'comparison_report',
    outputSchema: 'comparison-report/v1',
    requiredFields: ['criteria', 'comparisons', 'recommendation'],
    description: 'A criteria-based comparison whose recommendation remains advisory.',
    runtimeTaskKind: 'candidate_job_research',
  }),
  'form-planner': definition({
    id: 'form-planner',
    authority: 'recommend_only',
    capabilities: ['context.read', 'artifact.read', 'form.plan'],
    allowedTools: ['artifact_read_json', 'artifact_list_refs'],
    inputKinds: ['form_snapshot', 'profile_snapshot', 'page_snapshot'],
    outputKind: 'form_field_plan',
    outputSchema: 'form-field-plan/v1',
    requiredFields: ['fields', 'unknowns', 'warnings'],
    description: 'A field-by-field draft plan. It cannot type, upload, save, or submit.',
    runtimeTaskKind: 'trace_summarization',
  }),
  'safety-reviewer': definition({
    id: 'safety-reviewer',
    authority: 'recommend_only',
    capabilities: ['context.read', 'artifact.read', 'safety.review'],
    allowedTools: ['artifact_read_json', 'artifact_list_refs'],
    inputKinds: ['action_plan', 'form_field_plan', 'workflow_snapshot'],
    outputKind: 'safety_verdict',
    outputSchema: 'safety-verdict/v1',
    requiredFields: ['verdict', 'reasons', 'reviewedActionIds'],
    description: 'An advisory allow/ask/deny verdict. It is never an Approval decision or binding.',
    runtimeTaskKind: 'trace_summarization',
  }),
  verification: definition({
    id: 'verification',
    authority: 'recommend_only',
    capabilities: ['context.read', 'artifact.read', 'artifact.search', 'evidence.assess'],
    allowedTools: ['artifact_read_json', 'artifact_search_text', 'artifact_list_refs'],
    inputKinds: ['evidence_bundle', 'workflow_snapshot', 'page_snapshot'],
    outputKind: 'evidence_assessment',
    outputSchema: 'evidence-assessment/v1',
    requiredFields: ['assessment', 'evidenceIds', 'gaps'],
    description: 'An evidence assessment that cannot become authoritative completion evidence.',
    runtimeTaskKind: 'trace_summarization',
  }),
}

for (const id of BUILT_IN_AGENT_ROLE_IDS) validateDefinition(DEFINITIONS[id])

export function isBuiltInAgentRoleId(value: unknown): value is BuiltInAgentRoleId {
  return typeof value === 'string' && (BUILT_IN_AGENT_ROLE_IDS as readonly string[]).includes(value)
}

export function getBuiltInAgentRole(id: BuiltInAgentRoleId): MultiAgentRole {
  const definitionValue = DEFINITIONS[id]
  if (!definitionValue) throw new Error(`Unknown built-in AgentRole: ${String(id)}`)
  validateDefinition(definitionValue)
  return structuredClone(definitionValue.role)
}

export function listBuiltInAgentRoles(): MultiAgentRole[] {
  return BUILT_IN_AGENT_ROLE_IDS.map(getBuiltInAgentRole)
}

export function getBuiltInRoleRuntimeBinding(id: BuiltInAgentRoleId): BuiltInRoleRuntimeBinding {
  const definitionValue = DEFINITIONS[id]
  if (!definitionValue) throw new Error(`Unknown built-in AgentRole: ${String(id)}`)
  validateDefinition(definitionValue)
  return {
    schemaVersion: BUILT_IN_ROLE_RUNTIME_BINDING_SCHEMA_VERSION,
    role: structuredClone(definitionValue.role),
    roleDigest: multiAgentDigest(definitionValue.role),
    runtimeTaskKind: definitionValue.runtimeTaskKind,
    output: structuredClone(definitionValue.output),
  }
}

export function toBuiltInRoleEnvelopeBinding(
  binding: BuiltInRoleRuntimeBinding,
): BuiltInRoleEnvelopeBindingV1 {
  validateMultiAgentRole(binding.role)
  return {
    schemaVersion: 'built-in-role-envelope-binding/v1',
    roleId: binding.role.id,
    roleVersion: binding.role.version,
    roleDigest: binding.roleDigest,
    authority: binding.role.authority,
    runtimeTaskKind: binding.runtimeTaskKind,
    allowedTools: [...binding.role.allowedTools],
    outputArtifactKind: binding.output.artifactKind,
    outputPayloadSchemaVersion: binding.output.payloadSchemaVersion,
    requiredOutputFields: [...binding.output.requiredFields],
    browserWrite: false,
    livePageAccess: false,
    canResolveApproval: false,
    canWriteMemory: false,
    authoritativeCompletionEvidence: false,
    requiresMainWorkflowVerification: true,
  }
}

export function createBuiltInRoleTaskMetadata(input: {
  roleId: BuiltInAgentRoleId
  goal: string
  requestedArtifactIds?: readonly string[]
}): BuiltInRoleTaskMetadata {
  const goal = nonEmpty(input.goal, 'goal')
  const requestedArtifactIds = uniqueStrings(input.requestedArtifactIds ?? [], 'requestedArtifactIds')
  const binding = getBuiltInRoleRuntimeBinding(input.roleId)
  return {
    schemaVersion: BUILT_IN_ROLE_TASK_SCHEMA_VERSION,
    roleId: input.roleId,
    roleVersion: binding.role.version,
    roleDigest: binding.roleDigest,
    runtimeTaskKind: binding.runtimeTaskKind,
    outputArtifactKind: binding.output.artifactKind,
    outputPayloadSchemaVersion: binding.output.payloadSchemaVersion,
    goal,
    requestedArtifactIds,
  }
}

export function parseBuiltInRoleTaskMetadata(value: JsonValue | undefined): BuiltInRoleTaskMetadata | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  if (value.schemaVersion !== BUILT_IN_ROLE_TASK_SCHEMA_VERSION) return undefined
  closedObject(value, [
    'schemaVersion',
    'roleId',
    'roleVersion',
    'roleDigest',
    'runtimeTaskKind',
    'outputArtifactKind',
    'outputPayloadSchemaVersion',
    'goal',
    'requestedArtifactIds',
  ], 'BuiltInRoleTaskMetadata')
  if (!isBuiltInAgentRoleId(value.roleId)) throw new Error(`Unknown built-in AgentRole: ${String(value.roleId)}`)
  const expected = createBuiltInRoleTaskMetadata({
    roleId: value.roleId,
    goal: nonEmpty(value.goal, 'goal'),
    requestedArtifactIds: stringArray(value.requestedArtifactIds, 'requestedArtifactIds'),
  })
  if (multiAgentDigest(value) !== multiAgentDigest(expected)) {
    throw new Error(`Built-in role metadata for ${value.roleId} does not match the registered immutable role.`)
  }
  return expected
}

export function validateBuiltInRoleOutputPayload(roleId: BuiltInAgentRoleId, payload: JsonValue): void {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error(`${roleId} output payload must be a JSON object.`)
  }
  const binding = getBuiltInRoleRuntimeBinding(roleId)
  const payloadKeys = Object.keys(payload)
  if (payloadKeys.length !== binding.output.requiredFields.length
    || payloadKeys.some((field) => !binding.output.requiredFields.includes(field))) {
    throw new Error(`${roleId} output payload contains missing or forbidden fields.`)
  }
  for (const field of binding.output.requiredFields) {
    if (!(field in payload)) throw new Error(`${roleId} output payload is missing required field ${field}.`)
  }
  if (roleId === 'form-planner' && !Array.isArray(payload.fields)) {
    throw new Error('Form Planner output must contain a fields array.')
  }
  if (roleId === 'safety-reviewer'
    && payload.verdict !== 'allow'
    && payload.verdict !== 'ask'
    && payload.verdict !== 'deny') {
    throw new Error('Safety Reviewer verdict must be allow, ask, or deny.')
  }
  if (roleId === 'safety-reviewer'
    && (!Array.isArray(payload.reasons) || !Array.isArray(payload.reviewedActionIds))) {
    throw new Error('Safety Reviewer reasons and reviewedActionIds must be arrays.')
  }
  if (roleId === 'verification'
    && payload.assessment !== 'verified'
    && payload.assessment !== 'unverified'
    && payload.assessment !== 'rejected') {
    throw new Error('Verification assessment must be verified, unverified, or rejected.')
  }
  if (roleId === 'verification'
    && (!Array.isArray(payload.evidenceIds) || !Array.isArray(payload.gaps))) {
    throw new Error('Verification evidenceIds and gaps must be arrays.')
  }
}

function definition(input: {
  id: BuiltInAgentRoleId
  authority: MultiAgentRole['authority']
  capabilities: MultiAgentRole['capabilities']
  allowedTools: MultiAgentRole['allowedTools']
  inputKinds: string[]
  outputKind: BuiltInRoleOutputArtifactKind
  outputSchema: string
  requiredFields: string[]
  description: string
  runtimeTaskKind: ReadOnlyLlmTaskKind
}): RoleDefinition {
  const inputContracts = input.inputKinds.map((kind, index) => artifactContract({
    contractId: `${input.id}-input-${kind}/v1`,
    direction: 'input',
    artifactKinds: [kind],
    payloadSchemaVersions: [`${kind.replaceAll('_', '-')}/v1`],
    minCount: index === 0 ? 1 : 0,
    maxCount: 32,
    allowedOrigins: [...INPUT_ORIGINS],
    allowedTrust: [...INPUT_TRUST],
    lineage: 'none',
  }))
  const outputContract = artifactContract({
    contractId: `${input.id}-output/v1`,
    direction: 'output',
    artifactKinds: [input.outputKind],
    payloadSchemaVersions: [input.outputSchema],
    minCount: 1,
    maxCount: 1,
    allowedOrigins: ['subagent'],
    allowedTrust: ['non_authoritative'],
    lineage: 'at_least_one_current_input',
  })
  return {
    role: {
      schemaVersion: MULTI_AGENT_ROLE_SCHEMA_VERSION,
      id: input.id,
      version: '1.0.0',
      capabilities: [...input.capabilities],
      authority: input.authority,
      allowedTools: [...input.allowedTools],
      inputArtifactContracts: inputContracts,
      outputArtifactContracts: [outputContract],
      livePageAccess: false,
      browserWrite: false,
      canResolveApproval: false,
      canWriteMemory: false,
      authoritativeCompletionEvidence: false,
      requiresMainWorkflowVerification: true,
    },
    runtimeTaskKind: input.runtimeTaskKind,
    output: {
      artifactKind: input.outputKind,
      payloadSchemaVersion: input.outputSchema,
      requiredFields: [...input.requiredFields],
      description: input.description,
    },
  }
}

function artifactContract(input: {
  contractId: string
  direction: 'input' | 'output'
  artifactKinds: string[]
  payloadSchemaVersions: string[]
  minCount: number
  maxCount: number
  allowedOrigins: AgentArtifactContract['allowedOrigins']
  allowedTrust: AgentArtifactContract['allowedTrust']
  lineage: NonNullable<AgentArtifactContract['lineage']>
}): AgentArtifactContract {
  return {
    schemaVersion: AGENT_ARTIFACT_CONTRACT_SCHEMA_VERSION,
    contractId: input.contractId,
    direction: input.direction,
    artifactKinds: [...input.artifactKinds],
    payloadSchemaVersions: [...input.payloadSchemaVersions],
    mediaTypes: ['application/json'],
    minCount: input.minCount,
    maxCount: input.maxCount,
    immutableRequired: true,
    freshness: 'current_run_revision',
    allowedOrigins: [...(input.allowedOrigins ?? [])],
    allowedTrust: [...(input.allowedTrust ?? [])],
    lineage: input.lineage,
    requiresMainWorkflowVerification: true,
    authoritativeCompletionEvidence: false,
  }
}

function validateDefinition(value: RoleDefinition): void {
  validateMultiAgentRole(value.role)
  if (value.role.browserWrite !== false || value.role.livePageAccess !== false
    || value.role.canResolveApproval !== false || value.role.canWriteMemory !== false
    || value.role.authoritativeCompletionEvidence !== false
    || value.role.requiresMainWorkflowVerification !== true) {
    throw new Error(`Built-in role ${value.role.id} expands Main Agent authority.`)
  }
  if (value.runtimeTaskKind !== 'candidate_job_research' && value.runtimeTaskKind !== 'trace_summarization') {
    throw new Error(`Built-in role ${value.role.id} is not bound to the read-only LLM runner.`)
  }
  const output = value.role.outputArtifactContracts[0]
  if (!output
    || output.artifactKinds.length !== 1
    || output.artifactKinds[0] !== value.output.artifactKind
    || output.payloadSchemaVersions.length !== 1
    || output.payloadSchemaVersions[0] !== value.output.payloadSchemaVersion) {
    throw new Error(`Built-in role ${value.role.id} output descriptor does not match its Artifact Contract.`)
  }
}

function closedObject(value: object, keys: readonly string[], label: string): void {
  const unknown = Object.keys(value).find((key) => !keys.includes(key))
  if (unknown) throw new Error(`${label} contains forbidden field ${unknown}.`)
}

function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a non-empty string.`)
  return value.trim()
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`)
  return uniqueStrings(value, label)
}

function uniqueStrings(value: readonly unknown[], label: string): string[] {
  const result = value.map((item) => nonEmpty(item, label))
  if (new Set(result).size !== result.length) throw new Error(`${label} must not contain duplicates.`)
  return result
}
