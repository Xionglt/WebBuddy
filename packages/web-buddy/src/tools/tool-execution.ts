import type { LocalToolContext, LocalToolRunResult } from './local-adapter.js'

export interface ToolExecutionInput {
  toolName: string
  args: unknown
  ctx: LocalToolContext
  metadata?: {
    step?: number
    riskLevel?: string
    category?: string
    argBrief?: string
    policyAction?: string
    policyCode?: string
    policyRuleId?: string
    policyGateKind?: string
  }
}

export interface ToolExecutionResult {
  toolName: string
  args: unknown
  result: LocalToolRunResult
  metadata?: ToolExecutionInput['metadata']
}

export interface ToolExecutionRegistry {
  run(toolName: string, args: Record<string, unknown>, ctx: LocalToolContext): Promise<LocalToolRunResult>
}

/**
 * Light execution boundary for the local runtime. It intentionally delegates to
 * ToolRegistry and does not own policy, retry, queueing, or browser calls.
 */
export class ToolExecutionBoundary {
  constructor(private readonly registry: ToolExecutionRegistry) {}

  async execute(input: ToolExecutionInput): Promise<ToolExecutionResult> {
    const result = await this.registry.run(input.toolName, input.args as Record<string, unknown>, input.ctx)
    return {
      toolName: input.toolName,
      args: input.args,
      result,
      ...(input.metadata ? { metadata: input.metadata } : {}),
    }
  }
}

export { ToolExecutionService } from './tool-execution-service.js'
export type { ToolExecutionServiceOptions } from './tool-execution-service.js'
export type { NormalizedToolResult, ToolTerminalStatus } from './tool-result.js'
export type { NormalizedToolError, NormalizedToolErrorKind } from './tool-errors.js'
export { toLegacyToolRunResult } from './tool-result.js'
export type { ToolExecutionState, ToolExecutionStatus } from './tool-progress.js'
export type { ToolCall, ToolExecutionMetadata, ToolUseContext } from './tool-contract.js'
