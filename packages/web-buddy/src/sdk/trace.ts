import { mkdirSync, appendFileSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import type { Page } from 'playwright'
import {
  createAgentTraceSession,
  type AgentTraceSession,
  type AgentSpanStatus,
  type AgentTraceStatus,
} from '../agent-trace/index.js'
import { buildRunManifest, writeRunManifest, type RunSource } from '../metrics/trace-inputs.js'
import { generateAndWriteMetrics } from '../metrics/writer.js'
import { createAgentState, type AgentState, type AgentStateFinalStatus } from '../state/agent-state.js'
import { agentStatePathForTraceDir, writeAgentStateSafe } from '../state/store.js'
import type { ToolCategory } from '../tools/types.js'

export type RiskLevel = 'L0' | 'L1' | 'L2' | 'L3' | 'L4'
export type StepStatus = 'ok' | 'warn' | 'blocked' | 'error'

export interface TraceStep {
  step: number
  ts: string
  phase: string
  action: string
  url?: string
  title?: string
  risk?: RiskLevel
  toolCategory?: ToolCategory
  screenshotPath?: string
  observation?: string
  status: StepStatus
}

export interface TraceSummary {
  runId: string
  startedAt: string
  endedAt: string
  steps: number
  screenshots: number
  finalStatus: StepStatus
  /** Highest risk reached by any action this run. */
  maxRiskReached?: RiskLevel
  /** The trace JSONL path, relative to CWD when possible. */
  tracePath: string
}

export interface TraceRecorderOptions {
  runId?: string
  source?: RunSource
  scenario?: string
  profile?: string
  goal?: string
}

/**
 * Append-only trace recorder. One run = one directory under `outDir`:
 *
 *   output/<runId>/
 *     trace.jsonl      # one JSON object per step
 *     shot-001-...png  # screenshots
 *     summary.json     # written on finish()
 *
 * The recorder never throws on screenshot failure — a missing screenshot is
 * recorded as a warning, not a fatal error.
 */
export class TraceRecorder {
  readonly runId: string
  readonly dir: string
  readonly agentTrace?: AgentTraceSession
  readonly source: RunSource
  readonly scenario?: string
  readonly profile: string
  private stepCount = 0
  private screenshotCount = 0
  private startedAt: string
  private lastStatus: StepStatus = 'ok'
  private maxRisk: RiskLevel | undefined
  private readonly traceFile: string
  private readonly goal?: string
  private agentStatePath?: string
  private agentState?: AgentState

  constructor(outDir: string, input?: string | TraceRecorderOptions) {
    const options: TraceRecorderOptions = typeof input === 'string' ? { runId: input } : input ?? {}
    this.startedAt = new Date().toISOString()
    this.runId = options.runId ?? this.startedAt.replace(/[:.]/g, '-').slice(0, 19)
    this.source = options.source ?? 'local-runtime'
    this.scenario = options.scenario
    this.profile = options.profile ?? 'debug'
    this.goal = options.goal
    this.dir = join(outDir, this.runId)
    mkdirSync(this.dir, { recursive: true })
    this.traceFile = join(this.dir, 'trace.jsonl')
    this.agentTrace = createAgentTraceSession({
      sessionId: `run_${this.runId}`,
      runId: this.runId,
      outDir: join(outDir, 'traces'),
      source: this.source,
      scenario: this.scenario,
      profile: this.profile,
      userPrompt: this.goal,
      metadata: {
        legacyTraceDir: this.dir,
        profile: this.profile,
      },
    })
    if (this.agentTrace) {
      this.agentStatePath = agentStatePathForTraceDir(this.agentTrace.dir)
      this.agentState = createAgentState({
        runId: this.runId,
        sessionId: this.agentTrace.sessionId,
        source: this.source,
        scenario: this.scenario,
        profile: this.profile,
        goal: this.goal,
        stage: 'init',
        finalStatus: 'incomplete',
      })
      this.writeAgentStatePatch({})
      try {
        const manifestPath = writeRunManifest(buildRunManifest({
          runId: this.runId,
          sessionId: this.agentTrace.sessionId,
          source: this.source,
          scenario: this.scenario,
          profile: this.profile,
          runDir: this.dir,
          traceDir: this.agentTrace.dir,
          legacyTraceDir: this.dir,
          files: {
            legacyTraceJsonl: this.traceFile,
            summaryJson: join(this.dir, 'summary.json'),
            stdoutLog: undefined,
            stderrLog: undefined,
            streamJsonl: undefined,
            runLog: undefined,
          },
          metadata: {
            traceRecorderDir: this.dir,
            goal: this.goal,
          },
        }))
        this.agentTrace.recordEvent('run_manifest', {
          path: manifestPath,
          runId: this.runId,
          sessionId: this.agentTrace.sessionId,
        })
      } catch (error) {
        this.agentTrace.recordEvent('run_manifest_error', {
          message: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }

  /** Capture a screenshot (best-effort) and return its path relative to CWD. */
  async screenshot(page: Page | undefined, label: string): Promise<string | undefined> {
    if (!page) return undefined
    this.screenshotCount += 1
    const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)
    const file = join(this.dir, `shot-${String(this.screenshotCount).padStart(3, '0')}-${slug}.png`)
    try {
      await page.screenshot({ path: file, fullPage: false })
      const span = this.agentTrace?.startSpan({
        spanType: 'screenshot',
        name: 'page_screenshot',
        input: { label },
        metadata: { path: file },
      })
      span?.end({ status: 'success', output: { path: relative(process.cwd(), file) } })
      return relative(process.cwd(), file)
    } catch {
      const span = this.agentTrace?.startSpan({
        spanType: 'screenshot',
        name: 'page_screenshot',
        input: { label },
      })
      span?.end({ status: 'failed', errorMessage: 'Screenshot capture failed.' })
      return undefined
    }
  }

  record(step: Omit<TraceStep, 'step' | 'ts'>): TraceStep {
    this.stepCount += 1
    const url = step.url ? truncateUrl(step.url) : step.url
    const full: TraceStep = { step: this.stepCount, ts: new Date().toISOString(), ...step, url }
    this.lastStatus = full.status
    if (full.risk) this.maxRisk = higherRisk(this.maxRisk, full.risk)
    appendFileSync(this.traceFile, JSON.stringify(full) + '\n')
    this.writeAgentStatePatch({
      stage: full.phase,
      currentUrl: full.url ?? this.agentState?.currentUrl,
      lastAction: {
        step: full.step,
        phase: full.phase,
        action: full.action,
        status: full.status,
        risk: full.risk,
      },
      lastFailure: toAgentStateFailure(full),
    })
    this.agentTrace?.recordEvent('legacy_trace_step', full)
    const span = this.agentTrace?.startSpan({
      spanType: full.phase === 'agent_loop' && full.action.startsWith('GATE') ? 'gate' : 'agent_step',
      name: full.phase,
      input: { action: full.action },
      metadata: {
        step: full.step,
        url: full.url,
        title: full.title,
        risk: full.risk,
        toolCategory: full.toolCategory,
        screenshotPath: full.screenshotPath,
      },
    })
    span?.end({
      status: toAgentSpanStatus(full.status),
      output: { observation: full.observation },
    })
    return full
  }

  finish(): TraceSummary {
    const endedAt = new Date().toISOString()
    const tracePath = relative(process.cwd(), this.traceFile)
    const summary: TraceSummary = {
      runId: this.runId,
      startedAt: this.startedAt,
      endedAt,
      steps: this.stepCount,
      screenshots: this.screenshotCount,
      finalStatus: this.lastStatus,
      maxRiskReached: this.maxRisk,
      tracePath,
    }
    writeFileSync(join(this.dir, 'summary.json'), JSON.stringify(summary, null, 2))
    this.agentTrace?.finalize({
      status: toAgentTraceStatus(this.lastStatus),
      metadata: { summary },
    })
    this.writeAgentStatePatch({
      stage: 'done',
      finalStatus: toAgentStateFinalStatus(this.lastStatus),
    })
    if (this.agentTrace) {
      try {
        generateAndWriteMetrics({
          runId: this.runId,
          sessionId: this.agentTrace.sessionId,
          source: this.source,
          scenario: this.scenario,
          profile: this.profile,
          traceDir: this.agentTrace.dir,
          runDir: this.dir,
          outputDir: join(this.dir, '..'),
        })
      } catch {
        // Metrics are diagnostic output; they must not break the run.
      }
    }
    return summary
  }

  private writeAgentStatePatch(patch: Partial<AgentState>): void {
    if (!this.agentState || !this.agentStatePath) return
    this.agentState = {
      ...this.agentState,
      ...patch,
      updatedAt: new Date().toISOString(),
    }
    writeAgentStateSafe(this.agentState, this.agentStatePath)
  }
}

const ORDER: RiskLevel[] = ['L0', 'L1', 'L2', 'L3', 'L4']

function higherRisk(a: RiskLevel | undefined, b: RiskLevel): RiskLevel {
  if (!a) return b
  return ORDER.indexOf(a) >= ORDER.indexOf(b) ? a : b
}

/** Keep long data:/blob: URLs from bloating the trace JSONL. */
function truncateUrl(url: string, max = 160): string {
  if (url.length <= max) return url
  return `${url.slice(0, max)}…<+${url.length - max} chars>`
}

function toAgentSpanStatus(status: StepStatus): AgentSpanStatus {
  if (status === 'error') return 'failed'
  if (status === 'blocked') return 'skipped'
  return 'success'
}

function toAgentTraceStatus(status: StepStatus): AgentTraceStatus {
  if (status === 'error') return 'failed'
  if (status === 'blocked') return 'cancelled'
  return 'success'
}

function toAgentStateFinalStatus(status: StepStatus): AgentStateFinalStatus {
  if (status === 'ok') return 'completed'
  if (status === 'blocked') return 'blocked'
  if (status === 'error') return 'failed'
  return 'incomplete'
}

function toAgentStateFailure(step: TraceStep): AgentState['lastFailure'] {
  if (step.status !== 'error' && step.status !== 'blocked') return undefined
  return {
    category: 'unknown',
    message: step.observation || step.action,
    recoverable: step.status !== 'error',
  }
}
