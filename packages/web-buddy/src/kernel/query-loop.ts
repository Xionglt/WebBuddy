import type { AgentRuntimeEvent, AgentRuntimeLlm, AgentSafetyMode, AgentStopReason } from '../agent/types.js'
import type { HumanGate } from '../sdk/human.js'
import type { LlmGateway } from '../sdk/llm.js'
import type { ResumeProfile } from '../sdk/resume.js'
import type { SessionRecorder } from '../session/index.js'
import { runAgentLoop, type AgentEvent, type AgentLoopResult } from '../runtime/local/agent-loop.js'
import { ToolRegistry, type ToolContext } from '../runtime/local/tool-registry.js'
import type { WorkflowState } from '../workflow/workflow-state.js'
import type { KernelEvent } from './kernel-events.js'
import {
  DefaultAgentRunController,
  type AgentKernelStatus,
  type AgentRunController,
} from './run-controller.js'
import {
  createTurnStateSnapshot,
  turnIdForStep,
  updateTurnStateSnapshot,
  type TurnStateSnapshot,
} from './turn-state.js'
import { createTokenBudgetSnapshot, type TokenBudgetSnapshot } from './token-budget.js'

export interface QueryLoopInput {
  goal: string
  resume: ResumeProfile
  llm: AgentRuntimeLlm
  registry?: ToolRegistry
  ctx: ToolContext
  gate: HumanGate
  maxSteps?: number
  onEvent?: (event: KernelEvent) => void
  onRuntimeEvent?: (event: AgentRuntimeEvent) => void
  extraContext?: string
  safetyMode?: AgentSafetyMode
  session?: SessionRecorder
  controller?: AgentRunController
}

export interface AgentKernelResult {
  schemaVersion: 'agent-kernel-result/v1'
  runtime: 'agent-kernel'
  status: AgentKernelStatus
  stopReason: AgentStopReason
  steps: number
  toolCalls: number
  done: boolean
  blocked: boolean
  summary: string
  workflowState?: WorkflowState
  turnState?: TurnStateSnapshot
  tokenBudget?: TokenBudgetSnapshot
}

export class QueryLoop {
  async run(input: QueryLoopInput): Promise<AgentKernelResult> {
    const controller = input.controller ?? new DefaultAgentRunController()
    const registry = input.registry ?? new ToolRegistry()
    const runId = input.session?.session.runId ?? input.ctx.trace.runId
    const sessionId = input.session?.session.sessionId ?? input.ctx.sessionId
    let turnState = createTurnStateSnapshot({
      runId,
      sessionId,
      step: 0,
      status: 'created',
    })

    controller.markRunning()

    try {
      const loopResult = await runAgentLoop({
        goal: input.goal,
        resume: input.resume,
        llm: input.llm as LlmGateway,
        registry,
        ctx: input.ctx,
        gate: input.gate,
        maxSteps: input.maxSteps,
        onEvent: (event) => {
          turnState = updateTurnStateFromRuntimeEvent(turnState, event, runId, sessionId)
          input.onRuntimeEvent?.({ schemaVersion: 'agent-runtime-event/v1', ...event })
        },
        extraContext: input.extraContext,
        safetyMode: input.safetyMode,
        session: input.session,
        abortSignal: controller.signal,
      })

      const status = statusForLoopResult(loopResult, controller)
      markController(controller, status, loopResult.summary)
      turnState = updateTurnStateSnapshot(turnState, {
        step: loopResult.steps,
        turnId: turnIdForStep(loopResult.steps),
        status: turnStatusForKernelStatus(status, loopResult),
        completedAt: new Date().toISOString(),
        workflowState: loopResult.workflowState,
      })

      return {
        schemaVersion: 'agent-kernel-result/v1',
        runtime: 'agent-kernel',
        status,
        stopReason: inferStopReason(loopResult, status, input.maxSteps),
        steps: loopResult.steps,
        toolCalls: loopResult.toolCalls,
        done: loopResult.done,
        blocked: loopResult.blocked,
        summary: loopResult.summary,
        ...(loopResult.workflowState ? { workflowState: loopResult.workflowState } : {}),
        turnState,
        tokenBudget: createTokenBudgetSnapshot(),
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const status: AgentKernelStatus = controller.signal.aborted ? 'aborted' : 'failed'
      if (status === 'aborted') {
        controller.abort(message)
      } else {
        controller.markFailed(message)
      }
      turnState = updateTurnStateSnapshot(turnState, {
        status,
        completedAt: new Date().toISOString(),
        error: message,
      })
      return {
        schemaVersion: 'agent-kernel-result/v1',
        runtime: 'agent-kernel',
        status,
        stopReason: status === 'aborted' ? 'aborted' : 'unknown',
        steps: turnState.step,
        toolCalls: turnState.pendingToolCalls.length,
        done: false,
        blocked: true,
        summary: `${status === 'aborted' ? 'Run aborted' : 'Run failed'}: ${message}`,
        turnState,
        tokenBudget: createTokenBudgetSnapshot(),
      }
    }
  }
}

function updateTurnStateFromRuntimeEvent(
  snapshot: TurnStateSnapshot,
  event: AgentEvent,
  runId: string,
  sessionId: string,
): TurnStateSnapshot {
  const status = statusForRuntimeEvent(event.level)
  return updateTurnStateSnapshot(snapshot, {
    runId,
    sessionId,
    step: event.step,
    turnId: turnIdForStep(event.step),
    status,
  })
}

function statusForRuntimeEvent(level: AgentEvent['level']) {
  if (level === 'think') return 'model_running'
  if (level === 'act' || level === 'observe' || level === 'gate') return 'tools_running'
  if (level === 'done') return 'completed'
  if (level === 'error') return 'failed'
  return 'created'
}

function statusForLoopResult(result: AgentLoopResult, controller: AgentRunController): AgentKernelStatus {
  if (controller.signal.aborted || controller.status === 'aborted') return 'aborted'
  if (result.done && !result.blocked) return 'completed'
  if (result.blocked) return 'blocked'
  return 'blocked'
}

function turnStatusForKernelStatus(status: AgentKernelStatus, result: AgentLoopResult) {
  if (status === 'completed') return 'completed'
  if (status === 'aborted') return 'aborted'
  if (status === 'failed') return 'failed'
  if (result.blocked) return 'blocked'
  return 'completed'
}

function markController(controller: AgentRunController, status: AgentKernelStatus, summary: string): void {
  if (status === 'completed') controller.markCompleted()
  else if (status === 'blocked') controller.markBlocked(summary)
  else if (status === 'failed') controller.markFailed(summary)
  else if (status === 'aborted') controller.abort(summary)
}

function inferStopReason(result: AgentLoopResult, status: AgentKernelStatus, maxSteps?: number): AgentStopReason {
  const summary = result.summary.toLowerCase()
  if (status === 'aborted') return 'aborted'
  if (summary.includes('llm error')) return 'llm_error'
  if (result.blocked) return 'blocked'
  if (result.done) return 'agent_done'
  if (summary.includes('step budget') || (maxSteps !== undefined && result.steps >= maxSteps)) return 'step_budget'
  return 'unknown'
}
