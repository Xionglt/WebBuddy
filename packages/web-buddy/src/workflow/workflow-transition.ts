import type { FormState } from '../observation/form-state.js'
import type { PageState } from '../observation/page-state.js'
import type { PolicyDecision } from '../policy/agent-policy.js'
import type { GateDecision, GateKind } from '../sdk/human.js'
import type { LocalToolRunResult } from '../tools/local-adapter.js'
import { inspectDirectSubmitWorkflowState } from './direct-submit.js'
import type { WorkflowConfidence, WorkflowPhase, WorkflowState } from './workflow-state.js'

export interface WorkflowTransitionInput {
  previous: WorkflowState
  currentUrl?: string
  page?: PageState
  form?: FormState
  toolName?: string
  toolResult?: LocalToolRunResult
  policyDecision?: PolicyDecision
  gateKind?: GateKind
  gateDecision?: GateDecision
  agentDoneBlocked?: boolean
  now?: string
}

export interface WorkflowTransitionResult {
  state: WorkflowState
  changed: boolean
}

const LOGIN_TEXT = /login|log in|sign in|signin|sso|auth|登录|登陆|登入|账号登录|统一认证|单点登录/i
const CAPTCHA_TEXT = /captcha|human verification|verify you are human|人机验证|验证码|安全验证|滑块验证/i
const APPLY_ENTRY_TEXT = /apply|投递|投递简历|立即投递|申请职位|开始申请/i

export function transitionWorkflowState(input: WorkflowTransitionInput): WorkflowTransitionResult {
  const now = input.now ?? new Date().toISOString()
  const rule = inferWorkflowRule(input)
  if (!rule) return { state: input.previous, changed: false }

  const nextState = buildState(input.previous, rule.phase, {
    confidence: rule.confidence,
    reason: rule.reason,
    now,
    humanHandoffRequired: rule.humanHandoffRequired,
    blocker: rule.blocker,
  })

  return {
    state: nextState,
    changed:
      nextState.phase !== input.previous.phase ||
      nextState.reason !== input.previous.reason ||
      nextState.blocker !== input.previous.blocker ||
      nextState.humanHandoffRequired !== input.previous.humanHandoffRequired,
  }
}

interface WorkflowRule {
  phase: WorkflowPhase
  confidence: WorkflowConfidence
  reason: string
  humanHandoffRequired?: boolean
  blocker?: string
}

function inferWorkflowRule(input: WorkflowTransitionInput): WorkflowRule | undefined {
  if (input.agentDoneBlocked === false) {
    return {
      phase: 'done',
      confidence: 'high',
      reason: 'Agent reported completion without a blocker.',
    }
  }

  if (input.agentDoneBlocked === true) {
    if (input.gateKind === 'final_submit') {
      return {
        phase: 'blocked',
        confidence: 'high',
        reason: 'Final-submit gate triggered and the workflow is blocked.',
        humanHandoffRequired: true,
        blocker: 'Final submit requires manual takeover.',
      }
    }
    return {
      phase: 'blocked',
      confidence: 'high',
      reason: 'Agent reported completion with blocked=true.',
      humanHandoffRequired: true,
      blocker: 'Agent reported the workflow is blocked.',
    }
  }

  if (input.gateKind === 'final_submit' && input.gateDecision && input.gateDecision !== 'approve') {
    return {
      phase: 'blocked',
      confidence: 'high',
      reason: `Final-submit gate returned ${input.gateDecision}.`,
      humanHandoffRequired: true,
      blocker: 'Final submit requires manual takeover.',
    }
  }

  const pageText = workflowText(input.currentUrl, input.page)
  if (input.page?.pageType === 'captcha' || CAPTCHA_TEXT.test(pageText)) {
    return {
      phase: 'captcha_required',
      confidence: input.page?.pageType === 'captcha' ? 'high' : 'medium',
      reason: 'Current page appears to require human verification.',
      humanHandoffRequired: true,
      blocker: 'Human verification required before continuing.',
    }
  }

  if (input.page?.pageType === 'login' || LOGIN_TEXT.test(pageText)) {
    return {
      phase: 'login_required',
      confidence: input.page?.pageType === 'login' ? 'high' : 'medium',
      reason: 'Current page appears to be a login or SSO page.',
      humanHandoffRequired: true,
      blocker: 'Human login required before continuing.',
    }
  }

  const directSubmit = inspectDirectSubmitWorkflowState({
    form: input.form,
    page: input.page,
    currentUrl: input.currentUrl,
  })
  if (directSubmit?.detected) {
    return {
      phase: 'direct_submit_review',
      confidence: 'high',
      reason: 'Site appears to use an online-resume/direct-submit flow with no fillable fields.',
      humanHandoffRequired: true,
      blocker: 'Direct-submit review: next step is final submit and requires manual confirmation.',
    }
  }

  if (input.gateKind === 'final_submit' || input.policyDecision?.gateKind === 'final_submit') {
    return {
      phase: 'ready_for_final_submit',
      confidence: 'high',
      reason: 'Policy identified a final-submit gate.',
    }
  }

  if (input.form && shouldReviewForm(input.form)) {
    return {
      phase: 'reviewing',
      confidence: 'medium',
      reason: 'Application form appears mostly filled and has submit candidates.',
    }
  }

  if (input.form && shouldFillForm(input.form)) {
    return {
      phase: 'filling_application',
      confidence: 'medium',
      reason: 'Application form has fields or missing required values.',
    }
  }

  if (isApplyEntryClick(input)) {
    return {
      phase: 'entering_application',
      confidence: 'medium',
      reason: 'Apply entry action appears to open the application flow.',
    }
  }

  if (input.page?.pageType === 'detail' && input.previous.phase === 'observing') {
    return {
      phase: 'job_detail',
      confidence: 'medium',
      reason: 'Current page appears to be a job detail page.',
    }
  }

  return undefined
}

function buildState(
  previous: WorkflowState,
  phase: WorkflowPhase,
  options: {
    confidence: WorkflowConfidence
    reason: string
    now: string
    humanHandoffRequired?: boolean
    blocker?: string
  },
): WorkflowState {
  return {
    schemaVersion: 'workflow-state/v1',
    phase,
    confidence: options.confidence,
    reason: options.reason,
    updatedAt: options.now,
    ...(options.humanHandoffRequired ? { humanHandoffRequired: options.humanHandoffRequired } : {}),
    ...(options.blocker ? { blocker: options.blocker } : {}),
    ...(phase !== previous.phase
      ? {
          lastTransition: {
            from: previous.phase,
            to: phase,
            reason: options.reason,
            at: options.now,
          },
        }
      : previous.lastTransition
        ? { lastTransition: previous.lastTransition }
        : {}),
  }
}

function workflowText(currentUrl: string | undefined, page: PageState | undefined): string {
  return [currentUrl, page?.url, page?.title, page?.textSummary].filter(Boolean).join('\n')
}

function shouldFillForm(form: FormState): boolean {
  return form.missingRequired.length > 0 || form.fields.length >= 3
}

function shouldReviewForm(form: FormState): boolean {
  if (form.submitCandidates.length === 0 || form.fields.length === 0) return false
  if (form.missingRequired.length === 0) return true
  return form.filledFields.length > 0 && form.missingRequired.length <= Math.max(1, Math.floor(form.fields.length * 0.2))
}

function isApplyEntryClick(input: WorkflowTransitionInput): boolean {
  if (input.toolName !== 'browser_click' && input.toolName !== 'browser_click_text') return false
  if (input.previous.phase !== 'job_detail' && input.previous.phase !== 'entering_application') return false
  const observation = input.toolResult?.observation ?? ''
  if (input.policyDecision?.gateKind === 'final_submit') return false
  return APPLY_ENTRY_TEXT.test(observation) || input.toolResult?.pageChanged === true
}
