import type { Run } from '../domain/run.js'

/**
 * 应用层只依赖接口，不知道数据最终放在 Map、文件还是数据库。
 */
export interface RunRepository {
  findByIdempotencyKey(idempotencyKey: string): Promise<Run | undefined>
  insert(run: Run): Promise<void>
}

export interface Clock {
  now(): string
}

export interface IdGenerator {
  next(): string
}
