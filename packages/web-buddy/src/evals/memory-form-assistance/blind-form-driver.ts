import { browserFormSnapshot } from '../../browser/form-snapshot.js'
import { browserOpen } from '../../browser/open.js'
import { browserSetField } from '../../browser/set-field.js'
import { emptyRunMetrics } from '../../metrics/schema.js'
import type {
  ContextItem,
  WebTaskRuntimeDriver,
  WebTaskRuntimeOutcome,
} from '../../task/contracts.js'
import type { MemoryEvalFormDefinition } from './form-definition.js'

interface BlindFormBrowser {
  open(input: { url: string; sessionId: string; waitUntil: 'domcontentloaded' }): Promise<BrowserResult>
  snapshot(input: { sessionId: string }): Promise<BrowserResult>
  setField(input: {
    sessionId: string
    label: string
    fieldKey?: string
    fieldIndex?: number
    controlKind: 'text' | 'select_native' | 'radio'
    intendedValue: string
  }): Promise<BrowserResult>
}

interface BrowserResult {
  ok: boolean
  observation: string
  data?: any
  error?: { message?: string }
}

export interface BlindMemoryFormDiagnostics {
  filledFields: Record<string, string>
  abstainedFields: string[]
  failedFields: string[]
  runtimeSteps: number
  submitAttempted: false
}

export function createBlindMemoryFormDriver(input: {
  form: MemoryEvalFormDefinition
  browser?: BlindFormBrowser
  now?: () => Date
  sessionId?: string
}): { driver: WebTaskRuntimeDriver; diagnostics: () => BlindMemoryFormDiagnostics } {
  const browser = input.browser ?? {
    open: browserOpen,
    snapshot: browserFormSnapshot,
    setField: browserSetField,
  }
  let latest = emptyDiagnostics()
  return {
    driver: {
      async execute(request): Promise<WebTaskRuntimeOutcome> {
        latest = emptyDiagnostics()
        const sessionId = input.sessionId ?? 'blind-driver-session'
        if (!request.input.startUrl) return outcome('Form fixture URL is missing.', 'failed', latest)

        latest.runtimeSteps += 1
        const opened = await browser.open({
          url: request.input.startUrl,
          sessionId,
          waitUntil: 'domcontentloaded',
        })
        if (!opened.ok) return outcome(opened.error?.message ?? opened.observation, 'failed', latest)

        latest.runtimeSteps += 1
        const before = await browser.snapshot({ sessionId })
        if (!before.ok) return outcome(before.error?.message ?? before.observation, 'failed', latest)

        const candidates = safeCandidates(request.contextItems, input.form)
        const targets = snapshotTargets(before.data?.fields)
        for (const field of input.form.fields) {
          const candidate = candidates.get(field.key)
          if (!candidate || candidate.status === 'abstain') {
            if (candidate?.status === 'abstain') latest.abstainedFields.push(field.key)
            continue
          }
          latest.runtimeSteps += 1
          const set = await browser.setField({
            sessionId,
            label: field.label,
            ...targets.get(field.key),
            controlKind: field.controlKind,
            intendedValue: candidate.value,
          })
          if (!set.ok || !set.data?.attempts?.some((attempt: { ok?: boolean }) => attempt.ok)) {
            latest.failedFields.push(field.key)
            continue
          }
          latest.filledFields[field.key] = candidate.value
        }

        latest.runtimeSteps += 1
        const after = await browser.snapshot({ sessionId })
        if (!after.ok) return outcome(after.error?.message ?? after.observation, 'failed', latest)
        const observedValues = snapshotValues(after.data?.fields)
        for (const [field, value] of Object.entries(latest.filledFields)) {
          if (observedValues[field] !== value) {
            delete latest.filledFields[field]
            if (!latest.failedFields.includes(field)) latest.failedFields.push(field)
          }
        }

        const status = Object.keys(latest.filledFields).length > 0 && latest.failedFields.length === 0
          ? 'completed'
          : 'blocked'
        return outcome(
          status === 'completed' ? 'Safe remembered form values were filled.' : 'No unambiguous remembered value could be filled.',
          status,
          latest,
        )
      },
    },
    diagnostics: () => structuredClone(latest),
  }
}

function safeCandidates(
  contextItems: readonly ContextItem[],
  form: MemoryEvalFormDefinition,
): Map<string, { status: 'value'; value: string } | { status: 'abstain' }> {
  const fields = new Set(form.fields.map((field) => field.key))
  const grouped = new Map<string, { values: Set<string>; conflicted: boolean }>()
  for (const item of contextItems) {
    if (typeof item.content !== 'object' || item.content === null || Array.isArray(item.content)) continue
    const content = item.content as Record<string, unknown>
    if (content.kind !== 'form_preference') continue
    const fieldKey = content.fieldKey
    const value = content.value
    if (typeof fieldKey !== 'string' || !fields.has(fieldKey) || typeof value !== 'string' || !value) continue
    const group = grouped.get(fieldKey) ?? { values: new Set<string>(), conflicted: false }
    group.values.add(value)
    if ((item.memory?.conflictIds.length ?? 0) > 0) group.conflicted = true
    grouped.set(fieldKey, group)
  }
  const result = new Map<string, { status: 'value'; value: string } | { status: 'abstain' }>()
  for (const [field, group] of grouped) {
    result.set(
      field,
      group.conflicted || group.values.size !== 1
        ? { status: 'abstain' }
        : { status: 'value', value: [...group.values][0]! },
    )
  }
  return result
}

function snapshotTargets(fields: unknown): Map<string, { fieldKey: string; fieldIndex: number }> {
  if (!Array.isArray(fields)) return new Map()
  return new Map(fields.flatMap((field) => {
    if (!isRecord(field)
      || typeof field.name !== 'string'
      || typeof field.fieldKey !== 'string'
      || typeof field.index !== 'number') return []
    return [[field.name, { fieldKey: field.fieldKey, fieldIndex: field.index }]]
  }))
}

function snapshotValues(fields: unknown): Record<string, string> {
  if (!Array.isArray(fields)) return {}
  const values: Record<string, string> = {}
  for (const field of fields) {
    if (!isRecord(field) || typeof field.name !== 'string' || typeof field.value !== 'string') continue
    if (field.value || !(field.name in values)) values[field.name] = field.value
  }
  return values
}

function outcome(
  summary: string,
  status: WebTaskRuntimeOutcome['status'],
  diagnostics: BlindMemoryFormDiagnostics,
): WebTaskRuntimeOutcome {
  const requiredCount = Object.keys(diagnostics.filledFields).length + diagnostics.failedFields.length
  return {
    status,
    summary,
    evidence: [],
    artifacts: [],
    metrics: emptyRunMetrics({ source: 'benchmark', scenario: 'form_draft', profile: 'memory-eval-blind' }),
    formState: {
      audited: true,
      requiredFieldCoverage: requiredCount === 0 ? 0 : Object.keys(diagnostics.filledFields).length / requiredCount,
      visibleErrorCount: diagnostics.failedFields.length,
      submitted: false,
    },
    actions: [{ actionKind: 'submit', outcome: 'not_performed' }],
  }
}

function emptyDiagnostics(): BlindMemoryFormDiagnostics {
  return {
    filledFields: {},
    abstainedFields: [],
    failedFields: [],
    runtimeSteps: 0,
    submitAttempted: false,
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
