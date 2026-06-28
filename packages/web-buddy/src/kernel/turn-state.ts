export type TurnStatus =
  | 'created'
  | 'model_running'
  | 'tools_running'
  | 'completed'
  | 'blocked'
  | 'failed'
  | 'aborted'

export type PendingToolCallStatus = 'pending' | 'running' | 'completed' | 'failed' | 'blocked'

export interface PendingToolCallSnapshot {
  toolCallId: string
  name: string
  status: PendingToolCallStatus
}

export interface TurnStateSnapshot {
  version: 1
  runId?: string
  sessionId?: string
  turnId: string
  step: number
  status: TurnStatus
  startedAt: string
  updatedAt: string
  completedAt?: string
  pendingToolCalls: PendingToolCallSnapshot[]
  workflowState?: unknown
  error?: string
}

export interface CreateTurnStateSnapshotInput {
  runId?: string
  sessionId?: string
  turnId?: string
  step: number
  status?: TurnStatus
  startedAt?: string
  updatedAt?: string
  completedAt?: string
  pendingToolCalls?: PendingToolCallSnapshot[]
  workflowState?: unknown
  error?: string
}

export function createTurnStateSnapshot(input: CreateTurnStateSnapshotInput): TurnStateSnapshot {
  const now = new Date().toISOString()
  return {
    version: 1,
    ...(input.runId ? { runId: input.runId } : {}),
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    turnId: input.turnId ?? turnIdForStep(input.step),
    step: input.step,
    status: input.status ?? 'created',
    startedAt: input.startedAt ?? now,
    updatedAt: input.updatedAt ?? now,
    ...(input.completedAt ? { completedAt: input.completedAt } : {}),
    pendingToolCalls: input.pendingToolCalls ?? [],
    ...(input.workflowState !== undefined ? { workflowState: input.workflowState } : {}),
    ...(input.error ? { error: input.error } : {}),
  }
}

export function updateTurnStateSnapshot(
  snapshot: TurnStateSnapshot,
  patch: Partial<Omit<TurnStateSnapshot, 'version' | 'startedAt'>>,
): TurnStateSnapshot {
  const updatedAt = new Date().toISOString()
  return {
    ...snapshot,
    ...patch,
    updatedAt,
  }
}

export function turnIdForStep(step: number): string {
  return `turn_${String(step).padStart(3, '0')}`
}
