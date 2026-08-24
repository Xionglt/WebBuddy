import type { RunRepository } from '../application/ports.js'
import type { Run } from '../domain/run.js'

/**
 * 先用内存实现隔离数据库细节。之后可保持 RunRepository 不变，替换成文件或数据库实现。
 */
export class InMemoryRunRepository implements RunRepository {
  private readonly runsByIdempotencyKey = new Map<string, Run>()

  async findByIdempotencyKey(idempotencyKey: string): Promise<Run | undefined> {
    const run = this.runsByIdempotencyKey.get(idempotencyKey)
    return run ? structuredClone(run) : undefined
  }

  async insert(run: Run): Promise<void> {
    if (this.runsByIdempotencyKey.has(run.idempotencyKey)) {
      throw new Error('duplicate idempotency key')
    }
    this.runsByIdempotencyKey.set(run.idempotencyKey, structuredClone(run))
  }
}
