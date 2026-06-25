import type { RiskLevel } from '../sdk/trace.js'

export type ToolCategory = 'observation' | 'action' | 'human' | 'eval'

export interface ToolDef {
  name: string
  mcpName?: string
  description: string
  category: ToolCategory
  risk: RiskLevel
  parameters: Record<string, unknown>
  local: {
    enabled: boolean
  }
  mcp: {
    enabled: boolean
  }
  metadata?: Record<string, unknown>
}
