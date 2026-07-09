import { CompletionResumeService, type CompletionResumeResult } from '../workflow/completion-resume.js'
import { createUserConfirmation, type UserConfirmation } from '../workflow/user-confirmation.js'
import type { AgentSession, SessionStore } from './session-types.js'
import { FileSessionRecorder } from './session-recorder.js'
import { restoreSessionState, type RestoredSessionState } from './session-restore.js'

type RecorderTranscriptInput = Parameters<FileSessionRecorder['transcript']>[0]

export interface ConfirmSessionCompletionInput {
  store: SessionStore
  sessionId: string
  message: string
  confirmedBy: 'user'
  now?: string
}

export interface ConfirmSessionCompletionResult {
  schemaVersion: 'confirm-session-completion-result/v1'
  status: 'completed' | 'blocked'
  reason: string
  session: AgentSession
  restored: RestoredSessionState
  confirmation: UserConfirmation
  completion: CompletionResumeResult
}

export async function confirmSessionCompletion(
  input: ConfirmSessionCompletionInput,
): Promise<ConfirmSessionCompletionResult> {
  assertConfirmSessionCompletionInput(input)

  const now = input.now ?? new Date().toISOString()
  const session = await input.store.get(input.sessionId)
  if (!session) throw new Error(`Session not found: ${input.sessionId}`)
  assertSessionCanBeRechecked(session)

  const recorder = new FileSessionRecorder(input.store, session)
  const restored = await restoreSessionState({ session, now })

  await recorder.event({
    type: 'session_restored',
    message: 'Session restored for completion recheck.',
    data: restoredSessionMetadata(restored),
  })

  const confirmation = createUserConfirmation({
    sessionId: session.sessionId,
    runId: session.runId,
    confirmedBy: input.confirmedBy,
    scope: 'completion',
    message: input.message,
    ...(restoredWorkflowPhase(restored) ? { workflowPhase: restoredWorkflowPhase(restored) } : {}),
    ts: now,
    metadata: {
      restoredAt: restored.restoredAt,
      transcriptCount: restored.transcriptCount,
    },
  })

  await recorder.transcript({
    type: 'user_confirmation',
    confirmation,
  } as RecorderTranscriptInput)
  await recorder.event({
    type: 'user_confirmed',
    message: 'User confirmed workflow completion.',
    data: {
      confirmationId: confirmation.id,
      evidenceId: confirmation.evidence.id,
      confirmedBy: confirmation.confirmedBy,
      scope: confirmation.scope,
      workflowPhase: confirmation.workflowPhase,
    },
  })

  const completion = CompletionResumeService.evaluate({
    restored,
    confirmation,
    now,
  })

  await recorder.transcript({
    type: 'workflow_evidence',
    evidence: confirmation.evidence,
  } as RecorderTranscriptInput)
  await recorder.transcript({
    type: 'workflow_evaluation',
    evaluation: completion.workflowEvaluation,
  } as RecorderTranscriptInput)
  await recorder.transcript({
    type: 'completion_gate',
    decision: completion.completionGateDecision,
  } as RecorderTranscriptInput)
  await recorder.event({
    type: 'session_completion_rechecked',
    message: `Session completion rechecked: ${completion.status}.`,
    data: completionRecheckedMetadata(completion, confirmation),
  })

  const finalResult = finalResultPayload(completion, confirmation, restored)
  await recorder.transcript({
    type: 'final_result',
    status: completion.status,
    result: finalResult,
    reason: completion.reason,
  } as RecorderTranscriptInput)

  if (completion.status === 'completed') {
    await recorder.updateStatus('completed', {
      updatedAt: now,
      completedAt: now,
      blockedReason: undefined,
    })
  } else {
    await recorder.updateStatus('blocked', {
      updatedAt: now,
      completedAt: now,
      blockedReason: completion.reason,
    })
  }

  return {
    schemaVersion: 'confirm-session-completion-result/v1',
    status: completion.status,
    reason: completion.reason,
    session: { ...recorder.session },
    restored,
    confirmation,
    completion,
  }
}

function assertConfirmSessionCompletionInput(input: ConfirmSessionCompletionInput): void {
  if (!input || typeof input !== 'object') {
    throw new Error('Confirm session completion input is required.')
  }
  if (!input.store || typeof input.store.get !== 'function') {
    throw new Error('Confirm session completion store is required.')
  }
  assertNonEmptyString(input.sessionId, 'sessionId')
  assertNonEmptyString(input.message, 'message')
  if (input.confirmedBy !== 'user') {
    throw new Error('Session completion must be explicitly confirmed by user.')
  }
}

function assertSessionCanBeRechecked(session: AgentSession): void {
  if (session.status === 'failed' || session.status === 'aborted') {
    throw new Error(`Cannot confirm completion for ${session.status} session: ${session.sessionId}`)
  }
}

function assertNonEmptyString(value: unknown, label: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Confirm session completion ${label} must be a non-empty string.`)
  }
}

function restoredWorkflowPhase(restored: RestoredSessionState): string | undefined {
  return (
    restored.latestWorkflowEvaluation?.state.phase ??
    restored.latestWorkflowState?.phase ??
    restored.latestCompletionGate?.workflowPhase
  )
}

function restoredObservationPhase(restored: RestoredSessionState): string | undefined {
  return (
    restored.latestWorkflowEvaluation?.state.observationPhase ??
    restored.latestWorkflowState?.observationPhase ??
    restored.latestCompletionGate?.observationPhase
  )
}

function restoredSessionMetadata(restored: RestoredSessionState): Record<string, unknown> {
  return {
    restoredAt: restored.restoredAt,
    transcriptCount: restored.transcriptCount,
    sessionStatus: restored.session.status,
    workflowPhase: restoredWorkflowPhase(restored),
    observationPhase: restoredObservationPhase(restored),
    workflowEvidenceCount: restored.workflowEvidence.length,
    restoredMessageCount: restored.restoredMessages.length,
    latestFinalResultStatus: restored.latestFinalResult?.status,
    missingCriteria: restored.missingCriteria,
    blockers: restored.blockers,
  }
}

function completionRecheckedMetadata(
  completion: CompletionResumeResult,
  confirmation: UserConfirmation,
): Record<string, unknown> {
  return {
    status: completion.status,
    reason: completion.reason,
    confirmationId: confirmation.id,
    evidenceId: confirmation.evidence.id,
    confirmationEvidenceId: confirmation.evidence.id,
    action: completion.completionGateDecision.action,
    completionGateAction: completion.completionGateDecision.action,
    recommendedStatus: completion.completionGateDecision.recommendedStatus,
    workflowPhase: completion.completionGateDecision.workflowPhase,
    evidenceIds: completion.completionGateDecision.evidenceIds,
    missingCriteria: completion.completionGateDecision.missingCriteria,
    blockers: completion.completionGateDecision.blockers,
    observationPhase: completion.workflowEvaluation.state.observationPhase ?? completion.completionGateDecision.observationPhase,
  }
}

function finalResultPayload(
  completion: CompletionResumeResult,
  confirmation: UserConfirmation,
  restored: RestoredSessionState,
): Record<string, unknown> {
  return {
    schemaVersion: 'session-completion-final-result/v1',
    status: completion.status,
    reason: completion.reason,
    confirmationId: confirmation.id,
    confirmationEvidenceId: confirmation.evidence.id,
    restoredAt: restored.restoredAt,
    restoredMessageCount: restored.restoredMessages.length,
    completionGate: {
      action: completion.completionGateDecision.action,
      recommendedStatus: completion.completionGateDecision.recommendedStatus,
      workflowPhase: completion.completionGateDecision.workflowPhase,
      observationPhase: completion.workflowEvaluation.state.observationPhase ?? completion.completionGateDecision.observationPhase,
      evidenceIds: completion.completionGateDecision.evidenceIds,
      missingCriteria: completion.completionGateDecision.missingCriteria,
      blockers: completion.completionGateDecision.blockers,
    },
    workflowEvaluation: {
      phase: completion.workflowEvaluation.state.phase,
      observationPhase: completion.workflowEvaluation.state.observationPhase,
      changed: completion.workflowEvaluation.changed,
      evidenceIds: completion.workflowEvaluation.evidenceIds,
      missingCriteria: completion.workflowEvaluation.missingCriteria,
      blockers: completion.workflowEvaluation.blockers,
      reason: completion.workflowEvaluation.reason,
    },
  }
}
