import { browserClick } from '../browser/click.js'
import { browserOpen } from '../browser/open.js'
import { browserScreenshot } from '../browser/screenshot.js'
import { browserSelect } from '../browser/select.js'
import { browserSnapshot } from '../browser/snapshot.js'
import { browserType } from '../browser/type.js'
import { browserWait } from '../browser/wait.js'
import { sessionManager } from '../session/manager.js'
import type { ToolSchema } from '../sdk/llm.js'
import type { TraceRecorder } from '../sdk/trace.js'
import type { RiskLevel } from '../sdk/trace.js'
import { pageView } from './page-view.js'

/**
 * Central, schema-driven tool registry — the single source of truth for what
 * the agent (and the MCP server) can do. Tools self-describe with an OpenAI
 * function schema; the agent loop passes them to the LLM so the MODEL picks
 * which tool to call. Inspired by hermes/nanobot's registry pattern.
 */

export interface ToolContext {
  sessionId: string
  /** Visual highlighting on (headful). */
  highlight: boolean
  trace: TraceRecorder
}

export interface ToolRunResult {
  /** Human/LLM-readable summary of what happened. */
  observation: string
  /** Structured payload (snapshot, refs, etc.). */
  data?: unknown
  /** Resolved risk of THIS call (for click/type, read from the ref). */
  risk?: RiskLevel
  /** Did the page change (navigation / DOM mutation)? */
  pageChanged?: boolean
  /** Tool signalled it's done (e.g. agent_done). */
  done?: boolean
}

export interface ToolDef {
  name: string
  description: string
  /** JSON Schema for the function parameters. */
  parameters: Record<string, unknown>
  /** Inherent risk tier when not determinable per-call. */
  inherentRisk?: RiskLevel
  /** Resolve the risk for a specific call (e.g. click by ref → element risk). */
  resolveRisk?: (args: Record<string, unknown>, ctx: ToolContext) => RiskLevel | undefined
  run: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolRunResult>
}

function refRisk(args: Record<string, unknown>, ctx: ToolContext): RiskLevel | undefined {
  const ref = String(args.ref ?? '')
  if (!ref) return undefined
  const session = sessionManager.get(ctx.sessionId)
  return session?.latestSnapshot?.refMap.get(ref)?.risk
}

// --- Tool definitions -----------------------------------------------------

const TOOLS: ToolDef[] = [
  {
    name: 'browser_open',
    description:
      'Navigate the browser to a URL. Call this first, or to move to a new page. Returns a compact snapshot you can read directly — no need to call browser_snapshot right after unless the page changed.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Full URL including https://' },
        waitUntil: { type: 'string', enum: ['load', 'domcontentloaded', 'networkidle'] },
      },
      required: ['url'],
    },
    inherentRisk: 'L0',
    async run(args, _ctx) {
      const r = await browserOpen({ url: String(args.url), waitUntil: args.waitUntil as never })
      if (!r.ok) return toResult(r, undefined, false)
      // refresh snapshot so the agent has refs immediately
      const snap = await browserSnapshot({ sessionId: _ctx.sessionId })
      return {
        observation: `${r.observation}\n\n${pageView(snap.ok ? snap.data : undefined)}`,
        data: snap.ok ? snap.data : undefined,
        pageChanged: true,
      }
    },
  },
  {
    name: 'browser_snapshot',
    description:
      'Capture the current page as a list of interactive elements with ref IDs ([e1], [e2]...). ALWAYS snapshot (or read the snapshot returned by browser_open) before click/type/select so your refs are fresh.',
    parameters: { type: 'object', properties: {} },
    inherentRisk: 'L0',
    async run(_args, ctx) {
      const r = await browserSnapshot({ sessionId: ctx.sessionId })
      if (!r.ok) return toResult(r, undefined, false)
      return { observation: pageView(r.data), data: r.data, pageChanged: false }
    },
  },
  {
    name: 'browser_click',
    description:
      'Click an element by its ref (e.g. "e5"). Submit-like buttons are flagged risk L3 and need confirmation. Snapshot first to get fresh refs.',
    parameters: {
      type: 'object',
      properties: { ref: { type: 'string' }, confirmed: { type: 'boolean' } },
      required: ['ref'],
    },
    resolveRisk: refRisk,
    async run(args, ctx) {
      const r = await browserClick({
        ref: String(args.ref),
        sessionId: ctx.sessionId,
        confirmed: Boolean(args.confirmed),
        highlight: ctx.highlight,
      })
      return toResult(r, undefined, r.ok ? (r as { pageChanged?: boolean }).pageChanged : false)
    },
  },
  {
    name: 'browser_type',
    description:
      'Type text into an input/textarea by ref. Clears the field first by default. Use this to fill form fields with resume values.',
    parameters: {
      type: 'object',
      properties: {
        ref: { type: 'string' },
        text: { type: 'string' },
        clear: { type: 'boolean' },
      },
      required: ['ref', 'text'],
    },
    resolveRisk: refRisk,
    async run(args, ctx) {
      const r = await browserType({
        ref: String(args.ref),
        text: String(args.text ?? ''),
        sessionId: ctx.sessionId,
        clear: args.clear !== false,
        highlight: ctx.highlight,
      })
      return toResult(r, undefined, r.ok)
    },
  },
  {
    name: 'browser_select',
    description: 'Choose an option in a <select>/combobox by ref.',
    parameters: {
      type: 'object',
      properties: { ref: { type: 'string' }, value: { type: 'string' } },
      required: ['ref', 'value'],
    },
    resolveRisk: refRisk,
    async run(args, ctx) {
      const r = await browserSelect({ ref: String(args.ref), value: String(args.value), sessionId: ctx.sessionId })
      return toResult(r, undefined, r.ok)
    },
  },
  {
    name: 'browser_wait',
    description: 'Wait for a load state, a URL, visible text, or a fixed delay (ms). Use after clicks that trigger navigation/loading.',
    parameters: {
      type: 'object',
      properties: {
        for: { type: 'string', enum: ['load', 'domcontentloaded', 'networkidle', 'url', 'text', 'ms'] },
        value: { type: 'string' },
        ms: { type: 'number' },
      },
    },
    inherentRisk: 'L0',
    async run(args, ctx) {
      const r = await browserWait({
        sessionId: ctx.sessionId,
        for: args.for as never,
        value: args.value as string | undefined,
        ms: args.ms as number | undefined,
      })
      return toResult(r, undefined, false)
    },
  },
  {
    name: 'browser_screenshot',
    description: 'Save a PNG screenshot of the current page and return its path. Use when you need to inspect the page visually.',
    parameters: { type: 'object', properties: { label: { type: 'string' } } },
    inherentRisk: 'L0',
    async run(args, ctx) {
      const r = await browserScreenshot({ sessionId: ctx.sessionId, label: args.label as string | undefined })
      return toResult(r, undefined, false)
    },
  },
  {
    name: 'agent_done',
    description:
      'Signal that the task is complete. Call this (with a short summary) when the form is filled as far as it should be, or when you are blocked (e.g. a login/captcha wall you cannot pass). NEVER call this right after submitting — the human must approve submission separately.',
    parameters: {
      type: 'object',
      properties: { summary: { type: 'string' }, blocked: { type: 'boolean' } },
      required: ['summary'],
    },
    inherentRisk: 'L0',
    async run(args) {
      return { observation: `agent_done: ${args.summary}`, done: true, data: { blocked: Boolean(args.blocked) } }
    },
  },
]

function toResult(
  r: { ok: boolean; observation: string; data?: unknown; error?: { code: string; message: string }; pageChanged?: boolean },
  data: unknown,
  pageChanged: boolean,
): ToolRunResult {
  if (r.ok) {
    return { observation: r.observation, data, pageChanged }
  }
  return { observation: `FAILED (${r.error?.code}): ${r.error?.message ?? r.observation}`, pageChanged: false }
}

export class ToolRegistry {
  private tools = new Map<string, ToolDef>()
  constructor(defs: ToolDef[] = TOOLS) {
    for (const d of defs) this.tools.set(d.name, d)
  }

  get(name: string): ToolDef | undefined {
    return this.tools.get(name)
  }

  list(): ToolDef[] {
    return [...this.tools.values()]
  }

  /** OpenAI function-calling schemas for the model. */
  toOpenAITools(): ToolSchema[] {
    return this.list().map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }))
  }

  resolveRisk(name: string, args: Record<string, unknown>, ctx: ToolContext): RiskLevel | undefined {
    const t = this.tools.get(name)
    if (!t) return undefined
    return t.resolveRisk?.(args, ctx) ?? t.inherentRisk
  }

  async run(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolRunResult> {
    const t = this.tools.get(name)
    if (!t) return { observation: `Unknown tool: ${name}` }
    try {
      return await t.run(args, ctx)
    } catch (error) {
      return { observation: `Tool ${name} threw: ${(error as Error).message}` }
    }
  }
}

/** Whether a risk tier requires a human gate before the action runs. */
export function requiresGate(risk: RiskLevel | undefined): boolean {
  return risk === 'L3' || risk === 'L4'
}
