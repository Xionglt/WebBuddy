import type { CreateRunCommand, CreateRunResult } from '../domain/run.js'
import type { Clock, IdGenerator, RunRepository } from './ports.js'

export class IdempotencyConflictError extends Error {
  constructor() {
    super('The idempotency key has already been used with a different goal.')
    this.name = 'IdempotencyConflictError'
  }
}

export interface CreateRunDependencies {
  runs: RunRepository
  clock: Clock
  ids: IdGenerator
}

/**
 * 应用服务负责一次完整的业务用例，不处理 HTTP 细节。
 */
export class CreateRunUseCase {
  constructor(private readonly dependencies: CreateRunDependencies) {}

  async execute(_command: CreateRunCommand): Promise<CreateRunResult> {
    // TODO(learning-2): 按下面顺序完成创建任务用例。
    // 1. 用 idempotencyKey 查询已有 Run。
    // 2. key 相同且 goal 相同：返回原 Run，replayed=true。
    // 3. key 相同但 goal 不同：抛出 IdempotencyConflictError。
    // 4. 不存在：生成 queued Run，insert 后返回 replayed=false。
    //
    // 思考：为什么幂等判断属于应用层，而不是 HTTP handler？
    void this.dependencies
    throw new Error('TODO(learning-2): implement CreateRunUseCase.execute')
  }
}
