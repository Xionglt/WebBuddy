import type { ChatMessage } from '../sdk/llm.js'
import type { CompletionGateDecision } from '../workflow/completion-gate.js'
import type {
  WorkflowBlocker,
  WorkflowCriterionMissing,
  WorkflowEngineEvaluation,
} from '../workflow/workflow-engine.js'
import type { WorkflowEvidence } from '../workflow/workflow-evidence.js'
import type { WorkflowState } from '../workflow/workflow-state.js'
import type { AgentSession, FinalResultEntry, SessionStore, TranscriptEntry } from './session-types.js'
import { readJsonLines } from './transcript.js'
import { migrateTranscriptEntries } from './migrations.js'

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
  missingCriteria: WorkflowCriterionMissing[]
  blockers: WorkflowBlocker[]
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
  const transcript = migrateTranscriptEntries(await readJsonLines<unknown>(session.transcriptPath))

  let latestWorkflowState: WorkflowState | undefined
  let latestWorkflowEvaluation: WorkflowEngineEvaluation | undefined
  let latestCompletionGate: CompletionGateDecision | undefined
  let latestFinalResult: FinalResultEntry | undefined
  const workflowEvidence: WorkflowEvidence[] = []
  let restoredMessages: ChatMessage[] = []

  for (const entry of transcript) {
    const restoredMessage = chatMessageFromTranscriptEntry(entry)
    if (restoredMessage) restoredMessages.push(restoredMessage)

    if (entry.type === 'context_compaction') {
      restoredMessages = compactedRestoreMessages(entry)
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
    missingCriteria:
      arrayProperty<WorkflowCriterionMissing>(latestWorkflowEvaluation, 'missingCriteria') ??
      arrayProperty<WorkflowCriterionMissing>(latestCompletionGate, 'missingCriteria') ??
      [],
    blockers:
      arrayProperty<WorkflowBlocker>(latestWorkflowEvaluation, 'blockers') ??
      arrayProperty<WorkflowBlocker>(latestCompletionGate, 'blockers') ??
      [],
  }
}

function chatMessageFromTranscriptEntry(entry: TranscriptEntry): ChatMessage | undefined {
  if (entry.type === 'user_message') {
    return { role: 'user', content: entry.content }
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

function compactedRestoreMessages(entry: Extract<TranscriptEntry, { type: 'context_compaction' }>): ChatMessage[] {
  return [
    {
      role: 'system',
      content: 'RESTORED_COMPACTED_RUN_CONTEXT',
    },
    {
      role: 'user',
      content: stringifyJson({
        schemaVersion: 'restored-compacted-run-context/v1',
        summaryId: entry.summaryId,
        reason: entry.reason,
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
  return { ...value } as WorkflowState
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
