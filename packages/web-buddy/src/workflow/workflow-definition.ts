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
  description: 'Built-in workflow definition for browsing jobs and preparing an application for manual final submit.',
  initialPhase: 'observing',
  terminalPhases: ['done', 'blocked'],
  phases: [
    {
      id: 'observing',
      phase: 'observing',
      title: 'Observing',
      objective: 'Inspect the current page and infer whether it is part of a job application flow.',
      allowedNextPhases: ['selecting_job', 'job_detail', 'login_required', 'captcha_required', 'filling_application', 'direct_submit_review', 'blocked'],
      requiredEvidenceKinds: ['page'],
    },
    {
      id: 'selecting_job',
      phase: 'selecting_job',
      title: 'Selecting job',
      objective: 'Identify a suitable job listing before entering its detail page.',
      allowedNextPhases: ['job_detail', 'blocked'],
      requiredEvidenceKinds: ['page'],
    },
    {
      id: 'job_detail',
      phase: 'job_detail',
      title: 'Job detail',
      objective: 'Review job details and find the application entry point.',
      allowedNextPhases: ['entering_application', 'login_required', 'captcha_required', 'blocked'],
      requiredEvidenceKinds: ['page'],
    },
    {
      id: 'entering_application',
      phase: 'entering_application',
      title: 'Entering application',
      objective: 'Open the application flow without performing final submission.',
      allowedNextPhases: ['login_required', 'captcha_required', 'editing_resume', 'filling_application', 'direct_submit_review', 'blocked'],
      requiredEvidenceKinds: ['tool_result', 'page'],
    },
    {
      id: 'login_required',
      phase: 'login_required',
      title: 'Login required',
      objective: 'Pause for human login before continuing the workflow.',
      allowedNextPhases: ['entering_application', 'filling_application', 'direct_submit_review', 'blocked'],
      requiredEvidenceKinds: ['page'],
      humanHandoffRequired: true,
    },
    {
      id: 'captcha_required',
      phase: 'captcha_required',
      title: 'Captcha required',
      objective: 'Pause for human verification before continuing the workflow.',
      allowedNextPhases: ['entering_application', 'filling_application', 'direct_submit_review', 'blocked'],
      requiredEvidenceKinds: ['page'],
      humanHandoffRequired: true,
    },
    {
      id: 'editing_resume',
      phase: 'editing_resume',
      title: 'Editing resume',
      objective: 'Prepare or upload resume information needed by the application.',
      allowedNextPhases: ['filling_application', 'reviewing', 'direct_submit_review', 'blocked'],
      requiredEvidenceKinds: ['form', 'tool_result'],
    },
    {
      id: 'filling_application',
      phase: 'filling_application',
      title: 'Filling application',
      objective: 'Fill required application fields while respecting permission gates.',
      allowedNextPhases: ['editing_resume', 'reviewing', 'direct_submit_review', 'login_required', 'captcha_required', 'blocked'],
      requiredEvidenceKinds: ['form', 'tool_result'],
    },
    {
      id: 'reviewing',
      phase: 'reviewing',
      title: 'Reviewing',
      objective: 'Review filled application data and detect final submit controls.',
      allowedNextPhases: ['filling_application', 'direct_submit_review', 'ready_for_final_submit', 'blocked'],
      requiredEvidenceKinds: ['form'],
    },
    {
      id: 'direct_submit_review',
      phase: 'direct_submit_review',
      title: 'Direct submit review',
      objective: 'Stop on online-resume/direct-submit pages that have no fillable fields before final submission.',
      allowedNextPhases: ['ready_for_final_submit', 'done', 'blocked'],
      requiredEvidenceKinds: ['page', 'form', 'policy'],
      humanHandoffRequired: true,
    },
    {
      id: 'ready_for_final_submit',
      phase: 'ready_for_final_submit',
      title: 'Ready for final submit',
      objective: 'Stop before final submission and require human takeover or confirmation.',
      allowedNextPhases: ['done', 'blocked'],
      requiredEvidenceKinds: ['form', 'policy', 'user_confirm'],
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
      id: 'direct-submit-review-requires-page-form-and-policy-evidence',
      kind: 'evidence_required',
      description: 'Direct-submit review must be backed by page/form evidence and a final-submit policy evidence item.',
      phase: 'direct_submit_review',
      evidenceKinds: ['page', 'form', 'policy'],
      required: true,
    },
    {
      id: 'ready-for-final-submit-requires-form-and-policy-evidence',
      kind: 'evidence_required',
      description: 'Before final submit, the workflow must have form evidence and a policy evidence item for the final-submit gate.',
      phase: 'ready_for_final_submit',
      evidenceKinds: ['form', 'policy'],
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
