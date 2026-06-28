import { browserSnapshot } from '../../browser/snapshot.js'
import {
  buildLoopContext,
  renderInitialUserContext,
  renderSystemContext,
  renderUserContext,
} from '../../agent/prompt-assembler.js'
import type { ContextRecentAction } from '../../context/types.js'
import { decideToolPolicy, shouldStopAfterGateDecision, type PolicyEngineDecision } from '../../policy/agent-policy.js'
import { createPolicyAuditEvent } from '../../policy/policy-audit.js'
import { sessionManager } from '../../session/manager.js'
import {
  compactAssistantContent,
  compactToolResult,
  type AgentSessionStatus,
  type SessionRecorder,
} from '../../session/index.js'
import { abortReason } from '../../kernel/run-controller.js'
import type { HumanGate } from '../../sdk/human.js'
import type { LlmGateway, ChatMessage } from '../../sdk/llm.js'
import type { ResumeProfile } from '../../sdk/resume.js'
import type { RiskLevel } from '../../sdk/trace.js'
import { ToolExecutionBoundary } from '../../tools/tool-execution.js'
import { createInitialWorkflowState, type WorkflowState } from '../../workflow/workflow-state.js'
import { transitionWorkflowState } from '../../workflow/workflow-transition.js'
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
  /** Optional append-only session recorder for resumable runtime state. */
  session?: SessionRecorder
  /** Optional kernel/run-controller abort signal. Checked before model/tool work. */
  abortSignal?: AbortSignal
}

export interface AgentLoopResult {
  steps: number
  toolCalls: number
  done: boolean
  blocked: boolean
  summary: string
  workflowState?: WorkflowState
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
  const session = input.session

  let step = 0
  let toolCalls = 0
  let done = false
  let blocked = false
  let summary = 'no summary'
  let workflowState = createInitialWorkflowState()
  let sessionFinalized = false
  const recentActions: ContextRecentAction[] = []
  const blockers: string[] = []

  const sessionAction = async (label: string, action: () => Promise<void>) => {
    if (!session) return
    try {
      await action()
    } catch (error) {
      emit('warn', `Session ${label} write failed: ${error instanceof Error ? error.message : String(error)}`, step)
    }
  }
  const sessionEvent = async (...args: Parameters<SessionRecorder['event']>) =>
    sessionAction('event', () => session!.event(...args))
  const sessionTranscript = async (...args: Parameters<SessionRecorder['transcript']>) =>
    sessionAction('transcript', () => session!.transcript(...args))
  const sessionWorkflow = async (state: unknown) =>
    sessionAction('workflow', () => session!.workflow(state))
  const sessionStatus = async (status: AgentSessionStatus, patch?: Parameters<SessionRecorder['updateStatus']>[1]) =>
    sessionAction('status', () => session!.updateStatus(status, patch))
  const recordWorkflowSnapshot = async (state: WorkflowState, currentStep: number, reason: string) => {
    await sessionTranscript({ type: 'workflow_snapshot', turnId: turnIdForStep(currentStep), workflowState: state })
    await sessionEvent({
      type: 'workflow_updated',
      turnId: turnIdForStep(currentStep),
      message: reason,
      data: { workflowState: state },
    })
    await sessionWorkflow(state)
  }
  const finalizeSession = async (
    status: Extract<AgentSessionStatus, 'completed' | 'blocked' | 'failed' | 'aborted'>,
    result: Record<string, unknown>,
    reason?: string,
  ) => {
    if (!session || sessionFinalized) return
    sessionFinalized = true
    await sessionTranscript({
      type: 'final_result',
      status,
      result,
      ...(reason ? { reason } : {}),
    })
    await sessionEvent({
      type: sessionEventTypeForStatus(status),
      message: reason,
      data: result,
    })
    await sessionStatus(status, {
      ...(status === 'blocked' && reason ? { blockedReason: reason } : {}),
      ...(status === 'failed' && reason ? { error: reason } : {}),
    })
  }
  const abortRun = async (turnId?: string): Promise<AgentLoopResult> => {
    const reason = input.abortSignal ? abortReason(input.abortSignal) : 'Abort requested.'
    summary = `Run aborted: ${reason}`
    done = false
    blocked = true
    emit('warn', summary, step)
    ctx.trace.record({ phase: 'agent_loop', action: summary, status: 'blocked' })
    if (turnId) {
      await sessionEvent({
        type: 'turn_completed',
        turnId,
        message: `Turn ${step} aborted.`,
        data: { done, blocked, aborted: true },
      })
    }
    await finalizeSession('aborted', { steps: step, toolCalls, done, blocked, summary, workflowState }, summary)
    return { steps: step, toolCalls, done, blocked, summary, workflowState }
  }
  const checkAbort = async (turnId?: string): Promise<AgentLoopResult | undefined> => {
    if (!input.abortSignal?.aborted) return undefined
    return abortRun(turnId)
  }

  await sessionStatus('running')
  await sessionEvent({
    type: 'session_started',
    message: 'Agent loop started.',
    data: { goal, safetyMode, maxSteps },
  })
  await sessionTranscript({ type: 'user_message', content: goal })
  const abortedAfterStart = await checkAbort()
  if (abortedAfterStart) return abortedAfterStart

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

  let latestContext = await buildLoopContextWithWorkflow(input, workflowState, recentActions, blockers)
  const initialWorkflow = transitionWorkflowState({
    previous: workflowState,
    currentUrl: sessionManager.get(ctx.sessionId)?.page.url(),
    page: latestContext.page,
    form: latestContext.form,
  })
  workflowState = initialWorkflow.state
  if (initialWorkflow.changed) {
    latestContext = await buildLoopContextWithWorkflow(input, workflowState, recentActions, blockers)
  }
  await recordWorkflowSnapshot(workflowState, step, 'Initial workflow snapshot.')
  const initialHandoffSummary = workflowHandoffSummary(workflowState)
  if (initialHandoffSummary) {
    emit('done', initialHandoffSummary, step)
    ctx.trace.record({ phase: 'agent_loop', action: initialHandoffSummary, status: 'blocked' })
    await finalizeSession('blocked', { steps: step, toolCalls, summary: initialHandoffSummary, workflowState }, initialHandoffSummary)
    return { steps: step, toolCalls, done: true, blocked: true, summary: initialHandoffSummary, workflowState }
  }
  const messages: ChatMessage[] = [
    { role: 'system', content: renderSystemContext(latestContext) },
    { role: 'user', content: renderInitialUserContext(latestContext, firstView) },
  ]

  while (step < maxSteps) {
    step += 1
    const turnId = turnIdForStep(step)
    await sessionEvent({ type: 'turn_started', turnId, message: `Turn ${step} started.` })
    const abortedBeforeModel = await checkAbort(turnId)
    if (abortedBeforeModel) return abortedBeforeModel
    let completion
    try {
      completion = await llm.chatWithTools(messages, { tools, temperature: 0.2 })
    } catch (error) {
      const message = `LLM error: ${(error as Error).message}`
      emit('error', `LLM call failed: ${(error as Error).message}`, step)
      ctx.trace.record({ phase: 'agent_loop', action: message, status: 'error' })
      await sessionTranscript({
        type: 'error',
        turnId,
        message,
        ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
      })
      await finalizeSession('failed', { steps: step, toolCalls, summary: message, workflowState }, message)
      return {
        steps: step,
        toolCalls,
        done: false,
        blocked: true,
        summary: message,
        workflowState,
      }
    }

    await sessionTranscript({
      type: 'assistant_message',
      turnId,
      content: compactAssistantContent({
        content: completion.content,
        toolCalls: completion.toolCalls.map((call) => ({ id: call.id, name: call.name })),
      }),
    })
    await sessionEvent({
      type: 'model_message',
      turnId,
      message: completion.content.trim().slice(0, 200) || `Model requested ${completion.toolCalls.length} tool call(s).`,
      data: {
        toolCallCount: completion.toolCalls.length,
        toolCalls: completion.toolCalls.map((call) => ({ id: call.id, name: call.name })),
      },
    })

    if (completion.content.trim()) {
      emit('think', completion.content.replace(/\s+/g, ' ').slice(0, 200), step)
    }

    // No tool calls → model is done (or narrating). Treat as final.
    if (completion.toolCalls.length === 0) {
      summary = completion.content.trim() || 'model produced no further tool calls'
      done = true
      emit('done', `Loop ended (no tool calls). ${summary.slice(0, 160)}`, step)
      ctx.trace.record({ phase: 'agent_loop', action: `Loop ended: ${summary.slice(0, 200)}`, status: 'ok' })
      await sessionEvent({ type: 'turn_completed', turnId, message: `Turn ${step} completed.`, data: { done, blocked } })
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
      const abortedBeforeTool = await checkAbort(turnId)
      if (abortedBeforeTool) return abortedBeforeTool
      toolCalls += 1
      const tool = registry.get(call.name)
      const toolCategory = tool?.category
      const risk = registry.resolveRisk(call.name, call.arguments, ctx)
      const argBrief = briefArgs(call.name, call.arguments)
      const currentUrl = sessionManager.get(ctx.sessionId)?.page.url()
      await sessionTranscript({
        type: 'tool_call',
        turnId,
        toolCallId: call.id,
        name: call.name,
        args: call.arguments,
      })
      await sessionEvent({
        type: 'tool_call_created',
        turnId,
        toolCallId: call.id,
        message: `${call.name}(${argBrief})`,
        data: { name: call.name, risk, argBrief },
      })
      const policyDecision = decideToolPolicy({
        toolName: call.name,
        args: call.arguments,
        risk,
        safetyMode,
        currentUrl,
        refLabel: call.name === 'browser_click' ? labelForClick(call.arguments, ctx) : undefined,
        freshness: latestContext.freshness,
        workflowState,
      })
      const policyAudit = createPolicyAuditEvent({
        sessionId: ctx.sessionId,
        step,
        toolName: call.name,
        decision: policyDecision,
      })
      ctx.trace.agentTrace?.recordEvent('policy_decision', policyAudit)
      await sessionTranscript({
        type: 'policy_decision',
        turnId,
        toolCallId: call.id,
        toolName: call.name,
        decision: policyMetadata(policyDecision),
      })
      await sessionEvent({
        type: 'policy_evaluated',
        turnId,
        toolCallId: call.id,
        message: `${call.name}: ${policyDecision.action}`,
        data: { decision: policyMetadata(policyDecision) },
      })

      // Gate risky actions before running.
      if (policyDecision.action === 'block') {
        const note = `BLOCKED by policy [${policyDecision.policyCode}]. ${policyDecision.reason}`
        messages.push(toolMessage(call.id, noteWithPolicy(note, policyDecision)))
        blockers.push(`${call.name}(${argBrief}) blocked by ${policyDecision.policyCode}: ${policyDecision.reason}`)
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
        summary = `Policy blocked ${call.name}: ${policyDecision.reason}`
        workflowState = transitionWorkflowState({
          previous: workflowState,
          currentUrl,
          page: latestContext.page,
          form: latestContext.form,
          policyDecision,
          gateKind: policyDecision.gateKind,
          agentDoneBlocked: true,
        }).state
        await recordWorkflowSnapshot(workflowState, step, `Policy blocked ${call.name}.`)
        emit('gate', `[policy:block] ${call.name}(${argBrief})`, step)
        break
      } else if (policyDecision.action === 'auto_confirm') {
        call.arguments.confirmed = true
      } else if (policyDecision.action === 'gate') {
        const kind = policyDecision.gateKind ?? 'high_risk_action'
        await sessionEvent({
          type: 'human_gate_requested',
          turnId,
          toolCallId: call.id,
          message: `Gate requested for ${call.name}.`,
          data: { kind, risk, reason: policyDecision.reason },
        })
        const decision = await gate.confirm(kind, `Agent wants to ${call.name} (${argBrief})`, {
          url: currentUrl,
          risk,
          detail: policyDecision.reason,
        })
        await sessionEvent({
          type: 'human_gate_resolved',
          turnId,
          toolCallId: call.id,
          message: `Gate resolved: ${decision}.`,
          data: { kind, decision },
        })
        ctx.trace.record({
          phase: 'agent_loop',
          action: `GATE [${kind}] ${call.name}(${argBrief}) → ${decision}`,
          url: currentUrl,
          risk,
          observation: policyDecision.reason,
          status: decision === 'approve' ? 'ok' : 'blocked',
        })
        workflowState = transitionWorkflowState({
          previous: workflowState,
          currentUrl,
          page: latestContext.page,
          form: latestContext.form,
          policyDecision,
          gateKind: kind,
          gateDecision: decision,
        }).state
        await recordWorkflowSnapshot(workflowState, step, `Human gate ${kind} resolved ${decision}.`)
        emit('gate', `[${kind}] ${call.name}(${argBrief}) → ${decision}`, step)
        if (kind === 'final_submit') {
          const note = `BLOCKED by final-submit safety gate (${decision}). Do not retry this action; call agent_done and hand the final submission to the human.`
          messages.push(toolMessage(call.id, noteWithPolicy(note, policyDecision)))
          blockers.push(`final_submit gate stopped ${call.name}(${argBrief}) with decision=${decision}: ${policyDecision.reason}`)
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
          workflowState = transitionWorkflowState({
            previous: workflowState,
            currentUrl,
            page: latestContext.page,
            form: latestContext.form,
            policyDecision,
            gateKind: kind,
            gateDecision: decision,
            agentDoneBlocked: true,
          }).state
          await recordWorkflowSnapshot(workflowState, step, `Final-submit gate stopped ${call.name}.`)
          break
        }
        if (decision !== 'approve') {
          const note = `BLOCKED by human gate (${decision}). Do not retry this action; call agent_done if you cannot proceed.`
          messages.push(toolMessage(call.id, noteWithPolicy(note, policyDecision)))
          blockers.push(`${kind} gate stopped ${call.name}(${argBrief}) with decision=${decision}: ${policyDecision.reason}`)
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
            workflowState = transitionWorkflowState({
              previous: workflowState,
              currentUrl,
              page: latestContext.page,
              form: latestContext.form,
              policyDecision,
              gateKind: kind,
              gateDecision: decision,
              agentDoneBlocked: true,
            }).state
            await recordWorkflowSnapshot(workflowState, step, `Human gate stopped ${call.name}.`)
          }
          continue
        }
        // approved → mark confirmed for clicks
        if (call.name === 'browser_click' || call.name === 'browser_click_text') call.arguments.confirmed = true
      }

      emit('act', `${call.name}(${argBrief})`, step)
      await sessionEvent({
        type: 'tool_started',
        turnId,
        toolCallId: call.id,
        message: `${call.name} started.`,
        data: { name: call.name, argBrief, risk },
      })
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
          policy: policyMetadata(policyDecision),
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
            policyAction: policyDecision.action,
            policyCode: policyDecision.policyCode,
            policyRuleId: policyDecision.ruleId,
            policyGateKind: policyDecision.gateKind,
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
        const message = error instanceof Error ? error.message : String(error)
        await sessionTranscript({
          type: 'tool_result',
          turnId,
          toolCallId: call.id,
          name: call.name,
          ok: false,
          error: message,
        })
        await sessionEvent({
          type: 'tool_failed',
          turnId,
          toolCallId: call.id,
          message: `${call.name} failed: ${message}`,
          data: { name: call.name },
        })
        await sessionTranscript({
          type: 'error',
          turnId,
          message,
          ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
        })
        await finalizeSession('failed', { steps: step, toolCalls, toolName: call.name, error: message, workflowState }, message)
        throw error
      }
      const toolOk = !result.observation.startsWith('FAILED')
      const compactResult = compactToolResult(result)
      await sessionTranscript({
        type: 'tool_result',
        turnId,
        toolCallId: call.id,
        name: call.name,
        ok: toolOk,
        result: compactResult,
        ...(!toolOk ? { error: result.observation } : {}),
      })
      await sessionEvent({
        type: toolOk ? 'tool_completed' : 'tool_failed',
        turnId,
        toolCallId: call.id,
        message: `${call.name} ${toolOk ? 'completed' : 'failed'}.`,
        data: { name: call.name, result: compactResult },
      })
      ctx.trace.record({
        phase: 'agent_loop',
        action: `${call.name}(${argBrief})`,
        url: sessionManager.get(ctx.sessionId)?.page.url(),
        risk,
        toolCategory,
        status: toolOk ? 'ok' : 'warn',
        observation: result.observation.slice(0, 300),
      })

      if (result.done) {
        done = true
        blocked = Boolean((result.data as { blocked?: boolean } | undefined)?.blocked)
        summary = (call.arguments.summary as string) || result.observation
      }
      workflowState = transitionWorkflowState({
        previous: workflowState,
        currentUrl: sessionManager.get(ctx.sessionId)?.page.url(),
        page: latestContext.page,
        form: latestContext.form,
        toolName: call.name,
        toolResult: result,
        policyDecision,
        ...(result.done ? { agentDoneBlocked: blocked } : {}),
      }).state
      await recordWorkflowSnapshot(workflowState, step, `${call.name} updated workflow state.`)
      rememberRecentAction(recentActions, {
        step,
        toolName: call.name,
        argumentsSummary: argBrief,
        status: !toolOk ? 'warn' : blocked && result.done ? 'blocked' : 'ok',
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
      latestContext = await buildLoopContextWithWorkflow(input, workflowState, recentActions, blockers)
      const contextWorkflow = transitionWorkflowState({
        previous: workflowState,
        currentUrl: sessionManager.get(ctx.sessionId)?.page.url(),
        page: latestContext.page,
        form: latestContext.form,
      })
      workflowState = contextWorkflow.state
      if (contextWorkflow.changed) {
        await recordWorkflowSnapshot(workflowState, step, 'Context refresh updated workflow state.')
        latestContext = await buildLoopContextWithWorkflow(input, workflowState, recentActions, blockers)
      }
      const handoffSummary = workflowHandoffSummary(workflowState)
      if (handoffSummary) {
        done = true
        blocked = true
        summary = handoffSummary
        blockers.push(handoffSummary)
        rememberRecentAction(recentActions, {
          step,
          toolName: 'workflow_state',
          argumentsSummary: `phase=${workflowState.phase}`,
          status: 'blocked',
          observation: handoffSummary,
        })
        emit('done', handoffSummary, step)
        ctx.trace.record({ phase: 'agent_loop', action: handoffSummary, status: 'blocked' })
        await recordWorkflowSnapshot(workflowState, step, handoffSummary)
        break
      }
      messages.push({ role: 'user', content: `UPDATED_CONTEXT\n${renderUserContext(latestContext)}` })
    }

    await sessionEvent({
      type: 'turn_completed',
      turnId,
      message: `Turn ${step} completed.`,
      data: { done, blocked, toolCalls },
    })

    if (done) break
  }

  if (!done) {
    summary = `Reached step budget (${maxSteps}) without agent_done.`
    emit('warn', summary, step)
    ctx.trace.record({ phase: 'agent_loop', action: summary, status: 'warn' })
  }

  await finalizeSession(
    done && !blocked ? 'completed' : 'blocked',
    { steps: step, toolCalls, done, blocked, summary, workflowState },
    done && !blocked ? undefined : summary,
  )

  return { steps: step, toolCalls, done, blocked, summary, workflowState }
}

function turnIdForStep(step: number): string {
  return `turn_${String(step).padStart(3, '0')}`
}

function sessionEventTypeForStatus(status: Extract<AgentSessionStatus, 'completed' | 'blocked' | 'failed' | 'aborted'>) {
  if (status === 'completed') return 'session_completed'
  if (status === 'failed') return 'session_failed'
  if (status === 'aborted') return 'session_aborted'
  return 'session_blocked'
}

function buildLoopContextWithWorkflow(
  input: AgentLoopInput,
  workflowState: WorkflowState,
  recentActions: ContextRecentAction[],
  blockers: string[],
) {
  return buildLoopContext(
    {
      goal: input.goal,
      resume: input.resume,
      ctx: input.ctx,
      extraContext: input.extraContext,
      safetyMode: input.safetyMode,
      workflowState,
    },
    recentActions,
    blockersWithWorkflow(blockers, workflowState),
  )
}

function blockersWithWorkflow(blockers: string[], workflowState: WorkflowState): string[] {
  const next = [...blockers]
  if (workflowState.humanHandoffRequired && workflowState.blocker && !next.includes(workflowState.blocker)) {
    next.push(workflowState.blocker)
  }
  return next
}

function workflowHandoffSummary(workflowState: WorkflowState): string | undefined {
  if (workflowState.phase === 'login_required') return 'Human login required before continuing.'
  if (workflowState.phase === 'captcha_required') return 'Human verification required before continuing.'
  return undefined
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

function noteWithPolicy(note: string, decision: PolicyEngineDecision): string {
  return `${note}\nPolicy [${decision.policyCode}]: ${decision.reason}`
}

function policyMetadata(decision: PolicyEngineDecision): Record<string, unknown> {
  return {
    schemaVersion: decision.schemaVersion,
    action: decision.action,
    riskLevel: decision.riskLevel,
    gateKind: decision.gateKind,
    requiresFreshContext: decision.requiresFreshContext,
    policyCode: decision.policyCode,
    ruleId: decision.ruleId,
    workflowPhase: decision.workflowPhase,
    auditTags: decision.auditTags,
  }
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
