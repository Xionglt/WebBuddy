import type { GateDecision } from '../sdk/human.js'
import { policyEngine } from './policy-engine.js'
import type { PolicyEngineDecision, ToolPolicyInput } from './policy-engine.js'

export {
  gateKindForTool,
  policyEngine,
  PolicyEngine,
  policyRiskLevel,
  requiresHumanGate,
} from './policy-engine.js'

export type {
  AgentSafetyMode,
  PolicyAction,
  PolicyDecision,
  PolicyEngineDecision,
  PolicyEngineInput,
  PolicyFreshnessSummary,
  PolicyRiskLevel,
  ToolPolicyInput,
} from './policy-engine.js'

export function decideToolPolicy(input: ToolPolicyInput): PolicyEngineDecision {
  return policyEngine.evaluate(input)
}

export function shouldStopAfterGateDecision(decision: GateDecision): boolean {
  return decision === 'takeover'
}
