import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { CreateRunUseCase } from './application/create-run.js'
import { InMemoryRunRepository } from './adapters/in-memory-run-repository.js'
import { createRunHandler } from './http/create-run-handler.js'

const runs = new InMemoryRunRepository()
const createRun = new CreateRunUseCase({
  runs,
  clock: { now: () => new Date().toISOString() },
  ids: { next: () => `learning-${randomUUID()}` },
})
const handleCreateRun = createRunHandler(createRun)

export function createLearningServer() {
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://localhost')
      if (request.method !== 'POST' || url.pathname !== '/api/learning/runs') {
        return sendJson(response, 404, { error: 'not_found' })
      }

      const result = await handleCreateRun({
        headers: { 'x-idempotency-key': header(request, 'x-idempotency-key') },
        body: await readJsonBody(request),
      })
      sendJson(response, result.statusCode, result.body)
    } catch (error) {
      sendJson(response, 400, {
        error: 'invalid_json',
        message: error instanceof Error ? error.message : String(error),
      })
    }
  })
}

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name]
  return Array.isArray(value) ? value[0] : value
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let totalBytes = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    totalBytes += buffer.length
    if (totalBytes > 16 * 1024) throw new Error('request body is too large')
    chunks.push(buffer)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  return raw.length === 0 ? undefined : JSON.parse(raw)
}

function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(body))
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const port = Number(process.env.PORT ?? 4310)
  createLearningServer().listen(port, '127.0.0.1', () => {
    console.log(`Learning server: http://127.0.0.1:${port}`)
  })
}
