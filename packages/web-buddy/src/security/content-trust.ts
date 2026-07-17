import type {
  ContentOrigin,
  ContentSensitivity,
  ContentTrust,
  Provenance,
} from '../task/contracts.js'
import type {
  ContentSecurityInput,
  ContentSecurityMetadata,
  ContextSecurityFields,
  DerivedContentSecurityInput,
  ImmutableProvenance,
  SecurityClassificationReason,
} from './types.js'

export const CONTENT_ORIGINS = Object.freeze([
  'system',
  'user',
  'web',
  'tool',
  'download',
  'artifact',
  'memory',
  'subagent',
  'derived',
] as const satisfies readonly ContentOrigin[])

export const CONTENT_TRUST_LEVELS = Object.freeze([
  'trusted_runtime',
  'user_authorized',
  'untrusted_external',
  'derived_untrusted',
  'non_authoritative',
] as const satisfies readonly ContentTrust[])

export const CONTENT_SENSITIVITY_LEVELS = Object.freeze([
  'public',
  'internal',
  'personal',
  'auth',
  'secret',
] as const satisfies readonly ContentSensitivity[])

const ORIGIN_SET = new Set<string>(CONTENT_ORIGINS)
const TRUST_SET = new Set<string>(CONTENT_TRUST_LEVELS)
const SENSITIVITY_SET = new Set<string>(CONTENT_SENSITIVITY_LEVELS)
const SENSITIVITY_RANK = new Map<ContentSensitivity, number>(
  CONTENT_SENSITIVITY_LEVELS.map((value, index) => [value, index]),
)

/**
 * Classify one source without allowing source-controlled metadata to elevate
 * authority. Missing or invalid values are converted to safe defaults and
 * surfaced through classification.status/reasons.
 */
export function classifyContentSecurity(input: ContentSecurityInput): ContentSecurityMetadata {
  const contentId = requiredContentId(input.contentId)
  const reasons: SecurityClassificationReason[] = []
  const origin = normalizeOrigin(input.origin, reasons)
  const trust = trustForOrigin(origin, input.trust, reasons)
  const sensitivity = normalizeSensitivity(input.sensitivity, reasons)
  const provenance = normalizeProvenance(input.provenance, input.now, reasons)

  return freezeMetadata({
    schemaVersion: 'content-security-metadata/v1',
    contentId,
    origin,
    trust,
    sensitivity,
    provenance,
    classification: {
      status: reasons.length > 0 ? 'fail_closed' : 'classified',
      reasons: uniqueReasons(reasons),
    },
  })
}

/**
 * Create immutable metadata for content derived from one or more parents.
 * Trust can only stay equal or lose authority; sensitivity can only stay
 * equal or increase. Parent metadata is never mutated.
 */
export function deriveContentSecurity(
  parents: readonly ContentSecurityMetadata[],
  input: DerivedContentSecurityInput,
): ContentSecurityMetadata {
  const contentId = requiredContentId(input.contentId)
  const reasons: SecurityClassificationReason[] = []
  if (parents.length === 0) reasons.push('derivation_without_parents')
  if (parents.some((parent) => parent.classification.status === 'fail_closed')) {
    reasons.push('parent_fail_closed')
  }

  const trust = derivedTrust(parents, reasons)
  const inheritedSensitivity = parents.length > 0
    ? maxSensitivity(parents.map((parent) => parent.sensitivity))
    : 'secret'
  const sensitivity = derivedSensitivity(inheritedSensitivity, input.sensitivity, reasons)
  const requestedParentIds = validParentContentIds(
    input.provenance?.parentContentIds,
    reasons,
  )
  const parentContentIds = uniqueStrings([
    ...parents.map((parent) => parent.contentId),
    ...parents.flatMap((parent) => parent.provenance.parentContentIds),
    ...requestedParentIds,
  ])
  const provenance = normalizeProvenance(
    {
      ...input.provenance,
      parentContentIds,
    },
    input.now,
    reasons,
  )

  return freezeMetadata({
    schemaVersion: 'content-security-metadata/v1',
    contentId,
    origin: 'derived',
    trust,
    sensitivity,
    provenance,
    classification: {
      status: reasons.length > 0 ? 'fail_closed' : 'classified',
      reasons: uniqueReasons(reasons),
    },
  })
}

/**
 * Return a mutable clone suitable for the frozen M1 ContextItem contract.
 * Mutating the clone cannot alter the immutable security metadata.
 */
export function toContextSecurityFields(metadata: ContentSecurityMetadata): ContextSecurityFields {
  return {
    origin: metadata.origin,
    trust: metadata.trust,
    sensitivity: metadata.sensitivity,
    provenance: {
      ...metadata.provenance,
      parentContentIds: [...metadata.provenance.parentContentIds],
    },
  }
}

function normalizeOrigin(
  candidate: unknown,
  reasons: SecurityClassificationReason[],
): ContentOrigin {
  if (typeof candidate === 'string' && ORIGIN_SET.has(candidate)) {
    return candidate as ContentOrigin
  }
  reasons.push('origin_missing_or_invalid')
  return 'derived'
}

function trustForOrigin(
  origin: ContentOrigin,
  candidate: unknown,
  reasons: SecurityClassificationReason[],
): ContentTrust {
  const requested = typeof candidate === 'string' && TRUST_SET.has(candidate)
    ? candidate as ContentTrust
    : undefined

  if (candidate !== undefined && !requested) reasons.push('trust_missing_or_invalid')

  if (origin === 'subagent') {
    if (requested && requested !== 'non_authoritative') reasons.push('trust_clamped_for_origin')
    return 'non_authoritative'
  }
  if (origin === 'web' || origin === 'tool' || origin === 'download' || origin === 'memory') {
    if (requested === 'untrusted_external' || requested === 'derived_untrusted' || requested === 'non_authoritative') return requested
    if (requested) reasons.push('trust_clamped_for_origin')
    return 'untrusted_external'
  }
  if (origin === 'artifact' || origin === 'derived') {
    if (requested === 'derived_untrusted' || requested === 'non_authoritative') return requested
    if (requested) reasons.push('trust_clamped_for_origin')
    return 'derived_untrusted'
  }
  if (origin === 'system') {
    if (requested === 'trusted_runtime') return requested
    reasons.push(requested ? 'trust_clamped_for_origin' : 'trust_missing_or_invalid')
    return 'derived_untrusted'
  }
  if (requested === 'user_authorized') return requested
  reasons.push(requested ? 'trust_clamped_for_origin' : 'trust_missing_or_invalid')
  return 'derived_untrusted'
}

function normalizeSensitivity(
  candidate: unknown,
  reasons: SecurityClassificationReason[],
): ContentSensitivity {
  if (typeof candidate === 'string' && SENSITIVITY_SET.has(candidate)) {
    return candidate as ContentSensitivity
  }
  reasons.push('sensitivity_missing_or_invalid')
  return 'secret'
}

function derivedTrust(
  parents: readonly ContentSecurityMetadata[],
  reasons: SecurityClassificationReason[],
): ContentTrust {
  if (parents.length === 0) return 'derived_untrusted'
  const levels = new Set(parents.map((parent) => parent.trust))
  if (levels.has('non_authoritative')) return 'non_authoritative'
  if (levels.size > 1 && !levels.has('untrusted_external') && !levels.has('derived_untrusted')) {
    reasons.push('mixed_authority_derivation')
  }
  return 'derived_untrusted'
}

function derivedSensitivity(
  inherited: ContentSensitivity,
  candidate: unknown,
  reasons: SecurityClassificationReason[],
): ContentSensitivity {
  if (candidate === undefined) return inherited
  if (typeof candidate !== 'string' || !SENSITIVITY_SET.has(candidate)) {
    reasons.push('sensitivity_missing_or_invalid')
    return 'secret'
  }
  const requested = candidate as ContentSensitivity
  if (sensitivityRank(requested) < sensitivityRank(inherited)) {
    reasons.push('sensitivity_downgrade_blocked')
    return inherited
  }
  return requested
}

function maxSensitivity(values: readonly ContentSensitivity[]): ContentSensitivity {
  return values.reduce<ContentSensitivity>(
    (highest, value) => sensitivityRank(value) > sensitivityRank(highest) ? value : highest,
    'public',
  )
}

function sensitivityRank(value: ContentSensitivity): number {
  return SENSITIVITY_RANK.get(value) ?? SENSITIVITY_RANK.get('secret')!
}

function normalizeProvenance(
  candidate: Partial<Provenance> | undefined,
  now: Date | undefined,
  reasons: SecurityClassificationReason[],
): ImmutableProvenance {
  const validParents = validParentContentIds(candidate?.parentContentIds, reasons)

  const capturedAt = validTimestamp(candidate?.capturedAt)
    ? new Date(candidate!.capturedAt!).toISOString()
    : (now ?? new Date()).toISOString()
  const sha256 = optionalString(candidate?.sha256)
  if (sha256 && !/^[a-f0-9]{64}$/i.test(sha256)) {
    reasons.push('provenance_sha256_invalid')
  }

  return {
    capturedAt,
    parentContentIds: uniqueStrings(validParents),
    ...(optionalString(candidate?.runId) ? { runId: optionalString(candidate?.runId) } : {}),
    ...(optionalString(candidate?.sessionId) ? { sessionId: optionalString(candidate?.sessionId) } : {}),
    ...(optionalString(candidate?.sourceUrl) ? { sourceUrl: optionalString(candidate?.sourceUrl) } : {}),
    ...(optionalString(candidate?.sourceOrigin) ? { sourceOrigin: optionalString(candidate?.sourceOrigin) } : {}),
    ...(optionalString(candidate?.toolCallId) ? { toolCallId: optionalString(candidate?.toolCallId) } : {}),
    ...(optionalString(candidate?.artifactId) ? { artifactId: optionalString(candidate?.artifactId) } : {}),
    ...(sha256 && /^[a-f0-9]{64}$/i.test(sha256) ? { sha256 } : {}),
  }
}

function freezeMetadata(
  value: {
    schemaVersion: 'content-security-metadata/v1'
    contentId: string
    origin: ContentOrigin
    trust: ContentTrust
    sensitivity: ContentSensitivity
    provenance: ImmutableProvenance
    classification: {
      status: 'classified' | 'fail_closed'
      reasons: readonly SecurityClassificationReason[]
    }
  },
): ContentSecurityMetadata {
  const provenance = Object.freeze({
    ...value.provenance,
    parentContentIds: Object.freeze([...value.provenance.parentContentIds]),
  })
  const classification = Object.freeze({
    ...value.classification,
    reasons: Object.freeze([...value.classification.reasons]),
  })
  return Object.freeze({ ...value, provenance, classification })
}

function requiredContentId(value: string): string {
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (!normalized) throw new TypeError('contentId must be a non-empty string.')
  return normalized
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function validTimestamp(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && Number.isFinite(Date.parse(value))
}

function validParentContentIds(
  value: unknown,
  reasons: SecurityClassificationReason[],
): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    reasons.push('provenance_parent_ids_invalid')
    return []
  }
  const valid = value.filter(
    (item): item is string => typeof item === 'string' && item.trim().length > 0,
  )
  if (valid.length !== value.length) reasons.push('provenance_parent_ids_invalid')
  return valid
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))]
}

function uniqueReasons(
  values: readonly SecurityClassificationReason[],
): SecurityClassificationReason[] {
  return [...new Set(values)]
}
