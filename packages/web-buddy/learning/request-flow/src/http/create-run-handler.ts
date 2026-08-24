import {
  CreateRunUseCase,
  IdempotencyConflictError,
} from '../application/create-run.js'
import type { CreateRunCommand } from '../domain/run.js'

export interface HttpRequest {
  headers: Readonly<Record<string, string | undefined>>
  body: unknown
}

export interface HttpResponse {
  statusCode: number
  body: unknown
}

class BadRequestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BadRequestError'
  }
}

/**
 * HTTP 边界只做协议工作：取 header、校验 JSON shape、映射错误码。
 */
export function parseCreateRunRequest(_request: HttpRequest): CreateRunCommand {
  // TODO(learning-1): 完成请求解析。
  // 1. body 必须是普通对象。
  // 2. body 只能包含 goal；goal 必须是 trim 后非空的字符串。
  // 3. x-idempotency-key 必须存在且非空。
  // 4. 返回 { goal, idempotencyKey }，不要把 HttpRequest 传进应用层。
  //
  // 校验失败时抛 BadRequestError；先让 validation 测试变绿。
  throw new BadRequestError('TODO(learning-1): implement parseCreateRunRequest')
}

export function createRunHandler(createRun: Pick<CreateRunUseCase, 'execute'>) {
  return async (request: HttpRequest): Promise<HttpResponse> => {
    try {
      const command = parseCreateRunRequest(request)
      const result = await createRun.execute(command)
      return {
        statusCode: result.replayed ? 200 : 201,
        body: result,
      }
    } catch (error) {
      if (error instanceof BadRequestError) {
        return { statusCode: 400, body: { error: 'bad_request', message: error.message } }
      }
      if (error instanceof IdempotencyConflictError) {
        return { statusCode: 409, body: { error: 'idempotency_conflict', message: error.message } }
      }
      return {
        statusCode: 500,
        body: {
          error: 'internal_error',
          message: error instanceof Error ? error.message : String(error),
        },
      }
    }
  }
}
