import type { FormFieldOption, FormFieldState, FormState, SubmitCandidate, UploadHint } from './form-state.js'

export interface RawFormField {
  index?: number
  tag?: string
  type?: string
  role?: string
  label?: string
  placeholder?: string
  name?: string
  id?: string
  value?: string
  required?: boolean
  disabled?: boolean
  readonly?: boolean
  invalid?: boolean
  error?: string
  nearbyText?: string
  options?: RawFormFieldOption[]
}

export interface RawFormFieldOption {
  value?: string
  label?: string
  selected?: boolean
}

export interface RawUploadHint {
  tag?: string
  type?: string
  text?: string
  visible?: boolean
  accept?: string
}

export interface RawSubmitCandidate {
  tag?: string
  type?: string
  role?: string
  text?: string
  risk?: SubmitCandidate['risk'] | string
  visible?: boolean
}

export interface RawFormSnapshot {
  url?: string
  fields?: RawFormField[]
  submitCandidates?: RawSubmitCandidate[]
  uploadHints?: RawUploadHint[]
  visibleErrors?: string[]
}

export function buildFormState(raw: RawFormSnapshot, updatedAt = new Date().toISOString()): FormState {
  const fields = (raw.fields ?? []).map((field, index) => toFieldState(field, index))
  const submitCandidates = (raw.submitCandidates ?? []).map(toSubmitCandidate).filter((candidate) => candidate.text)
  const uploadHints = (raw.uploadHints ?? []).map(toUploadHint).filter((hint) => hint.text || hint.type === 'file')
  const visibleErrors = (raw.visibleErrors ?? []).map(normalize).filter(Boolean)
  return {
    schemaVersion: 'form-state/v1',
    url: raw.url ?? '',
    fields,
    missingRequired: fields.filter((field) => field.required && !field.filled && !field.disabled),
    filledFields: fields.filter((field) => field.filled),
    submitCandidates,
    uploadHints,
    visibleErrors,
    updatedAt,
  }
}

function toFieldState(field: RawFormField, fallbackIndex: number): FormFieldState {
  const value = normalize(field.value)
  const label = normalize(field.label) || normalize(field.placeholder) || normalize(field.name) || normalize(field.id) || normalize(field.nearbyText) || `field-${fallbackIndex + 1}`
  return {
    index: field.index ?? fallbackIndex,
    label,
    tag: field.tag,
    type: field.type,
    role: field.role,
    name: field.name,
    id: field.id,
    placeholder: field.placeholder,
    value,
    required: Boolean(field.required),
    filled: value.length > 0,
    disabled: Boolean(field.disabled),
    readonly: Boolean(field.readonly),
    invalid: Boolean(field.invalid),
    error: field.error,
    options: normalizeOptions(field.options),
  }
}

function toSubmitCandidate(candidate: RawSubmitCandidate): SubmitCandidate {
  return {
    tag: candidate.tag ?? 'unknown',
    type: candidate.type,
    role: candidate.role,
    text: normalize(candidate.text),
    risk: toRisk(candidate.risk),
    visible: candidate.visible,
  }
}

function toUploadHint(hint: RawUploadHint): UploadHint {
  return {
    tag: hint.tag ?? 'unknown',
    type: hint.type,
    text: normalize(hint.text),
    visible: hint.visible,
    accept: hint.accept,
  }
}

function normalizeOptions(options: RawFormFieldOption[] | undefined): FormFieldOption[] | undefined {
  if (!options || options.length === 0) return undefined
  return options
    .map((option) => ({
      value: normalize(option.value),
      label: normalize(option.label),
      selected: option.selected,
    }))
    .filter((option) => option.value || option.label)
}

function toRisk(value: SubmitCandidate['risk'] | string | undefined): SubmitCandidate['risk'] | undefined {
  return value === 'L0' || value === 'L1' || value === 'L2' || value === 'L3' || value === 'L4' ? value : undefined
}

function normalize(value: string | null | undefined): string {
  return (value || '').replace(/\s+/g, ' ').trim()
}
