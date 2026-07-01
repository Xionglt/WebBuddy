export type WorkflowPhase =
  | 'observing'
  | 'selecting_job'
  | 'job_detail'
  | 'entering_application'
  | 'login_required'
  | 'captcha_required'
  | 'editing_resume'
  | 'filling_application'
  | 'reviewing'
  | 'direct_submit_review'
  | 'ready_for_final_submit'
  | 'done'
  | 'blocked'

export type WorkflowConfidence = 'low' | 'medium' | 'high'

export interface WorkflowState {
  schemaVersion: 'workflow-state/v1'
  phase: WorkflowPhase
  confidence: WorkflowConfidence
  reason: string
  updatedAt: string
  humanHandoffRequired?: boolean
  blocker?: string
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
    phase: 'observing',
    confidence: 'medium',
    reason: 'Workflow has not inferred a more specific phase yet.',
    updatedAt: now,
  }
}
