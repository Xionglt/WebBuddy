import { join } from 'node:path'
import { browserSnapshot } from '../../browser/snapshot.js'
import { browserFormSnapshot } from '../../browser/form-snapshot.js'
import {
  buildLoopContext,
  renderInitialUserContext,
  renderSystemContext,
  renderUserContext,
} from '../../agent/prompt-assembler.js'
import {
  type ContextCompactionInput,
  type ContextCompactionWorkflowEvaluation,
} from '../../context/compaction.js'
import type { ContextCompactionResult } from '../../context/run-summary.js'
import {
  compactContextIfNeeded,
  isCompactedRunContextSystemMarker,
  sanitizeMessageBoundary,
  type SemanticCompactionPipelineOptions,
} from '../../context/compaction-pipeline.js'
import type { MicroCompactionOptions } from '../../context/micro-compaction.js'
import {
  compactRunMemory,
  createRunMemory,
  updateRunMemoryFromModel,
  updateRunMemoryFromTool,
  type RunMemory,
} from '../../context/run-memory.js'
import type { ContextRecentAction, ContextSnapshot } from '../../context/types.js'
import { AnswerStore, type UserAnswer } from '../../context/answer-store.js'
import { ensureMemdir, queryMemdir, renderMemorySearchResult } from '../../memory/index.js'
import { ProfileStore } from '../../context/profile-store.js'
import { createFieldPlanner } from '../../fill/field-planner.js'
import type { FieldPlan } from '../../fill/field-plan.js'
import {
  createFillLedger,
  type FillLedger,
  type FillLedgerEntryStatus,
  type FillLedgerSummary,
} from '../../fill/fill-ledger.js'
import type { TokenBudgetOptions } from '../../kernel/token-budget.js'
import { ApprovalQueue } from '../../permission/approval-queue.js'
import { PermissionEngine } from '../../permission/permission-engine.js'
import {
  appendPersistentPermissionRule,
  persistentPermissionRuleFromDecision,
} from '../../permission/persistent-rules.js'
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
  type PermissionMode,
  type PermissionRememberScope,
  type PermissionRequest,
} from '../../permission/permission-types.js'
import { decideToolPolicy, shouldStopAfterGateDecision, type PolicyEngineDecision } from '../../policy/agent-policy.js'
import { createPolicyAuditEvent } from '../../policy/policy-audit.js'
import {
  RISK_DECISIONS_ARTIFACT,
  appendRiskDecision,
  createPermissionRiskDecision,
  createPolicyRiskDecision,
  createRiskDecisionsArtifact,
  formatCompactRiskDecision,
  formatRiskLine,
  serializeRiskDecisionsArtifact,
  shouldShowCompactRiskDecision,
  type RiskDecisionRecord,
} from '../../policy/risk-decisions.js'
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
import type { ResumeProfile, ResumeProfileV2 } from '../../sdk/resume.js'
import type { RiskLevel } from '../../sdk/trace.js'
import type { LocalToolRunResult } from '../../tools/local-adapter.js'
import { ToolExecutionService } from '../../tools/tool-execution-service.js'
import { toLegacyToolRunResult, type NormalizedToolResult } from '../../tools/tool-result.js'
import {
  FileToolResultStore,
  type ToolResultArtifactKind,
  type ToolResultArtifactRef,
  type ToolResultArtifactSensitivity,
  type ToolResultStore,
} from '../../tools/tool-result-store.js'
import {
  completionGate as defaultCompletionGate,
  type CompletionGateDecision,
  type CompletionGateInput,
  type WebBuddyTaskType,
} from '../../workflow/completion-gate.js'
import { workflowEngine as defaultWorkflowEngine, type WorkflowEngineEvaluation, type WorkflowEngineInput } from '../../workflow/workflow-engine.js'
import { EvidenceStore, type AddWorkflowEvidenceInput, type WorkflowEvidence } from '../../workflow/workflow-evidence.js'
import { createInitialWorkflowState, type WorkflowState } from '../../workflow/workflow-state.js'
import { pageView } from './page-view.js'
import { ToolRegistry, type ToolContext } from './tool-registry.js'

export interface AgentEvent {
  step: number
  level: 'think' | 'risk' | 'decision' | 'act' | 'observe' | 'gate' | 'warn' | 'error' | 'done'
  message: string
}

export interface AgentLoopInput {
  /** The natural-language task, e.g. "fill the application form on this page with my resume". */
  goal: string
  resume: ResumeProfile
  /** Optional full structured resume. This is read-only context until autofill is enabled. */
  resumeV2?: ResumeProfileV2
  /** Optional field plan to inject into FILL_PLAN prompt context. */
  fieldPlan?: FieldPlan
  /** Optional fill ledger summary to inject into FILL_PLAN prompt context. */
  fillLedgerSummary?: FillLedgerSummary
  /** True when the current task includes a concrete local resume file that should be uploaded. */
  requiresCurrentResumeUpload?: boolean
  /** Explicit task contract for completion criteria. */
  taskType?: WebBuddyTaskType
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
  /** User-facing permission profile for deciding which gated actions can auto-allow. */
  permissionMode?: PermissionMode
  /** Explicit future switch for final-submit automation. Defaults false. */
  allowFinalSubmit?: boolean
  /** Optional append-only session recorder for resumable runtime state. */
  session?: SessionRecorder
  /** Chat transcript restored from session transcript and prepended to the next model call. */
  restoredMessages?: ChatMessage[]
  /** Optional kernel/run-controller abort signal. Checked before model/tool work. */
  abortSignal?: AbortSignal
  /** Optional execution service for tests or alternate local runtimes. */
  toolExecutionService?: ToolExecutionService
  /** Optional permission decision service for tests or alternate runtimes. */
  permissionEngine?: AgentLoopPermissionEngine
  /** Optional in-memory approval queue for tests or embedding runtimes. */
  approvalQueue?: AgentLoopApprovalQueue
  /** Context budget. When maxInputTokens is unset, a conservative default window is used. */
  contextBudget?: ContextBudgetOptions
  /** Optional micro-compaction controls for old tool results and snapshots. */
  microCompaction?: MicroCompactionOptions
  /** Optional semantic compaction controls. Enabled by default when the LLM supports chat(). */
  semanticCompaction?: SemanticCompactionPipelineOptions
  /** Optional user-scoped answer memory persisted across runs. */
  persistentAnswerStore?: PersistentAnswerStoreOptions
  /** Optional user-scoped permission memory persisted across runs. */
  persistentPermissionRules?: PersistentPermissionRulesOptions
  /** Optional memdir root for scoped long-term memory retrieval. */
  memdir?: MemdirOptions
  /** Optional deterministic compactor for tests or alternate local runtimes. */
  contextCompactor?: AgentLoopContextCompactor
  /** Optional workflow evaluator for tests or alternate local runtimes. */
  workflowEngine?: AgentLoopWorkflowEngine
  /** Optional completion gate for tests or alternate local runtimes. */
  completionGate?: AgentLoopCompletionGate
  /** Optional store for large tool-result artifacts. Defaults to the run trace artifact directory. */
  toolResultStore?: ToolResultStore
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
  /** Legacy fixed-count override for the raw tail retained after compaction. */
  keepRecentMessages?: number
  /** Fraction of the model input window retained as verbatim recent history. Defaults to 0.2. */
  recentRawTokenRatio?: number
}

export interface PersistentAnswerStoreOptions {
  path: string
}

export interface PersistentPermissionRulesOptions {
  path: string
}

export interface MemdirOptions {
  path: string
}

export interface AgentLoopContextCompactor {
  compact(input: ContextCompactionInput): ContextCompactionResult | Promise<ContextCompactionResult>
}

export interface AgentLoopWorkflowEngine {
  evaluate(input: WorkflowEngineInput): WorkflowEngineEvaluation
}

export interface AgentLoopCompletionGate {
  evaluate(input: CompletionGateInput): CompletionGateDecision
}

interface PermissionGateResponse {
  decision: GateDecision
  rememberScope?: Extract<PermissionRememberScope, 'session' | 'always'>
}

interface RememberingHumanGate extends HumanGate {
  confirmPermission?(
    kind: GateKind,
    message: string,
    context: Parameters<HumanGate['confirm']>[2],
    permission: { request: PermissionRequest; decision: PermissionDecision },
  ): Promise<GateDecision | PermissionGateResponse>
}

const DEFAULT_MAX_STEPS = 16
export const RAW_MODE_EXCLUDED_TOOLS = [
  'job_match_candidates',
  'plan_form_fill',
  'browser_set_field',
] as const

/**
 * The generic ReAct-style loop: the LLM picks browser tools itself, we execute
 * them (gating risky ones), feed observations back, until the model calls
 * `agent_done` or stops. This is what makes the agent work on ANY site — there
 * is no hardcoded field mapping.
 */
export async function runAgentLoop(input: AgentLoopInput): Promise<AgentLoopResult> {
  const { llm, registry, gate, resume, goal, onEvent } = input
  const profileStore = new ProfileStore(resume, input.resumeV2)
  const answerStore = input.ctx.answerStore ?? (input.persistentAnswerStore
    ? await AnswerStore.load(input.persistentAnswerStore.path)
    : new AnswerStore())
  const fillLedger = createFillLedger({
    fieldPlan: input.ctx.fieldPlan ?? input.fieldPlan,
    summary: input.ctx.fillLedgerSummary ?? input.fillLedgerSummary,
  })
  const taskType = input.taskType ?? (input.safetyMode === 'raw' ? 'explore' : 'fill_form')
  const requiresCurrentResumeUpload = input.requiresCurrentResumeUpload ?? false
  let currentResumeUploaded = false
  const ctx: ToolContext = {
    ...input.ctx,
    profileStore: input.ctx.profileStore ?? profileStore,
    answerStore,
    fieldPlan: input.ctx.fieldPlan ?? input.fieldPlan,
    fillLedgerSummary: fillLedger.summary(),
    humanInput: input.ctx.humanInput ?? gate,
    llm,
  }
  const loopInput: AgentLoopInput = { ...input, ctx }
  const safetyMode = input.safetyMode ?? 'guarded'
  const maxSteps = input.maxSteps ?? DEFAULT_MAX_STEPS
  const emit = (level: AgentEvent['level'], message: string, step: number) =>
    onEvent?.({ step, level, message })

  const tools = toolsForSafetyMode(registry, safetyMode)
  const toolExecution = input.toolExecutionService ?? new ToolExecutionService(registry)
  const permissionMode = input.permissionMode ?? 'safe'
  const permissionEngine = input.permissionEngine ?? new PermissionEngine({
    permissionMode,
    allowFinalSubmit: input.allowFinalSubmit ?? false,
  })
  const approvalQueue = input.approvalQueue ?? new ApprovalQueue()
  const workflowEngine = input.workflowEngine ?? defaultWorkflowEngine
  const completionGate = input.completionGate ?? defaultCompletionGate
  const workflowEvidenceStore = new EvidenceStore()
  const session = input.session
  const toolResultStore = input.toolResultStore ?? new FileToolResultStore({
    rootDir: join(ctx.trace.agentTrace?.dir ?? ctx.trace.dir, 'artifacts', 'tool-results'),
  })

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
  const runMemory = createRunMemory()
  let workflowHandoffAttempt = 0
  let lastRecordedSkillContextSignature = ''
  let lastRecordedRelevantMemorySignature = ''
  let consecutiveRejectedAgentDoneToolCalls = 0
  let lastRejectedAgentDoneGateSummary: string | undefined
  let lastRejectedAgentDoneGateReason: string | undefined
  const riskDecisions = createRiskDecisionsArtifact({
    runId: ctx.trace.runId,
    sessionId: ctx.trace.agentTrace?.sessionId ?? ctx.sessionId,
  })
  let lastWorkflowEvaluation: WorkflowEngineEvaluation | undefined

  const persistRiskDecisions = () => {
    ctx.trace.agentTrace?.writeArtifact(
      RISK_DECISIONS_ARTIFACT,
      serializeRiskDecisionsArtifact(riskDecisions),
    )
  }
  const recordRiskDecision = (decision: RiskDecisionRecord) => {
    appendRiskDecision(riskDecisions, decision)
    persistRiskDecisions()
  }
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
  const recordRunMemorySnapshot = async (reason: string, currentStep: number, turnId?: string, toolCallId?: string) => {
    const memory = compactRunMemory(runMemory)
    ctx.trace.agentTrace?.recordEvent('memory_updated', {
      step: currentStep,
      reason,
      memory,
      ...(toolCallId ? { toolCallId } : {}),
    })
    await sessionTranscript({
      type: 'memory_snapshot',
      ...(turnId ? { turnId } : {}),
      memory,
      reason,
    })
    await sessionEvent({
      type: 'memory_updated',
      ...(turnId ? { turnId } : {}),
      ...(toolCallId ? { toolCallId } : {}),
      message: reason,
      data: { memory },
    })
  }
  const recordSkillContextForSession = async (
    snapshot: ContextSnapshot,
    currentStep: number,
    reason: string,
  ) => {
    const skillContext = snapshot.resolvedSkillContext
    if (!skillContext) return
    const signature = skillContextSessionSignature(skillContext)
    if (signature === lastRecordedSkillContextSignature) return
    lastRecordedSkillContextSignature = signature
    const turnId = currentStep > 0 ? turnIdForStep(currentStep) : undefined
    await sessionTranscript({
      type: 'skill_context',
      ...(turnId ? { turnId } : {}),
      context: skillContext,
      reason,
    })
    await sessionEvent({
      type: 'skill_resolved',
      ...(turnId ? { turnId } : {}),
      message: `Resolved ${skillContext.skills.length} skill(s).`,
      data: {
        schemaVersion: skillContext.schemaVersion,
        skillHits: skillContext.skills.length,
        skills: skillContext.skills,
        policyHintCount: skillContext.policyHints.length,
        completionCriterionCount: skillContext.completionCriteria.length,
        memoryQueryCount: skillContext.memoryQueries.length,
        ignoredRelaxations: skillContext.safetyInvariantDigest.ignoredRelaxations,
        reason,
      },
    })
  }
  const recordRelevantMemoriesForSession = async (
    snapshot: ContextSnapshot,
    currentStep: number,
    reason: string,
  ) => {
    const relevantMemories = snapshot.relevantMemories
    if (!relevantMemories) return
    const signature = relevantMemories
    if (signature === lastRecordedRelevantMemorySignature) return
    lastRecordedRelevantMemorySignature = signature
    const turnId = currentStep > 0 ? turnIdForStep(currentStep) : undefined
    const data = {
      source: 'memdir',
      chars: relevantMemories.length,
      preview: truncateForWorkflowEvidence(relevantMemories.replace(/\s+/g, ' ').trim(), 500),
      reason,
    }
    ctx.trace.agentTrace?.recordEvent('memory_retrieved', {
      step: currentStep,
      sessionId: session?.session.sessionId ?? ctx.sessionId,
      ...data,
    })
    await sessionEvent({
      type: 'memory_retrieved',
      ...(turnId ? { turnId } : {}),
      message: 'Relevant memories selected for prompt context.',
      data,
    })
  }
  const syncFillLedgerSummary = (snapshot?: ContextSnapshot): FillLedgerSummary => {
    const summary = fillLedger.summary()
    ctx.fillLedgerSummary = summary
    const formCoverage = latestFormCoverage(snapshot)
    workflowState = {
      ...workflowState,
      fillLedgerSummary: summary,
      ...(formCoverage ? { formCoverage } : {}),
      currentResumeUploaded,
    }
    return summary
  }
  const ensureFieldPlan = async (snapshot: ContextSnapshot): Promise<ContextSnapshot> => {
    if (ctx.fieldPlan || !snapshot.form?.fields?.length) return snapshot
    const planner = createFieldPlanner({ llm })
    ctx.fieldPlan = await planner.plan({
      fields: snapshot.form.fields,
      profileStoreAvailable: Boolean(ctx.profileStore),
      answerStoreAvailable: Boolean(ctx.answerStore),
      profileStore: ctx.profileStore,
      answerStore: ctx.answerStore,
      llm,
      sourceFormUrl: snapshot.form.url,
    })
    return buildLoopContextWithWorkflow(loopInput, workflowState, runMemory, recentActions, blockers)
  }
  const refreshLoopContext = async (reason: string, currentStep: number): Promise<ContextSnapshot> => {
    const snapshot = await ensureFieldPlan(await buildLoopContextWithWorkflow(
      loopInput,
      workflowState,
      runMemory,
      recentActions,
      blockers,
    ))
    await recordSkillContextForSession(snapshot, currentStep, reason)
    await recordRelevantMemoriesForSession(snapshot, currentStep, reason)
    return snapshot
  }
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
  const recordCompletionGateDecision = async (
    decision: CompletionGateDecision,
    currentStep: number,
    options: { toolCallId?: string } = {},
  ) => {
    const turnId = turnIdForStep(currentStep)
    const data = completionGateDecisionMetadata(decision)
    await sessionTranscript({
      type: 'completion_gate',
      turnId,
      decision,
    })
    await sessionEvent({
      type: 'completion_gate_evaluated',
      turnId,
      ...(options.toolCallId ? { toolCallId: options.toolCallId } : {}),
      message: `Completion gate ${decision.action}: ${decision.recommendedStatus}.`,
      data,
    })
  }
  const rememberRejectedAgentDoneGate = (decision: CompletionGateDecision, gateSummary: string) => {
    consecutiveRejectedAgentDoneToolCalls += 1
    lastRejectedAgentDoneGateSummary = gateSummary
    lastRejectedAgentDoneGateReason = decision.reason
  }
  const clearRejectedAgentDoneGateStreak = () => {
    consecutiveRejectedAgentDoneToolCalls = 0
    lastRejectedAgentDoneGateSummary = undefined
    lastRejectedAgentDoneGateReason = undefined
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
      gateKind?: GateKind
      gateDecision?: GateDecision
      agentDoneBlocked?: boolean
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
    workflowState = {
      ...evaluation.state,
      fillLedgerSummary: fillLedger.summary(),
      ...(evaluationInput.form?.formCoverage ? { formCoverage: evaluationInput.form.formCoverage } : {}),
      currentResumeUploaded,
    }
    evaluation.state = workflowState
    lastWorkflowEvaluation = evaluation
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
    const riskDecision = createPermissionRiskDecision({
      step: currentStep,
      request,
      decision,
    })
    recordRiskDecision(riskDecision)
    if (shouldShowCompactRiskDecision(riskDecision)) {
      emit('decision', formatCompactRiskDecision(riskDecision), currentStep)
    }
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
    rememberScope?: Extract<PermissionRememberScope, 'session' | 'always'>,
  ): Promise<ApprovalRequest> => {
    const resolved = approvalQueue.resolve(approval.approvalId, {
      decision: gateDecision,
      source: 'human_gate',
      reason: `HumanGate returned ${gateDecision}.`,
      ...(rememberScope ? { data: { rememberScope } } : {}),
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
  const recordWorkflowHandoffPermission = async (state: WorkflowState, currentStep: number, reason: string): Promise<GateDecision | undefined> => {
    const handoffKind = workflowHandoffKind(state)
    if (!handoffKind) return undefined
    workflowHandoffAttempt += 1
    const turnId = `${turnIdForStep(currentStep)}_handoff_${workflowHandoffAttempt}`
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
    if (decision.action !== 'ask') return undefined

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
      status: gateDecision === 'approve' ? 'ok' : 'blocked',
    })
    return gateDecision
  }
  const finalizeSession = async (
    status: Extract<AgentSessionStatus, 'completed' | 'blocked' | 'failed' | 'aborted'>,
    result: Record<string, unknown>,
    reason?: string,
  ) => {
    persistRiskDecisions()
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
    await finalizeSession('aborted', { steps: step, toolCalls, done, blocked, summary, workflowState, runMemory: compactRunMemory(runMemory) }, summary)
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
    data: { goal, safetyMode, permissionMode, maxSteps },
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

  let latestContext = await refreshLoopContext('Initial context built.', step)
  const refreshLatestContextForAgentDone = async (currentStep: number): Promise<ContextSnapshot> => {
    const page = sessionManager.get(ctx.sessionId)?.page
    await page?.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {})
    await browserSnapshot({ sessionId: ctx.sessionId }).catch(() => undefined)
    await browserFormSnapshot({ sessionId: ctx.sessionId }).catch(() => undefined)
    latestContext = await refreshLoopContext('Refreshed context before agent_done.', currentStep)
    syncFillLedgerSummary(latestContext)
    ctx.trace.record({
      phase: 'agent_loop',
      action: 'Refreshed page and form state before evaluating agent_done.',
      url: page?.url(),
      status: 'ok',
    })
    await sessionEvent({
      type: 'workflow_updated',
      turnId: turnIdForStep(currentStep),
      message: 'Refreshed page and form state before agent_done.',
      data: {
        url: page?.url(),
        pageType: latestContext.page?.pageType,
        missingRequiredCount: latestContext.form?.missingRequired.length ?? 0,
        uploadHintCount: latestContext.form?.uploadHints?.length ?? 0,
      },
    })
    return latestContext
  }
  const refreshWorkflowAfterApprovedHandoff = async (
    currentStep: number,
    handoffKind: Extract<GateKind, 'login' | 'captcha'>,
  ): Promise<string | undefined> => {
    const page = sessionManager.get(ctx.sessionId)?.page
    await page?.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {})
    const snap = await browserSnapshot({ sessionId: ctx.sessionId })
    if (snap.ok) {
      ctx.trace.record({
        phase: 'agent_loop',
        action: `Refreshed browser snapshot after ${handoffKind} hand-off.`,
        url: page?.url(),
        status: 'ok',
      })
    }
    latestContext = await refreshLoopContext(`Refreshed context after ${handoffKind} handoff.`, currentStep)
    syncFillLedgerSummary(latestContext)
    const contextWorkflow = await evaluateWorkflow(currentStep, `Workflow handoff ${handoffKind} approved; refreshed page state.`, {
      currentUrl: page?.url(),
      page: latestContext.page,
      form: latestContext.form,
    })
    if (contextWorkflow.changed) {
      latestContext = await refreshLoopContext(`Workflow handoff ${handoffKind} changed context.`, currentStep)
    }
    return workflowHandoffSummary(workflowState)
  }
  const resolveResumableWorkflowHandoff = async (
    currentStep: number,
    initialSummary: string,
  ): Promise<{ resumed: boolean; summary: string }> => {
    let summary = initialSummary
    let handoffKind = workflowHandoffKind(workflowState)
    if (!handoffKind) return { resumed: false, summary }

    while (handoffKind) {
      const gateDecision = await recordWorkflowHandoffPermission(workflowState, currentStep, summary)
      if (gateDecision !== 'approve') return { resumed: false, summary }

      rememberRecentAction(recentActions, {
        step: currentStep,
        toolName: 'workflow_handoff',
        argumentsSummary: `gate=${handoffKind}`,
        status: 'ok',
        risk: 'L4',
        observation: `Human approved ${handoffKind} handoff; refreshing page state before continuing.`,
      })
      emit('gate', `Human ${handoffKind} hand-off approved; refreshing the page state before continuing.`, currentStep)

      const refreshedSummary = await refreshWorkflowAfterApprovedHandoff(currentStep, handoffKind)
      if (!refreshedSummary) return { resumed: true, summary }

      const refreshedKind = workflowHandoffKind(workflowState)
      if (!refreshedKind) return { resumed: true, summary: refreshedSummary }
      summary = refreshedSummary
      handoffKind = refreshedKind
      emit('gate', `${summary} Finish it in the browser, then approve again; choose decline/takeover to stop.`, currentStep)
    }

    return { resumed: false, summary }
  }
  const initialWorkflow = await evaluateWorkflow(step, 'Initial workflow snapshot.', {
    currentUrl: sessionManager.get(ctx.sessionId)?.page.url(),
    page: latestContext.page,
    form: latestContext.form,
  })
  if (initialWorkflow.changed) {
    latestContext = await refreshLoopContext('Initial workflow changed context.', step)
  }
  const initialHandoffSummary = workflowHandoffSummary(workflowState)
  if (initialHandoffSummary) {
    const handoff = await resolveResumableWorkflowHandoff(step, initialHandoffSummary)
    if (!handoff.resumed) {
      emit('done', handoff.summary, step)
      ctx.trace.record({ phase: 'agent_loop', action: handoff.summary, status: 'blocked' })
      await finalizeSession('blocked', { steps: step, toolCalls, summary: handoff.summary, workflowState, runMemory: compactRunMemory(runMemory) }, handoff.summary)
      return { steps: step, toolCalls, done: true, blocked: true, summary: handoff.summary, workflowState }
    }
    firstView = ''
  }
  syncFillLedgerSummary(latestContext)
  let messages: ChatMessage[] = initialMessageSet(latestContext, firstView, input.restoredMessages)
  const maybeCompactMessages = async (turnId: string) => {
    const compaction = await compactContextIfNeeded({
      goal,
      runId: session?.session.runId ?? ctx.trace.runId,
      sessionId: session?.session.sessionId ?? ctx.sessionId,
      turnId,
      step,
      messages,
      systemContent: renderSystemContext(latestContext),
      tokenBudgetOptions: tokenBudgetOptionsForLoop(input),
      keepRecentMessages: input.contextBudget?.keepRecentMessages,
      recentRawTokenRatio: input.contextBudget?.recentRawTokenRatio,
      latestContext,
      workflowState,
      recentActions,
      blockers,
      permissionRequests,
      permissionDecisions,
      approvals,
      evidence: workflowEvidenceStore.snapshot(),
      workflowEvaluation: workflowEvaluationForCompaction(lastWorkflowEvaluation, done, blocked),
      compactor: input.contextCompactor,
      semanticLlm: input.llm,
      semanticCompaction: input.semanticCompaction,
      microCompaction: input.microCompaction,
    })
    await sessionEvent({
      type: 'token_budget_updated',
      turnId,
      message: 'Token budget updated.',
      data: {
        tokenBudget: compaction.tokenBudget,
        ...(compaction.postMicroTokenBudget ? { postMicroTokenBudget: compaction.postMicroTokenBudget } : {}),
        ...(compaction.microCompaction?.applied ? { microCompaction: compaction.microCompaction.stats } : {}),
      },
    })

    if (!compaction.fullCompactionApplied) {
      if (compaction.changed) {
        messages = compaction.messages
        ctx.trace.agentTrace?.recordEvent('context_micro_compacted', {
          turnId,
          step,
          reason: compaction.reason,
          stats: compaction.microCompaction?.stats,
          tokenBudget: compaction.tokenBudget,
          postMicroTokenBudget: compaction.postMicroTokenBudget,
        })
        await sessionEvent({
          type: 'context_compacted',
          turnId,
          message: `Context micro-compacted: ${compaction.reason ?? 'old tool results were compacted.'}`,
          data: {
            mode: 'micro',
            stats: compaction.microCompaction?.stats,
            tokenBudget: compaction.tokenBudget,
            postMicroTokenBudget: compaction.postMicroTokenBudget,
          },
        })
      }
      return
    }

    if (!compaction.compaction || !compaction.postCompactionTokenBudget) return

    await sessionTranscript({
      type: 'context_compaction',
      turnId,
      summaryId: compaction.compaction.summary.summaryId,
      reason: compaction.reason ?? 'Context compacted.',
      tokenBudget: compaction.tokenBudget,
      postCompactionTokenBudget: compaction.postCompactionTokenBudget,
      mode: compaction.compaction.summary.compactMode ?? 'structured',
      microCompaction: compaction.microCompaction?.stats,
      recentRawRetention: compaction.recentRawRetention,
      ...(compaction.semanticError ? { semanticError: compaction.semanticError } : {}),
      summary: compaction.compaction.summary,
    })
    ctx.trace.agentTrace?.recordEvent('context_compacted', {
      turnId,
      step,
      reason: compaction.reason,
      summaryId: compaction.compaction.summary.summaryId,
      tokenBudget: compaction.tokenBudget,
      postMicroTokenBudget: compaction.postMicroTokenBudget,
      postCompactionTokenBudget: compaction.postCompactionTokenBudget,
      mode: compaction.compaction.summary.compactMode,
      semanticError: compaction.semanticError,
      stats: compaction.compaction.stats,
      microCompaction: compaction.microCompaction?.stats,
      recentRawRetention: compaction.recentRawRetention,
    })
    await sessionEvent({
      type: 'context_compacted',
      turnId,
      message: `Context compacted: ${compaction.reason}`,
      data: {
        summaryId: compaction.compaction.summary.summaryId,
        summary: compaction.compaction.summary,
        tokenBudget: compaction.tokenBudget,
        postMicroTokenBudget: compaction.postMicroTokenBudget,
        postCompactionTokenBudget: compaction.postCompactionTokenBudget,
        mode: compaction.compaction.summary.compactMode,
        semanticError: compaction.semanticError,
        stats: compaction.compaction.stats,
        microCompaction: compaction.microCompaction?.stats,
        recentRawRetention: compaction.recentRawRetention,
      },
    })

    messages = compaction.messages
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
      await finalizeSession('failed', { steps: step, toolCalls, summary: message, workflowState, runMemory: compactRunMemory(runMemory) }, message)
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
    if (updateRunMemoryFromModel({
      memory: runMemory,
      content: completion.content,
      toolCalls: completion.toolCalls.map((call) => ({ name: call.name, arguments: call.arguments })),
    })) {
      await recordRunMemorySnapshot('Run memory updated from model message.', step, turnId)
    }

    if (completion.content.trim()) {
      emit('think', completion.content.replace(/\s+/g, ' ').slice(0, 200), step)
    }

    // No tool calls → model is done (or narrating). Treat as final.
    if (completion.toolCalls.length === 0) {
      summary = completion.content.trim() || 'model produced no further tool calls'
      done = true
      if (safetyMode !== 'raw' && isFinalSubmitBoundaryActive(workflowState, lastWorkflowEvaluation)) {
        const completionGateDecision = completionGate.evaluate({
          done,
          blocked: false,
          summary,
          workflowState,
          workflowEvaluation: lastWorkflowEvaluation,
          page: latestContext.page,
          form: latestContext.form,
          formCoverage: latestFormCoverage(latestContext),
          fillLedgerSummary: fillLedger.summary(),
          requiresCurrentResumeUpload,
          currentResumeUploaded,
          taskType,
          source: 'model_no_tool_calls',
        })
        await recordCompletionGateDecision(completionGateDecision, step)
        if (completionGateDecision.action === 'block') {
          blocked = true
          summary = completionGateDecision.reason
          const completionGateBlockSummary = completionGateBlockerSummary(completionGateDecision)
          rememberUniqueBlocker(blockers, completionGateBlockSummary)
          emit('gate', completionGateBlockSummary, step)
          ctx.trace.record({
            phase: 'agent_loop',
            action: completionGateBlockSummary,
            url: sessionManager.get(ctx.sessionId)?.page.url(),
            status: 'blocked',
            observation: completionGateDecision.reason.slice(0, 300),
          })
        }
      }
      emit('done', `Loop ended (no tool calls). ${summary.slice(0, 160)}`, step)
      ctx.trace.record({
        phase: 'agent_loop',
        action: `Loop ended: ${summary.slice(0, 200)}`,
        status: blocked ? 'blocked' : 'ok',
      })
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
      if (call.name !== 'agent_done') clearRejectedAgentDoneGateStreak()
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
      const contextText = actionIntentContextText(latestContext)
      const policyDecision = decideToolPolicy({
        toolName: call.name,
        args: call.arguments,
        risk,
        safetyMode,
        refLabel,
        contextText,
        freshness: latestContext.freshness,
      })
      const policyAudit = createPolicyAuditEvent({
        sessionId: ctx.sessionId,
        step,
        toolName: call.name,
        risk,
        decision: policyDecision,
      })
      ctx.trace.agentTrace?.recordEvent('policy_decision', policyAudit)
      const policyRiskDecision = createPolicyRiskDecision({
        step,
        toolName: call.name,
        action: `${call.name}(${argBrief})`,
        risk,
        url: currentUrl,
        permissionMode,
        decision: policyDecision,
        timestamp: policyAudit.at,
      })
      recordRiskDecision(policyRiskDecision)
      if (shouldShowCompactRiskDecision(policyRiskDecision)) {
        emit('risk', formatRiskLine(policyRiskDecision), step)
      }
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
        if (isRefreshableStaleContextDeny(policyDecision, permissionDecision)) {
          emit('gate', `[permission:deny] ${call.name}(${argBrief}); refresh page/form state before retrying.`, step)
          await evaluateWorkflow(step, `Permission denied ${call.name}; context refresh required.`, {
            turnId,
            toolCallId: call.id,
            currentUrl,
            page: latestContext.page,
            form: latestContext.form,
            policyDecision,
            permissionRequest,
            permissionDecision,
            gateKind: permissionDecision.gateKind ?? policyDecision.gateKind,
          })
          continue
        }
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
        const gateResponse = await confirmPermissionGate(gate, kind, approval.message, approval.context, {
          request: permissionRequest,
          decision: permissionDecision,
        })
        const decision = gateResponse.decision
        const resolvedApproval = await resolveApproval(approval, decision, step, gateResponse.rememberScope)
        await rememberPermissionDecision({
          input,
          request: permissionRequest,
          permissionDecision,
          gateDecision: decision,
          rememberScope: gateResponse.rememberScope,
          step,
          emit,
        })
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
          const note = decision === 'approve'
            ? 'FINAL_SUBMIT_NOT_EXECUTED_AUTOMATICALLY. The human approved awareness of this final-submit step, but the runtime will not click a true final-submit control. If this is actually an application-entry or review-step action, inspect the page and choose the correct non-final control; otherwise ask the human to complete the final submit manually, then continue observing or call agent_done.'
            : `FINAL_SUBMIT_NOT_EXECUTED_AUTOMATICALLY. The human chose ${decision} for this final-submit step. Do not retry this exact final-submit action; continue with any remaining safe checks or call agent_done if no safe work remains.`
          const observation = noteWithPermission(note, policyDecision, permissionDecision)
          messages.push(toolMessage(call.id, observation))
          if (decision !== 'approve') {
            blockers.push(`final_submit gate did not execute ${call.name}(${argBrief}) with decision=${decision}: ${permissionDecision.reason}`)
          }
          rememberRecentAction(recentActions, {
            step,
            toolName: call.name,
            argumentsSummary: argBrief,
            status: decision === 'approve' ? 'warn' : 'blocked',
            risk,
            observation,
          })
          await evaluateWorkflow(step, `Final-submit gate returned control to the agent without executing ${call.name}.`, {
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
            ...(decision !== 'approve' ? { agentDoneBlocked: true } : {}),
          })
          if (decision !== 'approve') {
            blocked = true
            done = true
            summary = `Human ${decision} the final_submit step.`
            break
          }
          continue
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

      let preAgentDoneWorkflowEvaluation: WorkflowEngineEvaluation | undefined
      if (call.name === 'agent_done') {
        await refreshLatestContextForAgentDone(step)
        preAgentDoneWorkflowEvaluation = await evaluateWorkflow(step, 'Before agent_done.', {
          turnId,
          toolCallId: call.id,
          currentUrl: sessionManager.get(ctx.sessionId)?.page.url(),
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
            local: { ...ctx, ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}) },
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
        ctx.trace.agentTrace?.recordEvent('tool_result', {
          step,
          turnId,
          toolName: call.name,
          toolCallId: call.id,
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
        await finalizeSession('failed', { steps: step, toolCalls, toolName: call.name, error: message, workflowState, runMemory: compactRunMemory(runMemory) }, message)
        throw error
      }
      const toolOk = execution?.ok ?? !result.observation.startsWith('FAILED')
      if (call.name === 'plan_form_fill' && toolOk && isFieldPlan(result.data)) {
        ctx.fieldPlan = result.data
        latestContext = await refreshLoopContext(`${call.name} updated field plan.`, step)
        syncFillLedgerSummary(latestContext)
      }
      const fillLedgerUpdate = updateFillLedgerAfterTool(fillLedger, call.name, call.arguments, result, toolOk)
      if (fillLedgerUpdate) {
        syncFillLedgerSummary(latestContext)
        await sessionEvent({
          type: 'workflow_updated',
          turnId,
          toolCallId: call.id,
          message: `FillLedger updated: ${fillLedgerUpdate.status}.`,
          data: {
            fillLedgerSummary: fillLedger.summary(),
            entry: fillLedgerUpdate,
          },
        })
      }
      if (call.name === 'browser_upload_file' && toolOk) {
        currentResumeUploaded = true
        syncFillLedgerSummary(latestContext)
      }
      if (updateRunMemoryFromTool({
        memory: runMemory,
        toolName: call.name,
        args: call.arguments,
        result,
        ok: toolOk,
        currentUrl: sessionManager.get(ctx.sessionId)?.page.url(),
      })) {
        await recordRunMemorySnapshot(`Run memory updated from ${call.name}.`, step, turnId, call.id)
      }
      const compactResult = compactToolResult(result)
      const resultArtifact = await maybeStoreToolResultArtifact({
        store: toolResultStore,
        runId: session?.session.runId ?? ctx.trace.runId,
        sessionId: session?.session.sessionId ?? ctx.sessionId,
        turnId,
        workflowPhase: workflowState.phase,
        riskLevel: risk,
        policyCode: policyDecision.policyCode,
        pageUrl: sessionManager.get(ctx.sessionId)?.page.url(),
        toolName: call.name,
        toolCallId: call.id,
        step,
        result,
      })
      await sessionTranscript({
        type: 'tool_result',
        turnId,
        toolCallId: call.id,
        name: call.name,
        ok: toolOk,
        result: compactResult,
        ...(resultArtifact ? { artifacts: [resultArtifact] } : {}),
        ...(!toolOk ? { error: result.observation } : {}),
      })
      ctx.trace.agentTrace?.recordEvent('tool_result', {
        step,
        turnId,
        toolName: call.name,
        toolCallId: call.id,
        ok: toolOk,
        risk,
        artifactCount: resultArtifact ? 1 : 0,
        ...(resultArtifact
          ? {
              bytes: resultArtifact.bytes,
              kind: resultArtifact.kind,
              sha256: resultArtifact.sha256,
              artifact: resultArtifact,
            }
          : {}),
        observation: result.observation.slice(0, 500),
      })
      if (resultArtifact) {
        ctx.trace.agentTrace?.recordEvent('tool_result_artifact', {
          step,
          turnId,
          toolName: call.name,
          toolCallId: call.id,
          artifactCount: 1,
          bytes: resultArtifact.bytes,
          kind: resultArtifact.kind,
          sha256: resultArtifact.sha256,
          artifact: resultArtifact,
        })
        await sessionEvent({
          type: 'tool_result_artifact',
          turnId,
          toolCallId: call.id,
          message: `Stored large result artifact for ${call.name}.`,
          data: {
            name: call.name,
            artifactCount: 1,
            bytes: resultArtifact.bytes,
            kind: resultArtifact.kind,
            sha256: resultArtifact.sha256,
            artifact: resultArtifact,
          },
        })
      }
      await sessionEvent({
        type: toolOk ? 'tool_completed' : 'tool_failed',
        turnId,
        toolCallId: call.id,
        message: `${call.name} ${toolOk ? 'completed' : 'failed'}.`,
        data: {
          name: call.name,
          result: compactResult,
          ...(resultArtifact ? { artifacts: [resultArtifact] } : {}),
        },
      })
      const userAnswer = userAnswerFromToolResult(result)
      if (call.name === 'ask_user' && userAnswer) {
        if (input.persistentAnswerStore && !toolResultReusedSavedAnswer(result)) {
          await ctx.answerStore?.save(input.persistentAnswerStore.path, userAnswer.at)
        }
        await sessionTranscript({
          type: 'user_answer',
          turnId,
          toolCallId: call.id,
          field: userAnswer.field,
          question: userAnswer.question,
          answer: userAnswer.answer,
          source: userAnswer.source,
          data: userAnswer,
        })
        await sessionEvent({
          type: 'user_answer_recorded',
          turnId,
          toolCallId: call.id,
          message: `User answered ${userAnswer.field}.`,
          data: { field: userAnswer.field, source: userAnswer.source },
        })
      }
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
      let completionGateDecision: CompletionGateDecision | undefined
      let completionGateBlockSummary: string | undefined
      let rejectedPrematureAgentDone = false
      if (call.name === 'agent_done' && result.done && call.arguments.blocked === true) {
        const preAgentDoneGateDecision = completionGate.evaluate({
          done,
          blocked,
          summary,
          workflowState: preAgentDoneWorkflowEvaluation?.state ?? workflowState,
          workflowEvaluation: preAgentDoneWorkflowEvaluation,
          page: latestContext.page,
          form: latestContext.form,
          formCoverage: latestFormCoverage(latestContext),
          fillLedgerSummary: fillLedger.summary(),
          requiresCurrentResumeUpload,
          currentResumeUploaded,
          taskType,
          source: 'agent_done',
        })

        if (preAgentDoneGateDecision.action === 'reject') {
          completionGateDecision = preAgentDoneGateDecision
          await recordCompletionGateDecision(completionGateDecision, step, { toolCallId: call.id })
          rejectedPrematureAgentDone = true
          done = false
          blocked = false
          summary = 'no summary'
          completionGateBlockSummary = completionGateBlockerSummary(completionGateDecision)
          rememberRejectedAgentDoneGate(completionGateDecision, completionGateBlockSummary)
          rememberUniqueBlocker(blockers, completionGateBlockSummary)
          emit('gate', completionGateBlockSummary, step)
          ctx.trace.record({
            phase: 'agent_loop',
            action: completionGateBlockSummary,
            url: sessionManager.get(ctx.sessionId)?.page.url(),
            status: 'warn',
            observation: completionGateDecision.reason.slice(0, 300),
          })
          result = {
            observation: completionGateDecision.reason,
            done: false,
            data: { blocked: false, completionGateAction: 'reject' },
            pageChanged: false,
          }
        }
      }

      if (!rejectedPrematureAgentDone) {
        const workflowEvaluation = await evaluateWorkflow(step, `${call.name} updated workflow state.`, {
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
        if (call.name === 'agent_done' && result.done) {
          completionGateDecision = completionGate.evaluate({
            done,
            blocked,
            summary,
            workflowState,
            workflowEvaluation,
            page: latestContext.page,
            form: latestContext.form,
            formCoverage: latestFormCoverage(latestContext),
            fillLedgerSummary: fillLedger.summary(),
            requiresCurrentResumeUpload,
            currentResumeUploaded,
            taskType,
            source: 'agent_done',
          })
          await recordCompletionGateDecision(completionGateDecision, step, { toolCallId: call.id })

          if (completionGateDecision.action === 'reject') {
            rejectedPrematureAgentDone = true
            done = false
            blocked = false
            summary = 'no summary'
            completionGateBlockSummary = completionGateBlockerSummary(completionGateDecision)
            rememberRejectedAgentDoneGate(completionGateDecision, completionGateBlockSummary)
            rememberUniqueBlocker(blockers, completionGateBlockSummary)
            emit('gate', completionGateBlockSummary, step)
            ctx.trace.record({
              phase: 'agent_loop',
              action: completionGateBlockSummary,
              url: sessionManager.get(ctx.sessionId)?.page.url(),
              status: 'warn',
              observation: completionGateDecision.reason.slice(0, 300),
            })
            result = {
              observation: completionGateDecision.reason,
              done: false,
              data: { blocked: false, completionGateAction: 'reject' },
              pageChanged: false,
            }
          } else if (completionGateDecision.action === 'block') {
            done = true
            blocked = true
            summary = completionGateDecision.reason
            completionGateBlockSummary = completionGateBlockerSummary(completionGateDecision)
            rememberUniqueBlocker(blockers, completionGateBlockSummary)
            emit('gate', completionGateBlockSummary, step)
            ctx.trace.record({
              phase: 'agent_loop',
              action: completionGateBlockSummary,
              url: sessionManager.get(ctx.sessionId)?.page.url(),
              status: 'blocked',
              observation: completionGateDecision.reason.slice(0, 300),
            })
          } else if (completionGateDecision.action === 'allow') {
            done = true
            blocked = false
          }
        }
      }
      rememberRecentAction(recentActions, {
        step,
        toolName: call.name,
        argumentsSummary: argBrief,
        status: !toolOk || rejectedPrematureAgentDone ? 'warn' : blocked && result.done ? 'blocked' : 'ok',
        risk,
        observation: result.observation,
      })
      if (completionGateDecision?.action === 'block' || completionGateDecision?.action === 'reject') {
        rememberRecentAction(recentActions, {
          step,
          toolName: 'completion_gate',
          argumentsSummary: completionGateDecision.action,
          status: completionGateDecision.action === 'reject' ? 'warn' : 'blocked',
          observation: completionGateBlockSummary ?? completionGateDecision.reason,
        })
      }

      // After a page-changing action, refresh the snapshot view so refs stay fresh.
      let observation = result.observation
      if (result.pageChanged && call.name !== 'browser_open' && call.name !== 'browser_snapshot') {
        const snap = await browserSnapshot({ sessionId: ctx.sessionId })
        if (snap.ok) observation = `${observation}\n\n[updated page]\n${pageView(snap.data)}`
      }
      messages.push(toolMessage(call.id, toolMessageContentWithArtifact(observation, resultArtifact)))
      emit('observe', result.observation.replace(/\s+/g, ' ').slice(0, 160), step)

      if (done) break
    }

    if (!done) {
      latestContext = await refreshLoopContext('Context refresh updated prompt context.', step)
      syncFillLedgerSummary(latestContext)
      const contextWorkflow = await evaluateWorkflow(step, 'Context refresh updated workflow state.', {
        currentUrl: sessionManager.get(ctx.sessionId)?.page.url(),
        page: latestContext.page,
        form: latestContext.form,
      })
      if (contextWorkflow.changed) {
        latestContext = await refreshLoopContext('Workflow refresh changed prompt context.', step)
        syncFillLedgerSummary(latestContext)
      }
      const handoffSummary = workflowHandoffSummary(workflowState)
      if (handoffSummary) {
        const handoff = await resolveResumableWorkflowHandoff(step, handoffSummary)
        if (!handoff.resumed) {
          done = true
          blocked = true
          summary = handoff.summary
          blockers.push(handoff.summary)
          rememberRecentAction(recentActions, {
            step,
            toolName: 'workflow_state',
            argumentsSummary: `phase=${workflowState.phase}`,
            status: 'blocked',
            observation: handoff.summary,
          })
          emit('done', handoff.summary, step)
          ctx.trace.record({ phase: 'agent_loop', action: handoff.summary, status: 'blocked' })
          await recordWorkflowSnapshot(workflowState, step, handoff.summary)
          break
        }
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
    if (
      consecutiveRejectedAgentDoneToolCalls > 0 &&
      consecutiveRejectedAgentDoneToolCalls === toolCalls &&
      lastRejectedAgentDoneGateSummary
    ) {
      done = true
      blocked = true
      summary = `Completion gate blocked: ${lastRejectedAgentDoneGateSummary.replace(/^completion_gate rejected:\s*/i, '')}`
      const gateMessage = lastRejectedAgentDoneGateSummary.replace(/^completion_gate rejected/i, 'completion_gate blocked')
      emit('gate', gateMessage, step)
      ctx.trace.record({
        phase: 'agent_loop',
        action: gateMessage,
        status: 'blocked',
        observation: (lastRejectedAgentDoneGateReason ?? summary).slice(0, 300),
      })
    } else {
      summary = `Reached step budget (${maxSteps}) without agent_done.`
      emit('warn', summary, step)
      ctx.trace.record({ phase: 'agent_loop', action: summary, status: 'warn' })
    }
  }

  await finalizeSession(
    done && !blocked ? 'completed' : 'blocked',
    { steps: step, toolCalls, done, blocked, summary, workflowState, runMemory: compactRunMemory(runMemory) },
    done && !blocked ? undefined : summary,
  )

  return { steps: step, toolCalls, done, blocked, summary, workflowState }
}

export function toolsForSafetyMode(registry: ToolRegistry, safetyMode: 'guarded' | 'raw'): ReturnType<ToolRegistry['toOpenAITools']> {
  if (safetyMode === 'raw') return registry.toOpenAITools({ exclude: RAW_MODE_EXCLUDED_TOOLS })
  return registry.toOpenAITools()
}

function turnIdForStep(step: number): string {
  return `turn_${String(step).padStart(3, '0')}`
}

function initialMessageSet(
  latestContext: ContextSnapshot,
  firstView: string,
  restoredMessages: ChatMessage[] | undefined,
): ChatMessage[] {
  const systemMessage: ChatMessage = { role: 'system', content: renderSystemContext(latestContext) }
  const currentContextMessage: ChatMessage = { role: 'user', content: renderInitialUserContext(latestContext, firstView) }
  if (!restoredMessages?.length) return [systemMessage, currentContextMessage]

  const restored = restoredMessages
    .filter((message) => message.role !== 'system')
    .filter((message) => !isCompactedRunContextSystemMarker(message))
  return [
    systemMessage,
    ...sanitizeMessageBoundary(restored),
    currentContextMessage,
  ]
}

function tokenBudgetOptionsForLoop(input: AgentLoopInput): TokenBudgetOptions {
  return {
    ...input.contextBudget,
    modelName: input.contextBudget?.modelName ?? input.llm.label,
  }
}

function skillContextSessionSignature(context: NonNullable<ContextSnapshot['resolvedSkillContext']>): string {
  return JSON.stringify({
    skills: context.skills.map((skill) => ({
      id: skill.id,
      source: skill.source,
      loadMode: skill.loadMode,
      bodyHash: skill.bodyHash,
    })),
    policyHints: context.policyHints.map((hint) => ({
      id: hint.id,
      action: hint.action,
      gateKind: hint.gateKind,
      invariant: hint.invariant,
    })),
    completionCriteria: context.completionCriteria.map((criterion) => ({
      id: criterion.id,
      kind: criterion.kind,
      severity: criterion.severity,
    })),
    memoryQueries: context.memoryQueries.map((query) => ({
      id: query.id,
      scope: query.scope,
      topics: query.topics,
      maxResults: query.maxResults,
    })),
    ignoredRelaxations: context.safetyInvariantDigest.ignoredRelaxations,
  })
}

function sessionEventTypeForStatus(status: Extract<AgentSessionStatus, 'completed' | 'blocked' | 'failed' | 'aborted'>) {
  if (status === 'completed') return 'session_completed'
  if (status === 'failed') return 'session_failed'
  if (status === 'aborted') return 'session_aborted'
  return 'session_blocked'
}

function workflowEvaluationForCompaction(
  evaluation: WorkflowEngineEvaluation | undefined,
  done: boolean,
  blocked: boolean,
): ContextCompactionWorkflowEvaluation | undefined {
  if (!evaluation) return undefined

  const firstBlocker = evaluation.blockers[0]
  const finalSubmitBlocker = evaluation.blockers.find((blocker) => blocker.gateKind === 'final_submit')?.message
  const humanHandoffReason = evaluation.blockers.find((blocker) => blocker.kind === 'human_handoff')?.message

  return {
    ...(finalSubmitBlocker ? { finalSubmitBlocker } : {}),
    ...(firstBlocker ? { blocker: firstBlocker.message } : {}),
    missingCriteria: evaluation.missingCriteria,
    satisfiedCriteria: evaluation.matchedCriteria,
    ...(humanHandoffReason ? { humanHandoffReason } : {}),
    blocked: blocked || evaluation.state.phase === 'blocked',
    done,
    reason: evaluation.reason,
    evaluatedAt: evaluation.state.updatedAt,
  }
}

function isFinalSubmitBoundaryActive(
  workflowState: WorkflowState,
  evaluation: WorkflowEngineEvaluation | undefined,
): boolean {
  if (workflowState.phase === 'final_submit_boundary') return true
  if (/final[-_\s]?submit|final submission|manual takeover/i.test(workflowState.blocker ?? '')) return true
  return evaluation?.blockers.some((blocker) => (
    blocker.gateKind === 'final_submit' ||
    /final[-_\s]?submit|final submission|manual takeover/i.test(blocker.message)
  )) === true
}

function latestFormCoverage(snapshot: ContextSnapshot | undefined) {
  return snapshot?.form?.formCoverage ?? snapshot?.workflowState?.formCoverage
}

function isFieldPlan(value: unknown): value is FieldPlan {
  const plan = objectValue(value)
  return plan.schemaVersion === 'field-plan/v1' && Array.isArray(plan.planned)
}

function updateFillLedgerAfterTool(
  ledger: FillLedger,
  toolName: string,
  args: Record<string, unknown>,
  result: LocalToolRunResult,
  ok: boolean,
): { fieldKey: string; fieldIndex: number; status: FillLedgerEntryStatus } | undefined {
  if (toolName !== 'browser_set_field') return undefined
  const data = normalizedSetFieldData(args, result)
  const fieldIndex = numberValue(data.fieldIndex)
  const fieldKey = stringValue(data.fieldKey) || (fieldIndex === undefined ? undefined : `field_${fieldIndex}`)
  if (!fieldKey || fieldIndex === undefined) return undefined

  const status: FillLedgerEntryStatus = ok ? 'verified' : 'failed'
  ledger.upsert({
    fieldKey,
    fieldIndex,
    label: stringValue(data.label) || stringValue(data.matchedLabel) || fieldKey,
    intendedValue: intendedValueFrom(data.intendedValue),
    status,
    ...(!ok ? { lastError: stringValue(data.reason) || result.observation } : {}),
  })
  return { fieldKey, fieldIndex, status }
}

function normalizedSetFieldData(args: Record<string, unknown>, result: LocalToolRunResult): Record<string, unknown> {
  const field = objectValue(args.field)
  const resultData = objectValue(result.data)
  const failureData = parseSetFieldFailureObservation(result.observation)
  return mergeDefined(field, resultData, failureData, args)
}

function parseSetFieldFailureObservation(observation: string): Record<string, unknown> {
  const start = observation.indexOf('{')
  if (start < 0) return {}
  try {
    const parsed = JSON.parse(observation.slice(start))
    return objectValue(parsed)
  } catch {
    return {}
  }
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function mergeDefined(...objects: Record<string, unknown>[]): Record<string, unknown> {
  const merged: Record<string, unknown> = {}
  for (const object of objects) {
    for (const [key, value] of Object.entries(object)) {
      if (value !== undefined) merged[key] = value
    }
  }
  return merged
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

function intendedValueFrom(value: unknown): string | string[] | null | undefined {
  if (value === null) return null
  if (typeof value === 'string') return value
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) return value
  return undefined
}

async function buildLoopContextWithWorkflow(
  input: AgentLoopInput,
  workflowState: WorkflowState,
  runMemory: RunMemory,
  recentActions: ContextRecentAction[],
  blockers: string[],
) {
  const relevantMemories = await relevantMemoriesFor(input)
  return buildLoopContext(
    {
      goal: input.goal,
      resume: input.resume,
      ctx: input.ctx,
      extraContext: input.extraContext,
      taskState: taskStateForLoop(input, workflowState),
      safetyMode: input.safetyMode,
      workflowState,
      runMemory: compactRunMemory(runMemory),
      relevantMemories,
      fieldPlan: input.ctx.fieldPlan ?? input.fieldPlan,
      fillLedgerSummary: input.ctx.fillLedgerSummary ?? input.fillLedgerSummary ?? workflowState.fillLedgerSummary,
      answerSummary: summarizeAnswerStore(input.ctx.answerStore),
    },
    recentActions,
    blockersWithWorkflow(blockers, workflowState),
  )
}

function taskStateForLoop(input: AgentLoopInput, workflowState: WorkflowState) {
  const criteria: string[] = []
  const blockers: string[] = []
  if (input.requiresCurrentResumeUpload) {
    criteria.push('The current local resume file must be uploaded or re-uploaded to the site before the application draft can be considered ready.')
    criteria.push('After resume upload, refresh page/form state, save required resume/profile changes, then continue to the job application flow.')
    criteria.push('Do not treat an existing on-site resume as sufficient unless it is verified to be the current task resume or the human explicitly says to reuse it.')
    criteria.push('Application-entry buttons such as 投递简历/立即投递/Apply may open the application flow; they are not completion by themselves.')
    if (workflowState.currentResumeUploaded !== true) {
      blockers.push('Current task resume has not been verified as uploaded yet; first explore profile/resume/application areas for upload or re-upload controls.')
    }
  }
  criteria.push('Stop before true final submission controls such as 确认投递/提交申请/final submit, unless the human explicitly approves that final submit action.')
  return {
    schemaVersion: 'task-state/v1' as const,
    goal: input.goal,
    phase: workflowState.phase === 'done'
      ? 'done' as const
      : workflowState.phase === 'blocked' || workflowState.phase === 'external_blocker' || workflowState.phase === 'final_submit_boundary'
        ? 'blocked' as const
        : workflowState.currentResumeUploaded === true
          ? 'reviewing' as const
          : input.requiresCurrentResumeUpload
            ? 'filling' as const
            : 'observing' as const,
    source: 'derived_from_workflow' as const,
    sourceWorkflowPhase: workflowState.phase,
    knownBlockers: blockers,
    completionCriteria: criteria,
    updatedAt: workflowState.updatedAt,
  }
}

function summarizeAnswerStore(answerStore: ToolContext['answerStore']): string | undefined {
  const answers = answerStore?.all() ?? []
  if (answers.length === 0) return undefined
  return answers
    .slice(-12)
    .map((answer) => {
      const options = answer.options?.length ? ` | options=[${answer.options.map(compactAnswerText).join(', ')}]` : ''
      return `- field=${compactAnswerText(answer.field)} | answer=${compactAnswerText(answer.answer)} | source=${answer.source}${options} | at=${answer.at}`
    })
    .join('\n')
}

async function relevantMemoriesFor(input: AgentLoopInput): Promise<string | undefined> {
  if (!input.memdir?.path) return undefined
  try {
    await ensureMemdir(input.memdir.path)
    const result = await queryMemdir(input.memdir.path, {
      schemaVersion: 'memory-query/v1',
      runId: input.ctx.trace.runId,
      sessionId: input.ctx.sessionId,
      scope: ['session', 'project', 'user'],
      kinds: ['user_answer', 'site_fact', 'semantic_note', 'failure_pattern', 'skill_note'],
      topics: input.goal.split(/\s+/).filter((word) => word.length >= 4).slice(0, 8),
      urlOrigin: originForUrl(sessionManager.get(input.ctx.sessionId)?.page.url()),
      maxResults: 5,
      includeSensitive: false,
    })
    return renderMemorySearchResult(result)
  } catch {
    return undefined
  }
}

function originForUrl(url: string | undefined): string | undefined {
  if (!url) return undefined
  try {
    return new URL(url).origin
  } catch {
    return undefined
  }
}

function toolResultReusedSavedAnswer(result: unknown): boolean {
  if (!result || typeof result !== 'object') return false
  const data = (result as { data?: unknown }).data
  return Boolean(data && typeof data === 'object' && (data as { reused?: unknown }).reused === true)
}

function compactAnswerText(value: string): string {
  const compact = value.replace(/\s+/g, ' ').trim()
  return compact.length > 180 ? `${compact.slice(0, 177)}...` : compact
}

function blockersWithWorkflow(blockers: string[], workflowState: WorkflowState): string[] {
  const next = [...blockers]
  if (workflowState.humanHandoffRequired && workflowState.blocker && !next.includes(workflowState.blocker)) {
    next.push(workflowState.blocker)
  }
  return next
}

function workflowHandoffSummary(workflowState: WorkflowState): string | undefined {
  if (workflowState.phase === 'external_blocker') return workflowState.blocker ?? 'External blocker requires human action before continuing.'
  if (workflowState.phase === 'final_submit_boundary') return workflowState.blocker ?? 'Final submit requires human takeover before completion.'
  return undefined
}

function workflowHandoffKind(workflowState: WorkflowState): Extract<GateKind, 'login' | 'captcha'> | undefined {
  if (workflowState.phase !== 'external_blocker') return undefined
  const text = `${workflowState.blocker ?? ''} ${workflowState.reason}`
  if (/captcha|verification|验证码|人机验证/i.test(text)) return 'captcha'
  if (/login|sign in|sso|登录|登陆/i.test(text)) return 'login'
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

function actionIntentContextText(snapshot: ContextSnapshot): string {
  const lines = [
    snapshot.page?.title,
    snapshot.page?.pageType,
    snapshot.page?.textSummary,
    ...(snapshot.form?.submitCandidates ?? []).map((candidate) => candidate.text),
    ...(snapshot.form?.uploadHints ?? []).map((hint) => hint.text),
    ...(snapshot.form?.visibleErrors ?? []),
  ]
  return lines
    .filter((line): line is string => typeof line === 'string' && line.trim().length > 0)
    .join('\n')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1800)
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

function isRefreshableStaleContextDeny(policy: PolicyEngineDecision, permission: PermissionDecision): boolean {
  if (permission.action !== 'deny') return false
  const reason = `${policy.reason} ${permission.reason}`
  return /stale|Refresh page\/form state|Context appears stale/i.test(reason)
}

function policyMetadata(decision: PolicyEngineDecision): Record<string, unknown> {
  return {
    schemaVersion: decision.schemaVersion,
    action: decision.action,
    riskLevel: decision.riskLevel,
    gateKind: decision.gateKind,
    actionIntent: decision.actionIntent,
    requiresFreshContext: decision.requiresFreshContext,
    policyCode: decision.policyCode,
    ruleId: decision.ruleId,
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
    observationPhase: request.observationPhase,
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
    permissionMode: decision.permissionMode,
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

function completionGateDecisionMetadata(decision: CompletionGateDecision): Record<string, unknown> {
  return {
    schemaVersion: decision.schemaVersion,
    action: decision.action,
    recommendedStatus: decision.recommendedStatus,
    reason: decision.reason,
    missingCriteria: decision.missingCriteria,
    blockers: decision.blockers,
    workflowPhase: decision.workflowPhase,
    evidenceIds: decision.evidenceIds,
  }
}

function completionGateBlockerSummary(decision: CompletionGateDecision): string {
  const prefix = decision.action === 'reject' ? 'completion_gate rejected' : 'completion_gate blocked'
  const firstMissing = decision.missingCriteria[0]
  if (firstMissing) {
    const missingKinds = firstMissing.missingEvidenceKinds.length > 0
      ? ` missing ${firstMissing.missingEvidenceKinds.join(', ')}`
      : ''
    return `${prefix}: ${firstMissing.id}${missingKinds}`
  }

  const firstBlocker = decision.blockers[0]
  if (firstBlocker) {
    return `${prefix}: ${truncateForWorkflowEvidence(firstBlocker.message, 180)}`
  }

  return `${prefix}: ${truncateForWorkflowEvidence(decision.reason, 180)}`
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
      ...(request.observationPhase ? { observationPhase: request.observationPhase } : {}),
      permissionReason: decision.reason,
    },
    metadata: {
      permission: permissionMetadata(decision),
      policy: { ...request.policy, auditTags: [...request.policy.auditTags] },
    },
  }
}

async function confirmPermissionGate(
  gate: HumanGate,
  kind: GateKind,
  message: string,
  context: Parameters<HumanGate['confirm']>[2],
  permission: { request: PermissionRequest; decision: PermissionDecision },
): Promise<PermissionGateResponse> {
  const rememberingGate = gate as RememberingHumanGate
  const response = rememberingGate.confirmPermission
    ? await rememberingGate.confirmPermission(kind, message, context, permission)
    : await gate.confirm(kind, message, context)
  if (typeof response === 'string') return { decision: response }
  return response
}

async function rememberPermissionDecision(input: {
  input: AgentLoopInput
  request: PermissionRequest
  permissionDecision: PermissionDecision
  gateDecision: GateDecision
  rememberScope?: Extract<PermissionRememberScope, 'session' | 'always'>
  step: number
  emit: (level: AgentEvent['level'], message: string, step: number) => void
}): Promise<void> {
  if (!input.input.persistentPermissionRules?.path) return
  if (input.gateDecision !== 'approve') return
  if (!input.rememberScope) return
  if (!input.permissionDecision.remember.supportedScopes.includes(input.rememberScope)) return

  const rule = persistentPermissionRuleFromDecision({
    id: rememberedPermissionRuleId(input.request, input.rememberScope),
    decision: {
      ...input.permissionDecision,
      action: 'allow',
      source: 'user',
      reason: `Remembered human approval (${input.rememberScope}) for this non-final high-risk action.`,
    },
    request: input.request,
    rememberScope: input.rememberScope,
  })
  if (!rule) return

  try {
    await appendPersistentPermissionRule(input.input.persistentPermissionRules.path, rule)
    input.emit('decision', `Remembered permission (${input.rememberScope}) for ${permissionSubjectLabel(input.request)}.`, input.step)
  } catch (error) {
    input.emit('warn', `Permission remember write failed: ${error instanceof Error ? error.message : String(error)}`, input.step)
  }
}

function rememberedPermissionRuleId(
  request: PermissionRequest,
  scope: Extract<PermissionRememberScope, 'session' | 'always'>,
): string {
  const subject = request.subject.kind === 'tool_call'
    ? request.subject.toolName
    : `workflow_${request.subject.handoffKind}`
  const origin = originForUrl(request.currentUrl) ?? 'any-origin'
  return `remember_${scope}_${safeArtifactName(subject)}_${safeArtifactName(request.policy.policyCode)}_${safeArtifactName(origin)}`
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

function rememberUniqueBlocker(blockers: string[], blocker: string, maxBlockers = 12): void {
  if (!blockers.includes(blocker)) blockers.push(blocker)
  if (blockers.length > maxBlockers) blockers.splice(0, blockers.length - maxBlockers)
}

function toolMessage(toolCallId: string, content: string): ChatMessage {
  return { role: 'tool', tool_call_id: toolCallId, content }
}

const TOOL_RESULT_ARTIFACT_THRESHOLD_BYTES = 12 * 1024
const TOOL_MESSAGE_OBSERVATION_CHARS = 6000

async function maybeStoreToolResultArtifact(input: {
  store: ToolResultStore
  runId: string
  sessionId: string
  turnId: string
  workflowPhase?: string
  riskLevel?: RiskLevel
  policyCode?: string
  pageUrl?: string
  toolName: string
  toolCallId: string
  step: number
  result: unknown
}): Promise<ToolResultArtifactRef | undefined> {
  const content = stringifyPretty(input.result)
  const originalBytes = Buffer.byteLength(content, 'utf8')
  if (originalBytes <= TOOL_RESULT_ARTIFACT_THRESHOLD_BYTES) return undefined

  const ref = await input.store.write({
    runId: input.runId,
    sessionId: input.sessionId,
    toolCallId: input.toolCallId,
    toolName: input.toolName,
    kind: toolResultArtifactKind(input.toolName, input.result),
    content: input.result,
    sensitivity: toolResultArtifactSensitivity(input.toolName, content),
    retention: { scope: 'run', deleteWithSession: true },
    summary: toolResultArtifactSummary(input.toolName, input.result),
    metadata: {
      pageUrl: input.pageUrl,
      workflowPhase: input.workflowPhase,
      riskLevel: input.riskLevel,
      policyCode: input.policyCode,
    },
  })
  await input.store.read(ref)
  return ref
}

function toolMessageContentWithArtifact(observation: string, artifact: ToolResultArtifactRef | undefined): string {
  const visible = observation.slice(0, TOOL_MESSAGE_OBSERVATION_CHARS)
  if (!artifact) return visible
  return [
    visible,
    '',
    `<tool_result_artifact_ref artifactId="${artifact.artifactId}" kind="${artifact.kind}" bytes="${artifact.bytes}" sha256="${artifact.sha256}" />`,
  ].join('\n')
}

function toolResultArtifactKind(toolName: string, result: unknown): ToolResultArtifactKind {
  const normalized = toolName.toLowerCase()
  if (normalized.includes('screenshot')) return 'browser_screenshot'
  if (normalized.includes('snapshot') || normalized.includes('form')) return 'page_snapshot'
  if (normalized.includes('resume_query')) return 'resume_query'
  if (normalized.includes('network')) return 'network_log'
  if (typeof result === 'string') return 'text'
  return 'generic_json'
}

function toolResultArtifactSensitivity(toolName: string, content: string): ToolResultArtifactSensitivity {
  const normalized = toolName.toLowerCase()
  if (/(password|cookie|token|secret|authorization|storage[_-]?state)/i.test(content)) return 'secret'
  if (/(resume|profile|ask_user|upload|set_field|browser_type|form|snapshot)/i.test(normalized)) return 'personal'
  return 'internal'
}

function toolResultArtifactSummary(toolName: string, result: unknown): string {
  if (result && typeof result === 'object') {
    const observation = (result as { observation?: unknown }).observation
    if (typeof observation === 'string' && observation.trim()) {
      return `${toolName}: ${observation.replace(/\s+/g, ' ').trim().slice(0, 240)}`
    }
  }
  return `${toolName}: large tool result stored outside the prompt context.`
}

function stringifyPretty(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function safeArtifactName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || 'item'
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
    ...(page.facts ? { facts: page.facts } : {}),
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
    ...(form.facts ? { facts: form.facts } : {}),
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

function userAnswerFromToolResult(result: LocalToolRunResult): UserAnswer | undefined {
  const data = result.data
  if (!data || typeof data !== 'object') return undefined
  const answer = (data as { userAnswer?: unknown }).userAnswer
  if (!answer || typeof answer !== 'object') return undefined
  const candidate = answer as Partial<UserAnswer>
  if (
    typeof candidate.field !== 'string' ||
    typeof candidate.question !== 'string' ||
    typeof candidate.answer !== 'string' ||
    candidate.source !== 'ask_user'
  ) {
    return undefined
  }
  return {
    field: candidate.field,
    question: candidate.question,
    answer: candidate.answer,
    at: typeof candidate.at === 'string' ? candidate.at : new Date().toISOString(),
    source: 'ask_user',
    ...(Array.isArray(candidate.options) ? { options: candidate.options.map(String) } : {}),
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
