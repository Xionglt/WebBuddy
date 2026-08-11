import type { ContentTrust, ContextItem, OwnerScope } from '../task/contracts.js'
import { createHash } from 'node:crypto'
import type {
  MemoryLifecycleRecord,
  MemoryRetrievalResult,
  MemoryLifecycleService,
} from './memory-lifecycle.js'
import type { MemoryTargetScope } from './memory-write-policy.js'
import {
  evaluateWebMemoryGovernance,
  governedWebMemoryContent,
  isEvidenceBoundedWebMemory,
  type PageSemanticFingerprint,
  type WebMemoryGovernanceDecision,
  type WebMemoryGovernanceReason,
} from './web-memory-governance.js'
import {
  projectBrowserScenarioCapsules,
  type ProjectedBrowserScenarioCapsule,
} from './browser-scenario-capsule.js'

export interface LifecycleMemoryContextInput {
  service: MemoryLifecycleService
  ownerScope?: OwnerScope
  query: string
  runId: string
  revision: number
  sessionId: string
  maxResults?: number
  currentUrl?: string
  workflow?: string
  pageFingerprint?: PageSemanticFingerprint
  projectionMode?: 'atomic' | 'scenario'
}

export interface LifecycleMemoryGovernanceSummary {
  evaluated: number
  injected: number
  eligible: number
  advisory: number
  rejected: number
  reasons: Partial<Record<WebMemoryGovernanceReason, number>>
}

export type LifecycleMemoryContextBatch =
  | {
      status: 'retrieved'
      retrieval: MemoryRetrievalResult
      contextItems: ContextItem[]
      governance: LifecycleMemoryGovernanceSummary
    }
  | {
      status: 'skipped'
      reason: 'missing_scope' | 'empty_query'
      contextItems: []
    }

export async function retrieveLifecycleMemoryContextBatch(
  input: LifecycleMemoryContextInput,
): Promise<LifecycleMemoryContextBatch> {
  const scope = targetScope(input.ownerScope)
  if (!scope) return { status: 'skipped', reason: 'missing_scope', contextItems: [] }
  if (!input.query.trim()) return { status: 'skipped', reason: 'empty_query', contextItems: [] }
  const retrieval = await input.service.retrieve({
    schemaVersion: 'memory-lifecycle-retrieve/v2',
    scope,
    query: input.query,
    maxResults: input.maxResults ?? 8,
  })
  const governed = retrieval.records
    .map((item) => item.record)
    .filter((record) => record.state === 'active'
      && record.content !== null
      && record.sensitivity !== 'auth'
      && record.sensitivity !== 'secret')
    .map((record) => ({
      record,
      governance: evaluateWebMemoryGovernance(record, {
        currentUrl: input.currentUrl,
        workflow: input.workflow,
        pageFingerprint: input.pageFingerprint,
      }),
    }))
  const selected = governed.filter((item) => item.governance.status !== 'rejected')
  const contextItems = input.projectionMode === 'scenario'
    ? scenarioContextItems(selected, input)
    : selected.map((item) => memoryRecordContextItem(item.record, input, item.governance))
  return {
    status: 'retrieved',
    retrieval,
    contextItems,
    governance: governanceSummary(governed.map((item) => item.governance), selected.length),
  }
}

function scenarioContextItems(
  governed: ReadonlyArray<{
    record: Readonly<MemoryLifecycleRecord>
    governance: WebMemoryGovernanceDecision
  }>,
  input: LifecycleMemoryContextInput,
): ContextItem[] {
  const scenarioMemories = governed
    .filter((item): item is typeof item & { record: Readonly<MemoryLifecycleRecord> & {
      content: NonNullable<MemoryLifecycleRecord['content']>
    } } => isEvidenceBoundedWebMemory(item.record.content))
    .map((item) => ({
      record: item.record,
      memory: item.record.content as ReturnType<typeof governedWebMemoryContent>['memory'],
      governance: item.governance,
    }))
  const scenarioIds = new Set(scenarioMemories.map((item) => item.record.entryId))
  const genericItems = governed
    .filter((item) => !scenarioIds.has(item.record.entryId))
    .map((item) => memoryRecordContextItem(item.record, input, item.governance))
  const capsules = projectBrowserScenarioCapsules(scenarioMemories)
    .map((capsule) => scenarioCapsuleContextItem(capsule, input))
  return [...capsules, ...genericItems]
}

function scenarioCapsuleContextItem(
  projected: ProjectedBrowserScenarioCapsule,
  input: Pick<LifecycleMemoryContextInput, 'runId' | 'revision' | 'sessionId'>,
): ContextItem {
  const records = [...projected.records]
  const transformedFrom = records.map((record) => record.contentVersionId)
  const parentContentIds = [...new Set(records.flatMap((record) => (
    [record.contentVersionId, ...(record.provenance?.parentContentIds ?? [])]
  )))]
  const capturedAt = records.map((record) => record.updatedAt).sort().at(-1)
    ?? projected.capsule.latestEvidenceAt
  const digest = createHash('sha256').update(JSON.stringify(projected.capsule)).digest('hex')
  return {
    schemaVersion: 'context-item/v1',
    id: `lifecycle-memory.${projected.capsule.capsuleId}`,
    kind: 'browser_scenario_memory',
    content: projected.capsule,
    origin: 'derived',
    trust: 'derived_untrusted',
    instructionAuthority: 'data_only',
    sensitivity: projected.sensitivity,
    provenance: {
      capturedAt,
      parentContentIds,
      runId: input.runId,
      sessionId: input.sessionId,
      sha256: digest,
      ...(projected.capsule.applicability.urlOrigin
        ? { sourceOrigin: projected.capsule.applicability.urlOrigin }
        : {}),
    },
    allowedUses: ['prompt'],
    freshness: {
      validity: 'current',
      revision: input.revision,
      ...(projected.expiresAt ? { expiresAt: projected.expiresAt } : {}),
    },
    retention: {
      scope: 'session',
      deleteWithSession: true,
    },
    sanitization: {
      policyId: 'browser-scenario-capsule/v1',
      status: 'unchanged',
      redactedFields: [],
      instructionNeutralized: true,
      transformedFrom,
    },
    integrity: {
      immutable: true,
      digestVerified: true,
    },
  }
}

export async function retrieveLifecycleMemoryContext(
  input: LifecycleMemoryContextInput,
): Promise<ContextItem[]> {
  return (await retrieveLifecycleMemoryContextBatch(input)).contextItems
}
function memoryRecordContextItem(
  record: Readonly<MemoryLifecycleRecord>,
  input: Pick<Parameters<typeof retrieveLifecycleMemoryContext>[0], 'runId' | 'revision' | 'sessionId'>,
  governance: WebMemoryGovernanceDecision,
): ContextItem {
  const content = isEvidenceBoundedWebMemory(record.content)
    ? governedWebMemoryContent(record.content, governance)
    : record.content!
  return {
    schemaVersion: 'context-item/v1',
    id: `lifecycle-memory.${record.entryId}.r${record.revision}`,
    kind: 'lifecycle_memory',
    content,
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

function governanceSummary(
  decisions: WebMemoryGovernanceDecision[],
  injected: number,
): LifecycleMemoryGovernanceSummary {
  const reasons: LifecycleMemoryGovernanceSummary['reasons'] = {}
  for (const item of decisions) reasons[item.reasonCode] = (reasons[item.reasonCode] ?? 0) + 1
  return {
    evaluated: decisions.length,
    injected,
    eligible: decisions.filter((item) => item.status === 'eligible').length,
    advisory: decisions.filter((item) => item.status === 'advisory').length,
    rejected: decisions.filter((item) => item.status === 'rejected').length,
    reasons,
  }
}

function memoryContextTrust(trust: ContentTrust): ContentTrust {
  return trust === 'user_authorized' || trust === 'trusted_runtime'
    ? 'untrusted_external'
    : trust
}

function targetScope(ownerScope: OwnerScope | undefined): MemoryTargetScope | undefined {
  if (!ownerScope) return undefined
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
