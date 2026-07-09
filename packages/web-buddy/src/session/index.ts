export type { KernelEvent, KernelEventType } from '../kernel/kernel-events.js'
export type {
  AgentSession,
  AgentSessionSource,
  AgentSessionStatus,
  ApprovalDecisionEntry,
  ApprovalRequestEntry,
  AssistantMessageEntry,
  CompletionGateEntry,
  ContextCompactionEntry,
  CreateSessionInput,
  ErrorEntry,
  FinalResultEntry,
  PermissionDecisionEntry,
  PolicyDecisionEntry,
  SessionStore,
  ToolCallEntry,
  ToolResultEntry,
  TranscriptEntry,
  TranscriptEntryBase,
  UserConfirmationEntry,
  UserMessageEntry,
  WorkflowEvaluationEntry,
  WorkflowEvidenceEntry,
  WorkflowSnapshotEntry,
} from './session-types.js'
export { FileSessionStore } from './session-store.js'
export type { FileSessionStoreOptions } from './session-store.js'
export { FileSessionRecorder, NoopSessionRecorder } from './session-recorder.js'
export type { FileSessionRecorderOptions, SessionRecorder } from './session-recorder.js'
export { restoreSessionState } from './session-restore.js'
export type { RestoreSessionStateInput, RestoredSessionState } from './session-restore.js'
export { confirmSessionCompletion } from './session-completion.js'
export type { ConfirmSessionCompletionInput, ConfirmSessionCompletionResult } from './session-completion.js'
export { appendJsonLine, compactAssistantContent, compactToolResult, createTranscriptEntryId, readJsonLines } from './transcript.js'
export { migrateAgentSession, migrateTranscriptEntry, migrateTranscriptEntries } from './migrations.js'
export { createUserConfirmation } from '../workflow/user-confirmation.js'
export type { UserConfirmation, UserConfirmationInput } from '../workflow/user-confirmation.js'
