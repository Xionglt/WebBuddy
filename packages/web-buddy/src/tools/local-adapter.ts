import { browserClick } from '../browser/click.js'
import { browserClickText } from '../browser/click-text.js'
import { browserFillByLabel } from '../browser/fill-by-label.js'
import { browserFormSnapshot } from '../browser/form-snapshot.js'
import { browserOpen } from '../browser/open.js'
import { browserScreenshot } from '../browser/screenshot.js'
import { browserSelect } from '../browser/select.js'
import { browserSelectByText } from '../browser/select-by-text.js'
import { browserSnapshot } from '../browser/snapshot.js'
import { browserType } from '../browser/type.js'
import { browserWait } from '../browser/wait.js'
import { sessionManager } from '../session/manager.js'
import type { ToolSchema } from '../sdk/llm.js'
import type { RiskLevel, TraceRecorder } from '../sdk/trace.js'
import { pageView } from '../runtime/local/page-view.js'
import { listLocalToolDefs } from './catalog.js'
import type { ToolCategory, ToolDef as CatalogToolDef } from './types.js'

export interface LocalToolContext {
  sessionId: string
  highlight: boolean
  trace: TraceRecorder
}

export interface LocalToolRunResult {
  observation: string
  data?: unknown
  risk?: RiskLevel
  pageChanged?: boolean
  done?: boolean
}

export interface LocalToolDef {
  name: string
  description: string
  category: ToolCategory
  parameters: Record<string, unknown>
  inherentRisk?: RiskLevel
  metadata?: Record<string, unknown>
  resolveRisk?: (args: Record<string, unknown>, ctx: LocalToolContext) => RiskLevel | undefined
  run: (args: Record<string, unknown>, ctx: LocalToolContext) => Promise<LocalToolRunResult>
}

type BrowserToolResult = {
  ok: boolean
  observation: string
  data?: unknown
  error?: { code: string; message: string }
  pageChanged?: boolean
}

type LocalHandler = (args: Record<string, unknown>, ctx: LocalToolContext) => Promise<LocalToolRunResult>

const HIGH_RISK_TEXT = [
  /submit/i,
  /apply/i,
  /application/i,
  /提交/,
  /投递/,
  /申请/,
  /递交/,
  /报名/,
  /send/i,
  /发送/,
  /confirm/i,
  /确认/,
  /pay/i,
  /支付/,
]

const localHandlers: Record<string, LocalHandler> = {
  async browser_open(args, ctx) {
    const r = await browserOpen({ url: String(args.url), waitUntil: args.waitUntil as never, sessionId: ctx.sessionId })
    if (!r.ok) return toResult(r, undefined, false)
    const snap = await browserSnapshot({ sessionId: ctx.sessionId })
    return {
      observation: `${r.observation}\n\n${pageView(snap.ok ? snap.data : undefined)}`,
      data: snap.ok ? snap.data : r.data,
      pageChanged: true,
    }
  },

  async browser_snapshot(args, ctx) {
    const r = await browserSnapshot({ sessionId: ctx.sessionId, maxElements: args.maxElements as number | undefined })
    if (!r.ok) return toResult(r, undefined, false)
    return { observation: pageView(r.data), data: r.data, pageChanged: false }
  },

  async browser_form_snapshot(args, ctx) {
    const r = await browserFormSnapshot({
      sessionId: ctx.sessionId,
      maxFields: args.maxFields as number | undefined,
    })
    return toResult(r, r.ok ? r.data : undefined, false)
  },

  async browser_click(args, ctx) {
    const r = await browserClick({
      ref: String(args.ref),
      sessionId: ctx.sessionId,
      timeoutMs: args.timeoutMs as number | undefined,
      confirmed: Boolean(args.confirmed),
      highlight: ctx.highlight,
    })
    return toResult(r, undefined, r.ok ? Boolean(r.pageChanged) : false)
  },

  async browser_click_text(args, ctx) {
    const r = await browserClickText({
      text: String(args.text ?? ''),
      sessionId: ctx.sessionId,
      exact: args.exact as boolean | undefined,
      nth: args.nth as number | undefined,
      timeoutMs: args.timeoutMs as number | undefined,
      confirmed: Boolean(args.confirmed),
      highlight: ctx.highlight,
    })
    return toResult(r, r.ok ? r.data : undefined, r.ok ? Boolean(r.pageChanged) : false)
  },

  async browser_type(args, ctx) {
    const r = await browserType({
      ref: String(args.ref),
      text: String(args.text ?? ''),
      sessionId: ctx.sessionId,
      clear: args.clear !== false,
      timeoutMs: args.timeoutMs as number | undefined,
      highlight: ctx.highlight,
      typeDelayMs: args.typeDelayMs as number | undefined,
    })
    return toResult(r, undefined, r.ok)
  },

  async browser_fill_by_label(args, ctx) {
    const r = await browserFillByLabel({
      label: String(args.label ?? ''),
      text: String(args.text ?? ''),
      sessionId: ctx.sessionId,
      exact: args.exact as boolean | undefined,
      nth: args.nth as number | undefined,
      clear: args.clear !== false,
      timeoutMs: args.timeoutMs as number | undefined,
    })
    return toResult(r, r.ok ? r.data : undefined, r.ok)
  },

  async browser_select(args, ctx) {
    const r = await browserSelect({
      ref: String(args.ref),
      value: String(args.value),
      sessionId: ctx.sessionId,
      timeoutMs: args.timeoutMs as number | undefined,
    })
    return toResult(r, undefined, r.ok)
  },

  async browser_select_by_text(args, ctx) {
    const r = await browserSelectByText({
      option: String(args.option ?? ''),
      label: args.label as string | undefined,
      ref: args.ref as string | undefined,
      sessionId: ctx.sessionId,
      exact: args.exact as boolean | undefined,
      nth: args.nth as number | undefined,
      optionNth: args.optionNth as number | undefined,
      timeoutMs: args.timeoutMs as number | undefined,
    })
    return toResult(r, r.ok ? r.data : undefined, r.ok)
  },

  async browser_wait(args, ctx) {
    const r = await browserWait({
      sessionId: ctx.sessionId,
      for: args.for as never,
      value: args.value as string | undefined,
      ms: args.ms as number | undefined,
      timeoutMs: args.timeoutMs as number | undefined,
    })
    return toResult(r, undefined, false)
  },

  async browser_screenshot(args, ctx) {
    const r = await browserScreenshot({
      sessionId: ctx.sessionId,
      label: args.label as string | undefined,
      outDir: args.outDir as string | undefined,
      fullPage: args.fullPage as boolean | undefined,
    })
    return toResult(r, r.ok ? r.data : undefined, false)
  },

  async agent_done(args) {
    return { observation: `agent_done: ${args.summary}`, done: true, data: { blocked: Boolean(args.blocked) } }
  },
}

export function createLocalTools(defs: CatalogToolDef[] = listLocalToolDefs()): LocalToolDef[] {
  return defs.map((def) => {
    const handler = localHandlers[def.name]
    if (!handler) {
      throw new Error(`No local handler registered for ${def.name}`)
    }
    return {
      name: def.name,
      description: def.description,
      category: def.category,
      parameters: stripSessionParameter(def.parameters),
      inherentRisk: def.risk,
      metadata: def.metadata,
      resolveRisk: localRiskResolver(def),
      run: handler,
    }
  })
}

export function toOpenAITools(tools: LocalToolDef[]): ToolSchema[] {
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }))
}

function localRiskResolver(def: CatalogToolDef): LocalToolDef['resolveRisk'] | undefined {
  const resolver = def.metadata?.riskResolver
  if (resolver === 'ref') return refRisk
  if (resolver === 'refOrDefault') return (args, ctx) => refRisk(args, ctx) ?? def.risk
  if (resolver === 'text') return textRisk
  return undefined
}

function refRisk(args: Record<string, unknown>, ctx: LocalToolContext): RiskLevel | undefined {
  const ref = String(args.ref ?? '')
  if (!ref) return undefined
  const session = sessionManager.get(ctx.sessionId)
  return session?.latestSnapshot?.refMap.get(ref)?.risk
}

function textRisk(args: Record<string, unknown>): RiskLevel {
  const text = String(args.text ?? '')
  return HIGH_RISK_TEXT.some((pattern) => pattern.test(text)) ? 'L3' : 'L1'
}

function stripSessionParameter(parameters: Record<string, unknown>): Record<string, unknown> {
  const clone = JSON.parse(JSON.stringify(parameters)) as Record<string, unknown>
  const properties = clone.properties as Record<string, unknown> | undefined
  if (properties) delete properties.sessionId
  return clone
}

function toResult(r: BrowserToolResult, data: unknown, pageChanged: boolean): LocalToolRunResult {
  if (r.ok) {
    return { observation: r.observation, data: data ?? r.data, pageChanged }
  }
  return { observation: `FAILED (${r.error?.code}): ${r.error?.message ?? r.observation}`, pageChanged: false }
}
