export type TaskPhase = 'observing' | 'filling' | 'reviewing' | 'blocked' | 'done'

export interface TaskState {
  schemaVersion: 'task-state/v1'
  goal: string
  phase: TaskPhase
  source?: 'explicit' | 'derived_from_workflow'
  sourceWorkflowPhase?: string
  knownBlockers: string[]
  completionCriteria: string[]
  updatedAt: string
}

export interface CreateDefaultTaskStateInput {
  goal: string
  updatedAt?: string
}

export function createDefaultTaskState(input: CreateDefaultTaskStateInput): TaskState {
  return {
    schemaVersion: 'task-state/v1',
    goal: input.goal,
    phase: 'observing',
    source: 'explicit',
    knownBlockers: [],
    completionCriteria: [],
    updatedAt: input.updatedAt ?? new Date().toISOString(),
  }
}
