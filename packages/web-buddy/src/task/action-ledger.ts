import type { ActionOutcome, SensitiveActionKind } from './contracts.js'

export type ActionLedgerStatus =
  | 'proposed'
  | 'authorized'
  | 'denied'
  | 'performed'
  | 'failed'
  | 'skipped'

export interface ActionLedgerEntry {
  schemaVersion: 'action-ledger-entry/v1'
  sequence: number
  actionId: string
  actionKind: SensitiveActionKind
  toolName: string
  status: ActionLedgerStatus
  recordedAt: string
  reason?: string
}

export interface ActionLedgerRecordInput {
  actionId: string
  actionKind: SensitiveActionKind
  toolName: string
  reason?: string
}

/**
 * Runtime-owned audit ledger for sensitive actions. Completion outcomes are
 * projected only from observed proposals, authorization and execution—not
 * copied from the Completion Contract.
 */
export class ActionLedger {
  readonly #entries: ActionLedgerEntry[] = []
  readonly #now: () => Date

  constructor(now: () => Date = () => new Date()) {
    this.#now = now
  }

  static restore(
    entries: readonly ActionLedgerEntry[],
    now: () => Date = () => new Date(),
  ): ActionLedger {
    const ledger = new ActionLedger(now)
    const statuses = new Map<string, ActionLedgerStatus>()
    for (const [index, raw] of entries.entries()) {
      if (raw.schemaVersion !== 'action-ledger-entry/v1'
        || raw.sequence !== index + 1
        || !raw.actionId
        || !raw.toolName
        || !Number.isFinite(Date.parse(raw.recordedAt))) {
        throw new Error(`Invalid restored action ledger entry at sequence ${index + 1}.`)
      }
      const previous = statuses.get(raw.actionId)
      if (!validRestoredTransition(previous, raw.status)) {
        throw new Error(
          `Invalid restored action ledger transition for ${raw.actionId}: ${previous ?? 'none'} -> ${raw.status}.`,
        )
      }
      ledger.#entries.push(structuredClone(raw))
      statuses.set(raw.actionId, raw.status)
    }
    return ledger
  }

  propose(input: ActionLedgerRecordInput): ActionLedgerEntry {
    if (this.#entries.some((entry) => entry.actionId === input.actionId)) {
      throw new Error(`Action ${input.actionId} is already present in the ledger.`)
    }
    return this.#append(input, 'proposed')
  }

  authorize(actionId: string, reason?: string): ActionLedgerEntry {
    return this.#transition(actionId, 'authorized', ['proposed'], reason)
  }

  deny(actionId: string, reason?: string): ActionLedgerEntry {
    return this.#transition(actionId, 'denied', ['proposed', 'authorized'], reason)
  }

  perform(actionId: string, reason?: string): ActionLedgerEntry {
    return this.#transition(actionId, 'performed', ['authorized'], reason)
  }

  fail(actionId: string, reason?: string): ActionLedgerEntry {
    return this.#transition(actionId, 'failed', ['authorized'], reason)
  }

  skip(actionId: string, reason?: string): ActionLedgerEntry {
    return this.#transition(actionId, 'skipped', ['proposed', 'authorized'], reason)
  }

  snapshot(): readonly ActionLedgerEntry[] {
    return structuredClone(this.#entries)
  }

  latest(actionId: string): ActionLedgerEntry | undefined {
    for (let index = this.#entries.length - 1; index >= 0; index -= 1) {
      const entry = this.#entries[index]
      if (entry?.actionId === actionId) return structuredClone(entry)
    }
    return undefined
  }

  outcomes(monitoredKinds: readonly SensitiveActionKind[]): ActionOutcome[] {
    const outcomes: ActionOutcome[] = []
    for (const actionKind of [...new Set(monitoredKinds)]) {
      const entries = this.#entries.filter((entry) => entry.actionKind === actionKind)
      const performed = entries.filter((entry) => entry.status === 'performed')
      const authorized = [...new Map(
        entries
          .filter((entry) => entry.status === 'authorized' || entry.status === 'performed')
          .map((entry) => [entry.actionId, entry]),
      ).values()]
      if (performed.length === 0) outcomes.push({ actionKind, outcome: 'not_performed' })
      outcomes.push(...authorized.map((entry) => ({
        actionKind,
        outcome: 'approved' as const,
        actionId: entry.actionId,
      })))
      outcomes.push(...performed.map((entry) => ({
        actionKind,
        outcome: 'performed' as const,
        actionId: entry.actionId,
      })))
    }
    return outcomes
  }

  #transition(
    actionId: string,
    status: Exclude<ActionLedgerStatus, 'proposed'>,
    allowedPrevious: readonly ActionLedgerStatus[],
    reason?: string,
  ): ActionLedgerEntry {
    let previous: ActionLedgerEntry | undefined
    for (let index = this.#entries.length - 1; index >= 0; index -= 1) {
      const candidate = this.#entries[index]
      if (candidate?.actionId === actionId) {
        previous = candidate
        break
      }
    }
    if (!previous) throw new Error(`Action ${actionId} is missing from the ledger.`)
    if (!allowedPrevious.includes(previous.status)) {
      throw new Error(`Action ${actionId} cannot transition from ${previous.status} to ${status}.`)
    }
    return this.#append(previous, status, reason)
  }

  #append(
    input: Pick<ActionLedgerEntry, 'actionId' | 'actionKind' | 'toolName'>,
    status: ActionLedgerStatus,
    reason?: string,
  ): ActionLedgerEntry {
    const entry: ActionLedgerEntry = {
      schemaVersion: 'action-ledger-entry/v1',
      sequence: this.#entries.length + 1,
      actionId: input.actionId,
      actionKind: input.actionKind,
      toolName: input.toolName,
      status,
      recordedAt: this.#now().toISOString(),
      ...(reason ? { reason } : {}),
    }
    this.#entries.push(entry)
    return structuredClone(entry)
  }
}

function validRestoredTransition(
  previous: ActionLedgerStatus | undefined,
  next: ActionLedgerStatus,
): boolean {
  if (!previous) return next === 'proposed'
  if (next === 'authorized') return previous === 'proposed'
  if (next === 'denied') return previous === 'proposed' || previous === 'authorized'
  if (next === 'performed' || next === 'failed') return previous === 'authorized'
  if (next === 'skipped') return previous === 'proposed' || previous === 'authorized'
  return false
}
