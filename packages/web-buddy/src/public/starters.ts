import type {
  ContentSensitivity,
  ContextItem,
  JsonObject,
  JsonValue,
  SensitiveActionRule,
} from './contracts.js'
import type { WebTaskInput } from './task.js'
import { PublicContractError } from './task.js'

export const RESEARCH_STARTER_SCHEMA_VERSION = 'research-starter/v1' as const
export const COMPARISON_STARTER_SCHEMA_VERSION = 'comparison-starter/v1' as const
export const FORM_DRAFT_STARTER_SCHEMA_VERSION = 'form-draft-starter/v1' as const

export interface ResearchStarter {
  schemaVersion: typeof RESEARCH_STARTER_SCHEMA_VERSION
  goal: string
  startUrl: string
  runId?: string
}

export interface ComparisonOption {
  schemaVersion: 'comparison-option/v1'
  id: string
  label: string
  facts: JsonValue
}

export interface ComparisonStarter {
  schemaVersion: typeof COMPARISON_STARTER_SCHEMA_VERSION
  goal: string
  options: ComparisonOption[]
  startUrl?: string
  runId?: string
  capturedAt?: string
}

export interface FormDraftField {
  schemaVersion: 'form-draft-field/v1'
  field: string
  value: JsonValue
  sensitivity: Exclude<ContentSensitivity, 'auth' | 'secret'>
}

export interface FormDraftStarter {
  schemaVersion: typeof FORM_DRAFT_STARTER_SCHEMA_VERSION
  goal: string
  startUrl: string
  fields: FormDraftField[]
  runId?: string
  capturedAt?: string
}

export function createResearchStarter(input: ResearchStarter): WebTaskInput {
  if (input.schemaVersion !== RESEARCH_STARTER_SCHEMA_VERSION) unsupported('ResearchStarter')
  return {
    schemaVersion: 'web-task-input/v1',
    goal: {
      instruction: required(input.goal, 'goal'),
      scenario: 'research',
    },
    startUrl: httpUrl(input.startUrl),
    contract: {
      schemaVersion: 'web-task-contract/v1',
      contractId: 'starter.research.v1',
      revision: 0,
      criteria: [{
        kind: 'evidence_present',
        id: 'current-page-evidence',
        description: 'Current Main runtime page evidence is required.',
        evidenceKinds: ['page'],
        minCount: 1,
        allowedAuthorities: ['main_runtime'],
      }],
      requiredEvidence: [{
        id: 'research-source-evidence',
        kinds: ['page'],
        minCount: 1,
        allowedAuthorities: ['main_runtime'],
        origins: ['tool'],
        independentlyObserved: true,
      }],
      sensitiveActions: denyWriteActions(),
    },
    policy: denyWritePolicy(),
    ...(input.runId ? { runId: required(input.runId, 'runId') } : {}),
  }
}

export function createComparisonStarter(input: ComparisonStarter): WebTaskInput {
  if (input.schemaVersion !== COMPARISON_STARTER_SCHEMA_VERSION) unsupported('ComparisonStarter')
  if (!Array.isArray(input.options) || input.options.length < 2) {
    invalid('ComparisonStarter requires at least two options.')
  }
  const capturedAt = validTimestamp(input.capturedAt ?? new Date().toISOString())
  const contextItems = input.options.map((option, index) => comparisonContext(option, index, capturedAt))
  if (new Set(contextItems.map((item) => item.id)).size !== contextItems.length) {
    invalid('Comparison option ids must be unique.')
  }
  return {
    schemaVersion: 'web-task-input/v1',
    goal: {
      instruction: required(input.goal, 'goal'),
      scenario: 'comparison',
      metadata: { optionCount: contextItems.length },
    },
    ...(input.startUrl ? { startUrl: httpUrl(input.startUrl) } : {}),
    contextItems,
    contract: {
      schemaVersion: 'web-task-contract/v1',
      contractId: 'starter.comparison.v1',
      revision: 0,
      criteria: [{
        kind: 'artifact_present',
        id: 'comparison-report',
        description: 'A current immutable comparison report is required.',
        artifactKinds: ['comparison_report'],
        minCount: 1,
        schemaVersions: ['comparison-report/v1'],
      }],
      sensitiveActions: denyWriteActions(),
    },
    policy: denyWritePolicy(),
    ...(input.runId ? { runId: required(input.runId, 'runId') } : {}),
  }
}

export function createFormDraftStarter(input: FormDraftStarter): WebTaskInput {
  if (input.schemaVersion !== FORM_DRAFT_STARTER_SCHEMA_VERSION) unsupported('FormDraftStarter')
  if (!Array.isArray(input.fields) || input.fields.length === 0) invalid('FormDraftStarter requires fields.')
  const capturedAt = validTimestamp(input.capturedAt ?? new Date().toISOString())
  const contextItems = input.fields.map((field, index) => formFieldContext(field, index, capturedAt))
  return {
    schemaVersion: 'web-task-input/v1',
    goal: {
      instruction: required(input.goal, 'goal'),
      scenario: 'form_draft',
      metadata: { draftOnly: true },
    },
    startUrl: httpUrl(input.startUrl),
    contextItems,
    contract: {
      schemaVersion: 'web-task-contract/v1',
      contractId: 'starter.form-draft.v1',
      revision: 0,
      criteria: [
        {
          kind: 'form_state',
          id: 'draft-complete',
          description: 'Audit and prepare the form without submitting it.',
          requireFullAudit: true,
          requiredFieldCoverage: 1,
          allowVisibleErrors: false,
          requireDraftOnly: true,
        },
        {
          kind: 'action_boundary',
          id: 'submit-not-performed',
          description: 'Final submit must not be performed.',
          actionKinds: ['submit'],
          outcome: 'not_performed',
        },
      ],
      sensitiveActions: denyWriteActions(),
    },
    policy: denyWritePolicy(),
    ...(input.runId ? { runId: required(input.runId, 'runId') } : {}),
  }
}

function comparisonContext(optionValue: ComparisonOption, index: number, capturedAt: string): ContextItem {
  if (!optionValue || optionValue.schemaVersion !== 'comparison-option/v1') unsupported(`ComparisonOption[${index}]`)
  const id = required(optionValue.id, `options[${index}].id`)
  return userContext({
    id: `comparison.${id}`,
    kind: 'comparison_option',
    content: {
      id,
      label: required(optionValue.label, `options[${index}].label`),
      facts: json(optionValue.facts, `options[${index}].facts`),
    },
    sensitivity: 'public',
    capturedAt,
  })
}

function formFieldContext(fieldValue: FormDraftField, index: number, capturedAt: string): ContextItem {
  if (!fieldValue || fieldValue.schemaVersion !== 'form-draft-field/v1') unsupported(`FormDraftField[${index}]`)
  if (!['public', 'internal', 'personal'].includes(fieldValue.sensitivity)) {
    invalid('Form draft fields cannot contain auth or secret values.')
  }
  const field = required(fieldValue.field, `fields[${index}].field`)
  return userContext({
    id: `form-field.${index}.${field}`,
    kind: 'form_field_value',
    content: {
      field,
      value: json(fieldValue.value, `fields[${index}].value`),
    },
    sensitivity: fieldValue.sensitivity,
    capturedAt,
  })
}

function userContext(input: {
  id: string
  kind: string
  content: JsonObject
  sensitivity: Exclude<ContentSensitivity, 'auth' | 'secret'>
  capturedAt: string
}): ContextItem {
  return {
    schemaVersion: 'context-item/v1',
    id: input.id,
    kind: input.kind,
    content: input.content,
    origin: 'user',
    trust: 'user_authorized',
    instructionAuthority: 'advisory',
    sensitivity: input.sensitivity,
    provenance: {
      capturedAt: input.capturedAt,
      parentContentIds: [],
    },
    allowedUses: ['prompt', 'artifact', 'subagent', 'sink'],
    freshness: {
      validity: 'current',
      revision: 0,
    },
    retention: {
      scope: 'run',
      deleteWithSession: true,
    },
    sanitization: {
      policyId: 'starter-user-context/v1',
      status: 'unchanged',
      redactedFields: [],
      instructionNeutralized: false,
      transformedFrom: [],
    },
    integrity: {
      immutable: true,
      digestVerified: true,
    },
  }
}

function denyWritePolicy() {
  return {
    schemaVersion: 'task-policy/v1' as const,
    defaultSensitiveAction: 'deny' as const,
    rules: denyWriteActions(),
  }
}

function denyWriteActions(): SensitiveActionRule[] {
  return [{
    id: 'starter-deny-write-actions',
    actionKinds: ['upload', 'send', 'publish', 'submit', 'payment', 'memory_write', 'permission_write'],
    decision: 'deny',
    requireApprovalBinding: true,
  }]
}

function required(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() !== value || value.length === 0) invalid(`${label} is required.`)
  return value
}

function httpUrl(value: unknown): string {
  const raw = required(value, 'startUrl')
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    invalid('startUrl must be an absolute HTTP(S) URL.')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') invalid('startUrl must use HTTP(S).')
  return parsed.toString()
}

function validTimestamp(value: string): string {
  if (!Number.isFinite(Date.parse(value))) invalid('capturedAt must be a timestamp.')
  return value
}

function json(value: unknown, label: string): JsonValue {
  try {
    const serialized = JSON.stringify(value)
    if (serialized === undefined) invalid(`${label} must be JSON-safe.`)
    return JSON.parse(serialized) as JsonValue
  } catch {
    invalid(`${label} must be JSON-safe.`)
  }
}

function invalid(message: string): never {
  throw new PublicContractError('INVALID_CONTRACT', message)
}

function unsupported(label: string): never {
  throw new PublicContractError('UNSUPPORTED_SCHEMA_VERSION', `${label} schema version is not supported.`)
}
