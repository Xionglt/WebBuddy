import type { PageFacts } from './page-facts.js'

export type FieldKey = string

export type FormControlKind =
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

export interface FieldLocatorHints {
  aria?: string
  text?: string
  css?: string
  xpath?: string
  name?: string
  id?: string
  placeholder?: string
  label?: string
}

export interface FormCoverage {
  schemaVersion: 'form-coverage/v1'
  scrolledTop: boolean
  scrolledBottom: boolean
  segments: number
  totalFieldsSeen: number
  fieldKeysSeen?: FieldKey[]
  auditTool?: 'browser_form_snapshot' | 'browser_form_audit' | (string & {})
  updatedAt: string
}

export interface FormFieldState {
  index: number
  fieldKey?: FieldKey
  controlKind?: FormControlKind
  label: string
  tag?: string
  type?: string
  role?: string
  name?: string
  id?: string
  placeholder?: string
  value?: string
  required: boolean
  requiredConfidence?: number
  filled: boolean
  checked?: boolean
  disabled: boolean
  readonly: boolean
  invalid: boolean
  error?: string
  locatorHints?: FieldLocatorHints
  options?: FormFieldOption[]
}

export interface FormFieldOption {
  value: string
  label: string
  selected?: boolean
}

export interface UploadHint {
  tag: string
  type?: string
  text: string
  visible?: boolean
  accept?: string
}

export interface SubmitCandidate {
  tag: string
  type?: string
  role?: string
  text: string
  risk?: 'L0' | 'L1' | 'L2' | 'L3' | 'L4'
  visible?: boolean
}

export interface FormState {
  schemaVersion: 'form-state/v1'
  url: string
  fields: FormFieldState[]
  missingRequired: FormFieldState[]
  filledFields: FormFieldState[]
  submitCandidates: SubmitCandidate[]
  uploadHints?: UploadHint[]
  visibleErrors?: string[]
  facts?: PageFacts
  formCoverage?: FormCoverage
  updatedAt: string
}
