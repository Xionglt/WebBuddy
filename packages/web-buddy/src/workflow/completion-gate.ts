import type {
  WorkflowBlocker,
  WorkflowCriterionMissing,
  WorkflowEngineEvaluation,
} from './workflow-engine.js'
import type { EvidenceKind } from './workflow-evidence.js'
import type { WorkflowPhase, WorkflowState } from './workflow-state.js'

export type CompletionGateAction = 'allow' | 'block' | 'ignore'
export type CompletionGateRecommendedStatus = 'completed' | 'blocked' | 'unchanged'

export interface CompletionGateInput {
  done: boolean
  blocked: boolean
  summary?: string
  workflowState?: WorkflowState
  workflowEvaluation?: WorkflowEngineEvaluation
  source?: 'agent_done' | 'finalize' | 'manual' | (string & {})
}

export interface CompletionGateDecision {
  schemaVersion: 'completion-gate-decision/v1'
  action: CompletionGateAction
  recommendedStatus: CompletionGateRecommendedStatus
  reason: string
  missingCriteria: WorkflowCriterionMissing[]
  blockers: WorkflowBlocker[]
  workflowPhase?: WorkflowPhase | string
  evidenceIds: string[]
}

const CRITICAL_MISSING_EVIDENCE_KINDS = new Set<EvidenceKind>([
  'tool_result',
  'policy',
  'permission',
  'approval',
  'user_confirm',
  'workflow_state',
])

export class CompletionGate {
  static evaluate(input: CompletionGateInput): CompletionGateDecision {
    return completionGate.evaluate(input)
  }

  evaluate(input: CompletionGateInput): CompletionGateDecision {
    const evaluation = input.workflowEvaluation
    const workflowPhase = evaluation?.state.phase ?? input.workflowState?.phase
    const missingCriteria = copyMissingCriteria(evaluation?.missingCriteria ?? [])
    const blockers = copyBlockers(evaluation?.blockers ?? [])
    const evidenceIds = evidenceIdsFor(evaluation, missingCriteria, blockers)

    if (!input.done) {
      return decision({
        action: 'ignore',
        recommendedStatus: 'unchanged',
        reason: completionReason('Completion gate ignored because runtime has not received a done signal.', input),
        missingCriteria,
        blockers,
        workflowPhase,
        evidenceIds,
      })
    }

    if (input.blocked) {
      return decision({
        action: 'block',
        recommendedStatus: 'blocked',
        reason: completionReason('Completion gate blocked completion because runtime already marked the attempt as blocked.', input),
        missingCriteria,
        blockers,
        workflowPhase,
        evidenceIds,
      })
    }

    if (!evaluation) {
      return decision({
        action: 'ignore',
        recommendedStatus: 'unchanged',
        reason: completionReason('Completion gate ignored the done signal because no workflow evaluation is available.', input),
        missingCriteria,
        blockers,
        workflowPhase,
        evidenceIds,
      })
    }

    if (workflowPhase === 'direct_submit_review') {
      return decision({
        action: 'block',
        recommendedStatus: 'blocked',
        reason: completionReason(
          'Completion gate blocked completion because the workflow is in direct-submit review: the site uses an online resume/direct-submit mode, no fillable fields are available, and the next step is final submit.',
          input,
        ),
        missingCriteria,
        blockers,
        workflowPhase,
        evidenceIds,
      })
    }

    if (workflowPhase === 'ready_for_final_submit') {
      return decision({
        action: 'block',
        recommendedStatus: 'blocked',
        reason: completionReason(
          'Completion gate blocked completion because the workflow is ready for final submit and requires human takeover before completion.',
          input,
        ),
        missingCriteria,
        blockers,
        workflowPhase,
        evidenceIds,
      })
    }

    if (workflowPhase === 'blocked') {
      return decision({
        action: 'block',
        recommendedStatus: 'blocked',
        reason: completionReason('Completion gate blocked completion because the workflow phase is blocked.', input),
        missingCriteria,
        blockers,
        workflowPhase,
        evidenceIds,
      })
    }

    const finalSubmitBlocker = blockers.find((blocker) => blocker.gateKind === 'final_submit')
    if (finalSubmitBlocker) {
      return decision({
        action: 'block',
        recommendedStatus: 'blocked',
        reason: completionReason(
          `Completion gate blocked completion because a final-submit blocker is present: ${finalSubmitBlocker.message}`,
          input,
        ),
        missingCriteria,
        blockers,
        workflowPhase,
        evidenceIds,
      })
    }

    const blockingMissingCriteria = missingCriteria.filter(isRequiredOrCriticalMissingCriterion)
    if (blockingMissingCriteria.length > 0) {
      return decision({
        action: 'block',
        recommendedStatus: 'blocked',
        reason: completionReason(
          `Completion gate blocked completion because required workflow evidence is missing: ${missingCriterionSummary(blockingMissingCriteria)}.`,
          input,
        ),
        missingCriteria,
        blockers,
        workflowPhase,
        evidenceIds,
      })
    }

    if (missingCriteria.length > 0) {
      return decision({
        action: 'block',
        recommendedStatus: 'blocked',
        reason: completionReason(
          `Completion gate blocked completion because workflow criteria are still missing: ${missingCriterionSummary(missingCriteria)}.`,
          input,
        ),
        missingCriteria,
        blockers,
        workflowPhase,
        evidenceIds,
      })
    }

    if (workflowPhase === 'done' && missingCriteria.length === 0) {
      return decision({
        action: 'allow',
        recommendedStatus: 'completed',
        reason: completionReason('Completion gate allowed completion because workflow phase is done and no criteria are missing.', input),
        missingCriteria,
        blockers,
        workflowPhase,
        evidenceIds,
      })
    }

    return decision({
      action: 'block',
      recommendedStatus: 'blocked',
      reason: completionReason(
        `Completion gate blocked completion because workflow phase ${workflowPhase ?? 'unknown'} is not done.`,
        input,
      ),
      missingCriteria,
      blockers,
      workflowPhase,
      evidenceIds,
    })
  }
}

export const completionGate = new CompletionGate()

function decision(input: Omit<CompletionGateDecision, 'schemaVersion'>): CompletionGateDecision {
  return {
    schemaVersion: 'completion-gate-decision/v1',
    ...input,
  }
}

function completionReason(reason: string, input: CompletionGateInput): string {
  const source = input.source ? ` Source: ${input.source}.` : ''
  const summary = input.summary ? ` Agent summary: ${input.summary}` : ''
  return `${reason}${source}${summary}`
}

function isRequiredOrCriticalMissingCriterion(criterion: WorkflowCriterionMissing): boolean {
  if (criterion.kind === 'phase_required_evidence') return criterion.missingEvidenceKinds.length > 0
  if (criterion.kind === 'evidence_required') return true
  if (criterion.kind === 'human_handoff' || criterion.kind === 'blocked') return true
  return criterion.missingEvidenceKinds.some((kind) => CRITICAL_MISSING_EVIDENCE_KINDS.has(kind))
}

function missingCriterionSummary(criteria: WorkflowCriterionMissing[]): string {
  return criteria
    .map((criterion) => {
      const missingKinds =
        criterion.missingEvidenceKinds.length > 0 ? ` missing ${criterion.missingEvidenceKinds.join(', ')}` : ''
      return `${criterion.id}${missingKinds}`
    })
    .join('; ')
}

function evidenceIdsFor(
  evaluation: WorkflowEngineEvaluation | undefined,
  missingCriteria: WorkflowCriterionMissing[],
  blockers: WorkflowBlocker[],
): string[] {
  return unique([
    ...(evaluation?.evidenceIds ?? []),
    ...missingCriteria.flatMap((criterion) => criterion.evidenceIds),
    ...blockers.flatMap((blocker) => blocker.evidenceIds ?? []),
  ])
}

function copyMissingCriteria(criteria: WorkflowCriterionMissing[]): WorkflowCriterionMissing[] {
  return criteria.map((criterion) => ({
    ...criterion,
    evidenceKinds: [...criterion.evidenceKinds],
    missingEvidenceKinds: [...criterion.missingEvidenceKinds],
    evidenceIds: [...criterion.evidenceIds],
  }))
}

function copyBlockers(blockers: WorkflowBlocker[]): WorkflowBlocker[] {
  return blockers.map((blocker) => ({
    ...blocker,
    ...(blocker.missingEvidenceKinds ? { missingEvidenceKinds: [...blocker.missingEvidenceKinds] } : {}),
    ...(blocker.evidenceIds ? { evidenceIds: [...blocker.evidenceIds] } : {}),
  }))
}

function unique(values: string[]): string[] {
  return [...new Set(values)]
}
