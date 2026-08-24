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
export const AUTOPILOT_STARTER_SCHEMA_VERSION = 'autopilot-starter/v1' as const

export interface ResearchStarter {
  schemaVersion: typeof RESEARCH_STARTER_SCHEMA_VERSION
  goal: string
  startUrl: string
  /** Exact HTTP(S) origins the read-only researcher may navigate to. Defaults to the start URL origin. */
  allowedNavigationOrigins?: string[]
  runId?: string
}

export interface AutopilotStarter {
  schemaVersion: typeof AUTOPILOT_STARTER_SCHEMA_VERSION
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
  /** Exact HTTP(S) origins the read-only comparison task may navigate to. Defaults to the start URL origin. */
  allowedNavigationOrigins?: string[]
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
  const startUrl = httpUrl(input.startUrl)
  const sensitiveActions = readOnlyActions(startUrl, input.allowedNavigationOrigins)
  return {
    schemaVersion: 'web-task-input/v1',
    goal: {
      instruction: required(input.goal, 'goal'),
      scenario: 'research',
    },
    startUrl,
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
        origins: ['web'],
        independentlyObserved: true,
      }],
      sensitiveActions,
    },
    policy: readOnlyPolicy(startUrl, input.allowedNavigationOrigins),
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
  const startUrl = input.startUrl ? httpUrl(input.startUrl) : undefined
  const sensitiveActions = readOnlyActions(startUrl, input.allowedNavigationOrigins)
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
    ...(startUrl ? { startUrl } : {}),
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
      sensitiveActions,
    },
    policy: readOnlyPolicy(startUrl, input.allowedNavigationOrigins),
    ...(input.runId ? { runId: required(input.runId, 'runId') } : {}),
  }
}

export function createFormDraftStarter(input: FormDraftStarter): WebTaskInput {
  if (input.schemaVersion !== FORM_DRAFT_STARTER_SCHEMA_VERSION) unsupported('FormDraftStarter')
  if (!Array.isArray(input.fields) || input.fields.length === 0) invalid('FormDraftStarter requires fields.')
  const capturedAt = validTimestamp(input.capturedAt ?? new Date().toISOString())
  const contextItems = input.fields.map((field, index) => formFieldContext(field, index, capturedAt))
  const startUrl = httpUrl(input.startUrl)
  const sensitiveActions = formDraftActions(new URL(startUrl).origin)
  return {
    schemaVersion: 'web-task-input/v1',
    goal: {
      instruction: required(input.goal, 'goal'),
      scenario: 'form_draft',
      metadata: { draftOnly: true },
    },
    startUrl,
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
      sensitiveActions,
    },
    policy: {
      schemaVersion: 'task-policy/v1',
      defaultSensitiveAction: 'deny',
      rules: sensitiveActions,
    },
    ...(input.runId ? { runId: required(input.runId, 'runId') } : {}),
  }
}

/**
 * Maximum-effect autopilot task. Unlike the other starters, this does NOT inject
 * any deny-write rules: sensitive actions default to `ask`, which the runtime
 * auto-allows for every non-final high-risk action when the process runs with
 * `PERMISSION_MODE=autopilot` and `HUMAN_GATE_MODE=auto`. Only the truly
 * irreversible boundaries (final submit, payment, upload, login, captcha) stay
 * gated, because the runtime keeps those as hard invariants.
 *
 * Use this when you want the agent to drive the task end-to-end for a demo or a
 * personal run and stop being interrupted for ordinary browser writes.
 */
export function createAutopilotStarter(input: AutopilotStarter): WebTaskInput {
  if (input.schemaVersion !== AUTOPILOT_STARTER_SCHEMA_VERSION) unsupported('AutopilotStarter')
  return {
    schemaVersion: 'web-task-input/v1',
    goal: {
      instruction: required(input.goal, 'goal'),
      scenario: 'autopilot',
    },
    startUrl: httpUrl(input.startUrl),
    contract: {
      schemaVersion: 'web-task-contract/v1',
      contractId: 'starter.autopilot.v1',
      revision: 0,
      criteria: [{
        kind: 'evidence_present',
        id: 'current-page-evidence',
        description: 'At least one current Main runtime page evidence is required.',
        evidenceKinds: ['page'],
        minCount: 1,
        allowedAuthorities: ['main_runtime'],
      }],
    },
    policy: {
      schemaVersion: 'task-policy/v1',
      defaultSensitiveAction: 'ask',
      rules: [],
    },
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

function readOnlyPolicy(startUrl?: string, allowedNavigationOrigins?: readonly string[]) {
  return {
    schemaVersion: 'task-policy/v1' as const,
    defaultSensitiveAction: 'deny' as const,
    rules: readOnlyActions(startUrl, allowedNavigationOrigins),
  }
}

function readOnlyActions(startUrl?: string, allowedNavigationOrigins?: readonly string[]): SensitiveActionRule[] {
  if (!startUrl) {
    if (allowedNavigationOrigins && allowedNavigationOrigins.length > 0) {
      invalid('allowedNavigationOrigins requires startUrl.')
    }
    return denyWriteActions()
  }
  const origins = navigationOrigins(startUrl, allowedNavigationOrigins)
  return [
    {
      id: 'starter-allow-read-only-navigation',
      actionKinds: ['navigate'],
      decision: 'allow',
      destinationOrigins: origins,
      requireApprovalBinding: false,
    },
    ...denyWriteActions(),
  ]
}

function navigationOrigins(startUrl: string, values?: readonly string[]): string[] {
  const candidates = values === undefined ? [new URL(startUrl).origin] : values
  if (candidates.length === 0) invalid('allowedNavigationOrigins must not be empty when supplied.')
  const origins = candidates.map((value, index) => httpOrigin(value, `allowedNavigationOrigins[${index}]`))
  return [...new Set(origins)]
}

function httpOrigin(value: unknown, label: string): string {
  const raw = required(value, label)
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    invalid(`${label} must be an absolute HTTP(S) origin.`)
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.origin !== raw) {
    invalid(`${label} must be an exact HTTP(S) origin without credentials, path, query, or fragment.`)
  }
  return parsed.origin
}

function denyWriteActions(): SensitiveActionRule[] {
  return [{
    id: 'starter-deny-write-actions',
    actionKinds: ['upload', 'send', 'publish', 'submit', 'payment', 'memory_write', 'permission_write'],
    decision: 'deny',
    requireApprovalBinding: true,
  }]
}

function formDraftActions(destinationOrigin: string): SensitiveActionRule[] {
  return [
    {
      id: 'starter-confirm-form-fill',
      actionKinds: ['type_or_paste'],
      decision: 'ask',
      sourceSensitivities: ['public', 'internal', 'personal'],
      destinationOrigins: [destinationOrigin],
      requireApprovalBinding: true,
    },
    ...denyWriteActions(),
  ]
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
