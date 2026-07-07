import type { CompletionGateDecision } from '../workflow/completion-gate.js'
import type {
  WorkflowBlocker,
  WorkflowCriterionMissing,
  WorkflowEngineEvaluation,
} from '../workflow/workflow-engine.js'
import type { WorkflowEvidence } from '../workflow/workflow-evidence.js'
import type { WorkflowState } from '../workflow/workflow-state.js'
import type { AgentSession, FinalResultEntry, SessionStore, TranscriptEntry } from './session-types.js'
import { readJsonLines } from './transcript.js'

export interface RestoredSessionState {
  schemaVersion: 'restored-session-state/v1'
  session: AgentSession
  transcriptCount: number
  restoredAt: string
  latestWorkflowState?: WorkflowState
  workflowEvidence: WorkflowEvidence[]
  latestWorkflowEvaluation?: WorkflowEngineEvaluation
  latestCompletionGate?: CompletionGateDecision
  latestFinalResult?: FinalResultEntry
  missingCriteria: WorkflowCriterionMissing[]
  blockers: WorkflowBlocker[]
}

export type RestoreSessionStateInput =
  | AgentSession
  | {
      session: AgentSession
      now?: string
    }
  | {
      store: Pick<SessionStore, 'get'>
      sessionId: string
      now?: string
    }

export async function restoreSessionState(input: RestoreSessionStateInput): Promise<RestoredSessionState> {
  const session = await resolveSession(input)
  const transcript = await readJsonLines<TranscriptEntry>(session.transcriptPath)

  let latestWorkflowState: WorkflowState | undefined
  let latestWorkflowEvaluation: WorkflowEngineEvaluation | undefined
  let latestCompletionGate: CompletionGateDecision | undefined
  let latestFinalResult: FinalResultEntry | undefined
  const workflowEvidence: WorkflowEvidence[] = []

  for (const entry of transcript) {
    if (entry.type === 'workflow_snapshot') {
      latestWorkflowState = workflowStateFromUnknown(entry.workflowState)
      continue
    }

    if (entry.type === 'workflow_evidence') {
      workflowEvidence.push(entry.evidence as WorkflowEvidence)
      continue
    }

    if (entry.type === 'workflow_evaluation') {
      latestWorkflowEvaluation = workflowEvaluationFromUnknown(entry.evaluation)
      continue
    }

    if (entry.type === 'completion_gate') {
      latestCompletionGate = completionGateDecisionFromUnknown(entry.decision)
      continue
    }

    if (entry.type === 'final_result') {
      latestFinalResult = entry
    }
  }

  return {
    schemaVersion: 'restored-session-state/v1',
    session: { ...session },
    transcriptCount: transcript.length,
    restoredAt: restoredAtFor(input),
    ...(latestWorkflowState ? { latestWorkflowState } : {}),
    workflowEvidence,
    ...(latestWorkflowEvaluation ? { latestWorkflowEvaluation } : {}),
    ...(latestCompletionGate ? { latestCompletionGate } : {}),
    ...(latestFinalResult ? { latestFinalResult } : {}),
    missingCriteria:
      arrayProperty<WorkflowCriterionMissing>(latestWorkflowEvaluation, 'missingCriteria') ??
      arrayProperty<WorkflowCriterionMissing>(latestCompletionGate, 'missingCriteria') ??
      [],
    blockers:
      arrayProperty<WorkflowBlocker>(latestWorkflowEvaluation, 'blockers') ??
      arrayProperty<WorkflowBlocker>(latestCompletionGate, 'blockers') ??
      [],
  }
}

async function resolveSession(input: RestoreSessionStateInput): Promise<AgentSession> {
  if ('transcriptPath' in input) return input
  if ('session' in input) return input.session

  const session = await input.store.get(input.sessionId)
  if (!session) throw new Error(`Session not found: ${input.sessionId}`)
  return session
}

function restoredAtFor(input: RestoreSessionStateInput): string {
  if ('transcriptPath' in input) return new Date().toISOString()
  return input.now ?? new Date().toISOString()
}

function arrayProperty<T>(value: unknown, property: string): T[] | undefined {
  if (!value || typeof value !== 'object') return undefined
  const candidate = (value as Record<string, unknown>)[property]
  return Array.isArray(candidate) ? ([...candidate] as T[]) : undefined
}

function workflowStateFromUnknown(value: unknown): WorkflowState | undefined {
  if (!isRecord(value)) return undefined
  if (value.schemaVersion !== 'workflow-state/v1') return undefined
  if (typeof value.phase !== 'string') return undefined
  return { ...value } as WorkflowState
}

function workflowEvaluationFromUnknown(value: unknown): WorkflowEngineEvaluation | undefined {
  if (!isRecord(value)) return undefined
  const state = workflowStateFromUnknown(value.state)
  if (!state) return undefined
  return {
    ...value,
    state,
    matchedCriteria: arrayValue(value.matchedCriteria),
    missingCriteria: arrayValue(value.missingCriteria),
    blockers: arrayValue(value.blockers),
    evidenceIds: arrayValue(value.evidenceIds),
  } as WorkflowEngineEvaluation
}

function completionGateDecisionFromUnknown(value: unknown): CompletionGateDecision | undefined {
  if (!isRecord(value)) return undefined
  if (value.schemaVersion !== 'completion-gate-decision/v1') return undefined
  if (typeof value.action !== 'string' || typeof value.recommendedStatus !== 'string') return undefined
  return {
    ...value,
    missingCriteria: arrayValue(value.missingCriteria),
    blockers: arrayValue(value.blockers),
    evidenceIds: arrayValue(value.evidenceIds),
  } as CompletionGateDecision
}

function arrayValue<T>(value: unknown): T[] {
  return Array.isArray(value) ? ([...value] as T[]) : []
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
