import type { FormState } from '../observation/form-state.js'
import type { PageState } from '../observation/page-state.js'
import type { PolicyDecision } from '../policy/agent-policy.js'
import type { GateDecision, GateKind } from '../sdk/human.js'
import type { LocalToolRunResult } from '../tools/local-adapter.js'
import { inspectDirectSubmitWorkflowState } from './direct-submit.js'
import { classifyObservationPhase, type ObservationPhaseBlocker } from './phase-classifier.js'
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

const LOGIN_TEXT = /login|log in|sign in|signin|sso|auth|password|密码登录|短信登录|账号登录|统一认证|单点登录|请登录|登录后|登陆后|登入后/i
const CAPTCHA_TEXT = /captcha|human verification|verify you are human|人机验证|验证码|安全验证|滑块验证/i

export function transitionWorkflowState(input: WorkflowTransitionInput): WorkflowTransitionResult {
  const now = input.now ?? new Date().toISOString()
  const rule = inferWorkflowRule(input)
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

function inferWorkflowRule(input: WorkflowTransitionInput): WorkflowRule {
  if (input.agentDoneBlocked === false) {
    return {
      phase: 'done',
      confidence: 'high',
      reason: 'Agent reported completion; completion gate must still verify evidence.',
    }
  }

  if (input.agentDoneBlocked === true) {
    return {
      phase: 'blocked',
      confidence: 'high',
      reason: 'Agent reported completion with blocked=true.',
      humanHandoffRequired: true,
      blocker: blockerForGate(input.gateKind) ?? 'Agent reported the workflow is blocked.',
    }
  }

  const directSubmit = inspectDirectSubmitWorkflowState({
    form: input.form,
    page: input.page,
    currentUrl: input.currentUrl,
  })
  const blockers = blockersFor(input, directSubmit?.detected === true)
  const phase = classifyObservationPhase({
    page: input.page,
    form: input.form,
    blockers,
    policyFacts: input.policyDecision ? [input.policyDecision] : undefined,
    permissionFacts: input.gateKind ? [{ gateKind: input.gateKind, decision: input.gateDecision }] : undefined,
    summary: input.toolResult?.observation,
  })

  if (phase === 'external_blocker') {
    const blockerGateKind = blockers.find((blocker) => externalGateKind(blocker.gateKind))?.gateKind
    const gateKind = input.page?.pageType === 'captcha'
      ? 'captcha'
      : input.page?.pageType === 'login'
        ? 'login'
        : externalGateKind(input.gateKind) ?? externalGateKind(blockerGateKind)
    return {
      phase,
      confidence: gateKind ? 'high' : 'medium',
      reason: gateKind === 'captcha'
        ? 'Current evidence shows a human verification blocker.'
        : gateKind === 'login'
          ? 'Current evidence shows a login or SSO blocker.'
          : 'Current evidence shows an external blocker.',
      humanHandoffRequired: true,
      blocker: blockerForGate(gateKind) ?? 'External blocker requires human action before continuing.',
    }
  }

  if (phase === 'final_submit_boundary') {
    return {
      phase,
      confidence: 'high',
      reason: directSubmit?.detected
        ? 'Direct-submit evidence shows the next step is a final-submit boundary.'
        : 'Policy, permission, or page evidence shows a final-submit boundary.',
      humanHandoffRequired: true,
      blocker: 'Final submit requires human takeover before completion.',
    }
  }

  if (phase === 'blocked') {
    return {
      phase,
      confidence: 'high',
      reason: 'Current evidence shows the workflow cannot continue.',
      humanHandoffRequired: true,
      blocker: 'Workflow is blocked until human input or external state changes.',
    }
  }

  return {
    phase,
    confidence: input.page || input.form || input.toolResult ? 'medium' : input.previous.confidence,
    reason: phase === 'done'
      ? 'Current evidence shows the target state is reached.'
      : 'Current evidence remains inside the requested target flow.',
  }
}

function blockersFor(input: WorkflowTransitionInput, directSubmitDetected: boolean): ObservationPhaseBlocker[] {
  const blockers: ObservationPhaseBlocker[] = []
  const pageText = [input.page?.title, input.page?.textSummary].filter(Boolean).join('\n')
  if (CAPTCHA_TEXT.test(pageText)) {
    blockers.push({ gateKind: 'captcha', kind: 'external_blocker', message: 'Human verification required before continuing.' })
  } else if (LOGIN_TEXT.test(pageText)) {
    blockers.push({ gateKind: 'login', kind: 'external_blocker', message: 'Human login required before continuing.' })
  }
  if (input.gateKind && input.gateDecision !== 'approve') {
    blockers.push({
      gateKind: input.gateKind,
      message: input.policyDecision?.reason,
      unresolved: true,
    })
  }
  if (directSubmitDetected) {
    blockers.push({
      gateKind: 'final_submit',
      message: 'Direct-submit review reached final submit boundary.',
    })
  }
  if (input.gateDecision && input.gateDecision !== 'approve') {
    blockers.push({
      gateKind: input.gateKind,
      message: `Gate returned ${input.gateDecision}.`,
      recoverable: input.gateKind === 'final_submit' ? true : undefined,
    })
  }
  return blockers
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
    observationPhase: phase,
    confidence: options.confidence,
    reason: options.reason,
    updatedAt: options.now,
    ...(options.humanHandoffRequired ? { humanHandoffRequired: true } : {}),
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

function externalGateKind(gateKind: GateKind | string | undefined): Extract<GateKind, 'login' | 'captcha'> | undefined {
  return gateKind === 'login' || gateKind === 'captcha' ? gateKind : undefined
}

function blockerForGate(gateKind: GateKind | undefined): string | undefined {
  if (gateKind === 'login') return 'Human login required before continuing.'
  if (gateKind === 'captcha') return 'Human verification required before continuing.'
  if (gateKind === 'final_submit') return 'Final submit requires human takeover before completion.'
  return undefined
}
