import assert from 'node:assert/strict'
import test from 'node:test'
import { InMemoryRunRepository } from '../src/adapters/in-memory-run-repository.js'
import { CreateRunUseCase } from '../src/application/create-run.js'
import { createRunHandler } from '../src/http/create-run-handler.js'

function fixture() {
  let sequence = 0
  const useCase = new CreateRunUseCase({
    runs: new InMemoryRunRepository(),
    clock: { now: () => '2026-08-19T10:00:00.000Z' },
    ids: { next: () => `run-${++sequence}` },
  })
  return createRunHandler(useCase)
}

test('learning-1: rejects an empty goal at the HTTP boundary', async () => {
  const response = await fixture()({
    headers: { 'x-idempotency-key': 'request-1' },
    body: { goal: '   ' },
  })

  assert.equal(response.statusCode, 400)
  assert.deepEqual(response.body, {
    error: 'bad_request',
    message: 'body.goal must be a non-empty string',
  })
})

test('learning-1: rejects a missing idempotency key', async () => {
  const response = await fixture()({
    headers: {},
    body: { goal: 'Inspect the current page' },
  })

  assert.equal(response.statusCode, 400)
  assert.deepEqual(response.body, {
    error: 'bad_request',
    message: 'x-idempotency-key header is required',
  })
})

test('learning-2: creates a queued run', async () => {
  const response = await fixture()({
    headers: { 'x-idempotency-key': 'request-1' },
    body: { goal: 'Inspect the current page' },
  })

  assert.equal(response.statusCode, 201)
  assert.deepEqual(response.body, {
    replayed: false,
    run: {
      runId: 'run-1',
      goal: 'Inspect the current page',
      idempotencyKey: 'request-1',
      state: 'queued',
      createdAt: '2026-08-19T10:00:00.000Z',
    },
  })
})

test('learning-2: replays the same request without creating another run', async () => {
  const handle = fixture()
  const request = {
    headers: { 'x-idempotency-key': 'request-1' },
    body: { goal: 'Inspect the current page' },
  }

  const first = await handle(request)
  const replay = await handle(request)

  assert.equal(first.statusCode, 201)
  assert.equal(replay.statusCode, 200)
  assert.deepEqual(
    (replay.body as { run: { runId: string } }).run.runId,
    (first.body as { run: { runId: string } }).run.runId,
  )
})

test('learning-2: rejects reuse of a key with a different goal', async () => {
  const handle = fixture()
  await handle({
    headers: { 'x-idempotency-key': 'request-1' },
    body: { goal: 'Inspect the current page' },
  })

  const conflict = await handle({
    headers: { 'x-idempotency-key': 'request-1' },
    body: { goal: 'Submit the current page' },
  })

  assert.equal(conflict.statusCode, 409)
  assert.deepEqual(conflict.body, {
    error: 'idempotency_conflict',
    message: 'The idempotency key has already been used with a different goal.',
  })
})
