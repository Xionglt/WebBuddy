import { browserSnapshot } from '../browser/snapshot.js'
import { sessionManager } from '../session/manager.js'
import type { HumanGate } from '../sdk/human.js'
import type { LlmGateway, ChatMessage } from '../sdk/llm.js'
import type { ResumeProfile } from '../sdk/resume.js'
import type { RiskLevel } from '../sdk/trace.js'
import { pageView } from './page-view.js'
import { ToolRegistry, requiresGate, type ToolContext } from './tool-registry.js'

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

function resumeBrief(profile: ResumeProfile): string {
  const exp = profile.experience
    .slice(0, 4)
    .map((e) => `- ${e.title || ''} @ ${e.company || ''} (${e.period || ''})`)
    .join('\n')
  const edu = profile.education
    .slice(0, 2)
    .map((e) => `- ${e.degree || ''} ${e.major || ''} @ ${e.school || ''}`)
    .join('\n')
  return [
    `name: ${profile.name || '(unknown)'}`,
    `email: ${profile.email || '(unknown)'}`,
    `phone: ${profile.phone || '(unknown)'}`,
    `location: ${profile.location || '(unknown)'}`,
    `skills: ${profile.skills.join(', ') || '(none)'}`,
    profile.summary ? `summary: ${profile.summary}` : '',
    exp ? `experience:\n${exp}` : '',
    edu ? `education:\n${edu}` : '',
  ]
    .filter(Boolean)
    .join('\n')
}

function buildSystemPrompt(
  goal: string,
  resume: ResumeProfile,
  extraContext?: string,
  safetyMode: AgentLoopInput['safetyMode'] = 'guarded',
): string {
  const raw = [
    'You are an autonomous browser automation agent using a local Playwright runtime.',
    'You drive the browser ONLY through the provided tools. You receive a page snapshot as text with element refs like [e1], [e2]; use those exact refs in browser_click / browser_type / browser_select.',
    '',
    'Operate from the task and the visible website information. Navigate, search, filter, compare pages, click, type, upload/select, save, and submit when those actions are necessary to complete the user goal.',
    'Use browser_snapshot whenever page refs may be stale. Use browser_screenshot when visual inspection would help.',
    'If the site requires a human-only credential, SMS code, captcha, or payment/identity proof that you cannot complete with available page information, stop and summarize exactly what blocked you.',
    '',
    'CANDIDATE RESUME:',
    resumeBrief(resume),
    '',
    ...(extraContext ? ['CONTEXT:', extraContext, ''] : []),
    'TASK:',
    goal,
  ]
  if (safetyMode === 'raw') return raw.join('\n')

  return [
    'You are a careful browser automation agent that fills job-application forms from a candidate resume.',
    'You drive the browser ONLY through the provided tools. You receive a page snapshot as text with element refs like [e1], [e2]; use those exact refs in browser_click / browser_type / browser_select.',
    '',
    'SAFETY RULES (non-negotiable):',
    '- NEVER submit a final application. If you reach the final submit/确认投递/提交申请 button on an application form, do NOT click it — call agent_done with blocked=true.',
    '- It is OK to click a job-detail entry button such as 投递简历/Apply only when it merely opens the login/application flow and does not send the completed application.',
    '- For any element marked risk=L3 or risk=L4, the human must approve before the action runs; you may still request it (the system gates it).',
    '- If you hit a login wall or captcha you cannot pass, call agent_done with blocked=true and explain.',
    '- Prefer to fill only the fields you can map confidently from the resume. Leave unknown fields untouched.',
    '',
    'WORKFLOW: read the snapshot → decide the next single action → call exactly one tool → read the updated observation → repeat. Call agent_done when finished or blocked.',
    '',
    'CANDIDATE RESUME:',
    resumeBrief(resume),
    '',
    ...(extraContext ? ['CONTEXT:', extraContext, ''] : []),
    'TASK:',
    goal,
  ].join('\n')
}

/** Decide which gate kind a risky click maps to (submit vs generic high-risk). */
function gateKindForClick(args: Record<string, unknown>, ctx: ToolContext): 'final_submit' | 'high_risk_action' {
  const ref = String(args.ref ?? '')
  const stored = sessionManager.get(ctx.sessionId)?.latestSnapshot?.refMap.get(ref)
  const label = [stored?.name, stored?.text].filter(Boolean).join(' ')
  const currentUrl = sessionManager.get(ctx.sessionId)?.page.url() ?? ''
  const isAlibabaDetailEntry =
    /talent-holding\.alibaba\.com\/off-campus\/position-detail/i.test(currentUrl) &&
    /投递简历|立即投递|apply/i.test(label)
  if (isAlibabaDetailEntry) return 'high_risk_action'
  return /submit|投递|提交|申请|递交|deliver|apply|send/i.test(label) ? 'final_submit' : 'high_risk_action'
}

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

  const messages: ChatMessage[] = [
    { role: 'system', content: buildSystemPrompt(goal, resume, input.extraContext, safetyMode) },
    {
      role: 'user',
      content: firstView
        ? `The page is already open. Here is the current page:\n\n${firstView}\n\nNow act on the task. If the page changes, call browser_snapshot to refresh the refs. Do NOT call browser_open unless you genuinely need a different URL.`
        : 'Begin. Call browser_snapshot (or browser_open with the target URL) to see the page.',
    },
  ]

  let step = 0
  let toolCalls = 0
  let done = false
  let blocked = false
  let summary = 'no summary'

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
      const risk = registry.resolveRisk(call.name, call.arguments, ctx)
      const argBrief = briefArgs(call.name, call.arguments)

      // Gate risky actions before running.
      if (requiresGate(risk) && safetyMode === 'raw' && call.name === 'browser_click') {
        call.arguments.confirmed = true
      } else if (requiresGate(risk)) {
        const kind = call.name === 'browser_click' ? gateKindForClick(call.arguments, ctx) : 'high_risk_action'
        const decision = await gate.confirm(kind, `Agent wants to ${call.name} (${argBrief})`, {
          url: sessionManager.get(ctx.sessionId)?.page.url(),
          risk,
        })
        ctx.trace.record({
          phase: 'agent_loop',
          action: `GATE [${kind}] ${call.name}(${argBrief}) → ${decision}`,
          url: sessionManager.get(ctx.sessionId)?.page.url(),
          risk,
          status: decision === 'approve' ? 'ok' : 'blocked',
        })
        emit('gate', `[${kind}] ${call.name}(${argBrief}) → ${decision}`, step)
        if (kind === 'final_submit') {
          messages.push(toolMessage(call.id, `BLOCKED by final-submit safety gate (${decision}). Do not retry this action; call agent_done and hand the final submission to the human.`))
          blocked = true
          done = true
          summary = `Final submit requires manual takeover (gate: ${decision}).`
          break
        }
        if (decision !== 'approve') {
          messages.push(toolMessage(call.id, `BLOCKED by human gate (${decision}). Do not retry this action; call agent_done if you cannot proceed.`))
          if (kind === 'final_submit' || decision === 'takeover') {
            blocked = true
            done = true
            summary = `Human ${decision} the ${kind} step.`
          }
          continue
        }
        // approved → mark confirmed for clicks
        if (call.name === 'browser_click') call.arguments.confirmed = true
      }

      emit('act', `${call.name}(${argBrief})`, step)
      const toolSpan = ctx.trace.agentTrace?.startSpan({
        spanType: 'tool_call',
        name: call.name,
        toolName: call.name,
        input: call.arguments,
        metadata: {
          step,
          toolCallId: call.id,
          risk,
          argBrief,
        },
      })
      let result
      try {
        result = await registry.run(call.name, call.arguments, ctx)
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
        status: result.observation.startsWith('FAILED') ? 'warn' : 'ok',
        observation: result.observation.slice(0, 300),
      })

      if (result.done) {
        done = true
        blocked = Boolean((result.data as { blocked?: boolean } | undefined)?.blocked)
        summary = (call.arguments.summary as string) || result.observation
      }

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

function toolMessage(toolCallId: string, content: string): ChatMessage {
  return { role: 'tool', tool_call_id: toolCallId, content }
}
