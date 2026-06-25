import { runAgentLoop } from '../runtime/local/agent-loop.js'
import { ToolRegistry } from '../runtime/local/tool-registry.js'
import type { LlmGateway } from '../sdk/llm.js'
import { StopConditionManager, stopConditionManager } from './stop-condition.js'
import type { AgentRuntimeInput, AgentRuntimeResult } from './types.js'

export interface AgentRuntimeOptions {
  stopConditions?: StopConditionManager
}

export class AgentRuntime {
  private readonly stopConditions: StopConditionManager

  constructor(options: AgentRuntimeOptions = {}) {
    this.stopConditions = options.stopConditions ?? stopConditionManager
  }

  async run(input: AgentRuntimeInput): Promise<AgentRuntimeResult> {
    const registry = input.registry ?? new ToolRegistry()
    const loopResult = await runAgentLoop({
      goal: input.goal,
      resume: input.resume,
      llm: input.llm as LlmGateway,
      registry,
      ctx: input.ctx,
      gate: input.gate,
      maxSteps: input.maxSteps,
      onEvent: input.onEvent
        ? (event) => input.onEvent?.({ schemaVersion: 'agent-runtime-event/v1', ...event })
        : undefined,
      extraContext: input.extraContext,
      safetyMode: input.safetyMode,
    })

    return {
      schemaVersion: 'agent-runtime-result/v1',
      runtime: 'local-agent-loop',
      ...loopResult,
      stopReason: this.stopConditions.inferStopReason(loopResult, { maxSteps: input.maxSteps }),
    }
  }
}
