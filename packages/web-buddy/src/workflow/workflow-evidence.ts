import type { WorkflowConfidence, WorkflowPhase } from './workflow-state.js'

export type EvidenceKind =
  | 'page'
  | 'form'
  | 'tool_result'
  | 'policy'
  | 'permission'
  | 'approval'
  | 'user_confirm'
  | 'screenshot'
  | 'workflow_state'
  | 'context_summary'
  | 'other'
  | (string & {})

export interface WorkflowEvidence {
  schemaVersion: 'workflow-evidence/v1'
  id: string
  kind: EvidenceKind
  summary: string
  source: string
  confidence: WorkflowConfidence
  ts: string
  phase?: WorkflowPhase | string
  sessionId?: string
  runId?: string
  turnId?: string
  toolCallId?: string
  data?: Record<string, unknown>
  metadata?: Record<string, unknown>
}

export type AddWorkflowEvidenceInput = Omit<WorkflowEvidence, 'schemaVersion' | 'id' | 'confidence' | 'ts'> & {
  id?: string
  confidence?: WorkflowConfidence
  ts?: string
}

export interface EvidenceStoreOptions {
  now?: () => Date
}

export interface EvidenceStoreSnapshot {
  schemaVersion: 'evidence-store-snapshot/v1'
  version: 1
  generatedAt: string
  total: number
  kinds: EvidenceKind[]
  countsByKind: Record<string, number>
  evidence: WorkflowEvidence[]
  byKind: Record<string, WorkflowEvidence[]>
  all: WorkflowEvidence[]
}

export class EvidenceStore {
  private readonly evidence = new Map<string, WorkflowEvidence>()
  private sequence = 0

  constructor(private readonly options: EvidenceStoreOptions = {}) {}

  add(input: AddWorkflowEvidenceInput | WorkflowEvidence): WorkflowEvidence {
    const id = input.id ?? this.createEvidenceId(input.kind)
    const existing = this.evidence.get(id)
    if (existing) return cloneEvidence(existing)

    const evidence: WorkflowEvidence = {
      schemaVersion: 'workflow-evidence/v1',
      id,
      kind: input.kind,
      summary: input.summary,
      source: input.source,
      confidence: input.confidence ?? 'medium',
      ts: input.ts ?? this.now(),
      ...(input.phase ? { phase: input.phase } : {}),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.runId ? { runId: input.runId } : {}),
      ...(input.turnId ? { turnId: input.turnId } : {}),
      ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
      ...(input.data ? { data: cloneRecord(input.data) } : {}),
      ...(input.metadata ? { metadata: cloneRecord(input.metadata) } : {}),
    }

    this.evidence.set(id, evidence)
    return cloneEvidence(evidence)
  }

  list(): WorkflowEvidence[] {
    return [...this.evidence.values()].map(cloneEvidence)
  }

  byKind(kind: EvidenceKind): WorkflowEvidence[] {
    return this.list().filter((evidence) => evidence.kind === kind)
  }

  snapshot(): EvidenceStoreSnapshot {
    const evidence = this.list()
    const countsByKind: Record<string, number> = {}
    const byKind: Record<string, WorkflowEvidence[]> = {}
    for (const item of evidence) {
      countsByKind[item.kind] = (countsByKind[item.kind] ?? 0) + 1
      byKind[item.kind] = [...(byKind[item.kind] ?? []), cloneEvidence(item)]
    }

    return {
      schemaVersion: 'evidence-store-snapshot/v1',
      version: 1,
      generatedAt: this.now(),
      total: evidence.length,
      kinds: Object.keys(countsByKind),
      countsByKind,
      evidence,
      byKind,
      all: evidence.map(cloneEvidence),
    }
  }

  private now(): string {
    return (this.options.now?.() ?? new Date()).toISOString()
  }

  private createEvidenceId(kind: EvidenceKind): string {
    this.sequence += 1
    return `evid_${sanitizeId(kind)}_${String(this.sequence).padStart(4, '0')}`
  }
}

function sanitizeId(value: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '')
  return sanitized || 'evidence'
}

function cloneEvidence(evidence: WorkflowEvidence): WorkflowEvidence {
  return {
    ...evidence,
    ...(evidence.data ? { data: cloneRecord(evidence.data) } : {}),
    ...(evidence.metadata ? { metadata: cloneRecord(evidence.metadata) } : {}),
  }
}

function cloneRecord(record: Record<string, unknown>): Record<string, unknown> {
  const clone: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(record)) {
    clone[key] = cloneValue(value)
  }
  return clone
}

function cloneValue(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(cloneValue)

  const clone: Record<string, unknown> = {}
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    clone[key] = cloneValue(nested)
  }
  return clone
}
