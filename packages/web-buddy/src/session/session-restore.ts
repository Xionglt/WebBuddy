import type { ChatMessage } from '../sdk/llm.js'
import {
  renderResumeCapsule,
  validateResumeCapsule,
  type ResumeCapsuleV1,
} from '../continuation/contracts.js'
import type { KernelEvent } from '../kernel/kernel-events.js'
import { ActionLedger, type ActionLedgerEntry } from '../task/action-ledger.js'
import { validateExternalActionReceiptStorageBinding } from '../task/action-reconciliation-artifact.js'
import { unresolvedActionEntries, type ExternalActionReconciliationVerdict } from '../task/action-reconciliation.js'
import { validateArtifactRef, type ArtifactRef } from '../task/contracts.js'
import type { ToolResultArtifactRef } from '../tools/tool-result-store.js'
import type { CompletionGateDecision } from '../workflow/completion-gate.js'
import type {
  WorkflowBlocker,
  WorkflowCriterionMissing,
  WorkflowEngineEvaluation,
} from '../workflow/workflow-engine.js'
import type { WorkflowEvidence } from '../workflow/workflow-evidence.js'
import type { WorkflowState } from '../workflow/workflow-state.js'
import type { AgentSession, FinalResultEntry, SessionStore, TranscriptEntry } from './session-types.js'
import type { TaskNotificationPromptAttachmentV1 } from '../agents/async-task-contracts.js'
import { readJsonLines } from './transcript.js'
import { migrateTranscriptEntriesWithWarnings, type MigrationWarning } from './migrations.js'

export interface RestoredSessionState {
  schemaVersion: 'restored-session-state/v1'
  session: AgentSession
  transcriptCount: number
  restoredAt: string
  latestWorkflowState?: WorkflowState
  workflowEvidence: WorkflowEvidence[]
  latestWorkflowEvaluation?: WorkflowEngineEvaluation
  latestCompletionGate?: CompletionGateDecision
  latestFinalResult?: FinalResultEntry
  restoredMessages: ChatMessage[]
  migrationWarnings: MigrationWarning[]
  missingCriteria: WorkflowCriterionMissing[]
  blockers: WorkflowBlocker[]
  asyncTaskPromptAttachments: TaskNotificationPromptAttachmentV1[]
  latestResumeCapsule?: ResumeCapsuleV1
  actionLedgerEntries: ActionLedgerEntry[]
  unresolvedActions: ActionLedgerEntry[]
  externalActionReceiptArtifacts: ArtifactRef[]
  externalActionReceiptStorageRefs: ToolResultArtifactRef[]
  externalActionReconciliationVerdicts: ExternalActionReconciliationVerdict[]
}

export type RestoreSessionStateInput =
  | AgentSession
  | {
      session: AgentSession
      now?: string
    }
  | {
      store: Pick<SessionStore, 'get'>
      sessionId: string
      now?: string
    }

export async function restoreSessionState(input: RestoreSessionStateInput): Promise<RestoredSessionState> {
  const session = await resolveSession(input)
  const migratedTranscript = migrateTranscriptEntriesWithWarnings(await readJsonLines<unknown>(session.transcriptPath))
  const transcript = migratedTranscript.value
  const events = await readJsonLines<KernelEvent>(session.eventsPath)

  let latestWorkflowState: WorkflowState | undefined
  let latestWorkflowEvaluation: WorkflowEngineEvaluation | undefined
  let latestCompletionGate: CompletionGateDecision | undefined
  let latestFinalResult: FinalResultEntry | undefined
  const workflowEvidence: WorkflowEvidence[] = []
  const asyncTaskPromptAttachments: TaskNotificationPromptAttachmentV1[] = []
  let latestResumeCapsule: ResumeCapsuleV1 | undefined
  let restoredMessages: ChatMessage[] = []

  for (const entry of transcript) {
    const restoredMessage = chatMessageFromTranscriptEntry(entry)
    if (restoredMessage) restoredMessages.push(restoredMessage)

    if (entry.type === 'context_compaction') {
      restoredMessages = compactedRestoreMessages(entry)
      continue
    }

    if (entry.type === 'async_task_notification_attachment') {
      asyncTaskPromptAttachments.push(structuredClone(entry.attachment))
      continue
    }

    if (entry.type === 'user_continuation') {
      validateResumeCapsule(entry.capsule, session.runId)
      latestResumeCapsule = structuredClone(entry.capsule)
      continue
    }

    if (entry.type === 'workflow_snapshot') {
      latestWorkflowState = workflowStateFromUnknown(entry.workflowState)
      continue
    }

    if (entry.type === 'workflow_evidence') {
      workflowEvidence.push(entry.evidence as WorkflowEvidence)
      continue
    }

    if (entry.type === 'workflow_evaluation') {
      latestWorkflowEvaluation = workflowEvaluationFromUnknown(entry.evaluation)
      continue
    }

    if (entry.type === 'completion_gate') {
      latestCompletionGate = completionGateDecisionFromUnknown(entry.decision)
      continue
    }

    if (entry.type === 'final_result') {
      latestFinalResult = entry
    }
  }

  const actionLedgerEntries = actionLedgerEntriesFrom(events)
  const externalActionReceipts = externalActionReceiptsFrom(events, session.runId, session.sessionId)
  return {
    schemaVersion: 'restored-session-state/v1',
    session: { ...session },
    transcriptCount: transcript.length,
    restoredAt: restoredAtFor(input),
    ...(latestWorkflowState ? { latestWorkflowState } : {}),
    workflowEvidence,
    ...(latestWorkflowEvaluation ? { latestWorkflowEvaluation } : {}),
    ...(latestCompletionGate ? { latestCompletionGate } : {}),
    ...(latestFinalResult ? { latestFinalResult } : {}),
    restoredMessages,
    migrationWarnings: migratedTranscript.warnings,
    missingCriteria:
      arrayProperty<WorkflowCriterionMissing>(latestWorkflowEvaluation, 'missingCriteria') ??
      arrayProperty<WorkflowCriterionMissing>(latestCompletionGate, 'missingCriteria') ??
      [],
    blockers:
      arrayProperty<WorkflowBlocker>(latestWorkflowEvaluation, 'blockers') ??
      arrayProperty<WorkflowBlocker>(latestCompletionGate, 'blockers') ??
      [],
    asyncTaskPromptAttachments,
    ...(latestResumeCapsule ? { latestResumeCapsule } : {}),
    actionLedgerEntries,
    unresolvedActions: unresolvedActionEntries(actionLedgerEntries),
    externalActionReceiptArtifacts: externalActionReceipts.artifacts,
    externalActionReceiptStorageRefs: externalActionReceipts.storageRefs,
    externalActionReconciliationVerdicts: externalActionReceipts.verdicts,
  }
}

/**
 * Removes tool requests that did not durably settle before interruption.
 * Settled call/result pairs remain transcript context; this function never
 * executes either side and prevents an old incomplete call from being replayed.
 */
export function sanitizeRestoredMessagesForResume(messages: readonly ChatMessage[]): ChatMessage[] {
  const settledIds = new Set(
    messages
      .filter((message) => message.role === 'tool' && typeof message.tool_call_id === 'string')
      .map((message) => message.tool_call_id as string),
  )
  const retainedCallIds = new Set<string>()
  const sanitized: ChatMessage[] = []
  for (const message of messages) {
    if (message.role === 'assistant' && message.tool_calls?.length) {
      const settledCalls = message.tool_calls.filter((call) => settledIds.has(call.id))
      for (const call of settledCalls) retainedCallIds.add(call.id)
      if (settledCalls.length) {
        sanitized.push({ ...message, tool_calls: settledCalls })
      } else if (message.content) {
        sanitized.push({ role: 'assistant', content: message.content })
      }
      continue
    }
    if (message.role === 'tool'
      && (typeof message.tool_call_id !== 'string' || !retainedCallIds.has(message.tool_call_id))) continue
    sanitized.push(structuredClone(message))
  }
  return sanitized
}

function chatMessageFromTranscriptEntry(entry: TranscriptEntry): ChatMessage | undefined {
  if (entry.type === 'async_task_notification_attachment') {
    return { role: 'user', content: entry.content }
  }
  if (entry.type === 'user_message') {
    return { role: 'user', content: entry.content }
  }
  if (entry.type === 'user_continuation') {
    return {
      role: 'user',
      content: renderResumeCapsule(entry.capsule),
    }
  }
  if (entry.type === 'assistant_message') {
    return assistantMessageFromUnknown(entry.content)
  }
  if (entry.type === 'tool_call') {
    return {
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: entry.toolCallId,
          type: 'function',
          function: {
            name: entry.name,
            arguments: stringifyJson(entry.args),
          },
        },
      ],
    }
  }
  if (entry.type === 'tool_result') {
    return {
      role: 'tool',
      tool_call_id: entry.toolCallId,
      name: entry.name,
      content: stringifyJson(entry.ok ? entry.result : { error: entry.error, result: entry.result }),
    }
  }
  return undefined
}

function actionLedgerEntriesFrom(events: readonly KernelEvent[]): ActionLedgerEntry[] {
  const entries: ActionLedgerEntry[] = []
  for (const event of events) {
    if (event.type !== 'action_ledger_updated') continue
    const entry = event.data?.entry
    if (!isActionLedgerEntry(entry)) {
      throw new Error('Durable session contains an invalid action ledger event.')
    }
    entries.push(structuredClone(entry))
  }
  // Never expose unresolvedActions or receipt bindings from a merely
  // syntactically valid but impossible/forged state history.
  ActionLedger.restore(entries)
  return entries
}

function externalActionReceiptsFrom(
  events: readonly KernelEvent[],
  runId: string,
  sessionId: string,
): {
  artifacts: ArtifactRef[]
  storageRefs: ToolResultArtifactRef[]
  verdicts: ExternalActionReconciliationVerdict[]
} {
  const artifacts = new Map<string, ArtifactRef>()
  const storageRefs = new Map<string, ToolResultArtifactRef>()
  const verdicts = new Map<string, ExternalActionReconciliationVerdict>()
  const previousActionEntries = new Map<string, ActionLedgerEntry>()
  for (const event of events) {
    if (event.type !== 'action_ledger_updated') continue
    const entry = event.data?.entry
    const receiptArtifact = event.data?.receiptArtifact
    const receiptStorageRef = event.data?.receiptStorageRef
    const reconciliation = event.data?.reconciliation
    const priorEntry = isActionLedgerEntry(entry)
      ? previousActionEntries.get(entry.actionId)
      : undefined
    if (isActionLedgerEntry(entry)) {
      previousActionEntries.set(entry.actionId, structuredClone(entry))
    }
    if (isActionLedgerEntry(entry)
      && entry.status === 'committed'
      && entry.externalBinding !== undefined) {
      if (receiptArtifact === undefined) {
        throw new Error(
          `Committed external action ${entry.actionId} is missing its authoritative receipt artifact.`,
        )
      }
      if (!isCommittedReconciliationForEntry(reconciliation, entry, priorEntry)) {
        throw new Error(
          `Committed external action ${entry.actionId} is missing a matching reconciliation verdict.`,
        )
      }
    }
    if (receiptStorageRef !== undefined && receiptArtifact === undefined) {
      throw new Error('External action receipt storage cannot exist without its public artifact reference.')
    }
    if (receiptArtifact === undefined) continue
    if (!isActionLedgerEntry(entry) || entry.status !== 'committed') {
      throw new Error('External action receipt must be bound to a committed ledger event.')
    }
    const rawArtifact = receiptArtifact
    if (!isRecord(rawArtifact)
      || !isRecord(rawArtifact.binding)
      || !Number.isSafeInteger(rawArtifact.binding.revision)) {
      throw new Error('Durable session contains an invalid external action receipt artifact.')
    }
    const artifact = rawArtifact as unknown as ArtifactRef
    validateArtifactRef(artifact, runId, Number(rawArtifact.binding.revision))
    if (artifact.kind !== 'external_action_receipt'
      || artifact.payloadSchemaVersion !== 'external-action-receipt/v1'
      || artifact.producer.id !== 'external-action-reconciliation'
      || artifact.producer.version !== '1'
      || artifact.origin !== 'tool'
      || artifact.trust !== 'trusted_runtime'
      || artifact.requiresMainWorkflowVerification
      || !artifact.authoritativeCompletionEvidence
      || artifact.binding.actionSeq !== entry.sequence
      || artifact.binding.externalBusinessKey !== entry.externalBinding?.businessKey
      || artifact.parentEvidenceIds.length !== 0
      || artifact.parentArtifactIds.length !== 0) {
      throw new Error('Durable session contains an invalid external action receipt artifact.')
    }
    const rawStorageRef = receiptStorageRef
    if (!isToolResultArtifactRef(rawStorageRef)) {
      throw new Error('Durable session contains an invalid external action receipt storage reference.')
    }
    validateExternalActionReceiptStorageBinding(artifact, rawStorageRef, sessionId, entry)
    const existing = artifacts.get(artifact.id)
    if (existing && JSON.stringify(existing) !== JSON.stringify(artifact)) {
      throw new Error(`Durable session contains conflicting external action receipt ${artifact.id}.`)
    }
    const existingStorageRef = storageRefs.get(artifact.id)
    if (existingStorageRef && JSON.stringify(existingStorageRef) !== JSON.stringify(rawStorageRef)) {
      throw new Error(`Durable session contains conflicting external action receipt storage ${artifact.id}.`)
    }
    if (!isCommittedReconciliationForEntry(reconciliation, entry, priorEntry)) {
      throw new Error(`External action receipt ${artifact.id} has no matching committed verdict.`)
    }
    const verdict = reconciliation as ExternalActionReconciliationVerdict
    const existingVerdict = verdicts.get(artifact.id)
    if (existingVerdict && JSON.stringify(existingVerdict) !== JSON.stringify(verdict)) {
      throw new Error(`Durable session contains conflicting external action verdict ${artifact.id}.`)
    }
    artifacts.set(artifact.id, structuredClone(artifact))
    storageRefs.set(artifact.id, structuredClone(rawStorageRef))
    verdicts.set(artifact.id, structuredClone(verdict))
  }
  return {
    artifacts: [...artifacts.values()],
    storageRefs: [...storageRefs.values()],
    verdicts: [...verdicts.values()],
  }
}

function isCommittedReconciliationForEntry(
  value: unknown,
  entry: ActionLedgerEntry,
  priorEntry: ActionLedgerEntry | undefined,
): boolean {
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
  if (!isRecord(value)
    || Object.keys(value).some((key) => !allowedKeys.has(key))
    || value.schemaVersion !== 'external-action-reconciliation/v1'
    || value.actionId !== entry.actionId
    || value.businessKey !== entry.externalBinding?.businessKey
    || value.state !== 'committed'
    || value.verifier !== entry.externalBinding?.probeId
    || value.independentlyObserved !== true
    || typeof value.observedAt !== 'string'
    || !Number.isFinite(Date.parse(value.observedAt))
    || new Date(Date.parse(value.observedAt)).toISOString() !== value.observedAt
    || !priorEntry
    || priorEntry.actionId !== entry.actionId
    || Date.parse(value.observedAt) < Date.parse(priorEntry.recordedAt)
    || Date.parse(value.observedAt) > Date.now() + 5 * 60_000
    || typeof value.externalReference !== 'string'
    || value.externalReference.trim() === ''
    || value.externalReference !== value.externalReference.trim()
    || value.retrySafe !== undefined
    || typeof value.summary !== 'string'
    || value.summary.trim() === ''
    || !Array.isArray(value.evidenceIds)
    || value.evidenceIds.length === 0
    || value.evidenceIds.some((id) => (
      typeof id !== 'string' || id.trim() === '' || id !== id.trim()
    ))
    || new Set(value.evidenceIds).size !== value.evidenceIds.length) {
    return false
  }
  if (entry.externalBinding?.schemaVersion === 'external-action-binding/v2') {
    return value.observedEffectDigest === entry.externalBinding.effectDigest
  }
  return value.observedEffectDigest === undefined
    || (typeof value.observedEffectDigest === 'string'
      && /^[a-f0-9]{64}$/i.test(value.observedEffectDigest))
}

function isToolResultArtifactRef(value: unknown): value is ToolResultArtifactRef {
  if (!isRecord(value) || value.schemaVersion !== 'tool-result-artifact-ref/v1') return false
  return typeof value.artifactId === 'string'
    && typeof value.runId === 'string'
    && typeof value.sessionId === 'string'
    && typeof value.toolCallId === 'string'
    && typeof value.toolName === 'string'
    && typeof value.kind === 'string'
    && typeof value.uri === 'string'
    && value.uri.length > 0
    && typeof value.mediaType === 'string'
    && Number.isSafeInteger(value.bytes)
    && typeof value.sha256 === 'string'
    && typeof value.createdAt === 'string'
    && isRecord(value.retention)
    && typeof value.retention.scope === 'string'
    && typeof value.sensitivity === 'string'
}

function isActionLedgerEntry(value: unknown): value is ActionLedgerEntry {
  if (!isRecord(value) || value.schemaVersion !== 'action-ledger-entry/v1') return false
  return Number.isSafeInteger(value.sequence)
    && Number(value.sequence) > 0
    && typeof value.actionId === 'string'
    && value.actionId.length > 0
    && typeof value.actionKind === 'string'
    && ACTION_LEDGER_KINDS.has(value.actionKind)
    && typeof value.toolName === 'string'
    && value.toolName.length > 0
    && typeof value.status === 'string'
    && ACTION_LEDGER_STATUSES.has(value.status)
    && typeof value.recordedAt === 'string'
    && Number.isFinite(Date.parse(value.recordedAt))
    && (value.externalBinding === undefined || (
      isRecord(value.externalBinding)
      && (value.externalBinding.schemaVersion === 'external-action-binding/v1'
        || value.externalBinding.schemaVersion === 'external-action-binding/v2')
      && typeof value.externalBinding.businessKey === 'string'
      && value.externalBinding.businessKey.length > 0
      && typeof value.externalBinding.probeId === 'string'
      && value.externalBinding.probeId.length > 0
      && (value.externalBinding.schemaVersion === 'external-action-binding/v1'
        || (typeof value.externalBinding.effectDigest === 'string'
          && /^[a-f0-9]{64}$/i.test(value.externalBinding.effectDigest)))
      && Object.keys(value.externalBinding).length
        === (value.externalBinding.schemaVersion === 'external-action-binding/v1' ? 3 : 4)
    ))
    && (value.actionDecision === undefined || (
      isRecord(value.actionDecision)
      && value.actionDecision.schemaVersion === 'action-decision-ref/v1'
      && (value.actionDecision.source === 'task_policy' || value.actionDecision.source === 'human_gate')
      && typeof value.actionDecision.decisionRef === 'string'
      && value.actionDecision.decisionRef.trim().length > 0
      && (value.actionDecision.actionBindingSha256 === undefined
        || (typeof value.actionDecision.actionBindingSha256 === 'string'
          && /^[a-f0-9]{64}$/i.test(value.actionDecision.actionBindingSha256)))
      && Object.keys(value.actionDecision).length
        === (value.actionDecision.actionBindingSha256 === undefined ? 3 : 4)
    ))
}

const ACTION_LEDGER_KINDS = new Set([
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
const ACTION_LEDGER_STATUSES = new Set([
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

function compactedRestoreMessages(entry: Extract<TranscriptEntry, { type: 'context_compaction' }>): ChatMessage[] {
  return [
    {
      role: 'system',
      content: 'RESTORED_COMPACTED_RUN_CONTEXT',
    },
    {
      role: 'user',
      cacheBoundary: 'compaction_checkpoint',
      content: stringifyJson({
        schemaVersion: 'restored-compacted-run-context/v1',
        summaryId: entry.summaryId,
        reason: entry.reason,
        ...(entry.mode ? { mode: entry.mode } : {}),
        ...(entry.recentRawRetention ? { recentRawRetention: entry.recentRawRetention } : {}),
        ...(entry.semanticError ? { semanticError: entry.semanticError } : {}),
        summary: entry.summary,
      }),
    },
  ]
}

function assistantMessageFromUnknown(value: unknown): ChatMessage {
  if (typeof value === 'string') return { role: 'assistant', content: value }
  if (isRecord(value)) {
    const content = typeof value.content === 'string' ? value.content : stringifyJson(value)
    const toolCalls = Array.isArray(value.tool_calls) ? value.tool_calls.filter(isChatToolCall) : undefined
    return {
      role: 'assistant',
      content,
      ...(toolCalls?.length ? { tool_calls: toolCalls } : {}),
    }
  }
  return { role: 'assistant', content: stringifyJson(value) }
}

function isChatToolCall(value: unknown): value is NonNullable<ChatMessage['tool_calls']>[number] {
  if (!isRecord(value) || value.type !== 'function' || typeof value.id !== 'string' || !isRecord(value.function)) return false
  return typeof value.function.name === 'string' && typeof value.function.arguments === 'string'
}

function stringifyJson(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === undefined) return ''
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

async function resolveSession(input: RestoreSessionStateInput): Promise<AgentSession> {
  if ('transcriptPath' in input) return input
  if ('session' in input) return input.session

  const session = await input.store.get(input.sessionId)
  if (!session) throw new Error(`Session not found: ${input.sessionId}`)
  return session
}

function restoredAtFor(input: RestoreSessionStateInput): string {
  if ('transcriptPath' in input) return new Date().toISOString()
  return input.now ?? new Date().toISOString()
}

function arrayProperty<T>(value: unknown, property: string): T[] | undefined {
  if (!value || typeof value !== 'object') return undefined
  const candidate = (value as Record<string, unknown>)[property]
  return Array.isArray(candidate) ? ([...candidate] as T[]) : undefined
}

function workflowStateFromUnknown(value: unknown): WorkflowState | undefined {
  if (!isRecord(value)) return undefined
  if (value.schemaVersion !== 'workflow-state/v1') return undefined
  if (typeof value.phase !== 'string') return undefined
  return { ...value } as unknown as WorkflowState
}

function workflowEvaluationFromUnknown(value: unknown): WorkflowEngineEvaluation | undefined {
  if (!isRecord(value)) return undefined
  const state = workflowStateFromUnknown(value.state)
  if (!state) return undefined
  return {
    ...value,
    state,
    matchedCriteria: arrayValue(value.matchedCriteria),
    missingCriteria: arrayValue(value.missingCriteria),
    blockers: arrayValue(value.blockers),
    evidenceIds: arrayValue(value.evidenceIds),
  } as WorkflowEngineEvaluation
}

function completionGateDecisionFromUnknown(value: unknown): CompletionGateDecision | undefined {
  if (!isRecord(value)) return undefined
  if (value.schemaVersion !== 'completion-gate-decision/v1') return undefined
  if (typeof value.action !== 'string' || typeof value.recommendedStatus !== 'string') return undefined
  return {
    ...value,
    missingCriteria: arrayValue(value.missingCriteria),
    blockers: arrayValue(value.blockers),
    evidenceIds: arrayValue(value.evidenceIds),
  } as CompletionGateDecision
}

function arrayValue<T>(value: unknown): T[] {
  return Array.isArray(value) ? ([...value] as T[]) : []
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
