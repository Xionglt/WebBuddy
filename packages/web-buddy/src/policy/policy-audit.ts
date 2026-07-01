import type { GateKind } from '../sdk/human.js'
import type { RiskLevel } from '../sdk/trace.js'
import type { WorkflowPhase } from '../workflow/workflow-state.js'
import type { PolicyAction, PolicyEngineDecision, PolicyRiskLevel } from './policy-engine.js'

export interface PolicyAuditEvent {
  schemaVersion: 'policy-audit/v1'
  at: string
  sessionId: string
  step: number
  toolName: string
  risk?: RiskLevel
  action: PolicyAction
  riskLevel: PolicyRiskLevel
  gateKind?: GateKind
  policyCode: string
  ruleId: string
  reason: string
  workflowPhase?: WorkflowPhase
  requiresFreshContext?: boolean
}

export function createPolicyAuditEvent(input: {
  sessionId: string
  step: number
  toolName: string
  risk?: RiskLevel
  decision: PolicyEngineDecision
  at?: string
}): PolicyAuditEvent {
  const { decision } = input
  return {
    schemaVersion: 'policy-audit/v1',
    at: input.at ?? new Date().toISOString(),
    sessionId: input.sessionId,
    step: input.step,
    toolName: input.toolName,
    ...(input.risk ? { risk: input.risk } : {}),
    action: decision.action,
    riskLevel: decision.riskLevel,
    policyCode: decision.policyCode,
    ruleId: decision.ruleId,
    reason: decision.reason,
    ...(decision.gateKind ? { gateKind: decision.gateKind } : {}),
    ...(decision.workflowPhase ? { workflowPhase: decision.workflowPhase } : {}),
    ...(decision.requiresFreshContext ? { requiresFreshContext: decision.requiresFreshContext } : {}),
  }
}
