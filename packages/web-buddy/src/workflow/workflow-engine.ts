import type { FormState } from '../observation/form-state.js'
import type { PageState } from '../observation/page-state.js'
import type { PolicyDecision, PolicyEngineDecision } from '../policy/agent-policy.js'
import type { ApprovalRequest, ApprovalResolution, PermissionDecision, PermissionRequest } from '../permission/permission-types.js'
import type { GateDecision, GateKind } from '../sdk/human.js'
import type { LocalToolRunResult } from '../tools/local-adapter.js'
import {
  jobApplicationWorkflowDefinition,
  type WorkflowCompletionCriterion,
  type WorkflowCompletionCriterionKind,
  type WorkflowDefinition,
  type WorkflowPhaseDefinition,
} from './workflow-definition.js'
import type { EvidenceKind, EvidenceStoreSnapshot, WorkflowEvidence } from './workflow-evidence.js'
import type { WorkflowPhase, WorkflowState } from './workflow-state.js'
import { transitionWorkflowState } from './workflow-transition.js'

export type WorkflowCriteriaKind = WorkflowCompletionCriterionKind | 'phase_required_evidence'
export type WorkflowBlockerKind = 'human_handoff' | 'workflow_blocked' | 'missing_evidence'

export interface WorkflowRecentAction {
  toolName?: string
  name?: string
  toolResult?: LocalToolRunResult | Record<string, unknown>
  result?: LocalToolRunResult | Record<string, unknown>
  policyDecision?: PolicyDecision
  gateKind?: GateKind
  gateDecision?: GateDecision
  agentDoneBlocked?: boolean
  done?: boolean
  blocked?: boolean
  at?: string
  summary?: string
}

export type WorkflowPolicyFact = PolicyDecision | PolicyEngineDecision

export type WorkflowPermissionFact =
  | PermissionRequest
  | PermissionDecision
  | {
      gateKind?: GateKind
      action?: string
      decision?: GateDecision
      status?: string
      reason?: string
      workflowPhase?: WorkflowPhase
      subject?: unknown
      policy?: { action?: string; gateKind?: GateKind; policyCode?: string; reason?: string }
    }

export type WorkflowApprovalFact =
  | ApprovalRequest
  | ApprovalResolution
  | {
      gateKind?: GateKind
      kind?: GateKind
      status?: string
      decision?: GateDecision
      reason?: string
      resolution?: { status?: string; decision?: GateDecision; reason?: string }
      context?: { workflowPhase?: string }
    }

export interface WorkflowEvidenceSnapshotLike {
  evidence?: WorkflowEvidence[]
  all?: WorkflowEvidence[]
  byKind?: Record<string, WorkflowEvidence[]>
}

export interface WorkflowEngineInput {
  previous: WorkflowState
  currentUrl?: string
  page?: PageState
  form?: FormState
  recentActions?: WorkflowRecentAction[]
  policyFacts?: WorkflowPolicyFact[]
  permissionFacts?: WorkflowPermissionFact[]
  approvalFacts?: WorkflowApprovalFact[]
  evidenceSnapshot?: EvidenceStoreSnapshot | WorkflowEvidence[] | WorkflowEvidenceSnapshotLike
  now?: string
}

export interface WorkflowCriterionMatch {
  id: string
  kind: WorkflowCriteriaKind
  description: string
  phase?: WorkflowPhase
  evidenceKinds: EvidenceKind[]
  evidenceIds: string[]
  reason: string
}

export interface WorkflowCriterionMissing {
  id: string
  kind: WorkflowCriteriaKind
  description: string
  phase?: WorkflowPhase
  evidenceKinds: EvidenceKind[]
  missingEvidenceKinds: EvidenceKind[]
  evidenceIds: string[]
  reason: string
}

export interface WorkflowBlocker {
  id: string
  kind: WorkflowBlockerKind
  message: string
  phase: WorkflowPhase
  gateKind?: GateKind
  criterionId?: string
  missingEvidenceKinds?: EvidenceKind[]
  evidenceIds?: string[]
}

export interface WorkflowEngineEvaluation {
  state: WorkflowState
  changed: boolean
  matchedCriteria: WorkflowCriterionMatch[]
  missingCriteria: WorkflowCriterionMissing[]
  blockers: WorkflowBlocker[]
  evidenceIds: string[]
  reason: string
}

interface RuntimeFacts {
  latestAction?: WorkflowRecentAction
  toolName?: string
  toolResult?: LocalToolRunResult
  policyDecision?: PolicyDecision
  gateKind?: GateKind
  gateDecision?: GateDecision
  agentDoneBlocked?: boolean
}

interface EvidenceLookup {
  all: WorkflowEvidence[]
  byKind: Map<string, WorkflowEvidence[]>
}

export class WorkflowEngine {
  constructor(private readonly definition: WorkflowDefinition<WorkflowPhase> = jobApplicationWorkflowDefinition) {}

  static evaluate(input: WorkflowEngineInput): WorkflowEngineEvaluation {
    return workflowEngine.evaluate(input)
  }

  evaluate(input: WorkflowEngineInput): WorkflowEngineEvaluation {
    const now = input.now ?? new Date().toISOString()
    const facts = runtimeFactsFor(input)
    const transition = transitionWorkflowState({
      previous: input.previous,
      currentUrl: input.currentUrl,
      page: input.page,
      form: input.form,
      toolName: facts.toolName,
      toolResult: facts.toolResult,
      policyDecision: facts.policyDecision,
      gateKind: facts.gateKind,
      gateDecision: facts.gateDecision,
      agentDoneBlocked: facts.agentDoneBlocked,
      now,
    })

    const state = withRequiredHandoffState(transition.state, input.previous, facts, this.definition, now)
    const evidence = evidenceLookupFor(input.evidenceSnapshot)
    const baseBlockers = handoffAndWorkflowBlockers(state, facts, this.definition)
    const { matchedCriteria, missingCriteria } = evaluateCriteria(this.definition, state, evidence, baseBlockers)
    const blockers = uniqueBlockers([
      ...baseBlockers,
      ...missingCriteria
        .filter((criterion) => criterion.kind !== 'phase_required_evidence')
        .map((criterion) => missingEvidenceBlocker(state, criterion)),
    ])
    const evidenceIds = unique(matchedCriteria.flatMap((criterion) => criterion.evidenceIds))

    return {
      state,
      changed: transition.changed || !sameWorkflowState(input.previous, state),
      matchedCriteria,
      missingCriteria,
      blockers,
      evidenceIds,
      reason: evaluationReason(state, matchedCriteria, missingCriteria, blockers),
    }
  }
}

export const workflowEngine = new WorkflowEngine()

function runtimeFactsFor(input: WorkflowEngineInput): RuntimeFacts {
  const latestAction = last(input.recentActions)
  const policyDecision = latestAction?.policyDecision ?? last(input.policyFacts)
  const latestPermission = last(input.permissionFacts)
  const latestApproval = last(input.approvalFacts)
  const gateKind =
    latestAction?.gateKind ??
    policyDecision?.gateKind ??
    gateKindFromPermission(latestPermission) ??
    gateKindFromApproval(latestApproval)
  const gateDecision =
    latestAction?.gateDecision ?? gateDecisionFromApproval(latestApproval) ?? gateDecisionFromPermission(latestPermission)

  return {
    ...(latestAction ? { latestAction } : {}),
    ...(toolNameFromAction(latestAction) ? { toolName: toolNameFromAction(latestAction) } : {}),
    ...(toolResultFromAction(latestAction) ? { toolResult: toolResultFromAction(latestAction) } : {}),
    ...(policyDecision ? { policyDecision } : {}),
    ...(gateKind ? { gateKind } : {}),
    ...(gateDecision ? { gateDecision } : {}),
    ...(agentDoneBlockedFromAction(latestAction) !== undefined
      ? { agentDoneBlocked: agentDoneBlockedFromAction(latestAction) }
      : {}),
  }
}

function withRequiredHandoffState(
  state: WorkflowState,
  previous: WorkflowState,
  facts: RuntimeFacts,
  definition: WorkflowDefinition<WorkflowPhase>,
  now: string,
): WorkflowState {
  const gateKind = humanHandoffGateKindFor(state, facts, definition)
  if (!gateKind && !(state.phase === 'blocked' && state.humanHandoffRequired)) return state

  const blocker = state.blocker ?? blockerMessageFor(gateKind, state.phase)
  if (state.humanHandoffRequired && state.blocker === blocker) return state

  return {
    ...state,
    humanHandoffRequired: true,
    blocker,
    updatedAt: now,
    ...(state.lastTransition
      ? { lastTransition: state.lastTransition }
      : state.phase !== previous.phase
        ? {
            lastTransition: {
              from: previous.phase,
              to: state.phase,
              reason: state.reason,
              at: now,
            },
          }
        : {}),
  }
}

function evaluateCriteria(
  definition: WorkflowDefinition<WorkflowPhase>,
  state: WorkflowState,
  evidence: EvidenceLookup,
  blockers: WorkflowBlocker[],
): { matchedCriteria: WorkflowCriterionMatch[]; missingCriteria: WorkflowCriterionMissing[] } {
  const matchedCriteria: WorkflowCriterionMatch[] = []
  const missingCriteria: WorkflowCriterionMissing[] = []
  const phaseDefinition = phaseDefinitionFor(definition, state.phase)
  const phaseRequiredKinds = phaseDefinition?.requiredEvidenceKinds ?? []

  if (phaseDefinition && phaseRequiredKinds.length > 0) {
    pushEvidenceCriterion({
      id: `phase-${state.phase}-required-evidence`,
      kind: 'phase_required_evidence',
      description: `Phase ${state.phase} requires ${phaseRequiredKinds.join(', ')} evidence.`,
      phase: state.phase,
      evidenceKinds: phaseRequiredKinds,
      evidence,
      matchedCriteria,
      missingCriteria,
    })
  }

  for (const criterion of definition.completionCriteria) {
    if (!criterionApplies(criterion, state, blockers)) continue

    if (criterion.kind === 'human_handoff') {
      pushHumanHandoffCriterion(criterion, state, evidence, blockers, matchedCriteria, missingCriteria)
      continue
    }

    if (criterion.kind === 'phase_reached') {
      matchedCriteria.push({
        id: criterion.id,
        kind: criterion.kind,
        description: criterion.description,
        ...(criterion.phase ? { phase: criterion.phase } : {}),
        evidenceKinds: [],
        evidenceIds: [],
        reason: `Workflow phase ${state.phase} satisfies the phase-reached criterion.`,
      })
      continue
    }

    pushEvidenceCriterion({
      id: criterion.id,
      kind: criterion.kind,
      description: criterion.description,
      phase: criterion.phase,
      evidenceKinds: criterion.evidenceKinds ?? [],
      evidence,
      matchedCriteria,
      missingCriteria,
    })
  }

  return {
    matchedCriteria: uniqueCriteria(matchedCriteria),
    missingCriteria: uniqueCriteria(missingCriteria),
  }
}

function pushHumanHandoffCriterion(
  criterion: WorkflowCompletionCriterion<WorkflowPhase>,
  state: WorkflowState,
  evidence: EvidenceLookup,
  blockers: WorkflowBlocker[],
  matchedCriteria: WorkflowCriterionMatch[],
  missingCriteria: WorkflowCriterionMissing[],
): void {
  const evidenceKinds = criterion.evidenceKinds ?? []
  const evidenceIds = evidenceIdsForKinds(evidence, evidenceKinds)
  const handoffBlockers = blockers.filter((blocker) => blocker.kind === 'human_handoff')
  if (handoffBlockers.length > 0) {
    matchedCriteria.push({
      id: criterion.id,
      kind: criterion.kind,
      description: criterion.description,
      phase: state.phase,
      evidenceKinds,
      evidenceIds,
      reason: `Human handoff blocker is present for ${handoffBlockers.map((blocker) => blocker.gateKind ?? state.phase).join(', ')}.`,
    })
    return
  }

  missingCriteria.push({
    id: criterion.id,
    kind: criterion.kind,
    description: criterion.description,
    phase: state.phase,
    evidenceKinds,
    missingEvidenceKinds: [],
    evidenceIds,
    reason: 'Human handoff semantics are required but no handoff blocker was produced.',
  })
}

function pushEvidenceCriterion(input: {
  id: string
  kind: WorkflowCriteriaKind
  description: string
  phase?: WorkflowPhase
  evidenceKinds: EvidenceKind[]
  evidence: EvidenceLookup
  matchedCriteria: WorkflowCriterionMatch[]
  missingCriteria: WorkflowCriterionMissing[]
}): void {
  const evidenceIds = evidenceIdsForKinds(input.evidence, input.evidenceKinds)
  const missingEvidenceKinds = input.evidenceKinds.filter((kind) => evidenceIdsForKinds(input.evidence, [kind]).length === 0)

  if (missingEvidenceKinds.length === 0) {
    input.matchedCriteria.push({
      id: input.id,
      kind: input.kind,
      description: input.description,
      ...(input.phase ? { phase: input.phase } : {}),
      evidenceKinds: input.evidenceKinds,
      evidenceIds,
      reason:
        input.evidenceKinds.length > 0
          ? `Found required evidence: ${input.evidenceKinds.join(', ')}.`
          : 'Criterion does not require evidence.',
    })
    return
  }

  input.missingCriteria.push({
    id: input.id,
    kind: input.kind,
    description: input.description,
    ...(input.phase ? { phase: input.phase } : {}),
    evidenceKinds: input.evidenceKinds,
    missingEvidenceKinds,
    evidenceIds,
    reason: `Missing required evidence: ${missingEvidenceKinds.join(', ')}.`,
  })
}

function criterionApplies(
  criterion: WorkflowCompletionCriterion<WorkflowPhase>,
  state: WorkflowState,
  blockers: WorkflowBlocker[],
): boolean {
  if (criterion.kind === 'human_handoff') return state.humanHandoffRequired === true || hasHumanHandoffBlocker(blockers)
  if (criterion.phase) return criterion.phase === state.phase
  if (criterion.kind === 'blocked') return state.phase === 'blocked'
  return criterion.required === true
}

function handoffAndWorkflowBlockers(
  state: WorkflowState,
  facts: RuntimeFacts,
  definition: WorkflowDefinition<WorkflowPhase>,
): WorkflowBlocker[] {
  const blockers: WorkflowBlocker[] = []
  const gateKind = humanHandoffGateKindFor(state, facts, definition)

  if (gateKind || state.humanHandoffRequired) {
    blockers.push({
      id: gateKind ? `human-handoff-${gateKind}` : `human-handoff-${state.phase}`,
      kind: 'human_handoff',
      message: state.blocker ?? blockerMessageFor(gateKind, state.phase),
      phase: state.phase,
      ...(gateKind ? { gateKind } : {}),
    })
  }

  if (state.phase === 'blocked') {
    blockers.push({
      id: 'workflow-blocked',
      kind: 'workflow_blocked',
      message: state.blocker ?? state.reason,
      phase: state.phase,
      ...(gateKind ? { gateKind } : {}),
    })
  }

  return blockers
}

function missingEvidenceBlocker(state: WorkflowState, criterion: WorkflowCriterionMissing): WorkflowBlocker {
  return {
    id: `missing-evidence-${criterion.id}`,
    kind: 'missing_evidence',
    message: criterion.reason,
    phase: state.phase,
    criterionId: criterion.id,
    missingEvidenceKinds: criterion.missingEvidenceKinds,
    evidenceIds: criterion.evidenceIds,
  }
}

function humanHandoffGateKindFor(
  state: WorkflowState,
  facts: RuntimeFacts,
  definition: WorkflowDefinition<WorkflowPhase>,
): GateKind | undefined {
  if (state.phase === 'login_required') return 'login'
  if (state.phase === 'captcha_required') return 'captcha'
  if (state.phase === 'direct_submit_review') return 'final_submit'
  if (state.phase === 'ready_for_final_submit') return 'final_submit'
  if (facts.gateKind === 'login' || facts.gateKind === 'captcha' || facts.gateKind === 'final_submit') return facts.gateKind
  return undefined
}

function blockerMessageFor(gateKind: GateKind | undefined, phase: WorkflowPhase): string {
  if (gateKind === 'login' || phase === 'login_required') return 'Human login required before continuing.'
  if (gateKind === 'captcha' || phase === 'captcha_required') return 'Human verification required before continuing.'
  if (phase === 'direct_submit_review') {
    return 'Direct-submit review required: no fillable fields were found and the next step is final submit.'
  }
  if (gateKind === 'final_submit' || phase === 'ready_for_final_submit') {
    return 'Final submit requires human takeover before completion.'
  }
  return 'Workflow requires human action before continuing.'
}

function evidenceLookupFor(snapshot: WorkflowEngineInput['evidenceSnapshot']): EvidenceLookup {
  const all = uniqueEvidence(evidenceListFor(snapshot))
  const byKind = new Map<string, WorkflowEvidence[]>()
  for (const item of all) {
    byKind.set(item.kind, [...(byKind.get(item.kind) ?? []), item])
  }
  return { all, byKind }
}

function evidenceListFor(snapshot: WorkflowEngineInput['evidenceSnapshot']): WorkflowEvidence[] {
  if (!snapshot) return []
  if (Array.isArray(snapshot)) return snapshot.map(cloneEvidence)

  const candidate = snapshot as WorkflowEvidenceSnapshotLike
  if (candidate.all) return candidate.all.map(cloneEvidence)
  if (candidate.evidence) return candidate.evidence.map(cloneEvidence)
  if (candidate.byKind) return Object.values(candidate.byKind).flat().map(cloneEvidence)
  return []
}

function evidenceIdsForKinds(evidence: EvidenceLookup, kinds: EvidenceKind[]): string[] {
  return unique(kinds.flatMap((kind) => evidence.byKind.get(kind) ?? []).map((item) => item.id))
}

function gateKindFromPermission(fact: WorkflowPermissionFact | undefined): GateKind | undefined {
  const record = asRecord(fact)
  const direct = gateKindValue(record.gateKind)
  if (direct) return direct

  const subject = asRecord(record.subject)
  const subjectKind = typeof subject.kind === 'string' ? subject.kind : undefined
  if (subjectKind === 'workflow_handoff') return gateKindValue(subject.handoffKind)

  const policy = asRecord(record.policy)
  return gateKindValue(policy.gateKind)
}

function gateDecisionFromPermission(fact: WorkflowPermissionFact | undefined): GateDecision | undefined {
  const record = asRecord(fact)
  const direct = gateDecisionValue(record.decision)
  if (direct) return direct
  if (record.action === 'deny') return 'decline'
  return undefined
}

function gateKindFromApproval(fact: WorkflowApprovalFact | undefined): GateKind | undefined {
  const record = asRecord(fact)
  return gateKindValue(record.gateKind) ?? gateKindValue(record.kind)
}

function gateDecisionFromApproval(fact: WorkflowApprovalFact | undefined): GateDecision | undefined {
  const record = asRecord(fact)
  const resolution = asRecord(record.resolution)
  const direct = gateDecisionValue(record.decision) ?? gateDecisionValue(resolution.decision)
  if (direct) return direct
  const status = String(record.status ?? resolution.status ?? '')
  if (status === 'approved') return 'approve'
  if (status === 'denied' || status === 'expired' || status === 'cancelled') return 'decline'
  return undefined
}

function gateKindValue(value: unknown): GateKind | undefined {
  if (
    value === 'login' ||
    value === 'captcha' ||
    value === 'upload_resume' ||
    value === 'save_resume' ||
    value === 'final_submit' ||
    value === 'high_risk_action'
  ) {
    return value
  }
  return undefined
}

function gateDecisionValue(value: unknown): GateDecision | undefined {
  if (value === 'approve' || value === 'decline' || value === 'takeover') return value
  return undefined
}

function toolNameFromAction(action: WorkflowRecentAction | undefined): string | undefined {
  return action?.toolName ?? action?.name
}

function toolResultFromAction(action: WorkflowRecentAction | undefined): LocalToolRunResult | undefined {
  const result = action?.toolResult ?? action?.result
  const record = asRecord(result)
  const observation =
    typeof record.observation === 'string'
      ? record.observation
      : typeof action?.summary === 'string'
        ? action.summary
        : undefined
  if (!observation) return undefined

  return {
    observation,
    ...(record.data !== undefined ? { data: record.data } : {}),
    ...(typeof record.pageChanged === 'boolean' ? { pageChanged: record.pageChanged } : {}),
    ...(typeof record.done === 'boolean' ? { done: record.done } : {}),
  }
}

function agentDoneBlockedFromAction(action: WorkflowRecentAction | undefined): boolean | undefined {
  if (!action) return undefined
  if (typeof action.agentDoneBlocked === 'boolean') return action.agentDoneBlocked
  if (toolNameFromAction(action) !== 'agent_done' && action.done !== true) return undefined
  if (typeof action.blocked === 'boolean') return action.blocked

  const result = asRecord(action.toolResult ?? action.result)
  const data = asRecord(result.data)
  if (typeof data.blocked === 'boolean') return data.blocked
  return undefined
}

function phaseDefinitionFor(
  definition: WorkflowDefinition<WorkflowPhase>,
  phase: WorkflowPhase,
): WorkflowPhaseDefinition<WorkflowPhase> | undefined {
  return definition.phases.find((candidate) => candidate.phase === phase || candidate.id === phase)
}

function evaluationReason(
  state: WorkflowState,
  matchedCriteria: WorkflowCriterionMatch[],
  missingCriteria: WorkflowCriterionMissing[],
  blockers: WorkflowBlocker[],
): string {
  const blockerText = blockers.length > 0 ? ` Blockers: ${blockers.map((blocker) => blocker.message).join(' | ')}.` : ''
  const missingText =
    missingCriteria.length > 0
      ? ` Missing criteria: ${missingCriteria.map((criterion) => criterion.id).join(', ')}.`
      : ''
  return `Workflow evaluated as ${state.phase}: ${state.reason} Matched ${matchedCriteria.length} criteria.${missingText}${blockerText}`
}

function sameWorkflowState(left: WorkflowState, right: WorkflowState): boolean {
  return (
    left.phase === right.phase &&
    left.confidence === right.confidence &&
    left.reason === right.reason &&
    left.humanHandoffRequired === right.humanHandoffRequired &&
    left.blocker === right.blocker
  )
}

function hasHumanHandoffBlocker(blockers: WorkflowBlocker[]): boolean {
  return blockers.some((blocker) => blocker.kind === 'human_handoff')
}

function uniqueCriteria<T extends { id: string }>(criteria: T[]): T[] {
  const seen = new Set<string>()
  const result: T[] = []
  for (const criterion of criteria) {
    if (seen.has(criterion.id)) continue
    seen.add(criterion.id)
    result.push(criterion)
  }
  return result
}

function uniqueBlockers(blockers: WorkflowBlocker[]): WorkflowBlocker[] {
  return uniqueCriteria(blockers)
}

function uniqueEvidence(evidence: WorkflowEvidence[]): WorkflowEvidence[] {
  return uniqueCriteria(evidence)
}

function unique(values: string[]): string[] {
  return [...new Set(values)]
}

function last<T>(values: T[] | undefined): T | undefined {
  return values && values.length > 0 ? values[values.length - 1] : undefined
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

function cloneEvidence(evidence: WorkflowEvidence): WorkflowEvidence {
  return {
    ...evidence,
    ...(evidence.data ? { data: { ...evidence.data } } : {}),
    ...(evidence.metadata ? { metadata: { ...evidence.metadata } } : {}),
  }
}
