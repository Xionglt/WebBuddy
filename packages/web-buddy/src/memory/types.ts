export type MemoryScope = 'run' | 'session' | 'project' | 'user'
export type MemoryKind =
  | 'user_answer'
  | 'permission_rule'
  | 'semantic_note'
  | 'episodic_recall'
  | 'site_fact'
  | 'failure_pattern'
  | 'skill_note'

export type MemorySensitivity = 'public' | 'internal' | 'personal' | 'secret'

export interface MemorySource {
  type: 'transcript' | 'user' | 'permission_decision' | 'answer_store' | 'skill' | 'derived_summary'
  refId?: string
  transcriptEntryId?: string
  toolCallId?: string
  skillId?: string
}

export interface MemoryRecordBase {
  schemaVersion: 'memory-record/v1'
  id: string
  kind: MemoryKind
  scope: MemoryScope
  runId?: string
  sessionId?: string
  projectId?: string
  userId?: string
  createdAt: string
  updatedAt: string
  expiresAt?: string
  source: MemorySource
  sensitivity: MemorySensitivity
  tags: string[]
  confidence: number
}

export interface UserAnswerMemory extends MemoryRecordBase {
  kind: 'user_answer'
  question: string
  field: string
  answer: string
  normalizedValue?: string
  reusable: boolean
}

export interface PermissionRuleMemory extends MemoryRecordBase {
  kind: 'permission_rule'
  ruleId: string
  action: 'allow' | 'ask' | 'deny'
  subjectPattern: {
    kind: 'tool_call' | 'workflow_handoff'
    toolName?: string
    toolCategory?: string
    argHash?: string
    urlOrigin?: string
    handoffKind?: string
  }
  rememberScope: 'session' | 'always'
  gateKind?: string
  policyCode?: string
  auditTags: string[]
}

export interface SemanticMemory extends MemoryRecordBase {
  kind: 'semantic_note' | 'site_fact' | 'failure_pattern' | 'skill_note'
  title: string
  body: string
  topics: string[]
  embeddingRef?: string
}

export interface EpisodicRecallMemory extends MemoryRecordBase {
  kind: 'episodic_recall'
  summary: string
  outcome: 'completed' | 'blocked' | 'failed' | 'aborted'
  evidenceRefs: Array<{ kind: string; ref: string }>
  reusableLessons: string[]
}

export type MemoryRecord = UserAnswerMemory | PermissionRuleMemory | SemanticMemory | EpisodicRecallMemory

export interface MemoryQuery {
  schemaVersion: 'memory-query/v1'
  runId: string
  sessionId: string
  scope: MemoryScope[]
  kinds?: MemoryKind[]
  topics?: string[]
  field?: string
  urlOrigin?: string
  maxResults: number
  includeSensitive?: boolean
}

export interface MemorySearchResult {
  schemaVersion: 'memory-search-result/v1'
  query: MemoryQuery
  generatedAt: string
  records: Array<{ record: MemoryRecord; score: number; reason: string }>
}
