import type { GateKind } from '../sdk/human.js'
import type { RiskLevel } from '../sdk/trace.js'
import type { PermissionDecision, PermissionMode, PermissionRequest } from '../permission/permission-types.js'
import type { PolicyAction, PolicyEngineDecision, PolicyRiskLevel } from './policy-engine.js'
import type { PolicyAuditEvent } from './policy-audit.js'

export const RISK_DECISIONS_ARTIFACT = 'risk-decisions.json'

export type RiskDecisionSource = 'policy' | 'permission'
export type RiskDecisionOutcome = 'allow' | 'ask' | 'deny' | 'auto_allow'

export interface RiskDecisionRecord {
  schemaVersion: 'risk-decision/v1'
  source: RiskDecisionSource
  step?: number
  tool: string
  action: string
  risk?: RiskLevel
  riskLevel: PolicyRiskLevel
  gateKind?: GateKind
  decision: RiskDecisionOutcome
  permissionMode?: PermissionMode
  reason: string
  url?: string
  timestamp: string
  policyCode?: string
  ruleId?: string
  requestId?: string
}

export interface RiskDecisionSummary {
  total: number
  allowed: number
  autoAllowed: number
  gated: number
  denied: number
}

export interface RiskDecisionsArtifact {
  schemaVersion: 'risk-decisions/v1'
  runId?: string
  sessionId?: string
  generatedAt: string
  decisions: RiskDecisionRecord[]
  summary: RiskDecisionSummary
}

export interface AgentTraceEventJson {
  ts?: string
  event?: string
  data?: unknown
}

export function createRiskDecisionsArtifact(input: {
  runId?: string
  sessionId?: string
  generatedAt?: string
  decisions?: RiskDecisionRecord[]
}): RiskDecisionsArtifact {
  const decisions = input.decisions ? [...input.decisions] : []
  return {
    schemaVersion: 'risk-decisions/v1',
    ...(input.runId ? { runId: input.runId } : {}),
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    decisions,
    summary: summarizeRiskDecisions(decisions),
  }
}

export function appendRiskDecision(
  artifact: RiskDecisionsArtifact,
  decision: RiskDecisionRecord,
): RiskDecisionsArtifact {
  artifact.decisions.push(decision)
  artifact.generatedAt = new Date().toISOString()
  artifact.summary = summarizeRiskDecisions(artifact.decisions)
  return artifact
}

export function serializeRiskDecisionsArtifact(artifact: RiskDecisionsArtifact): string {
  return `${JSON.stringify({
    ...artifact,
    summary: summarizeRiskDecisions(artifact.decisions),
  }, null, 2)}\n`
}

export function createPolicyRiskDecision(input: {
  step?: number
  toolName: string
  action?: string
  risk?: RiskLevel
  url?: string
  permissionMode?: PermissionMode
  decision: PolicyEngineDecision | PolicyAuditEvent
  timestamp?: string
}): RiskDecisionRecord {
  const decision = input.decision
  return compactRecord({
    source: 'policy',
    step: input.step ?? ('step' in decision ? decision.step : undefined),
    tool: input.toolName,
    action: input.action ?? input.toolName,
    risk: input.risk ?? ('risk' in decision ? decision.risk : undefined) ?? riskFromRiskLevel(decision.riskLevel),
    riskLevel: decision.riskLevel,
    gateKind: decision.gateKind,
    decision: policyOutcome(decision.action),
    permissionMode: input.permissionMode,
    reason: decision.reason,
    url: input.url,
    timestamp: input.timestamp ?? ('at' in decision ? decision.at : undefined) ?? new Date().toISOString(),
    policyCode: decision.policyCode,
    ruleId: decision.ruleId,
  })
}

export function createPermissionRiskDecision(input: {
  step?: number
  request?: PermissionRequest | Record<string, unknown>
  decision: PermissionDecision | Record<string, unknown>
  timestamp?: string
}): RiskDecisionRecord {
  const request = recordFromUnknown(input.request)
  const decision = recordFromUnknown(input.decision) ?? {}
  const subject = recordFromUnknown(request?.subject)
  const tool = permissionToolName(subject, request)
  const action = permissionActionName(tool, subject)
  const riskLevel = policyRiskLevelValue(decision.riskLevel) ?? policyRiskLevelValue(request?.riskLevel) ?? 'low'
  const risk = riskLevelValue(decision.risk) ?? riskLevelValue(request?.risk) ?? riskFromRiskLevel(riskLevel)
  const gateKind = gateKindValue(decision.gateKind) ?? gateKindValue(request?.gateKind)
  const auditTags = stringArray(decision.auditTags)
  const rawAction = stringValue(decision.action)
  const outcome = rawAction === 'allow' && auditTags.includes('permission:auto_allow')
    ? 'auto_allow'
    : permissionOutcome(rawAction)
  return compactRecord({
    source: 'permission',
    step: numberValue(input.step) ?? numberValue(request?.step),
    tool,
    action,
    risk,
    riskLevel,
    gateKind,
    decision: outcome,
    permissionMode: permissionModeValue(decision.permissionMode),
    reason: stringValue(decision.reason) ?? stringValue(request?.policy && recordFromUnknown(request.policy)?.reason) ?? 'Permission decision recorded.',
    url: stringValue(request?.currentUrl),
    timestamp: input.timestamp ?? stringValue(decision.decidedAt) ?? new Date().toISOString(),
    policyCode: stringValue(decision.policyCode) ?? stringValue(request?.policy && recordFromUnknown(request.policy)?.policyCode),
    ruleId: stringValue(decision.ruleId),
    requestId: stringValue(decision.requestId) ?? stringValue(request?.requestId),
  })
}

export function createRiskDecisionsArtifactFromEvents(input: {
  events: AgentTraceEventJson[]
  runId?: string
  sessionId?: string
  generatedAt?: string
}): RiskDecisionsArtifact {
  const decisions: RiskDecisionRecord[] = []
  for (const event of input.events) {
    const value = tracePayloadValue(event.data)
    if (event.event === 'policy_decision' && isPolicyAuditEventLike(value)) {
      decisions.push(createPolicyRiskDecision({
        step: value.step,
        toolName: value.toolName,
        risk: riskLevelValue(value.risk),
        decision: value,
        timestamp: event.ts ?? value.at,
      }))
      continue
    }
    if (event.event === 'permission_decision') {
      const data = recordFromUnknown(value)
      if (!data) continue
      const decision = recordFromUnknown(data.decision) ?? data
      if (!decision) continue
      decisions.push(createPermissionRiskDecision({
        step: numberValue(data.step),
        request: recordFromUnknown(data.request),
        decision,
        timestamp: event.ts,
      }))
    }
  }
  return createRiskDecisionsArtifact({
    runId: input.runId,
    sessionId: input.sessionId,
    generatedAt: input.generatedAt,
    decisions,
  })
}

export function summarizeRiskDecisions(decisions: RiskDecisionRecord[]): RiskDecisionSummary {
  const summary: RiskDecisionSummary = {
    total: decisions.length,
    allowed: 0,
    autoAllowed: 0,
    gated: 0,
    denied: 0,
  }
  for (const decision of decisions) {
    if (decision.decision === 'allow') summary.allowed += 1
    else if (decision.decision === 'auto_allow') summary.autoAllowed += 1
    else if (decision.decision === 'ask') summary.gated += 1
    else if (decision.decision === 'deny') summary.denied += 1
  }
  return summary
}

export function formatCompactRiskDecision(decision: RiskDecisionRecord): string {
  const subject = gateLabel(decision.gateKind)
  const action = decision.action || decision.tool
  if (decision.decision === 'auto_allow') {
    const mode = decision.permissionMode ? ` by ${decision.permissionMode} mode` : ''
    return `${subject} auto-allowed${mode}: ${action} | ${decision.reason}`
  }
  if (decision.decision === 'ask') {
    return `${subject} gated: ${action} | ${decision.reason}`
  }
  if (decision.decision === 'deny') {
    return `${subject} denied: ${action} | ${decision.reason}`
  }
  return `${subject} allowed: ${action} | ${decision.reason}`
}

export function shouldShowCompactRiskDecision(decision: RiskDecisionRecord): boolean {
  return decision.riskLevel === 'high' ||
    decision.riskLevel === 'critical' ||
    decision.decision === 'ask' ||
    decision.decision === 'deny' ||
    decision.decision === 'auto_allow'
}

export function formatRiskLine(decision: RiskDecisionRecord): string {
  const risk = decision.risk ?? riskFromRiskLevel(decision.riskLevel)
  const gate = decision.gateKind ? ` gate=${decision.gateKind}` : ''
  return `${decision.tool}: risk ${risk}/${decision.riskLevel}${gate} | ${decision.reason}`
}

function compactRecord(input: {
  source: RiskDecisionSource
  step?: number
  tool: string
  action: string
  risk?: RiskLevel
  riskLevel: PolicyRiskLevel
  gateKind?: GateKind
  decision: RiskDecisionOutcome
  permissionMode?: PermissionMode
  reason: string
  url?: string
  timestamp: string
  policyCode?: string
  ruleId?: string
  requestId?: string
}): RiskDecisionRecord {
  return {
    schemaVersion: 'risk-decision/v1',
    source: input.source,
    ...(input.step !== undefined ? { step: input.step } : {}),
    tool: input.tool,
    action: sanitizeAction(input.action || input.tool),
    ...(input.risk ? { risk: input.risk } : {}),
    riskLevel: input.riskLevel,
    ...(input.gateKind ? { gateKind: input.gateKind } : {}),
    decision: input.decision,
    ...(input.permissionMode ? { permissionMode: input.permissionMode } : {}),
    reason: input.reason,
    ...(input.url ? { url: truncateUrl(input.url) } : {}),
    timestamp: input.timestamp,
    ...(input.policyCode ? { policyCode: input.policyCode } : {}),
    ...(input.ruleId ? { ruleId: input.ruleId } : {}),
    ...(input.requestId ? { requestId: input.requestId } : {}),
  }
}

function policyOutcome(action: PolicyAction): RiskDecisionOutcome {
  if (action === 'gate') return 'ask'
  if (action === 'block') return 'deny'
  if (action === 'auto_confirm') return 'auto_allow'
  return 'allow'
}

function permissionOutcome(action: string | undefined): RiskDecisionOutcome {
  if (action === 'ask') return 'ask'
  if (action === 'deny') return 'deny'
  return 'allow'
}

function gateLabel(gateKind: GateKind | undefined): string {
  if (gateKind === 'final_submit') return 'final-submit'
  if (gateKind === 'upload_resume') return 'resume upload'
  if (gateKind === 'save_resume') return 'save-resume'
  if (gateKind === 'login') return 'login'
  if (gateKind === 'captcha') return 'captcha'
  return 'high-risk action'
}

function permissionToolName(
  subject: Record<string, unknown> | undefined,
  request: Record<string, unknown> | undefined,
): string {
  const subjectTool = stringValue(subject?.toolName)
  if (subjectTool) return subjectTool
  const handoff = stringValue(subject?.handoffKind) ?? stringValue(request?.gateKind)
  return handoff ? `workflow_${handoff}` : 'unknown'
}

function permissionActionName(tool: string, subject: Record<string, unknown> | undefined): string {
  const argBrief = stringValue(subject?.argBrief)
  if (!argBrief) return tool
  return `${tool}(${argBrief})`
}

function sanitizeAction(value: string): string {
  return value
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[redacted]')
    .replace(/([A-Za-z0-9._%+-]+)@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g, '[email:redacted]')
    .replace(/\b1[3-9]\d{9}\b/g, '[phone:redacted]')
    .replace(/(api[_-]?key|token|authorization|password|secret|cookie)(["':=\s]+)([^"'\s,}]+)/gi, '$1$2[redacted]')
    .slice(0, 240)
}

function truncateUrl(url: string, max = 160): string {
  if (url.length <= max) return url
  return `${url.slice(0, max)}...<+${url.length - max} chars>`
}

function riskFromRiskLevel(riskLevel: PolicyRiskLevel): RiskLevel {
  if (riskLevel === 'critical') return 'L4'
  if (riskLevel === 'high') return 'L3'
  if (riskLevel === 'medium') return 'L2'
  return 'L1'
}

function tracePayloadValue(value: unknown): unknown {
  const record = recordFromUnknown(value)
  if (!record) return value
  if (typeof record.kind === 'string' && Object.prototype.hasOwnProperty.call(record, 'value')) {
    return record.value
  }
  return value
}

function isPolicyAuditEventLike(value: unknown): value is PolicyAuditEvent & { risk?: RiskLevel } {
  const record = recordFromUnknown(value)
  return Boolean(record &&
    record.schemaVersion === 'policy-audit/v1' &&
    typeof record.toolName === 'string' &&
    typeof record.action === 'string' &&
    typeof record.riskLevel === 'string' &&
    typeof record.policyCode === 'string' &&
    typeof record.ruleId === 'string' &&
    typeof record.reason === 'string')
}

function recordFromUnknown(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function riskLevelValue(value: unknown): RiskLevel | undefined {
  return value === 'L0' || value === 'L1' || value === 'L2' || value === 'L3' || value === 'L4'
    ? value
    : undefined
}

function policyRiskLevelValue(value: unknown): PolicyRiskLevel | undefined {
  return value === 'low' || value === 'medium' || value === 'high' || value === 'critical'
    ? value
    : undefined
}

function gateKindValue(value: unknown): GateKind | undefined {
  return typeof value === 'string' ? value as GateKind : undefined
}

function permissionModeValue(value: unknown): PermissionMode | undefined {
  return value === 'safe' || value === 'review' || value === 'trusted' || value === 'autopilot'
    ? value
    : undefined
}
