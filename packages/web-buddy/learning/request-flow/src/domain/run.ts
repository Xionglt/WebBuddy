/**
 * 第一轮只学习“创建任务”，所以 Run 只有 queued 状态。
 * running/completed/failed 会在下一轮接入 Runtime Worker 时再加入。
 */
export interface Run {
  runId: string
  goal: string
  idempotencyKey: string
  state: 'queued'
  createdAt: string
}

export interface CreateRunCommand {
  goal: string
  idempotencyKey: string
}

export interface CreateRunResult {
  run: Run
  replayed: boolean
}
