import type { SkillTriggers } from '../types.js'

export type CandidateSkillScope = 'project' | 'user'
export type CandidateFindingSeverity = 'blocker' | 'warning'

export interface ValidationFindingV1 {
  schemaVersion: 'skill-candidate-finding/v1'
  severity: CandidateFindingSeverity
  code: string
  path: string
  message: string
}

export interface SkillGenerationRequestV1 {
  schemaVersion: 'skill-generation-request/v1'
  requestId: string
  createdAt: string
  runId: string
  revision: number
  sessionId: string
  attempt: number
  traceSessionId: string
  resultStatus: 'completed'
  outcomeArtifactId: string
  outcomeSha256: string
  requestedScope: CandidateSkillScope
}

export interface ProjectedToolStepV1 {
  sequence: number
  toolName: string
  toolCategory?: string
}

export interface ProjectedSkillEvidenceV1 {
  schemaVersion: 'projected-skill-evidence/v1'
  runId: string
  revision: number
  sessionId: string
  attempt: number
  task: {
    taskType?: string
    workflowPhase?: string
    domain?: string
  }
  successfulTools: ProjectedToolStepV1[]
  actions: Array<{ actionKind: string; outcome: string }>
  resolvedSkills: Array<{
    id: string
    source: string
    reason: string
    bodyHash?: string
  }>
  source: {
    outcomeArtifactId: string
    outcomeSha256: string
    traceSha256: string
    resolvedSkillsSha256: string
  }
}

export interface ProposedSkillV1 {
  schemaVersion: 'proposed-skill/v1'
  id: string
  name: string
  scope: CandidateSkillScope
  priority: number
  triggers: SkillTriggers
  provides: { promptSections: ['NEXT_ACTION_RULES'] }
  promptSections: [{
    id: 'NEXT_ACTION_RULES'
    summary: string
  }]
  body: string
}

export interface SkillCandidateV1 {
  schemaVersion: 'skill-candidate/v1'
  candidateId: string
  createdAt: string
  proposedSkill: ProposedSkillV1
  provenance: {
    requestId: string
    runId: string
    revision: number
    sessionId: string
    attempt: number
    outcomeArtifactId: string
    traceSha256: string
    generatorId: string
    generatorVersion: string
  }
  evidenceSummary: ProjectedSkillEvidenceV1
  fingerprint: string
  validation: {
    blockers: ValidationFindingV1[]
    warnings: ValidationFindingV1[]
  }
}

export interface SkillGenerationReceiptV1 {
  schemaVersion: 'skill-generation-receipt/v1'
  requestId: string
  processedAt: string
  status: 'generated' | 'duplicate' | 'ineligible' | 'rejected'
  candidateId?: string
  findings: ValidationFindingV1[]
}

export function assertSkillGenerationRequest(value: unknown): asserts value is SkillGenerationRequestV1 {
  within('INVALID_SKILL_GENERATION_REQUEST', () => {
    const item = plainObject(value, '$')
    exactKeys(item, [
      'schemaVersion',
      'requestId',
      'createdAt',
      'runId',
      'revision',
      'sessionId',
      'attempt',
      'traceSessionId',
      'resultStatus',
      'outcomeArtifactId',
      'outcomeSha256',
      'requestedScope',
    ], '$')
    literal(item.schemaVersion, 'skill-generation-request/v1', '$.schemaVersion')
    safeId(item.requestId, '$.requestId')
    timestamp(item.createdAt, '$.createdAt')
    opaqueId(item.runId, '$.runId')
    positiveInteger(item.revision, '$.revision', true)
    opaqueId(item.sessionId, '$.sessionId')
    positiveInteger(item.attempt, '$.attempt')
    opaqueId(item.traceSessionId, '$.traceSessionId')
    literal(item.resultStatus, 'completed', '$.resultStatus')
    safeId(item.outcomeArtifactId, '$.outcomeArtifactId')
    hash(item.outcomeSha256, '$.outcomeSha256')
    oneOf(item.requestedScope, ['project', 'user'], '$.requestedScope')
  })
}

export function assertProjectedSkillEvidence(value: unknown): asserts value is ProjectedSkillEvidenceV1 {
  within('INVALID_PROJECTED_SKILL_EVIDENCE', () => {
    const item = plainObject(value, '$')
    exactKeys(item, [
      'schemaVersion',
      'runId',
      'revision',
      'sessionId',
      'attempt',
      'task',
      'successfulTools',
      'actions',
      'resolvedSkills',
      'source',
    ], '$')
    literal(item.schemaVersion, 'projected-skill-evidence/v1', '$.schemaVersion')
    opaqueId(item.runId, '$.runId')
    positiveInteger(item.revision, '$.revision', true)
    opaqueId(item.sessionId, '$.sessionId')
    positiveInteger(item.attempt, '$.attempt')
    taskContext(item.task)
    array(item.successfulTools, '$.successfulTools').forEach((step, index) => toolStep(step, index))
    array(item.actions, '$.actions').forEach((action, index) => projectedAction(action, index))
    array(item.resolvedSkills, '$.resolvedSkills').forEach((skill, index) => resolvedSkill(skill, index))
    evidenceSource(item.source)
  })
}

export function assertProposedSkill(value: unknown): asserts value is ProposedSkillV1 {
  within('INVALID_PROPOSED_SKILL', () => {
    const item = plainObject(value, '$')
    exactKeys(item, [
      'schemaVersion',
      'id',
      'name',
      'scope',
      'priority',
      'triggers',
      'provides',
      'promptSections',
      'body',
    ], '$')
    literal(item.schemaVersion, 'proposed-skill/v1', '$.schemaVersion')
    nonEmptyString(item.id, '$.id')
    nonEmptyString(item.name, '$.name')
    oneOf(item.scope, ['project', 'user'], '$.scope')
    positiveInteger(item.priority, '$.priority', true)
    skillTriggers(item.triggers)
    const provides = plainObject(item.provides, '$.provides')
    exactKeys(provides, ['promptSections'], '$.provides')
    const providedSections = array(provides.promptSections, '$.provides.promptSections')
    if (providedSections.length !== 1) fail('$.provides.promptSections must contain one item')
    literal(providedSections[0], 'NEXT_ACTION_RULES', '$.provides.promptSections[0]')
    const sections = array(item.promptSections, '$.promptSections')
    if (sections.length !== 1) fail('$.promptSections must contain one item')
    const section = plainObject(sections[0], '$.promptSections[0]')
    exactKeys(section, ['id', 'summary'], '$.promptSections[0]')
    literal(section.id, 'NEXT_ACTION_RULES', '$.promptSections[0].id')
    nonEmptyString(section.summary, '$.promptSections[0].summary')
    nonEmptyString(item.body, '$.body')
  })
}

export function assertSkillCandidate(value: unknown): asserts value is SkillCandidateV1 {
  within('INVALID_SKILL_CANDIDATE', () => {
    const item = plainObject(value, '$')
    exactKeys(item, [
      'schemaVersion',
      'candidateId',
      'createdAt',
      'proposedSkill',
      'provenance',
      'evidenceSummary',
      'fingerprint',
      'validation',
    ], '$')
    literal(item.schemaVersion, 'skill-candidate/v1', '$.schemaVersion')
    safeId(item.candidateId, '$.candidateId')
    timestamp(item.createdAt, '$.createdAt')
    assertProposedSkill(item.proposedSkill)
    candidateProvenance(item.provenance)
    assertProjectedSkillEvidence(item.evidenceSummary)
    hash(item.fingerprint, '$.fingerprint')
    const validation = plainObject(item.validation, '$.validation')
    exactKeys(validation, ['blockers', 'warnings'], '$.validation')
    array(validation.blockers, '$.validation.blockers').forEach((finding, index) => {
      validationFinding(finding, `$.validation.blockers[${index}]`, 'blocker')
    })
    array(validation.warnings, '$.validation.warnings').forEach((finding, index) => {
      validationFinding(finding, `$.validation.warnings[${index}]`, 'warning')
    })
  })
}

export function assertSkillGenerationReceipt(value: unknown): asserts value is SkillGenerationReceiptV1 {
  within('INVALID_SKILL_GENERATION_RECEIPT', () => {
    const item = plainObject(value, '$')
    exactKeys(item, [
      'schemaVersion',
      'requestId',
      'processedAt',
      'status',
      'findings',
    ], '$', ['candidateId'])
    literal(item.schemaVersion, 'skill-generation-receipt/v1', '$.schemaVersion')
    safeId(item.requestId, '$.requestId')
    timestamp(item.processedAt, '$.processedAt')
    oneOf(item.status, ['generated', 'duplicate', 'ineligible', 'rejected'], '$.status')
    if (item.candidateId !== undefined) safeId(item.candidateId, '$.candidateId')
    if ((item.status === 'generated' || item.status === 'duplicate') && item.candidateId === undefined) {
      fail('$.candidateId is required for generated and duplicate receipts')
    }
    if ((item.status === 'ineligible' || item.status === 'rejected') && item.candidateId !== undefined) {
      fail('$.candidateId is forbidden for ineligible and rejected receipts')
    }
    array(item.findings, '$.findings').forEach((finding, index) => {
      validationFinding(finding, `$.findings[${index}]`)
    })
  })
}

function candidateProvenance(value: unknown): void {
  const item = plainObject(value, '$.provenance')
  exactKeys(item, [
    'requestId',
    'runId',
    'revision',
    'sessionId',
    'attempt',
    'outcomeArtifactId',
    'traceSha256',
    'generatorId',
    'generatorVersion',
  ], '$.provenance')
  safeId(item.requestId, '$.provenance.requestId')
  opaqueId(item.runId, '$.provenance.runId')
  positiveInteger(item.revision, '$.provenance.revision', true)
  opaqueId(item.sessionId, '$.provenance.sessionId')
  positiveInteger(item.attempt, '$.provenance.attempt')
  safeId(item.outcomeArtifactId, '$.provenance.outcomeArtifactId')
  hash(item.traceSha256, '$.provenance.traceSha256')
  safeId(item.generatorId, '$.provenance.generatorId')
  nonEmptyString(item.generatorVersion, '$.provenance.generatorVersion')
}

function taskContext(value: unknown): void {
  const item = plainObject(value, '$.task')
  exactKeys(item, [], '$.task', ['taskType', 'workflowPhase', 'domain'])
  for (const key of ['taskType', 'workflowPhase', 'domain'] as const) {
    if (item[key] !== undefined) nonEmptyString(item[key], `$.task.${key}`)
  }
}

function toolStep(value: unknown, index: number): void {
  const path = `$.successfulTools[${index}]`
  const item = plainObject(value, path)
  exactKeys(item, ['sequence', 'toolName'], path, ['toolCategory'])
  positiveInteger(item.sequence, `${path}.sequence`)
  nonEmptyString(item.toolName, `${path}.toolName`)
  if (item.toolCategory !== undefined) nonEmptyString(item.toolCategory, `${path}.toolCategory`)
}

function projectedAction(value: unknown, index: number): void {
  const path = `$.actions[${index}]`
  const item = plainObject(value, path)
  exactKeys(item, ['actionKind', 'outcome'], path)
  nonEmptyString(item.actionKind, `${path}.actionKind`)
  nonEmptyString(item.outcome, `${path}.outcome`)
}

function resolvedSkill(value: unknown, index: number): void {
  const path = `$.resolvedSkills[${index}]`
  const item = plainObject(value, path)
  exactKeys(item, ['id', 'source', 'reason'], path, ['bodyHash'])
  nonEmptyString(item.id, `${path}.id`)
  nonEmptyString(item.source, `${path}.source`)
  nonEmptyString(item.reason, `${path}.reason`)
  if (item.bodyHash !== undefined) hash(item.bodyHash, `${path}.bodyHash`)
}

function evidenceSource(value: unknown): void {
  const item = plainObject(value, '$.source')
  exactKeys(item, [
    'outcomeArtifactId',
    'outcomeSha256',
    'traceSha256',
    'resolvedSkillsSha256',
  ], '$.source')
  safeId(item.outcomeArtifactId, '$.source.outcomeArtifactId')
  hash(item.outcomeSha256, '$.source.outcomeSha256')
  hash(item.traceSha256, '$.source.traceSha256')
  hash(item.resolvedSkillsSha256, '$.source.resolvedSkillsSha256')
}

function validationFinding(
  value: unknown,
  path: string,
  expectedSeverity?: CandidateFindingSeverity,
): void {
  const item = plainObject(value, path)
  exactKeys(item, ['schemaVersion', 'severity', 'code', 'path', 'message'], path)
  literal(item.schemaVersion, 'skill-candidate-finding/v1', `${path}.schemaVersion`)
  oneOf(item.severity, ['blocker', 'warning'], `${path}.severity`)
  if (expectedSeverity !== undefined && item.severity !== expectedSeverity) {
    fail(`${path}.severity must be ${expectedSeverity}`)
  }
  nonEmptyString(item.code, `${path}.code`)
  nonEmptyString(item.path, `${path}.path`)
  nonEmptyString(item.message, `${path}.message`)
}

function skillTriggers(value: unknown): void {
  const item = plainObject(value, '$.triggers')
  exactKeys(item, [], '$.triggers', [
    'taskTypes',
    'domains',
    'urlPatterns',
    'workflowPhases',
    'toolNames',
  ])
  let triggerCount = 0
  for (const key of ['taskTypes', 'domains', 'urlPatterns', 'workflowPhases', 'toolNames'] as const) {
    if (item[key] === undefined) continue
    const entries = array(item[key], `$.triggers.${key}`)
    triggerCount += entries.length
    entries.forEach((entry, index) => {
      nonEmptyString(entry, `$.triggers.${key}[${index}]`)
    })
  }
  if (triggerCount === 0) fail('$.triggers must contain at least one bounded trigger')
}

function within(code: string, check: () => void): void {
  try {
    check()
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(`${code}:`)) throw error
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`${code}: ${message}`)
  }
}

function plainObject(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${path} must be a plain object`)
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) fail(`${path} must be a plain object`)
  return value as Record<string, unknown>
}

function exactKeys(
  value: Record<string, unknown>,
  required: string[],
  path: string,
  optional: string[] = [],
): void {
  const actual = Object.keys(value)
  const allowed = new Set([...required, ...optional])
  for (const key of required) {
    if (!Object.hasOwn(value, key)) fail(`${path} is missing ${key}`)
  }
  for (const key of actual) {
    if (!allowed.has(key)) fail(`${path} contains unexpected key ${key}`)
    if (value[key] === undefined) fail(`${path}.${key} must be omitted instead of undefined`)
  }
}

function array(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) fail(`${path} must be an array`)
  return value
}

function nonEmptyString(value: unknown, path: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) fail(`${path} must be a non-empty string`)
}

function safeId(value: unknown, path: string): asserts value is string {
  opaqueId(value, path)
}

function opaqueId(value: unknown, path: string): asserts value is string {
  nonEmptyString(value, path)
  if (!/^[a-zA-Z0-9._-]{1,120}$/.test(value) || value === '..' || value.includes('..')) {
    fail(`${path} must be a safe id`)
  }
}

function positiveInteger(value: unknown, path: string, allowZero = false): void {
  if (!Number.isInteger(value) || (value as number) < (allowZero ? 0 : 1)) {
    fail(`${path} must be ${allowZero ? 'a non-negative' : 'a positive'} integer`)
  }
}

function timestamp(value: unknown, path: string): void {
  nonEmptyString(value, path)
  const parsed = new Date(value)
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    fail(`${path} must be a canonical ISO timestamp`)
  }
}

function hash(value: unknown, path: string): asserts value is string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) fail(`${path} must be a SHA-256 hex digest`)
}

function literal(value: unknown, expected: string, path: string): void {
  if (value !== expected) fail(`${path} must be ${expected}`)
}

function oneOf(value: unknown, expected: readonly string[], path: string): void {
  if (typeof value !== 'string' || !expected.includes(value)) {
    fail(`${path} must be one of ${expected.join(', ')}`)
  }
}

function fail(message: string): never {
  throw new Error(message)
}
