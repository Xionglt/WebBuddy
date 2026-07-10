import type { FillLedgerSummary } from '../fill/fill-ledger.js'
import type { FormCoverage, FormState } from '../observation/form-state.js'
import type { PageState } from '../observation/page-state.js'
import type { PolicyDecision, PolicyEngineDecision } from '../policy/agent-policy.js'
import type { ApprovalRequest, ApprovalResolution, PermissionDecision, PermissionRequest } from '../permission/permission-types.js'
import type { GateDecision, GateKind } from '../sdk/human.js'
import type { LocalToolRunResult } from '../tools/local-adapter.js'
import type { WebBuddyTaskType } from './completion-gate.js'
import { classifyObservationPhase, type ObservationPhase } from './phase-classifier.js'
import { evaluateTaskCompletion, type TaskCompletionVerdict } from './task-completion.js'
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
  summary?: string
  taskType?: WebBuddyTaskType
  formCoverage?: FormCoverage
  fillLedgerSummary?: FillLedgerSummary
  requiresCurrentResumeUpload?: boolean
  currentResumeUploaded?: boolean
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
  observationPhase?: ObservationPhase
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
    const observationFacts = contextualRuntimeFactsFor(input, facts)
    const policyFacts = contextualPolicyFactsFor(input)
    const permissionFacts = contextualPermissionFactsFor(input)
    const transition = transitionWorkflowState({
      previous: input.previous,
      currentUrl: input.currentUrl,
      page: input.page,
      form: input.form,
      toolName: observationFacts.toolName,
      toolResult: observationFacts.toolResult,
      policyDecision: observationFacts.policyDecision,
      gateKind: observationFacts.gateKind,
      gateDecision: observationFacts.gateDecision,
      agentDoneBlocked: observationFacts.agentDoneBlocked,
      now,
    })

    const evidence = evidenceLookupFor(input.evidenceSnapshot)
    const transitionedState = withRequiredHandoffState(transition.state, input.previous, observationFacts, this.definition, now)
    const preliminaryBlockers = handoffAndWorkflowBlockers(transitionedState, observationFacts, this.definition)
    const taskCompletionVerdict = taskCompletionVerdictFor(input, transitionedState, evidence, now)
    const observationPhase = classifyObservationPhase({
      page: input.page,
      form: input.form,
      blockers: preliminaryBlockers,
      ...(taskCompletionVerdict ? { taskCompletionVerdict } : {}),
      policyFacts,
      permissionFacts,
      externalBlockerVisible: transitionedState.phase === 'external_blocker',
      summary: input.summary ?? observationFacts.latestAction?.summary ?? observationFacts.toolResult?.observation,
    })
    const classifiedState = withObservationPhase(
      transitionStatePhase(transitionedState, input.previous, observationPhase, now),
      observationPhase,
    )
    const stateForEvaluation = withRequiredHandoffState(classifiedState, input.previous, observationFacts, this.definition, now)
    const baseBlockers = handoffAndWorkflowBlockers(stateForEvaluation, observationFacts, this.definition)
    const { matchedCriteria, missingCriteria } = evaluateCriteria(this.definition, stateForEvaluation, evidence, baseBlockers)
    const blockers = uniqueBlockers([
      ...baseBlockers,
      ...missingCriteria
        .filter((criterion) => criterion.kind !== 'phase_required_evidence')
        .map((criterion) => missingEvidenceBlocker(stateForEvaluation, criterion)),
    ])
    const evidenceIds = unique(matchedCriteria.flatMap((criterion) => criterion.evidenceIds))

    return {
      state: stateForEvaluation,
      observationPhase,
      changed: transition.changed || !sameWorkflowState(input.previous, stateForEvaluation),
      matchedCriteria,
      missingCriteria,
      blockers,
      evidenceIds,
      reason: evaluationReason(stateForEvaluation, matchedCriteria, missingCriteria, blockers),
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

function contextualRuntimeFactsFor(input: WorkflowEngineInput, facts: RuntimeFacts): RuntimeFacts {
  if (!shouldIgnoreStaleFinalSubmitFacts(input, facts)) return facts

  return {
    ...(facts.latestAction ? { latestAction: facts.latestAction } : {}),
    ...(facts.toolName ? { toolName: facts.toolName } : {}),
    ...(facts.toolResult ? { toolResult: facts.toolResult } : {}),
    ...(facts.policyDecision && !isFinalSubmitPolicyFact(facts.policyDecision) ? { policyDecision: facts.policyDecision } : {}),
    ...(facts.gateKind && facts.gateKind !== 'final_submit' ? { gateKind: facts.gateKind } : {}),
    ...(facts.gateKind && facts.gateKind !== 'final_submit' && facts.gateDecision ? { gateDecision: facts.gateDecision } : {}),
    ...(facts.agentDoneBlocked !== undefined ? { agentDoneBlocked: facts.agentDoneBlocked } : {}),
  }
}

function contextualPolicyFactsFor(input: WorkflowEngineInput): WorkflowPolicyFact[] | undefined {
  if (!shouldIgnoreStaleFinalSubmitFacts(input, runtimeFactsFor(input))) return input.policyFacts
  return input.policyFacts?.filter((fact) => !isFinalSubmitPolicyFact(fact))
}

function contextualPermissionFactsFor(input: WorkflowEngineInput): WorkflowPermissionFact[] | undefined {
  if (!shouldIgnoreStaleFinalSubmitFacts(input, runtimeFactsFor(input))) return input.permissionFacts
  return input.permissionFacts?.filter((fact) => gateKindFromPermission(fact) !== 'final_submit')
}

function shouldIgnoreStaleFinalSubmitFacts(input: WorkflowEngineInput, facts: RuntimeFacts): boolean {
  if (!hasCurrentObservation(input)) return false
  if (currentObservationHasFinalSubmitSurface(input)) return false
  return (
    facts.gateKind === 'final_submit' ||
    isFinalSubmitPolicyFact(facts.policyDecision) ||
    input.policyFacts?.some(isFinalSubmitPolicyFact) === true ||
    input.permissionFacts?.some((fact) => gateKindFromPermission(fact) === 'final_submit') === true ||
    input.approvalFacts?.some((fact) => gateKindFromApproval(fact) === 'final_submit') === true
  )
}

function hasCurrentObservation(input: WorkflowEngineInput): boolean {
  return Boolean(input.page || input.form || input.currentUrl || input.summary)
}

function currentObservationHasFinalSubmitSurface(input: WorkflowEngineInput): boolean {
  const formSubmit = input.form?.submitCandidates.some((candidate) => {
    if (candidate.visible === false) return false
    if (APPLY_ENTRY_TEXT.test(candidate.text)) return false
    return candidate.risk === 'L3' || candidate.risk === 'L4' || FINAL_SUBMIT_TEXT.test(candidate.text)
  })
  if (formSubmit) return true

  const finalButton = input.page?.facts?.likelyFinalSubmitButtons.some(
    (button) => button.visible !== false && FINAL_SUBMIT_TEXT.test(button.text),
  )
  if (finalButton) return true

  const dialog = input.page?.facts?.visibleBlockingDialog
  if (dialog?.present && /quota|final_submit|submit/i.test(String(dialog.kind ?? ''))) return true

  const text = [input.summary, input.page?.title, input.page?.textSummary, input.form?.visibleErrors?.join(' ')]
    .filter(Boolean)
    .join(' ')
  return FINAL_SUBMIT_CONTEXT_TEXT.test(text)
}

function isFinalSubmitPolicyFact(fact: WorkflowPolicyFact | undefined): boolean {
  if (!fact) return false
  return fact.gateKind === 'final_submit' || FINAL_SUBMIT_CONTEXT_TEXT.test([fact.reason, fact.policyCode].filter(Boolean).join(' '))
}

const FINAL_SUBMIT_TEXT =
  /确认投递|提交申请|完成投递|确认提交|递交申请|最终提交|final submit|submit application|complete application|finish application|confirm and submit|publish application|submit$/i
const APPLY_ENTRY_TEXT =
  /^(投递简历|立即投递|申请职位|开始申请|start application|apply now|apply)$/i
const FINAL_SUBMIT_CONTEXT_TEXT =
  /最终提交|final submit|submit application|complete application|finish application|confirm and submit|确认投递|确认提交|提交申请|递交申请|温馨提示.*(申请|投递)|本月.*还能.*(申请|投递)|申请名额|投递名额/i

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

function taskCompletionVerdictFor(
  input: WorkflowEngineInput,
  state: WorkflowState,
  evidence: EvidenceLookup,
  now: string,
): Pick<TaskCompletionVerdict, 'targetStateReached' | 'externalBlockerVisible'> | undefined {
  if (!input.taskType) {
    if (state.phase === 'done') return { targetStateReached: true, externalBlockerVisible: false }
    return undefined
  }

  const verdict = evaluateTaskCompletion({
    taskType: input.taskType,
    page: input.page,
    form: input.form,
    formCoverage: input.formCoverage ?? input.form?.formCoverage ?? input.previous.formCoverage,
    fillLedgerSummary: input.fillLedgerSummary ?? input.previous.fillLedgerSummary,
    requiresCurrentResumeUpload: input.requiresCurrentResumeUpload,
    currentResumeUploaded: input.currentResumeUploaded ?? input.previous.currentResumeUploaded,
    summary: input.summary,
    evidenceSnapshot: evidenceStoreSnapshotFor(evidence, now),
  })
  const targetStateReached = verdict.targetStateReached ||
    (verdict.externalBlockerVisible !== true && fillFormTargetReachedFromWorkflowEvidence(input, evidence))

  return {
    targetStateReached,
    externalBlockerVisible: verdict.externalBlockerVisible,
  }
}

function fillFormTargetReachedFromWorkflowEvidence(input: WorkflowEngineInput, evidence: EvidenceLookup): boolean {
  if (input.taskType !== 'fill_form') return false
  if ((evidence.byKind.get('form') ?? []).length === 0) return false

  const ledger = input.fillLedgerSummary ?? input.previous.fillLedgerSummary
  if (!ledger || ledger.total <= 0) return false
  if (ledger.pendingRequired !== 0 || ledger.failed !== 0 || ledger.needsUser !== 0) return false
  if (ledger.verified + ledger.skipped < ledger.total) return false

  const currentResumeUploaded = input.currentResumeUploaded ?? input.previous.currentResumeUploaded
  if (input.requiresCurrentResumeUpload && currentResumeUploaded !== true) return false

  const form = input.form
  if (!form) return false
  if (form.missingRequired.length > 0 || form.missingRequiredMayBeIncomplete === true) return false
  if ((form.visibleErrors ?? []).some((error) => /\S/.test(error))) return false

  const coverage = input.formCoverage ?? form.formCoverage ?? input.previous.formCoverage
  return legacyFormCoverageHasNoRequiredGap(coverage)
}

function legacyFormCoverageHasNoRequiredGap(coverage: FormCoverage | undefined): boolean {
  const record = asRecord(coverage)
  const uncoveredRequired = record.uncoveredRequired
  if (!Array.isArray(uncoveredRequired) || uncoveredRequired.length > 0) return false
  if (record.scrolledBottom !== true) return false

  const coveredFields = numberValue(record.coveredFields)
  const visibleFields = numberValue(record.visibleFields)
  const totalFields = numberValue(record.totalFields)
  if (coveredFields === undefined) return true
  if (visibleFields !== undefined && coveredFields < visibleFields) return false
  if (totalFields !== undefined && coveredFields < totalFields) return false
  return true
}

function transitionStatePhase(state: WorkflowState, previous: WorkflowState, phase: WorkflowPhase, now: string): WorkflowState {
  if (state.phase === phase) return state
  return {
    ...state,
    phase,
    reason: phaseReason(phase, state.reason),
    updatedAt: now,
    ...(phase === 'external_blocker' || phase === 'final_submit_boundary' || phase === 'blocked'
      ? { humanHandoffRequired: true, blocker: state.blocker ?? blockerMessageFor(undefined, phase) }
      : {}),
    ...(phase === 'in_target_flow' || phase === 'done'
      ? { humanHandoffRequired: undefined, blocker: undefined }
      : {}),
    lastTransition: {
      from: previous.phase,
      to: phase,
      reason: phaseReason(phase, state.reason),
      at: now,
    },
  }
}

function withObservationPhase(state: WorkflowState, observationPhase: ObservationPhase): WorkflowState {
  if (state.observationPhase === observationPhase) return state
  return {
    ...state,
    observationPhase,
  }
}

function humanHandoffGateKindFor(
  state: WorkflowState,
  facts: RuntimeFacts,
  definition: WorkflowDefinition<WorkflowPhase>,
): GateKind | undefined {
  if (state.phase === 'final_submit_boundary') return 'final_submit'
  if (state.phase === 'external_blocker' && (facts.gateKind === 'login' || facts.gateKind === 'captcha')) return facts.gateKind
  if (state.phase === 'external_blocker' && /captcha|verification|验证码|人机验证/i.test(state.blocker ?? state.reason)) return 'captcha'
  if (state.phase === 'external_blocker' && /login|sign in|sso|登录|登陆/i.test(state.blocker ?? state.reason)) return 'login'
  if (facts.gateKind === 'final_submit') return facts.gateKind
  if ((facts.gateKind === 'login' || facts.gateKind === 'captcha') && facts.gateDecision !== 'approve') return facts.gateKind
  return undefined
}

function blockerMessageFor(gateKind: GateKind | undefined, phase: WorkflowPhase): string {
  if (gateKind === 'login') return 'Human login required before continuing.'
  if (gateKind === 'captcha') return 'Human verification required before continuing.'
  if (gateKind === 'final_submit' || phase === 'final_submit_boundary') {
    return 'Final submit requires human takeover before completion.'
  }
  if (phase === 'external_blocker') return 'External blocker requires human action before continuing.'
  if (phase === 'blocked') return 'Workflow is blocked until human input or external state changes.'
  return 'Workflow requires human action before continuing.'
}

function phaseReason(phase: WorkflowPhase, fallback: string): string {
  if (phase === 'done') return 'Task completion evidence reached the requested target state.'
  if (phase === 'external_blocker') return 'Current observation shows an external blocker.'
  if (phase === 'final_submit_boundary') return 'Current observation shows a final-submit boundary.'
  if (phase === 'blocked') return 'Current observation shows the workflow is blocked.'
  return fallback || 'Current observation remains inside the requested target flow.'
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

function evidenceStoreSnapshotFor(evidence: EvidenceLookup, now: string): EvidenceStoreSnapshot {
  const byKind: Record<string, WorkflowEvidence[]> = {}
  const countsByKind: Record<string, number> = {}
  for (const item of evidence.all) {
    byKind[item.kind] = [...(byKind[item.kind] ?? []), cloneEvidence(item)]
    countsByKind[item.kind] = (countsByKind[item.kind] ?? 0) + 1
  }

  return {
    schemaVersion: 'evidence-store-snapshot/v1',
    version: 1,
    generatedAt: now,
    total: evidence.all.length,
    kinds: Object.keys(countsByKind),
    countsByKind,
    evidence: evidence.all.map(cloneEvidence),
    byKind,
    all: evidence.all.map(cloneEvidence),
  }
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

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function cloneEvidence(evidence: WorkflowEvidence): WorkflowEvidence {
  return {
    ...evidence,
    ...(evidence.data ? { data: { ...evidence.data } } : {}),
    ...(evidence.metadata ? { metadata: { ...evidence.metadata } } : {}),
  }
}
