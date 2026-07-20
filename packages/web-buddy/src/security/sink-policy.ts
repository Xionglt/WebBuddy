import {
  consumeApprovalBinding,
  digestCanonicalJson,
  validateActionBinding,
  type ActionBinding,
  type ApprovalBinding,
  type ContentOrigin,
  type ContentSensitivity,
  type ContentTrust,
  type ContextItem,
  type SensitiveActionKind,
  type TaskPolicy,
} from '../task/contracts.js'
import { redactSensitiveData, type RedactionResult } from './redaction.js'

export type SinkPolicyReasonCode =
  | 'not_sensitive'
  | 'policy_denied'
  | 'approval_required'
  | 'approval_invalid'
  | 'destination_missing'
  | 'destination_not_allowed'
  | 'binding_mismatch'
  | 'secret_egress_blocked'
  | 'untrusted_memory_write_blocked'

export interface SinkPolicyDecision {
  schemaVersion: 'sink-policy-decision/v1'
  action: 'allow' | 'ask' | 'deny'
  reasonCode: SinkPolicyReasonCode
  reason: string
  actionKind: SensitiveActionKind
  sourceContentIds: string[]
  sourceSensitivities: ContentSensitivity[]
  destinationOrigin?: string
  redaction: RedactionResult
  consumedApproval?: ApprovalBinding
}

export interface SinkPolicyInput {
  actionKind: SensitiveActionKind
  runId: string
  revision: number
  policy?: TaskPolicy
  sourceItems?: ReadonlyArray<Pick<ContextItem, 'id' | 'origin' | 'trust' | 'sensitivity'>>
  payload?: unknown
  sourceOrigin?: string
  destinationOrigin?: string
  actionBinding?: ActionBinding
  approvalBinding?: ApprovalBinding
  consumedApprovalNonces?: Set<string>
  now?: Date
}

const DESTINATION_ACTIONS = new Set<SensitiveActionKind>([
  'navigate',
  'type_or_paste',
  'upload',
  'send',
  'publish',
  'submit',
  'payment',
])

export function evaluateSinkPolicy(input: SinkPolicyInput): SinkPolicyDecision {
  const sourceItems = input.sourceItems ?? []
  const sourceContentIds = sourceItems.map((item) => item.id)
  const sourceSensitivities = unique(sourceItems.map((item) => item.sensitivity))
  const redaction = redactSensitiveData(input.payload ?? null)
  const base = {
    schemaVersion: 'sink-policy-decision/v1' as const,
    actionKind: input.actionKind,
    sourceContentIds,
    sourceSensitivities,
    ...(input.destinationOrigin ? { destinationOrigin: input.destinationOrigin } : {}),
    redaction,
  }

  if (DESTINATION_ACTIONS.has(input.actionKind) && !validOrigin(input.destinationOrigin)) {
    return deny(base, 'destination_missing', 'Sensitive destination must be an explicit absolute origin.')
  }
  if (input.actionKind === 'memory_write' && sourceItems.some(isUntrustedSource)) {
    return deny(base, 'untrusted_memory_write_blocked', 'Untrusted web/tool/download/memory/subagent content cannot enter reusable memory.')
  }
  if (sourceItems.some((item) => item.sensitivity === 'secret' || item.sensitivity === 'auth') || redaction.changed) {
    return deny(base, 'secret_egress_blocked', 'Secret/auth material and detected credentials cannot cross a sensitive sink.')
  }

  const rule = matchingRule(input.policy, input.actionKind, sourceSensitivities, input.destinationOrigin)
  const policyDecision = rule?.decision ?? input.policy?.defaultSensitiveAction ?? 'deny'
  if (rule?.destinationOrigins?.length && !rule.destinationOrigins.includes(input.destinationOrigin!)) {
    return deny(base, 'destination_not_allowed', 'Destination origin is outside the matched TaskPolicy rule.')
  }
  if (policyDecision === 'deny') {
    return deny(
      base,
      'policy_denied',
      input.policy
        ? `TaskPolicy denied ${input.actionKind}.`
        : `No TaskPolicy was supplied; the fail-closed default denied ${input.actionKind}.`,
    )
  }
  if (!input.actionBinding || !input.approvalBinding) {
    return {
      ...base,
      action: 'ask',
      reasonCode: 'approval_required',
      reason: `TaskPolicy requires an exact approval for ${input.actionKind}.`,
    }
  }

  try {
    validateSinkBinding(input, sourceContentIds)
    const consumed = consumeApprovalBinding(
      input.actionBinding,
      input.approvalBinding,
      input.consumedApprovalNonces ?? new Set<string>(),
      input.now ?? new Date(),
    )
    return {
      ...base,
      action: 'allow',
      reasonCode: 'not_sensitive',
      reason: 'Exact action/origin/revision-bound approval was consumed.',
      consumedApproval: consumed,
    }
  } catch (error) {
    return deny(
      base,
      error instanceof Error && /bind|match/i.test(error.message) ? 'binding_mismatch' : 'approval_invalid',
      `Approval rejected: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

export function evaluateRedirectPolicy(
  input: Omit<SinkPolicyInput, 'actionKind' | 'destinationOrigin'> & {
    approvedDestinationOrigin: string
    redirectedDestinationOrigin: string
  },
): SinkPolicyDecision {
  return evaluateSinkPolicy({
    ...input,
    actionKind: 'navigate',
    destinationOrigin: input.redirectedDestinationOrigin,
  })
}

export function createSinkActionBinding(input: {
  contractId: string
  revision: number
  runId: string
  actionId: string
  toolName: string
  args: Record<string, unknown>
  sourceItems?: ReadonlyArray<Pick<ContextItem, 'id' | 'sensitivity'>>
  sourceOrigin?: string
  destinationOrigin?: string
  actionSeq: number
  expiresAt: string
}): ActionBinding {
  const binding: ActionBinding = {
    schemaVersion: 'action-binding/v1',
    contractId: input.contractId,
    contractRevision: input.revision,
    runId: input.runId,
    actionId: input.actionId,
    toolName: input.toolName,
    argsSha256: digestCanonicalJson(input.args),
    sourceContentIds: (input.sourceItems ?? []).map((item) => item.id),
    sourceSensitiveClasses: sensitiveClasses((input.sourceItems ?? []).map((item) => item.sensitivity)),
    ...(input.sourceOrigin ? { sourceOrigin: input.sourceOrigin } : {}),
    ...(input.destinationOrigin ? { destinationOrigin: input.destinationOrigin } : {}),
    actionSeq: input.actionSeq,
    expiresAt: input.expiresAt,
  }
  validateActionBinding(binding, input.runId, input.revision)
  return binding
}

export function sensitiveActionKindForTool(
  toolName: string,
  gateKind?: string,
): SensitiveActionKind | undefined {
  if (toolName === 'browser_open') return 'navigate'
  if (/upload/i.test(toolName)) return 'upload'
  if (/type|fill|paste|select/i.test(toolName)) return 'type_or_paste'
  if (/payment|purchase|checkout/i.test(toolName)) return 'payment'
  if (/publish|post/i.test(toolName)) return 'publish'
  if (/send|message|email/i.test(toolName)) return 'send'
  if (gateKind === 'final_submit' || /submit/i.test(toolName)) return 'submit'
  if (/memory.*write|remember/i.test(toolName)) return 'memory_write'
  if (/permission.*write/i.test(toolName)) return 'permission_write'
  return undefined
}

export function destinationOriginForTool(
  toolName: string,
  args: Record<string, unknown>,
  currentUrl?: string,
): string | undefined {
  const candidate = toolName === 'browser_open' && typeof args.url === 'string'
    ? args.url
    : currentUrl
  if (!candidate) return undefined
  try {
    return new URL(candidate).origin
  } catch {
    return undefined
  }
}

function validateSinkBinding(input: SinkPolicyInput, sourceContentIds: string[]): void {
  const binding = input.actionBinding!
  validateActionBinding(binding, input.runId, input.revision)
  if (binding.argsSha256 !== digestCanonicalJson(input.payload ?? null)) {
    throw new Error('Action binding does not match the exact final executable payload.')
  }
  if (binding.sourceOrigin !== input.sourceOrigin
    || binding.destinationOrigin !== input.destinationOrigin
    || !sameSet(binding.sourceContentIds, sourceContentIds)) {
    throw new Error('Action binding does not match exact source content and origin/destination.')
  }
}

function matchingRule(
  policy: TaskPolicy | undefined,
  actionKind: SensitiveActionKind,
  sensitivities: ContentSensitivity[],
  destinationOrigin: string | undefined,
) {
  return policy?.rules.find((rule) =>
    rule.actionKinds.includes(actionKind)
    && (!rule.sourceSensitivities?.length || sensitivities.some((value) => rule.sourceSensitivities!.includes(value)))
    && (!rule.destinationOrigins?.length || Boolean(destinationOrigin)),
  )
}

function isUntrustedSource(item: {
  origin: ContentOrigin
  trust: ContentTrust
}): boolean {
  return ['web', 'tool', 'download', 'memory', 'subagent'].includes(item.origin)
    || item.trust === 'untrusted_external'
    || item.trust === 'derived_untrusted'
    || item.trust === 'non_authoritative'
}

function validOrigin(value: string | undefined): boolean {
  if (!value) return false
  try {
    return new URL(value).origin === value
  } catch {
    return false
  }
}

function deny(
  base: Omit<SinkPolicyDecision, 'action' | 'reasonCode' | 'reason'>,
  reasonCode: SinkPolicyReasonCode,
  reason: string,
): SinkPolicyDecision {
  return { ...base, action: 'deny', reasonCode, reason }
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)]
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value) => right.includes(value))
}

function sensitiveClasses(values: readonly ContentSensitivity[]) {
  const classes = new Set<'identity' | 'token'>()
  if (values.includes('personal')) classes.add('identity')
  if (values.includes('auth') || values.includes('secret')) classes.add('token')
  return [...classes]
}
