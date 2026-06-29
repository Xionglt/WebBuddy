export type NormalizedToolErrorKind =
  | 'aborted'
  | 'timeout'
  | 'tool_failed_observation'
  | 'unknown_tool'
  | 'registry_exception'
  | 'invalid_result'

export interface NormalizedToolError {
  schemaVersion: 'normalized-tool-error/v1'
  kind: NormalizedToolErrorKind
  code: string
  message: string
  retryable: boolean
  fatal: boolean
  cause?: unknown
}

export function createNormalizedToolError(
  kind: NormalizedToolErrorKind,
  code: string,
  message: string,
  options: { retryable?: boolean; fatal?: boolean; cause?: unknown } = {},
): NormalizedToolError {
  return {
    schemaVersion: 'normalized-tool-error/v1',
    kind,
    code,
    message,
    retryable: options.retryable ?? false,
    fatal: options.fatal ?? false,
    ...(options.cause !== undefined ? { cause: options.cause } : {}),
  }
}

export function messageFromUnknown(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
