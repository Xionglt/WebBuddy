import type {
  DurableToolResultStore,
  ToolResultArtifactRef,
  ToolResultStore,
} from '../tools/tool-result-store.js'
import type { ArtifactRef } from './contracts.js'
import type { ActionLedgerEntry } from './action-ledger.js'
import type { ExternalActionReconciliationVerdict } from './action-reconciliation.js'

export interface MaterializeExternalActionReceiptInput {
  store: ToolResultStore
  runId: string
  revision: number
  sessionId: string
  action: ActionLedgerEntry
  verdict: ExternalActionReconciliationVerdict
}

export interface MaterializedExternalActionReceipt {
  artifact: ArtifactRef
  /** Internal durable locator used to re-read and hash-check the immutable payload on recovery. */
  storageRef: ToolResultArtifactRef
}

export interface VerifyExternalActionReceiptInput {
  store: ToolResultStore
  artifact: ArtifactRef
  storageRef: ToolResultArtifactRef
  sessionId: string
  action: ActionLedgerEntry
  verdict: ExternalActionReconciliationVerdict
}

export interface PersistExternalActionReconciliationAttemptInput {
  store: ToolResultStore
  runId: string
  revision: number
  sessionId: string
  action: ActionLedgerEntry
  verdict?: ExternalActionReconciliationVerdict
  /** Must append/fsync the terminal ledger event together with any returned receipt refs. */
  persistLedgerEvent(
    receipt: MaterializedExternalActionReceipt | undefined,
  ): Promise<void>
}

/** Writes the authoritative receipt before its committed ledger event is fsynced. */
export async function materializeExternalActionReceipt(
  input: MaterializeExternalActionReceiptInput,
): Promise<MaterializedExternalActionReceipt> {
  if (input.action.status !== 'committed'
    || input.verdict.state !== 'committed'
    || input.verdict.actionId !== input.action.actionId
    || input.verdict.businessKey !== input.action.externalBinding?.businessKey
    || input.verdict.verifier !== input.action.externalBinding?.probeId
    || !input.verdict.independentlyObserved
    || input.verdict.evidenceIds.length === 0
    || !input.verdict.externalReference
    || (input.action.externalBinding?.schemaVersion === 'external-action-binding/v2'
      && input.verdict.observedEffectDigest !== input.action.externalBinding.effectDigest)) {
    throw new Error('External action receipt requires an independently verified committed action/verdict binding.')
  }
  if (!isDurableStore(input.store)) {
    throw new Error(
      'EXTERNAL_ACTION_RECEIPT_DURABILITY_REQUIRED: receipt storage must provide writeDurably().',
    )
  }
  const stored = await input.store.writeDurably({
    runId: input.runId,
    sessionId: input.sessionId,
    toolCallId: input.action.actionId,
    toolName: 'external_action_reconciliation',
    kind: 'generic_json',
    content: {
      schemaVersion: 'external-action-receipt/v1',
      actionId: input.action.actionId,
      actionKind: input.action.actionKind,
      businessKey: input.verdict.businessKey,
      externalReference: input.verdict.externalReference,
      ...(input.verdict.observedEffectDigest
        ? { observedEffectDigest: input.verdict.observedEffectDigest }
        : {}),
      observedAt: input.verdict.observedAt,
      verifier: input.verdict.verifier,
      probeEvidenceIds: input.verdict.evidenceIds,
      summary: input.verdict.summary,
    },
    mediaType: 'application/json',
    sensitivity: 'internal',
    retention: { scope: 'run', deleteWithSession: true },
    summary: `External receipt ${input.verdict.externalReference} for ${input.verdict.businessKey}.`,
  })
  const receipt: MaterializedExternalActionReceipt = {
    artifact: {
      schemaVersion: 'artifact-ref/v1',
      id: stored.artifactId,
      kind: 'external_action_receipt',
      payloadSchemaVersion: 'external-action-receipt/v1',
      mediaType: stored.mediaType,
      byteLength: stored.bytes,
      sha256: stored.sha256,
      createdAt: stored.createdAt,
      immutable: true,
      locator: `artifact:${stored.artifactId}`,
      producer: { id: 'external-action-reconciliation', version: '1' },
      parentEvidenceIds: [],
      parentArtifactIds: [],
      origin: 'tool',
      trust: 'trusted_runtime',
      sensitivity: stored.sensitivity,
      retention: { scope: 'run', deleteWithSession: true },
      binding: {
        runId: input.runId,
        revision: input.revision,
        actionSeq: input.action.sequence,
        externalBusinessKey: input.verdict.businessKey,
      },
      requiresMainWorkflowVerification: false,
      authoritativeCompletionEvidence: true,
      redaction: {
        status: stored.redaction?.status === 'redacted'
          ? 'redacted'
          : stored.redaction?.status === 'contains_sensitive'
            ? 'rejected'
            : 'not_required',
        policyId: 'runtime-persistence-boundary/v1',
      },
      scanner: { status: 'not_scanned', scannerId: 'not-configured' },
    },
    storageRef: stored,
  }
  // Completion may run in the same process without a restart. Re-read the
  // physical payload now so a sanitizer/custom store cannot return a valid hash
  // for semantically altered receipt fields and become authoritative until the
  // next restore notices.
  await verifyExternalActionReceipt({
    store: input.store,
    artifact: receipt.artifact,
    storageRef: receipt.storageRef,
    sessionId: input.sessionId,
    action: input.action,
    verdict: input.verdict,
  })
  return receipt
}

/**
 * Owns the receipt-first/event-second durability order for every Runtime path.
 * If receipt storage fails, no terminal event callback is made. If the event
 * callback rejects, the receipt is already durable; only re-reading the journal
 * can distinguish a pre-append orphan from a post-fsync acknowledgement loss.
 */
export async function persistExternalActionReconciliationAttempt(
  input: PersistExternalActionReconciliationAttemptInput,
): Promise<MaterializedExternalActionReceipt | undefined> {
  assertAttemptVerdictMatchesAction(input.action, input.verdict)
  const receipt = input.action.status === 'committed'
    ? await materializeExternalActionReceipt({
        store: input.store,
        runId: input.runId,
        revision: input.revision,
        sessionId: input.sessionId,
        action: input.action,
        verdict: input.verdict!,
      })
    : undefined
  await input.persistLedgerEvent(receipt)
  return receipt
}

function isDurableStore(store: ToolResultStore): store is DurableToolResultStore {
  return typeof (store as Partial<DurableToolResultStore>).writeDurably === 'function'
}

function assertAttemptVerdictMatchesAction(
  action: ActionLedgerEntry,
  verdict: ExternalActionReconciliationVerdict | undefined,
): void {
  if (!verdict) {
    if (action.status === 'committed' || action.status === 'not_committed') {
      throw new Error(`Terminal external action ${action.actionId} is missing its reconciliation verdict.`)
    }
    return
  }
  const expectedStatus = verdict.state === 'committed'
    ? 'committed'
    : verdict.state === 'not_committed'
      ? 'not_committed'
      : 'ambiguous'
  if (action.status !== expectedStatus) {
    throw new Error(
      `External action ${action.actionId} status ${action.status} does not match verdict ${verdict.state}.`,
    )
  }
}

/** Re-reads the immutable receipt and verifies both its hash and semantic action binding. */
export async function verifyExternalActionReceipt(
  input: VerifyExternalActionReceiptInput,
): Promise<void> {
  validateExternalActionReceiptStorageBinding(
    input.artifact,
    input.storageRef,
    input.sessionId,
    input.action,
  )
  const envelope = await input.store.read(input.storageRef)
  const content = envelope.content
  assertCommittedVerdictBinding(input.action, input.verdict)
  if (!isRecord(content)
    || content.schemaVersion !== 'external-action-receipt/v1'
    || content.actionId !== input.action.actionId
    || content.actionKind !== input.action.actionKind
    || content.businessKey !== input.action.externalBinding?.businessKey
    || content.externalReference !== input.verdict.externalReference
    || (input.action.externalBinding?.schemaVersion === 'external-action-binding/v2'
      && content.observedEffectDigest !== input.action.externalBinding.effectDigest)
    || content.observedAt !== input.verdict.observedAt
    || content.verifier !== input.verdict.verifier
    || !Array.isArray(content.probeEvidenceIds)
    || content.probeEvidenceIds.length === 0
    || content.probeEvidenceIds.some((id) => typeof id !== 'string' || id.trim() === '')
    || !sameStringArray(content.probeEvidenceIds, input.verdict.evidenceIds)
    || content.summary !== input.verdict.summary
    || content.observedEffectDigest !== input.verdict.observedEffectDigest) {
    throw new Error(`External action receipt content is invalid for ${input.action.actionId}.`)
  }
}

function assertCommittedVerdictBinding(
  action: ActionLedgerEntry,
  verdict: ExternalActionReconciliationVerdict,
): void {
  if (verdict.schemaVersion !== 'external-action-reconciliation/v1'
    || verdict.state !== 'committed'
    || verdict.actionId !== action.actionId
    || verdict.businessKey !== action.externalBinding?.businessKey
    || verdict.verifier !== action.externalBinding?.probeId
    || !verdict.independentlyObserved
    || verdict.evidenceIds.length === 0
    || !verdict.externalReference
    || (action.externalBinding?.schemaVersion === 'external-action-binding/v2'
      && verdict.observedEffectDigest !== action.externalBinding.effectDigest)) {
    throw new Error(`External action receipt verdict is invalid for ${action.actionId}.`)
  }
}

function sameStringArray(left: unknown[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

export function validateExternalActionReceiptStorageBinding(
  artifact: ArtifactRef,
  storageRef: ToolResultArtifactRef,
  sessionId: string,
  action: ActionLedgerEntry,
): void {
  if (storageRef.schemaVersion !== 'tool-result-artifact-ref/v1'
    || storageRef.artifactId !== artifact.id
    || storageRef.runId !== artifact.binding.runId
    || storageRef.sessionId !== sessionId
    || storageRef.toolCallId !== action.actionId
    || storageRef.toolName !== 'external_action_reconciliation'
    || storageRef.kind !== 'generic_json'
    || storageRef.mediaType !== artifact.mediaType
    || storageRef.bytes !== artifact.byteLength
    || storageRef.sha256 !== artifact.sha256
    || storageRef.createdAt !== artifact.createdAt
    || storageRef.sensitivity !== artifact.sensitivity
    || storageRef.retention.scope !== artifact.retention.scope
    || storageRef.retention.deleteWithSession !== artifact.retention.deleteWithSession
    || artifact.binding.externalBusinessKey !== action.externalBinding?.businessKey
    || artifact.locator !== `artifact:${storageRef.artifactId}`) {
    throw new Error(`External action receipt storage binding is invalid for ${action.actionId}.`)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
