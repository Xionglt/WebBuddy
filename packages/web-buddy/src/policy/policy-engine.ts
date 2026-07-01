import type { ContextFreshness } from '../context/types.js'
import type { GateKind } from '../sdk/human.js'
import type { RiskLevel } from '../sdk/trace.js'
import type { WorkflowPhase, WorkflowState } from '../workflow/workflow-state.js'

export type AgentSafetyMode = 'guarded' | 'raw'
export type PolicyAction = 'allow' | 'gate' | 'block' | 'auto_confirm'
export type PolicyRiskLevel = 'low' | 'medium' | 'high' | 'critical'

export interface PolicyDecision {
  action: PolicyAction
  riskLevel: PolicyRiskLevel
  reason: string
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

const FINAL_ACTION_TEXT =
  /submit|投递|提交|申请|递交|deliver|apply|send|confirm|确认|pay|支付|publish|发布/i
const APPLY_ENTRY_TEXT = /apply|投递|投递简历|立即投递|申请职位|start application|开始申请/i
const REVIEW_SUBMIT_TEXT = /submit|提交|提交申请|确认提交|confirm|确认|pay|支付|publish|发布|send|递交/i

export class PolicyEngine {
  evaluate(input: PolicyEngineInput): PolicyEngineDecision {
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
      })
    }

    const gateKind = gateKindForTool(input)
    const rawAutoConfirm = input.safetyMode === 'raw' && isAutoConfirmClick(input.toolName)
    const rule = rawAutoConfirm
      ? rawAutoConfirmRule()
      : freshnessCue
        ? staleHighRiskRule(freshnessCue)
        : workflowRuleFor(input, gateKind, workflowPhase) ?? highRiskGateRule(gateKind)

    return buildDecision({
      action: rawAutoConfirm ? 'auto_confirm' : freshnessCue ? 'block' : 'gate',
      riskLevel,
      gateKind,
      requiresFreshContext,
      reasonOverride: freshnessCue,
      rule,
      workflowPhase,
      extraTags: [
        input.safetyMode === 'raw' ? 'safety:raw' : 'safety:guarded',
        freshnessCue ? 'freshness:stale' : undefined,
        `gate:${gateKind}`,
      ],
    })
  }
}

export const policyEngine = new PolicyEngine()

export function gateKindForTool(
  input: Pick<PolicyEngineInput, 'toolName' | 'args' | 'currentUrl' | 'refLabel' | 'workflowState' | 'workflowPhase'>,
): GateKind {
  const phase = workflowPhaseFor(input)
  if (phase === 'login_required') return 'login'
  if (phase === 'captcha_required') return 'captcha'
  if (input.toolName === 'browser_click') return gateKindForClick(input)
  if (input.toolName === 'browser_click_text') return gateKindForClickText(input.args, phase)
  return 'high_risk_action'
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
    policyCode: input.rule.policyCode,
    ruleId: input.rule.ruleId,
    auditTags: unique([
      `action:${input.action}`,
      `risk:${input.riskLevel}`,
      ...input.rule.tags,
      ...(input.workflowPhase ? [`workflow:${input.workflowPhase}`] : []),
      ...(input.extraTags ?? []),
    ]),
    ...(input.gateKind ? { gateKind: input.gateKind } : {}),
    ...(input.requiresFreshContext ? { requiresFreshContext: input.requiresFreshContext } : {}),
    ...(input.workflowPhase ? { workflowPhase: input.workflowPhase } : {}),
  }
}

function gateKindForClick(
  input: Pick<PolicyEngineInput, 'args' | 'currentUrl' | 'refLabel' | 'workflowState' | 'workflowPhase'>,
): GateKind {
  const label = String(input.refLabel ?? '')
  const phase = workflowPhaseFor(input)
  const workflowKind = workflowGateKindForText(label, phase)
  if (workflowKind) return workflowKind
  const currentUrl = input.currentUrl ?? ''
  const isAlibabaDetailEntry =
    /talent-holding\.alibaba\.com\/off-campus\/position-detail/i.test(currentUrl) &&
    /投递简历|立即投递|apply/i.test(label)
  if (isAlibabaDetailEntry) return 'high_risk_action'
  return FINAL_ACTION_TEXT.test(label) ? 'final_submit' : 'high_risk_action'
}

function gateKindForClickText(args: Record<string, unknown>, phase: WorkflowPhase | undefined): GateKind {
  const text = String(args.text ?? '')
  const workflowKind = workflowGateKindForText(text, phase)
  if (workflowKind) return workflowKind
  return FINAL_ACTION_TEXT.test(text) ? 'final_submit' : 'high_risk_action'
}

function workflowGateKindForText(text: string, phase: WorkflowPhase | undefined): GateKind | undefined {
  if (!phase) return undefined
  if ((phase === 'job_detail' || phase === 'entering_application') && APPLY_ENTRY_TEXT.test(text)) {
    return 'high_risk_action'
  }
  if (phase === 'direct_submit_review' && (REVIEW_SUBMIT_TEXT.test(text) || APPLY_ENTRY_TEXT.test(text))) {
    return 'final_submit'
  }
  if (
    (phase === 'reviewing' || phase === 'ready_for_final_submit') &&
    REVIEW_SUBMIT_TEXT.test(text)
  ) {
    return 'final_submit'
  }
  if (phase === 'login_required') return 'login'
  if (phase === 'captcha_required') return 'captcha'
  return undefined
}

function workflowRuleFor(
  input: PolicyEngineInput,
  gateKind: GateKind,
  phase: WorkflowPhase | undefined,
): DecisionRule | undefined {
  if (phase === 'login_required') {
    return {
      policyCode: 'policy.workflow.login_required',
      ruleId: 'policy.workflow.login_required.v1',
      reason: 'Workflow is in login_required; route this step through the login human gate.',
      tags: ['workflow', 'login_required', 'human_handoff'],
    }
  }
  if (phase === 'captcha_required') {
    return {
      policyCode: 'policy.workflow.captcha_required',
      ruleId: 'policy.workflow.captcha_required.v1',
      reason: 'Workflow is in captcha_required; route this step through the captcha human gate.',
      tags: ['workflow', 'captcha_required', 'human_handoff'],
    }
  }

  const text = policyTextFor(input)
  if ((phase === 'job_detail' || phase === 'entering_application') && APPLY_ENTRY_TEXT.test(text)) {
    return {
      policyCode: 'policy.workflow.apply_entry',
      ruleId: 'policy.workflow.apply_entry.v1',
      reason: 'Apply-entry action requires a high-risk gate but is not a final-submit action.',
      tags: ['workflow', 'apply_entry'],
    }
  }
  if (phase === 'direct_submit_review' && (REVIEW_SUBMIT_TEXT.test(text) || APPLY_ENTRY_TEXT.test(text))) {
    return {
      policyCode: 'policy.workflow.final_submit',
      ruleId: 'policy.workflow.final_submit.v1',
      reason: 'Submit-like action in direct-submit review requires the final-submit safety gate.',
      tags: ['workflow', 'final_submit'],
    }
  }
  if (
    (phase === 'reviewing' || phase === 'ready_for_final_submit') &&
    REVIEW_SUBMIT_TEXT.test(text)
  ) {
    return {
      policyCode: 'policy.workflow.final_submit',
      ruleId: 'policy.workflow.final_submit.v1',
      reason: 'Submit-like action in review phase requires the final-submit safety gate.',
      tags: ['workflow', 'final_submit'],
    }
  }
  if (gateKind === 'final_submit') {
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

function rawAutoConfirmRule(): DecisionRule {
  return {
    policyCode: 'policy.raw.auto_confirm',
    ruleId: 'policy.raw.auto_confirm.v1',
    reason: 'Raw safety mode auto-confirms high-risk click actions for compatibility.',
    tags: ['raw', 'auto_confirm'],
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

function policyTextFor(input: Pick<PolicyEngineInput, 'toolName' | 'args' | 'refLabel'>): string {
  if (input.toolName === 'browser_click') return String(input.refLabel ?? '')
  if (input.toolName === 'browser_click_text') return String(input.args.text ?? '')
  return ''
}

function isAutoConfirmClick(toolName: string): boolean {
  return toolName === 'browser_click' || toolName === 'browser_click_text'
}

function reasonForGate(gateKind: GateKind): string {
  if (gateKind === 'final_submit') return 'Submit-like action requires the final-submit safety gate.'
  if (gateKind === 'login') return 'Login step requires the login human gate.'
  if (gateKind === 'captcha') return 'Captcha step requires the captcha human gate.'
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
