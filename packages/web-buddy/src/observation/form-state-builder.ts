import type {
  FieldLocatorHints,
  FormControlKind,
  FormCoverage,
  FormFieldOption,
  FormFieldState,
  FormState,
  SubmitCandidate,
  UploadHint,
} from './form-state.js'
import { normalizePageFacts, type PageFacts } from './page-facts.js'

export interface RawFormField {
  index?: number
  fieldKey?: string
  controlKind?: FormControlKind
  tag?: string
  type?: string
  role?: string
  label?: string
  placeholder?: string
  name?: string
  id?: string
  value?: string
  filled?: boolean
  checked?: boolean
  required?: boolean
  requiredConfidence?: number
  disabled?: boolean
  readonly?: boolean
  invalid?: boolean
  error?: string
  nearbyText?: string
  locatorHints?: FieldLocatorHints
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
  facts?: Partial<PageFacts>
  formCoverage?: FormCoverage
}

export function buildFormState(raw: RawFormSnapshot, updatedAt = new Date().toISOString()): FormState {
  const fields = (raw.fields ?? []).map((field, index) => toFieldState(field, index))
  const submitCandidates = (raw.submitCandidates ?? []).map(toSubmitCandidate).filter((candidate) => candidate.text)
  const uploadHints = (raw.uploadHints ?? []).map(toUploadHint).filter((hint) => hint.text || hint.type === 'file')
  const visibleErrors = (raw.visibleErrors ?? []).map(normalize).filter(Boolean)
  const facts = normalizePageFacts(raw.facts)
  return {
    schemaVersion: 'form-state/v1',
    url: raw.url ?? '',
    fields,
    missingRequired: fields.filter((field) => field.required && !field.filled && !field.disabled),
    filledFields: fields.filter((field) => field.filled),
    submitCandidates,
    uploadHints,
    visibleErrors,
    ...(facts ? { facts } : {}),
    ...(raw.formCoverage ? { formCoverage: raw.formCoverage } : {}),
    updatedAt,
  }
}

function toFieldState(field: RawFormField, fallbackIndex: number): FormFieldState {
  const value = normalize(field.value)
  const label = normalize(field.label) || normalize(field.placeholder) || normalize(field.name) || normalize(field.id) || normalize(field.nearbyText) || `field-${fallbackIndex + 1}`
  return {
    index: field.index ?? fallbackIndex,
    fieldKey: normalize(field.fieldKey) || undefined,
    controlKind: normalizeControlKind(field.controlKind, field.tag, field.type, field.role),
    label,
    tag: field.tag,
    type: field.type,
    role: field.role,
    name: field.name,
    id: field.id,
    placeholder: field.placeholder,
    value,
    required: Boolean(field.required),
    requiredConfidence: clampConfidence(field.requiredConfidence),
    filled: typeof field.filled === 'boolean' ? field.filled : isFilled(field, value),
    checked: field.checked,
    disabled: Boolean(field.disabled),
    readonly: Boolean(field.readonly),
    invalid: Boolean(field.invalid),
    error: field.error,
    locatorHints: normalizeLocatorHints(field.locatorHints),
    options: normalizeOptions(field.options),
  }
}

function isFilled(field: RawFormField, value: string): boolean {
  const controlKind = normalizeControlKind(field.controlKind, field.tag, field.type, field.role)
  if (controlKind === 'checkbox' || controlKind === 'radio') return Boolean(field.checked)
  if (controlKind === 'select_native' || controlKind === 'select_custom' || controlKind === 'cascader') {
    if (field.options?.some((option) => option.selected && (normalize(option.value) || normalize(option.label)))) return true
    return value.length > 0 && !/^(请选择|please select|select|choose)$/i.test(value)
  }
  return value.length > 0
}

function normalizeControlKind(
  value: FormControlKind | undefined,
  tag?: string,
  type?: string,
  role?: string,
): FormControlKind | undefined {
  if (
    value === 'text' ||
    value === 'textarea' ||
    value === 'select_native' ||
    value === 'select_custom' ||
    value === 'cascader' ||
    value === 'date' ||
    value === 'radio' ||
    value === 'checkbox' ||
    value === 'file' ||
    value === 'unknown'
  ) {
    return value
  }
  const normalizedTag = normalize(tag).toLowerCase()
  const normalizedType = normalize(type).toLowerCase()
  const normalizedRole = normalize(role).toLowerCase()
  if (normalizedType === 'checkbox' || normalizedRole === 'checkbox' || normalizedRole === 'switch') return 'checkbox'
  if (normalizedType === 'radio' || normalizedRole === 'radio') return 'radio'
  if (normalizedType === 'file') return 'file'
  if (normalizedTag === 'select') return 'select_native'
  if (normalizedRole === 'combobox') return 'select_custom'
  if (normalizedTag === 'textarea') return 'textarea'
  if (/date|time|month|week/.test(normalizedType)) return 'date'
  if (normalizedTag === 'input' || /textbox|searchbox/.test(normalizedRole)) return 'text'
  return undefined
}

function clampConfidence(value: number | undefined): number | undefined {
  if (typeof value !== 'number' || Number.isNaN(value)) return undefined
  return Math.max(0, Math.min(1, value))
}

function normalizeLocatorHints(hints: FieldLocatorHints | undefined): FieldLocatorHints | undefined {
  if (!hints) return undefined
  const normalized = {
    aria: normalize(hints.aria) || undefined,
    text: normalize(hints.text) || undefined,
    css: normalize(hints.css) || undefined,
    xpath: normalize(hints.xpath) || undefined,
    name: normalize(hints.name) || undefined,
    id: normalize(hints.id) || undefined,
    placeholder: normalize(hints.placeholder) || undefined,
    label: normalize(hints.label) || undefined,
  }
  return Object.values(normalized).some(Boolean) ? normalized : undefined
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
