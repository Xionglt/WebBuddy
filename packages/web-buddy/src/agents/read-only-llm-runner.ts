import { join } from 'node:path'
import type { ChatCompletion, ChatMessage, ChatOptions } from '../sdk/llm.js'
import { estimateChatMessages, estimateTokens } from '../kernel/token-budget.js'
import {
  CONTRACT_READ_ONLY_ARTIFACT_TOOL_NAMES,
  ContractReadOnlyArtifactToolError,
  executeContractReadOnlyArtifactTool,
  readOnlySubagentToolSchemas,
  type ImmutableArtifactReader,
  type ReadOnlySubagentToolCall,
} from './agent-runner.js'
import type {
  AgentTaskRunControlV1,
  AgentTaskRunOutcome,
  AgentTaskRunRequestV1,
  BuiltInRoleOutputV1,
  ImmutableArtifactRef,
  JsonValue,
  ReadOnlyLlmTaskRunnerV1,
  ReadOnlySubagentResult,
  ResultFreshnessVerdict,
  RunnerError,
  RunnerErrorCode,
  RunnerProgressPhase,
  TaskContractError,
} from './async-task-contracts.js'
import { createSidechainSession, type SidechainSession } from './sidechain-session.js'
import {
  getBuiltInRoleRuntimeBinding,
  isBuiltInAgentRoleId,
  toBuiltInRoleEnvelopeBinding,
  validateBuiltInRoleOutputPayload,
} from './built-in-roles.js'
import { multiAgentDigest } from './multi-agent-contracts.js'

type ReadOnlyLlmRunRequest = Extract<AgentTaskRunRequestV1, { runnerKind: 'read_only_llm' }>
type ReadOnlyLlmRunOutcome = Exclude<AgentTaskRunOutcome, { outcome: 'succeeded_deterministic' }>
type ReadOnlyLlmContextEnvelope = ReadOnlyLlmRunRequest['contextEnvelope']

export interface SubagentLlmClient {
  chatWithTools(messages: ChatMessage[], options?: ChatOptions): Promise<ChatCompletion>
}

export interface ReadOnlyLlmSubagentRunnerOptions {
  llm: SubagentLlmClient
  artifactReader: ImmutableArtifactReader
  sidechainOutputDir: string | ((request: ReadOnlyLlmRunRequest) => string)
  runnerId?: string
  runnerVersion?: string
  now?: () => Date
}

export class ReadOnlyLlmSubagentRunner implements ReadOnlyLlmTaskRunnerV1 {
  readonly contractVersion = 'agent-task-runner/v1' as const
  readonly runnerId: string
  readonly runnerVersion: string
  readonly kinds = ['candidate_job_research', 'trace_summarization'] as const
  readonly capacityClass = 'read_only_llm' as const
  readonly runnerKind = 'read_only_llm' as const

  private readonly llm: SubagentLlmClient
  private readonly artifactReader: ImmutableArtifactReader
  private readonly sidechainOutputDir: ReadOnlyLlmSubagentRunnerOptions['sidechainOutputDir']
  private readonly now: () => Date

  constructor(options: ReadOnlyLlmSubagentRunnerOptions) {
    this.llm = options.llm
    this.artifactReader = options.artifactReader
    this.sidechainOutputDir = options.sidechainOutputDir
    this.runnerId = options.runnerId ?? 'read_only_llm'
    this.runnerVersion = options.runnerVersion ?? '1.0.0'
    this.now = options.now ?? (() => new Date())
  }

  async run(request: ReadOnlyLlmRunRequest, control: AgentTaskRunControlV1): Promise<ReadOnlyLlmRunOutcome> {
    const validationError = validateRunRequest(request, this)
    if (validationError) return failedOutcome(validationError)
    if (control.abortSignal.aborted) return abortedOutcome('signal')
    const deadline = Date.now() + request.limits.overallTimeoutMs

    const outputDir = typeof this.sidechainOutputDir === 'function'
      ? this.sidechainOutputDir(request)
      : this.sidechainOutputDir
    const sidechain = await createSidechainSession({
      taskId: request.runIdentity.taskId,
      agentId: `${this.runnerId}-${request.runIdentity.attempt}`,
      runId: request.contextEnvelope.parentRunId,
      sessionId: request.contextEnvelope.parentSessionId,
      outputDir,
      transcriptPath: join(outputDir, 'subagents', safePart(request.runIdentity.taskId), `attempt-${request.runIdentity.attempt}.jsonl`),
      now: this.now,
    })
    let progressSeq = 0
    const progress = async (phase: RunnerProgressPhase, summary: string): Promise<void> => {
      throwIfAborted(control.abortSignal)
      progressSeq += 1
      const value = {
        schemaVersion: 'agent-task-runner-progress/v1',
        runIdentity: request.runIdentity,
        progressSeq,
        phase,
        summary,
        occurredAt: this.now().toISOString(),
        authoritativeCompletionEvidence: false,
      } as const
      await sidechain.recordProgress(value)
      await invokeRuntimeOperation(control.reportProgress(value), control.abortSignal, deadline)
    }

    try {
      await sidechain.append({
        type: 'sidechain_started',
        message: `Read-only LLM sidechain started for ${request.task.kind}.`,
        data: {
          runIdentity: request.runIdentity,
          runnerId: this.runnerId,
          runnerVersion: this.runnerVersion,
          allowedTools: request.contextEnvelope.allowedTools,
          limits: request.limits,
          parentHistoryIncluded: false,
          authoritativeCompletionEvidence: false,
        },
      })
      await sidechain.append({
        type: 'sidechain_context_envelope',
        message: request.contextEnvelope.envelopeId,
        data: {
          envelopeId: request.contextEnvelope.envelopeId,
          sourceGraphRevision: request.contextEnvelope.sourceGraphRevision,
          selectedContextIds: request.contextEnvelope.selectedContext.map((item) => item.id),
          omittedContextIds: request.contextEnvelope.omittedContext.map((item) => item.id),
          parentHistoryIncluded: false,
        },
      })
      await progress('initializing', 'Validated the read-only task boundary and independent context envelope.')

      const outcome = await this.runLoop(request, control, sidechain, progress, deadline)
      return outcome
    } catch (error) {
      if (isTaskContractError(error)) throw error
      if (error instanceof RunAbortError) {
        await appendAbortIfPossible(sidechain, error.reason)
        return abortedOutcome(error.reason)
      }
      const runnerError = toRunnerError(error)
      await appendFailureIfPossible(sidechain, runnerError)
      return failedOutcome(runnerError)
    }
  }

  private async runLoop(
    request: ReadOnlyLlmRunRequest,
    control: AgentTaskRunControlV1,
    sidechain: SidechainSession,
    progress: (phase: RunnerProgressPhase, summary: string) => Promise<void>,
    deadline: number,
  ): Promise<ReadOnlyLlmRunOutcome> {
    const messages = initialMessages(request.contextEnvelope)
    const artifactRefs = selectedArtifactRefs(request.contextEnvelope)
    let toolCallCount = 0
    let outputTokens = 0

    assertInputBudget(messages, request.limits.maxInputTokens)

    for (let turn = 1; turn <= request.limits.maxTurns; turn += 1) {
      throwIfAborted(control.abortSignal)
      if (Date.now() >= deadline) throw new RunAbortError('timeout')
      assertInputBudget(messages, request.limits.maxInputTokens)
      const remainingOutputTokens = request.limits.maxOutputTokens - outputTokens
      if (remainingOutputTokens <= 0) throw budgetError('Subagent output token budget is exhausted.')

      await progress('reasoning', `Starting isolated LLM turn ${turn} of ${request.limits.maxTurns}.`)
      const completion = await invokeLlmWithLimits({
        llm: this.llm,
        messages,
        options: {
          tools: readOnlySubagentToolSchemas(request.contextEnvelope.allowedTools),
          toolChoice: 'auto',
          jsonMode: true,
          temperature: 0.1,
          maxTokens: remainingOutputTokens,
          timeoutMs: request.limits.perRequestTimeoutMs,
          redactTrace: true,
        },
        signal: control.abortSignal,
        perRequestTimeoutMs: request.limits.perRequestTimeoutMs,
        deadline,
      })
      const completionTokens = estimateCompletionTokens(completion)
      outputTokens += completionTokens
      if (outputTokens > request.limits.maxOutputTokens) {
        throw budgetError('Subagent output exceeded the configured token budget.')
      }

      const assistantMessage = assistantMessageFrom(completion)
      messages.push(assistantMessage)
      await sidechain.append({
        type: 'sidechain_assistant',
        message: completion.content,
        data: {
          turn,
          toolCalls: completion.toolCalls,
          estimatedOutputTokens: completionTokens,
          cumulativeOutputTokens: outputTokens,
        },
      })

      if (completion.toolCalls.length === 0) {
        await progress('validating_output', 'Validating structured recommendations and evidence references.')
        const draft = parseStructuredResult(completion.content, request.contextEnvelope, artifactRefs)
        throwIfAborted(control.abortSignal)
        const freshness = freshnessFor(request)
        await sidechain.append({
          type: 'sidechain_completed',
          message: draft.summary,
          data: {
            recommendations: draft.recommendations,
            evidenceRefs: draft.evidenceRefs,
            uncertainties: draft.uncertainties,
            ...(draft.roleOutput ? { roleOutput: draft.roleOutput } : {}),
            freshness,
            requiresMainWorkflowVerification: true,
            authoritativeCompletionEvidence: false,
          },
        })
        throwIfAborted(control.abortSignal)
        const sidechainTranscriptRef = await sidechain.finalizeTranscript(request.task.actionBinding)
        if (control.abortSignal.aborted) return abortedOutcome('signal')
        const result: ReadOnlySubagentResult = {
          schemaVersion: 'read-only-subagent-result/v1',
          runIdentity: request.runIdentity,
          runnerId: this.runnerId,
          runnerVersion: this.runnerVersion,
          envelopeId: request.contextEnvelope.envelopeId,
          sourceGraphRevision: request.contextEnvelope.sourceGraphRevision,
          freshness,
          summary: draft.summary,
          recommendations: draft.recommendations,
          evidenceRefs: draft.evidenceRefs,
          uncertainties: draft.uncertainties,
          ...(draft.roleOutput ? { roleOutput: draft.roleOutput } : {}),
          sidechainTranscriptRef,
          requiresMainWorkflowVerification: true,
          authoritativeCompletionEvidence: false,
        }
        return { schemaVersion: 'agent-task-run-outcome/v1', outcome: 'succeeded', result }
      }

      if (toolCallCount + completion.toolCalls.length > request.limits.maxToolCalls) {
        throw budgetError('Subagent tool-call budget is exhausted.')
      }
      await progress('reading_artifacts', `Executing ${completion.toolCalls.length} immutable artifact read call(s).`)
      for (const call of completion.toolCalls) {
        throwIfAborted(control.abortSignal)
        toolCallCount += 1
        await sidechain.append({
          type: 'sidechain_tool_call',
          message: call.name,
          data: { turn, toolCallId: call.id, name: call.name, arguments: call.arguments },
        })
        try {
          const result = await invokeRuntimeOperation(
            executeContractReadOnlyArtifactTool({
              call,
              allowedTools: request.contextEnvelope.allowedTools,
              artifacts: artifactRefs,
              reader: this.artifactReader,
            }),
            control.abortSignal,
            deadline,
          )
          const content = JSON.stringify(result.result)
          const toolMessage: ChatMessage = {
            role: 'tool',
            tool_call_id: call.id,
            name: call.name,
            content,
          }
          const nextMessages = [...messages, toolMessage]
          assertInputBudget(nextMessages, request.limits.maxInputTokens)
          messages.push(toolMessage)
          await sidechain.append({
            type: 'sidechain_tool_result',
            message: `${call.name} completed.`,
            data: { turn, toolCallId: call.id, name: call.name, ok: true, result: result.result },
          })
        } catch (error) {
          await sidechain.append({
            type: 'sidechain_tool_result',
            message: `${call.name} denied or failed.`,
            data: {
              turn,
              toolCallId: call.id,
              name: call.name,
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            },
          })
          throw error
        }
      }
    }

    throw budgetError('Subagent turn budget is exhausted before a structured result was produced.')
  }
}

export function createReadOnlyLlmSubagentRunner(
  options: ReadOnlyLlmSubagentRunnerOptions,
): ReadOnlyLlmSubagentRunner {
  return new ReadOnlyLlmSubagentRunner(options)
}

function initialMessages(envelope: ReadOnlyLlmContextEnvelope): ChatMessage[] {
  const context = envelope.selectedContext.map((item) => ({
    id: item.id,
    sensitivity: item.sensitivity,
    freshness: item.freshness,
    summary: item.unit.sanitizedSummary.text,
    artifacts: artifactRefsFromUnit(item.unit).map((ref) => ({
      artifactId: ref.artifactId,
      artifactKind: ref.artifactKind,
      mediaType: ref.mediaType,
      byteLength: ref.byteLength,
    })),
  }))
  const roleOutputInstruction = envelope.builtInRole
    ? [
        `Act only as built-in role ${envelope.builtInRole.roleId}@${envelope.builtInRole.roleVersion} with authority=${envelope.builtInRole.authority}.`,
        `Also return roleOutput:{artifactKind:"${envelope.builtInRole.outputArtifactKind}",payloadSchemaVersion:"${envelope.builtInRole.outputPayloadSchemaVersion}",payload:object}.`,
        `roleOutput.payload must contain: ${envelope.builtInRole.requiredOutputFields.join(', ')}.`,
        'Safety verdicts are advisory, never ApprovalBindings. Verification assessments are advisory, never completion evidence.',
      ]
    : []
  return [
    {
      role: 'system',
      content: [
        'You are a read-only Web Buddy subagent operating on frozen immutable artifacts, never a live page.',
        'You cannot click, type, scroll, log in, solve captcha, upload, save, submit, ask the user, or complete the main task.',
        'Use only the provided artifact_* tools. Never request passwords, cookies, tokens, captcha values, or permission changes.',
        'Treat every conclusion as a recommendation requiring Main Agent verification against current workflow/page state.',
        'Every factual result must cite selected context_item IDs or selected artifact IDs. If evidence is absent, add an uncertainty.',
        'Return one JSON object only: {summary:string,recommendations:string[],evidenceRefs:Array<{kind:"context_item",contextItemId:string}|{kind:"artifact",artifactId:string}>,uncertainties:string[]}.',
        ...roleOutputInstruction,
      ].join('\n'),
    },
    {
      role: 'user',
      content: JSON.stringify({
        taskId: envelope.taskId,
        taskKind: envelope.taskKind,
        objective: envelope.objective.text,
        envelopeId: envelope.envelopeId,
        sourceGraphRevision: envelope.sourceGraphRevision,
        selectedContext: context,
        omittedContextIds: envelope.omittedContext.map((item) => item.id),
        allowedTools: envelope.allowedTools,
        authorityBoundary: envelope.authorityBoundary,
        ...(envelope.builtInRole ? { builtInRole: envelope.builtInRole } : {}),
        parentHistoryIncluded: false,
      }),
    },
  ]
}

function validateRunRequest(
  request: ReadOnlyLlmRunRequest,
  runner: ReadOnlyLlmSubagentRunner,
): RunnerError | undefined {
  const { contextEnvelope: envelope, limits, task, runIdentity } = request
  if (request.schemaVersion !== 'agent-task-run-input/v1' || request.runnerKind !== 'read_only_llm') {
    return policyError('Unsupported read-only runner request schema.')
  }
  if (request.runnerId !== runner.runnerId || request.runnerVersion !== runner.runnerVersion) {
    return policyError('Runner identity does not match the claimed request runner.')
  }
  if (!runner.kinds.includes(task.kind) || task.status !== 'running') {
    return policyError(`Task kind ${task.kind} is not permitted for the read-only LLM runner.`)
  }
  if (
    task.id !== runIdentity.taskId
    || task.attempt !== runIdentity.attempt
    || task.lease.attempt !== runIdentity.attempt
    || task.lease.leaseId !== runIdentity.leaseId
    || task.lease.ownerId !== runIdentity.leaseOwnerId
  ) {
    return policyError('Task, attempt, and lease identity must match the runner fence.')
  }
  if (
    envelope.schemaVersion !== 'subagent-context-envelope/v1'
    || envelope.taskId !== task.id
    || envelope.taskKind !== task.kind
    || envelope.sourceGraphRevision !== request.graphRevision
  ) {
    return policyError('Context envelope does not match the read-only task.')
  }
  if (
    envelope.parentHistoryIncluded !== false
    || envelope.authorityBoundary.browserWrite !== false
    || envelope.authorityBoundary.livePageAccess !== false
    || envelope.authorityBoundary.authoritativeCompletionEvidence !== false
    || envelope.authorityBoundary.requiresMainWorkflowVerification !== true
    || Object.values(envelope.authorityBoundary.gates).some((allowed) => allowed !== false)
  ) {
    return policyError('Context envelope attempts to expand Subagent authority.')
  }
  if (envelope.allowedTools.some((name) => !CONTRACT_READ_ONLY_ARTIFACT_TOOL_NAMES.includes(name))) {
    return policyError('Context envelope exposes a non-artifact tool.')
  }
  if (envelope.builtInRole) {
    if (!isBuiltInAgentRoleId(envelope.builtInRole.roleId)) {
      return policyError(`Unknown built-in role ${envelope.builtInRole.roleId}.`)
    }
    const expectedRole = toBuiltInRoleEnvelopeBinding(getBuiltInRoleRuntimeBinding(envelope.builtInRole.roleId))
    if (multiAgentDigest(envelope.builtInRole) !== multiAgentDigest(expectedRole)
      || envelope.builtInRole.runtimeTaskKind !== task.kind
      || envelope.allowedTools.some((tool) => !envelope.builtInRole!.allowedTools.includes(tool))) {
      return policyError('Context envelope built-in role binding is forged or mismatched.')
    }
  }
  const numericLimits = Object.values(limits)
  if (numericLimits.some((value) => !Number.isSafeInteger(value) || value <= 0)) {
    return budgetError('All runner limits must be positive integers.')
  }
  if (
    envelope.tokenBudget.usedInputTokens > envelope.tokenBudget.maxInputTokens
    || envelope.tokenBudget.usedInputTokens > limits.maxInputTokens
    || envelope.tokenBudget.reservedOutputTokens > limits.maxOutputTokens
  ) {
    return budgetError('Context envelope exceeds the runner token limits.')
  }
  for (const ref of selectedArtifactRefs(envelope)) {
    if (ref.sessionId !== envelope.parentSessionId || ref.runId !== envelope.parentRunId || ref.immutable !== true) {
      return artifactError('Selected artifact ownership or immutability does not match the envelope.')
    }
  }
  return undefined
}

function selectedArtifactRefs(envelope: ReadOnlyLlmContextEnvelope): ImmutableArtifactRef[] {
  const refs = envelope.selectedContext.flatMap((item) => artifactRefsFromUnit(item.unit))
  const unique = new Map<string, ImmutableArtifactRef>()
  for (const ref of refs) unique.set(ref.artifactId, ref)
  return [...unique.values()]
}

function artifactRefsFromUnit(unit: ReadOnlyLlmContextEnvelope['selectedContext'][number]['unit']): ImmutableArtifactRef[] {
  const refs = unit.kind === 'artifact'
    ? [unit.artifactRef, ...unit.sanitizedSummary.sourceArtifactRefs]
    : unit.kind === 'structured_projection'
      ? [...unit.evidenceRefs, ...unit.sanitizedSummary.sourceArtifactRefs]
      : [unit.callArtifactRef, unit.resultArtifactRef, ...unit.sanitizedSummary.sourceArtifactRefs]
  return refs.map((ref) => ({
    ...ref,
    storage: { ...ref.storage, relativeSegments: [...ref.storage.relativeSegments] },
    actionBinding: { ...ref.actionBinding },
  }))
}

function assistantMessageFrom(completion: ChatCompletion): ChatMessage {
  return {
    role: 'assistant',
    content: completion.content,
    ...(completion.toolCalls.length
      ? {
          tool_calls: completion.toolCalls.map((call) => ({
            id: call.id,
            type: 'function' as const,
            function: { name: call.name, arguments: JSON.stringify(call.arguments) },
          })),
        }
      : {}),
  }
}

function parseStructuredResult(
  content: string,
  envelope: ReadOnlyLlmContextEnvelope,
  artifacts: readonly ImmutableArtifactRef[],
): Pick<ReadOnlySubagentResult, 'summary' | 'recommendations' | 'evidenceRefs' | 'uncertainties' | 'roleOutput'> {
  let value: unknown
  try {
    value = JSON.parse(content)
  } catch {
    throw schemaError('Subagent final response must be a JSON object without markdown fences.')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw schemaError('Subagent result must be an object.')
  const record = value as Record<string, unknown>
  const summary = requiredResultString(record.summary, 'summary')
  const recommendations = resultStringArray(record.recommendations, 'recommendations')
  const uncertainties = resultStringArray(record.uncertainties, 'uncertainties')
  let roleOutput: BuiltInRoleOutputV1 | undefined
  if (envelope.builtInRole) {
    if (!record.roleOutput || typeof record.roleOutput !== 'object' || Array.isArray(record.roleOutput)) {
      throw schemaError(`Built-in role ${envelope.builtInRole.roleId} must return roleOutput.`)
    }
    const candidate = record.roleOutput as Record<string, unknown>
    const keys = Object.keys(candidate)
    const allowedKeys = ['artifactKind', 'payloadSchemaVersion', 'payload']
    if (keys.length !== allowedKeys.length || keys.some((key) => !allowedKeys.includes(key))) {
      throw schemaError('roleOutput must contain only artifactKind, payloadSchemaVersion, and payload.')
    }
    if (candidate.artifactKind !== envelope.builtInRole.outputArtifactKind
      || candidate.payloadSchemaVersion !== envelope.builtInRole.outputPayloadSchemaVersion) {
      throw schemaError('roleOutput does not match the bound built-in role Artifact Contract.')
    }
    if (!isBuiltInAgentRoleId(envelope.builtInRole.roleId)) {
      throw schemaError(`Unknown built-in role ${envelope.builtInRole.roleId}.`)
    }
    const payload = candidate.payload as JsonValue
    try {
      validateBuiltInRoleOutputPayload(envelope.builtInRole.roleId, payload)
    } catch (error) {
      throw schemaError(error instanceof Error ? error.message : String(error))
    }
    roleOutput = {
      schemaVersion: 'built-in-role-output/v1',
      roleId: envelope.builtInRole.roleId,
      roleVersion: envelope.builtInRole.roleVersion,
      roleDigest: envelope.builtInRole.roleDigest,
      artifactKind: envelope.builtInRole.outputArtifactKind,
      payloadSchemaVersion: envelope.builtInRole.outputPayloadSchemaVersion,
      payload,
      requiresMainWorkflowVerification: true,
      authoritativeCompletionEvidence: false,
    }
  } else if (record.roleOutput !== undefined) {
    throw schemaError('Legacy task output cannot self-assert a built-in role.')
  }
  if (!Array.isArray(record.evidenceRefs) || record.evidenceRefs.length === 0) {
    throw schemaError('Subagent result must include at least one evidence ref.')
  }
  const selectedIds = new Set(envelope.selectedContext.map((item) => item.id))
  const artifactById = new Map(artifacts.map((ref) => [ref.artifactId, ref]))
  const evidenceRefs = record.evidenceRefs.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw schemaError('Invalid evidence ref.')
    const evidence = entry as Record<string, unknown>
    if (evidence.kind === 'context_item' && typeof evidence.contextItemId === 'string' && selectedIds.has(evidence.contextItemId)) {
      return { kind: 'context_item' as const, contextItemId: evidence.contextItemId }
    }
    if (evidence.kind === 'artifact' && typeof evidence.artifactId === 'string') {
      const artifactRef = artifactById.get(evidence.artifactId)
      if (artifactRef) return { kind: 'artifact' as const, artifactRef }
    }
    throw schemaError('Evidence refs must resolve inside the selected context manifest.')
  })
  return { summary, recommendations, evidenceRefs, uncertainties, ...(roleOutput ? { roleOutput } : {}) }
}

function freshnessFor(request: ReadOnlyLlmRunRequest): ResultFreshnessVerdict {
  if (request.task.actionBinding.kind === 'not_action_bound') {
    return { kind: 'not_action_bound', validity: 'not_applicable' }
  }
  const assessedAgainst = request.contextEnvelope.currentActionBinding.kind === 'browser_action'
    ? request.contextEnvelope.currentActionBinding.sourceActionSeq
    : request.task.actionBinding.sourceActionSeq
  return {
    kind: 'assessed',
    sourceActionSeq: request.task.actionBinding.sourceActionSeq,
    assessedAgainstActionSeq: assessedAgainst,
    validity: request.task.actionBinding.sourceActionSeq === assessedAgainst ? 'unverified' : 'stale',
  }
}

async function invokeLlmWithLimits(input: {
  llm: SubagentLlmClient
  messages: ChatMessage[]
  options: ChatOptions
  signal: AbortSignal
  perRequestTimeoutMs: number
  deadline: number
}): Promise<ChatCompletion> {
  const overallRemaining = input.deadline - Date.now()
  if (overallRemaining <= 0) throw new RunAbortError('timeout')
  const timeoutMs = Math.min(input.perRequestTimeoutMs, overallRemaining)
  const timeoutKind = overallRemaining <= input.perRequestTimeoutMs ? 'overall' : 'request'
  return new Promise<ChatCompletion>((resolve, reject) => {
    let settled = false
    const finish = (operation: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      input.signal.removeEventListener('abort', onAbort)
      operation()
    }
    const onAbort = (): void => finish(() => reject(new RunAbortError('signal')))
    const timer = setTimeout(() => finish(() => reject(
      timeoutKind === 'overall' ? new RunAbortError('timeout') : runnerErrorException('LLM_TIMEOUT', 'LLM request timed out.'),
    )), timeoutMs)
    input.signal.addEventListener('abort', onAbort, { once: true })
    void input.llm.chatWithTools(input.messages, { ...input.options, timeoutMs })
      .then((completion) => finish(() => resolve(completion)))
      .catch((error) => finish(() => reject(error)))
  })
}

async function invokeRuntimeOperation<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  deadline: number,
): Promise<T> {
  const remainingMs = deadline - Date.now()
  if (remainingMs <= 0) throw new RunAbortError('timeout')
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const finish = (callback: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      callback()
    }
    const onAbort = (): void => finish(() => reject(new RunAbortError('signal')))
    const timer = setTimeout(() => finish(() => reject(new RunAbortError('timeout'))), remainingMs)
    signal.addEventListener('abort', onAbort, { once: true })
    void operation.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    )
  })
}

function assertInputBudget(messages: ChatMessage[], maxInputTokens: number): void {
  if (estimateChatMessages(messages).totalTokens > maxInputTokens) {
    throw budgetError('Subagent input token budget is exhausted.')
  }
}

function estimateCompletionTokens(completion: ChatCompletion): number {
  return estimateTokens(completion.content) + completion.toolCalls.reduce(
    (total, call) => total + 8 + estimateTokens(call.id) + estimateTokens(call.name) + estimateTokens(JSON.stringify(call.arguments)),
    0,
  )
}

function requiredResultString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw schemaError(`Subagent result ${field} must be a non-empty string.`)
  return value.trim()
}

function resultStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || !entry.trim())) {
    throw schemaError(`Subagent result ${field} must be an array of non-empty strings.`)
  }
  return value.map((entry) => (entry as string).trim())
}

function safePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]+/g, '_').replace(/^_+|_+$/g, '') || 'task'
}

class RunAbortError extends Error {
  constructor(readonly reason: 'signal' | 'lease_lost' | 'session_abort' | 'timeout') {
    super(`Read-only runner aborted: ${reason}`)
    this.name = 'RunAbortError'
  }
}

class RunnerErrorException extends Error {
  constructor(readonly runnerError: RunnerError) {
    super(runnerError.message)
    this.name = 'RunnerErrorException'
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new RunAbortError('signal')
}

function runnerErrorException(code: RunnerErrorCode, message: string): RunnerErrorException {
  return new RunnerErrorException(makeRunnerError(code, message))
}

function policyError(message: string): RunnerError {
  return makeRunnerError('POLICY_VIOLATION', message)
}

function artifactError(message: string): RunnerError {
  return makeRunnerError('ARTIFACT_INTEGRITY_FAILED', message)
}

function schemaError(message: string): RunnerErrorException {
  return runnerErrorException('OUTPUT_SCHEMA_INVALID', message)
}

function budgetError(message: string): RunnerError {
  return makeRunnerError('BUDGET_EXHAUSTED', message)
}

function makeRunnerError(code: RunnerErrorCode, message: string): RunnerError {
  const transient = code === 'LLM_TIMEOUT' || code === 'LLM_TRANSIENT' || code === 'ARTIFACT_NOT_READY'
  const policy = code === 'TOOL_DENIED' || code === 'POLICY_VIOLATION'
  const cancelled = code === 'SESSION_ABORTED'
  return {
    schemaVersion: 'agent-task-runner-error/v1',
    code,
    category: transient ? 'transient' : policy ? 'policy' : cancelled ? 'cancelled' : code === 'INTERNAL' ? 'internal' : 'validation',
    retryDisposition: transient ? 'retry_same_task' : 'never_retry',
    message,
  }
}

function toRunnerError(error: unknown): RunnerError {
  if (error instanceof RunnerErrorException) return error.runnerError
  if (isRunnerError(error)) return error
  if (error instanceof ContractReadOnlyArtifactToolError) return makeRunnerError(error.code, error.message)
  const message = error instanceof Error ? error.message : String(error)
  if (/timeout|timed out|abort/i.test(message)) return makeRunnerError('LLM_TIMEOUT', message)
  if (/HTTP|fetch|network|ECONN|5\d\d/i.test(message)) return makeRunnerError('LLM_TRANSIENT', message)
  return makeRunnerError('INTERNAL', message)
}

function isRunnerError(value: unknown): value is RunnerError {
  return Boolean(
    value
    && typeof value === 'object'
    && (value as { schemaVersion?: unknown }).schemaVersion === 'agent-task-runner-error/v1',
  )
}

function isTaskContractError(value: unknown): value is TaskContractError {
  return Boolean(
    value
    && typeof value === 'object'
    && (value as { schemaVersion?: unknown }).schemaVersion === 'async-task-contract-error/v1',
  )
}

function failedOutcome(error: RunnerError): ReadOnlyLlmRunOutcome {
  return { schemaVersion: 'agent-task-run-outcome/v1', outcome: 'failed', error }
}

function abortedOutcome(reason: 'signal' | 'lease_lost' | 'session_abort' | 'timeout'): ReadOnlyLlmRunOutcome {
  return { schemaVersion: 'agent-task-run-outcome/v1', outcome: 'aborted', reason }
}

async function appendFailureIfPossible(sidechain: SidechainSession, error: RunnerError): Promise<void> {
  await sidechain.append({
    type: 'sidechain_failed',
    message: error.message,
    data: { error, requiresMainWorkflowVerification: true, authoritativeCompletionEvidence: false },
  }).catch(() => undefined)
}

async function appendAbortIfPossible(
  sidechain: SidechainSession,
  reason: 'signal' | 'lease_lost' | 'session_abort' | 'timeout',
): Promise<void> {
  await sidechain.append({
    type: 'sidechain_aborted',
    message: `Read-only sidechain aborted: ${reason}.`,
    data: { reason, authoritativeCompletionEvidence: false },
  }).catch(() => undefined)
}
