import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { AgentState } from './agent-state.js'

export function agentStatePathForTraceDir(traceDir: string): string {
  return join(traceDir, 'agent-state.json')
}

export function writeAgentState(state: AgentState, path: string): string {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2))
  return path
}

export function writeAgentStateSafe(state: AgentState, path: string): string | undefined {
  try {
    return writeAgentState(state, path)
  } catch {
    return undefined
  }
}
