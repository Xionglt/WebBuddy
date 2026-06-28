import { AgentKernel } from '../kernel/agent-kernel.js'
import { ToolRegistry } from '../runtime/local/tool-registry.js'
import { StopConditionManager, stopConditionManager } from './stop-condition.js'
import type { AgentRuntimeInput, AgentRuntimeResult } from './types.js'

export interface AgentRuntimeOptions {
  stopConditions?: StopConditionManager
  kernel?: AgentKernel
}

export class AgentRuntime {
  private readonly stopConditions: StopConditionManager
  private readonly kernel: AgentKernel

  constructor(options: AgentRuntimeOptions = {}) {
    this.stopConditions = options.stopConditions ?? stopConditionManager
    this.kernel = options.kernel ?? new AgentKernel()
  }

  async run(input: AgentRuntimeInput): Promise<AgentRuntimeResult> {
    const registry = input.registry ?? new ToolRegistry()
    const kernelResult = await this.kernel.start({
      goal: input.goal,
      resume: input.resume,
      llm: input.llm,
      registry,
      ctx: input.ctx,
      gate: input.gate,
      maxSteps: input.maxSteps,
      onEvent: input.onKernelEvent,
      onRuntimeEvent: input.onEvent,
      extraContext: input.extraContext,
      safetyMode: input.safetyMode,
      session: input.session,
      controller: input.controller,
    })

    return {
      schemaVersion: 'agent-runtime-result/v1',
      runtime: 'local-agent-loop',
      steps: kernelResult.steps,
      toolCalls: kernelResult.toolCalls,
      done: kernelResult.done,
      blocked: kernelResult.blocked,
      summary: kernelResult.summary,
      stopReason: kernelResult.status === 'aborted'
        ? 'aborted'
        : this.stopConditions.inferStopReason(kernelResult, { maxSteps: input.maxSteps }),
      ...(kernelResult.workflowState ? { workflowState: kernelResult.workflowState } : {}),
    }
  }
}
