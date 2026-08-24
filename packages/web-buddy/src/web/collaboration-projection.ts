import type {
  AgentTask,
  AgentTaskEvent,
  AgentTaskGraphV2,
  AgentTaskStatus,
} from '../agents/async-task-contracts.js'
import { parseBuiltInRoleTaskMetadata, type BuiltInAgentRoleId } from '../agents/built-in-roles.js'
import type { SessionArtifactRecord } from '../agents/session-artifact-store.js'

export const PUBLIC_COLLABORATION_SCHEMA_VERSION = 'public-collaboration/v1' as const

export interface PublicCollaborationProjection {
  schemaVersion: typeof PUBLIC_COLLABORATION_SCHEMA_VERSION
  runId: string
  sessionId?: string
  graphRevision: number
  members: PublicCollaborationMember[]
  tasks: PublicCollaborationTask[]
  artifacts: PublicCollaborationArtifact[]
  activities: PublicCollaborationActivity[]
}

interface PublicCollaborationMember {
  id: string
  roleId: 'main-agent' | BuiltInAgentRoleId | 'worker'
  label: string
  status: 'idle' | 'working' | 'done' | 'failed'
  taskCount: number
}

interface PublicCollaborationTask {
  id: string
  kind: AgentTask['kind']
  roleId?: BuiltInAgentRoleId
  title: string
  status: AgentTaskStatus
  attempt: number
  maxAttempts: number
  requiredForCompletion: boolean
  terminalPolicy: AgentTask['terminalPolicy']
  createdAt: string
  updatedAt: string
  outputCount: number
  outputArtifacts: Array<{ artifactId: string; artifactKind: string }>
  error?: {
    code: string
    retryDisposition: string
    message: string
  }
}

interface PublicCollaborationArtifact {
  artifactId: string
  artifactKind: string
  summary: string
  createdAt: string
  byteLength: number
  producerRoleId?: BuiltInAgentRoleId
}

interface PublicCollaborationActivity {
  id: string
  sequence: number
  eventType: AgentTaskEvent['eventType']
  taskId?: string
  roleId?: BuiltInAgentRoleId
  occurredAt: string
  label: string
  level: 'info' | 'working' | 'done' | 'error'
}

export function emptyCollaborationProjection(runId: string, runState = 'idle'): PublicCollaborationProjection {
  return {
    schemaVersion: PUBLIC_COLLABORATION_SCHEMA_VERSION,
    runId,
    graphRevision: 0,
    members: [mainMember(mainStatus(runState))],
    tasks: [],
    artifacts: [],
    activities: [],
  }
}

export function projectCollaboration(input: {
  runId: string
  sessionId: string
  runState: string
  graph: AgentTaskGraphV2
  events: readonly AgentTaskEvent[]
  artifactRecords: readonly SessionArtifactRecord[]
}): PublicCollaborationProjection {
  const roleByTaskId = new Map(input.graph.tasks.map((task) => [task.id, roleIdOf(task)]))
  return {
    schemaVersion: PUBLIC_COLLABORATION_SCHEMA_VERSION,
    runId: input.runId,
    sessionId: input.sessionId,
    graphRevision: input.graph.revision,
    members: projectMembers(input.graph.tasks, input.runState),
    tasks: input.graph.tasks
      .map(projectTask)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
    artifacts: projectArtifacts(input.artifactRecords, input.graph.tasks),
    activities: input.events
      .slice(-80)
      .map((event) => projectActivity(event, roleByTaskId.get(event.taskId ?? ''))),
  }
}

function projectMembers(tasks: readonly AgentTask[], runState: string): PublicCollaborationMember[] {
  const grouped = new Map<string, AgentTask[]>()
  for (const task of tasks) {
    const roleId = roleIdOf(task) ?? 'worker'
    const current = grouped.get(roleId) ?? []
    current.push(task)
    grouped.set(roleId, current)
  }
  return [
    mainMember(mainStatus(runState)),
    ...[...grouped.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([roleId, roleTasks]) => ({
        id: `member-${roleId}`,
        roleId: roleId as BuiltInAgentRoleId | 'worker',
        label: roleLabel(roleId),
        status: memberStatus(roleTasks),
        taskCount: roleTasks.length,
      })),
  ]
}

function projectTask(task: AgentTask): PublicCollaborationTask {
  const roleId = roleIdOf(task)
  return {
    id: task.id,
    kind: task.kind,
    ...(roleId ? { roleId } : {}),
    title: bounded(task.title, 180),
    status: task.status,
    attempt: task.attempt,
    maxAttempts: task.maxAttempts,
    requiredForCompletion: task.requiredForCompletion,
    terminalPolicy: task.terminalPolicy,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    outputCount: task.outputs.length,
    outputArtifacts: task.outputs.slice(-6).map((output) => ({
      artifactId: output.artifactRef.artifactId,
      artifactKind: output.artifactRef.artifactKind,
    })),
    ...(task.lastError ? {
      error: {
        code: task.lastError.code,
        retryDisposition: task.lastError.retryDisposition,
        message: bounded(task.lastError.message, 300),
      },
    } : {}),
  }
}

function projectArtifacts(
  records: readonly SessionArtifactRecord[],
  tasks: readonly AgentTask[],
): PublicCollaborationArtifact[] {
  const producerRoleByArtifactId = new Map<string, BuiltInAgentRoleId>()
  for (const task of tasks) {
    const roleId = roleIdOf(task)
    if (!roleId) continue
    for (const output of task.outputs) producerRoleByArtifactId.set(output.artifactRef.artifactId, roleId)
  }
  return records
    .filter(isUserFacingArtifact)
    .sort((left, right) => right.ref.createdAt.localeCompare(left.ref.createdAt))
    .slice(0, 32)
    .map((record) => {
      const producerRoleId = producerRoleByArtifactId.get(record.ref.artifactId)
      return {
        artifactId: record.ref.artifactId,
        artifactKind: record.ref.artifactKind,
        summary: bounded(record.summary, 260),
        createdAt: record.ref.createdAt,
        byteLength: record.ref.byteLength,
        ...(producerRoleId ? { producerRoleId } : {}),
      }
    })
}

function projectActivity(
  event: AgentTaskEvent,
  roleId: BuiltInAgentRoleId | undefined,
): PublicCollaborationActivity {
  return {
    id: event.eventId,
    sequence: event.eventSeq,
    eventType: event.eventType,
    ...(event.taskId ? { taskId: event.taskId } : {}),
    ...(roleId ? { roleId } : {}),
    occurredAt: event.occurredAt,
    label: activityLabel(event.eventType),
    level: activityLevel(event.eventType),
  }
}

function roleIdOf(task: AgentTask): BuiltInAgentRoleId | undefined {
  try {
    for (const input of task.inputs) {
      if (input.kind !== 'goal') continue
      const metadata = parseBuiltInRoleTaskMetadata(input.structuredValue)
      if (metadata) return metadata.roleId
    }
  } catch {
    return undefined
  }
  return undefined
}

function isUserFacingArtifact(record: SessionArtifactRecord): boolean {
  const kind = record.ref.artifactKind
  if (['context_envelope', 'task_graph_checkpoint', 'schema', 'sidechain_transcript'].includes(kind)) return false
  if (record.ref.artifactId.startsWith('main-task-seed_')) return false
  if (record.ref.artifactId.startsWith('main-readiness-')) return false
  if (kind === 'runner_result' && !record.ref.artifactId.startsWith('observation-')) return false
  return true
}

function mainMember(status: PublicCollaborationMember['status']): PublicCollaborationMember {
  return { id: 'member-main-agent', roleId: 'main-agent', label: 'Main Agent', status, taskCount: 1 }
}

function mainStatus(runState: string): PublicCollaborationMember['status'] {
  if (['failed', 'cancelled'].includes(runState)) return 'failed'
  if (runState === 'completed') return 'done'
  if (['running', 'queued', 'resuming', 'pausing'].includes(runState)) return 'working'
  return 'idle'
}

function memberStatus(tasks: readonly AgentTask[]): PublicCollaborationMember['status'] {
  if (tasks.some((task) => ['pending', 'blocked', 'running'].includes(task.status))) return 'working'
  if (tasks.some((task) => task.status === 'failed' || task.status === 'killed')) return 'failed'
  if (tasks.length > 0 && tasks.every((task) => task.status === 'completed')) return 'done'
  return 'idle'
}

function roleLabel(roleId: string): string {
  return ({
    planner: 'Planner',
    researcher: 'Researcher',
    comparison: 'Comparison',
    'form-planner': 'Form Planner',
    'safety-reviewer': 'Safety Reviewer',
    verification: 'Verification',
    worker: 'Worker',
  } as Record<string, string>)[roleId] ?? roleId
}

function activityLabel(eventType: AgentTaskEvent['eventType']): string {
  return ({
    task_created: '子任务已创建',
    task_claimed: '子任务已开始',
    task_progressed: '子任务正在处理',
    task_retry_scheduled: '子任务已安排重试',
    task_completed: '子任务已完成',
    task_failed: '子任务失败',
    task_killed: '子任务已终止',
    task_cancel_requested: '子任务正在取消',
    task_cancelled_before_run: '子任务已取消',
    task_lease_expired: '子任务租约过期',
    task_result_stale: '子任务结果已过期',
    task_notification_acknowledged: '子任务结果已接收',
    browser_action_advanced: 'Main Agent 已更新页面',
    graph_migrated: '协作图已迁移',
  } as Record<string, string>)[eventType] ?? eventType
}

function activityLevel(eventType: AgentTaskEvent['eventType']): PublicCollaborationActivity['level'] {
  if (eventType === 'task_completed' || eventType === 'task_notification_acknowledged') return 'done'
  if (eventType === 'task_failed' || eventType === 'task_killed' || eventType === 'task_lease_expired') return 'error'
  if (eventType === 'task_claimed' || eventType === 'task_progressed' || eventType === 'task_retry_scheduled') return 'working'
  return 'info'
}

function bounded(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  return normalized.length <= maxChars ? normalized : `${normalized.slice(0, maxChars - 1)}…`
}
