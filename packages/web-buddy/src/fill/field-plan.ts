import type { FieldKey, FormFieldState } from '../observation/form-state.js'
import type { AnswerStore } from '../context/answer-store.js'
import type { ProfileStore } from '../context/profile-store.js'
import type { ChatOptions } from '../sdk/llm.js'

export type FieldControlKind =
  | 'text'
  | 'textarea'
  | 'select_native'
  | 'select_custom'
  | 'cascader'
  | 'date'
  | 'radio'
  | 'checkbox'
  | 'file'
  | 'unknown'

export type FieldValueSource =
  | 'resume'
  | 'user_answer'
  | 'derived'
  | 'page'
  | 'none'

export interface FieldPlanUserQuestion {
  question: string
  options?: string[]
}

export interface FieldOptionMatch {
  optionValue: string
  optionLabel: string
  score: number
}

export interface PlannedField {
  fieldKey: FieldKey
  fieldIndex: number
  label: string
  controlKind: FieldControlKind
  required?: boolean
  requiredConfidence?: number
  intendedValue: string | string[] | null
  valueSource: FieldValueSource
  sourceRef?: string
  normalization?: string
  confidence: number
  needsUser?: FieldPlanUserQuestion
  optionMatched?: FieldOptionMatch
  skipReason?: string
}

export interface FieldPlan {
  schemaVersion: 'field-plan/v1'
  planned: PlannedField[]
  sourceFormUrl?: string
  fieldCount?: number
  updatedAt: string
}

export interface FieldPlannerInput {
  fields: FormFieldState[]
  profileStoreAvailable: boolean
  answerStoreAvailable: boolean
  profileStore?: ProfileStore
  answerStore?: AnswerStore
  llm?: FieldPlannerLlm
  existingPlan?: FieldPlan
  sourceFormUrl?: string
  now?: string
}

export interface FieldPlanner {
  plan(input: FieldPlannerInput): FieldPlan | Promise<FieldPlan>
}

export interface FieldPlannerLlm {
  hasKey: boolean
  generateJson<T = unknown>(system: string, user: string, options?: ChatOptions): Promise<T | null>
}
