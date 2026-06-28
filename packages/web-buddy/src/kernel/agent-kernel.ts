import type {
  AgentRuntimeEvent,
  AgentRuntimeLlm,
  AgentSafetyMode,
} from '../agent/types.js'
import type { HumanGate } from '../sdk/human.js'
import type { ResumeProfile } from '../sdk/resume.js'
import type { SessionRecorder } from '../session/index.js'
import { ToolRegistry, type ToolContext } from '../runtime/local/tool-registry.js'
import type { KernelEvent, KernelEventType } from './kernel-events.js'
import { QueryLoop, type AgentKernelResult } from './query-loop.js'
import {
  DefaultAgentRunController,
  type AgentKernelStatus,
  type AgentRunController,
} from './run-controller.js'
import { createTurnStateSnapshot } from './turn-state.js'

export interface AgentKernelInput {
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

export interface AgentKernelOptions {
  queryLoop?: QueryLoop
}

export class AgentKernel {
  private readonly queryLoop: QueryLoop

  constructor(options: AgentKernelOptions = {}) {
    this.queryLoop = options.queryLoop ?? new QueryLoop()
  }

  async start(input: AgentKernelInput): Promise<AgentKernelResult> {
    const controller = input.controller ?? new DefaultAgentRunController()
    const runId = input.session?.session.runId ?? input.ctx.trace.runId
    const sessionId = input.session?.session.sessionId ?? input.ctx.sessionId
    const emit = (type: KernelEventType, message: string, data?: Record<string, unknown>) => {
      input.onEvent?.({
        version: 1,
        type,
        sessionId,
        runId,
        ts: new Date().toISOString(),
        message,
        ...(data ? { data } : {}),
      })
    }

    controller.markRunning()
    emit('session_started', 'Agent kernel started.', {
      goal: input.goal,
      maxSteps: input.maxSteps,
      safetyMode: input.safetyMode ?? 'guarded',
    })

    const result = await this.queryLoop.run({
      ...input,
      controller,
    })

    emit(terminalEventType(result.status), terminalMessage(result), {
      status: result.status,
      stopReason: result.stopReason,
      steps: result.steps,
      toolCalls: result.toolCalls,
      done: result.done,
      blocked: result.blocked,
    })

    return result
  }
}

export function failedKernelResult(input: {
  status: Extract<AgentKernelStatus, 'failed' | 'aborted'>
  summary: string
  runId?: string
  sessionId?: string
}): AgentKernelResult {
  return {
    schemaVersion: 'agent-kernel-result/v1',
    runtime: 'agent-kernel',
    status: input.status,
    stopReason: input.status === 'aborted' ? 'aborted' : 'unknown',
    steps: 0,
    toolCalls: 0,
    done: false,
    blocked: true,
    summary: input.summary,
    turnState: createTurnStateSnapshot({
      runId: input.runId,
      sessionId: input.sessionId,
      step: 0,
      status: input.status,
      completedAt: new Date().toISOString(),
      error: input.summary,
    }),
  }
}

function terminalEventType(status: AgentKernelStatus): KernelEventType {
  if (status === 'completed') return 'session_completed'
  if (status === 'aborted') return 'session_aborted'
  if (status === 'failed') return 'session_failed'
  return 'session_blocked'
}

function terminalMessage(result: AgentKernelResult): string {
  if (result.status === 'completed') return 'Agent kernel completed.'
  if (result.status === 'aborted') return result.summary || 'Agent kernel aborted.'
  if (result.status === 'failed') return result.summary || 'Agent kernel failed.'
  return result.summary || 'Agent kernel blocked.'
}
