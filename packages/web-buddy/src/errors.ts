import type { ToolErrorCode, ToolFailure } from './types.js'

export function toolFailure(
  code: ToolErrorCode,
  message: string,
  options?: {
    recoverable?: boolean
    suggestedNextActions?: string[]
    observation?: string
  },
): ToolFailure {
  return {
    ok: false,
    observation: options?.observation ?? message,
    error: {
      code,
      message,
      recoverable: options?.recoverable ?? code !== 'NAVIGATION_BLOCKED',
      suggestedNextActions: options?.suggestedNextActions,
    },
  }
}

export function toolSuccess<T>(
  observation: string,
  data: T,
  pageChanged = false,
) {
  return {
    ok: true as const,
    observation,
    data,
    pageChanged,
  }
}

export function formatToolResult(result: { ok: boolean; observation: string; data?: unknown; error?: ToolFailure['error']; pageChanged?: boolean }) {
  return JSON.stringify(result, null, 2)
}
