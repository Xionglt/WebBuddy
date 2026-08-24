import type { ActionOutcome, SensitiveActionKind } from './contracts.js'

export type ActionLedgerStatus =
  | 'proposed'
  | 'authorized'
  | 'executing'
  | 'executed'
  | 'denied'
  | 'committed'
  | 'not_committed'
  | 'ambiguous'
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
  externalBinding?: ExternalActionBinding
  actionDecision?: ActionDecisionRef
}

export interface ActionDecisionRef {
  schemaVersion: 'action-decision-ref/v1'
  source: 'task_policy' | 'human_gate'
  /** Approval id or exact policy rule id that authorized this attempt. */
  decisionRef: string
  /** Digest of the exact sink ActionBinding when one exists. */
  actionBindingSha256?: string
}

export interface ExternalActionBindingV1 {
  schemaVersion: 'external-action-binding/v1'
  /** Stable scoped identifier, for example portal:tenant-a:invoice:INV-CN-260601. */
  businessKey: string
  /** Identifies the deterministic site adapter that can query authoritative state. */
  probeId: string
}

export interface ExternalActionBindingV2 {
  schemaVersion: 'external-action-binding/v2'
  /** Stable scoped identifier, for example portal:tenant-a:invoice:INV-CN-260601. */
  businessKey: string
  /** Identifies the deterministic site adapter that can query authoritative state. */
  probeId: string
  /** Runtime-owned digest of action kind, canonical business effect (or tool-argument fallback) and sink origin. */
  effectDigest: string
}

export type ExternalActionBinding = ExternalActionBindingV1 | ExternalActionBindingV2

export interface ActionLedgerRecordInput {
  actionId: string
  actionKind: SensitiveActionKind
  toolName: string
  reason?: string
  externalBinding?: ExternalActionBinding
}

const ACTION_LEDGER_STATUSES = new Set<ActionLedgerStatus>([
  'proposed',
  'authorized',
  'executing',
  'executed',
  'denied',
  'committed',
  'not_committed',
  'ambiguous',
  'performed',
  'failed',
  'skipped',
])

const SENSITIVE_ACTION_KINDS = new Set<SensitiveActionKind>([
  'navigate',
  'type_or_paste',
  'upload',
  'send',
  'publish',
  'submit',
  'payment',
  'memory_write',
  'permission_write',
])

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
    const identities = new Map<string, Pick<ActionLedgerEntry, 'actionKind' | 'toolName' | 'externalBinding'>>()
    const logicalStatuses = new Map<
      string,
      Pick<ActionLedgerEntry, 'actionId' | 'actionKind' | 'status'> & { effectDigest: string | undefined }
    >()
    let previousRecordedAtMs = Number.NEGATIVE_INFINITY
    for (const [index, raw] of entries.entries()) {
      const recordedAtMs = typeof raw.recordedAt === 'string' ? Date.parse(raw.recordedAt) : Number.NaN
      if (raw.schemaVersion !== 'action-ledger-entry/v1'
        || !exactKeys(raw, [
          'schemaVersion',
          'sequence',
          'actionId',
          'actionKind',
          'toolName',
          'status',
          'recordedAt',
          ...(raw.reason === undefined ? [] : ['reason']),
          ...(raw.externalBinding === undefined ? [] : ['externalBinding']),
          ...(raw.actionDecision === undefined ? [] : ['actionDecision']),
        ])
        || !Number.isSafeInteger(raw.sequence)
        || raw.sequence !== index + 1
        || typeof raw.actionId !== 'string'
        || raw.actionId.trim().length === 0
        || raw.actionId !== raw.actionId.trim()
        || typeof raw.toolName !== 'string'
        || raw.toolName.trim().length === 0
        || raw.toolName !== raw.toolName.trim()
        || (raw.reason !== undefined && typeof raw.reason !== 'string')
        || !ACTION_LEDGER_STATUSES.has(raw.status)
        || !SENSITIVE_ACTION_KINDS.has(raw.actionKind)
        || !validExternalBinding(raw.externalBinding)
        || !validActionDecisionRef(raw.actionDecision)
        || !Number.isFinite(recordedAtMs)
        || new Date(recordedAtMs).toISOString() !== raw.recordedAt
        || recordedAtMs < previousRecordedAtMs) {
        throw new Error(`Invalid restored action ledger entry at sequence ${index + 1}.`)
      }
      previousRecordedAtMs = recordedAtMs
      if (raw.externalBinding && raw.status === 'performed') {
        throw new Error(
          `Restored external action ${raw.actionId} cannot use legacy performed; reconciliation must produce committed.`,
        )
      }
      const identity = identities.get(raw.actionId)
      if (identity && !sameActionIdentity(identity, raw)) {
        throw new Error(`Restored action ledger identity changed for ${raw.actionId}.`)
      }
      const previous = statuses.get(raw.actionId)
      let previousEntry: ActionLedgerEntry | undefined
      for (let entryIndex = ledger.#entries.length - 1; entryIndex >= 0; entryIndex -= 1) {
        const candidate = ledger.#entries[entryIndex]
        if (candidate?.actionId === raw.actionId) {
          previousEntry = candidate
          break
        }
      }
      if (previousEntry
        && !(previousEntry.status === 'proposed' && raw.status === 'authorized')
        && !sameActionDecision(previousEntry.actionDecision, raw.actionDecision)) {
        throw new Error(`Restored action authorization changed for ${raw.actionId}.`)
      }
      if (!previous && raw.actionDecision !== undefined) {
        throw new Error(`Restored proposed action ${raw.actionId} cannot already be authorized.`)
      }
      const logicalKey = raw.externalBinding ? logicalActionKey(raw) : undefined
      const previousLogical = logicalKey ? logicalStatuses.get(logicalKey) : undefined
      if (!previous
        && raw.status === 'proposed'
        && previousLogical
        && previousLogical.actionKind !== raw.actionKind) {
        throw new Error(`Restored logical external action ${logicalKey} changed its action kind.`)
      }
      if (!previous
        && raw.status === 'proposed'
        && previousLogical
        && previousLogical.effectDigest !== effectDigestFor(raw.externalBinding)) {
        throw new Error(`Restored logical external action ${logicalKey} changed its effect digest.`)
      }
      if (!previous
        && raw.status === 'proposed'
        && previousLogical
        && (previousLogical.status === 'proposed'
          || previousLogical.status === 'committed'
          || previousLogical.status === 'performed'
          || unresolvedExternalActionStatus(previousLogical.status))) {
        throw new Error(
          `Restored logical external action ${logicalKey} was reproposed from ${previousLogical.status}.`,
        )
      }
      if (!validRestoredTransition(previous, raw.status)) {
        throw new Error(
          `Invalid restored action ledger transition for ${raw.actionId}: ${previous ?? 'none'} -> ${raw.status}.`,
        )
      }
      ledger.#entries.push(structuredClone(raw))
      statuses.set(raw.actionId, raw.status)
      if (logicalKey) {
        logicalStatuses.set(logicalKey, {
          actionId: raw.actionId,
          actionKind: raw.actionKind,
          status: raw.status,
          effectDigest: effectDigestFor(raw.externalBinding),
        })
      }
      identities.set(raw.actionId, {
        actionKind: raw.actionKind,
        toolName: raw.toolName,
        ...(raw.externalBinding ? { externalBinding: structuredClone(raw.externalBinding) } : {}),
      })
    }
    return ledger
  }

  propose(input: ActionLedgerRecordInput): ActionLedgerEntry {
    if (this.#entries.some((entry) => entry.actionId === input.actionId)) {
      throw new Error(`Action ${input.actionId} is already present in the ledger.`)
    }
    if (!validExternalBinding(input.externalBinding)) {
      throw new Error(`Action ${input.actionId} has an invalid external reconciliation binding.`)
    }
    if (input.externalBinding?.schemaVersion === 'external-action-binding/v1') {
      throw new Error('Legacy external-action-binding/v1 may be restored but cannot be proposed for a new action.')
    }
    if (input.externalBinding) {
      const existing = this.latestExternalAction(input.externalBinding.businessKey)
      if (existing && existing.actionKind !== input.actionKind) {
        throw new Error(
          `Logical external action ${input.externalBinding.businessKey} changed its action kind.`,
        )
      }
      if (existing
        && effectDigestFor(existing.externalBinding) !== effectDigestFor(input.externalBinding)) {
        throw new Error(
          `Logical external action ${input.externalBinding.businessKey} changed its effect digest.`,
        )
      }
      if (existing && (existing.status === 'proposed'
        || existing.status === 'committed'
        || existing.status === 'performed'
        || unresolvedExternalActionStatus(existing.status))) {
        throw new Error(
          `Logical external action ${input.externalBinding.businessKey} cannot be reproposed from ${existing.status}.`,
        )
      }
    }
    return this.#append(input, 'proposed')
  }

  authorize(
    actionId: string,
    reason?: string,
    actionDecision?: ActionDecisionRef,
  ): ActionLedgerEntry {
    if (!validActionDecisionRef(actionDecision)) {
      throw new Error(`Action ${actionId} has an invalid authorization reference.`)
    }
    return this.#transition(actionId, 'authorized', ['proposed'], reason, actionDecision)
  }

  /**
   * Records the execution boundary before a tool is allowed to produce an
   * external effect. This entry must be persisted before invoking an
   * irreversible browser action.
   */
  begin(actionId: string, reason?: string): ActionLedgerEntry {
    return this.#transition(actionId, 'executing', ['authorized'], reason)
  }

  /** The local tool returned, but the external business outcome is not yet proven. */
  markExecuted(actionId: string, reason?: string): ActionLedgerEntry {
    return this.#transition(actionId, 'executed', ['executing'], reason)
  }

  deny(actionId: string, reason?: string): ActionLedgerEntry {
    return this.#transition(actionId, 'denied', ['proposed', 'authorized'], reason)
  }

  perform(actionId: string, reason?: string): ActionLedgerEntry {
    if (this.latest(actionId)?.externalBinding) {
      throw new Error(
        `External action ${actionId} cannot use legacy performed; reconciliation must produce committed.`,
      )
    }
    return this.#transition(actionId, 'performed', ['authorized', 'executing'], reason)
  }

  fail(actionId: string, reason?: string): ActionLedgerEntry {
    return this.#transition(actionId, 'failed', ['authorized', 'executing'], reason)
  }

  skip(actionId: string, reason?: string): ActionLedgerEntry {
    return this.#transition(actionId, 'skipped', ['proposed', 'authorized'], reason)
  }

  commit(actionId: string, reason?: string): ActionLedgerEntry {
    return this.#transition(actionId, 'committed', ['authorized', 'executing', 'executed', 'failed', 'ambiguous'], reason)
  }

  /**
   * Records an effect found by a read-only preflight before this run obtained
   * execution authority. This is business-state evidence, not an assertion
   * that the current run performed or approved the external write.
   */
  observeCommitted(actionId: string, reason?: string): ActionLedgerEntry {
    return this.#transition(actionId, 'committed', ['proposed'], reason)
  }

  markNotCommitted(actionId: string, reason?: string): ActionLedgerEntry {
    return this.#transition(
      actionId,
      'not_committed',
      ['proposed', 'authorized', 'executing', 'executed', 'failed', 'ambiguous'],
      reason,
    )
  }

  markAmbiguous(actionId: string, reason?: string): ActionLedgerEntry {
    return this.#transition(
      actionId,
      'ambiguous',
      ['proposed', 'authorized', 'executing', 'executed', 'failed', 'ambiguous'],
      reason,
    )
  }

  /** Fails closed when a pre-execution authoritative query cannot decide. */
  markPreflightAmbiguous(actionId: string, reason?: string): ActionLedgerEntry {
    return this.#transition(actionId, 'ambiguous', ['proposed'], reason)
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

  latestExternalAction(businessKey: string): ActionLedgerEntry | undefined {
    for (let index = this.#entries.length - 1; index >= 0; index -= 1) {
      const entry = this.#entries[index]
      if (entry?.externalBinding?.businessKey === businessKey) {
        return structuredClone(entry)
      }
    }
    return undefined
  }

  outcomes(monitoredKinds: readonly SensitiveActionKind[]): ActionOutcome[] {
    const outcomes: ActionOutcome[] = []
    for (const actionKind of [...new Set(monitoredKinds)]) {
      const entries = this.#entries.filter((entry) => entry.actionKind === actionKind)
      const latestByAction = new Map<string, ActionLedgerEntry>()
      for (const entry of entries) latestByAction.set(entry.actionId, entry)
      const latestByLogicalAction = new Map<string, ActionLedgerEntry>()
      for (const entry of latestByAction.values()) {
        latestByLogicalAction.set(logicalActionKey(entry), entry)
      }
      const latest = [...latestByLogicalAction.values()]
      const performed = latest.filter((entry) => entry.status === 'performed' || entry.status === 'committed')
      const notPerformed = latest.filter((entry) => entry.status === 'not_committed')
      const indeterminate = latest.filter((entry) => (
        entry.status === 'authorized'
        || entry.status === 'executing'
        || entry.status === 'executed'
        || entry.status === 'failed'
        || entry.status === 'ambiguous'
      ))
      const authorizedActionIds = new Set(
        entries.filter((entry) => entry.status === 'authorized').map((entry) => entry.actionId),
      )
      const locallyAttemptedActionIds = new Set(
        entries
          .filter((entry) => (
            entry.status === 'executing'
            || entry.status === 'executed'
            || entry.status === 'performed'
          ))
          .map((entry) => entry.actionId),
      )
      const authorized = latest.filter((entry) => authorizedActionIds.has(entry.actionId))
      if (performed.length === 0 && indeterminate.length === 0) {
        outcomes.push({ actionKind, outcome: 'not_performed' })
      }
      outcomes.push(...authorized.map((entry) => ({
        actionKind,
        outcome: 'approved' as const,
        actionId: entry.actionId,
        localExecutionAttempted: locallyAttemptedActionIds.has(entry.actionId),
        ...(entry.externalBinding ? { businessKey: entry.externalBinding.businessKey } : {}),
      })))
      outcomes.push(...performed.map((entry) => ({
        actionKind,
        outcome: 'performed' as const,
        actionId: entry.actionId,
        localExecutionAttempted: locallyAttemptedActionIds.has(entry.actionId),
        ...(entry.externalBinding ? { businessKey: entry.externalBinding.businessKey } : {}),
      })))
      outcomes.push(...notPerformed.map((entry) => ({
        actionKind,
        outcome: 'not_performed' as const,
        actionId: entry.actionId,
        localExecutionAttempted: locallyAttemptedActionIds.has(entry.actionId),
        ...(entry.externalBinding ? { businessKey: entry.externalBinding.businessKey } : {}),
      })))
      outcomes.push(...indeterminate.map((entry) => ({
        actionKind,
        outcome: 'indeterminate' as const,
        actionId: entry.actionId,
        localExecutionAttempted: locallyAttemptedActionIds.has(entry.actionId),
        ...(entry.externalBinding ? { businessKey: entry.externalBinding.businessKey } : {}),
      })))
    }
    return outcomes
  }

  #transition(
    actionId: string,
    status: Exclude<ActionLedgerStatus, 'proposed'>,
    allowedPrevious: readonly ActionLedgerStatus[],
    reason?: string,
    actionDecision?: ActionDecisionRef,
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
    return this.#append(
      { ...previous, ...(actionDecision ? { actionDecision: structuredClone(actionDecision) } : {}) },
      status,
      reason,
    )
  }

  #append(
    input: Pick<ActionLedgerEntry, 'actionId' | 'actionKind' | 'toolName' | 'externalBinding' | 'actionDecision'>,
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
      recordedAt: this.#recordedAt(),
      ...(reason ? { reason } : {}),
      ...(input.externalBinding ? { externalBinding: structuredClone(input.externalBinding) } : {}),
      ...(input.actionDecision ? { actionDecision: structuredClone(input.actionDecision) } : {}),
    }
    this.#entries.push(entry)
    return structuredClone(entry)
  }

  #recordedAt(): string {
    const nowMs = this.#now().getTime()
    if (!Number.isFinite(nowMs)) throw new Error('ActionLedger clock returned an invalid instant.')
    const previous = this.#entries.at(-1)
    const previousMs = previous ? Date.parse(previous.recordedAt) : Number.NEGATIVE_INFINITY
    return new Date(Math.max(nowMs, previousMs)).toISOString()
  }
}

function validRestoredTransition(
  previous: ActionLedgerStatus | undefined,
  next: ActionLedgerStatus,
): boolean {
  if (!previous) return next === 'proposed'
  if (next === 'authorized') return previous === 'proposed'
  if (next === 'executing') return previous === 'authorized'
  if (next === 'executed') return previous === 'executing'
  if (next === 'denied') return previous === 'proposed' || previous === 'authorized'
  if (next === 'performed' || next === 'failed') return previous === 'authorized' || previous === 'executing'
  if (next === 'skipped') return previous === 'proposed' || previous === 'authorized'
  if (next === 'committed') {
    return previous === 'proposed'
      || previous === 'authorized'
      || previous === 'executing'
      || previous === 'executed'
      || previous === 'failed'
      || previous === 'ambiguous'
  }
  if (next === 'not_committed') {
    return previous === 'proposed'
      || previous === 'authorized'
      || previous === 'executing'
      || previous === 'executed'
      || previous === 'failed'
      || previous === 'ambiguous'
  }
  if (next === 'ambiguous') {
    return previous === 'proposed'
      || previous === 'authorized'
      || previous === 'executing'
      || previous === 'executed'
      || previous === 'failed'
      || previous === 'ambiguous'
  }
  return false
}

function validExternalBinding(binding: ExternalActionBinding | undefined): boolean {
  if (binding === undefined) return true
  const common = typeof binding.businessKey === 'string'
    && binding.businessKey.trim().length > 0
    && binding.businessKey === binding.businessKey.trim()
    && binding.businessKey.length <= 1_024
    && typeof binding.probeId === 'string'
    && binding.probeId.trim().length > 0
    && binding.probeId === binding.probeId.trim()
    && binding.probeId.length <= 256
  if (!common) return false
  if (binding.schemaVersion === 'external-action-binding/v1') {
    return exactKeys(binding, ['schemaVersion', 'businessKey', 'probeId'])
  }
  return binding.schemaVersion === 'external-action-binding/v2'
    && typeof binding.effectDigest === 'string'
    && /^[a-f0-9]{64}$/i.test(binding.effectDigest)
    && exactKeys(binding, ['schemaVersion', 'businessKey', 'probeId', 'effectDigest'])
}

function sameActionIdentity(
  expected: Pick<ActionLedgerEntry, 'actionKind' | 'toolName' | 'externalBinding'>,
  actual: Pick<ActionLedgerEntry, 'actionKind' | 'toolName' | 'externalBinding'>,
): boolean {
  return expected.actionKind === actual.actionKind
    && expected.toolName === actual.toolName
    && expected.externalBinding?.businessKey === actual.externalBinding?.businessKey
    && expected.externalBinding?.probeId === actual.externalBinding?.probeId
    && effectDigestFor(expected.externalBinding) === effectDigestFor(actual.externalBinding)
    && expected.externalBinding?.schemaVersion === actual.externalBinding?.schemaVersion
}

function effectDigestFor(binding: ExternalActionBinding | undefined): string | undefined {
  return binding?.schemaVersion === 'external-action-binding/v2' ? binding.effectDigest : undefined
}

function validActionDecisionRef(value: ActionDecisionRef | undefined): boolean {
  return value === undefined || (
    value.schemaVersion === 'action-decision-ref/v1'
    && (value.source === 'task_policy' || value.source === 'human_gate')
    && typeof value.decisionRef === 'string'
    && value.decisionRef.trim().length > 0
    && value.decisionRef === value.decisionRef.trim()
    && (value.actionBindingSha256 === undefined
      || (typeof value.actionBindingSha256 === 'string'
        && /^[a-f0-9]{64}$/i.test(value.actionBindingSha256)))
    && exactKeys(value, [
      'schemaVersion',
      'source',
      'decisionRef',
      ...(value.actionBindingSha256 === undefined ? [] : ['actionBindingSha256']),
    ])
  )
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index])
}

function sameActionDecision(
  left: ActionDecisionRef | undefined,
  right: ActionDecisionRef | undefined,
): boolean {
  return left?.schemaVersion === right?.schemaVersion
    && left?.source === right?.source
    && left?.decisionRef === right?.decisionRef
    && left?.actionBindingSha256 === right?.actionBindingSha256
}

function logicalActionKey(entry: ActionLedgerEntry): string {
  return entry.externalBinding
    ? `external:business:${entry.externalBinding.businessKey}`
    : `${entry.actionKind}:action:${entry.actionId}`
}

function unresolvedExternalActionStatus(status: ActionLedgerStatus): boolean {
  return status === 'authorized'
    || status === 'executing'
    || status === 'executed'
    || status === 'failed'
    || status === 'ambiguous'
}
