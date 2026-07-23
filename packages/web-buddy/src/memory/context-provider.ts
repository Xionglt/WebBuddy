import type { ContentTrust, ContextItem, OwnerScope } from '../task/contracts.js'
import type {
  MemoryLifecycleRecord,
  MemoryLifecycleService,
} from './memory-lifecycle.js'
import type { MemoryTargetScope } from './memory-write-policy.js'

export async function retrieveLifecycleMemoryContext(input: {
  service: MemoryLifecycleService
  ownerScope: OwnerScope
  query: string
  runId: string
  revision: number
  sessionId: string
  maxResults?: number
}): Promise<ContextItem[]> {
  const scope = targetScope(input.ownerScope)
  if (!scope || !input.query.trim()) return []
  const result = await input.service.retrieve({
    schemaVersion: 'memory-lifecycle-retrieve/v2',
    scope,
    query: input.query,
    maxResults: input.maxResults ?? 8,
  })
  return result.records
    .map((item) => item.record)
    .filter((record) => record.state === 'active'
      && record.content !== null
      && record.sensitivity !== 'auth'
      && record.sensitivity !== 'secret')
    .map((record) => memoryRecordContextItem(record, input))
}
function memoryRecordContextItem(
  record: Readonly<MemoryLifecycleRecord>,
  input: Pick<Parameters<typeof retrieveLifecycleMemoryContext>[0], 'runId' | 'revision' | 'sessionId'>,
): ContextItem {
  return {
    schemaVersion: 'context-item/v1',
    id: `lifecycle-memory.${record.entryId}.r${record.revision}`,
    kind: 'lifecycle_memory',
    content: record.content!,
    origin: 'memory',
    trust: memoryContextTrust(record.trust),
    instructionAuthority: 'data_only',
    sensitivity: record.sensitivity,
    provenance: {
      capturedAt: record.updatedAt,
      parentContentIds: record.provenance?.parentContentIds ?? [],
      runId: input.runId,
      sessionId: input.sessionId,
      sha256: record.contentHash,
    },
    allowedUses: ['prompt'],
    freshness: {
      validity: 'current',
      revision: input.revision,
      ...(record.expiresAt ? { expiresAt: record.expiresAt } : {}),
    },
    retention: {
      scope: 'session',
      deleteWithSession: true,
    },
    sanitization: {
      policyId: 'memory-lifecycle-context/v1',
      status: 'unchanged',
      redactedFields: [],
      instructionNeutralized: true,
      transformedFrom: [record.contentVersionId],
    },
    integrity: {
      immutable: true,
      digestVerified: true,
    },
    memory: {
      schemaVersion: 'memory-binding/v1',
      memoryId: record.entryId,
      revision: record.revision,
      scope: record.scope.kind,
      status: 'active',
      ...(record.expiresAt ? { expiresAt: record.expiresAt } : {}),
      supersedesIds: record.supersedes.map((item) => item.entryId),
      conflictIds: record.conflicts.map((item) => item.entryId),
    },
  }
}

function memoryContextTrust(trust: ContentTrust): ContentTrust {
  return trust === 'user_authorized' || trust === 'trusted_runtime'
    ? 'untrusted_external'
    : trust
}

function targetScope(ownerScope: OwnerScope): MemoryTargetScope | undefined {
  if (ownerScope.userId) {
    return {
      kind: 'user',
      ...(ownerScope.tenantId ? { tenantId: ownerScope.tenantId } : {}),
      userId: ownerScope.userId,
    }
  }
  if (ownerScope.projectId) {
    return {
      kind: 'project',
      ...(ownerScope.tenantId ? { tenantId: ownerScope.tenantId } : {}),
      projectId: ownerScope.projectId,
    }
  }
  return undefined
}
