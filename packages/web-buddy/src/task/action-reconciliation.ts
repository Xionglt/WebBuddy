import {
  type ActionLedgerEntry,
  type ActionLedgerStatus,
  type ExternalActionBindingV2,
  ActionLedger,
} from './action-ledger.js'
import { digestCanonicalJson } from './contracts.js'

export type ExternalActionState = 'committed' | 'not_committed' | 'ambiguous'

const MAX_BUSINESS_KEY_LENGTH = 1_024
const MAX_PROBE_ID_LENGTH = 256
const MAX_EXTERNAL_REFERENCE_LENGTH = 512
const MAX_VERDICT_SUMMARY_LENGTH = 2_048
const MAX_EVIDENCE_ID_LENGTH = 512
const MAX_EVIDENCE_IDS = 32
const MAX_OBSERVED_AT_FUTURE_SKEW_MS = 5 * 60 * 1_000

export interface ExternalActionReconciliationVerdict {
  schemaVersion: 'external-action-reconciliation/v1'
  actionId: string
  businessKey: string
  state: ExternalActionState
  observedAt: string
  verifier: string
  independentlyObserved: boolean
  evidenceIds: string[]
  externalReference?: string
  /** Digest recomputed from authoritative read-back fields for a committed v2 action. */
  observedEffectDigest?: string
  /** Required for not_committed: the trusted adapter proved that retry cannot duplicate the effect. */
  retrySafe?: boolean
  summary: string
}

export interface ExternalActionProbeRequest {
  action: Readonly<ActionLedgerEntry>
  businessKey: string
  /** Aborted when the runtime's reconciliation deadline expires. */
  signal?: AbortSignal
}

export interface ExternalActionProbe {
  readonly schemaVersion: 'external-action-probe/v1'
  readonly id: string
  /** Recovery probes may observe external state but may never produce browser or business writes. */
  readonly authority: 'read_only'
  reconcile(request: Readonly<ExternalActionProbeRequest>): Promise<ExternalActionReconciliationVerdict>
}

export interface ExternalActionBindingRequest {
  actionId: string
  actionKind: ActionLedgerEntry['actionKind']
  toolName: string
  args: Readonly<Record<string, unknown>>
  currentUrl?: string
  /** Actual sink target when it differs from the currently displayed page. */
  destinationOrigin?: string
  /**
   * Site-normalized business effect. A generic click's selector cannot encode
   * fields such as amount or attachment version, so trusted adapters should
   * supply those stable semantics and let the Runtime canonicalize/hash them.
   */
  effectPayload?: Readonly<Record<string, unknown>>
}

export type ExternalActionBindingCandidate = Omit<ExternalActionBindingV2, 'effectDigest'> & {
  /** Stable business fields used instead of volatile/raw tool arguments. Never persisted in clear text. */
  effectPayload?: Readonly<Record<string, unknown>>
  /** Canonical origin of the real external sink when it differs from the visible page. */
  destinationOrigin?: string
  /** Optional assertion; when supplied it must equal the digest computed by the Runtime. */
  effectDigest?: string
}

export type ExternalActionBindingResolver = (
  request: Readonly<ExternalActionBindingRequest>,
) => ExternalActionBindingCandidate | undefined

export type ExternallyReconciledActionKind = Extract<
  ActionLedgerEntry['actionKind'],
  'upload' | 'send' | 'publish' | 'submit' | 'payment'
>

export interface ExternalActionIntentRequest {
  schemaVersion: 'external-action-intent-request/v1'
  actionId: string
  toolName: string
  args: Readonly<Record<string, unknown>>
  inferredActionKind?: ActionLedgerEntry['actionKind']
  currentUrl?: string
  destinationOrigin?: string
}

export interface ExternalActionIntentCandidate {
  schemaVersion: 'external-action-intent/v1'
  actionKind: ExternallyReconciledActionKind
  binding: ExternalActionBindingCandidate
}

export interface NonExternalActionIntentCandidate {
  schemaVersion: 'external-action-intent/v1'
  /** Trusted adapter attestation that this opaque control does not cross a business-effect boundary. */
  actionKind: 'non_external'
}

export type ExternalActionIntentResolution =
  | ExternalActionIntentCandidate
  | NonExternalActionIntentCandidate

/** Trusted site adapter that may upgrade an otherwise opaque browser call. */
export type ExternalActionIntentResolver = (
  request: Readonly<ExternalActionIntentRequest>,
) => ExternalActionIntentResolution | undefined

export function resolveExternalActionIntentKind(
  intent: ExternalActionIntentResolution | undefined,
  inferredActionKind: ActionLedgerEntry['actionKind'] | undefined,
): ActionLedgerEntry['actionKind'] | undefined {
  if (!intent) return inferredActionKind
  if (intent.actionKind === 'non_external') {
    if (intent.schemaVersion !== 'external-action-intent/v1'
      || Object.keys(intent).sort().join(',') !== 'actionKind,schemaVersion') {
      throw new Error('EXTERNAL_ACTION_INTENT_INVALID: site adapter returned an invalid non_external intent.')
    }
    if (inferredActionKind !== undefined) {
      throw new Error(
        `EXTERNAL_ACTION_CLASSIFICATION_CONFLICT: runtime inferred ${inferredActionKind}, adapter returned non_external.`,
      )
    }
    return undefined
  }
  if (intent.schemaVersion !== 'external-action-intent/v1'
    || !requiresDurableActionJournal(intent.actionKind)
    || !intent.binding
    || intent.binding.schemaVersion !== 'external-action-binding/v2'
    || Object.keys(intent).sort().join(',') !== 'actionKind,binding,schemaVersion') {
    throw new Error('EXTERNAL_ACTION_INTENT_INVALID: site adapter returned an invalid external action intent.')
  }
  if (inferredActionKind !== undefined && inferredActionKind !== intent.actionKind) {
    throw new Error(
      `EXTERNAL_ACTION_CLASSIFICATION_CONFLICT: runtime inferred ${inferredActionKind}, adapter returned ${intent.actionKind}.`,
    )
  }
  return intent.actionKind
}

export function bindExternalActionRequest(
  candidate: ExternalActionBindingCandidate,
  request: Readonly<ExternalActionBindingRequest>,
): ExternalActionBindingV2 {
  if (!candidate
    || candidate.schemaVersion !== 'external-action-binding/v2'
    || typeof candidate.businessKey !== 'string'
    || candidate.businessKey.trim() === ''
    || candidate.businessKey !== candidate.businessKey.trim()
    || typeof candidate.probeId !== 'string'
    || candidate.probeId.trim() === ''
    || candidate.probeId !== candidate.probeId.trim()) {
    throw new Error('External action binding candidate must be canonical external-action-binding/v2.')
  }
  const destinationOrigin = externalActionDestinationOrigin(candidate, request)
  const effectDigest = externalActionEffectDigest({
    ...request,
    ...(candidate.effectPayload !== undefined ? { effectPayload: candidate.effectPayload } : {}),
    ...(destinationOrigin ? { destinationOrigin } : {}),
  })
  if (candidate.effectDigest !== undefined && candidate.effectDigest !== effectDigest) {
    throw new Error(`External action binding effect digest does not match ${candidate.businessKey}.`)
  }
  return {
    schemaVersion: 'external-action-binding/v2',
    businessKey: candidate.businessKey,
    probeId: candidate.probeId,
    effectDigest,
  }
}

export function externalActionDestinationOrigin(
  candidate: Pick<ExternalActionBindingCandidate, 'destinationOrigin'>,
  request: Readonly<ExternalActionBindingRequest>,
): string | undefined {
  const value = candidate.destinationOrigin
    ?? request.destinationOrigin
    ?? originOrUndefined(request.currentUrl)
  if (value === undefined) return undefined
  try {
    const url = new URL(value)
    if (url.origin !== value) throw new Error('not canonical')
    return url.origin
  } catch {
    throw new Error('External action destinationOrigin must be a canonical absolute origin.')
  }
}

export function externalActionEffectDigest(
  request: Readonly<ExternalActionBindingRequest>,
): string {
  return digestCanonicalJson({
    schemaVersion: 'external-action-effect/v1',
    actionKind: request.actionKind,
    effect: request.effectPayload
      ? {
          source: 'site_adapter/v1',
          payload: request.effectPayload,
        }
      : {
          source: 'tool_arguments/v1',
          toolName: request.toolName,
          args: request.args,
        },
    destinationOrigin: request.destinationOrigin ?? originOrUndefined(request.currentUrl),
  })
}

export interface ReconcileExternalActionInput {
  ledger: ActionLedger
  actionId: string
  businessKey?: string
  probe: ExternalActionProbe
  signal?: AbortSignal
}

export interface ExternalActionReconciliationResult {
  schemaVersion: 'external-action-reconciliation-result/v1'
  verdict: ExternalActionReconciliationVerdict
  ledgerEntry: ActionLedgerEntry
  resolved: boolean
}

export interface ReconcileExternalActionWithDeadlineInput extends ReconcileExternalActionInput {
  timeoutMs: number
  timeoutMessage?: string
}

export interface ExternalActionReconciliationAttempt {
  schemaVersion: 'external-action-reconciliation-attempt/v1'
  resolved: boolean
  ledgerEntry?: ActionLedgerEntry
  verdict?: ExternalActionReconciliationVerdict
  error?: string
}

export interface InspectExternalActionWithDeadlineInput {
  /** A detached proposed action used only to bind the read-only query. */
  action: Readonly<ActionLedgerEntry>
  probe: ExternalActionProbe
  timeoutMs: number
  timeoutMessage?: string
}

export interface ExternalActionInspectionAttempt {
  schemaVersion: 'external-action-inspection-attempt/v1'
  resolved: boolean
  verdict?: ExternalActionReconciliationVerdict
  error?: string
}

export interface ExternalActionProbeBudgetInput {
  perActionTimeoutMs: number
  recoveryBudgetMs: number
  startedAtMs: number
  nowMs: number
}

/** Returns the next bounded timeout, or undefined when the whole recovery budget is exhausted. */
export function externalActionProbeTimeoutForBudget(
  input: ExternalActionProbeBudgetInput,
): number | undefined {
  if (!Number.isFinite(input.perActionTimeoutMs) || input.perActionTimeoutMs <= 0) {
    throw new Error('External action recovery perActionTimeoutMs is invalid.')
  }
  if (!Number.isFinite(input.recoveryBudgetMs) || input.recoveryBudgetMs <= 0) {
    throw new Error('External action recovery recoveryBudgetMs is invalid.')
  }
  if (!Number.isFinite(input.startedAtMs) || !Number.isFinite(input.nowMs)) {
    throw new Error('External action recovery clock is invalid.')
  }
  const remaining = input.startedAtMs + input.recoveryBudgetMs - input.nowMs
  if (remaining <= 0) return undefined
  return Math.max(1, Math.min(input.perActionTimeoutMs, remaining))
}

/**
 * Reconcile an action whose external outcome is unknown. A terminal verdict is
 * accepted only from an independent observation with evidence. The probe is a
 * site adapter (receipt lookup, business-record query, or explicit user audit),
 * never an LLM assertion.
 */
export async function reconcileExternalAction(
  input: ReconcileExternalActionInput,
): Promise<ExternalActionReconciliationResult> {
  throwIfAborted(input.signal)
  // Validate the authority boundary before inspecting action state so a
  // write-capable adapter is rejected deterministically on every call.
  assertProbeContract(input.probe)
  const currentAction = input.ledger.latest(input.actionId)
  if (!currentAction) throw new Error(`Action ${input.actionId} is missing from the ledger.`)
  if (currentAction.status !== 'proposed' && !isUnresolvedActionStatus(currentAction.status)) {
    throw new Error(`Action ${input.actionId} is not eligible for reconciliation from ${currentAction.status}.`)
  }
  const verdict = await queryExternalAction({
    action: currentAction,
    probe: input.probe,
    ...(input.businessKey ? { businessKey: input.businessKey } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
  })
  const reason = reconciliationReason(verdict)
  if (verdict.state === 'committed') {
    return result(
      verdict,
      currentAction.status === 'proposed'
        ? input.ledger.observeCommitted(currentAction.actionId, reason)
        : input.ledger.commit(currentAction.actionId, reason),
      true,
    )
  }
  if (verdict.state === 'not_committed') {
    return result(verdict, input.ledger.markNotCommitted(currentAction.actionId, reason), true)
  }
  return result(verdict, input.ledger.markAmbiguous(currentAction.actionId, reason), false)
}

/**
 * Queries authoritative state before this run is allowed to execute. It never
 * mutates a Ledger; callers must durably record any terminal observation before
 * using it as completion evidence.
 */
export async function inspectExternalActionWithDeadline(
  input: InspectExternalActionWithDeadlineInput,
): Promise<ExternalActionInspectionAttempt> {
  if (!Number.isFinite(input.timeoutMs) || input.timeoutMs <= 0) {
    throw new Error('External action probe timeout must be a positive finite number.')
  }
  if (input.action.status !== 'proposed') {
    throw new Error(`External action preflight requires proposed state, received ${input.action.status}.`)
  }
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const inspection = queryExternalAction({
      action: input.action,
      probe: input.probe,
      signal: controller.signal,
    })
    const verdict = await Promise.race([
      inspection,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error(
            input.timeoutMessage
              ?? `External action probe ${input.probe.id} timed out during preflight for ${input.action.actionId}.`,
          )
          controller.abort(error)
          reject(error)
        }, input.timeoutMs)
      }),
    ])
    return {
      schemaVersion: 'external-action-inspection-attempt/v1',
      resolved: verdict.state !== 'ambiguous',
      verdict,
    }
  } catch (error) {
    return {
      schemaVersion: 'external-action-inspection-attempt/v1',
      resolved: false,
      error: error instanceof Error ? error.message : String(error),
    }
  } finally {
    if (timer) clearTimeout(timer)
    controller.abort()
  }
}

/** Rejects adapters whose declared capability could mutate the system being reconciled. */
export function assertProbeContract(probe: ExternalActionProbe): void {
  if (!probe
    || probe.schemaVersion !== 'external-action-probe/v1'
    || probe.authority !== 'read_only'
    || typeof probe.id !== 'string'
    || probe.id.trim() === ''
    || probe.id !== probe.id.trim()
    || typeof probe.reconcile !== 'function') {
    throw new Error('External action probe must declare a canonical read_only external-action-probe/v1 contract.')
  }
}

/** Resolves exactly one registered adapter so a duplicated id cannot change recovery behavior by ordering. */
export function externalActionProbeById(
  probes: readonly ExternalActionProbe[] | undefined,
  probeId: string,
): ExternalActionProbe | undefined {
  const matches = probes?.filter((candidate) => candidate.id === probeId) ?? []
  if (matches.length > 1) {
    throw new Error(`External action probe id ${probeId} is registered more than once.`)
  }
  const probe = matches[0]
  if (probe) assertProbeContract(probe)
  return probe
}

/**
 * Runtime-safe reconciliation wrapper. It aborts at the deadline, fences late
 * probe results before ledger mutation, and conservatively records ambiguous
 * when a probe fails or times out.
 */
export async function reconcileExternalActionWithDeadline(
  input: ReconcileExternalActionWithDeadlineInput,
): Promise<ExternalActionReconciliationAttempt> {
  if (!Number.isFinite(input.timeoutMs) || input.timeoutMs <= 0) {
    throw new Error('External action probe timeout must be a positive finite number.')
  }
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const reconciliation = reconcileExternalAction({
      ledger: input.ledger,
      actionId: input.actionId,
      probe: input.probe,
      ...(input.businessKey ? { businessKey: input.businessKey } : {}),
      signal: controller.signal,
    })
    const result = await Promise.race([
      reconciliation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error(
            input.timeoutMessage
              ?? `External action probe ${input.probe.id} timed out for ${input.actionId}.`,
          )
          controller.abort(error)
          reject(error)
        }, input.timeoutMs)
      }),
    ])
    return {
      schemaVersion: 'external-action-reconciliation-attempt/v1',
      resolved: result.resolved,
      ledgerEntry: result.ledgerEntry,
      verdict: result.verdict,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const latest = input.ledger.latest(input.actionId)
    const ledgerEntry = latest
      && (latest.status === 'proposed' || isUnresolvedActionStatus(latest.status))
      ? input.ledger.markAmbiguous(
          input.actionId,
          `External reconciliation failed closed: ${message}`,
        )
      : undefined
    return {
      schemaVersion: 'external-action-reconciliation-attempt/v1',
      resolved: false,
      ...(ledgerEntry ? { ledgerEntry } : {}),
      error: message,
    }
  } finally {
    if (timer) clearTimeout(timer)
    controller.abort()
  }
}

export function unresolvedActionEntries(
  entries: readonly ActionLedgerEntry[],
): ActionLedgerEntry[] {
  const latest = new Map<string, ActionLedgerEntry>()
  for (const entry of entries) {
    // Map#set keeps the original insertion position. Delete first so a newly
    // appended ambiguous attempt moves to the tail; actions skipped when the
    // whole recovery budget expires will therefore lead the next restart.
    latest.delete(entry.actionId)
    latest.set(entry.actionId, structuredClone(entry))
  }
  return [...latest.values()].filter((entry) => (
    isUnresolvedActionStatus(entry.status)
    || (entry.status === 'proposed' && entry.externalBinding !== undefined)
  ))
}

export function isUnresolvedActionStatus(status: ActionLedgerStatus): boolean {
  return status === 'authorized'
    || status === 'executing'
    || status === 'executed'
    || status === 'failed'
    || status === 'ambiguous'
}

export function requiresDurableActionJournal(actionKind: ActionLedgerEntry['actionKind']): boolean {
  return actionKind === 'upload'
    || actionKind === 'send'
    || actionKind === 'publish'
    || actionKind === 'submit'
    || actionKind === 'payment'
}

function validateVerdict(
  value: ExternalActionReconciliationVerdict,
  action: Readonly<ActionLedgerEntry>,
  businessKey: string,
  probeId: string,
): ExternalActionReconciliationVerdict {
  if (!value || value.schemaVersion !== 'external-action-reconciliation/v1') {
    throw new Error('External action probe returned an unsupported verdict.')
  }
  const allowedKeys = new Set([
    'schemaVersion',
    'actionId',
    'businessKey',
    'state',
    'observedAt',
    'verifier',
    'independentlyObserved',
    'evidenceIds',
    'externalReference',
    'observedEffectDigest',
    'retrySafe',
    'summary',
  ])
  const unknownKeys = Object.keys(value).filter((key) => !allowedKeys.has(key))
  if (unknownKeys.length > 0) {
    throw new Error(
      `External action verdict contains unsupported field(s): ${unknownKeys.sort().join(', ')}.`,
    )
  }
  if (value.actionId !== action.actionId || value.businessKey !== businessKey) {
    throw new Error('External action verdict does not match its action/business binding.')
  }
  if (value.verifier !== probeId) {
    throw new Error(`External action verdict verifier must match probe ${probeId}.`)
  }
  if (!['committed', 'not_committed', 'ambiguous'].includes(value.state)) {
    throw new Error(`External action verdict has unsupported state: ${String(value.state)}.`)
  }
  if (typeof value.independentlyObserved !== 'boolean') {
    throw new Error('External action verdict independentlyObserved must be boolean.')
  }
  if (value.retrySafe !== undefined && typeof value.retrySafe !== 'boolean') {
    throw new Error('External action verdict retrySafe must be boolean when supplied.')
  }
  if (value.externalReference !== undefined) {
    nonEmpty(value.externalReference, 'externalReference', MAX_EXTERNAL_REFERENCE_LENGTH)
  }
  if (value.observedEffectDigest !== undefined
    && (typeof value.observedEffectDigest !== 'string'
      || !/^[a-f0-9]{64}$/i.test(value.observedEffectDigest))) {
    throw new Error('External action verdict observedEffectDigest must be a SHA-256 hex digest.')
  }
  nonEmpty(value.verifier, 'verifier', MAX_PROBE_ID_LENGTH)
  nonEmpty(value.summary, 'summary', MAX_VERDICT_SUMMARY_LENGTH)
  const observedAt = Date.parse(value.observedAt)
  if (!Number.isFinite(observedAt)) {
    throw new Error('External action verdict observedAt is invalid.')
  }
  if (new Date(observedAt).toISOString() !== value.observedAt) {
    throw new Error('External action verdict observedAt must be a canonical ISO-8601 instant.')
  }
  if (observedAt < Date.parse(action.recordedAt)) {
    throw new Error('External action verdict predates the latest durable action state.')
  }
  if (observedAt > Date.now() + MAX_OBSERVED_AT_FUTURE_SKEW_MS) {
    throw new Error('External action verdict observedAt is implausibly far in the future.')
  }
  if (!Array.isArray(value.evidenceIds)
    || value.evidenceIds.length > MAX_EVIDENCE_IDS
    || value.evidenceIds.some((id) => (
      typeof id !== 'string'
      || id.trim() === ''
      || id !== id.trim()
      || id.length > MAX_EVIDENCE_ID_LENGTH
    ))) {
    throw new Error('External action verdict evidenceIds are invalid.')
  }
  if (new Set(value.evidenceIds).size !== value.evidenceIds.length) {
    throw new Error('External action verdict evidenceIds must be unique.')
  }
  if (value.state === 'committed' && value.retrySafe !== undefined) {
    throw new Error('A committed verdict cannot carry retrySafe.')
  }
  if (value.state === 'not_committed' && value.externalReference !== undefined) {
    throw new Error('A not_committed verdict cannot carry an externalReference.')
  }
  if (value.state === 'ambiguous'
    && (value.externalReference !== undefined
      || value.retrySafe !== undefined
      || value.observedEffectDigest !== undefined)) {
    throw new Error('An ambiguous verdict cannot carry terminal outcome fields.')
  }
  if (value.state === 'not_committed' && value.observedEffectDigest !== undefined) {
    throw new Error('A not_committed verdict cannot carry an observedEffectDigest.')
  }
  if (value.state !== 'ambiguous') {
    if (!value.independentlyObserved || value.evidenceIds.length === 0) {
      throw new Error('A terminal external action verdict requires independent evidence.')
    }
    if (value.state === 'committed') {
      nonEmpty(value.externalReference, 'externalReference')
      if (action.externalBinding?.schemaVersion === 'external-action-binding/v2') {
        if (!value.observedEffectDigest) {
          throw new Error('A committed v2 verdict requires an authoritative observedEffectDigest.')
        }
        if (value.observedEffectDigest !== action.externalBinding.effectDigest) {
          throw new Error('External action verdict does not match the authorized effect digest.')
        }
      }
    }
    if (value.state === 'not_committed' && value.retrySafe !== true) {
      throw new Error('A not_committed verdict must prove that retry is safe.')
    }
  }
  return {
    schemaVersion: 'external-action-reconciliation/v1',
    actionId: value.actionId,
    businessKey: value.businessKey,
    state: value.state,
    observedAt: value.observedAt,
    verifier: value.verifier,
    independentlyObserved: value.independentlyObserved,
    evidenceIds: [...value.evidenceIds],
    ...(value.externalReference !== undefined ? { externalReference: value.externalReference } : {}),
    ...(value.observedEffectDigest !== undefined
      ? { observedEffectDigest: value.observedEffectDigest }
      : {}),
    ...(value.retrySafe !== undefined ? { retrySafe: value.retrySafe } : {}),
    summary: value.summary,
  }
}

async function queryExternalAction(input: {
  action: Readonly<ActionLedgerEntry>
  businessKey?: string
  probe: ExternalActionProbe
  signal?: AbortSignal
}): Promise<ExternalActionReconciliationVerdict> {
  throwIfAborted(input.signal)
  assertProbeContract(input.probe)
  const probeId = input.probe.id
  const action = deepFrozenExternalActionData(input.action)
  if (!action.externalBinding) {
    throw new Error(`External action ${action.actionId} has no durable business/probe binding to reconcile.`)
  }
  const businessKey = nonEmpty(
    input.businessKey ?? action.externalBinding.businessKey,
    'businessKey',
    MAX_BUSINESS_KEY_LENGTH,
  )
  if (action.externalBinding.businessKey !== businessKey) {
    throw new Error(
      `External action ${action.actionId} is bound to ${action.externalBinding.businessKey}, received ${businessKey}.`,
    )
  }
  if (action.externalBinding.probeId !== probeId) {
    throw new Error(
      `External action ${action.actionId} requires probe ${action.externalBinding.probeId}, received ${probeId}.`,
    )
  }
  const rawVerdictResult = await input.probe.reconcile(Object.freeze({
    action,
    businessKey,
    ...(input.signal ? { signal: input.signal } : {}),
  }))
  // A probe may ignore AbortSignal. Fence its late result before a caller can
  // persist or act on a result whose deadline has already expired.
  throwIfAborted(input.signal)
  return validateVerdict(
    deepFrozenExternalActionData(rawVerdictResult),
    action,
    businessKey,
    probeId,
  )
}

function reconciliationReason(verdict: ExternalActionReconciliationVerdict): string {
  return [
    `Reconciled ${verdict.businessKey} as ${verdict.state}`,
    verdict.externalReference ? `externalReference=${verdict.externalReference}` : undefined,
    verdict.state === 'not_committed' ? `retrySafe=${String(verdict.retrySafe)}` : undefined,
    `verifier=${verdict.verifier}`,
    `evidence=${verdict.evidenceIds.join(',') || 'none'}`,
    verdict.summary,
  ].filter(Boolean).join('; ')
}

function result(
  verdict: ExternalActionReconciliationVerdict,
  ledgerEntry: ActionLedgerEntry,
  resolved: boolean,
): ExternalActionReconciliationResult {
  return {
    schemaVersion: 'external-action-reconciliation-result/v1',
    verdict,
    ledgerEntry,
    resolved,
  }
}

function nonEmpty(value: string | undefined, label: string, maxLength = Number.POSITIVE_INFINITY): string {
  if (typeof value !== 'string'
    || value.trim() === ''
    || value !== value.trim()
    || value.length > maxLength) {
    throw new Error(`External action reconciliation ${label} must be non-empty.`)
  }
  return value
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error('External action reconciliation was aborted.')
  }
}

function originOrUndefined(url: string | undefined): string | undefined {
  if (!url) return undefined
  try {
    return new URL(url).origin
  } catch {
    throw new Error(`External action destination URL is invalid: ${url}`)
  }
}

function deepFrozenExternalActionData<T>(value: T): Readonly<T> {
  const cloned = structuredClone(value)
  return deepFreezeExternalActionData(cloned)
}

function deepFreezeExternalActionData<T>(value: T): Readonly<T> {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreezeExternalActionData(child)
  }
  return value
}
