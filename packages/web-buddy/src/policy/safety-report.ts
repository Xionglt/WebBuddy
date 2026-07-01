import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { aggregateMetrics } from '../metrics/aggregate.js'
import type { RunMetrics, RunMetricsStatus } from '../metrics/schema.js'
import { resolveTraceInputs, type ResolveTraceInputsOptions, type ResolvedTraceInputs } from '../metrics/trace-inputs.js'
import type { WorkflowPhase } from '../workflow/workflow-state.js'
import type { PolicyAuditEvent } from './policy-audit.js'
import {
  createRiskDecisionsArtifactFromEvents,
  type RiskDecisionRecord,
  type RiskDecisionSummary,
} from './risk-decisions.js'

export interface SafetyReport {
  schemaVersion: 'safety-report/v1'
  runId: string
  finalStatus: RunMetricsStatus
  finalWorkflowPhase?: WorkflowPhase
  finalSubmitAttempted: boolean
  finalSubmitBlocked: boolean
  loginHandoffRequired: boolean
  captchaHandoffRequired: boolean
  highRiskActionCount: number
  gateCount: number
  riskDecisionCount: number
  autoAllowedCount: number
  gatedCount: number
  deniedCount: number
  policyCodes: string[]
  summary: string
}

export interface SafetyReportResult {
  report: SafetyReport
  metrics: RunMetrics
  inputs: ResolvedTraceInputs
}

interface AgentTraceEventJson {
  event?: string
  data?: unknown
}

interface LegacyTraceStepJson {
  phase?: string
  action?: string
  status?: string
  observation?: string
}

export function generateSafetyReport(options: ResolveTraceInputsOptions = {}): SafetyReportResult {
  const inputs = resolveTraceInputs(options)
  const metrics = aggregateMetrics(inputs)
  const traceEvents = readJsonl<AgentTraceEventJson>(inputs.files.eventsJsonl)
  const policyEvents = readPolicyEvents(traceEvents)
  const riskDecisions = createRiskDecisionsArtifactFromEvents({
    events: traceEvents,
    runId: metrics.runId || inputs.runId,
    sessionId: metrics.sessionId || inputs.sessionId,
  })
  const riskSummary = summarizeFinalRiskOutcomes(riskDecisions.decisions)
  const legacySteps = readJsonl<LegacyTraceStepJson>(inputs.files.legacyTraceJsonl)
  const policyCodes = unique([
    ...policyEvents.map((event) => event.policyCode),
    ...Object.keys(metrics.policy.policyCodeCounts),
  ])
  const finalWorkflowPhase = lastWorkflowPhase(policyEvents)
  const finalSubmitAttempted =
    policyEvents.some((event) => event.gateKind === 'final_submit') ||
    (metrics.policy.gateKindCounts.final_submit ?? 0) > 0 ||
    legacySteps.some((step) => /GATE \[final_submit\]|final-submit/i.test(step.action ?? step.observation ?? ''))
  const finalSubmitBlocked =
    finalSubmitAttempted &&
    (metrics.status === 'blocked' ||
      policyEvents.some((event) => event.gateKind === 'final_submit' && event.action === 'block') ||
      legacySteps.some((step) => /GATE \[final_submit\]|final-submit/i.test(step.action ?? step.observation ?? '') && step.status === 'blocked'))
  const loginHandoffRequired =
    policyEvents.some((event) => event.gateKind === 'login' || event.workflowPhase === 'login_required') ||
    (metrics.policy.gateKindCounts.login ?? 0) > 0 ||
    legacySteps.some((step) => /login required|human login/i.test(step.action ?? step.observation ?? ''))
  const captchaHandoffRequired =
    policyEvents.some((event) => event.gateKind === 'captcha' || event.workflowPhase === 'captcha_required') ||
    (metrics.policy.gateKindCounts.captcha ?? 0) > 0 ||
    legacySteps.some((step) => /captcha|verification required|human verification/i.test(step.action ?? step.observation ?? ''))
  const highRiskActionCount = policyEvents.length > 0
    ? policyEvents.filter((event) => event.riskLevel === 'high' || event.riskLevel === 'critical').length
    : metrics.policy.gates + metrics.policy.blocks + metrics.policy.autoConfirms
  const gateCount = metrics.policy.gates || policyEvents.filter((event) => event.action === 'gate').length

  const report: SafetyReport = {
    schemaVersion: 'safety-report/v1',
    runId: metrics.runId || inputs.runId || 'unknown',
    finalStatus: metrics.status,
    finalSubmitAttempted,
    finalSubmitBlocked,
    loginHandoffRequired,
    captchaHandoffRequired,
    highRiskActionCount,
    gateCount,
    riskDecisionCount: riskDecisions.summary.total,
    autoAllowedCount: riskSummary.autoAllowed,
    gatedCount: riskSummary.gated,
    deniedCount: riskSummary.denied,
    policyCodes,
    summary: summarizeSafety({
      finalStatus: metrics.status,
      finalSubmitAttempted,
      finalSubmitBlocked,
      loginHandoffRequired,
      captchaHandoffRequired,
      highRiskActionCount,
      gateCount,
      riskDecisionCount: riskDecisions.summary.total,
      autoAllowedCount: riskSummary.autoAllowed,
      gatedCount: riskSummary.gated,
      deniedCount: riskSummary.denied,
    }),
    ...(finalWorkflowPhase ? { finalWorkflowPhase } : {}),
  }

  return { report, metrics, inputs }
}

export function safetyReportPath(inputs: ResolvedTraceInputs): string {
  if (inputs.traceDir) return join(inputs.traceDir, 'safety-report.json')
  if (inputs.runDir) return join(inputs.runDir, 'safety-report.json')
  throw new Error('Cannot write safety report without traceDir or runDir.')
}

export function writeSafetyReport(report: SafetyReport, path: string): string {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(report, null, 2))
  return path
}

export function generateAndWriteSafetyReport(options: ResolveTraceInputsOptions = {}): SafetyReportResult & { path: string } {
  const result = generateSafetyReport(options)
  const path = safetyReportPath(result.inputs)
  writeSafetyReport(result.report, path)
  return { ...result, path }
}

function readPolicyEvents(events: AgentTraceEventJson[]): PolicyAuditEvent[] {
  return events
    .filter((event) => event.event === 'policy_decision')
    .map((event) => tracePayloadValue(event.data))
    .filter(isPolicyAuditEvent)
}

function lastWorkflowPhase(events: PolicyAuditEvent[]): WorkflowPhase | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const phase = events[i]?.workflowPhase
    if (phase) return phase
  }
  return undefined
}

function summarizeSafety(input: {
  finalStatus: RunMetricsStatus
  finalSubmitAttempted: boolean
  finalSubmitBlocked: boolean
  loginHandoffRequired: boolean
  captchaHandoffRequired: boolean
  highRiskActionCount: number
  gateCount: number
  riskDecisionCount: number
  autoAllowedCount: number
  gatedCount: number
  deniedCount: number
}): string {
  if (input.finalSubmitBlocked) {
    return `Final submit was attempted and blocked; ${input.gateCount} policy gate(s), ${input.autoAllowedCount} auto-allowed, ${input.gatedCount} gated, and ${input.deniedCount} denied risk outcome(s) were recorded.`
  }
  if (input.loginHandoffRequired) return 'Run required human login handoff before continuing.'
  if (input.captchaHandoffRequired) return 'Run required human verification handoff before continuing.'
  if (input.finalSubmitAttempted) return 'Final submit was attempted; review gate outcome before replaying.'
  return `Run ended with status ${input.finalStatus}; ${input.highRiskActionCount} high-risk policy decision(s), ${input.autoAllowedCount} auto-allowed, ${input.gatedCount} gated, and ${input.deniedCount} denied risk outcome(s) were recorded.`
}

function summarizeFinalRiskOutcomes(decisions: RiskDecisionRecord[]): RiskDecisionSummary {
  const permissionKeys = new Set<string>()
  for (const decision of decisions) {
    if (decision.source !== 'permission') continue
    for (const key of riskDecisionActionKeys(decision)) permissionKeys.add(key)
  }
  const finalDecisions = decisions.filter((decision) => {
    if (decision.source !== 'policy') return true
    return !riskDecisionActionKeys(decision).some((key) => permissionKeys.has(key))
  })
  return {
    total: finalDecisions.length,
    allowed: finalDecisions.filter((decision) => decision.decision === 'allow').length,
    autoAllowed: finalDecisions.filter((decision) => decision.decision === 'auto_allow').length,
    gated: finalDecisions.filter((decision) => decision.decision === 'ask').length,
    denied: finalDecisions.filter((decision) => decision.decision === 'deny').length,
  }
}

function riskDecisionActionKeys(decision: RiskDecisionRecord): string[] {
  return [
    decision.requestId ? `request:${decision.requestId}` : '',
    `${decision.step ?? 'unknown'}:${decision.tool}`,
  ].filter(Boolean)
}

function readJsonl<T>(file: string | undefined): T[] {
  if (!file || !existsSync(file)) return []
  const out: T[] = []
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      out.push(JSON.parse(trimmed) as T)
    } catch {
      // Safety report is best-effort diagnostic output.
    }
  }
  return out
}

function tracePayloadValue(value: unknown): unknown {
  if (!isRecord(value)) return value
  if (typeof value.kind === 'string' && Object.prototype.hasOwnProperty.call(value, 'value')) {
    return value.value
  }
  return value
}

function isPolicyAuditEvent(value: unknown): value is PolicyAuditEvent {
  if (!isRecord(value)) return false
  return value.schemaVersion === 'policy-audit/v1' &&
    typeof value.toolName === 'string' &&
    typeof value.action === 'string' &&
    typeof value.riskLevel === 'string' &&
    typeof value.policyCode === 'string' &&
    typeof value.ruleId === 'string' &&
    typeof value.reason === 'string'
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
