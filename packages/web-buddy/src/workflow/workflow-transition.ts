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
  verifiedFinalSubmitCompletion?: boolean
  now?: string
}

export interface WorkflowTransitionResult {
  state: WorkflowState
  changed: boolean
}

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

  const directSubmit = input.verifiedFinalSubmitCompletion
    ? undefined
    : inspectDirectSubmitWorkflowState({
    form: input.form,
    page: input.page,
    currentUrl: input.currentUrl,
      })
  const blockers = blockersFor(input, directSubmit?.detected === true)
  const rawPhase = classifyObservationPhase({
    page: input.page,
    form: input.form,
    blockers,
    policyFacts: input.policyDecision ? [input.policyDecision] : undefined,
    permissionFacts: input.gateKind ? [{ gateKind: input.gateKind, decision: input.gateDecision }] : undefined,
    summary: input.toolResult?.observation,
  })
  const phase = input.verifiedFinalSubmitCompletion && rawPhase === 'final_submit_boundary'
    ? 'in_target_flow'
    : rawPhase

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
  if (input.gateKind && !isApprovingDecision(input.gateDecision)) {
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
  if (input.gateDecision && !isApprovingDecision(input.gateDecision)) {
    blockers.push({
      gateKind: input.gateKind,
      message: `Gate returned ${input.gateDecision}.`,
      recoverable: input.gateKind === 'final_submit' ? true : undefined,
    })
  }
  return blockers
}

function isApprovingDecision(decision: GateDecision | undefined): boolean {
  return decision === 'approve' || decision === 'approve_and_execute'
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
