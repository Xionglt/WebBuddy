import { mkdirSync, appendFileSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import type { Page } from 'playwright'
import {
  createAgentTraceSession,
  type AgentTraceSession,
  type AgentSpanStatus,
  type AgentTraceStatus,
} from '../agent-trace/index.js'

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
  private stepCount = 0
  private screenshotCount = 0
  private startedAt: string
  private lastStatus: StepStatus = 'ok'
  private maxRisk: RiskLevel | undefined
  private readonly traceFile: string

  constructor(outDir: string, runId?: string) {
    this.startedAt = new Date().toISOString()
    this.runId = runId ?? this.startedAt.replace(/[:.]/g, '-').slice(0, 19)
    this.dir = join(outDir, this.runId)
    mkdirSync(this.dir, { recursive: true })
    this.traceFile = join(this.dir, 'trace.jsonl')
    this.agentTrace = createAgentTraceSession({
      sessionId: `run_${this.runId}`,
      runId: this.runId,
      outDir: join(outDir, 'traces'),
      source: 'trace-recorder',
    })
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
    return summary
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
