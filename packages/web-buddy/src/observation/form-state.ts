export interface FormFieldState {
  index: number
  label: string
  tag?: string
  type?: string
  role?: string
  name?: string
  id?: string
  placeholder?: string
  value?: string
  required: boolean
  filled: boolean
  disabled: boolean
  readonly: boolean
  invalid: boolean
  error?: string
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
  updatedAt: string
}
