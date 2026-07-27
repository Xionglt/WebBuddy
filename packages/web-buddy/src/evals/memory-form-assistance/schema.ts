import type { ContentOrigin, ContentSensitivity, ContentTrust } from '../../task/contracts.js'
import {
  MEMORY_EVAL_FORM_DEFINITION,
  type MemoryEvalFormDefinition,
} from './form-definition.js'

export const MEMORY_FORM_ASSISTANCE_SUITE_SCHEMA_VERSION =
  'memory-form-assistance-suite/v1' as const
export const MEMORY_FORM_ASSISTANCE_CASE_SCHEMA_VERSION =
  'memory-form-assistance-case/v1' as const

export type MemoryEvalCategory =
  | 'fact_update'
  | 'preference_conflict'
  | 'expired'
  | 'fuzzy_recall'
  | 'pollution'

export interface MemoryEvalPreferenceContent {
  kind: 'form_preference'
  fieldKey: string
  value: string
  statement: string
}

export interface MemoryEvalWriteSource {
  origin: ContentOrigin
  trust: ContentTrust
  sensitivity: ContentSensitivity
}

interface MemoryEvalWriteBase {
  content: MemoryEvalPreferenceContent
  source: MemoryEvalWriteSource
  expectedStatus: 'created' | 'updated' | 'policy_denied'
  ttlMs?: number
  expiresAt?: string
  supersedes?: string[]
  conflicts?: string[]
}

export interface MemoryEvalCreateStep extends MemoryEvalWriteBase {
  operation: 'create'
  alias: string
}

export interface MemoryEvalUpdateStep extends MemoryEvalWriteBase {
  operation: 'update'
  entryAlias: string
  contentVersionAlias: string
}

export type MemoryEvalWriteStep = MemoryEvalCreateStep | MemoryEvalUpdateStep

export interface MemoryFormAssistanceCase {
  schemaVersion: typeof MEMORY_FORM_ASSISTANCE_CASE_SCHEMA_VERSION
  id: string
  category: MemoryEvalCategory
  clock: { writeAt: string; runAt: string }
  writes: MemoryEvalWriteStep[]
  goal: { instruction: string; scenario: 'form_draft' }
  form: MemoryEvalFormDefinition
  expected: {
    fields: Record<string, string>
    abstainFields: string[]
    forbiddenValues: Record<string, string[]>
    targetWriteAlias: string
  }
  oracleSentinel?: string
}

export interface MemoryFormAssistanceSuite {
  schemaVersion: typeof MEMORY_FORM_ASSISTANCE_SUITE_SCHEMA_VERSION
  cases: MemoryFormAssistanceCase[]
}

const CATEGORIES: MemoryEvalCategory[] = [
  'fact_update',
  'preference_conflict',
  'expired',
  'fuzzy_recall',
  'pollution',
]
const CASE_KEYS = new Set([
  'schemaVersion', 'id', 'category', 'clock', 'writes', 'goal', 'form', 'expected', 'oracleSentinel',
])
const CREATE_KEYS = new Set([
  'operation', 'alias', 'content', 'source', 'expectedStatus', 'ttlMs', 'expiresAt', 'supersedes', 'conflicts',
])
const UPDATE_KEYS = new Set([
  'operation', 'entryAlias', 'contentVersionAlias', 'content', 'source', 'expectedStatus', 'ttlMs', 'expiresAt', 'supersedes', 'conflicts',
])
const ORIGINS = new Set<ContentOrigin>([
  'system', 'user', 'web', 'tool', 'download', 'artifact', 'memory', 'subagent', 'derived',
])
const TRUSTS = new Set<ContentTrust>([
  'trusted_runtime', 'user_authorized', 'untrusted_external', 'derived_untrusted', 'non_authoritative',
])
const SENSITIVITIES = new Set<ContentSensitivity>([
  'public', 'internal', 'personal', 'auth', 'secret',
])

export function assertMemoryFormAssistanceSuite(
  value: unknown,
): asserts value is MemoryFormAssistanceSuite {
  const suite = closedObject(value, new Set(['schemaVersion', 'cases']), 'suite')
  if (suite.schemaVersion !== MEMORY_FORM_ASSISTANCE_SUITE_SCHEMA_VERSION) {
    throw new Error(`Unsupported memory form assistance suite schema: ${String(suite.schemaVersion)}`)
  }
  if (!Array.isArray(suite.cases)) throw new Error('Memory form assistance suite cases must be an array.')

  const ids = new Set<string>()
  const counts = new Map<MemoryEvalCategory, number>(CATEGORIES.map((category) => [category, 0]))
  for (const candidate of suite.cases) {
    const evalCase = validateCase(candidate)
    if (ids.has(evalCase.id)) throw new Error(`Duplicate memory form assistance case id: ${evalCase.id}`)
    ids.add(evalCase.id)
    counts.set(evalCase.category, (counts.get(evalCase.category) ?? 0) + 1)
  }
  for (const category of CATEGORIES) {
    if (counts.get(category) !== 2) {
      throw new Error(`Memory form assistance suite requires exactly 2 ${category} cases.`)
    }
  }
}

export function memoryEvalKeywordOverlap(instruction: string, content: unknown): string[] {
  const terms = instruction.toLowerCase().split(/\s+/).filter(Boolean)
  const targetText = JSON.stringify(content).toLowerCase()
  return terms.filter((term) => targetText.includes(term))
}

function validateCase(value: unknown): MemoryFormAssistanceCase {
  const evalCase = closedObject(value, CASE_KEYS, 'case')
  if (evalCase.schemaVersion !== MEMORY_FORM_ASSISTANCE_CASE_SCHEMA_VERSION) {
    throw new Error(`Unsupported memory form assistance case schema: ${String(evalCase.schemaVersion)}`)
  }
  const id = requiredString(evalCase.id, 'case id')
  if (!CATEGORIES.includes(evalCase.category as MemoryEvalCategory)) {
    throw new Error(`${id}: unsupported category ${String(evalCase.category)}`)
  }
  const category = evalCase.category as MemoryEvalCategory
  const clock = validateClock(evalCase.clock, id)
  const form = validateForm(evalCase.form, id)
  const fieldKeys = new Set(form.fields.map((field) => field.key))
  const writes = validateWrites(evalCase.writes, fieldKeys, id)
  const goal = validateGoal(evalCase.goal, id)
  const expected = validateExpected(evalCase.expected, fieldKeys, writes.aliases, id)
  const target = writes.steps.find((step) => (
    ('alias' in step && step.alias === expected.targetWriteAlias)
    || ('contentVersionAlias' in step && step.contentVersionAlias === expected.targetWriteAlias)
  ))!
  const overlap = memoryEvalKeywordOverlap(goal.instruction, target.content)
  if (category === 'fuzzy_recall') {
    if (overlap.length > 0) throw new Error(`${id}: fuzzy case has keyword overlap: ${overlap.join(', ')}`)
    const query = goal.instruction.toLowerCase()
    for (const fragment of [target.content.fieldKey, target.content.value, target.content.statement]) {
      if (query.includes(fragment.toLowerCase())) {
        throw new Error(`${id}: fuzzy query contains target content fragment: ${fragment}`)
      }
    }
  } else if (category !== 'pollution' && overlap.length === 0) {
    throw new Error(`${id}: ${category} case requires stable keyword overlap.`)
  }
  if (category === 'pollution') validatePollutionCase(writes.steps, id)
  if (evalCase.oracleSentinel !== undefined) requiredString(evalCase.oracleSentinel, `${id}.oracleSentinel`)
  return {
    schemaVersion: MEMORY_FORM_ASSISTANCE_CASE_SCHEMA_VERSION,
    id,
    category,
    clock,
    writes: writes.steps,
    goal,
    form,
    expected,
    ...(evalCase.oracleSentinel === undefined ? {} : { oracleSentinel: String(evalCase.oracleSentinel) }),
  }
}

function validateClock(value: unknown, caseId: string): MemoryFormAssistanceCase['clock'] {
  const clock = closedObject(value, new Set(['writeAt', 'runAt']), `${caseId}.clock`)
  const writeAt = utcTimestamp(clock.writeAt, `${caseId}.clock.writeAt`)
  const runAt = utcTimestamp(clock.runAt, `${caseId}.clock.runAt`)
  if (Date.parse(runAt) < Date.parse(writeAt)) throw new Error(`${caseId}: runAt must not precede writeAt.`)
  return { writeAt, runAt }
}

function validateForm(value: unknown, caseId: string): MemoryEvalFormDefinition {
  const form = closedObject(value, new Set(['fields']), `${caseId}.form`)
  if (!Array.isArray(form.fields) || form.fields.length !== 5) {
    throw new Error(`${caseId}: form must contain exactly five fields.`)
  }
  const keys = new Set<string>()
  const fields = form.fields.map((candidate, index) => {
    const field = closedObject(
      candidate,
      new Set(['key', 'label', 'controlKind', 'required']),
      `${caseId}.form.fields[${index}]`,
    )
    const key = requiredString(field.key, `${caseId}.form.fields[${index}].key`)
    if (keys.has(key)) throw new Error(`${caseId}: duplicate form field key ${key}`)
    keys.add(key)
    if (!['text', 'select_native', 'radio'].includes(String(field.controlKind))) {
      throw new Error(`${caseId}: unsupported form control ${String(field.controlKind)}`)
    }
    if (typeof field.required !== 'boolean') throw new Error(`${caseId}: form required must be boolean.`)
    return {
      key,
      label: requiredString(field.label, `${caseId}.form.fields[${index}].label`),
      controlKind: field.controlKind as 'text' | 'select_native' | 'radio',
      required: field.required,
    }
  })
  if (JSON.stringify(fields) !== JSON.stringify(MEMORY_EVAL_FORM_DEFINITION.fields)) {
    throw new Error(`${caseId}: form must match the fixed fixture definition.`)
  }
  return { fields }
}

function validateWrites(
  value: unknown,
  fieldKeys: ReadonlySet<string>,
  caseId: string,
): { steps: MemoryEvalWriteStep[]; aliases: Set<string> } {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${caseId}: writes must be non-empty.`)
  const aliases = new Set<string>()
  const createAliases = new Set<string>()
  const steps = value.map((candidate, index): MemoryEvalWriteStep => {
    if (!isRecord(candidate)) throw new Error(`${caseId}.writes[${index}] must be an object.`)
    const operation = candidate.operation
    if (operation !== 'create' && operation !== 'update') {
      throw new Error(`${caseId}.writes[${index}]: unsupported operation ${String(operation)}`)
    }
    const step = closedObject(candidate, operation === 'create' ? CREATE_KEYS : UPDATE_KEYS, `${caseId}.writes[${index}]`)
    const alias = operation === 'create'
      ? requiredString(step.alias, `${caseId}.writes[${index}].alias`)
      : requiredString(step.contentVersionAlias, `${caseId}.writes[${index}].contentVersionAlias`)
    if (aliases.has(alias)) throw new Error(`${caseId}: duplicate write alias ${alias}`)
    if (operation === 'update') {
      const entryAlias = requiredString(step.entryAlias, `${caseId}.writes[${index}].entryAlias`)
      if (!createAliases.has(entryAlias)) throw new Error(`${caseId}: update entryAlias is missing: ${entryAlias}`)
    }
    validateReferences(step.supersedes, aliases, `${caseId}.writes[${index}].supersedes`)
    validateReferences(step.conflicts, aliases, `${caseId}.writes[${index}].conflicts`)
    const content = validateContent(step.content, fieldKeys, `${caseId}.writes[${index}].content`)
    const source = validateSource(step.source, `${caseId}.writes[${index}].source`)
    const expectedStatus = validateExpectedStatus(
      step.expectedStatus,
      operation,
      `${caseId}.writes[${index}].expectedStatus`,
    )
    const ttlMs = step.ttlMs === undefined
      ? undefined
      : boundedInteger(step.ttlMs, `${caseId}.writes[${index}].ttlMs`, 1, 366 * 24 * 60 * 60 * 1000)
    const expiresAt = step.expiresAt === undefined
      ? undefined
      : utcTimestamp(step.expiresAt, `${caseId}.writes[${index}].expiresAt`)
    if (ttlMs !== undefined && expiresAt !== undefined) {
      throw new Error(`${caseId}.writes[${index}]: ttlMs and expiresAt are mutually exclusive.`)
    }
    aliases.add(alias)
    if (operation === 'create') createAliases.add(alias)
    const base = {
      content,
      source,
      expectedStatus,
      ...(ttlMs === undefined ? {} : { ttlMs }),
      ...(expiresAt ? { expiresAt } : {}),
      ...(step.supersedes === undefined ? {} : { supersedes: [...step.supersedes as string[]] }),
      ...(step.conflicts === undefined ? {} : { conflicts: [...step.conflicts as string[]] }),
    }
    return operation === 'create'
      ? { operation, alias, ...base }
      : {
          operation,
          entryAlias: String(step.entryAlias),
          contentVersionAlias: alias,
          ...base,
        }
  })
  return { steps, aliases }
}

function validateExpectedStatus(
  value: unknown,
  operation: MemoryEvalWriteStep['operation'],
  label: string,
): MemoryEvalWriteStep['expectedStatus'] {
  const allowed = operation === 'create'
    ? new Set(['created', 'policy_denied'])
    : new Set(['updated', 'policy_denied'])
  if (typeof value !== 'string' || !allowed.has(value)) {
    throw new Error(`${label} is invalid for ${operation}.`)
  }
  return value as MemoryEvalWriteStep['expectedStatus']
}

function validateContent(
  value: unknown,
  fieldKeys: ReadonlySet<string>,
  label: string,
): MemoryEvalPreferenceContent {
  const content = closedObject(value, new Set(['kind', 'fieldKey', 'value', 'statement']), label)
  if (content.kind !== 'form_preference') throw new Error(`${label}.kind must be form_preference.`)
  const fieldKey = requiredString(content.fieldKey, `${label}.fieldKey`)
  if (!fieldKeys.has(fieldKey)) throw new Error(`${fieldKey} is not a form field.`)
  return {
    kind: 'form_preference',
    fieldKey,
    value: requiredString(content.value, `${label}.value`),
    statement: requiredString(content.statement, `${label}.statement`),
  }
}

function validateSource(value: unknown, label: string): MemoryEvalWriteSource {
  const source = closedObject(value, new Set(['origin', 'trust', 'sensitivity']), label)
  if (!ORIGINS.has(source.origin as ContentOrigin)) throw new Error(`${label}.origin is invalid.`)
  if (!TRUSTS.has(source.trust as ContentTrust)) throw new Error(`${label}.trust is invalid.`)
  if (!SENSITIVITIES.has(source.sensitivity as ContentSensitivity)) throw new Error(`${label}.sensitivity is invalid.`)
  return source as unknown as MemoryEvalWriteSource
}

function validateGoal(value: unknown, caseId: string): MemoryFormAssistanceCase['goal'] {
  const goal = closedObject(value, new Set(['instruction', 'scenario']), `${caseId}.goal`)
  if (goal.scenario !== 'form_draft') throw new Error(`${caseId}: goal scenario must be form_draft.`)
  return { instruction: requiredString(goal.instruction, `${caseId}.goal.instruction`), scenario: 'form_draft' }
}

function validateExpected(
  value: unknown,
  fieldKeys: ReadonlySet<string>,
  aliases: ReadonlySet<string>,
  caseId: string,
): MemoryFormAssistanceCase['expected'] {
  const expected = closedObject(
    value,
    new Set(['fields', 'abstainFields', 'forbiddenValues', 'targetWriteAlias']),
    `${caseId}.expected`,
  )
  const fields = stringRecord(expected.fields, `${caseId}.expected.fields`)
  const forbiddenValues = stringArrayRecord(expected.forbiddenValues, `${caseId}.expected.forbiddenValues`)
  const abstainFields = stringArray(expected.abstainFields, `${caseId}.expected.abstainFields`)
  for (const key of [...Object.keys(fields), ...Object.keys(forbiddenValues), ...abstainFields]) {
    if (!fieldKeys.has(key)) throw new Error(`${key} is not a form field.`)
  }
  const targetWriteAlias = requiredString(expected.targetWriteAlias, `${caseId}.expected.targetWriteAlias`)
  if (!aliases.has(targetWriteAlias)) throw new Error(`${caseId}: targetWriteAlias is missing: ${targetWriteAlias}`)
  return { fields, abstainFields, forbiddenValues, targetWriteAlias }
}

function validatePollutionCase(steps: readonly MemoryEvalWriteStep[], caseId: string): void {
  if (steps.length !== 1 || !['web', 'tool'].includes(steps[0].source.origin)
    || steps[0].source.trust !== 'untrusted_external'
    || steps[0].expectedStatus !== 'policy_denied') {
    throw new Error(`${caseId}: pollution case must contain one policy_denied untrusted web/tool write.`)
  }
}

function validateReferences(value: unknown, aliases: ReadonlySet<string>, label: string): void {
  if (value === undefined) return
  for (const alias of stringArray(value, label)) {
    if (!aliases.has(alias)) throw new Error(`${label} references missing alias ${alias}`)
  }
}

function stringRecord(value: unknown, label: string): Record<string, string> {
  const record = closedObject(value, undefined, label)
  return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, requiredString(item, `${label}.${key}`)]))
}

function stringArrayRecord(value: unknown, label: string): Record<string, string[]> {
  const record = closedObject(value, undefined, label)
  return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, stringArray(item, `${label}.${key}`)]))
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`)
  const result = value.map((item, index) => requiredString(item, `${label}[${index}]`))
  if (new Set(result).size !== result.length) throw new Error(`${label} contains duplicates.`)
  return result
}

function utcTimestamp(value: unknown, label: string): string {
  const timestamp = requiredString(value, label)
  const parsed = new Date(timestamp)
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== timestamp) {
    throw new Error(`${label} must be a canonical UTC timestamp.`)
  }
  return timestamp
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a non-empty string.`)
  return value
}

function boundedInteger(value: unknown, label: string, min: number, max: number): number {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    throw new Error(`${label} must be an integer between ${min} and ${max}.`)
  }
  return value as number
}

function closedObject(
  value: unknown,
  allowed: ReadonlySet<string> | undefined,
  label: string,
): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be an object.`)
  if (allowed) {
    for (const key of Object.keys(value)) {
      if (!allowed.has(key)) throw new Error(`${label} has unknown field ${key}.`)
    }
  }
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
