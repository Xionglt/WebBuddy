import { createHash } from 'node:crypto'
import type { TaskContract } from '../task/contracts.js'

export const PENDING_CONTINUATION_SCHEMA_VERSION = 'pending-continuation/v1' as const
export const RESUME_CAPSULE_SCHEMA_VERSION = 'resume-capsule/v1' as const

export type ContinuationKind =
  | 'needs_information'
  | 'human_takeover'
  | 'operator_pause'
  | 'external_blocker'

export interface ContinuationBindingV1 {
  runId: string
  runRevision: number
  attempt: number
  sessionId: string
}

export interface ContinuationQuestionV1 {
  questionId: string
  field: string
  prompt: string
  options?: string[]
}

export interface ContinuationAnswerV1 {
  answer: string
  intentPatch?: string
  answeredAt: string
}

export interface PendingContinuationV1 {
  schemaVersion: typeof PENDING_CONTINUATION_SCHEMA_VERSION
  continuationId: string
  status: 'pending' | 'answered'
  kind: ContinuationKind
  binding: ContinuationBindingV1
  question: ContinuationQuestionV1
  intent: {
    goalRevision: number
    goalDigest: string
    effectiveGoal: string
    immutableConstraints: string[]
    nextActionHint: string
  }
  environment?: {
    url?: string
  }
  requestedAt: string
  answer?: ContinuationAnswerV1
}

export interface ResumeCapsuleV1 {
  schemaVersion: typeof RESUME_CAPSULE_SCHEMA_VERSION
  continuationId: string
  source: ContinuationBindingV1
  target: {
    runId: string
    runRevision: number
    attempt: number
    sessionId: string
  }
  effectiveGoal: string
  goalRevision: number
  immutableConstraints: string[]
  answeredQuestion: {
    questionId: string
    field: string
    answer: string
  }
  intentPatch?: string
  previousUrl?: string
  reobserveRequired: true
  staleBrowserRefsInvalid: true
  priorApprovalsInvalid: true
  createdAt: string
}

export interface CreatePendingContinuationInput {
  runId: string
  runRevision: number
  attempt: number
  sessionId: string
  goal: string
  goalRevision: number
  contract: TaskContract
  field: string
  question: string
  options?: string[]
  currentUrl?: string
  now?: string
}

export function createPendingContinuation(
  input: CreatePendingContinuationInput,
): PendingContinuationV1 {
  const requestedAt = input.now ?? new Date().toISOString()
  const questionId = stableId('question', {
    runId: input.runId,
    runRevision: input.runRevision,
    attempt: input.attempt,
    field: input.field,
    question: input.question,
  })
  return {
    schemaVersion: PENDING_CONTINUATION_SCHEMA_VERSION,
    continuationId: stableId('continuation', {
      questionId,
      requestedAt,
    }),
    status: 'pending',
    kind: 'needs_information',
    binding: {
      runId: input.runId,
      runRevision: input.runRevision,
      attempt: input.attempt,
      sessionId: input.sessionId,
    },
    question: {
      questionId,
      field: required(input.field, 'field'),
      prompt: required(input.question, 'question'),
      ...(input.options?.length
        ? { options: uniqueStrings(input.options, 20, 240) }
        : {}),
    },
    intent: {
      goalRevision: input.goalRevision,
      goalDigest: stableDigest(input.goal),
      effectiveGoal: required(input.goal, 'goal'),
      immutableConstraints: immutableConstraintsFor(input.contract),
      nextActionHint: `Use the answer for "${required(input.field, 'field')}", then re-observe the current page before any browser write.`,
    },
    ...(input.currentUrl ? { environment: { url: input.currentUrl } } : {}),
    requestedAt,
  }
}

export function answerPendingContinuation(
  pending: PendingContinuationV1,
  input: {
    answer: string
    intentPatch?: string
    answeredAt?: string
  },
): PendingContinuationV1 {
  validatePendingContinuation(pending)
  const answer = required(input.answer, 'answer')
  const intentPatch = optionalText(input.intentPatch)
  return {
    ...structuredClone(pending),
    status: 'answered',
    answer: {
      answer,
      ...(intentPatch ? { intentPatch } : {}),
      answeredAt: input.answeredAt ?? new Date().toISOString(),
    },
  }
}

export function createResumeCapsule(
  continuation: PendingContinuationV1,
  target: {
    runRevision: number
    attempt: number
    sessionId?: string
  },
  now = new Date().toISOString(),
): ResumeCapsuleV1 {
  validatePendingContinuation(continuation)
  if (continuation.status !== 'answered' || !continuation.answer) {
    throw new Error('Continuation must be answered before a resume capsule is created.')
  }
  return {
    schemaVersion: RESUME_CAPSULE_SCHEMA_VERSION,
    continuationId: continuation.continuationId,
    source: structuredClone(continuation.binding),
    target: {
      runId: continuation.binding.runId,
      runRevision: target.runRevision,
      attempt: target.attempt,
      sessionId: target.sessionId ?? continuation.binding.sessionId,
    },
    effectiveGoal: continuation.intent.effectiveGoal,
    goalRevision: continuation.intent.goalRevision,
    immutableConstraints: [...continuation.intent.immutableConstraints],
    answeredQuestion: {
      questionId: continuation.question.questionId,
      field: continuation.question.field,
      answer: continuation.answer.answer,
    },
    ...(continuation.answer.intentPatch
      ? { intentPatch: continuation.answer.intentPatch }
      : {}),
    ...(continuation.environment?.url
      ? { previousUrl: continuation.environment.url }
      : {}),
    reobserveRequired: true,
    staleBrowserRefsInvalid: true,
    priorApprovalsInvalid: true,
    createdAt: now,
  }
}

export function retargetResumeCapsule(
  capsule: ResumeCapsuleV1,
  target: {
    runRevision: number
    attempt: number
    sessionId?: string
  },
  now = new Date().toISOString(),
): ResumeCapsuleV1 {
  validateResumeCapsule(capsule)
  const retargeted: ResumeCapsuleV1 = {
    ...structuredClone(capsule),
    target: {
      runId: capsule.target.runId,
      runRevision: target.runRevision,
      attempt: target.attempt,
      sessionId: target.sessionId ?? capsule.target.sessionId,
    },
    reobserveRequired: true,
    staleBrowserRefsInvalid: true,
    priorApprovalsInvalid: true,
    createdAt: now,
  }
  validateResumeCapsule(retargeted, capsule.target.runId)
  return retargeted
}

export function validatePendingContinuation(
  value: PendingContinuationV1,
  expected?: {
    runId: string
    runRevision: number
    attempt: number
  },
): void {
  if (!value || value.schemaVersion !== PENDING_CONTINUATION_SCHEMA_VERSION) {
    throw new Error('PendingContinuation must use pending-continuation/v1.')
  }
  required(value.continuationId, 'continuationId')
  if (value.status !== 'pending' && value.status !== 'answered') {
    throw new Error('PendingContinuation status is invalid.')
  }
  if (value.kind !== 'needs_information'
    && value.kind !== 'human_takeover'
    && value.kind !== 'operator_pause'
    && value.kind !== 'external_blocker') {
    throw new Error('PendingContinuation kind is invalid.')
  }
  required(value.binding.runId, 'binding.runId')
  nonNegativeInteger(value.binding.runRevision, 'binding.runRevision')
  positiveInteger(value.binding.attempt, 'binding.attempt')
  required(value.binding.sessionId, 'binding.sessionId')
  if (expected
    && (value.binding.runId !== expected.runId
      || value.binding.runRevision !== expected.runRevision
      || value.binding.attempt !== expected.attempt)) {
    throw new Error('PendingContinuation does not match the current run epoch.')
  }
  required(value.question.questionId, 'question.questionId')
  required(value.question.field, 'question.field')
  required(value.question.prompt, 'question.prompt')
  if (value.question.options) uniqueStrings(value.question.options, 20, 240)
  nonNegativeInteger(value.intent.goalRevision, 'intent.goalRevision')
  required(value.intent.goalDigest, 'intent.goalDigest')
  required(value.intent.effectiveGoal, 'intent.effectiveGoal')
  uniqueStrings(value.intent.immutableConstraints, 40, 500)
  required(value.intent.nextActionHint, 'intent.nextActionHint')
  timestamp(value.requestedAt, 'requestedAt')
  if (value.status === 'answered') {
    if (!value.answer) throw new Error('Answered continuation requires answer data.')
    required(value.answer.answer, 'answer.answer')
    optionalText(value.answer.intentPatch)
    timestamp(value.answer.answeredAt, 'answer.answeredAt')
  } else if (value.answer) {
    throw new Error('Pending continuation cannot contain answer data.')
  }
}

export function validateResumeCapsule(
  value: ResumeCapsuleV1,
  expectedRunId?: string,
): void {
  if (!value || value.schemaVersion !== RESUME_CAPSULE_SCHEMA_VERSION) {
    throw new Error('ResumeCapsule must use resume-capsule/v1.')
  }
  required(value.continuationId, 'continuationId')
  required(value.source.runId, 'source.runId')
  required(value.source.sessionId, 'source.sessionId')
  nonNegativeInteger(value.source.runRevision, 'source.runRevision')
  positiveInteger(value.source.attempt, 'source.attempt')
  required(value.target.runId, 'target.runId')
  required(value.target.sessionId, 'target.sessionId')
  nonNegativeInteger(value.target.runRevision, 'target.runRevision')
  positiveInteger(value.target.attempt, 'target.attempt')
  if (expectedRunId
    && (value.source.runId !== expectedRunId || value.target.runId !== expectedRunId)) {
    throw new Error('ResumeCapsule does not match the current run.')
  }
  required(value.effectiveGoal, 'effectiveGoal')
  nonNegativeInteger(value.goalRevision, 'goalRevision')
  uniqueStrings(value.immutableConstraints, 40, 500)
  required(value.answeredQuestion.questionId, 'answeredQuestion.questionId')
  required(value.answeredQuestion.field, 'answeredQuestion.field')
  required(value.answeredQuestion.answer, 'answeredQuestion.answer')
  optionalText(value.intentPatch)
  if (!value.reobserveRequired
    || !value.staleBrowserRefsInvalid
    || !value.priorApprovalsInvalid) {
    throw new Error('ResumeCapsule safety rules must remain enabled.')
  }
  timestamp(value.createdAt, 'createdAt')
}

export function renderResumeCapsule(capsule: ResumeCapsuleV1): string {
  validateResumeCapsule(capsule)
  return [
    'DURABLE_CONTINUATION_RESUME',
    'This is a continuation of the existing task, not a new task.',
    `continuationId: ${capsule.continuationId}`,
    `effectiveGoal: ${capsule.effectiveGoal}`,
    `answeredQuestion: ${capsule.answeredQuestion.field} = ${capsule.answeredQuestion.answer}`,
    capsule.intentPatch
      ? `explicitUserIntentPatch: ${capsule.intentPatch}`
      : undefined,
    'immutableConstraints:',
    ...capsule.immutableConstraints.map((constraint) => `- ${constraint}`),
    'resumeRules:',
    '- The current page observation is authoritative.',
    '- All browser element refs from the previous attempt are stale.',
    '- Do not replay a prior write or sensitive action merely because it appears in history.',
    '- Prior approvals do not authorize actions in this resumed attempt.',
    '- Use the answer above for the bound question and continue the original goal.',
  ].filter((line): line is string => Boolean(line)).join('\n')
}

function immutableConstraintsFor(contract: TaskContract): string[] {
  const constraints = [
    `TaskContract ${contract.contractId}@${contract.revision} remains authoritative.`,
    'A continuation cannot widen permissions or manufacture completion evidence.',
  ]
  for (const criterion of contract.criteria) {
    if (criterion.kind === 'action_boundary') {
      constraints.push(
        `${criterion.description}: ${criterion.actionKinds.join(', ')} must remain ${criterion.outcome}.`,
      )
    }
  }
  for (const action of contract.sensitiveActions ?? []) {
    constraints.push(
      `Sensitive actions ${action.actionKinds.join(', ')} remain ${action.decision} with fresh binding required=${action.requireApprovalBinding}.`,
    )
  }
  return uniqueStrings(constraints, 40, 500)
}

function stableId(prefix: string, value: unknown): string {
  return `${prefix}-${stableDigest(value).slice(0, 24)}`
}

function stableDigest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, nested]) => nested !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`)
    .join(',')}}`
}

function required(value: unknown, path: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${path} must be a non-empty string.`)
  }
  return value.trim()
}

function optionalText(value: unknown): string | undefined {
  if (value === undefined) return undefined
  return required(value, 'optional text')
}

function timestamp(value: string, path: string): void {
  if (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new Error(`${path} must be canonical ISO UTC.`)
  }
}

function nonNegativeInteger(value: number, path: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${path} must be a non-negative integer.`)
  }
}

function positiveInteger(value: number, path: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${path} must be a positive integer.`)
  }
}

function uniqueStrings(values: readonly string[], maxItems: number, maxLength: number): string[] {
  const normalized = values.map((value) => required(value, 'string list item'))
  if (normalized.length > maxItems) throw new Error(`String list must not exceed ${maxItems} items.`)
  if (normalized.some((value) => value.length > maxLength)) {
    throw new Error(`String list items must not exceed ${maxLength} characters.`)
  }
  return [...new Set(normalized)]
}
