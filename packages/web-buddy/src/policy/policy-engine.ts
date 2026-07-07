import type { ContextFreshness } from '../context/types.js'
import type { GateKind } from '../sdk/human.js'
import type { RiskLevel } from '../sdk/trace.js'
import { inferActionIntent, type ActionIntent } from './action-intent.js'
import { classifySafetyInvariant } from './safety-invariants.js'
import type { SafetyInvariantDecision } from './safety-invariants.js'

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
  refLabel?: string
  contextText?: string
  freshness?: PolicyFreshnessSummary | ContextFreshness
  pageSignals?: {
    hasOnlySubmitLikeControls?: boolean
    formFieldsPresent?: boolean
  }
  confirmed?: boolean
}

export type ToolPolicyInput = PolicyEngineInput

export interface PolicyEngineDecision extends PolicyDecision {
  schemaVersion: 'policy-decision/v1'
  policyCode: string
  ruleId: string
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
    const requiresFreshContext = requiresHumanGate(input.risk)
    const freshnessCue = requiresFreshContext ? staleFreshnessCue(input.freshness) : undefined
    const invariant = classifySafetyInvariant(input)

    if (!requiresHumanGate(input.risk) && invariant.action === 'allow') {
      return buildDecision({
        action: 'allow',
        riskLevel,
        rule: {
          policyCode: 'policy.low_risk.allow',
          ruleId: 'policy.low_risk.allow.v1',
          reason: 'Tool risk does not require a human gate.',
          tags: ['low_risk'],
        },
        actionIntent,
      })
    }

    const gateKind = invariant.gateKind
    const rule = freshnessCue
      ? staleHighRiskRule(freshnessCue)
      : safetyInvariantRule(invariant)

    return buildDecision({
      action: freshnessCue ? 'block' : invariant.action === 'block' ? 'block' : 'gate',
      riskLevel,
      actionIntent,
      gateKind,
      requiresFreshContext,
      reasonOverride: freshnessCue,
      rule,
      extraTags: [
        input.safetyMode === 'raw' ? 'safety:raw' : 'safety:guarded',
        freshnessCue ? 'freshness:stale' : undefined,
        `intent:${actionIntent}`,
        `gate:${gateKind}`,
        invariant.invariant ? `invariant:${invariant.invariant}` : undefined,
      ],
    })
  }
}

export const policyEngine = new PolicyEngine()

export function gateKindForTool(
  input: Pick<PolicyEngineInput, 'toolName' | 'args' | 'risk' | 'refLabel' | 'contextText' | 'pageSignals' | 'confirmed'>,
): GateKind {
  return classifySafetyInvariant(input).gateKind
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
      ...(input.extraTags ?? []),
    ]),
    ...(input.gateKind ? { gateKind: input.gateKind } : {}),
    ...(input.requiresFreshContext ? { requiresFreshContext: input.requiresFreshContext } : {}),
  }
}

function safetyInvariantRule(decision: SafetyInvariantDecision): DecisionRule {
  return {
    policyCode: 'policy.high_risk.gate',
    ruleId: 'policy.high_risk.gate.v1',
    reason: decision.reason,
    tags: ['high_risk', ...(decision.invariant ? [decision.invariant] : [])],
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
