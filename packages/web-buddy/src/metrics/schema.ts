import type { RunSource } from './trace-inputs.js'
import type { PromptSectionId } from '../context/types.js'

export type RunMetricsStatus = 'completed' | 'blocked' | 'incomplete' | 'failed' | 'unknown'
export type FailureCategory = 'login' | 'captcha' | 'form' | 'navigation' | 'model' | 'tool' | 'unknown'

export interface PolicyMetrics {
  decisions: number
  allows: number
  gates: number
  blocks: number
  autoConfirms: number
  gateKindCounts: Record<string, number>
  policyCodeCounts: Record<string, number>
  blockedReasonCounts: Record<string, number>
}

export interface PermissionMetrics {
  decisions: number
  allows: number
  asks: number
  denies: number
  autoAllows: number
  modeCounts: Record<string, number>
  gateKindCounts: Record<string, number>
  ruleIdCounts: Record<string, number>
}

export interface RunMetrics {
  schemaVersion: 'run-metrics/v1'
  generatedAt: string
  runId?: string
  sessionId?: string
  runDir?: string
  traceDir?: string
  source: RunSource
  scenario?: string
  profile?: string
  status: RunMetricsStatus
  durationMs: number
  llmCalls: number
  toolCalls: number
  mcpToolCalls: number
  observationToolCalls: number
  actionToolCalls: number
  humanToolCalls: number
  evalToolCalls: number
  browserSnapshots: number
  browserClicks: number
  browserTypes: number
  browserWaits: number
  screenshots: number
  manualHandoffs: number
  contextBuilds: number
  contextChars: number
  contextTruncations: number
  recentActionsIncluded: number
  pageStateAgeMs: number
  formStateAgeMs: number
  promptSectionChars: Partial<Record<PromptSectionId, number>>
  spans: number
  events: number
  legacySteps: number
  stdoutBytes: number
  stderrBytes: number
  streamJsonBytes: number
  runLogBytes: number
  promptBytes: number
  failureCategory: FailureCategory
  policy: PolicyMetrics
  permission: PermissionMetrics
  warnings: string[]
}

export function emptyRunMetrics(input: {
  runId?: string
  sessionId?: string
  runDir?: string
  traceDir?: string
  source: RunSource
  scenario?: string
  profile?: string
  warnings?: string[]
}): RunMetrics {
  return {
    schemaVersion: 'run-metrics/v1',
    generatedAt: new Date().toISOString(),
    runId: input.runId,
    sessionId: input.sessionId,
    runDir: input.runDir,
    traceDir: input.traceDir,
    source: input.source,
    scenario: input.scenario,
    profile: input.profile,
    status: 'unknown',
    durationMs: 0,
    llmCalls: 0,
    toolCalls: 0,
    mcpToolCalls: 0,
    observationToolCalls: 0,
    actionToolCalls: 0,
    humanToolCalls: 0,
    evalToolCalls: 0,
    browserSnapshots: 0,
    browserClicks: 0,
    browserTypes: 0,
    browserWaits: 0,
    screenshots: 0,
    manualHandoffs: 0,
    contextBuilds: 0,
    contextChars: 0,
    contextTruncations: 0,
    recentActionsIncluded: 0,
    pageStateAgeMs: 0,
    formStateAgeMs: 0,
    promptSectionChars: {},
    spans: 0,
    events: 0,
    legacySteps: 0,
    stdoutBytes: 0,
    stderrBytes: 0,
    streamJsonBytes: 0,
    runLogBytes: 0,
    promptBytes: 0,
    failureCategory: 'unknown',
    policy: emptyPolicyMetrics(),
    permission: emptyPermissionMetrics(),
    warnings: input.warnings ? [...input.warnings] : [],
  }
}

export function emptyPolicyMetrics(): PolicyMetrics {
  return {
    decisions: 0,
    allows: 0,
    gates: 0,
    blocks: 0,
    autoConfirms: 0,
    gateKindCounts: {},
    policyCodeCounts: {},
    blockedReasonCounts: {},
  }
}

export function emptyPermissionMetrics(): PermissionMetrics {
  return {
    decisions: 0,
    allows: 0,
    asks: 0,
    denies: 0,
    autoAllows: 0,
    modeCounts: {},
    gateKindCounts: {},
    ruleIdCounts: {},
  }
}
