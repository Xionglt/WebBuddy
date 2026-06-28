import { existsSync, readFileSync, statSync } from 'node:fs'
import type { ResolvedTraceInputs } from './trace-inputs.js'
import { emptyRunMetrics, type RunMetrics, type RunMetricsStatus } from './schema.js'
import { getToolCategory } from '../tools/catalog.js'
import type { ToolCategory } from '../tools/types.js'
import type { PromptSectionId } from '../context/types.js'

interface AgentTraceSessionJson {
  sessionId?: string
  runId?: string
  source?: string
  scenario?: string
  profile?: string
  status?: string
  startedAt?: string
  endedAt?: string
  totals?: {
    spans?: number
    llmCalls?: number
    toolCalls?: number
    mcpToolCalls?: number
    skillCalls?: number
    screenshots?: number
  }
}

interface AgentTraceSpanJson {
  spanType?: string
  name?: string
  toolName?: string
  toolCategory?: string
  status?: string
}

interface LegacyTraceStepJson {
  phase?: string
  action?: string
  toolCategory?: string
  status?: string
  screenshotPath?: string
}

interface AgentTraceEventJson {
  event?: string
  data?: unknown
}

export function aggregateMetrics(inputs: ResolvedTraceInputs): RunMetrics {
  const metrics = emptyRunMetrics({
    runId: inputs.runId,
    sessionId: inputs.sessionId,
    runDir: inputs.runDir,
    traceDir: inputs.traceDir,
    source: inputs.source,
    scenario: inputs.scenario,
    profile: inputs.profile,
    warnings: inputs.warnings,
  })

  applySessionJson(metrics, inputs)
  applySpansJsonl(metrics, inputs)
  applyEventsJsonl(metrics, inputs)
  applyLegacyTraceJsonl(metrics, inputs)
  applyFileSizes(metrics, inputs)

  if (metrics.status === 'unknown') {
    metrics.status = inferStatusFromCounts(metrics)
  }
  return metrics
}

function applySessionJson(metrics: RunMetrics, inputs: ResolvedTraceInputs): void {
  const sessionFile = inputs.files.sessionJson
  if (!sessionFile) return
  const session = readJson<AgentTraceSessionJson>(sessionFile, metrics)
  if (!session) return

  metrics.runId = metrics.runId || session.runId
  metrics.sessionId = metrics.sessionId || session.sessionId
  metrics.scenario = metrics.scenario || session.scenario
  metrics.profile = metrics.profile || session.profile
  metrics.status = mapAgentTraceStatus(session.status)
  metrics.durationMs = durationMs(session.startedAt, session.endedAt) || metrics.durationMs

  const totals = session.totals
  if (totals) {
    metrics.spans = Math.max(metrics.spans, totals.spans || 0)
    metrics.llmCalls = Math.max(metrics.llmCalls, totals.llmCalls || 0)
    metrics.toolCalls = Math.max(metrics.toolCalls, totals.toolCalls || 0)
    metrics.mcpToolCalls = Math.max(metrics.mcpToolCalls, totals.mcpToolCalls || 0)
    metrics.screenshots = Math.max(metrics.screenshots, totals.screenshots || 0)
  }
}

function applySpansJsonl(metrics: RunMetrics, inputs: ResolvedTraceInputs): void {
  const spansFile = inputs.files.spansJsonl
  if (!spansFile) return

  let spans = 0
  let llmCalls = 0
  let toolCalls = 0
  let mcpToolCalls = 0
  let screenshots = 0

  for (const span of readJsonl<AgentTraceSpanJson>(spansFile, metrics)) {
    spans += 1
    const spanType = span.spanType || ''
    const toolName = span.toolName || span.name || ''
    if (spanType === 'llm_call') llmCalls += 1
    if (spanType === 'tool_call') {
      toolCalls += 1
      incrementToolCategory(metrics, resolveToolCategory(toolName, span.toolCategory))
    }
    if (spanType === 'mcp_tool_call') {
      mcpToolCalls += 1
      incrementToolCategory(metrics, resolveToolCategory(toolName, span.toolCategory))
    }
    if (spanType === 'screenshot') screenshots += 1

    if (isBrowserTool(toolName, 'snapshot')) metrics.browserSnapshots += 1
    if (isBrowserTool(toolName, 'click')) metrics.browserClicks += 1
    if (isBrowserTool(toolName, 'type') || isBrowserTool(toolName, 'fill')) metrics.browserTypes += 1
    if (isBrowserTool(toolName, 'wait')) metrics.browserWaits += 1
    if (isBrowserTool(toolName, 'screenshot')) metrics.screenshots += 1
    if (spanType === 'gate' || /handoff|manual/i.test(toolName)) metrics.manualHandoffs += 1
    if (span.status === 'failed' && metrics.status === 'unknown') metrics.status = 'failed'
  }

  metrics.spans = Math.max(metrics.spans, spans)
  metrics.llmCalls = Math.max(metrics.llmCalls, llmCalls)
  metrics.toolCalls = Math.max(metrics.toolCalls, toolCalls)
  metrics.mcpToolCalls = Math.max(metrics.mcpToolCalls, mcpToolCalls)
  metrics.screenshots = Math.max(metrics.screenshots, screenshots)
}

function applyEventsJsonl(metrics: RunMetrics, inputs: ResolvedTraceInputs): void {
  const eventsFile = inputs.files.eventsJsonl
  if (!eventsFile) return

  for (const event of readJsonl<AgentTraceEventJson>(eventsFile, metrics)) {
    metrics.events += 1
    const hay = JSON.stringify(event)
    if (/handoff|manual|WEB_HANDOFF_WAITING/i.test(hay)) metrics.manualHandoffs += 1
    applyPolicyDecisionEvent(metrics, event)
    applyContextSelectionEvent(metrics, event)
  }
}

function applyPolicyDecisionEvent(metrics: RunMetrics, event: AgentTraceEventJson): void {
  if (event.event !== 'policy_decision') return

  const data = tracePayloadValue(event.data)
  if (!isRecord(data)) {
    metrics.policy.decisions += 1
    return
  }

  metrics.policy.decisions += 1
  const action = stringValue(data.action)
  if (action === 'allow') metrics.policy.allows += 1
  else if (action === 'gate') metrics.policy.gates += 1
  else if (action === 'block') {
    metrics.policy.blocks += 1
    incrementCount(metrics.policy.blockedReasonCounts, stringValue(data.reason) ?? 'unknown')
  } else if (action === 'auto_confirm') metrics.policy.autoConfirms += 1

  const gateKind = stringValue(data.gateKind)
  if (gateKind) incrementCount(metrics.policy.gateKindCounts, gateKind)

  const policyCode = stringValue(data.policyCode)
  if (policyCode) incrementCount(metrics.policy.policyCodeCounts, policyCode)
}

function applyContextSelectionEvent(metrics: RunMetrics, event: AgentTraceEventJson): void {
  if (event.event !== 'context_selection') return

  const data = tracePayloadValue(event.data)
  if (!isRecord(data)) {
    metrics.contextBuilds += 1
    return
  }
  const metricSource = isRecord(data.metrics) ? data.metrics : data

  metrics.contextBuilds += numberValue(metricSource.contextBuilds) ?? 1
  metrics.contextChars += numberValue(metricSource.contextChars) ?? 0
  metrics.contextTruncations += numberValue(metricSource.contextTruncations) ?? 0
  metrics.recentActionsIncluded += numberValue(metricSource.recentActionsIncluded) ?? 0
  const freshness = isRecord(metricSource.freshness) ? metricSource.freshness : undefined
  const pageStateAgeMs = numberValue(metricSource.pageStateAgeMs) ?? numberValue(freshness?.pageStateAgeMs)
  const formStateAgeMs = numberValue(metricSource.formStateAgeMs) ?? numberValue(freshness?.formStateAgeMs)
  if (pageStateAgeMs !== undefined) metrics.pageStateAgeMs = Math.max(metrics.pageStateAgeMs, pageStateAgeMs)
  if (formStateAgeMs !== undefined) metrics.formStateAgeMs = Math.max(metrics.formStateAgeMs, formStateAgeMs)

  const promptSectionChars = metricSource.promptSectionChars
  if (!isRecord(promptSectionChars)) return
  for (const [sectionId, rawValue] of Object.entries(promptSectionChars)) {
    const value = numberValue(rawValue)
    if (value === undefined) continue
    const id = sectionId as PromptSectionId
    metrics.promptSectionChars[id] = (metrics.promptSectionChars[id] ?? 0) + value
  }
}

function applyLegacyTraceJsonl(metrics: RunMetrics, inputs: ResolvedTraceInputs): void {
  const traceFile = inputs.files.legacyTraceJsonl
  if (!traceFile) return

  const shouldCountActions = metrics.toolCalls === 0 && metrics.mcpToolCalls === 0
  for (const step of readJsonl<LegacyTraceStepJson>(traceFile, metrics)) {
    metrics.legacySteps += 1
    const action = step.action || step.phase || ''
    const browserAction = /\b(browser_[a-z_]+|agent_done)\b/i.test(action)
    if (shouldCountActions && browserAction) metrics.toolCalls += 1
    if (shouldCountActions) incrementToolCategory(metrics, resolveToolCategory(action, step.toolCategory))
    if (shouldCountActions && /browser_snapshot/i.test(action)) metrics.browserSnapshots += 1
    if (shouldCountActions && /browser_click/i.test(action)) metrics.browserClicks += 1
    if (shouldCountActions && /browser_type|browser_fill/i.test(action)) metrics.browserTypes += 1
    if (shouldCountActions && /browser_wait/i.test(action)) metrics.browserWaits += 1
    if (step.screenshotPath) metrics.screenshots += 1
    if (step.status === 'blocked') metrics.status = 'blocked'
    if (step.status === 'error') metrics.status = 'failed'
  }

  const summary = readJson<{ finalStatus?: string; screenshots?: number; steps?: number }>(inputs.files.summaryJson, metrics)
  if (summary) {
    if (summary.finalStatus && metrics.status === 'unknown') metrics.status = mapLegacyStatus(summary.finalStatus)
    metrics.screenshots = Math.max(metrics.screenshots, summary.screenshots || 0)
    metrics.legacySteps = Math.max(metrics.legacySteps, summary.steps || 0)
  }
}

function applyFileSizes(metrics: RunMetrics, inputs: ResolvedTraceInputs): void {
  metrics.stdoutBytes = fileSize(inputs.files.stdoutLog)
  metrics.stderrBytes = fileSize(inputs.files.stderrLog)
  metrics.streamJsonBytes = fileSize(inputs.files.streamJsonl)
  metrics.runLogBytes = fileSize(inputs.files.runLog)
  metrics.promptBytes = fileSize(inputs.files.prompt)
}

function readJson<T>(file: string | undefined, metrics: RunMetrics): T | undefined {
  if (!file || !existsSync(file)) return undefined
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T
  } catch (error) {
    metrics.warnings.push(`Failed to parse JSON ${file}: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
}

function readJsonl<T>(file: string, metrics: RunMetrics): T[] {
  if (!existsSync(file)) return []
  const out: T[] = []
  const text = readFileSync(file, 'utf8')
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim()
    if (!line) continue
    try {
      out.push(JSON.parse(line) as T)
    } catch (error) {
      metrics.warnings.push(`Failed to parse JSONL ${file}:${i + 1}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return out
}

function durationMs(startedAt: string | undefined, endedAt: string | undefined): number {
  if (!startedAt || !endedAt) return 0
  const start = Date.parse(startedAt)
  const end = Date.parse(endedAt)
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return 0
  return end - start
}

function fileSize(file: string | undefined): number {
  if (!file || !existsSync(file)) return 0
  try {
    return statSync(file).size
  } catch {
    return 0
  }
}

function mapAgentTraceStatus(status: string | undefined): RunMetricsStatus {
  if (status === 'success') return 'completed'
  if (status === 'failed') return 'failed'
  if (status === 'cancelled') return 'incomplete'
  if (status === 'running') return 'incomplete'
  return 'unknown'
}

function mapLegacyStatus(status: string): RunMetricsStatus {
  if (status === 'ok') return 'completed'
  if (status === 'blocked') return 'blocked'
  if (status === 'error') return 'failed'
  if (status === 'warn') return 'incomplete'
  return 'unknown'
}

function inferStatusFromCounts(metrics: RunMetrics): RunMetricsStatus {
  if (metrics.spans > 0 || metrics.events > 0 || metrics.legacySteps > 0) return 'incomplete'
  return 'unknown'
}

function isBrowserTool(toolName: string, operation: string): boolean {
  const normalized = toolName.toLowerCase()
  return normalized === `browser_${operation}` ||
    normalized.endsWith(`__browser_${operation}`) ||
    normalized.includes(`browser_${operation}`)
}

function resolveToolCategory(toolName: string, category: string | undefined): ToolCategory | undefined {
  if (category === 'observation' || category === 'action' || category === 'human' || category === 'eval') {
    return category
  }
  const canonical = canonicalToolName(toolName)
  return canonical ? getToolCategory(canonical) : undefined
}

function canonicalToolName(toolName: string): string | undefined {
  const match = toolName.toLowerCase().match(/(?:^|__)browser_[a-z_]+|(?:^|__)agent_done/)
  if (!match) return undefined
  return match[0].replace(/^__/, '')
}

function incrementToolCategory(metrics: RunMetrics, category: ToolCategory | undefined): void {
  if (category === 'observation') metrics.observationToolCalls += 1
  if (category === 'action') metrics.actionToolCalls += 1
  if (category === 'human') metrics.humanToolCalls += 1
  if (category === 'eval') metrics.evalToolCalls += 1
}

function tracePayloadValue(value: unknown): unknown {
  if (!isRecord(value)) return value
  if (typeof value.kind === 'string' && Object.prototype.hasOwnProperty.call(value, 'value')) {
    return value.value
  }
  return value
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function incrementCount(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
