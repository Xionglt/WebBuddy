import type { RunRecord } from '../control/store-contracts.js'
import {
  digestCanonicalJson,
  validateContextItem,
  type ContextItem,
  type JsonValue,
} from '../task/contracts.js'
import {
  ConversationStoreError,
  decodeConversationRecord,
  type ConversationRecord,
  type ConversationTurnRecord,
} from './contracts.js'

const MAX_INHERITED_TURNS = 12
const MAX_INHERITED_ARTIFACTS = 24

type ConversationRunRecord = Pick<RunRecord, 'runId' | 'state' | 'reason' | 'artifactRefs'>

export function assembleConversationContext(input: {
  conversation: ConversationRecord
  priorRuns: ConversationRunRecord[]
  capturedAt: string
}): ContextItem[] {
  const conversation = decodeConversationRecord(input.conversation)
  assertTimestamp(input.capturedAt)
  const selectedTurns = conversation.turns.slice(-MAX_INHERITED_TURNS)
  if (!selectedTurns.length) return []
  const runsById = new Map(input.priorRuns.map((run) => [run.runId, run]))
  if (runsById.size !== input.priorRuns.length) invalid('Conversation context contains duplicate Run IDs.')
  const bound = selectedTurns.map((turn) => {
    const run = runsById.get(turn.runId)
    if (!run) invalid(`Conversation Turn ${turn.turnId} is missing its bound Run ${turn.runId}.`)
    return { turn, run }
  })
  const selectedArtifactIds = selectRecentArtifactIds(bound)
  const parentContentIds = selectedTurns.map((turn) => turn.turnId)
  const base = {
    schemaVersion: 'context-item/v1' as const,
    provenance: {
      capturedAt: input.capturedAt,
      parentContentIds,
    },
    allowedUses: ['prompt', 'trace'] as const,
    freshness: {
      validity: 'current' as const,
      revision: conversation.recordRevision,
    },
    retention: {
      scope: 'run' as const,
      deleteWithSession: true,
    },
    sanitization: {
      policyId: 'conversation-context/v1',
      status: 'unchanged' as const,
      redactedFields: [],
      instructionNeutralized: false,
      transformedFrom: [],
    },
    integrity: {
      immutable: true,
      digestVerified: false,
    },
  }
  const userContent = bound.map(({ turn }) => ({
    sequence: turn.sequence,
    message: turn.userMessage,
  })) satisfies JsonValue
  const runContent = bound.map(({ turn, run }) => ({
    sequence: turn.sequence,
    runId: run.runId,
    state: run.state,
    ...(run.reason ? { summary: run.reason } : {}),
    artifacts: run.artifactRefs
      .filter((artifact) => selectedArtifactIds.has(artifact.id))
      .map((artifact) => ({
        id: artifact.id,
        kind: artifact.kind,
        payloadSchemaVersion: artifact.payloadSchemaVersion,
        createdAt: artifact.createdAt,
      })),
  })) satisfies JsonValue
  const items: ContextItem[] = [
    {
      ...base,
      id: contextId(conversation, 'user-history', userContent),
      kind: 'conversation_user_history',
      content: userContent,
      origin: 'user',
      trust: 'user_authorized',
      instructionAuthority: 'user_goal',
      sensitivity: 'personal',
      allowedUses: [...base.allowedUses],
    },
    {
      ...base,
      id: contextId(conversation, 'run-history', runContent),
      kind: 'conversation_run_history',
      content: runContent,
      origin: 'derived',
      trust: 'non_authoritative',
      instructionAuthority: 'data_only',
      sensitivity: 'internal',
      allowedUses: [...base.allowedUses],
    },
  ]
  items.forEach(validateContextItem)
  return items
}

function selectRecentArtifactIds(
  bound: Array<{ turn: ConversationTurnRecord; run: ConversationRunRecord }>,
): Set<string> {
  const selected = new Set<string>()
  for (const { run } of [...bound].reverse()) {
    for (const artifact of [...run.artifactRefs].reverse()) {
      if (selected.size >= MAX_INHERITED_ARTIFACTS) return selected
      selected.add(artifact.id)
    }
  }
  return selected
}

function contextId(conversation: ConversationRecord, kind: string, content: JsonValue): string {
  return `conversation-context-${digestCanonicalJson({
    conversationId: conversation.conversationId,
    revision: conversation.recordRevision,
    kind,
    content,
  }).slice(0, 32)}`
}

function assertTimestamp(value: string): void {
  if (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    invalid('Conversation context capturedAt must be a canonical UTC timestamp.')
  }
}

function invalid(message: string): never {
  throw new ConversationStoreError('INVALID_RECORD', message)
}
