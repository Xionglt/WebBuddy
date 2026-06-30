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
      latestWorkflowState = entry.workflowState as WorkflowState
      continue
    }

    if (entry.type === 'workflow_evidence') {
      workflowEvidence.push(entry.evidence as WorkflowEvidence)
      continue
    }

    if (entry.type === 'workflow_evaluation') {
      latestWorkflowEvaluation = entry.evaluation as WorkflowEngineEvaluation
      continue
    }

    if (entry.type === 'completion_gate') {
      latestCompletionGate = entry.decision as CompletionGateDecision
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
