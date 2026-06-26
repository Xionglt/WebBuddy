import { browserSnapshot } from '../../browser/snapshot.js'
import {
  buildLoopContext,
  renderInitialUserContext,
  renderSystemContext,
  renderUserContext,
} from '../../agent/prompt-assembler.js'
import type { ContextRecentAction } from '../../context/types.js'
import { decideToolPolicy, shouldStopAfterGateDecision, type PolicyDecision } from '../../policy/agent-policy.js'
import { sessionManager } from '../../session/manager.js'
import type { HumanGate } from '../../sdk/human.js'
import type { LlmGateway, ChatMessage } from '../../sdk/llm.js'
import type { ResumeProfile } from '../../sdk/resume.js'
import type { RiskLevel } from '../../sdk/trace.js'
import { ToolExecutionBoundary } from '../../tools/tool-execution.js'
import { pageView } from './page-view.js'
import { ToolRegistry, type ToolContext } from './tool-registry.js'

export interface AgentEvent {
  step: number
  level: 'think' | 'act' | 'observe' | 'gate' | 'warn' | 'error' | 'done'
  message: string
}

export interface AgentLoopInput {
  /** The natural-language task, e.g. "fill the application form on this page with my resume". */
  goal: string
  resume: ResumeProfile
  llm: LlmGateway
  registry: ToolRegistry
  ctx: ToolContext
  gate: HumanGate
  maxSteps?: number
  onEvent?: (e: AgentEvent) => void
  /** Extra context lines (e.g. the matched job title) appended to the system prompt. */
  extraContext?: string
  /** `raw` removes job-application workflow guardrails so the model drives the browser directly. */
  safetyMode?: 'guarded' | 'raw'
}

export interface AgentLoopResult {
  steps: number
  toolCalls: number
  done: boolean
  blocked: boolean
  summary: string
}

const DEFAULT_MAX_STEPS = 16

/**
 * The generic ReAct-style loop: the LLM picks browser tools itself, we execute
 * them (gating risky ones), feed observations back, until the model calls
 * `agent_done` or stops. This is what makes the agent work on ANY site — there
 * is no hardcoded field mapping.
 */
export async function runAgentLoop(input: AgentLoopInput): Promise<AgentLoopResult> {
  const { llm, registry, ctx, gate, resume, goal, onEvent } = input
  const safetyMode = input.safetyMode ?? 'guarded'
  const maxSteps = input.maxSteps ?? DEFAULT_MAX_STEPS
  const emit = (level: AgentEvent['level'], message: string, step: number) =>
    onEvent?.({ step, level, message })

  const tools = registry.toOpenAITools()
  const toolExecution = new ToolExecutionBoundary(registry)

  // Snapshot the already-open page so the model starts from the real form
  // instead of guessing a URL to open. (The orchestrator opens the target first.)
  let firstView = ''
  try {
    const snap = await browserSnapshot({ sessionId: ctx.sessionId })
    if (snap.ok) {
      firstView = pageView(snap.data)
      ctx.trace.record({ phase: 'agent_loop', action: 'Initial snapshot of the open page.', status: 'ok' })
    }
  } catch {
    // no page yet — the model can call browser_open itself
  }

  let step = 0
  let toolCalls = 0
  let done = false
  let blocked = false
  let summary = 'no summary'
  const recentActions: ContextRecentAction[] = []
  const blockers: string[] = []
  let latestContext = await buildLoopContext(input, recentActions, blockers)
  const messages: ChatMessage[] = [
    { role: 'system', content: renderSystemContext(latestContext) },
    { role: 'user', content: renderInitialUserContext(latestContext, firstView) },
  ]

  while (step < maxSteps) {
    step += 1
    let completion
    try {
      completion = await llm.chatWithTools(messages, { tools, temperature: 0.2 })
    } catch (error) {
      emit('error', `LLM call failed: ${(error as Error).message}`, step)
      ctx.trace.record({ phase: 'agent_loop', action: `LLM error: ${(error as Error).message}`, status: 'error' })
      return { steps: step, toolCalls, done: false, blocked: true, summary: `LLM error: ${(error as Error).message}` }
    }

    if (completion.content.trim()) {
      emit('think', completion.content.replace(/\s+/g, ' ').slice(0, 200), step)
    }

    // No tool calls → model is done (or narrating). Treat as final.
    if (completion.toolCalls.length === 0) {
      summary = completion.content.trim() || 'model produced no further tool calls'
      done = true
      emit('done', `Loop ended (no tool calls). ${summary.slice(0, 160)}`, step)
      ctx.trace.record({ phase: 'agent_loop', action: `Loop ended: ${summary.slice(0, 200)}`, status: 'ok' })
      break
    }

    // Append the assistant tool-call message so the API sees the request it made.
    messages.push({
      role: 'assistant',
      content: completion.content,
      tool_calls: completion.toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function',
        function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
      })),
    })

    for (const call of completion.toolCalls) {
      toolCalls += 1
      const tool = registry.get(call.name)
      const toolCategory = tool?.category
      const risk = registry.resolveRisk(call.name, call.arguments, ctx)
      const argBrief = briefArgs(call.name, call.arguments)
      const currentUrl = sessionManager.get(ctx.sessionId)?.page.url()
      const policyDecision = decideToolPolicy({
        toolName: call.name,
        args: call.arguments,
        risk,
        safetyMode,
        currentUrl,
        refLabel: call.name === 'browser_click' ? labelForClick(call.arguments, ctx) : undefined,
        freshness: latestContext.freshness,
      })

      // Gate risky actions before running.
      if (policyDecision.action === 'auto_confirm') {
        call.arguments.confirmed = true
      } else if (policyDecision.action === 'gate') {
        const kind = policyDecision.gateKind ?? 'high_risk_action'
        const decision = await gate.confirm(kind, `Agent wants to ${call.name} (${argBrief})`, {
          url: currentUrl,
          risk,
          detail: policyDecision.requiresFreshContext ? policyDecision.reason : undefined,
        })
        ctx.trace.record({
          phase: 'agent_loop',
          action: `GATE [${kind}] ${call.name}(${argBrief}) → ${decision}`,
          url: currentUrl,
          risk,
          observation: policyDecision.reason,
          status: decision === 'approve' ? 'ok' : 'blocked',
        })
        emit('gate', `[${kind}] ${call.name}(${argBrief}) → ${decision}`, step)
        if (kind === 'final_submit') {
          const note = `BLOCKED by final-submit safety gate (${decision}). Do not retry this action; call agent_done and hand the final submission to the human.`
          messages.push(toolMessage(call.id, noteWithPolicy(note, policyDecision)))
          blockers.push(`final_submit gate stopped ${call.name}(${argBrief}) with decision=${decision}`)
          rememberRecentAction(recentActions, {
            step,
            toolName: call.name,
            argumentsSummary: argBrief,
            status: 'blocked',
            risk,
            observation: noteWithPolicy(note, policyDecision),
          })
          blocked = true
          done = true
          summary = `Final submit requires manual takeover (gate: ${decision}).`
          break
        }
        if (decision !== 'approve') {
          const note = `BLOCKED by human gate (${decision}). Do not retry this action; call agent_done if you cannot proceed.`
          messages.push(toolMessage(call.id, noteWithPolicy(note, policyDecision)))
          blockers.push(`${kind} gate stopped ${call.name}(${argBrief}) with decision=${decision}`)
          rememberRecentAction(recentActions, {
            step,
            toolName: call.name,
            argumentsSummary: argBrief,
            status: 'blocked',
            risk,
            observation: noteWithPolicy(note, policyDecision),
          })
          if (shouldStopAfterGateDecision(decision)) {
            blocked = true
            done = true
            summary = `Human ${decision} the ${kind} step.`
          }
          continue
        }
        // approved → mark confirmed for clicks
        if (call.name === 'browser_click' || call.name === 'browser_click_text') call.arguments.confirmed = true
      }

      emit('act', `${call.name}(${argBrief})`, step)
      const toolSpan = ctx.trace.agentTrace?.startSpan({
        spanType: 'tool_call',
        name: call.name,
        toolName: call.name,
        toolCategory,
        input: call.arguments,
        metadata: {
          step,
          toolCallId: call.id,
          risk,
          category: toolCategory,
          argBrief,
        },
      })
      let result
      try {
        const execution = await toolExecution.execute({
          toolName: call.name,
          args: call.arguments,
          ctx,
          metadata: {
            step,
            riskLevel: policyDecision.riskLevel,
            category: toolCategory,
            argBrief,
          },
        })
        result = execution.result
        toolSpan?.end({
          status: result.observation.startsWith('FAILED') ? 'failed' : 'success',
          output: result,
          metadata: {
            pageChanged: result.pageChanged,
            risk: result.risk,
            done: result.done,
          },
        })
      } catch (error) {
        toolSpan?.end({
          status: 'failed',
          errorMessage: error instanceof Error ? error.message : String(error),
        })
        throw error
      }
      ctx.trace.record({
        phase: 'agent_loop',
        action: `${call.name}(${argBrief})`,
        url: sessionManager.get(ctx.sessionId)?.page.url(),
        risk,
        toolCategory,
        status: result.observation.startsWith('FAILED') ? 'warn' : 'ok',
        observation: result.observation.slice(0, 300),
      })

      if (result.done) {
        done = true
        blocked = Boolean((result.data as { blocked?: boolean } | undefined)?.blocked)
        summary = (call.arguments.summary as string) || result.observation
      }
      rememberRecentAction(recentActions, {
        step,
        toolName: call.name,
        argumentsSummary: argBrief,
        status: result.observation.startsWith('FAILED') ? 'warn' : blocked && result.done ? 'blocked' : 'ok',
        risk,
        observation: result.observation,
      })

      // After a page-changing action, refresh the snapshot view so refs stay fresh.
      let observation = result.observation
      if (result.pageChanged && call.name !== 'browser_open' && call.name !== 'browser_snapshot') {
        const snap = await browserSnapshot({ sessionId: ctx.sessionId })
        if (snap.ok) observation = `${observation}\n\n[updated page]\n${pageView(snap.data)}`
      }
      messages.push(toolMessage(call.id, observation.slice(0, 6000)))
      emit('observe', result.observation.replace(/\s+/g, ' ').slice(0, 160), step)

      if (done) break
    }

    if (!done) {
      latestContext = await buildLoopContext(input, recentActions, blockers)
      messages.push({ role: 'user', content: `UPDATED_CONTEXT\n${renderUserContext(latestContext)}` })
    }

    if (done) break
  }

  if (!done) {
    summary = `Reached step budget (${maxSteps}) without agent_done.`
    emit('warn', summary, step)
    ctx.trace.record({ phase: 'agent_loop', action: summary, status: 'warn' })
  }

  return { steps: step, toolCalls, done, blocked, summary }
}

function briefArgs(name: string, args: Record<string, unknown>): string {
  const parts: string[] = []
  for (const [k, v] of Object.entries(args)) {
    if (v === undefined || v === null) continue
    const s = typeof v === 'string' ? (v.length > 40 ? `${v.slice(0, 40)}…` : v) : String(v)
    parts.push(`${k}=${s}`)
  }
  return parts.length ? parts.join(', ') : '(no args)'
}

function labelForClick(args: Record<string, unknown>, ctx: ToolContext): string {
  const ref = String(args.ref ?? '')
  const stored = sessionManager.get(ctx.sessionId)?.latestSnapshot?.refMap.get(ref)
  return [stored?.name, stored?.text].filter(Boolean).join(' ')
}

function noteWithPolicy(note: string, decision: PolicyDecision): string {
  if (!decision.reason.toLowerCase().includes('stale')) return note
  return `${note}\nPolicy: ${decision.reason}`
}

function rememberRecentAction(
  actions: ContextRecentAction[],
  action: Omit<ContextRecentAction, 'at'>,
  maxActions = 12,
): void {
  actions.push({ ...action, at: new Date().toISOString() })
  if (actions.length > maxActions) actions.splice(0, actions.length - maxActions)
}

function toolMessage(toolCallId: string, content: string): ChatMessage {
  return { role: 'tool', tool_call_id: toolCallId, content }
}
