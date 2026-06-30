import { browserSnapshot } from '../../browser/snapshot.js'
import {
  buildLoopContext,
  renderInitialUserContext,
  renderSystemContext,
  renderUserContext,
} from '../../agent/prompt-assembler.js'
import {
  contextCompactor as defaultContextCompactor,
  type ContextCompactionInput,
  type ContextCompactionResult,
} from '../../context/compaction.js'
import { COMPACTED_RUN_CONTEXT_PREFIX } from '../../context/run-summary.js'
import type { ContextRecentAction } from '../../context/types.js'
import { estimateTokenBudget, type TokenBudgetOptions, type TokenBudgetSnapshot } from '../../kernel/token-budget.js'
import { ApprovalQueue } from '../../permission/approval-queue.js'
import { PermissionEngine } from '../../permission/permission-engine.js'
import {
  createToolPermissionRequest,
  createWorkflowHandoffPermissionRequest,
  type ApprovalEnqueueInput,
  type ApprovalRequest,
  type ApprovalResolution,
  type ApprovalResolveDecision,
  type ApprovalResolvePatch,
  type ApprovalResolveResult,
  type PermissionDecision,
  type PermissionRequest,
} from '../../permission/permission-types.js'
import { decideToolPolicy, shouldStopAfterGateDecision, type PolicyEngineDecision } from '../../policy/agent-policy.js'
import { createPolicyAuditEvent } from '../../policy/policy-audit.js'
import { sessionManager } from '../../session/manager.js'
import {
  compactAssistantContent,
  compactToolResult,
  type AgentSessionStatus,
  type SessionRecorder,
} from '../../session/index.js'
import { abortReason } from '../../kernel/run-controller.js'
import type { GateDecision, GateKind, HumanGate } from '../../sdk/human.js'
import type { LlmGateway, ChatMessage } from '../../sdk/llm.js'
import type { ResumeProfile } from '../../sdk/resume.js'
import type { RiskLevel } from '../../sdk/trace.js'
import type { LocalToolRunResult } from '../../tools/local-adapter.js'
import { ToolExecutionService } from '../../tools/tool-execution-service.js'
import { toLegacyToolRunResult, type NormalizedToolResult } from '../../tools/tool-result.js'
import { workflowEngine as defaultWorkflowEngine, type WorkflowEngineEvaluation, type WorkflowEngineInput } from '../../workflow/workflow-engine.js'
import { EvidenceStore, type AddWorkflowEvidenceInput, type WorkflowEvidence } from '../../workflow/workflow-evidence.js'
import { createInitialWorkflowState, type WorkflowState } from '../../workflow/workflow-state.js'
import { pageView } from './page-view.js'
import { ToolRegistry, type ToolContext } from './tool-registry.js'

export interface AgentEvent {
  step: number
  level: 'think' | 'act' | 'observe' | 'gate' | 'warn' | 'error' | 'done'
  message: string
}

export interface AgentLoopInput {
  /** The natural-language task, e.g. "fill the application form on this page with my resume". */
  goal: string
  resume: ResumeProfile
  llm: LlmGateway
  registry: ToolRegistry
  ctx: ToolContext
  gate: HumanGate
  maxSteps?: number
  onEvent?: (e: AgentEvent) => void
  /** Extra context lines (e.g. the matched job title) appended to the system prompt. */
  extraContext?: string
  /** `raw` removes job-application workflow guardrails so the model drives the browser directly. */
  safetyMode?: 'guarded' | 'raw'
  /** Optional append-only session recorder for resumable runtime state. */
  session?: SessionRecorder
  /** Optional kernel/run-controller abort signal. Checked before model/tool work. */
  abortSignal?: AbortSignal
  /** Optional execution service for tests or alternate local runtimes. */
  toolExecutionService?: ToolExecutionService
  /** Optional permission decision service for tests or alternate runtimes. */
  permissionEngine?: AgentLoopPermissionEngine
  /** Optional in-memory approval queue for tests or embedding runtimes. */
  approvalQueue?: AgentLoopApprovalQueue
  /** Optional context budget. When maxInputTokens is unset, the loop estimates but does not compact. */
  contextBudget?: ContextBudgetOptions
  /** Optional deterministic compactor for tests or alternate local runtimes. */
  contextCompactor?: AgentLoopContextCompactor
  /** Optional workflow evaluator for tests or alternate local runtimes. */
  workflowEngine?: AgentLoopWorkflowEngine
}

export interface AgentLoopResult {
  steps: number
  toolCalls: number
  done: boolean
  blocked: boolean
  summary: string
  workflowState?: WorkflowState
}

export interface AgentLoopPermissionEngine {
  decide(request: PermissionRequest): PermissionDecision
}

export interface AgentLoopApprovalQueue {
  enqueue(request: ApprovalEnqueueInput | ApprovalRequest): ApprovalRequest
  resolve(
    approvalId: string,
    result: ApprovalResolveResult | ApprovalResolveDecision,
    patch?: Omit<ApprovalResolvePatch, 'status' | 'decision'>,
  ): ApprovalRequest
}

export interface ContextBudgetOptions extends TokenBudgetOptions {
  keepRecentMessages?: number
}

export interface AgentLoopContextCompactor {
  compact(input: ContextCompactionInput): ContextCompactionResult
}

export interface AgentLoopWorkflowEngine {
  evaluate(input: WorkflowEngineInput): WorkflowEngineEvaluation
}

const DEFAULT_MAX_STEPS = 16
const DEFAULT_KEEP_RECENT_MESSAGES = 6

/**
 * The generic ReAct-style loop: the LLM picks browser tools itself, we execute
 * them (gating risky ones), feed observations back, until the model calls
 * `agent_done` or stops. This is what makes the agent work on ANY site — there
 * is no hardcoded field mapping.
 */
export async function runAgentLoop(input: AgentLoopInput): Promise<AgentLoopResult> {
  const { llm, registry, ctx, gate, resume, goal, onEvent } = input
  const safetyMode = input.safetyMode ?? 'guarded'
  const maxSteps = input.maxSteps ?? DEFAULT_MAX_STEPS
  const emit = (level: AgentEvent['level'], message: string, step: number) =>
    onEvent?.({ step, level, message })

  const tools = registry.toOpenAITools()
  const toolExecution = input.toolExecutionService ?? new ToolExecutionService(registry)
  const permissionEngine = input.permissionEngine ?? new PermissionEngine()
  const approvalQueue = input.approvalQueue ?? new ApprovalQueue()
  const workflowEngine = input.workflowEngine ?? defaultWorkflowEngine
  const workflowEvidenceStore = new EvidenceStore()
  const session = input.session

  let step = 0
  let toolCalls = 0
  let done = false
  let blocked = false
  let summary = 'no summary'
  let workflowState = createInitialWorkflowState()
  let sessionFinalized = false
  const recentActions: ContextRecentAction[] = []
  const blockers: string[] = []
  const permissionRequests: PermissionRequest[] = []
  const permissionDecisions: PermissionDecision[] = []
  const approvals: ApprovalRequest[] = []

  const sessionAction = async (label: string, action: () => Promise<void>) => {
    if (!session) return
    try {
      await action()
    } catch (error) {
      emit('warn', `Session ${label} write failed: ${error instanceof Error ? error.message : String(error)}`, step)
    }
  }
  const sessionEvent = async (...args: Parameters<SessionRecorder['event']>) =>
    sessionAction('event', () => session!.event(...args))
  const sessionTranscript = async (...args: Parameters<SessionRecorder['transcript']>) =>
    sessionAction('transcript', () => session!.transcript(...args))
  const sessionWorkflow = async (state: unknown) =>
    sessionAction('workflow', () => session!.workflow(state))
  const sessionStatus = async (status: AgentSessionStatus, patch?: Parameters<SessionRecorder['updateStatus']>[1]) =>
    sessionAction('status', () => session!.updateStatus(status, patch))
  const addWorkflowEvidence = async (
    evidenceInput: AddWorkflowEvidenceInput,
    currentStep: number,
  ): Promise<WorkflowEvidence> => {
    const evidence = workflowEvidenceStore.add({
      sessionId: session?.session.sessionId ?? ctx.sessionId,
      runId: session?.session.runId ?? ctx.trace.runId,
      ...evidenceInput,
    })
    const turnId = evidence.turnId ?? turnIdForStep(currentStep)
    await sessionTranscript({ type: 'workflow_evidence', turnId, evidence })
    await sessionEvent({
      type: 'workflow_evidence_recorded',
      turnId,
      ...(evidence.toolCallId ? { toolCallId: evidence.toolCallId } : {}),
      message: `Workflow evidence recorded: ${evidence.kind}.`,
      data: {
        evidenceId: evidence.id,
        kind: evidence.kind,
        phase: evidence.phase,
        summary: evidence.summary,
      },
    })
    return evidence
  }
  const addContextWorkflowEvidence = async (
    context: Pick<WorkflowEngineInput, 'page' | 'form'> & { turnId?: string; toolCallId?: string },
    currentStep: number,
  ) => {
    if (context.page) {
      await addWorkflowEvidence({
        kind: 'page',
        summary: workflowPageEvidenceSummary(context.page),
        source: 'runtime_context',
        confidence: context.page.pageType === 'unknown' ? 'medium' : 'high',
        phase: workflowState.phase,
        ...(context.turnId ? { turnId: context.turnId } : {}),
        ...(context.toolCallId ? { toolCallId: context.toolCallId } : {}),
        data: workflowPageEvidenceData(context.page),
      }, currentStep)
    }
    if (context.form) {
      await addWorkflowEvidence({
        kind: 'form',
        summary: workflowFormEvidenceSummary(context.form),
        source: 'runtime_context',
        confidence: context.form.missingRequired.length === 0 ? 'high' : 'medium',
        phase: workflowState.phase,
        ...(context.turnId ? { turnId: context.turnId } : {}),
        ...(context.toolCallId ? { toolCallId: context.toolCallId } : {}),
        data: workflowFormEvidenceData(context.form),
      }, currentStep)
    }
  }
  const recordWorkflowEvaluation = async (
    evaluation: WorkflowEngineEvaluation,
    currentStep: number,
    reason: string,
  ) => {
    await sessionTranscript({
      type: 'workflow_evaluation',
      turnId: turnIdForStep(currentStep),
      evaluation,
    })
    await sessionEvent({
      type: 'workflow_evaluated',
      turnId: turnIdForStep(currentStep),
      message: reason,
      data: {
        phase: evaluation.state.phase,
        changed: evaluation.changed,
        blockerCount: evaluation.blockers.length,
        evidenceIds: evaluation.evidenceIds,
        reason: evaluation.reason,
      },
    })
  }
  const recordWorkflowSnapshot = async (state: WorkflowState, currentStep: number, reason: string) => {
    await sessionTranscript({ type: 'workflow_snapshot', turnId: turnIdForStep(currentStep), workflowState: state })
    await sessionEvent({
      type: 'workflow_updated',
      turnId: turnIdForStep(currentStep),
      message: reason,
      data: { workflowState: state },
    })
    await sessionWorkflow(state)
  }
  const evaluateWorkflow = async (
    currentStep: number,
    reason: string,
    evaluationInput: Omit<WorkflowEngineInput, 'previous' | 'evidenceSnapshot'> & {
      turnId?: string
      toolCallId?: string
      policyDecision?: PolicyEngineDecision
      permissionRequest?: PermissionRequest
      permissionDecision?: PermissionDecision
      approval?: ApprovalRequest
      approvalResolution?: ApprovalResolution
      toolName?: string
      toolResult?: NormalizedToolResult | LocalToolRunResult
    } = {},
  ): Promise<WorkflowEngineEvaluation> => {
    await addContextWorkflowEvidence(evaluationInput, currentStep)
    if (evaluationInput.policyDecision) {
      await addWorkflowEvidence({
        kind: 'policy',
        summary: `Policy ${evaluationInput.policyDecision.action}: ${evaluationInput.policyDecision.reason}`,
        source: 'policy_engine',
        confidence: 'high',
        phase: workflowState.phase,
        ...(evaluationInput.turnId ? { turnId: evaluationInput.turnId } : {}),
        ...(evaluationInput.toolCallId ? { toolCallId: evaluationInput.toolCallId } : {}),
        data: policyMetadata(evaluationInput.policyDecision),
      }, currentStep)
    }
    if (evaluationInput.permissionDecision) {
      await addWorkflowEvidence({
        kind: 'permission',
        summary: `Permission ${evaluationInput.permissionDecision.action}: ${evaluationInput.permissionDecision.reason}`,
        source: 'permission_engine',
        confidence: 'high',
        phase: workflowState.phase,
        ...(evaluationInput.turnId ? { turnId: evaluationInput.turnId } : {}),
        ...(evaluationInput.toolCallId ? { toolCallId: evaluationInput.toolCallId } : {}),
        data: {
          ...(evaluationInput.permissionRequest ? { request: permissionRequestMetadata(evaluationInput.permissionRequest) } : {}),
          decision: permissionMetadata(evaluationInput.permissionDecision),
        },
      }, currentStep)
    }
    if (evaluationInput.approval) {
      await addWorkflowEvidence({
        kind: 'approval',
        summary: `Approval ${evaluationInput.approval.status}: ${evaluationInput.approval.reason}`,
        source: 'approval_queue',
        confidence: 'high',
        phase: workflowState.phase,
        ...(evaluationInput.turnId ? { turnId: evaluationInput.turnId } : {}),
        ...(evaluationInput.toolCallId ? { toolCallId: evaluationInput.toolCallId } : {}),
        data: {
          approval: approvalMetadata(evaluationInput.approval),
          ...(evaluationInput.approvalResolution
            ? { resolution: approvalResolutionMetadata(evaluationInput.approvalResolution) }
            : {}),
        },
      }, currentStep)
    }
    if (evaluationInput.toolName && evaluationInput.toolResult) {
      await addWorkflowEvidence({
        kind: 'tool_result',
        summary: workflowToolResultSummary(evaluationInput.toolName, evaluationInput.toolResult),
        source: evaluationInput.toolName,
        confidence: 'medium',
        phase: workflowState.phase,
        ...(evaluationInput.turnId ? { turnId: evaluationInput.turnId } : {}),
        ...(evaluationInput.toolCallId ? { toolCallId: evaluationInput.toolCallId } : {}),
        data: workflowToolResultEvidenceData(evaluationInput.toolResult),
      }, currentStep)
    }

    const evaluation = workflowEngine.evaluate({
      ...evaluationInput,
      previous: workflowState,
      recentActions: workflowRecentActions(recentActions, evaluationInput),
      policyFacts: evaluationInput.policyDecision ? [evaluationInput.policyDecision] : undefined,
      permissionFacts: [...permissionRequests, ...permissionDecisions],
      approvalFacts: [...approvals],
      evidenceSnapshot: workflowEvidenceStore.snapshot(),
    })
    workflowState = evaluation.state
    await recordWorkflowEvaluation(evaluation, currentStep, reason)
    await recordWorkflowSnapshot(workflowState, currentStep, reason)
    await addWorkflowEvidence({
      kind: 'workflow_state',
      summary: `Workflow state is ${workflowState.phase}: ${workflowState.reason}`,
      source: 'workflow_engine',
      confidence: workflowState.confidence,
      phase: workflowState.phase,
      ...(evaluationInput.turnId ? { turnId: evaluationInput.turnId } : {}),
      ...(evaluationInput.toolCallId ? { toolCallId: evaluationInput.toolCallId } : {}),
      data: {
        state: workflowState,
        changed: evaluation.changed,
        blockers: evaluation.blockers,
        matchedCriteria: evaluation.matchedCriteria,
        missingCriteria: evaluation.missingCriteria,
      },
    }, currentStep)
    return evaluation
  }
  const recordPermissionEvaluation = async (
    request: PermissionRequest,
    decision: PermissionDecision,
    currentStep: number,
  ) => {
    const toolCallId = permissionToolCallId(request)
    const toolName = permissionToolName(request)
    const requestMetadata = permissionRequestMetadata(request)
    const decisionMetadata = permissionMetadata(decision)
    ctx.trace.agentTrace?.recordEvent('permission_decision', {
      step: currentStep,
      request: requestMetadata,
      decision: decisionMetadata,
    })
    await sessionTranscript({
      type: 'permission_decision',
      ...(request.turnId ? { turnId: request.turnId } : {}),
      permissionRequestId: request.requestId,
      ...(toolCallId ? { toolCallId } : {}),
      ...(toolName ? { toolName } : {}),
      request: requestMetadata,
      decision: decisionMetadata,
    })
    await sessionEvent({
      type: 'permission_evaluated',
      ...(request.turnId ? { turnId: request.turnId } : {}),
      ...(toolCallId ? { toolCallId } : {}),
      message: `${permissionSubjectLabel(request)}: ${decision.action}`,
      data: { request: requestMetadata, decision: decisionMetadata },
    })
  }
  const decidePermission = async (request: PermissionRequest, currentStep: number): Promise<PermissionDecision> => {
    const decision = permissionEngine.decide(request)
    permissionRequests.push(request)
    permissionDecisions.push(decision)
    await recordPermissionEvaluation(request, decision, currentStep)
    return decision
  }
  const enqueueApproval = async (
    request: PermissionRequest,
    decision: PermissionDecision,
    currentStep: number,
  ): Promise<ApprovalRequest> => {
    const approval = approvalQueue.enqueue(approvalInputFor(request, decision))
    rememberApproval(approvals, approval)
    const approvalData = approvalMetadata(approval)
    ctx.trace.agentTrace?.recordEvent('approval_requested', { step: currentStep, approval: approvalData })
    await sessionTranscript({
      type: 'approval_request',
      ...(approval.turnId ? { turnId: approval.turnId } : {}),
      approvalId: approval.approvalId,
      permissionRequestId: approval.permissionRequestId ?? request.requestId,
      ...(approval.toolCallId ? { toolCallId: approval.toolCallId } : {}),
      status: 'pending',
      request: approvalData,
    })
    await sessionEvent({
      type: 'approval_requested',
      ...(approval.turnId ? { turnId: approval.turnId } : {}),
      ...(approval.toolCallId ? { toolCallId: approval.toolCallId } : {}),
      message: `Approval requested: ${approval.gateKind}.`,
      data: { approval: approvalData },
    })
    return approval
  }
  const resolveApproval = async (
    approval: ApprovalRequest,
    gateDecision: GateDecision,
    currentStep: number,
  ): Promise<ApprovalRequest> => {
    const resolved = approvalQueue.resolve(approval.approvalId, {
      decision: gateDecision,
      source: 'human_gate',
      reason: `HumanGate returned ${gateDecision}.`,
    })
    rememberApproval(approvals, resolved)
    const approvalData = approvalMetadata(resolved)
    const resolutionData = resolved.resolution ? approvalResolutionMetadata(resolved.resolution) : undefined
    ctx.trace.agentTrace?.recordEvent('approval_resolved', {
      step: currentStep,
      approval: approvalData,
      resolution: resolutionData,
    })
    await sessionTranscript({
      type: 'approval_decision',
      ...(resolved.turnId ? { turnId: resolved.turnId } : {}),
      approvalId: resolved.approvalId,
      permissionRequestId: resolved.permissionRequestId ?? approval.permissionRequestId ?? approval.approvalId,
      ...(resolved.toolCallId ? { toolCallId: resolved.toolCallId } : {}),
      decision: { decision: gateDecision, approval: approvalData, resolution: resolutionData },
    })
    await sessionEvent({
      type: 'approval_resolved',
      ...(resolved.turnId ? { turnId: resolved.turnId } : {}),
      ...(resolved.toolCallId ? { toolCallId: resolved.toolCallId } : {}),
      message: `Approval resolved: ${gateDecision}.`,
      data: { approval: approvalData, resolution: resolutionData },
    })
    return resolved
  }
  const recordWorkflowHandoffPermission = async (state: WorkflowState, currentStep: number, reason: string) => {
    const handoffKind = workflowHandoffKind(state)
    if (!handoffKind) return
    const turnId = turnIdForStep(currentStep)
    const request = createWorkflowHandoffPermissionRequest({
      handoffKind,
      reason,
      runId: session?.session.runId ?? ctx.trace.runId,
      sessionId: session?.session.sessionId ?? ctx.sessionId,
      turnId,
      step: currentStep,
      workflowState: state,
      currentUrl: sessionManager.get(ctx.sessionId)?.page.url(),
    })
    const decision = await decidePermission(request, currentStep)
    if (decision.action !== 'ask') return

    const approval = await enqueueApproval(request, decision, currentStep)
    await sessionEvent({
      type: 'human_gate_requested',
      turnId,
      message: `Gate requested for workflow handoff: ${handoffKind}.`,
      data: { kind: handoffKind, reason: decision.reason, approvalId: approval.approvalId },
    })
    const gateDecision = await gate.confirm(handoffKind, approval.message, approval.context)
    const resolvedApproval = await resolveApproval(approval, gateDecision, currentStep)
    await sessionEvent({
      type: 'human_gate_resolved',
      turnId,
      message: `Gate resolved: ${gateDecision}.`,
      data: { kind: handoffKind, decision: gateDecision, approvalId: resolvedApproval.approvalId },
    })
    ctx.trace.record({
      phase: 'agent_loop',
      action: `GATE [${handoffKind}] workflow_handoff → ${gateDecision}`,
      url: request.currentUrl,
      risk: request.risk,
      observation: decision.reason,
      status: 'blocked',
    })
    await evaluateWorkflow(currentStep, `Workflow handoff ${handoffKind} resolved ${gateDecision}.`, {
      turnId,
      currentUrl: request.currentUrl,
      permissionRequest: request,
      permissionDecision: decision,
      approval: resolvedApproval,
      approvalResolution: resolvedApproval.resolution,
      gateKind: handoffKind,
      gateDecision,
    })
  }
  const finalizeSession = async (
    status: Extract<AgentSessionStatus, 'completed' | 'blocked' | 'failed' | 'aborted'>,
    result: Record<string, unknown>,
    reason?: string,
  ) => {
    if (!session || sessionFinalized) return
    sessionFinalized = true
    await sessionTranscript({
      type: 'final_result',
      status,
      result,
      ...(reason ? { reason } : {}),
    })
    await sessionEvent({
      type: sessionEventTypeForStatus(status),
      message: reason,
      data: result,
    })
    await sessionStatus(status, {
      ...(status === 'blocked' && reason ? { blockedReason: reason } : {}),
      ...(status === 'failed' && reason ? { error: reason } : {}),
    })
  }
  const abortRun = async (turnId?: string): Promise<AgentLoopResult> => {
    const reason = input.abortSignal ? abortReason(input.abortSignal) : 'Abort requested.'
    summary = `Run aborted: ${reason}`
    done = false
    blocked = true
    emit('warn', summary, step)
    ctx.trace.record({ phase: 'agent_loop', action: summary, status: 'blocked' })
    if (turnId) {
      await sessionEvent({
        type: 'turn_completed',
        turnId,
        message: `Turn ${step} aborted.`,
        data: { done, blocked, aborted: true },
      })
    }
    await finalizeSession('aborted', { steps: step, toolCalls, done, blocked, summary, workflowState }, summary)
    return { steps: step, toolCalls, done, blocked, summary, workflowState }
  }
  const checkAbort = async (turnId?: string): Promise<AgentLoopResult | undefined> => {
    if (!input.abortSignal?.aborted) return undefined
    return abortRun(turnId)
  }

  await sessionStatus('running')
  await sessionEvent({
    type: 'session_started',
    message: 'Agent loop started.',
    data: { goal, safetyMode, maxSteps },
  })
  await sessionTranscript({ type: 'user_message', content: goal })
  const abortedAfterStart = await checkAbort()
  if (abortedAfterStart) return abortedAfterStart

  // Snapshot the already-open page so the model starts from the real form
  // instead of guessing a URL to open. (The orchestrator opens the target first.)
  let firstView = ''
  try {
    const snap = await browserSnapshot({ sessionId: ctx.sessionId })
    if (snap.ok) {
      firstView = pageView(snap.data)
      ctx.trace.record({ phase: 'agent_loop', action: 'Initial snapshot of the open page.', status: 'ok' })
    }
  } catch {
    // no page yet — the model can call browser_open itself
  }

  let latestContext = await buildLoopContextWithWorkflow(input, workflowState, recentActions, blockers)
  const initialWorkflow = await evaluateWorkflow(step, 'Initial workflow snapshot.', {
    currentUrl: sessionManager.get(ctx.sessionId)?.page.url(),
    page: latestContext.page,
    form: latestContext.form,
  })
  if (initialWorkflow.changed) {
    latestContext = await buildLoopContextWithWorkflow(input, workflowState, recentActions, blockers)
  }
  const initialHandoffSummary = workflowHandoffSummary(workflowState)
  if (initialHandoffSummary) {
    await recordWorkflowHandoffPermission(workflowState, step, initialHandoffSummary)
    emit('done', initialHandoffSummary, step)
    ctx.trace.record({ phase: 'agent_loop', action: initialHandoffSummary, status: 'blocked' })
    await finalizeSession('blocked', { steps: step, toolCalls, summary: initialHandoffSummary, workflowState }, initialHandoffSummary)
    return { steps: step, toolCalls, done: true, blocked: true, summary: initialHandoffSummary, workflowState }
  }
  let messages: ChatMessage[] = [
    { role: 'system', content: renderSystemContext(latestContext) },
    { role: 'user', content: renderInitialUserContext(latestContext, firstView) },
  ]
  const maybeCompactMessages = async (turnId: string) => {
    const tokenBudget = estimateTokenBudget(messages, input.contextBudget)
    await sessionEvent({
      type: 'token_budget_updated',
      turnId,
      message: 'Token budget updated.',
      data: { tokenBudget },
    })

    if (!tokenBudget.compactRecommended) return

    const compactor = input.contextCompactor ?? defaultContextCompactor
    const compaction = compactor.compact({
      goal,
      runId: session?.session.runId ?? ctx.trace.runId,
      sessionId: session?.session.sessionId ?? ctx.sessionId,
      turnId,
      step,
      messages,
      latestContext,
      workflowState,
      recentActions,
      blockers,
      permissionRequests,
      permissionDecisions,
      approvals,
    })
    const reason = compactReason(tokenBudget)
    const compactedMessages = compactedMessageSet(messages, {
      systemContent: renderSystemContext(latestContext),
      compactedMessage: compaction.compactedMessage,
      keepRecentMessages: input.contextBudget?.keepRecentMessages ?? DEFAULT_KEEP_RECENT_MESSAGES,
    })
    const postCompactionTokenBudget = estimateTokenBudget(compactedMessages, input.contextBudget)

    await sessionTranscript({
      type: 'context_compaction',
      turnId,
      summaryId: compaction.summary.summaryId,
      reason,
      tokenBudget,
      summary: compaction.summary,
    })
    await sessionEvent({
      type: 'context_compacted',
      turnId,
      message: `Context compacted: ${reason}`,
      data: {
        summaryId: compaction.summary.summaryId,
        summary: compaction.summary,
        tokenBudget,
        postCompactionTokenBudget,
        stats: compaction.stats,
      },
    })

    messages = compactedMessages
  }

  while (step < maxSteps) {
    step += 1
    const turnId = turnIdForStep(step)
    await sessionEvent({ type: 'turn_started', turnId, message: `Turn ${step} started.` })
    const abortedBeforeModel = await checkAbort(turnId)
    if (abortedBeforeModel) return abortedBeforeModel
    await maybeCompactMessages(turnId)
    const abortedAfterCompaction = await checkAbort(turnId)
    if (abortedAfterCompaction) return abortedAfterCompaction
    let completion
    try {
      completion = await llm.chatWithTools(messages, { tools, temperature: 0.2 })
    } catch (error) {
      const message = `LLM error: ${(error as Error).message}`
      emit('error', `LLM call failed: ${(error as Error).message}`, step)
      ctx.trace.record({ phase: 'agent_loop', action: message, status: 'error' })
      await sessionTranscript({
        type: 'error',
        turnId,
        message,
        ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
      })
      await finalizeSession('failed', { steps: step, toolCalls, summary: message, workflowState }, message)
      return {
        steps: step,
        toolCalls,
        done: false,
        blocked: true,
        summary: message,
        workflowState,
      }
    }

    await sessionTranscript({
      type: 'assistant_message',
      turnId,
      content: compactAssistantContent({
        content: completion.content,
        toolCalls: completion.toolCalls.map((call) => ({ id: call.id, name: call.name })),
      }),
    })
    await sessionEvent({
      type: 'model_message',
      turnId,
      message: completion.content.trim().slice(0, 200) || `Model requested ${completion.toolCalls.length} tool call(s).`,
      data: {
        toolCallCount: completion.toolCalls.length,
        toolCalls: completion.toolCalls.map((call) => ({ id: call.id, name: call.name })),
      },
    })

    if (completion.content.trim()) {
      emit('think', completion.content.replace(/\s+/g, ' ').slice(0, 200), step)
    }

    // No tool calls → model is done (or narrating). Treat as final.
    if (completion.toolCalls.length === 0) {
      summary = completion.content.trim() || 'model produced no further tool calls'
      done = true
      emit('done', `Loop ended (no tool calls). ${summary.slice(0, 160)}`, step)
      ctx.trace.record({ phase: 'agent_loop', action: `Loop ended: ${summary.slice(0, 200)}`, status: 'ok' })
      await sessionEvent({ type: 'turn_completed', turnId, message: `Turn ${step} completed.`, data: { done, blocked } })
      break
    }

    // Append the assistant tool-call message so the API sees the request it made.
    messages.push({
      role: 'assistant',
      content: completion.content,
      tool_calls: completion.toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function',
        function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
      })),
    })

    for (const call of completion.toolCalls) {
      const abortedBeforeTool = await checkAbort(turnId)
      if (abortedBeforeTool) return abortedBeforeTool
      toolCalls += 1
      const tool = registry.get(call.name)
      const toolCategory = tool?.category
      const risk = registry.resolveRisk(call.name, call.arguments, ctx)
      const argBrief = briefArgs(call.name, call.arguments)
      const currentUrl = sessionManager.get(ctx.sessionId)?.page.url()
      await sessionTranscript({
        type: 'tool_call',
        turnId,
        toolCallId: call.id,
        name: call.name,
        args: call.arguments,
      })
      await sessionEvent({
        type: 'tool_call_created',
        turnId,
        toolCallId: call.id,
        message: `${call.name}(${argBrief})`,
        data: { name: call.name, risk, argBrief },
      })
      const refLabel = call.name === 'browser_click' ? labelForClick(call.arguments, ctx) : undefined
      const policyDecision = decideToolPolicy({
        toolName: call.name,
        args: call.arguments,
        risk,
        safetyMode,
        currentUrl,
        refLabel,
        freshness: latestContext.freshness,
        workflowState,
      })
      const policyAudit = createPolicyAuditEvent({
        sessionId: ctx.sessionId,
        step,
        toolName: call.name,
        decision: policyDecision,
      })
      ctx.trace.agentTrace?.recordEvent('policy_decision', policyAudit)
      await sessionTranscript({
        type: 'policy_decision',
        turnId,
        toolCallId: call.id,
        toolName: call.name,
        decision: policyMetadata(policyDecision),
      })
      await sessionEvent({
        type: 'policy_evaluated',
        turnId,
        toolCallId: call.id,
        message: `${call.name}: ${policyDecision.action}`,
        data: { decision: policyMetadata(policyDecision) },
      })

      const permissionRequest = createToolPermissionRequest({
        call: {
          id: call.id,
          name: call.name,
          arguments: call.arguments,
        },
        policyDecision,
        risk,
        currentUrl,
        workflowState,
        runId: session?.session.runId ?? ctx.trace.runId,
        sessionId: session?.session.sessionId ?? ctx.sessionId,
        turnId,
        step,
        argBrief,
        toolCategory,
        refLabel,
        freshness: latestContext.freshness,
      })
      const permissionDecision = await decidePermission(permissionRequest, step)

      if (permissionDecision.action === 'deny') {
        const note = `BLOCKED by permission [${permissionDecision.ruleId}]. ${permissionDecision.reason}`
        const observation = noteWithPermission(note, policyDecision, permissionDecision)
        messages.push(toolMessage(call.id, observation))
        blockers.push(`${call.name}(${argBrief}) denied by ${permissionDecision.ruleId}: ${permissionDecision.reason}`)
        rememberRecentAction(recentActions, {
          step,
          toolName: call.name,
          argumentsSummary: argBrief,
          status: 'blocked',
          risk,
          observation,
        })
        blocked = true
        done = true
        summary = policyDecision.action === 'block'
          ? `Policy blocked ${call.name}: ${policyDecision.reason}`
          : `Permission denied ${call.name}: ${permissionDecision.reason}`
        await evaluateWorkflow(step, `Permission denied ${call.name}.`, {
          turnId,
          toolCallId: call.id,
          currentUrl,
          page: latestContext.page,
          form: latestContext.form,
          policyDecision,
          permissionRequest,
          permissionDecision,
          gateKind: permissionDecision.gateKind ?? policyDecision.gateKind,
          agentDoneBlocked: true,
        })
        emit('gate', `[permission:deny] ${call.name}(${argBrief})`, step)
        break
      }

      if (permissionDecision.action === 'allow') {
        if (policyDecision.action === 'auto_confirm') markConfirmed(call)
      } else if (permissionDecision.action === 'ask') {
        const approval = await enqueueApproval(permissionRequest, permissionDecision, step)
        const kind = approval.gateKind
        await sessionEvent({
          type: 'human_gate_requested',
          turnId,
          toolCallId: call.id,
          message: `Gate requested for ${call.name}.`,
          data: {
            kind,
            risk,
            reason: permissionDecision.reason,
            permissionRequestId: permissionRequest.requestId,
            approvalId: approval.approvalId,
          },
        })
        const decision = await gate.confirm(kind, approval.message, approval.context)
        const resolvedApproval = await resolveApproval(approval, decision, step)
        await sessionEvent({
          type: 'human_gate_resolved',
          turnId,
          toolCallId: call.id,
          message: `Gate resolved: ${decision}.`,
          data: {
            kind,
            decision,
            permissionRequestId: permissionRequest.requestId,
            approvalId: resolvedApproval.approvalId,
          },
        })
        ctx.trace.record({
          phase: 'agent_loop',
          action: `GATE [${kind}] ${call.name}(${argBrief}) → ${decision}`,
          url: currentUrl,
          risk,
          observation: permissionDecision.reason,
          status: decision === 'approve' ? 'ok' : 'blocked',
        })
        await evaluateWorkflow(step, `Human gate ${kind} resolved ${decision}.`, {
          turnId,
          toolCallId: call.id,
          currentUrl,
          page: latestContext.page,
          form: latestContext.form,
          policyDecision,
          permissionRequest,
          permissionDecision,
          approval: resolvedApproval,
          approvalResolution: resolvedApproval.resolution,
          gateKind: kind,
          gateDecision: decision,
        })
        emit('gate', `[${kind}] ${call.name}(${argBrief}) → ${decision}`, step)
        if (kind === 'final_submit') {
          const note = `BLOCKED by final-submit safety gate (${decision}). Do not retry this action; call agent_done and hand the final submission to the human.`
          const observation = noteWithPermission(note, policyDecision, permissionDecision)
          messages.push(toolMessage(call.id, observation))
          blockers.push(`final_submit gate stopped ${call.name}(${argBrief}) with decision=${decision}: ${permissionDecision.reason}`)
          rememberRecentAction(recentActions, {
            step,
            toolName: call.name,
            argumentsSummary: argBrief,
            status: 'blocked',
            risk,
            observation,
          })
          blocked = true
          done = true
          summary = `Final submit requires manual takeover (gate: ${decision}).`
          await evaluateWorkflow(step, `Final-submit gate stopped ${call.name}.`, {
            turnId,
            toolCallId: call.id,
            currentUrl,
            page: latestContext.page,
            form: latestContext.form,
            policyDecision,
            permissionRequest,
            permissionDecision,
            approval: resolvedApproval,
            approvalResolution: resolvedApproval.resolution,
            gateKind: kind,
            gateDecision: decision,
            agentDoneBlocked: true,
          })
          break
        }
        if (decision !== 'approve') {
          const note = `BLOCKED by human gate (${decision}). Do not retry this action; call agent_done if you cannot proceed.`
          const observation = noteWithPermission(note, policyDecision, permissionDecision)
          messages.push(toolMessage(call.id, observation))
          blockers.push(`${kind} gate stopped ${call.name}(${argBrief}) with decision=${decision}: ${permissionDecision.reason}`)
          rememberRecentAction(recentActions, {
            step,
            toolName: call.name,
            argumentsSummary: argBrief,
            status: 'blocked',
            risk,
            observation,
          })
          if (decision === 'decline' || shouldStopAfterGateDecision(decision)) {
            blocked = true
            done = true
            summary = `Human ${decision} the ${kind} step.`
            await evaluateWorkflow(step, `Human gate stopped ${call.name}.`, {
              turnId,
              toolCallId: call.id,
              currentUrl,
              page: latestContext.page,
              form: latestContext.form,
              policyDecision,
              permissionRequest,
              permissionDecision,
              approval: resolvedApproval,
              approvalResolution: resolvedApproval.resolution,
              gateKind: kind,
              gateDecision: decision,
              agentDoneBlocked: true,
            })
            break
          }
          continue
        }
        markConfirmed(call)
      }

      const abortedBeforeExecution = await checkAbort(turnId)
      if (abortedBeforeExecution) return abortedBeforeExecution

      if (call.name === 'agent_done') {
        await evaluateWorkflow(step, 'Before agent_done.', {
          turnId,
          toolCallId: call.id,
          currentUrl,
          page: latestContext.page,
          form: latestContext.form,
          toolName: call.name,
          policyDecision,
          permissionRequest,
          permissionDecision,
        })
      }

      emit('act', `${call.name}(${argBrief})`, step)
      await sessionEvent({
        type: 'tool_started',
        turnId,
        toolCallId: call.id,
        message: `${call.name} started.`,
        data: { name: call.name, argBrief, risk },
      })
      const toolSpan = ctx.trace.agentTrace?.startSpan({
        spanType: 'tool_call',
        name: call.name,
        toolName: call.name,
        toolCategory,
        input: call.arguments,
        metadata: {
          step,
          toolCallId: call.id,
          risk,
          category: toolCategory,
          argBrief,
          policy: policyMetadata(policyDecision),
        },
      })
      let result
      let execution: NormalizedToolResult | undefined
      try {
        execution = await toolExecution.execute(
          {
            id: call.id,
            name: call.name,
            arguments: call.arguments,
          },
          {
            schemaVersion: 'tool-use-context/v1',
            runId: session?.session.runId ?? ctx.trace.runId,
            sessionId: session?.session.sessionId ?? ctx.sessionId,
            turnId,
            step,
            toolCallId: call.id,
            local: ctx,
            abortSignal: input.abortSignal,
            metadata: {
              step,
              riskLevel: policyDecision.riskLevel,
              category: toolCategory,
              argBrief,
              policyAction: policyDecision.action,
              policyCode: policyDecision.policyCode,
              policyRuleId: policyDecision.ruleId,
              policyGateKind: policyDecision.gateKind,
            },
          },
        )
        if (execution.error?.fatal) {
          if (execution.error.cause instanceof Error) throw execution.error.cause
          throw new Error(execution.error.message)
        }
        result = toLegacyToolRunResult(execution)
        toolSpan?.end({
          status: execution.ok ? 'success' : 'failed',
          output: result,
          metadata: {
            pageChanged: result.pageChanged,
            risk: result.risk,
            done: result.done,
          },
        })
      } catch (error) {
        toolSpan?.end({
          status: 'failed',
          errorMessage: error instanceof Error ? error.message : String(error),
        })
        const message = error instanceof Error ? error.message : String(error)
        await sessionTranscript({
          type: 'tool_result',
          turnId,
          toolCallId: call.id,
          name: call.name,
          ok: false,
          error: message,
        })
        await sessionEvent({
          type: 'tool_failed',
          turnId,
          toolCallId: call.id,
          message: `${call.name} failed: ${message}`,
          data: { name: call.name },
        })
        await sessionTranscript({
          type: 'error',
          turnId,
          message,
          ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
        })
        await finalizeSession('failed', { steps: step, toolCalls, toolName: call.name, error: message, workflowState }, message)
        throw error
      }
      const toolOk = execution?.ok ?? !result.observation.startsWith('FAILED')
      const compactResult = compactToolResult(result)
      await sessionTranscript({
        type: 'tool_result',
        turnId,
        toolCallId: call.id,
        name: call.name,
        ok: toolOk,
        result: compactResult,
        ...(!toolOk ? { error: result.observation } : {}),
      })
      await sessionEvent({
        type: toolOk ? 'tool_completed' : 'tool_failed',
        turnId,
        toolCallId: call.id,
        message: `${call.name} ${toolOk ? 'completed' : 'failed'}.`,
        data: { name: call.name, result: compactResult },
      })
      ctx.trace.record({
        phase: 'agent_loop',
        action: `${call.name}(${argBrief})`,
        url: sessionManager.get(ctx.sessionId)?.page.url(),
        risk,
        toolCategory,
        status: toolOk ? 'ok' : 'warn',
        observation: result.observation.slice(0, 300),
      })

      if (result.done) {
        done = true
        blocked = Boolean((result.data as { blocked?: boolean } | undefined)?.blocked)
        summary = (call.arguments.summary as string) || result.observation
      }
      await evaluateWorkflow(step, `${call.name} updated workflow state.`, {
        turnId,
        toolCallId: call.id,
        currentUrl: sessionManager.get(ctx.sessionId)?.page.url(),
        page: latestContext.page,
        form: latestContext.form,
        toolName: call.name,
        toolResult: result,
        policyDecision,
        permissionRequest,
        permissionDecision,
        ...(result.done ? { agentDoneBlocked: blocked } : {}),
      })
      rememberRecentAction(recentActions, {
        step,
        toolName: call.name,
        argumentsSummary: argBrief,
        status: !toolOk ? 'warn' : blocked && result.done ? 'blocked' : 'ok',
        risk,
        observation: result.observation,
      })

      // After a page-changing action, refresh the snapshot view so refs stay fresh.
      let observation = result.observation
      if (result.pageChanged && call.name !== 'browser_open' && call.name !== 'browser_snapshot') {
        const snap = await browserSnapshot({ sessionId: ctx.sessionId })
        if (snap.ok) observation = `${observation}\n\n[updated page]\n${pageView(snap.data)}`
      }
      messages.push(toolMessage(call.id, observation.slice(0, 6000)))
      emit('observe', result.observation.replace(/\s+/g, ' ').slice(0, 160), step)

      if (done) break
    }

    if (!done) {
      latestContext = await buildLoopContextWithWorkflow(input, workflowState, recentActions, blockers)
      const contextWorkflow = await evaluateWorkflow(step, 'Context refresh updated workflow state.', {
        currentUrl: sessionManager.get(ctx.sessionId)?.page.url(),
        page: latestContext.page,
        form: latestContext.form,
      })
      if (contextWorkflow.changed) {
        latestContext = await buildLoopContextWithWorkflow(input, workflowState, recentActions, blockers)
      }
      const handoffSummary = workflowHandoffSummary(workflowState)
      if (handoffSummary) {
        done = true
        blocked = true
        summary = handoffSummary
        blockers.push(handoffSummary)
        rememberRecentAction(recentActions, {
          step,
          toolName: 'workflow_state',
          argumentsSummary: `phase=${workflowState.phase}`,
          status: 'blocked',
          observation: handoffSummary,
        })
        emit('done', handoffSummary, step)
        ctx.trace.record({ phase: 'agent_loop', action: handoffSummary, status: 'blocked' })
        await recordWorkflowSnapshot(workflowState, step, handoffSummary)
        await recordWorkflowHandoffPermission(workflowState, step, handoffSummary)
        break
      }
      messages.push({ role: 'user', content: `UPDATED_CONTEXT\n${renderUserContext(latestContext)}` })
    }

    await sessionEvent({
      type: 'turn_completed',
      turnId,
      message: `Turn ${step} completed.`,
      data: { done, blocked, toolCalls },
    })

    if (done) break
  }

  if (!done) {
    summary = `Reached step budget (${maxSteps}) without agent_done.`
    emit('warn', summary, step)
    ctx.trace.record({ phase: 'agent_loop', action: summary, status: 'warn' })
  }

  await finalizeSession(
    done && !blocked ? 'completed' : 'blocked',
    { steps: step, toolCalls, done, blocked, summary, workflowState },
    done && !blocked ? undefined : summary,
  )

  return { steps: step, toolCalls, done, blocked, summary, workflowState }
}

function turnIdForStep(step: number): string {
  return `turn_${String(step).padStart(3, '0')}`
}

function compactReason(tokenBudget: TokenBudgetSnapshot): string {
  const estimated = tokenBudget.estimatedTotalTokens ?? 0
  const threshold = tokenBudget.compactThresholdTokens
  if (threshold !== undefined) {
    return `Estimated context ${estimated} tokens reached compaction threshold ${threshold}.`
  }
  return `Estimated context ${estimated} tokens reached compaction threshold.`
}

function compactedMessageSet(
  messages: ChatMessage[],
  input: {
    systemContent: string
    compactedMessage: ChatMessage
    keepRecentMessages: number
  },
): ChatMessage[] {
  return [
    { role: 'system', content: input.systemContent },
    input.compactedMessage,
    ...recentMessagesForCompaction(messages, input.keepRecentMessages),
  ]
}

function recentMessagesForCompaction(messages: ChatMessage[], keepRecentMessages: number): ChatMessage[] {
  const keep = normalizeKeepRecentMessages(keepRecentMessages)
  if (keep === 0) return []
  const candidates = messages.filter((message) => (
    message.role !== 'system' && !isCompactedRunContextMessage(message)
  ))
  return sanitizeRecentMessageTail(candidates.slice(Math.max(0, candidates.length - keep)))
}

function sanitizeRecentMessageTail(messages: ChatMessage[]): ChatMessage[] {
  let tail = [...messages]
  while (tail[0]?.role === 'tool') tail = tail.slice(1)

  while (tail[0]?.role === 'assistant' && tail[0].tool_calls?.length) {
    const missingToolCallIds = new Set(tail[0].tool_calls.map((toolCall) => toolCall.id))
    let index = 1
    while (index < tail.length && tail[index].role === 'tool') {
      const toolCallId = tail[index].tool_call_id
      if (toolCallId) missingToolCallIds.delete(toolCallId)
      index += 1
    }
    if (missingToolCallIds.size === 0) break
    tail = tail.slice(index)
    while (tail[0]?.role === 'tool') tail = tail.slice(1)
  }

  return tail
}

function normalizeKeepRecentMessages(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_KEEP_RECENT_MESSAGES
  return Math.max(0, Math.floor(value))
}

function isCompactedRunContextMessage(message: ChatMessage): boolean {
  return message.role === 'user' && message.content.startsWith(COMPACTED_RUN_CONTEXT_PREFIX)
}

function sessionEventTypeForStatus(status: Extract<AgentSessionStatus, 'completed' | 'blocked' | 'failed' | 'aborted'>) {
  if (status === 'completed') return 'session_completed'
  if (status === 'failed') return 'session_failed'
  if (status === 'aborted') return 'session_aborted'
  return 'session_blocked'
}

function buildLoopContextWithWorkflow(
  input: AgentLoopInput,
  workflowState: WorkflowState,
  recentActions: ContextRecentAction[],
  blockers: string[],
) {
  return buildLoopContext(
    {
      goal: input.goal,
      resume: input.resume,
      ctx: input.ctx,
      extraContext: input.extraContext,
      safetyMode: input.safetyMode,
      workflowState,
    },
    recentActions,
    blockersWithWorkflow(blockers, workflowState),
  )
}

function blockersWithWorkflow(blockers: string[], workflowState: WorkflowState): string[] {
  const next = [...blockers]
  if (workflowState.humanHandoffRequired && workflowState.blocker && !next.includes(workflowState.blocker)) {
    next.push(workflowState.blocker)
  }
  return next
}

function workflowHandoffSummary(workflowState: WorkflowState): string | undefined {
  if (workflowState.phase === 'login_required') return 'Human login required before continuing.'
  if (workflowState.phase === 'captcha_required') return 'Human verification required before continuing.'
  return undefined
}

function workflowHandoffKind(workflowState: WorkflowState): Extract<GateKind, 'login' | 'captcha'> | undefined {
  if (workflowState.phase === 'login_required') return 'login'
  if (workflowState.phase === 'captcha_required') return 'captcha'
  return undefined
}

function briefArgs(name: string, args: Record<string, unknown>): string {
  const parts: string[] = []
  for (const [k, v] of Object.entries(args)) {
    if (v === undefined || v === null) continue
    const s = typeof v === 'string' ? (v.length > 40 ? `${v.slice(0, 40)}…` : v) : String(v)
    parts.push(`${k}=${s}`)
  }
  return parts.length ? parts.join(', ') : '(no args)'
}

function labelForClick(args: Record<string, unknown>, ctx: ToolContext): string {
  const ref = String(args.ref ?? '')
  const stored = sessionManager.get(ctx.sessionId)?.latestSnapshot?.refMap.get(ref)
  return [stored?.name, stored?.text].filter(Boolean).join(' ')
}

function markConfirmed(call: { name: string; arguments: Record<string, unknown> }): void {
  if (call.name === 'browser_click' || call.name === 'browser_click_text' || call.name === 'browser_upload_file') {
    call.arguments.confirmed = true
  }
}

function noteWithPermission(note: string, policy: PolicyEngineDecision, permission: PermissionDecision): string {
  return [
    note,
    `Policy [${policy.policyCode}]: ${policy.reason}`,
    `Permission [${permission.ruleId}]: ${permission.reason}`,
  ].join('\n')
}

function policyMetadata(decision: PolicyEngineDecision): Record<string, unknown> {
  return {
    schemaVersion: decision.schemaVersion,
    action: decision.action,
    riskLevel: decision.riskLevel,
    gateKind: decision.gateKind,
    requiresFreshContext: decision.requiresFreshContext,
    policyCode: decision.policyCode,
    ruleId: decision.ruleId,
    workflowPhase: decision.workflowPhase,
    auditTags: decision.auditTags,
  }
}

function permissionRequestMetadata(request: PermissionRequest): Record<string, unknown> {
  return {
    schemaVersion: request.schemaVersion,
    requestId: request.requestId,
    runId: request.runId,
    sessionId: request.sessionId,
    turnId: request.turnId,
    step: request.step,
    requestedAt: request.requestedAt,
    subject: permissionSubjectMetadata(request),
    risk: request.risk,
    riskLevel: request.riskLevel,
    currentUrl: request.currentUrl,
    workflowPhase: request.workflowPhase,
    gateKind: request.gateKind,
    policy: { ...request.policy, auditTags: [...request.policy.auditTags] },
    context: request.context
      ? {
          ...request.context,
          ...(request.context.freshness && typeof request.context.freshness === 'object'
            ? { freshness: { ...(request.context.freshness as Record<string, unknown>) } }
            : {}),
        }
      : undefined,
  }
}

function permissionSubjectMetadata(request: PermissionRequest): Record<string, unknown> {
  if (request.subject.kind === 'tool_call') {
    return {
      ...request.subject,
      args: { ...request.subject.args },
    }
  }
  return { ...request.subject }
}

function permissionMetadata(decision: PermissionDecision): Record<string, unknown> {
  return {
    schemaVersion: decision.schemaVersion,
    requestId: decision.requestId,
    action: decision.action,
    source: decision.source,
    ruleId: decision.ruleId,
    policyCode: decision.policyCode,
    policyRuleId: decision.policyRuleId,
    risk: decision.risk,
    riskLevel: decision.riskLevel,
    reason: decision.reason,
    decidedAt: decision.decidedAt,
    gateKind: decision.gateKind,
    requiresFreshContext: decision.requiresFreshContext,
    rememberable: decision.rememberable,
    remember: {
      supportedScopes: [...decision.remember.supportedScopes],
      defaultScope: decision.remember.defaultScope,
    },
    auditTags: [...decision.auditTags],
  }
}

function approvalInputFor(request: PermissionRequest, decision: PermissionDecision): ApprovalEnqueueInput {
  const gateKind = decision.gateKind ?? request.gateKind ?? fallbackGateKind(request)
  const toolCallId = permissionToolCallId(request)
  const toolName = permissionToolName(request)
  const argBrief = request.subject.kind === 'tool_call' ? request.subject.argBrief : undefined
  return {
    id: approvalIdFor(request),
    runId: request.runId,
    sessionId: request.sessionId,
    ...(request.turnId ? { turnId: request.turnId } : {}),
    ...(toolCallId ? { toolCallId } : {}),
    permissionRequestId: request.requestId,
    reason: decision.reason,
    gateKind,
    ...(request.risk ? { risk: request.risk } : {}),
    riskLevel: decision.riskLevel,
    title: approvalTitle(gateKind),
    message: approvalMessage(request),
    context: {
      ...(request.currentUrl ? { url: request.currentUrl } : {}),
      ...(request.risk ? { risk: request.risk } : {}),
      detail: decision.reason,
      ...(toolName ? { toolName } : {}),
      ...(argBrief ? { argBrief } : {}),
      policyCode: request.policy.policyCode,
      ruleId: decision.ruleId,
      ...(request.workflowPhase ? { workflowPhase: request.workflowPhase } : {}),
      permissionReason: decision.reason,
    },
    metadata: {
      permission: permissionMetadata(decision),
      policy: { ...request.policy, auditTags: [...request.policy.auditTags] },
    },
  }
}

function approvalIdFor(request: PermissionRequest): string {
  return request.requestId.replace(/^perm_/, 'appr_')
}

function approvalTitle(gateKind: GateKind): string {
  if (gateKind === 'final_submit') return 'Approval required: Final submission'
  if (gateKind === 'upload_resume') return 'Approval required: Upload resume'
  if (gateKind === 'save_resume') return 'Approval required: Save resume draft'
  if (gateKind === 'login') return 'Approval required: Login'
  if (gateKind === 'captcha') return 'Approval required: Captcha / verification'
  return 'Approval required: High-risk action'
}

function approvalMessage(request: PermissionRequest): string {
  if (request.subject.kind === 'tool_call') {
    return `Agent wants to ${request.subject.toolName} (${request.subject.argBrief ?? briefArgs(request.subject.toolName, request.subject.args)})`
  }
  return request.subject.reason
}

function fallbackGateKind(request: PermissionRequest): GateKind {
  if (request.subject.kind === 'workflow_handoff') return request.subject.handoffKind
  return 'high_risk_action'
}

function approvalMetadata(approval: ApprovalRequest): Record<string, unknown> {
  return {
    schemaVersion: approval.schemaVersion,
    id: approval.id,
    approvalId: approval.approvalId,
    permissionRequestId: approval.permissionRequestId,
    runId: approval.runId,
    sessionId: approval.sessionId,
    turnId: approval.turnId,
    toolCallId: approval.toolCallId,
    status: approval.status,
    kind: approval.kind,
    gateKind: approval.gateKind,
    risk: approval.risk,
    riskLevel: approval.riskLevel,
    title: approval.title,
    message: approval.message,
    reason: approval.reason,
    context: approval.context ? { ...approval.context } : undefined,
    allowedDecisions: [...approval.allowedDecisions],
    createdAt: approval.createdAt,
    updatedAt: approval.updatedAt,
    resolvedAt: approval.resolvedAt,
    expiresAt: approval.expiresAt,
    resolution: approval.resolution ? approvalResolutionMetadata(approval.resolution) : undefined,
    metadata: approval.metadata ? { ...approval.metadata } : undefined,
  }
}

function approvalResolutionMetadata(resolution: ApprovalResolution): Record<string, unknown> {
  return {
    schemaVersion: resolution.schemaVersion,
    id: resolution.id,
    approvalId: resolution.approvalId,
    permissionRequestId: resolution.permissionRequestId,
    status: resolution.status,
    decision: resolution.decision,
    source: resolution.source,
    reason: resolution.reason,
    resolvedAt: resolution.resolvedAt,
    decidedAt: resolution.decidedAt,
    data: resolution.data ? { ...resolution.data } : undefined,
  }
}

function permissionToolCallId(request: PermissionRequest): string | undefined {
  return request.subject.kind === 'tool_call' ? request.subject.toolCallId : undefined
}

function permissionToolName(request: PermissionRequest): string | undefined {
  return request.subject.kind === 'tool_call' ? request.subject.toolName : undefined
}

function permissionSubjectLabel(request: PermissionRequest): string {
  if (request.subject.kind === 'tool_call') return request.subject.toolName
  return `workflow_${request.subject.handoffKind}`
}

function rememberApproval(approvals: ApprovalRequest[], approval: ApprovalRequest, maxApprovals = 24): void {
  const existingIndex = approvals.findIndex((item) => item.approvalId === approval.approvalId)
  if (existingIndex >= 0) approvals[existingIndex] = approval
  else approvals.push(approval)
  if (approvals.length > maxApprovals) approvals.splice(0, approvals.length - maxApprovals)
}

function rememberRecentAction(
  actions: ContextRecentAction[],
  action: Omit<ContextRecentAction, 'at'>,
  maxActions = 12,
): void {
  actions.push({ ...action, at: new Date().toISOString() })
  if (actions.length > maxActions) actions.splice(0, actions.length - maxActions)
}

function toolMessage(toolCallId: string, content: string): ChatMessage {
  return { role: 'tool', tool_call_id: toolCallId, content }
}

function workflowRecentActions(
  actions: ContextRecentAction[],
  current: {
    toolName?: string
    toolResult?: NormalizedToolResult | LocalToolRunResult
    policyDecision?: PolicyEngineDecision
    gateKind?: GateKind
    gateDecision?: GateDecision
    agentDoneBlocked?: boolean
  },
): NonNullable<WorkflowEngineInput['recentActions']> {
  const mapped = actions.map((action) => ({
    toolName: action.toolName,
    at: action.at,
    summary: action.observation ?? action.argumentsSummary,
  }))
  const hasCurrent =
    current.toolName ||
    current.toolResult ||
    current.policyDecision ||
    current.gateKind ||
    current.gateDecision ||
    typeof current.agentDoneBlocked === 'boolean'
  if (!hasCurrent) return mapped

  return [
    ...mapped,
    {
      ...(current.toolName ? { toolName: current.toolName } : {}),
      ...(current.toolResult ? { toolResult: current.toolResult } : {}),
      ...(current.policyDecision ? { policyDecision: current.policyDecision } : {}),
      ...(current.gateKind ? { gateKind: current.gateKind } : {}),
      ...(current.gateDecision ? { gateDecision: current.gateDecision } : {}),
      ...(typeof current.agentDoneBlocked === 'boolean'
        ? {
            agentDoneBlocked: current.agentDoneBlocked,
            blocked: current.agentDoneBlocked,
            done: current.toolName === 'agent_done' || current.toolResult?.done === true,
          }
        : {}),
      at: new Date().toISOString(),
      summary: current.toolResult?.observation,
    },
  ]
}

function workflowPageEvidenceSummary(page: NonNullable<WorkflowEngineInput['page']>): string {
  const title = page.title ? ` "${page.title}"` : ''
  return `Page${title} is classified as ${page.pageType}.`
}

function workflowPageEvidenceData(page: NonNullable<WorkflowEngineInput['page']>): Record<string, unknown> {
  return {
    url: page.url,
    title: page.title,
    pageType: page.pageType,
    interactiveCount: page.interactiveCount,
    formCount: page.formCount,
    linkCount: page.linkCount,
    buttonCount: page.buttonCount,
    inputCount: page.inputCount,
    textSummary: truncateForWorkflowEvidence(page.textSummary),
    updatedAt: page.updatedAt,
  }
}

function workflowFormEvidenceSummary(form: NonNullable<WorkflowEngineInput['form']>): string {
  return `Form has ${form.fields.length} field(s), ${form.filledFields.length} filled, ${form.missingRequired.length} missing required.`
}

function workflowFormEvidenceData(form: NonNullable<WorkflowEngineInput['form']>): Record<string, unknown> {
  return {
    url: form.url,
    fieldCount: form.fields.length,
    filledFieldCount: form.filledFields.length,
    missingRequiredCount: form.missingRequired.length,
    submitCandidateCount: form.submitCandidates.length,
    uploadHintCount: form.uploadHints?.length ?? 0,
    visibleErrorCount: form.visibleErrors?.length ?? 0,
    updatedAt: form.updatedAt,
  }
}

function workflowToolResultSummary(toolName: string, result: NormalizedToolResult | LocalToolRunResult): string {
  return `${toolName}: ${truncateForWorkflowEvidence(result.observation, 240)}`
}

function workflowToolResultEvidenceData(result: NormalizedToolResult | LocalToolRunResult): Record<string, unknown> {
  return {
    observation: truncateForWorkflowEvidence(result.observation),
    pageChanged: Boolean(result.pageChanged),
    done: Boolean(result.done),
    ...(result.risk ? { risk: result.risk } : {}),
    ...(result.data !== undefined ? { data: compactWorkflowEvidenceData(result.data) } : {}),
  }
}

function compactWorkflowEvidenceData(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value
  if (Array.isArray(value)) return { itemCount: value.length }
  const record = value as Record<string, unknown>
  return {
    ...('url' in record ? { url: record.url } : {}),
    ...('title' in record ? { title: record.title } : {}),
    ...('ok' in record ? { ok: record.ok } : {}),
    ...('error' in record ? { error: record.error } : {}),
    keys: Object.keys(record).slice(0, 24),
  }
}

function truncateForWorkflowEvidence(value: string, maxLength = 500): string {
  if (value.length <= maxLength) return value
  return `${value.slice(0, maxLength - 1)}…`
}
