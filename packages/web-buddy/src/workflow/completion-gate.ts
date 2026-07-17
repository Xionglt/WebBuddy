import type { FormState } from '../observation/form-state.js'
import type { PageState } from '../observation/page-state.js'
import type { FillLedgerSummary } from '../fill/fill-ledger.js'
import type { FormCoverage } from '../observation/form-state.js'
import type { MainCompletionReadinessV1 } from '../agents/async-task-contracts.js'
import type {
  WorkflowBlocker,
  WorkflowCriterionMissing,
  WorkflowEngineEvaluation,
} from './workflow-engine.js'
import type { EvidenceStoreSnapshot, WorkflowEvidence } from './workflow-evidence.js'
import type { ObservationPhase } from './phase-classifier.js'
import type { WorkflowPhase, WorkflowState } from './workflow-state.js'
import { actionableDialogPresent } from './actionable-dialog.js'
import { evaluateTaskCompletion } from './task-completion.js'
import { evaluateCompletionContract } from '../task/completion-contract.js'
import type { ActionOutcome, ArtifactRef, EvidenceRef, TaskContract } from '../task/contracts.js'

export type CompletionGateAction = 'allow' | 'block' | 'ignore' | 'reject'
export type CompletionGateRecommendedStatus = 'completed' | 'blocked' | 'unchanged'
export type WebBuddyTaskType = 'explore' | 'apply_entry' | 'fill_form' | 'final_review'

export interface CompletionGateInput {
  done: boolean
  blocked: boolean
  summary?: string
  workflowState?: WorkflowState
  workflowEvaluation?: WorkflowEngineEvaluation
  page?: PageState
  form?: FormState
  formCoverage?: FormCoverage
  fillLedgerSummary?: FillLedgerSummary
  requiresCurrentResumeUpload?: boolean
  currentResumeUploaded?: boolean
  asyncTaskRuntimeEnabled?: boolean
  mainCompletionReadiness?: MainCompletionReadinessV1
  taskType?: WebBuddyTaskType
  taskContract?: TaskContract
  runId?: string
  revision?: number
  evidence?: EvidenceRef[]
  artifacts?: ArtifactRef[]
  actions?: ActionOutcome[]
  summaryAuthority?: 'main_agent' | 'read_only_subagent'
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
  observationPhase?: ObservationPhase
  evidenceIds: string[]
}

export class CompletionGate {
  static evaluate(input: CompletionGateInput): CompletionGateDecision {
    return completionGate.evaluate(input)
  }

  evaluate(input: CompletionGateInput): CompletionGateDecision {
    const evaluation = input.workflowEvaluation
    const workflowPhase = evaluation?.state.phase ?? input.workflowState?.phase
    const taskType = input.taskType ?? 'fill_form'
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

    if (input.asyncTaskRuntimeEnabled && !input.mainCompletionReadiness) {
      missingCriteria.push(requiredAsyncTaskReadinessMissingCriterion())
      return decision({
        action: 'reject',
        recommendedStatus: 'unchanged',
        reason: completionReason(
          'PREMATURE_AGENT_DONE_REJECTED. Completion gate rejected completion because async-task readiness was not supplied by the runtime authority.',
          input,
        ),
        missingCriteria,
        blockers,
        workflowPhase,
        evidenceIds,
      })
    }

    if (input.mainCompletionReadiness?.state === 'blocked_required_tasks') {
      missingCriteria.push(requiredAsyncTasksIncompleteCriterion(input.mainCompletionReadiness))
      return decision({
        action: 'reject',
        recommendedStatus: 'unchanged',
        reason: completionReason(
          'PREMATURE_AGENT_DONE_REJECTED. Completion gate rejected completion because required asynchronous tasks have not satisfied their terminal policy.',
          input,
        ),
        missingCriteria,
        blockers,
        workflowPhase,
        evidenceIds,
      })
    }

    if (input.taskContract) {
      const runId = input.runId ?? input.evidence?.[0]?.binding.runId
      const revision = input.revision ?? input.taskContract.revision
      if (!runId) {
        return decision({
          action: 'reject',
          recommendedStatus: 'unchanged',
          reason: completionReason('PREMATURE_AGENT_DONE_REJECTED. Generic completion requires a run binding.', input),
          missingCriteria,
          blockers,
          workflowPhase,
          evidenceIds,
        })
      }
      const contractEvaluation = evaluateCompletionContract({
        contract: input.taskContract,
        runId,
        revision,
        evidence: input.evidence ?? [],
        artifacts: input.artifacts ?? [],
        formState: completionFormState(input),
        actions: input.actions ?? [],
      })
      if (contractEvaluation.completed) {
        return decision({
          action: 'allow',
          recommendedStatus: 'completed',
          reason: completionReason('Completion gate allowed completion because every required TaskContract criterion has verified evidence.', input),
          missingCriteria,
          blockers,
          workflowPhase,
          evidenceIds: contractEvaluation.evidenceIds,
        })
      }
      const genericMissing = contractEvaluation.criteria.filter((criterion) => !criterion.passed)
      missingCriteria.push(...genericMissing.map((criterion) => ({
        id: criterion.id,
        kind: 'evidence_required' as const,
        description: criterion.id,
        evidenceKinds: [],
        missingEvidenceKinds: [],
        evidenceIds: criterion.evidenceIds,
        reason: criterion.reason,
      })))
      const externalBlocker = input.page?.pageType === 'login' || input.page?.pageType === 'captcha' || blockers.some(isExternalCompletionBlocker)
      return decision({
        action: input.blocked && externalBlocker ? 'block' : 'reject',
        recommendedStatus: input.blocked && externalBlocker ? 'blocked' : 'unchanged',
        reason: completionReason(`PREMATURE_AGENT_DONE_REJECTED. TaskContract criteria are missing: ${contractEvaluation.missingCriteria.join(', ')}.`, input),
        missingCriteria,
        blockers,
        workflowPhase,
        evidenceIds: contractEvaluation.evidenceIds,
      })
    }

    const verdict = evaluateTaskCompletion({
      taskType,
      page: input.page,
      form: input.form,
      formCoverage: input.formCoverage ?? input.form?.formCoverage ?? input.workflowState?.formCoverage,
      fillLedgerSummary: input.fillLedgerSummary ?? input.workflowState?.fillLedgerSummary,
      requiresCurrentResumeUpload: input.requiresCurrentResumeUpload,
      currentResumeUploaded: input.currentResumeUploaded ?? input.workflowState?.currentResumeUploaded,
      summary: input.summaryAuthority === 'read_only_subagent' ? undefined : input.summary,
      evidenceSnapshot: taskCompletionEvidenceSnapshot(input, workflowPhase),
    })
    const externalBlockerVisible = verdict.externalBlockerVisible || blockers.some(isExternalCompletionBlocker)

    if (input.source === 'agent_done' && input.blocked && !verdict.externalBlockerVisible && !blockers.some(isFinalSubmitBlocker)) {
      const dialog = actionableDialogPresent({ page: input.page, form: input.form })
      missingCriteria.push(taskCompletionMissingCriterion(verdict.missingEvidence))
      return decision({
        action: 'reject',
        recommendedStatus: 'unchanged',
        reason: completionReason([
          'PREMATURE_AGENT_DONE_REJECTED.',
          dialog.present
            ? `Completion gate rejected agent_done(blocked=true) because the page still has actionable dialog controls: ${dialog.controls.slice(0, 6).join(', ')}.`
            : 'Completion gate rejected agent_done(blocked=true) because no external blocker is visible and any login/captcha handoff has cleared.',
          'Continue operating instead of finalizing the run as blocked.',
        ].join(' '), input),
        missingCriteria,
        blockers,
        workflowPhase,
        evidenceIds,
      })
    }

    if (externalBlockerVisible && !verdict.targetStateReached) {
      return decision({
        action: 'block',
        recommendedStatus: 'blocked',
        reason: completionReason(
          `Completion gate blocked completion because task completion evidence or workflow blockers show an external blocker: ${blockerSummary(blockers) ?? verdict.reason}`,
          input,
        ),
        missingCriteria,
        blockers,
        workflowPhase,
        evidenceIds,
      })
    }

    if (verdict.targetStateReached) {
      return decision({
        action: 'allow',
        recommendedStatus: 'completed',
        reason: completionReason(`Completion gate allowed completion because ${verdict.reason}`, input),
        missingCriteria,
        blockers,
        workflowPhase,
        evidenceIds,
      })
    }

    if (input.source === 'resume_completion' && workflowPhase === 'done' && missingCriteria.length === 0 && blockers.length === 0) {
      return decision({
        action: 'allow',
        recommendedStatus: 'completed',
        reason: completionReason('Completion gate allowed resume completion because restored workflow state is done and explicit user confirmation cleared the restored completion blockers.', input),
        missingCriteria,
        blockers,
        workflowPhase,
        evidenceIds,
      })
    }

    if (input.source === 'resume_completion' && missingCriteria.length > 0) {
      return decision({
        action: 'block',
        recommendedStatus: 'blocked',
        reason: completionReason(
          `Completion gate kept resume completion blocked because restored completion criteria are still missing: ${missingCriteria.map((criterion) => criterion.reason).join('; ')}.`,
          input,
        ),
        missingCriteria,
        blockers,
        workflowPhase,
        evidenceIds,
      })
    }

    missingCriteria.push(taskCompletionMissingCriterion(verdict.missingEvidence))

    return decision({
      action: 'reject',
      recommendedStatus: 'unchanged',
      reason: completionReason(
        `PREMATURE_AGENT_DONE_REJECTED. Completion gate rejected premature agent_done because task completion evidence is missing: ${missingEvidenceSummary(verdict.missingEvidence)}. Continue with the suggested next actions instead of ending the run.`,
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

function completionFormState(input: CompletionGateInput) {
  const coverage = input.formCoverage ?? input.form?.formCoverage ?? input.workflowState?.formCoverage
  const fields = input.form?.fields ?? []
  const required = fields.filter((field) => field.required && field.disabled !== true && field.readonly !== true)
  const filled = required.filter((field) => field.filled === true)
  return {
    audited: coverage?.scope === 'full_audit' && coverage.complete === true && coverage.fieldLimitReached !== true,
    requiredFieldCoverage: required.length ? filled.length / required.length : coverage?.complete === true ? 1 : 0,
    visibleErrorCount: (input.form?.visibleErrors ?? []).filter((value) => /\S/.test(value)).length,
    submitted: input.page?.pageType === 'confirmation',
  }
}

function decision(input: Omit<CompletionGateDecision, 'schemaVersion'>): CompletionGateDecision {
  return {
    schemaVersion: 'completion-gate-decision/v1',
    ...input,
  }
}

function completionReason(reason: string, input: CompletionGateInput): string {
  const source = input.source ? ` Source: ${input.source}.` : ''
  const summary = input.summary
    ? input.summaryAuthority === 'read_only_subagent'
      ? ` Non-authoritative subagent summary (not completion evidence): ${input.summary}`
      : ` Agent summary: ${input.summary}`
    : ''
  return `${reason}${source}${summary}`
}

function requiredAsyncTasksIncompleteCriterion(
  readiness: Extract<MainCompletionReadinessV1, { state: 'blocked_required_tasks' }>,
): WorkflowCriterionMissing {
  const pending = [...readiness.pendingOrRunningTaskIds]
  const failed = [...readiness.failedOrKilledTaskIds]
  return {
    id: 'required_async_tasks_incomplete',
    kind: 'evidence_required',
    description: 'Required asynchronous tasks must satisfy their frozen terminal policy before main completion verification.',
    evidenceKinds: [],
    missingEvidenceKinds: [],
    evidenceIds: [],
    reason: [
      ...(pending.length > 0 ? [`Pending or running required tasks: ${pending.join(', ')}.`] : []),
      ...(failed.length > 0 ? [`Required tasks that failed or were killed: ${failed.join(', ')}.`] : []),
    ].join(' ') || 'Required asynchronous tasks have not satisfied their terminal policy.',
  }
}

function requiredAsyncTaskReadinessMissingCriterion(): WorkflowCriterionMissing {
  return {
    id: 'required_async_task_readiness_missing',
    kind: 'evidence_required',
    description: 'The enabled async-task runtime must provide typed completion readiness.',
    evidenceKinds: [],
    missingEvidenceKinds: [],
    evidenceIds: [],
    reason: 'MainCompletionReadinessV1 was not supplied by the runtime authority.',
  }
}

function taskCompletionMissingCriterion(missingEvidence: string[]): WorkflowCriterionMissing {
  return {
    id: 'task_completion_missing_evidence',
    kind: 'evidence_required',
    description: 'Task completion evidence must prove the requested target state before agent_done is accepted.',
    evidenceKinds: [],
    missingEvidenceKinds: [],
    evidenceIds: [],
    reason: missingEvidenceSummary(missingEvidence),
  }
}

function missingEvidenceSummary(missingEvidence: string[]): string {
  return missingEvidence.length > 0 ? missingEvidence.join('; ') : 'Missing task completion evidence.'
}

function blockerSummary(blockers: WorkflowBlocker[]): string | undefined {
  if (blockers.length === 0) return undefined
  return blockers.map((blocker) => blocker.message).join('; ')
}

function isExternalCompletionBlocker(blocker: WorkflowBlocker): boolean {
  return blocker.kind === 'human_handoff' || blocker.kind === 'workflow_blocked'
}

function isFinalSubmitBlocker(blocker: WorkflowBlocker): boolean {
  return blocker.gateKind === 'final_submit'
}

function taskCompletionEvidenceSnapshot(
  input: CompletionGateInput,
  workflowPhase: WorkflowPhase | string | undefined,
): EvidenceStoreSnapshot {
  const evidence: WorkflowEvidence[] = []
  const ts = input.page?.updatedAt ?? input.form?.updatedAt ?? input.workflowState?.updatedAt ?? new Date(0).toISOString()

  if (input.page) {
    evidence.push({
      schemaVersion: 'workflow-evidence/v1',
      id: 'completion_gate_page',
      kind: 'page',
      summary: [input.page.title, input.page.textSummary].filter(Boolean).join(' ') || 'Current page state is available.',
      source: 'completion_gate',
      confidence: 'medium',
      ts: input.page.updatedAt ?? ts,
      ...(workflowPhase ? { phase: workflowPhase } : {}),
      data: { pageType: input.page.pageType },
    })
  }

  if (input.form) {
    evidence.push({
      schemaVersion: 'workflow-evidence/v1',
      id: 'completion_gate_form',
      kind: 'form',
      summary: [
        `${input.form.fields.length} form field(s)`,
        ...(input.form.visibleErrors ?? []),
        ...(input.form.submitCandidates ?? []).map((candidate) => candidate.text),
        ...(input.form.uploadHints ?? []).map((hint) => hint.text),
      ].filter(Boolean).join('; ') || 'Current form state is available.',
      source: 'completion_gate',
      confidence: 'medium',
      ts: input.form.updatedAt ?? ts,
      ...(workflowPhase ? { phase: workflowPhase } : {}),
    })
  }

  const countsByKind: Record<string, number> = {}
  const byKind: Record<string, WorkflowEvidence[]> = {}
  for (const item of evidence) {
    countsByKind[item.kind] = (countsByKind[item.kind] ?? 0) + 1
    byKind[item.kind] = [...(byKind[item.kind] ?? []), item]
  }

  return {
    schemaVersion: 'evidence-store-snapshot/v1',
    version: 1,
    generatedAt: ts,
    total: evidence.length,
    kinds: Object.keys(countsByKind),
    countsByKind,
    evidence,
    byKind,
    all: evidence,
  }
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
