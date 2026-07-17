import type {
  ContentOrigin,
  ContentSensitivity,
  ContentTrust,
  ContextItem,
  Provenance,
} from '../task/contracts.js'

export type SecurityOrigin = ContentOrigin
export type SecurityTrust = ContentTrust
export type SecuritySensitivity = ContentSensitivity

export type ImmutableProvenance = Readonly<
  Omit<Provenance, 'parentContentIds'> & {
    parentContentIds: readonly string[]
  }
>

export type SecurityClassificationReason =
  | 'origin_missing_or_invalid'
  | 'trust_missing_or_invalid'
  | 'trust_clamped_for_origin'
  | 'sensitivity_missing_or_invalid'
  | 'sensitivity_downgrade_blocked'
  | 'provenance_parent_ids_invalid'
  | 'provenance_sha256_invalid'
  | 'derivation_without_parents'
  | 'mixed_authority_derivation'
  | 'parent_fail_closed'

export interface ContentSecurityMetadata {
  readonly schemaVersion: 'content-security-metadata/v1'
  readonly contentId: string
  readonly origin: SecurityOrigin
  readonly trust: SecurityTrust
  readonly sensitivity: SecuritySensitivity
  readonly provenance: ImmutableProvenance
  readonly classification: Readonly<{
    status: 'classified' | 'fail_closed'
    reasons: readonly SecurityClassificationReason[]
  }>
}

export interface ContentSecurityInput {
  contentId: string
  origin?: unknown
  trust?: unknown
  sensitivity?: unknown
  provenance?: Partial<Provenance>
  now?: Date
}

export interface DerivedContentSecurityInput {
  contentId: string
  sensitivity?: unknown
  provenance?: Partial<Provenance>
  now?: Date
}

export type ContextSecurityFields = Pick<
  ContextItem,
  'origin' | 'trust' | 'sensitivity' | 'provenance'
>
