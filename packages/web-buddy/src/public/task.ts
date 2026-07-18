import {
  runWebTask as runInternalWebTask,
} from '../sdk/web-task.js'
import {
  snapshotWebTaskInput as snapshotInternalWebTaskInput,
  type WebTaskInput as InternalWebTaskInput,
  type WebTaskResult as InternalWebTaskResult,
} from '../task/contracts.js'
import type {
  ActionBinding,
  ArtifactRef,
  CheckpointRef,
  CompletionCriterion,
  ContentOrigin,
  ContentSensitivity,
  ContentTrust,
  ContextItem,
  ContextProvider,
  EvidenceRef,
  EvidenceRequirement,
  JsonObject,
  JsonValue,
  OwnerScope,
  RunMetrics,
  SensitiveActionRule,
  SessionRef,
  TaskContract,
  TaskGoal,
  TaskPolicy,
  WebTaskEvent,
  WebTaskInputSnapshot,
  WebTaskResult,
} from './contracts.js'

export const PUBLIC_SDK_VERSION = '1.0.0' as const
export const PUBLIC_WEB_TASK_INPUT_SCHEMA_VERSION = 'web-task-input/v1' as const
export const PUBLIC_POLICY_HOOK_REQUEST_SCHEMA_VERSION = 'public-policy-hook-request/v1' as const
export const PUBLIC_POLICY_HOOK_DECISION_SCHEMA_VERSION = 'public-policy-hook-decision/v1' as const

export const PUBLIC_SCHEMA_COMPATIBILITY = Object.freeze({
  schemaVersion: 'public-schema-compatibility/v1',
  sdkVersion: PUBLIC_SDK_VERSION,
  policy: 'reject_unknown_major',
  supported: Object.freeze([
    'web-task-input/v1',
    'web-task-contract/v1',
    'web-task-result/v1',
    'context-item/v1',
    'context-provider-request/v1',
    'task-policy/v1',
    'agent-role/v1',
    'public-policy-hook-request/v1',
    'public-policy-hook-decision/v1',
  ]),
} as const)

export type PublicContractErrorCode =
  | 'INVALID_CONTRACT'
  | 'UNSUPPORTED_SCHEMA_VERSION'
  | 'SCOPE_MISMATCH'
  | 'QUOTA_EXCEEDED'
  | 'TRANSPORT_ERROR'

export class PublicContractError extends Error {
  readonly code: PublicContractErrorCode

  constructor(code: PublicContractErrorCode, message: string) {
    super(message)
    this.name = 'PublicContractError'
    this.code = code
  }
}

/**
 * Stable execution options. The internal runtime driver and trace filesystem
 * paths are deliberately absent from the public boundary.
 */
export interface WebTaskRunOptions {
  maxSteps?: number
  headless?: boolean
}

export interface WebTaskInput {
  schemaVersion: typeof PUBLIC_WEB_TASK_INPUT_SCHEMA_VERSION
  goal: TaskGoal
  contract: TaskContract
  startUrl?: string
  contextItems?: ContextItem[]
  contextProviders?: ContextProvider[]
  policy?: TaskPolicy
  runtime?: WebTaskRunOptions
  runId?: string
  sessionRef?: SessionRef
  revision?: number
  ownerScope?: OwnerScope
  onEvent?: (event: WebTaskEvent) => void
}

export async function runWebTask(input: WebTaskInput): Promise<WebTaskResult> {
  return projectWebTaskResult(await runInternalWebTask(toInternalInput(input)))
}

export function snapshotWebTaskInput(
  input: WebTaskInput,
  resolvedRunId?: string,
): WebTaskInputSnapshot {
  return snapshotInternalWebTaskInput(
    toInternalInput(input),
    resolvedRunId,
  ) as WebTaskInputSnapshot
}

/**
 * Hooks may tighten a decision but cannot mint an allow. Hosts run them after
 * baseline policy classification and before the sensitive action.
 */
export interface PolicyHookRequest {
  schemaVersion: typeof PUBLIC_POLICY_HOOK_REQUEST_SCHEMA_VERSION
  runId: string
  revision: number
  action: ActionBinding
  sourceContentIds: string[]
  sourceSensitivities: ContentSensitivity[]
  destinationOrigin?: string
  metadata?: JsonObject
}

export interface PolicyHookDecision {
  schemaVersion: typeof PUBLIC_POLICY_HOOK_DECISION_SCHEMA_VERSION
  decision: 'no_change' | 'ask' | 'deny'
  reason: string
  auditTags: string[]
}

export interface PolicyHook {
  id: string
  version: string
  evaluate(request: Readonly<PolicyHookRequest>): PolicyHookDecision | Promise<PolicyHookDecision>
}

export function validatePolicyHookDecision(value: unknown): asserts value is PolicyHookDecision {
  if (!isPlainObject(value)) invalid('PolicyHookDecision must be a plain object.')
  closedKeys(value, ['schemaVersion', 'decision', 'reason', 'auditTags'], 'PolicyHookDecision')
  if (value.schemaVersion !== PUBLIC_POLICY_HOOK_DECISION_SCHEMA_VERSION) unsupported('PolicyHookDecision')
  if (value.decision !== 'no_change' && value.decision !== 'ask' && value.decision !== 'deny') {
    invalid('PolicyHookDecision cannot grant allow authority.')
  }
  nonEmpty(value.reason, 'PolicyHookDecision.reason')
  stringArray(value.auditTags, 'PolicyHookDecision.auditTags')
}

export type {
  ActionBinding,
  ArtifactRef,
  CheckpointRef,
  CompletionCriterion,
  ContentOrigin,
  ContentSensitivity,
  ContentTrust,
  ContextItem,
  ContextProvider,
  EvidenceRef,
  EvidenceRequirement,
  JsonObject,
  JsonValue,
  OwnerScope,
  RunMetrics,
  SensitiveActionRule,
  SessionRef,
  TaskContract,
  TaskGoal,
  TaskPolicy,
  WebTaskEvent,
  WebTaskInputSnapshot,
  WebTaskResult,
}

function toInternalInput(input: WebTaskInput): InternalWebTaskInput {
  if (!isPlainObject(input)) invalid('WebTaskInput must be a plain object.')
  if (input.schemaVersion !== PUBLIC_WEB_TASK_INPUT_SCHEMA_VERSION) unsupported('WebTaskInput')
  return {
    ...input,
    ...(input.runtime
      ? {
          runtime: {
            ...(input.runtime.maxSteps !== undefined ? { maxSteps: input.runtime.maxSteps } : {}),
            ...(input.runtime.headless !== undefined ? { headless: input.runtime.headless } : {}),
          },
        }
      : {}),
  } as InternalWebTaskInput
}

function projectWebTaskResult(result: InternalWebTaskResult): WebTaskResult {
  return {
    schemaVersion: 'web-task-result/v1',
    runId: result.runId,
    revision: result.revision,
    status: result.status,
    summary: result.summary,
    evidence: structuredClone(result.evidence) as EvidenceRef[],
    artifacts: structuredClone(result.artifacts) as ArtifactRef[],
    metrics: projectRunMetrics(result.metrics),
    ...(result.sessionRef ? { sessionRef: structuredClone(result.sessionRef) as SessionRef } : {}),
    ...(result.checkpointRef ? { checkpointRef: structuredClone(result.checkpointRef) as CheckpointRef } : {}),
    ...(result.ownerScope ? { ownerScope: structuredClone(result.ownerScope) as OwnerScope } : {}),
  }
}

function projectRunMetrics(metrics: InternalWebTaskResult['metrics']): RunMetrics {
  return {
    schemaVersion: 'run-metrics/v1',
    generatedAt: metrics.generatedAt,
    ...(metrics.runId ? { runId: metrics.runId } : {}),
    ...(metrics.sessionId ? { sessionId: metrics.sessionId } : {}),
    source: metrics.source,
    ...(metrics.scenario ? { scenario: metrics.scenario } : {}),
    ...(metrics.profile ? { profile: metrics.profile } : {}),
    status: metrics.status,
    durationMs: metrics.durationMs,
    llmCalls: metrics.llmCalls,
    toolCalls: metrics.toolCalls,
    warnings: [...metrics.warnings],
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function closedKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const keys = new Set(allowed)
  for (const key of Object.keys(value)) {
    if (!keys.has(key)) invalid(`${label} contains unsupported field ${key}.`)
  }
}

function nonEmpty(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.trim() !== value || value.length === 0) {
    invalid(`${label} must be a non-empty string.`)
  }
}

function stringArray(value: unknown, label: string): asserts value is string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.length === 0)) {
    invalid(`${label} must be a string array.`)
  }
}

function invalid(message: string): never {
  throw new PublicContractError('INVALID_CONTRACT', message)
}

function unsupported(label: string): never {
  throw new PublicContractError('UNSUPPORTED_SCHEMA_VERSION', `${label} schema version is not supported.`)
}
