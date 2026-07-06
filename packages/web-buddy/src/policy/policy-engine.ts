import type { ContextFreshness } from '../context/types.js'
import type { GateKind } from '../sdk/human.js'
import type { RiskLevel } from '../sdk/trace.js'
import type { WorkflowPhase, WorkflowState } from '../workflow/workflow-state.js'
import { inferActionIntent, type ActionIntent } from './action-intent.js'

export type AgentSafetyMode = 'guarded' | 'raw'
export type PolicyAction = 'allow' | 'gate' | 'block' | 'auto_confirm'
export type PolicyRiskLevel = 'low' | 'medium' | 'high' | 'critical'

export interface PolicyDecision {
  action: PolicyAction
  riskLevel: PolicyRiskLevel
  reason: string
  actionIntent?: ActionIntent
  gateKind?: GateKind
  requiresFreshContext?: boolean
}

export interface PolicyFreshnessSummary {
  pageStateStale?: boolean
  formStateStale?: boolean
  pageStateAgeMs?: number
  formStateAgeMs?: number
  staleAfterMs?: number
}

export interface PolicyEngineInput {
  toolName: string
  args: Record<string, unknown>
  risk?: RiskLevel
  safetyMode?: AgentSafetyMode
  currentUrl?: string
  refLabel?: string
  contextText?: string
  freshness?: PolicyFreshnessSummary | ContextFreshness
  workflowState?: WorkflowState
  workflowPhase?: WorkflowPhase
}

export type ToolPolicyInput = PolicyEngineInput

export interface PolicyEngineDecision extends PolicyDecision {
  schemaVersion: 'policy-decision/v1'
  policyCode: string
  ruleId: string
  workflowPhase?: WorkflowPhase
  auditTags: string[]
}

interface DecisionRule {
  policyCode: string
  ruleId: string
  reason: string
  tags: string[]
}

export class PolicyEngine {
  evaluate(input: PolicyEngineInput): PolicyEngineDecision {
    const actionIntent = inferActionIntent(input)
    const riskLevel = policyRiskLevel(input.risk)
    const workflowPhase = workflowPhaseFor(input)
    const requiresFreshContext = requiresHumanGate(input.risk)
    const freshnessCue = requiresFreshContext ? staleFreshnessCue(input.freshness) : undefined

    if (!requiresHumanGate(input.risk)) {
      return buildDecision({
        action: 'allow',
        riskLevel,
        rule: {
          policyCode: 'policy.low_risk.allow',
          ruleId: 'policy.low_risk.allow.v1',
          reason: 'Tool risk does not require a human gate.',
          tags: ['low_risk'],
        },
        workflowPhase,
        actionIntent,
      })
    }

    const gateKind = gateKindForActionIntent(actionIntent)
    const rule = freshnessCue
      ? staleHighRiskRule(freshnessCue)
      : workflowRuleFor(actionIntent, gateKind, workflowPhase) ?? highRiskGateRule(gateKind)

    return buildDecision({
      action: freshnessCue ? 'block' : 'gate',
      riskLevel,
      actionIntent,
      gateKind,
      requiresFreshContext,
      reasonOverride: freshnessCue,
      rule,
      workflowPhase,
      extraTags: [
        input.safetyMode === 'raw' ? 'safety:raw' : 'safety:guarded',
        freshnessCue ? 'freshness:stale' : undefined,
        `intent:${actionIntent}`,
        `gate:${gateKind}`,
      ],
    })
  }
}

export const policyEngine = new PolicyEngine()

export function gateKindForTool(
  input: Pick<PolicyEngineInput, 'toolName' | 'args' | 'risk' | 'currentUrl' | 'refLabel' | 'contextText' | 'workflowState' | 'workflowPhase'>,
): GateKind {
  return gateKindForActionIntent(inferActionIntent(input))
}

export function policyRiskLevel(risk: RiskLevel | undefined): PolicyRiskLevel {
  if (risk === 'L4') return 'critical'
  if (risk === 'L3') return 'high'
  if (risk === 'L2') return 'medium'
  return 'low'
}

export function requiresHumanGate(risk: RiskLevel | undefined): boolean {
  return risk === 'L3' || risk === 'L4'
}

function buildDecision(input: {
  action: PolicyAction
  riskLevel: PolicyRiskLevel
  rule: DecisionRule
  actionIntent?: ActionIntent
  gateKind?: GateKind
  requiresFreshContext?: boolean
  reasonOverride?: string
  workflowPhase?: WorkflowPhase
  extraTags?: Array<string | undefined>
}): PolicyEngineDecision {
  return {
    schemaVersion: 'policy-decision/v1',
    action: input.action,
    riskLevel: input.riskLevel,
    reason: input.reasonOverride ?? input.rule.reason,
    ...(input.actionIntent ? { actionIntent: input.actionIntent } : {}),
    policyCode: input.rule.policyCode,
    ruleId: input.rule.ruleId,
    auditTags: unique([
      `action:${input.action}`,
      `risk:${input.riskLevel}`,
      ...(input.actionIntent ? [`intent:${input.actionIntent}`] : []),
      ...input.rule.tags,
      ...(input.workflowPhase ? [`workflow:${input.workflowPhase}`] : []),
      ...(input.extraTags ?? []),
    ]),
    ...(input.gateKind ? { gateKind: input.gateKind } : {}),
    ...(input.requiresFreshContext ? { requiresFreshContext: input.requiresFreshContext } : {}),
    ...(input.workflowPhase ? { workflowPhase: input.workflowPhase } : {}),
  }
}

function gateKindForActionIntent(intent: ActionIntent): GateKind {
  if (intent === 'login') return 'login'
  if (intent === 'captcha') return 'captcha'
  if (intent === 'upload_resume') return 'upload_resume'
  if (intent === 'save_draft') return 'save_resume'
  if (intent === 'final_submit') return 'final_submit'
  return 'high_risk_action'
}

function workflowRuleFor(
  actionIntent: ActionIntent,
  gateKind: GateKind,
  phase: WorkflowPhase | undefined,
): DecisionRule | undefined {
  if (actionIntent === 'login') {
    return {
      policyCode: 'policy.workflow.login_required',
      ruleId: 'policy.workflow.login_required.v1',
      reason: 'Workflow is in login_required; route this step through the login human gate.',
      tags: ['workflow', 'login_required', 'human_handoff'],
    }
  }
  if (actionIntent === 'captcha') {
    return {
      policyCode: 'policy.workflow.captcha_required',
      ruleId: 'policy.workflow.captcha_required.v1',
      reason: 'Workflow is in captcha_required; route this step through the captcha human gate.',
      tags: ['workflow', 'captcha_required', 'human_handoff'],
    }
  }

  if (actionIntent === 'upload_resume') {
    return {
      policyCode: 'policy.workflow.upload_resume',
      ruleId: 'policy.workflow.upload_resume.v1',
      reason: 'Resume upload requires approval and must be bound to a real upload control.',
      tags: ['workflow', 'upload_resume'],
    }
  }
  if (actionIntent === 'save_draft') {
    return {
      policyCode: 'policy.workflow.save_draft',
      ruleId: 'policy.workflow.save_draft.v1',
      reason: 'Saving an application or resume draft requires a human gate.',
      tags: ['workflow', 'save_draft'],
    }
  }
  if (actionIntent === 'apply_entry') {
    return {
      policyCode: 'policy.workflow.apply_entry',
      ruleId: 'policy.workflow.apply_entry.v1',
      reason: 'Apply-entry action requires a high-risk gate but is not a final-submit action.',
      tags: ['workflow', 'apply_entry'],
    }
  }
  if (actionIntent === 'application_confirm') {
    return {
      policyCode: 'policy.workflow.application_confirm',
      ruleId: 'policy.workflow.application_confirm.v1',
      reason: 'Application-confirm action requires a high-risk gate but is not a final-submit action.',
      tags: ['workflow', 'application_confirm'],
    }
  }
  if (actionIntent === 'final_submit' && phase === 'direct_submit_review') {
    return {
      policyCode: 'policy.workflow.final_submit',
      ruleId: 'policy.workflow.final_submit.v1',
      reason: 'Submit-like action in direct-submit review requires the final-submit safety gate.',
      tags: ['workflow', 'final_submit'],
    }
  }
  if (actionIntent === 'final_submit' && (phase === 'reviewing' || phase === 'ready_for_final_submit')) {
    return {
      policyCode: 'policy.workflow.final_submit',
      ruleId: 'policy.workflow.final_submit.v1',
      reason: 'Submit-like action in review phase requires the final-submit safety gate.',
      tags: ['workflow', 'final_submit'],
    }
  }
  if (actionIntent === 'final_submit' || gateKind === 'final_submit') {
    return {
      policyCode: 'policy.high_risk.gate',
      ruleId: 'policy.high_risk.gate.v1',
      reason: 'Submit-like action requires the final-submit safety gate.',
      tags: ['high_risk', 'final_submit'],
    }
  }
  return undefined
}

function highRiskGateRule(gateKind: GateKind): DecisionRule {
  return {
    policyCode: 'policy.high_risk.gate',
    ruleId: 'policy.high_risk.gate.v1',
    reason: reasonForGate(gateKind),
    tags: ['high_risk'],
  }
}

function staleHighRiskRule(reason: string): DecisionRule {
  return {
    policyCode: 'policy.freshness.high_risk_stale',
    ruleId: 'policy.freshness.high_risk_stale.v1',
    reason,
    tags: ['freshness', 'high_risk_stale'],
  }
}

function workflowPhaseFor(input: Pick<PolicyEngineInput, 'workflowState' | 'workflowPhase'>): WorkflowPhase | undefined {
  return input.workflowPhase ?? input.workflowState?.phase
}

function reasonForGate(gateKind: GateKind): string {
  if (gateKind === 'final_submit') return 'Submit-like action requires the final-submit safety gate.'
  if (gateKind === 'login') return 'Login step requires the login human gate.'
  if (gateKind === 'captcha') return 'Captcha step requires the captcha human gate.'
  if (gateKind === 'upload_resume') return 'Resume upload requires approval.'
  if (gateKind === 'save_resume') return 'Saving the resume or application draft requires approval.'
  return 'High-risk tool action requires a human gate.'
}

function staleFreshnessCue(freshness: PolicyFreshnessSummary | ContextFreshness | undefined): string | undefined {
  if (!freshness) return undefined
  const staleSources: string[] = []
  if (freshness.pageStateStale) staleSources.push(formatStaleSource('page', freshness.pageStateAgeMs, freshness.staleAfterMs))
  if (freshness.formStateStale) staleSources.push(formatStaleSource('form', freshness.formStateAgeMs, freshness.staleAfterMs))
  if (staleSources.length === 0) return undefined
  return `Context appears stale before a high-risk action (${staleSources.join(', ')}). Refresh page/form state before proceeding.`
}

function formatStaleSource(label: string, ageMs: number | undefined, staleAfterMs: number | undefined): string {
  const age = typeof ageMs === 'number' ? `ageMs=${ageMs}` : 'ageMs=unknown'
  const threshold = typeof staleAfterMs === 'number' ? ` staleAfterMs=${staleAfterMs}` : ''
  return `${label} ${age}${threshold}`
}

function unique(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))]
}
