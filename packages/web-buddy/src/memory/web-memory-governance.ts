import { createHash } from 'node:crypto'
import type { FormState } from '../observation/form-state.js'
import type { PageState } from '../observation/page-state.js'
import type { JsonObject } from '../task/contracts.js'

export const WEB_MEMORY_SCHEMA_VERSION = 'web-memory/v1' as const
export const PAGE_SEMANTIC_FINGERPRINT_SCHEMA_VERSION =
  'page-semantic-fingerprint/v1' as const
export const GOVERNED_WEB_MEMORY_CONTEXT_SCHEMA_VERSION =
  'governed-web-memory-context/v1' as const

export type WebMemoryEffect =
  | 'restrictive_constraint'
  | 'preference'
  | 'procedure'
  | 'authorization'

export type PageSemanticFingerprint = JsonObject & {
  schemaVersion: typeof PAGE_SEMANTIC_FINGERPRINT_SCHEMA_VERSION
  urlOrigin: string
  pathPattern: string
  pageType?: string
  workflowStage?: string
  fieldSignatures: string[]
  actionSignatures: string[]
  digest: string
}

export type EvidenceBoundedWebMemory = JsonObject & {
  schemaVersion: typeof WEB_MEMORY_SCHEMA_VERSION
  effect: WebMemoryEffect
  memoryKey?: string
  statement: string
  applicability?: JsonObject & {
    urlOrigin?: string
    pathPattern?: string
    workflow?: string
  }
  evidence: JsonObject & {
    source: 'user_instruction' | 'user_correction' | 'runtime_observation'
    capturedAt: string
    contentId?: string
    quoteHash?: string
    runId?: string
    turnId?: string
    pageFingerprint?: PageSemanticFingerprint
  }
  validation: JsonObject & {
    mode: 'none' | 'current_page' | 'current_session'
    minFingerprintSimilarity?: number
  }
}

export type WebMemoryGovernanceReason =
  | 'generic_memory'
  | 'restrictive_constraint'
  | 'preference_data_only'
  | 'historical_authorization_rejected'
  | 'origin_mismatch'
  | 'path_mismatch'
  | 'workflow_mismatch'
  | 'current_session_required'
  | 'page_fingerprint_required'
  | 'page_fingerprint_mismatch'
  | 'procedure_verified_against_current_page'

export type WebMemoryGovernanceDecision = JsonObject & {
  status: 'eligible' | 'advisory' | 'rejected'
  reasonCode: WebMemoryGovernanceReason
  requiresLiveVerification: boolean
  canExpandPermissions: false
  fingerprintSimilarity?: number
}

export interface WebMemoryGovernanceContext {
  currentUrl?: string
  workflow?: string
  pageFingerprint?: PageSemanticFingerprint
}

export type GovernedWebMemoryContext = JsonObject & {
  schemaVersion: typeof GOVERNED_WEB_MEMORY_CONTEXT_SCHEMA_VERSION
  statement: string
  effect: WebMemoryEffect
  governance: WebMemoryGovernanceDecision
  memory: EvidenceBoundedWebMemory
}

/**
 * Build a stable fingerprint from semantic form/page features rather than DOM
 * position or CSS selectors. Field and action order is deliberately ignored,
 * so harmless layout reordering does not invalidate a procedure memory.
 */
export function buildPageSemanticFingerprint(input: {
  url?: string
  page?: Pick<PageState, 'url' | 'pageType'>
  form?: Pick<FormState, 'url' | 'fields' | 'submitCandidates'>
  workflowStage?: string
}): PageSemanticFingerprint {
  const rawUrl = input.url ?? input.form?.url ?? input.page?.url
  const parsed = parseHttpUrl(rawUrl)
  if (!parsed) throw new Error('Page semantic fingerprint requires an absolute HTTP(S) URL.')

  const fieldSignatures = uniqueSorted((input.form?.fields ?? []).map((field) => [
    normalizeSemanticText(field.fieldKey ?? ''),
    normalizeSemanticText(field.label),
    normalizeSemanticText(field.controlKind ?? field.role ?? field.type ?? field.tag ?? 'unknown'),
    field.required ? 'required' : 'optional',
  ].join('|')))
  const actionSignatures = uniqueSorted((input.form?.submitCandidates ?? []).map((action) => [
    normalizeSemanticText(action.role ?? action.tag ?? 'action'),
    normalizeSemanticText(action.text),
    action.risk ?? 'unknown-risk',
  ].join('|')))
  const base = {
    schemaVersion: PAGE_SEMANTIC_FINGERPRINT_SCHEMA_VERSION,
    urlOrigin: parsed.origin,
    pathPattern: semanticPathPattern(parsed.pathname),
    ...(input.page?.pageType ? { pageType: input.page.pageType } : {}),
    ...(input.workflowStage?.trim() ? { workflowStage: normalizeSemanticText(input.workflowStage) } : {}),
    fieldSignatures,
    actionSignatures,
  }
  return {
    ...base,
    digest: createHash('sha256').update(JSON.stringify(base)).digest('hex'),
  }
}

/**
 * Similarity is intentionally conservative. An origin mismatch is a hard
 * zero; the remaining score rewards stable workflow/page identity and uses
 * Jaccard overlap for order-insensitive fields/actions.
 */
export function pageSemanticFingerprintSimilarity(
  saved: PageSemanticFingerprint,
  current: PageSemanticFingerprint,
): number {
  if (!isPageSemanticFingerprint(saved) || !isPageSemanticFingerprint(current)) return 0
  if (saved.urlOrigin !== current.urlOrigin) return 0
  if (saved.digest === current.digest) return 1

  const features: Array<{ weight: number; score: number }> = [
    { weight: 0.15, score: saved.pathPattern === current.pathPattern ? 1 : 0 },
    {
      weight: 0.1,
      score: saved.pageType && current.pageType
        ? Number(saved.pageType === current.pageType)
        : 0.5,
    },
    {
      weight: 0.1,
      score: saved.workflowStage && current.workflowStage
        ? Number(saved.workflowStage === current.workflowStage)
        : 0.5,
    },
    { weight: 0.3, score: jaccard(saved.fieldSignatures, current.fieldSignatures) },
    // Action semantics receive the largest weight: a form whose fields stayed
    // stable but whose Preview button became Submit is not the same workflow.
    { weight: 0.35, score: jaccard(saved.actionSignatures, current.actionSignatures) },
  ]
  return round(features.reduce((total, item) => total + item.weight * item.score, 0))
}

/**
 * Memory is evidence, never authority. Restrictive constraints may narrow
 * behaviour, while historical authorization is rejected before prompt
 * injection. Procedure memories remain advisory even after a fingerprint
 * match because the concrete element/action must still be observed live.
 */
export function evaluateWebMemoryGovernance(
  record: { content: unknown },
  context: WebMemoryGovernanceContext = {},
): WebMemoryGovernanceDecision {
  if (!isEvidenceBoundedWebMemory(record.content)) {
    return decision('eligible', 'generic_memory', false)
  }
  const memory = record.content
  const currentUrl = parseHttpUrl(context.currentUrl)
  const scopedOrigin = memory.applicability?.urlOrigin
  if (scopedOrigin && (!currentUrl || currentUrl.origin !== scopedOrigin)) {
    return decision('rejected', 'origin_mismatch', true)
  }
  const scopedPath = memory.applicability?.pathPattern
  if (scopedPath && (!currentUrl || semanticPathPattern(currentUrl.pathname) !== scopedPath)) {
    return decision('rejected', 'path_mismatch', true)
  }
  if (memory.applicability?.workflow) {
    if (!context.workflow || normalizeSemanticText(context.workflow) !== normalizeSemanticText(memory.applicability.workflow)) {
      return decision('rejected', 'workflow_mismatch', true)
    }
  }

  if (memory.effect === 'authorization') {
    return decision('rejected', 'historical_authorization_rejected', true)
  }
  if (memory.validation.mode === 'current_session') {
    return decision('rejected', 'current_session_required', true)
  }
  if (memory.effect === 'restrictive_constraint' && memory.validation.mode === 'none') {
    return decision('eligible', 'restrictive_constraint', false)
  }
  if (memory.effect === 'preference' && memory.validation.mode === 'none') {
    return decision('eligible', 'preference_data_only', false)
  }

  const savedFingerprint = memory.evidence.pageFingerprint
  const currentFingerprint = context.pageFingerprint
  if (!savedFingerprint || !currentFingerprint) {
    return decision('advisory', 'page_fingerprint_required', true)
  }
  const similarity = pageSemanticFingerprintSimilarity(savedFingerprint, currentFingerprint)
  const threshold = memory.validation.minFingerprintSimilarity ?? 0.8
  if (similarity < threshold) {
    return decision('rejected', 'page_fingerprint_mismatch', true, similarity)
  }
  return decision(
    memory.effect === 'procedure' ? 'advisory' : 'eligible',
    'procedure_verified_against_current_page',
    true,
    similarity,
  )
}

export function governedWebMemoryContent(
  content: EvidenceBoundedWebMemory,
  governance: WebMemoryGovernanceDecision,
): GovernedWebMemoryContext {
  return {
    schemaVersion: GOVERNED_WEB_MEMORY_CONTEXT_SCHEMA_VERSION,
    statement: content.statement,
    effect: content.effect,
    governance,
    memory: structuredClone(content),
  }
}

export function isEvidenceBoundedWebMemory(value: unknown): value is EvidenceBoundedWebMemory {
  if (!isRecord(value) || value.schemaVersion !== WEB_MEMORY_SCHEMA_VERSION) return false
  if (!['restrictive_constraint', 'preference', 'procedure', 'authorization'].includes(String(value.effect))) return false
  if (typeof value.statement !== 'string' || !value.statement.trim()) return false
  if (value.memoryKey !== undefined
    && (typeof value.memoryKey !== 'string' || !/^[a-z][a-z0-9_.-]{2,95}$/.test(value.memoryKey))) return false
  if (!isRecord(value.evidence)
    || !['user_instruction', 'user_correction', 'runtime_observation'].includes(String(value.evidence.source))
    || !validTimestamp(value.evidence.capturedAt)) return false
  if (value.evidence.pageFingerprint !== undefined
    && !isPageSemanticFingerprint(value.evidence.pageFingerprint)) return false
  for (const key of ['contentId', 'runId', 'turnId'] as const) {
    if (value.evidence[key] !== undefined && typeof value.evidence[key] !== 'string') return false
  }
  if (value.evidence.quoteHash !== undefined
    && (typeof value.evidence.quoteHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.evidence.quoteHash))) return false
  if (!isRecord(value.validation)
    || !['none', 'current_page', 'current_session'].includes(String(value.validation.mode))) return false
  if (value.validation.minFingerprintSimilarity !== undefined
    && (!Number.isFinite(value.validation.minFingerprintSimilarity)
      || Number(value.validation.minFingerprintSimilarity) < 0
      || Number(value.validation.minFingerprintSimilarity) > 1)) return false
  if (value.applicability !== undefined && !validApplicability(value.applicability)) return false
  return true
}

export function isPageSemanticFingerprint(value: unknown): value is PageSemanticFingerprint {
  if (!isRecord(value) || value.schemaVersion !== PAGE_SEMANTIC_FINGERPRINT_SCHEMA_VERSION) return false
  return typeof value.urlOrigin === 'string'
    && Boolean(parseHttpUrl(value.urlOrigin))
    && typeof value.pathPattern === 'string'
    && Array.isArray(value.fieldSignatures)
    && value.fieldSignatures.every((item) => typeof item === 'string')
    && Array.isArray(value.actionSignatures)
    && value.actionSignatures.every((item) => typeof item === 'string')
    && typeof value.digest === 'string'
    && /^[a-f0-9]{64}$/.test(value.digest)
}

export function semanticPathPattern(pathname: string): string {
  const segments = pathname.split('/').filter(Boolean).map((segment) => {
    const decoded = safeDecode(segment).toLowerCase()
    if (/^\d+$/.test(decoded)
      || /^[a-f0-9]{16,}$/i.test(decoded)
      || /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(decoded)) return ':id'
    return normalizeSemanticText(decoded).replace(/\s+/g, '-')
  })
  return `/${segments.join('/')}` || '/'
}

function decision(
  status: WebMemoryGovernanceDecision['status'],
  reasonCode: WebMemoryGovernanceReason,
  requiresLiveVerification: boolean,
  fingerprintSimilarity?: number,
): WebMemoryGovernanceDecision {
  return {
    status,
    reasonCode,
    requiresLiveVerification,
    canExpandPermissions: false,
    ...(fingerprintSimilarity === undefined ? {} : { fingerprintSimilarity }),
  }
}

function validApplicability(value: unknown): boolean {
  if (!isRecord(value)) return false
  if (value.urlOrigin !== undefined && !parseHttpUrl(String(value.urlOrigin))) return false
  if (value.pathPattern !== undefined && typeof value.pathPattern !== 'string') return false
  if (value.workflow !== undefined && typeof value.workflow !== 'string') return false
  return true
}

function parseHttpUrl(value: unknown): URL | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : undefined
  } catch {
    return undefined
  }
}

function normalizeSemanticText(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim()
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort()
}

function jaccard(left: string[], right: string[]): number {
  const a = new Set(left)
  const b = new Set(right)
  if (a.size === 0 && b.size === 0) return 1
  const union = new Set([...a, ...b])
  let intersection = 0
  for (const value of a) if (b.has(value)) intersection += 1
  return union.size === 0 ? 0 : intersection / union.size
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000
}

function validTimestamp(value: unknown): boolean {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
