import type { ContextFreshness } from '../context/types.js'
import type { GateDecision, GateKind } from '../sdk/human.js'
import type { RiskLevel } from '../sdk/trace.js'

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

export interface ToolPolicyInput {
  toolName: string
  args: Record<string, unknown>
  risk?: RiskLevel
  safetyMode?: 'guarded' | 'raw'
  currentUrl?: string
  refLabel?: string
  freshness?: PolicyFreshnessSummary | ContextFreshness
}

const FINAL_ACTION_TEXT =
  /submit|投递|提交|申请|递交|deliver|apply|send|confirm|确认|pay|支付|publish|发布/i

export function decideToolPolicy(input: ToolPolicyInput): PolicyDecision {
  const riskLevel = policyRiskLevel(input.risk)
  const requiresFreshContext = riskLevel === 'high' || riskLevel === 'critical'
  const freshnessCue = requiresFreshContext ? staleFreshnessCue(input.freshness) : undefined

  if (!requiresHumanGate(input.risk)) {
    return {
      action: 'allow',
      riskLevel,
      reason: freshnessCue ?? 'Tool risk does not require a human gate.',
      ...(requiresFreshContext ? { requiresFreshContext } : {}),
    }
  }

  const gateKind = gateKindForTool(input)
  const reason = freshnessCue ?? reasonForGate(gateKind)
  const common = {
    riskLevel,
    reason,
    gateKind,
    requiresFreshContext,
  }

  if (input.safetyMode === 'raw' && isAutoConfirmClick(input.toolName)) {
    return {
      action: 'auto_confirm',
      ...common,
    }
  }

  return {
    action: 'gate',
    ...common,
  }
}

export function gateKindForTool(input: Pick<ToolPolicyInput, 'toolName' | 'args' | 'currentUrl' | 'refLabel'>): GateKind {
  if (input.toolName === 'browser_click') return gateKindForClick(input)
  if (input.toolName === 'browser_click_text') return gateKindForClickText(input.args)
  return 'high_risk_action'
}

export function shouldStopAfterGateDecision(decision: GateDecision): boolean {
  return decision === 'takeover'
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

function gateKindForClick(input: Pick<ToolPolicyInput, 'args' | 'currentUrl' | 'refLabel'>): GateKind {
  const label = String(input.refLabel ?? '')
  const currentUrl = input.currentUrl ?? ''
  const isAlibabaDetailEntry =
    /talent-holding\.alibaba\.com\/off-campus\/position-detail/i.test(currentUrl) &&
    /投递简历|立即投递|apply/i.test(label)
  if (isAlibabaDetailEntry) return 'high_risk_action'
  return FINAL_ACTION_TEXT.test(label) ? 'final_submit' : 'high_risk_action'
}

function gateKindForClickText(args: Record<string, unknown>): GateKind {
  const text = String(args.text ?? '')
  return FINAL_ACTION_TEXT.test(text) ? 'final_submit' : 'high_risk_action'
}

function isAutoConfirmClick(toolName: string): boolean {
  return toolName === 'browser_click' || toolName === 'browser_click_text'
}

function reasonForGate(gateKind: GateKind): string {
  if (gateKind === 'final_submit') return 'Submit-like action requires the final-submit safety gate.'
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
