export interface ElementRef {
  ref: string
  role?: string
  name?: string
  text?: string
  tag: string
  value?: string
  disabled?: boolean
  visible: boolean
  risk?: 'L0' | 'L1' | 'L2' | 'L3' | 'L4'
  locatorHints: {
    aria?: string
    text?: string
    css?: string
    xpath?: string
  }
  fingerprint: {
    textHash?: string
    domPathHash?: string
    ariaHash?: string
  }
}

export interface PageSnapshot {
  snapshotId: string
  url: string
  title: string
  textSummary: string
  elements: ElementRef[]
  stats: {
    elementCount: number
    interactiveCount: number
    truncated: boolean
  }
}

export interface ToolSuccess<T = unknown> {
  ok: true
  observation: string
  data: T
  pageChanged?: boolean
}

export interface ToolFailure {
  ok: false
  observation: string
  error: {
    code: ToolErrorCode
    message: string
    recoverable: boolean
    suggestedNextActions?: string[]
  }
}

export type ToolResult<T = unknown> = ToolSuccess<T> | ToolFailure

export type ToolErrorCode =
  | 'REF_STALE'
  | 'ELEMENT_NOT_FOUND'
  | 'NAVIGATION_BLOCKED'
  | 'TIMEOUT'
  | 'PAGE_CRASHED'
  | 'INVALID_ARGUMENT'
  | 'CONFIRMATION_REQUIRED'
  | 'SESSION_NOT_FOUND'
  | 'UNKNOWN'

export interface SnapshotRecord {
  snapshot: PageSnapshot
  refMap: Map<string, StoredRef>
}

export interface StoredRef {
  ref: string
  role?: string
  name?: string
  text?: string
  tag: string
  css?: string
  xpath?: string
  aria?: string
  risk?: ElementRef['risk']
}
