import type {
  ActionOutcome,
  ArtifactRef,
  CompletionCriterion,
  CompletionFormState,
  EvidenceAuthority,
  EvidenceRef,
  EvidenceRequirement,
  TaskContract,
} from './contracts.js'

export interface CriterionEvaluation {
  id: string
  passed: boolean
  reason: string
  evidenceIds: string[]
  artifactIds: string[]
}

export interface CompletionContractEvaluation {
  schemaVersion: 'completion-contract-evaluation/v1'
  completed: boolean
  criteria: CriterionEvaluation[]
  missingCriteria: string[]
  evidenceIds: string[]
  artifactIds: string[]
}

export interface EvaluateCompletionContractInput {
  contract: TaskContract
  runId: string
  revision: number
  evidence: readonly EvidenceRef[]
  artifacts: readonly ArtifactRef[]
  formState?: CompletionFormState
  actions?: readonly ActionOutcome[]
  now?: Date
}

const AUTHORITATIVE = new Set<EvidenceAuthority>(['main_runtime', 'user'])

export function evaluateCompletionContract(input: EvaluateCompletionContractInput): CompletionContractEvaluation {
  const now = input.now ?? new Date()
  const evidence = uniqueRefs(input.evidence).filter((item) => evidenceIsCurrentAndVerified(item, input.runId, input.revision, now))
  const artifacts = uniqueRefs(input.artifacts).filter((item) => artifactIsUsable(item, input.runId, input.revision))
  const criteria = [
    ...input.contract.criteria.map((criterion) => evaluateCriterion(criterion, evidence, artifacts, input.formState, input.actions ?? [], now)),
    ...(input.contract.requiredEvidence ?? []).map((requirement) => evaluateEvidenceRequirement(requirement, evidence, now)),
  ]
  const requiredIds = new Set(input.contract.criteria.filter((criterion) => criterion.required !== false).map((criterion) => criterion.id))
  for (const requirement of input.contract.requiredEvidence ?? []) requiredIds.add(requirement.id)
  const missingCriteria = criteria.filter((item) => requiredIds.has(item.id) && !item.passed).map((item) => item.id)
  return {
    schemaVersion: 'completion-contract-evaluation/v1',
    completed: missingCriteria.length === 0,
    criteria,
    missingCriteria,
    evidenceIds: unique(criteria.flatMap((item) => item.evidenceIds)),
    artifactIds: unique(criteria.flatMap((item) => item.artifactIds)),
  }
}

export function evidenceIsCurrentAndVerified(evidence: EvidenceRef, runId: string, revision: number, now = new Date()): boolean {
  if (!AUTHORITATIVE.has(evidence.authority)) return false
  if (evidence.verificationStatus !== 'verified') return false
  if (evidence.freshness.validity !== 'current' && evidence.freshness.validity !== 'not_applicable') return false
  if (evidence.binding.runId !== runId || evidence.binding.revision !== revision) return false
  const createdAt = Date.parse(evidence.createdAt)
  if (!Number.isFinite(createdAt) || createdAt > now.getTime()) return false
  if (evidence.expiresAt && Date.parse(evidence.expiresAt) <= now.getTime()) return false
  return true
}

function artifactIsUsable(artifact: ArtifactRef, runId: string, revision: number): boolean {
  if (!artifact.immutable || artifact.binding.runId !== runId || artifact.binding.revision !== revision) return false
  if (artifact.redaction.status === 'rejected') return false
  if (artifact.scanner.status === 'quarantined' || artifact.scanner.status === 'rejected') return false
  if (artifact.requiresMainWorkflowVerification || artifact.authoritativeCompletionEvidence === false) {
    return artifact.origin !== 'subagent' && artifact.trust !== 'non_authoritative'
  }
  return true
}

function evaluateCriterion(
  criterion: CompletionCriterion,
  evidence: EvidenceRef[],
  artifacts: ArtifactRef[],
  formState: CompletionFormState | undefined,
  actions: readonly ActionOutcome[],
  now: Date,
): CriterionEvaluation {
  if (criterion.kind === 'evidence_present') {
    const matches = evidence.filter((item) => (
      criterion.evidenceKinds.includes(item.kind)
      && criterion.allowedAuthorities.includes(item.authority)
      && (criterion.maxAgeMs === undefined || now.getTime() - Date.parse(item.createdAt) <= criterion.maxAgeMs)
    ))
    return evaluated(criterion.id, matches.length >= criterion.minCount, `Found ${matches.length}/${criterion.minCount} required evidence item(s).`, matches.map((item) => item.id), [])
  }
  if (criterion.kind === 'artifact_present') {
    const matches = artifacts.filter((item) => criterion.artifactKinds.includes(item.kind) && (!criterion.schemaVersions?.length || criterion.schemaVersions.includes(item.payloadSchemaVersion)))
    return evaluated(criterion.id, matches.length >= criterion.minCount, `Found ${matches.length}/${criterion.minCount} required artifact(s).`, [], matches.map((item) => item.id))
  }
  if (criterion.kind === 'form_state') {
    const passed = Boolean(
      formState &&
      (!criterion.requireFullAudit || formState.audited) &&
      formState.requiredFieldCoverage >= criterion.requiredFieldCoverage &&
      (criterion.allowVisibleErrors || formState.visibleErrorCount === 0) &&
      (!criterion.requireDraftOnly || !formState.submitted),
    )
    return evaluated(criterion.id, passed, formState ? `Form audit=${formState.audited}, coverage=${formState.requiredFieldCoverage}, errors=${formState.visibleErrorCount}, submitted=${formState.submitted}.` : 'No verified form state was supplied.', [], [])
  }
  if (criterion.kind === 'human_confirmation') {
    const matches = evidence.filter((item) => item.authority === 'user' && item.kind === `user_confirmation:${criterion.confirmationKind}` && (!criterion.actionId || item.actionBinding?.actionId === criterion.actionId))
    return evaluated(criterion.id, matches.length > 0, matches.length ? 'Required human confirmation is present.' : 'Required human confirmation is missing.', matches.map((item) => item.id), [])
  }
  const passed = criterion.actionKinds.every((kind) => actions.some((action) => action.actionKind === kind && action.outcome === criterion.outcome))
  return evaluated(criterion.id, passed, passed ? `Required ${criterion.outcome} action boundary is satisfied.` : `Action boundary requires ${criterion.actionKinds.join(', ')}=${criterion.outcome}.`, [], [])
}

function evaluateEvidenceRequirement(requirement: EvidenceRequirement, evidence: EvidenceRef[], now: Date): CriterionEvaluation {
  const matches = evidence.filter((item) => {
    if (!requirement.kinds.includes(item.kind) || !requirement.allowedAuthorities.includes(item.authority)) return false
    if (requirement.origins?.length && !requirement.origins.includes(item.origin)) return false
    if (requirement.independentlyObserved && !item.independentlyObserved) return false
    if (requirement.maxAgeMs !== undefined && now.getTime() - Date.parse(item.createdAt) > requirement.maxAgeMs) return false
    return true
  })
  return evaluated(requirement.id, matches.length >= requirement.minCount, `Found ${matches.length}/${requirement.minCount} evidence requirement item(s).`, matches.map((item) => item.id), [])
}

function evaluated(id: string, passed: boolean, reason: string, evidenceIds: string[], artifactIds: string[]): CriterionEvaluation {
  return { id, passed, reason, evidenceIds, artifactIds }
}

function unique(values: string[]): string[] {
  return [...new Set(values)]
}

function uniqueRefs<T extends { id: string }>(values: readonly T[]): T[] {
  const seen = new Set<string>()
  return values.filter((value) => {
    if (seen.has(value.id)) return false
    seen.add(value.id)
    return true
  })
}
