export { runWebTask, WebTaskContractError, snapshotWebTaskInput } from './web-task.js'
export type {
  ActionBinding,
  AgentRole,
  ApprovalBinding,
  ArtifactRef,
  CompletionCriterion,
  ContextItem,
  ContextProvider,
  EvidenceRef,
  EvidenceRequirement,
  OwnerScope,
  RunSnapshot,
  RuntimeOptions,
  SensitiveActionRule,
  SessionRef,
  TaskContract,
  TaskGoal,
  TaskPolicy,
  WebTaskEvent,
  WebTaskInput,
  WebTaskInputSnapshot,
  WebTaskResult,
  WebTaskRuntimeDriver,
  WebTaskRuntimeOutcome,
} from './web-task.js'

/** @deprecated Recruiting compatibility surface; use runWebTask(). */
export { runJobApplicationAgent } from './orchestrator.js'
export type { AgentRunResult, RunOptions } from './orchestrator.js'
