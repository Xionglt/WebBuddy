import type { FormState } from '../observation/form-state.js'
import type { PageState } from '../observation/page-state.js'
import type { RiskLevel } from '../sdk/trace.js'

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

export interface ContextSnapshot {
  schemaVersion: 'context-snapshot/v1'
  sessionId: string
  goal: string
  page?: PageState
  form?: FormState
  resumeSummary: string
  recentActions: ContextRecentAction[]
  safetyNotes: string[]
  blockers: string[]
  extraContext?: string
  updatedAt: string
}

export interface ContextSnapshotInput {
  sessionId: string
  goal: string
  resumeSummary: string
  recentActions?: ContextRecentAction[]
  safetyNotes?: string[]
  blockers?: string[]
  extraContext?: string
  updatedAt?: string
}

export type PromptSectionId =
  | 'SYSTEM_ROLE'
  | 'SAFETY_RULES'
  | 'TASK'
  | 'RESUME_SUMMARY'
  | 'CURRENT_PAGE_STATE'
  | 'CURRENT_FORM_STATE'
  | 'RECENT_ACTIONS'
  | 'NEXT_ACTION_RULES'

export interface PromptSection {
  id: PromptSectionId
  title: string
  content: string
}
