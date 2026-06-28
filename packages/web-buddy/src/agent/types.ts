import type { ContextRecentAction } from '../context/types.js'
import type { KernelEvent } from '../kernel/kernel-events.js'
import type { AgentRunController } from '../kernel/run-controller.js'
import type { HumanGate } from '../sdk/human.js'
import type { ChatCompletion, ChatMessage, ChatOptions } from '../sdk/llm.js'
import type { ResumeProfile } from '../sdk/resume.js'
import type { SessionRecorder } from '../session/index.js'
import type { ToolContext, ToolRegistry } from '../runtime/local/tool-registry.js'
import type { TaskState } from '../task/task-state.js'
import type { WorkflowState } from '../workflow/workflow-state.js'

export type AgentSafetyMode = 'guarded' | 'raw'

export type AgentStopReason = 'agent_done' | 'blocked' | 'step_budget' | 'llm_error' | 'aborted' | 'unknown'

export type AgentRuntimeEventLevel = 'think' | 'act' | 'observe' | 'gate' | 'warn' | 'error' | 'done'

export interface AgentRuntimeLlm {
  chatWithTools(messages: ChatMessage[], options?: ChatOptions): Promise<ChatCompletion>
}

export interface AgentRuntimeEvent {
  schemaVersion: 'agent-runtime-event/v1'
  step: number
  level: AgentRuntimeEventLevel
  message: string
}

export interface AgentRuntimeInput {
  /** The natural-language task, e.g. "fill the application form on this page with my resume". */
  goal: string
  resume: ResumeProfile
  llm: AgentRuntimeLlm
  registry?: ToolRegistry
  ctx: ToolContext
  gate: HumanGate
  maxSteps?: number
  onEvent?: (event: AgentRuntimeEvent) => void
  onKernelEvent?: (event: KernelEvent) => void
  /** Extra context lines (e.g. the matched job title) appended to the system prompt. */
  extraContext?: string
  /** `raw` removes job-application workflow guardrails so the model drives the browser directly. */
  safetyMode?: AgentSafetyMode
  /** Optional append-only session recorder for resumable runtime state. */
  session?: SessionRecorder
  /** Optional kernel-level run controller for abort/pause/status integration. */
  controller?: AgentRunController
}

export interface AgentRuntimeResult {
  schemaVersion: 'agent-runtime-result/v1'
  runtime: 'local-agent-loop'
  steps: number
  toolCalls: number
  done: boolean
  blocked: boolean
  summary: string
  stopReason: AgentStopReason
  workflowState?: WorkflowState
}

export interface PromptAssemblerInput {
  goal: string
  resume: ResumeProfile
  ctx: Pick<ToolContext, 'sessionId'>
  extraContext?: string
  taskState?: TaskState
  workflowState?: WorkflowState
  safetyMode?: AgentSafetyMode
}

export interface LoopContextState {
  recentActions: ContextRecentAction[]
  blockers: string[]
}
