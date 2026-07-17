import type { FormState } from '../observation/form-state.js'
import type { PageState } from '../observation/page-state.js'
import type { RiskLevel } from '../sdk/trace.js'
import type { TaskState } from '../task/task-state.js'
import type { FieldPlan } from '../fill/field-plan.js'
import type { FillLedgerSummary } from '../fill/fill-ledger.js'
import type { WorkflowState } from '../workflow/workflow-state.js'
import type { RunMemory } from './run-memory.js'
import type { ResolvedSkillContext } from '../skills/types.js'
import type { ContextItem } from '../task/contracts.js'

export type MaybePromise<T> = T | Promise<T>

export interface ObservationProvider {
  getPageState(sessionId: string): MaybePromise<PageState | undefined>
  getFormState(sessionId: string): MaybePromise<FormState | undefined>
}

export type RecentActionStatus = 'ok' | 'warn' | 'blocked' | 'error'

export interface ContextRecentAction {
  step: number
  toolName: string
  argumentsSummary: string
  status: RecentActionStatus
  risk?: RiskLevel
  observation?: string
  at: string
}

export interface ContextFreshness {
  pageStateUpdatedAt?: string
  formStateUpdatedAt?: string
  pageStateAgeMs?: number
  formStateAgeMs?: number
  pageStateStale: boolean
  formStateStale: boolean
  staleAfterMs: number
}

export interface ContextSnapshot {
  schemaVersion: 'context-snapshot/v1'
  sessionId: string
  goal: string
  page?: PageState
  form?: FormState
  taskState?: TaskState
  workflowState?: WorkflowState
  runMemory?: RunMemory
  relevantMemories?: string
  fieldPlan?: FieldPlan
  fillLedgerSummary?: FillLedgerSummary
  answerSummary?: string
  /** Bounded control-plane summary of background work; never includes child ReAct history. */
  agentTasks?: string
  freshness: ContextFreshness
  contextItems: ContextItem[]
  contextSummary: string
  recentActions: ContextRecentAction[]
  safetyNotes: string[]
  resolvedSkillContext?: ResolvedSkillContext
  blockers: string[]
  extraContext?: string
  updatedAt: string
}

export interface ContextSnapshotInput {
  sessionId: string
  goal: string
  contextItems?: ContextItem[]
  contextSummary?: string
  recentActions?: ContextRecentAction[]
  safetyNotes?: string[]
  resolvedSkillContext?: ResolvedSkillContext
  blockers?: string[]
  extraContext?: string
  taskState?: TaskState
  workflowState?: WorkflowState
  runMemory?: RunMemory
  relevantMemories?: string
  fieldPlan?: FieldPlan
  fillLedgerSummary?: FillLedgerSummary
  answerSummary?: string
  agentTasks?: string
  updatedAt?: string
}

export type PromptSectionId =
  | 'SYSTEM_ROLE'
  | 'SAFETY_RULES'
  | 'TASK'
  | 'TASK_STATE'
  | 'WORKFLOW_STATE'
  | 'AGENT_TASKS'
  | 'RUN_MEMORY'
  | 'RELEVANT_MEMORIES'
  | 'CONTEXT_ITEMS'
  | 'CURRENT_PAGE_STATE'
  | 'CURRENT_FORM_STATE'
  | 'FILL_PLAN'
  | 'RECENT_ACTIONS'
  | 'NEXT_ACTION_RULES'

export interface PromptSection {
  id: PromptSectionId
  title: string
  content: string
}
