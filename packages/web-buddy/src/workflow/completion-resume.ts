import type { RestoredSessionState } from '../session/session-restore.js'
import { CompletionGate, completionGate as defaultCompletionGate, type CompletionGateDecision } from './completion-gate.js'
import type { UserConfirmation } from './user-confirmation.js'
import {
  WorkflowEngine,
  workflowEngine as defaultWorkflowEngine,
  type WorkflowApprovalFact,
  type WorkflowEngineEvaluation,
  type WorkflowPermissionFact,
  type WorkflowPolicyFact,
  type WorkflowRecentAction,
} from './workflow-engine.js'
import type { WorkflowEvidence } from './workflow-evidence.js'
import { createInitialWorkflowState, type WorkflowState } from './workflow-state.js'

export interface CompletionResumeInput {
  restored: RestoredSessionState
  confirmation?: UserConfirmation
  workflowEngine?: Pick<WorkflowEngine, 'evaluate'>
  completionGate?: Pick<CompletionGate, 'evaluate'>
  now?: string
}

export interface CompletionResumeResult {
  schemaVersion: 'completion-resume-result/v1'
  status: 'completed' | 'blocked'
  reason: string
  workflowEvaluation: WorkflowEngineEvaluation
  completionGateDecision: CompletionGateDecision
  evidence: WorkflowEvidence[]
}

export class CompletionResumeService {
  static evaluate(input: CompletionResumeInput): CompletionResumeResult {
    return completionResumeService.evaluate(input)
  }

  evaluate(input: CompletionResumeInput): CompletionResumeResult {
    const now = input.now ?? new Date().toISOString()
    const restored = input.restored
    const evidence = combinedEvidence(restored.workflowEvidence, input.confirmation?.evidence)
    const workflowEngine = input.workflowEngine ?? defaultWorkflowEngine
    const completionGate = input.completionGate ?? defaultCompletionGate
    const previous = previousWorkflowState(restored, now)
    const workflowEvaluation = workflowEngine.evaluate({
      previous,
      evidenceSnapshot: evidence,
      recentActions: resumeRecentActions(restored),
      policyFacts: restoredPolicyFacts(restored),
      permissionFacts: restoredPermissionFacts(restored),
      approvalFacts: restoredApprovalFacts(restored),
      now,
    })

    const completionGateDecision = completionGate.evaluate({
      done: true,
      blocked: false,
      summary: resumeSummary(restored),
      workflowState: workflowEvaluation.state,
      workflowEvaluation,
      source: 'resume_completion',
    })

    return {
      schemaVersion: 'completion-resume-result/v1',
      status: completionGateDecision.action === 'allow' ? 'completed' : 'blocked',
      reason: completionGateDecision.reason,
      workflowEvaluation,
      completionGateDecision,
      evidence,
    }
  }
}

export const completionResumeService = new CompletionResumeService()

function previousWorkflowState(restored: RestoredSessionState, now: string): WorkflowState {
  return cloneWorkflowState(restored.latestWorkflowState ?? restored.latestWorkflowEvaluation?.state ?? createInitialWorkflowState(now))
}

function combinedEvidence(restoredEvidence: WorkflowEvidence[], confirmationEvidence: WorkflowEvidence | undefined): WorkflowEvidence[] {
  return uniqueEvidence([
    ...restoredEvidence.map(cloneEvidence),
    ...(confirmationEvidence ? [cloneEvidence(confirmationEvidence)] : []),
  ])
}

function resumeRecentActions(restored: RestoredSessionState): WorkflowRecentAction[] {
  const actions = restored.workflowEvidence
    .filter((evidence) => evidence.kind === 'tool_result')
    .map(toolResultActionFromEvidence)
    .filter((action): action is WorkflowRecentAction => Boolean(action))

  const finalSubmitAction = finalSubmitRecoveryAction(restored)
  if (finalSubmitAction) actions.push(finalSubmitAction)

  return actions
}

function toolResultActionFromEvidence(evidence: WorkflowEvidence): WorkflowRecentAction | undefined {
  const toolName = toolNameFromEvidence(evidence)
  if (!toolName) return undefined

  const data = record(evidence.data)
  const toolResultData = record(data.data)
  const done = data.done === true
  const blocked = blockedValue(data) ?? blockedValue(toolResultData)
  const observation = typeof data.observation === 'string' ? data.observation : evidence.summary

  return {
    toolName,
    toolResult: {
      observation,
      ...(typeof data.pageChanged === 'boolean' ? { pageChanged: data.pageChanged } : {}),
      ...(done ? { done } : {}),
      ...(Object.keys(toolResultData).length > 0 ? { data: cloneRecord(toolResultData) } : {}),
    },
    ...(typeof blocked === 'boolean' ? { blocked } : {}),
    ...(toolName === 'agent_done' && typeof blocked === 'boolean' ? { agentDoneBlocked: blocked } : {}),
    ...(evidence.ts ? { at: evidence.ts } : {}),
    summary: evidence.summary,
  }
}

function finalSubmitRecoveryAction(restored: RestoredSessionState): WorkflowRecentAction | undefined {
  if (!hasFinalSubmitRecoveryFact(restored)) return undefined

  return {
    toolName: 'resume_completion',
    gateKind: 'final_submit',
    at: restored.restoredAt,
    summary: 'Restored final-submit blocker during completion resume.',
  }
}

function hasFinalSubmitRecoveryFact(restored: RestoredSessionState): boolean {
  return (
    restored.latestWorkflowState?.phase === 'ready_for_final_submit' ||
    restored.latestWorkflowEvaluation?.state.phase === 'ready_for_final_submit' ||
    restored.latestCompletionGate?.workflowPhase === 'ready_for_final_submit' ||
    restored.blockers.some(isFinalSubmitBlocker) ||
    restored.latestWorkflowEvaluation?.blockers.some(isFinalSubmitBlocker) === true ||
    restored.latestCompletionGate?.blockers.some(isFinalSubmitBlocker) === true
  )
}

function restoredPolicyFacts(restored: RestoredSessionState): WorkflowPolicyFact[] | undefined {
  const facts = restored.workflowEvidence
    .filter((evidence) => evidence.kind === 'policy')
    .map((evidence) => cloneRecord(record(evidence.data)))
    .filter((fact) => Object.keys(fact).length > 0)
  return facts.length > 0 ? (facts as WorkflowPolicyFact[]) : undefined
}

function restoredPermissionFacts(restored: RestoredSessionState): WorkflowPermissionFact[] | undefined {
  const facts = restored.workflowEvidence
    .filter((evidence) => evidence.kind === 'permission')
    .map((evidence) => {
      const data = record(evidence.data)
      const decision = record(data.decision)
      return Object.keys(decision).length > 0 ? cloneRecord(decision) : cloneRecord(data)
    })
    .filter((fact) => Object.keys(fact).length > 0)
  return facts.length > 0 ? (facts as WorkflowPermissionFact[]) : undefined
}

function restoredApprovalFacts(restored: RestoredSessionState): WorkflowApprovalFact[] | undefined {
  const facts = restored.workflowEvidence
    .filter((evidence) => evidence.kind === 'approval')
    .map((evidence) => {
      const data = record(evidence.data)
      const approval = record(data.approval)
      const resolution = record(data.resolution)
      if (Object.keys(approval).length === 0 && Object.keys(resolution).length === 0) return cloneRecord(data)
      return {
        ...cloneRecord(approval),
        ...(Object.keys(resolution).length > 0 ? { resolution: cloneRecord(resolution) } : {}),
      }
    })
    .filter((fact) => Object.keys(fact).length > 0)
  return facts.length > 0 ? (facts as WorkflowApprovalFact[]) : undefined
}

function resumeSummary(restored: RestoredSessionState): string {
  const finalResult = restored.latestFinalResult
  const resultRecord = record(finalResult?.result)
  const finalSummary =
    stringValue(finalResult?.reason) ??
    stringValue(resultRecord.summary) ??
    stringValue(resultRecord.reason) ??
    stringValue(restored.latestCompletionGate?.reason) ??
    stringValue(restored.latestWorkflowEvaluation?.reason)

  return finalSummary
    ? `Resume completion recheck from restored session: ${finalSummary}`
    : 'Resume completion recheck from restored session.'
}

function toolNameFromEvidence(evidence: WorkflowEvidence): string | undefined {
  if (evidence.source && evidence.source !== 'workflow_engine' && evidence.source !== 'runtime_context') {
    return evidence.source
  }

  const match = evidence.summary.match(/^([a-z][a-z0-9_]*):/i)
  return match?.[1]
}

function blockedValue(recordValue: Record<string, unknown>): boolean | undefined {
  return typeof recordValue.blocked === 'boolean' ? recordValue.blocked : undefined
}

function isFinalSubmitBlocker(blocker: { gateKind?: unknown }): boolean {
  return blocker.gateKind === 'final_submit'
}

function uniqueEvidence(evidence: WorkflowEvidence[]): WorkflowEvidence[] {
  const seen = new Set<string>()
  const result: WorkflowEvidence[] = []
  for (const item of evidence) {
    if (seen.has(item.id)) continue
    seen.add(item.id)
    result.push(item)
  }
  return result
}

function cloneWorkflowState(state: WorkflowState): WorkflowState {
  return {
    ...state,
    ...(state.lastTransition ? { lastTransition: { ...state.lastTransition } } : {}),
  }
}

function cloneEvidence(evidence: WorkflowEvidence): WorkflowEvidence {
  return {
    ...evidence,
    ...(evidence.data ? { data: cloneRecord(evidence.data) } : {}),
    ...(evidence.metadata ? { metadata: cloneRecord(evidence.metadata) } : {}),
  }
}

function cloneRecord(recordValue: Record<string, unknown>): Record<string, unknown> {
  const clone: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(recordValue)) {
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

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}
