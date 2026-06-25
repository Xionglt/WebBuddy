import type { RunSource } from '../metrics/trace-inputs.js'

export type AgentStateFinalStatus =
  | 'completed'
  | 'blocked'
  | 'incomplete'
  | 'failed'
  | 'unknown'

export interface AgentStateFailure {
  category: string
  message: string
  recoverable: boolean
}

export interface AgentState {
  schemaVersion: 'agent-state/v1'
  runId?: string
  sessionId?: string
  source: RunSource
  scenario?: string
  profile?: string
  goal?: string
  stage: string
  currentUrl?: string
  lastAction?: unknown
  lastFailure?: AgentStateFailure
  finalStatus: AgentStateFinalStatus
  updatedAt: string
}

export function createAgentState(input: {
  runId?: string
  sessionId?: string
  source: RunSource
  scenario?: string
  profile?: string
  goal?: string
  stage?: string
  currentUrl?: string
  lastAction?: unknown
  lastFailure?: AgentStateFailure
  finalStatus?: AgentStateFinalStatus
}): AgentState {
  return {
    schemaVersion: 'agent-state/v1',
    runId: input.runId,
    sessionId: input.sessionId,
    source: input.source,
    scenario: input.scenario,
    profile: input.profile,
    goal: input.goal,
    stage: input.stage || 'init',
    currentUrl: input.currentUrl,
    lastAction: input.lastAction,
    lastFailure: input.lastFailure,
    finalStatus: input.finalStatus || 'incomplete',
    updatedAt: new Date().toISOString(),
  }
}
