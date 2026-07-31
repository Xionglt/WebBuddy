import type { WorkflowDefinition } from './workflow-definition.js'
import type { WorkflowPhase, WorkflowState } from './workflow-state.js'

export type WorkflowTransitionDisposition = 'allowed' | 'reconciled' | 'rejected'

export interface WorkflowTransitionGuardDecision {
  disposition: WorkflowTransitionDisposition
  from: WorkflowPhase
  requested: WorkflowPhase
  state: WorkflowState
  reason: string
}

export interface WorkflowTransitionGuardInput {
  previous: WorkflowState
  candidate: WorkflowState
  definition: WorkflowDefinition<WorkflowPhase>
  /** A fresh page/form observation may reconcile a live workflow that changed externally. */
  hasFreshObservation: boolean
}

/**
 * Enforces declared workflow edges without pretending that a browser is fully
 * controlled by the agent. Unexpected live-phase changes require fresh
 * observation and are recorded as reconciliation; `done` is strictly terminal.
 */
export function guardWorkflowTransition(
  input: WorkflowTransitionGuardInput,
): WorkflowTransitionGuardDecision {
  const { previous, candidate, definition } = input
  if (previous.phase === candidate.phase) {
    return decision('allowed', previous, candidate, 'Workflow phase did not change.')
  }

  const previousDefinition = definition.phases.find(
    (phase) => phase.id === previous.phase || phase.phase === previous.phase,
  )
  if (previousDefinition?.allowedNextPhases?.includes(candidate.phase)) {
    return decision(
      'allowed',
      previous,
      candidate,
      `Declared workflow transition ${previous.phase} -> ${candidate.phase}.`,
    )
  }

  if (previous.phase === 'done') {
    return rejected(previous, candidate, 'The done phase is terminal and cannot be reopened within the same run attempt.')
  }

  if (input.hasFreshObservation) {
    const reason =
      `Reconciled unexpected workflow transition ${previous.phase} -> ${candidate.phase} from fresh page/form evidence.`
    return {
      disposition: 'reconciled',
      from: previous.phase,
      requested: candidate.phase,
      state: {
        ...candidate,
        reason: `${reason} ${candidate.reason}`,
        lastTransition: {
          from: previous.phase,
          to: candidate.phase,
          reason,
          at: candidate.updatedAt,
        },
      },
      reason,
    }
  }

  return rejected(
    previous,
    candidate,
    `Workflow transition ${previous.phase} -> ${candidate.phase} is not declared and has no fresh page/form evidence.`,
  )
}

function decision(
  disposition: Extract<WorkflowTransitionDisposition, 'allowed'>,
  previous: WorkflowState,
  candidate: WorkflowState,
  reason: string,
): WorkflowTransitionGuardDecision {
  return {
    disposition,
    from: previous.phase,
    requested: candidate.phase,
    state: candidate,
    reason,
  }
}

function rejected(
  previous: WorkflowState,
  candidate: WorkflowState,
  reason: string,
): WorkflowTransitionGuardDecision {
  return {
    disposition: 'rejected',
    from: previous.phase,
    requested: candidate.phase,
    state: previous,
    reason,
  }
}
