#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createWebTaskRuntimeDriver } from '../dist/sdk/web-task.js'
import { loadConfig } from '../dist/sdk/config.js'
import { snapshotWebTaskInput } from '../dist/task/contracts.js'

const root = await mkdtemp(join(tmpdir(), 'web-buddy-auto-memory-runtime-'))
const writes = []
let mainCalls = 0
let extractionCalls = 0
const model = createServer(async (request, response) => {
  const body = JSON.parse(await bodyText(request))
  const automaticExtraction = body.messages?.some((message) => (
    message.role === 'system' && String(message.content).includes('extract durable browser-agent memories')
  ))
  const extractionInput = automaticExtraction
    ? JSON.parse(body.messages.find((message) => message.role === 'user')?.content ?? '{}')
    : undefined
  const content = automaticExtraction
    ? JSON.stringify({
        candidates: [{
          effect: 'preference',
          memoryKey: 'response.language',
          statement: '用户偏好默认使用中文回答。',
          evidenceId: extractionInput?.evidence?.[0]?.evidenceId,
          evidenceQuote: '以后默认使用中文回答',
          confidence: 0.97,
        }],
      })
    : '任务已完成。'
  if (automaticExtraction) extractionCalls += 1
  else mainCalls += 1
  response.writeHead(200, { 'content-type': 'application/json' })
  response.end(JSON.stringify({
    choices: [{ message: { content } }],
    usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
  }))
})

try {
  await listen(model)
  const config = loadConfig()
  config.model.apiKey = 'fixture-key'
  config.model.authToken = null
  config.model.provider = 'openai'
  config.model.baseUrl = `http://127.0.0.1:${model.address().port}`
  config.trace.outDir = root
  config.agent.maxSteps = 1
  const snapshot = snapshotWebTaskInput({
    schemaVersion: 'web-task-input/v1',
    runId: 'automatic-memory-runtime-run',
    revision: 0,
    goal: {
      instruction: '以后默认使用中文回答。',
      scenario: 'assistant_preferences',
    },
    contract: {
      schemaVersion: 'web-task-contract/v1',
      contractId: 'automatic-memory-runtime-contract',
      revision: 0,
      criteria: [{
        id: 'no-submit',
        kind: 'action_boundary',
        description: 'Automatic Memory extraction must not submit anything.',
        actionKinds: ['submit'],
        outcome: 'not_performed',
      }],
    },
  })
  const outcome = await createWebTaskRuntimeDriver({
    config,
    sessionId: 'automatic-memory-runtime-session',
    automaticMemorySink: {
      async write(candidate) {
        writes.push(candidate)
        return { status: 'written', entryId: 'memory-runtime', revision: 0 }
      },
    },
  }).execute({
    schemaVersion: 'web-task-runtime-request/v1',
    input: snapshot,
    contextItems: [],
    runtime: { maxSteps: 1 },
    emit() {},
  })

  assert.equal(outcome.status, 'completed', outcome.summary)
  assert.equal(mainCalls, 1)
  assert.equal(extractionCalls, 1)
  assert.equal(writes.length, 1)
  assert.equal(writes[0].memoryKey, 'response.language')
  assert.equal(writes[0].memory.applicability.workflow, 'assistant_preferences')
} finally {
  await close(model)
  await rm(root, { recursive: true, force: true })
}

console.log('automatic-memory-runtime-test: PASS')

function bodyText(request) {
  return new Promise((resolve, reject) => {
    let value = ''
    request.setEncoding('utf8')
    request.on('data', (chunk) => { value += chunk })
    request.on('end', () => resolve(value))
    request.on('error', reject)
  })
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()))
}
