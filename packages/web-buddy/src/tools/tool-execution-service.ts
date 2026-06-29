import { abortReason } from '../kernel/run-controller.js'
import type { KernelEvent, KernelEventType } from '../kernel/kernel-events.js'
import type { LocalToolContext, LocalToolRunResult } from './local-adapter.js'
import type { ToolCall, ToolUseContext } from './tool-contract.js'
import { createNormalizedToolError, messageFromUnknown, type NormalizedToolError } from './tool-errors.js'
import type { ToolExecutionState, ToolExecutionStatus } from './tool-progress.js'
import {
  isValidLocalToolRunResult,
  normalizeLocalToolResult,
  normalizedFailureResult,
  toLegacyToolRunResult,
  type NormalizedToolResult,
  type ToolTerminalStatus,
} from './tool-result.js'

export interface ToolExecutionRegistry {
  run(toolName: string, args: Record<string, unknown>, ctx: LocalToolContext): Promise<LocalToolRunResult>
}

export interface ToolExecutionServiceOptions {
  defaultTimeoutMs?: number
}

type RegistryOutcome =
  | { kind: 'result'; result: LocalToolRunResult }
  | { kind: 'exception'; error: unknown }

type RaceOutcome =
  | RegistryOutcome
  | { kind: 'aborted'; reason: string }
  | { kind: 'timeout'; timeoutMs: number }

export class ToolExecutionService {
  constructor(
    private readonly registry: ToolExecutionRegistry,
    private readonly options: ToolExecutionServiceOptions = {},
  ) {}

  async execute(call: ToolCall, context: ToolUseContext): Promise<NormalizedToolResult> {
    const timeoutMs = normalizeTimeoutMs(context.timeoutMs ?? this.options.defaultTimeoutMs)
    const queuedAt = nowIso(context)
    let state: ToolExecutionState = {
      version: 1,
      toolCallId: call.id,
      name: call.name,
      turnId: context.turnId,
      step: context.step,
      status: 'queued',
      attempts: 1,
      queuedAt,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(context.metadata ? { metadata: context.metadata } : {}),
    }
    this.publish(context, state)

    if (context.abortSignal?.aborted) {
      const reason = abortReason(context.abortSignal)
      const error = createNormalizedToolError('aborted', 'ABORTED', reason)
      state = this.terminalState(context, state, 'cancelled', {
        error,
        abortReason: reason,
        startedAt: undefined,
      })
      this.publish(context, state)
      return normalizedFailureResult(call, state, error, `FAILED (ABORTED): ${reason}`)
    }

    const startedAt = nowIso(context)
    state = { ...state, status: 'running', startedAt }
    this.publish(context, state)

    const outcome = await this.runWithDeadline(call, context, timeoutMs)
    if (outcome.kind === 'result') {
      if (!isValidLocalToolRunResult(outcome.result)) {
        const message = `Tool ${call.name} returned an invalid result.`
        const error = createNormalizedToolError('invalid_result', 'INVALID_TOOL_RESULT', message, {
          fatal: true,
          cause: outcome.result,
        })
        state = this.terminalState(context, state, 'failed', { error })
        this.publish(context, state)
        return normalizedFailureResult(call, state, error, `FAILED (INVALID_TOOL_RESULT): ${message}`)
      }

      const thrownMessage = toolThrownMessage(call.name, outcome.result.observation)
      if (thrownMessage) {
        const error = createNormalizedToolError('registry_exception', 'TOOL_EXCEPTION', thrownMessage, {
          fatal: true,
        })
        state = this.terminalState(context, state, 'failed', { error })
        this.publish(context, state)
        return normalizedFailureResult(call, state, error, `FAILED (TOOL_EXCEPTION): ${thrownMessage}`)
      }

      const normalized = normalizeLocalToolResult(
        call,
        outcome.result,
        this.terminalState(context, state, terminalStatusForObservation(outcome.result.observation, call.name), {}),
      )
      state = normalized.state
      this.publish(context, state)
      return normalized
    }

    if (outcome.kind === 'exception') {
      const message = `Tool ${call.name} threw: ${messageFromUnknown(outcome.error)}`
      const error = createNormalizedToolError('registry_exception', 'TOOL_EXCEPTION', message, {
        fatal: true,
        cause: outcome.error,
      })
      state = this.terminalState(context, state, 'failed', { error })
      this.publish(context, state)
      return normalizedFailureResult(call, state, error, `FAILED (TOOL_EXCEPTION): ${message}`)
    }

    if (outcome.kind === 'timeout') {
      const message = `Tool ${call.name} timed out after ${outcome.timeoutMs}ms.`
      const error = createNormalizedToolError('timeout', 'TOOL_TIMEOUT', message)
      state = this.terminalState(context, state, 'timed_out', { error })
      this.publish(context, state)
      return normalizedFailureResult(call, state, error, `FAILED (TOOL_TIMEOUT): ${message}`)
    }

    const error = createNormalizedToolError('aborted', 'ABORTED', outcome.reason)
    state = this.terminalState(context, state, 'cancelled', {
      error,
      abortReason: outcome.reason,
    })
    this.publish(context, state)
    return normalizedFailureResult(call, state, error, `FAILED (ABORTED): ${outcome.reason}`)
  }

  private async runWithDeadline(
    call: ToolCall,
    context: ToolUseContext,
    timeoutMs: number | undefined,
  ): Promise<RaceOutcome> {
    const registryPromise = this.runRegistry(call, context)
    const races: Promise<RaceOutcome>[] = [registryPromise]
    let timeoutId: ReturnType<typeof setTimeout> | undefined
    let abortListener: (() => void) | undefined

    if (context.abortSignal) {
      if (context.abortSignal.aborted) {
        races.push(Promise.resolve({ kind: 'aborted', reason: abortReason(context.abortSignal) }))
      } else {
        races.push(new Promise<RaceOutcome>((resolve) => {
          abortListener = () => resolve({ kind: 'aborted', reason: abortReason(context.abortSignal!) })
          context.abortSignal!.addEventListener('abort', abortListener, { once: true })
        }))
      }
    }

    if (timeoutMs !== undefined && Number.isFinite(timeoutMs) && timeoutMs >= 0) {
      races.push(new Promise<RaceOutcome>((resolve) => {
        timeoutId = setTimeout(() => resolve({ kind: 'timeout', timeoutMs }), timeoutMs)
      }))
    }

    try {
      return await Promise.race(races)
    } finally {
      if (timeoutId) clearTimeout(timeoutId)
      if (abortListener) context.abortSignal?.removeEventListener('abort', abortListener)
    }
  }

  private async runRegistry(call: ToolCall, context: ToolUseContext): Promise<RegistryOutcome> {
    try {
      const result = await this.registry.run(call.name, call.arguments, context.local)
      return { kind: 'result', result }
    } catch (error) {
      return { kind: 'exception', error }
    }
  }

  private terminalState(
    context: ToolUseContext,
    state: ToolExecutionState,
    status: ToolTerminalStatus,
    patch: {
      error?: NormalizedToolError
      abortReason?: string
      startedAt?: string
    },
  ): ToolExecutionState {
    const completedAt = nowIso(context)
    const startedAt = patch.startedAt === undefined ? state.startedAt : patch.startedAt
    return {
      ...state,
      status,
      ...(startedAt ? { startedAt } : {}),
      completedAt,
      durationMs: durationMs(startedAt ?? state.queuedAt, completedAt),
      ...(patch.abortReason ? { abortReason: patch.abortReason } : {}),
      ...(patch.error ? { error: patch.error } : {}),
    }
  }

  private publish(context: ToolUseContext, state: ToolExecutionState): void {
    try {
      context.onStateChange?.(state)
    } catch {
      // Observability callbacks should not change tool execution semantics.
    }
    try {
      context.emit?.(kernelEventForState(context, state))
    } catch {
      // Kernel event emission is best-effort at this layer.
    }
  }
}

function nowIso(context: ToolUseContext): string {
  return (context.now?.() ?? new Date()).toISOString()
}

function durationMs(startedAt: string, completedAt: string): number {
  return Math.max(0, Date.parse(completedAt) - Date.parse(startedAt))
}

function normalizeTimeoutMs(timeoutMs: number | undefined): number | undefined {
  if (timeoutMs === undefined) return undefined
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) return undefined
  return timeoutMs
}

function terminalStatusForObservation(observation: string, toolName: string): ToolTerminalStatus {
  if (observation.startsWith('FAILED (') || observation.startsWith('Unknown tool:')) return 'failed'
  if (observation.startsWith(`Tool ${toolName} threw:`)) return 'failed'
  return 'succeeded'
}

function toolThrownMessage(toolName: string, observation: string): string | undefined {
  const prefix = `Tool ${toolName} threw:`
  if (!observation.startsWith(prefix)) return undefined
  return observation.slice(prefix.length).trim() || observation
}

function kernelEventForState(context: ToolUseContext, state: ToolExecutionState): KernelEvent {
  const type = kernelEventTypeForState(state.status)
  return {
    version: 1,
    sessionId: context.sessionId,
    runId: context.runId,
    ts: state.completedAt ?? state.startedAt ?? state.queuedAt,
    type,
    turnId: state.turnId,
    toolCallId: state.toolCallId,
    message: `${state.name} ${messageStatusForState(state.status)}.`,
    data: {
      name: state.name,
      status: state.status,
      executionState: state,
      ...(state.durationMs !== undefined ? { durationMs: state.durationMs } : {}),
      ...(state.error ? { error: state.error } : {}),
    },
  }
}

function kernelEventTypeForState(status: ToolExecutionStatus): KernelEventType {
  if (status === 'queued') return 'tool_call_created'
  if (status === 'running') return 'tool_started'
  if (status === 'succeeded') return 'tool_completed'
  return 'tool_failed'
}

function messageStatusForState(status: ToolExecutionStatus): string {
  if (status === 'queued') return 'queued'
  if (status === 'running') return 'started'
  if (status === 'succeeded') return 'completed'
  if (status === 'timed_out') return 'timed out'
  if (status === 'cancelled') return 'cancelled'
  return 'failed'
}

export { toLegacyToolRunResult }
