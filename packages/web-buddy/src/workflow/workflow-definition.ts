import type { WorkflowPhase } from './workflow-state.js'

export type WorkflowCompletionCriterionKind =
  | 'phase_reached'
  | 'evidence_required'
  | 'human_handoff'
  | 'blocked'

export interface WorkflowDefinition<Phase extends string = string> {
  schemaVersion: 'workflow-definition/v1'
  id: string
  name: string
  version: 1
  description?: string
  initialPhase: Phase
  terminalPhases: Phase[]
  phases: WorkflowPhaseDefinition<Phase>[]
  completionCriteria: WorkflowCompletionCriterion<Phase>[]
}

export interface WorkflowPhaseDefinition<Phase extends string = string> {
  id: Phase
  phase: Phase
  title: string
  objective: string
  allowedNextPhases?: Phase[]
  requiredEvidenceKinds?: string[]
  humanHandoffRequired?: boolean
  terminal?: boolean
}

export interface WorkflowCompletionCriterion<Phase extends string = string> {
  id: string
  kind: WorkflowCompletionCriterionKind
  description: string
  phase?: Phase
  evidenceKinds?: string[]
  required?: boolean
}

export const jobApplicationWorkflowDefinition: WorkflowDefinition<WorkflowPhase> = {
  schemaVersion: 'workflow-definition/v1',
  id: 'job-application',
  name: 'Job Application',
  version: 1,
  description: 'Built-in observation workflow definition for target flow, external blockers, final-submit boundary, and completion.',
  initialPhase: 'in_target_flow',
  terminalPhases: ['done', 'blocked'],
  phases: [
    {
      id: 'in_target_flow',
      phase: 'in_target_flow',
      title: 'In target flow',
      objective: 'Continue the requested workflow while gathering page, form, policy, and tool evidence.',
      allowedNextPhases: ['external_blocker', 'final_submit_boundary', 'done', 'blocked'],
      requiredEvidenceKinds: ['page'],
    },
    {
      id: 'external_blocker',
      phase: 'external_blocker',
      title: 'External blocker',
      objective: 'Pause for human action when login, captcha, or another external blocker is visible.',
      allowedNextPhases: ['in_target_flow', 'blocked'],
      requiredEvidenceKinds: ['page'],
      humanHandoffRequired: true,
    },
    {
      id: 'final_submit_boundary',
      phase: 'final_submit_boundary',
      title: 'Final submit boundary',
      objective: 'Stop before any final submission and require human takeover or confirmation.',
      allowedNextPhases: ['in_target_flow', 'done', 'blocked'],
      requiredEvidenceKinds: ['page', 'form', 'policy'],
      humanHandoffRequired: true,
    },
    {
      id: 'done',
      phase: 'done',
      title: 'Done',
      objective: 'Record completion only when completion criteria are backed by workflow evidence.',
      requiredEvidenceKinds: ['tool_result', 'user_confirm'],
      terminal: true,
    },
    {
      id: 'blocked',
      phase: 'blocked',
      title: 'Blocked',
      objective: 'Record that the workflow cannot continue without human action or a changed external state.',
      requiredEvidenceKinds: ['workflow_state'],
      humanHandoffRequired: true,
      terminal: true,
    },
  ],
  completionCriteria: [
    {
      id: 'final-submit-boundary-requires-page-form-and-policy-evidence',
      kind: 'evidence_required',
      description: 'Final-submit boundary must be backed by page/form evidence and a final-submit policy evidence item.',
      phase: 'final_submit_boundary',
      evidenceKinds: ['page', 'form', 'policy'],
      required: true,
    },
    {
      id: 'done-requires-explicit-completion-evidence',
      kind: 'evidence_required',
      description: 'The done phase must be supported by explicit completion evidence instead of optimistic model narration.',
      phase: 'done',
      evidenceKinds: ['tool_result', 'user_confirm'],
      required: true,
    },
    {
      id: 'handoff-phases-require-human-action',
      kind: 'human_handoff',
      description: 'Login, captcha, and final-submit phases require human handoff semantics.',
      evidenceKinds: ['page', 'policy', 'user_confirm'],
      required: true,
    },
    {
      id: 'blocked-is-terminal',
      kind: 'blocked',
      description: 'Blocked is a terminal workflow outcome until human input or external state changes.',
      phase: 'blocked',
      evidenceKinds: ['workflow_state'],
      required: true,
    },
  ],
}
