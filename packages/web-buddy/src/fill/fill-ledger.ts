import type { FieldKey } from '../observation/form-state.js'
import type { FieldPlan, FieldValueSource, PlannedField } from './field-plan.js'

export type FillLedgerEntryStatus =
  | 'planned'
  | 'filled_unverified'
  | 'verified'
  | 'failed'
  | 'skipped'
  | 'needs_user'

export interface FillLedgerEntry {
  schemaVersion: 'fill-ledger-entry/v1'
  fieldKey: FieldKey
  fieldIndex: number
  label: string
  intendedValue: string | string[] | null
  status: FillLedgerEntryStatus
  attempts: number
  source?: FieldValueSource
  required?: boolean
  requiredConfidence?: number
  lastError?: string
  updatedAt: string
}

export interface FillLedgerSummary {
  schemaVersion: 'fill-ledger-summary/v1'
  total: number
  verified: number
  failed: number
  needsUser: number
  skipped: number
  pendingRequired: number
  updatedAt: string
}

export interface FillLedgerSnapshot {
  schemaVersion: 'fill-ledger/v1'
  entries: FillLedgerEntry[]
  summary: FillLedgerSummary
  updatedAt: string
}

export interface FillLedger {
  upsert(entry: Partial<FillLedgerEntry> & { fieldKey: FieldKey; fieldIndex: number }): void
  snapshot(): FillLedgerSnapshot
  summary(): FillLedgerSummary
}

export class InMemoryFillLedger implements FillLedger {
  private readonly entries = new Map<string, FillLedgerEntry>()
  private updatedAt: string

  constructor(input: { fieldPlan?: FieldPlan; summary?: FillLedgerSummary; now?: string } = {}) {
    this.updatedAt = input.summary?.updatedAt ?? input.now ?? new Date().toISOString()
    if (input.fieldPlan) this.seedFromPlan(input.fieldPlan)
  }

  upsert(entry: Partial<FillLedgerEntry> & { fieldKey: FieldKey; fieldIndex: number }): void {
    const now = entry.updatedAt ?? new Date().toISOString()
    const key = ledgerKey(entry.fieldKey, entry.fieldIndex)
    const previous = this.entries.get(key)
    const status = entry.status ?? previous?.status ?? 'planned'
    const next: FillLedgerEntry = {
      schemaVersion: 'fill-ledger-entry/v1',
      fieldKey: entry.fieldKey,
      fieldIndex: entry.fieldIndex,
      label: entry.label ?? previous?.label ?? entry.fieldKey,
      intendedValue: entry.intendedValue !== undefined ? entry.intendedValue : previous?.intendedValue ?? null,
      status,
      attempts: entry.attempts ?? nextAttempts(previous, status),
      ...(entry.source ?? previous?.source ? { source: entry.source ?? previous?.source } : {}),
      ...(entry.required !== undefined || previous?.required !== undefined ? { required: entry.required ?? previous?.required } : {}),
      ...(entry.requiredConfidence !== undefined || previous?.requiredConfidence !== undefined
        ? { requiredConfidence: entry.requiredConfidence ?? previous?.requiredConfidence }
        : {}),
      ...(entry.lastError !== undefined
        ? { lastError: entry.lastError }
        : previous?.lastError && status === previous.status
          ? { lastError: previous.lastError }
          : {}),
      updatedAt: now,
    }
    this.entries.set(key, next)
    this.updatedAt = now
  }

  snapshot(): FillLedgerSnapshot {
    return {
      schemaVersion: 'fill-ledger/v1',
      entries: this.sortedEntries(),
      summary: this.summary(),
      updatedAt: this.updatedAt,
    }
  }

  summary(): FillLedgerSummary {
    const entries = this.sortedEntries()
    const pendingRequired = entries.filter((entry) => (
      entry.required === true &&
      entry.status !== 'verified' &&
      entry.status !== 'skipped'
    )).length
    return {
      schemaVersion: 'fill-ledger-summary/v1',
      total: entries.length,
      verified: entries.filter((entry) => entry.status === 'verified').length,
      failed: entries.filter((entry) => entry.status === 'failed').length,
      needsUser: entries.filter((entry) => entry.status === 'needs_user').length,
      skipped: entries.filter((entry) => entry.status === 'skipped').length,
      pendingRequired,
      updatedAt: this.updatedAt,
    }
  }

  private seedFromPlan(plan: FieldPlan): void {
    for (const field of plan.planned) {
      this.upsert(entryFromPlannedField(field, plan.updatedAt))
    }
  }

  private sortedEntries(): FillLedgerEntry[] {
    return [...this.entries.values()].sort((a, b) => a.fieldIndex - b.fieldIndex || a.fieldKey.localeCompare(b.fieldKey))
  }
}

export function createFillLedger(input: { fieldPlan?: FieldPlan; summary?: FillLedgerSummary; now?: string } = {}): FillLedger {
  return new InMemoryFillLedger(input)
}

function entryFromPlannedField(field: PlannedField, updatedAt: string): FillLedgerEntry {
  return {
    schemaVersion: 'fill-ledger-entry/v1',
    fieldKey: field.fieldKey,
    fieldIndex: field.fieldIndex,
    label: field.label,
    intendedValue: field.intendedValue,
    status: plannedStatus(field),
    attempts: 0,
    source: field.valueSource,
    ...(field.required !== undefined ? { required: field.required } : {}),
    ...(field.requiredConfidence !== undefined ? { requiredConfidence: field.requiredConfidence } : {}),
    ...(field.skipReason ? { lastError: field.skipReason } : {}),
    updatedAt,
  }
}

function plannedStatus(field: PlannedField): FillLedgerEntryStatus {
  if (field.needsUser) return 'needs_user'
  if (field.skipReason) return 'skipped'
  return 'planned'
}

function ledgerKey(fieldKey: FieldKey, fieldIndex: number): string {
  return `${fieldIndex}:${fieldKey}`
}

function nextAttempts(previous: FillLedgerEntry | undefined, status: FillLedgerEntryStatus): number {
  const attempts = previous?.attempts ?? 0
  if (status === 'filled_unverified' || status === 'verified' || status === 'failed') return attempts + 1
  return attempts
}
