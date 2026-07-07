import type { FillLedgerSummary } from '../fill/fill-ledger.js'
import type { FormCoverage } from '../observation/form-state.js'
import type { ObservationPhase } from './phase-classifier.js'

export type WorkflowPhase =
  | 'in_target_flow'
  | 'external_blocker'
  | 'final_submit_boundary'
  | 'done'
  | 'blocked'

export type WorkflowConfidence = 'low' | 'medium' | 'high'

export interface WorkflowState {
  schemaVersion: 'workflow-state/v1'
  phase: WorkflowPhase
  observationPhase?: ObservationPhase
  confidence: WorkflowConfidence
  reason: string
  updatedAt: string
  humanHandoffRequired?: boolean
  blocker?: string
  formCoverage?: FormCoverage
  fillLedgerSummary?: FillLedgerSummary
  currentResumeUploaded?: boolean
  lastTransition?: {
    from: WorkflowPhase
    to: WorkflowPhase
    reason: string
    at: string
  }
}

export function createInitialWorkflowState(now = new Date().toISOString()): WorkflowState {
  return {
    schemaVersion: 'workflow-state/v1',
    phase: 'in_target_flow',
    confidence: 'medium',
    reason: 'Workflow is observing target-flow progress from current evidence.',
    updatedAt: now,
  }
}
