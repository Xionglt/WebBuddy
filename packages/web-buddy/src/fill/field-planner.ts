import type { AnswerStore } from '../context/answer-store.js'
import type { ProfileStore } from '../context/profile-store.js'
import type { FormFieldState } from '../observation/form-state.js'
import type { ResumeEducation, ResumeExperience, ResumeProjectExperience } from '../sdk/resume.js'
import type {
  FieldPlan,
  FieldPlanner,
  FieldPlannerInput,
  FieldPlannerLlm,
  FieldValueSource,
  PlannedField,
} from './field-plan.js'
import {
  composeSelfIntro,
  deriveYearsOfExperience,
  matchOption,
  normalizePhone,
  pickHighestDegree,
} from './normalizers.js'

interface PlannerProfile {
  name?: string
  email?: string
  phone?: string
  location?: string
  summary?: string
  seniority?: string
  targetRoles: string[]
  skills: string[]
  experience: ResumeExperience[]
  projects: ResumeProjectExperience[]
  education: ResumeEducation[]
}

interface CandidateValue {
  value: string | string[] | null
  source: FieldValueSource
  sourceRef?: string
  normalization?: string
  confidence: number
}

export class DeterministicFieldPlanner implements FieldPlanner {
  plan(input: FieldPlannerInput): FieldPlan {
    const profile = profileFromStore(input.profileStore)
    const now = input.now ?? new Date().toISOString()
    const planned = input.fields.map((field) => planField(field, profile, input.answerStore, now))
    return {
      schemaVersion: 'field-plan/v1',
      planned,
      ...(input.sourceFormUrl ? { sourceFormUrl: input.sourceFormUrl } : {}),
      fieldCount: input.fields.length,
      updatedAt: now,
    }
  }
}

export function createDeterministicFieldPlanner(): FieldPlanner {
  return new DeterministicFieldPlanner()
}

export function createFieldPlanner(input: { llm?: FieldPlannerLlm } = {}): FieldPlanner {
  return input.llm?.hasKey && typeof input.llm.generateJson === 'function'
    ? new LlmFallbackFieldPlanner(input.llm)
    : new DeterministicFieldPlanner()
}

class LlmFallbackFieldPlanner implements FieldPlanner {
  constructor(private readonly llm: FieldPlannerLlm) {}

  async plan(input: FieldPlannerInput): Promise<FieldPlan> {
    const base = new DeterministicFieldPlanner().plan(input)
    const unresolved = base.planned.filter((field) => field.valueSource === 'none')
    if (!unresolved.length) return base

    const payload = await this.llm.generateJson<unknown>(
      llmPlannerSystemPrompt(),
      llmPlannerUserPrompt(input, unresolved),
      { timeoutMs: 25000, maxTokens: 3500, redactTrace: true },
    ).catch(() => null)
    const llmFields = parseLlmPlannedFields(payload, input.fields)
    if (!llmFields.length) return base

    const byKey = new Map(llmFields.map((field) => [field.fieldKey, field]))
    return {
      ...base,
      planned: base.planned.map((field) => {
        if (field.valueSource !== 'none') return field
        return byKey.get(field.fieldKey) ?? field
      }),
      updatedAt: input.now ?? new Date().toISOString(),
    }
  }
}

function planField(
  field: FormFieldState,
  profile: PlannerProfile,
  answerStore: AnswerStore | undefined,
  now: string,
): PlannedField {
  const fieldKey = field.fieldKey ?? `field_${field.index}`
  const base = {
    fieldKey,
    fieldIndex: field.index,
    label: field.label || field.placeholder || field.name || field.id || fieldKey,
    controlKind: field.controlKind ?? 'unknown',
    required: field.required,
    requiredConfidence: field.requiredConfidence,
  }

  if (field.disabled || field.readonly) {
    return {
      ...base,
      intendedValue: null,
      valueSource: 'none',
      confidence: 0,
      skipReason: field.disabled ? 'field_disabled' : 'field_readonly',
    }
  }
  if (base.controlKind === 'file') {
    return {
      ...base,
      intendedValue: null,
      valueSource: 'none',
      confidence: 1,
      skipReason: 'file_fields_must_use_browser_upload_file',
    }
  }

  const answer = answerStore?.get(base.label) ?? answerStore?.get(field.name ?? '') ?? answerStore?.get(field.id ?? '')
  if (answer) {
    return withOptions(field, {
      ...base,
      intendedValue: answer.answer,
      valueSource: 'user_answer',
      sourceRef: `answer:${answer.field}`,
      confidence: 0.95,
    })
  }

  const candidate = candidateForField(field, profile, now)
  if (candidate) {
    return withOptions(field, {
      ...base,
      intendedValue: candidate.value,
      valueSource: candidate.source,
      sourceRef: candidate.sourceRef,
      normalization: candidate.normalization,
      confidence: candidate.confidence,
    })
  }

  const shouldAsk = field.required || (field.requiredConfidence ?? 0) >= 0.75
  return {
    ...base,
    intendedValue: null,
    valueSource: 'none',
    confidence: 0,
    ...(shouldAsk
      ? { needsUser: { question: `请提供"${base.label}"应填写的内容。` } }
      : { skipReason: 'no_resume_or_user_answer_source' }),
  }
}

function withOptions(field: FormFieldState, planned: PlannedField): PlannedField {
  if (!['select_native', 'select_custom', 'radio'].includes(planned.controlKind)) return planned
  if (typeof planned.intendedValue !== 'string') return planned
  const option = matchOption(planned.intendedValue, field.options)
  if (!option) return planned
  return {
    ...planned,
    intendedValue: option.optionLabel,
    optionMatched: option,
    normalization: appendNormalization(planned.normalization, `option-match:${option.score.toFixed(2)}`),
    confidence: Math.min(0.99, Math.max(planned.confidence, option.score)),
  }
}

function candidateForField(field: FormFieldState, profile: PlannerProfile, now: string): CandidateValue | undefined {
  const text = labelText(field)
  const kind = field.controlKind ?? 'unknown'

  if (/(姓名|名字|name)/i.test(text) && profile.name) {
    return resumeValue(profile.name, 'contact.name', 0.95)
  }
  if (/(邮箱|邮件|email|e-mail)/i.test(text) && profile.email) {
    return resumeValue(profile.email, 'contact.email', 0.98)
  }
  if (/(手机|电话|联系电话|手机号|phone|mobile|tel)/i.test(text) && profile.phone) {
    return resumeValue(normalizePhone(profile.phone) ?? profile.phone, 'contact.phone', 0.95, 'phone:digits')
  }
  if (/(城市|所在地|居住地|当前.*地|location|city)/i.test(text) && profile.location) {
    return resumeValue(profile.location, 'contact.location', 0.85)
  }
  if (/(学历|degree|education)/i.test(text)) {
    const degree = pickHighestDegree(profile.education)
    if (degree) return derivedValue(degree, 'education.highestDegree', 0.86, 'education:highest-degree')
  }
  if (/(工作年限|经验年限|工作经验|years.*experience|experience.*years)/i.test(text)) {
    const years = deriveYearsOfExperience(profile.experience, new Date(now))
    if (years !== undefined) return derivedValue(String(years), 'experience.periods', 0.82, 'experience:years')
  }
  if (/(公司|单位|employer|company)/i.test(text) && profile.experience[0]?.company) {
    return resumeValue(profile.experience[0].company, 'experience[0].company', 0.82)
  }
  if (/(职位|岗位|职务|title|role)/i.test(text)) {
    const title = profile.experience[0]?.title ?? profile.targetRoles[0]
    if (title) return resumeValue(title, profile.experience[0]?.title ? 'experience[0].title' : 'targetRoles[0]', 0.82)
  }
  if (/(技能|技术栈|skills?|technology|technologies)/i.test(text) && profile.skills.length) {
    return resumeValue(profile.skills.slice(0, 12).join(', '), 'skills', 0.84)
  }
  if (/(项目|project)/i.test(text) && profile.projects[0]) {
    const project = profile.projects[0]
    const value = [project.name, project.role, project.summary].filter(Boolean).join(' - ')
    if (value) return resumeValue(value, 'projects[0]', 0.78)
  }
  if (/(简介|介绍|自我评价|summary|introduction|profile|bio)/i.test(text) || kind === 'textarea') {
    const value = composeSelfIntro({
      summary: profile.summary,
      skills: profile.skills,
      experience: profile.experience,
      maxLen: kind === 'textarea' ? 420 : 180,
    })
    if (value) return derivedValue(value, 'summary+skills+experience[0]', 0.78, 'compose:self-intro')
  }
  if (/(资历|级别|seniority|level)/i.test(text) && profile.seniority) {
    return resumeValue(profile.seniority, 'summary.seniority', 0.75)
  }

  return undefined
}

function profileFromStore(store: ProfileStore | undefined): PlannerProfile {
  const all = objectValue(store?.query('all').data)
  const contact = objectValue(all.contact)
  const summary = objectValue(all.summary)
  return {
    name: fieldString(objectValue(contact.name)),
    email: fieldString(objectValue(contact.email)),
    phone: fieldString(objectValue(contact.phone)),
    location: fieldString(objectValue(contact.location)),
    summary: fieldString(objectValue(summary.summary)),
    seniority: fieldString(objectValue(summary.seniority)),
    targetRoles: fieldArray(all.targetRoles),
    skills: fieldArray(all.skills),
    experience: fieldArray(all.experience) as ResumeExperience[],
    projects: fieldArray(all.projects) as ResumeProjectExperience[],
    education: fieldArray(all.education) as ResumeEducation[],
  }
}

function fieldString(value: Record<string, unknown>): string | undefined {
  return typeof value.value === 'string' && value.value.trim() ? value.value : undefined
}

function fieldArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  const object = objectValue(value)
  return Array.isArray(object.value) ? object.value : []
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function labelText(field: FormFieldState): string {
  return [
    field.label,
    field.placeholder,
    field.name,
    field.id,
    field.locatorHints?.label,
    field.locatorHints?.text,
    field.locatorHints?.placeholder,
  ].filter(Boolean).join(' ')
}

function resumeValue(value: string, sourceRef: string, confidence: number, normalization?: string): CandidateValue {
  return { value, source: 'resume', sourceRef, confidence, ...(normalization ? { normalization } : {}) }
}

function derivedValue(value: string, sourceRef: string, confidence: number, normalization: string): CandidateValue {
  return { value, source: 'derived', sourceRef, confidence, normalization }
}

function appendNormalization(left: string | undefined, right: string): string {
  return left ? `${left};${right}` : right
}

function llmPlannerSystemPrompt(): string {
  return [
    'You are a conservative job-application form field planner.',
    'Return only JSON with shape {"planned":[...]} for unresolved fields.',
    'Use resume facts and saved user answers only. Do not invent private facts.',
    'If a required field cannot be answered from the supplied data, set intendedValue to null and include needsUser.question.',
    'For each planned item include fieldKey, intendedValue, valueSource, sourceRef, confidence, and optional normalization/skipReason/needsUser.',
  ].join('\n')
}

function llmPlannerUserPrompt(input: FieldPlannerInput, unresolved: PlannedField[]): string {
  const profile = input.profileStore?.query('all').data
  const answers = input.answerStore?.all() ?? []
  const fields = unresolved.map((field) => {
    const source = input.fields.find((item) => (item.fieldKey ?? `field_${item.index}`) === field.fieldKey)
    return {
      fieldKey: field.fieldKey,
      fieldIndex: field.fieldIndex,
      label: field.label,
      controlKind: field.controlKind,
      required: field.required,
      options: source?.options,
    }
  })
  return JSON.stringify({
    task: 'Plan values for unresolved form fields.',
    constraints: [
      'Prefer resume, user_answer, or derived values.',
      'Use valueSource "derived" only when the value is directly derived from supplied resume data.',
      'Use valueSource "none" with needsUser when no supplied data supports a value.',
      'Confidence must be between 0 and 1.',
    ],
    fields,
    resumeProfile: profile,
    savedUserAnswers: answers,
  }, null, 2)
}

function parseLlmPlannedFields(payload: unknown, sourceFields: FormFieldState[]): PlannedField[] {
  const object = objectValue(payload)
  const list = Array.isArray(object.planned) ? object.planned : []
  const byKey = new Map(sourceFields.map((field) => [field.fieldKey ?? `field_${field.index}`, field]))
  const planned: PlannedField[] = []
  for (const item of list) {
    const value = objectValue(item)
    const fieldKey = typeof value.fieldKey === 'string' ? value.fieldKey : ''
    const field = byKey.get(fieldKey)
    if (!field) continue
    const intendedValue = parseIntendedValue(value.intendedValue)
    const valueSource = parseValueSource(value.valueSource)
    const confidence = clampConfidence(value.confidence)
    const needsUser = parseNeedsUser(value.needsUser)
    const label = field.label || field.placeholder || field.name || field.id || fieldKey
    const plannedField: PlannedField = {
      fieldKey,
      fieldIndex: field.index,
      label,
      controlKind: field.controlKind ?? 'unknown',
      required: field.required,
      requiredConfidence: field.requiredConfidence,
      intendedValue,
      valueSource,
      confidence,
      ...(typeof value.sourceRef === 'string' && value.sourceRef.trim() ? { sourceRef: value.sourceRef } : {}),
      ...(typeof value.normalization === 'string' && value.normalization.trim() ? { normalization: value.normalization } : {}),
      ...(typeof value.skipReason === 'string' && value.skipReason.trim() ? { skipReason: value.skipReason } : {}),
      ...(needsUser ? { needsUser } : {}),
    }
    planned.push(withOptions(field, plannedField))
  }
  return planned
}

function parseIntendedValue(value: unknown): string | string[] | null {
  if (value === null) return null
  if (typeof value === 'string') return value
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) return value
  return null
}

function parseValueSource(value: unknown): FieldValueSource {
  return value === 'resume' || value === 'user_answer' || value === 'derived' || value === 'page' || value === 'none'
    ? value
    : 'none'
}

function clampConfidence(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0
}

function parseNeedsUser(value: unknown): PlannedField['needsUser'] | undefined {
  const object = objectValue(value)
  if (typeof object.question !== 'string' || !object.question.trim()) return undefined
  return {
    question: object.question,
    ...(Array.isArray(object.options) && object.options.every((item) => typeof item === 'string')
      ? { options: object.options }
      : {}),
  }
}
