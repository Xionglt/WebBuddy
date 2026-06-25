import type { AgentLoopResult } from '../runtime/local/agent-loop.js'
import type { AgentStopReason } from './types.js'

export interface StopConditionContext {
  maxSteps?: number
}

export class StopConditionManager {
  inferStopReason(result: AgentLoopResult, context: StopConditionContext = {}): AgentStopReason {
    const summary = result.summary.toLowerCase()

    if (summary.includes('llm error')) return 'llm_error'
    if (result.blocked) return 'blocked'
    if (result.done) return 'agent_done'
    if (summary.includes('step budget') || (context.maxSteps !== undefined && result.steps >= context.maxSteps)) {
      return 'step_budget'
    }
    return 'unknown'
  }
}

export const stopConditionManager = new StopConditionManager()
