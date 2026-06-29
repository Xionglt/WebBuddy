import type { RiskLevel } from '../sdk/trace.js'
import type { LocalToolRunResult } from './local-adapter.js'
import type { ToolCall } from './tool-contract.js'
import { createNormalizedToolError, type NormalizedToolError } from './tool-errors.js'
import type { ToolExecutionState, ToolExecutionStatus } from './tool-progress.js'

export type ToolTerminalStatus = Exclude<ToolExecutionStatus, 'queued' | 'running'>

export interface NormalizedToolResult {
  schemaVersion: 'normalized-tool-result/v1'
  toolCallId: string
  name: string
  args: Record<string, unknown>
  ok: boolean
  status: ToolTerminalStatus
  observation: string
  data?: unknown
  risk?: RiskLevel
  pageChanged: boolean
  done: boolean
  rawResult?: LocalToolRunResult
  error?: NormalizedToolError
  state: ToolExecutionState
  queuedAt: string
  startedAt?: string
  completedAt: string
  durationMs: number
}

export function normalizeLocalToolResult(
  call: ToolCall,
  rawResult: LocalToolRunResult,
  state: ToolExecutionState,
): NormalizedToolResult {
  const thrownMessage = toolRegistryThrowMessage(call.name, rawResult.observation)
  const observation = thrownMessage === undefined ? rawResult.observation : `FAILED (TOOL_EXCEPTION): ${thrownMessage}`
  const error = thrownMessage === undefined
    ? errorFromObservation(observation)
    : createNormalizedToolError('registry_exception', 'TOOL_EXCEPTION', thrownMessage, { fatal: true })
  return {
    schemaVersion: 'normalized-tool-result/v1',
    toolCallId: call.id,
    name: call.name,
    args: call.arguments,
    ok: !error,
    status: error ? 'failed' : 'succeeded',
    observation,
    ...(rawResult.data !== undefined ? { data: rawResult.data } : {}),
    ...(rawResult.risk ? { risk: rawResult.risk } : {}),
    pageChanged: Boolean(rawResult.pageChanged),
    done: Boolean(rawResult.done),
    rawResult,
    ...(error ? { error } : {}),
    state,
    queuedAt: state.queuedAt,
    ...(state.startedAt ? { startedAt: state.startedAt } : {}),
    completedAt: state.completedAt ?? state.queuedAt,
    durationMs: state.durationMs ?? 0,
  }
}

export function normalizedFailureResult(
  call: ToolCall,
  state: ToolExecutionState,
  error: NormalizedToolError,
  observation: string,
): NormalizedToolResult {
  return {
    schemaVersion: 'normalized-tool-result/v1',
    toolCallId: call.id,
    name: call.name,
    args: call.arguments,
    ok: false,
    status: state.status as ToolTerminalStatus,
    observation,
    pageChanged: false,
    done: false,
    error,
    state,
    queuedAt: state.queuedAt,
    ...(state.startedAt ? { startedAt: state.startedAt } : {}),
    completedAt: state.completedAt ?? state.queuedAt,
    durationMs: state.durationMs ?? 0,
  }
}

export function toLegacyToolRunResult(result: NormalizedToolResult): LocalToolRunResult {
  const legacy: LocalToolRunResult = {
    observation: result.observation,
  }
  if (result.data !== undefined) legacy.data = result.data
  if (result.risk) legacy.risk = result.risk
  if (result.rawResult?.pageChanged !== undefined || result.pageChanged) legacy.pageChanged = result.pageChanged
  if (result.rawResult?.done !== undefined || result.done) legacy.done = result.done
  return legacy
}

export function isValidLocalToolRunResult(value: unknown): value is LocalToolRunResult {
  return Boolean(
    value &&
      typeof value === 'object' &&
      typeof (value as { observation?: unknown }).observation === 'string',
  )
}

function errorFromObservation(observation: string): NormalizedToolError | undefined {
  if (observation.startsWith('FAILED (')) {
    const code = observation.match(/^FAILED \(([^)]+)\):/)?.[1] ?? 'TOOL_FAILED'
    return createNormalizedToolError('tool_failed_observation', code, observation)
  }
  if (observation.startsWith('Unknown tool:')) {
    return createNormalizedToolError('unknown_tool', 'UNKNOWN_TOOL', observation)
  }
  return undefined
}

export function toolRegistryThrowMessage(toolName: string, observation: string): string | undefined {
  const prefix = `Tool ${toolName} threw:`
  if (!observation.startsWith(prefix)) return undefined
  return observation.slice(prefix.length).trim() || observation
}

export type { NormalizedToolError, NormalizedToolErrorKind } from './tool-errors.js'
