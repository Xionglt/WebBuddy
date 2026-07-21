#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createComparisonStarter,
  createFormDraftStarter,
  createResearchStarter,
  runWebTask,
} from '../dist/public/index.js'
import { sessionManager } from '../dist/session/manager.js'

const root = await mkdtemp(join(tmpdir(), 'web-buddy-starter-runtime-'))
const fixture = createServer((request, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  if (request.url === '/form') {
    response.end(`<!doctype html><html><head><title>Draft form</title></head><body>
      <main><h1>Contact draft</h1><form>
        <label for="name">Name</label><input id="name" name="name" required />
        <button type="submit">Submit</button>
      </form></main></body></html>`)
    return
  }
  response.end('<!doctype html><html><head><title>Research fixture</title></head><body><main><h1>Runtime facts</h1><p>The safe plan costs 10 credits.</p></main></body></html>')
})
const model = createServer((request, response) => {
  const chunks = []
  request.on('data', (chunk) => chunks.push(chunk))
  request.on('end', () => {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    const messages = Array.isArray(body.messages) ? body.messages : []
    const text = messages.map((message) => String(message.content ?? '')).join('\n')
    const toolNames = messages.flatMap((message) => (
      Array.isArray(message.tool_calls)
        ? message.tool_calls.map((call) => call?.function?.name)
        : []
    ))
    let message
    if (text.includes('FORM_STARTER_E2E') && !toolNames.includes('browser_set_field')) {
      message = toolCall('set-name', 'browser_set_field', {
        label: 'Name',
        controlKind: 'text',
        intendedValue: 'Ada',
      })
    } else if (text.includes('FORM_STARTER_E2E')) {
      message = toolCall('done-form', 'agent_done', {
        summary: 'Filled and audited the Name field; final submit was not performed.',
        blocked: false,
      })
    } else if (text.includes('COMPARISON_STARTER_E2E')) {
      message = toolCall('done-comparison', 'agent_done', {
        summary: 'Basic costs 10 with email support; Pro costs 25 with priority support. Basic is the lower-cost choice.',
        blocked: false,
      })
    } else {
      message = toolCall('done-research', 'agent_done', {
        summary: 'The current page states that the safe plan costs 10 credits.',
        blocked: false,
      })
    }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ choices: [{ message }] }))
  })
})

const environmentKeys = [
  'MODEL_PROVIDER',
  'MODEL_API_KEY',
  'MODEL_BASE_URL',
  'MODEL_NAME',
  'HUMAN_GATE_MODE',
  'PLAYWRIGHT_BLOCK_LOCALHOST',
  'PLAYWRIGHT_ALLOWED_DOMAINS',
  'PLAYWRIGHT_HEADLESS',
  'PLAYWRIGHT_KEEP_BROWSER_OPEN',
  'TRACE_OUT_DIR',
  'AGENT_RUN_ID',
]
const previousEnvironment = Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]))

try {
  await listen(fixture)
  await listen(model)
  const fixtureBase = address(fixture)
  process.env.MODEL_PROVIDER = 'openai'
  process.env.MODEL_API_KEY = 'starter-test-key'
  process.env.MODEL_BASE_URL = `${address(model)}/v1`
  process.env.MODEL_NAME = 'starter-fixture-model'
  process.env.HUMAN_GATE_MODE = 'auto'
  process.env.PLAYWRIGHT_BLOCK_LOCALHOST = 'false'
  process.env.PLAYWRIGHT_ALLOWED_DOMAINS = '127.0.0.1'
  process.env.PLAYWRIGHT_HEADLESS = 'true'
  process.env.PLAYWRIGHT_KEEP_BROWSER_OPEN = 'false'
  process.env.TRACE_OUT_DIR = join(root, 'trace')

  const research = await runWebTask(createResearchStarter({
    schemaVersion: 'research-starter/v1',
    goal: 'RESEARCH_STARTER_E2E: summarize the current fixture.',
    startUrl: `${fixtureBase}/research`,
    runId: 'starter-research-e2e',
  }))
  assert.equal(research.status, 'completed', research.summary)
  assert(research.evidence.some((item) => item.kind === 'page' && item.origin === 'web'))

  const comparison = await runWebTask(createComparisonStarter({
    schemaVersion: 'comparison-starter/v1',
    goal: 'COMPARISON_STARTER_E2E: compare the supplied plans.',
    runId: 'starter-comparison-e2e',
    options: [
      { schemaVersion: 'comparison-option/v1', id: 'basic', label: 'Basic', facts: { price: 10, support: 'email' } },
      { schemaVersion: 'comparison-option/v1', id: 'pro', label: 'Pro', facts: { price: 25, support: 'priority' } },
    ],
  }))
  assert.equal(comparison.status, 'completed', comparison.summary)
  assert.equal(comparison.artifacts.length, 2)
  const comparisonReport = comparison.artifacts.find((artifact) => artifact.kind === 'comparison_report')
  assert(comparisonReport)
  assert.equal(comparisonReport.payloadSchemaVersion, 'comparison-report/v1')
  assert(comparison.artifacts.some((artifact) => artifact.kind === 'runtime_outcome'))

  const formEvents = []
  const formInput = createFormDraftStarter({
    schemaVersion: 'form-draft-starter/v1',
    goal: 'FORM_STARTER_E2E: fill the Name field and keep the form as a draft.',
    startUrl: `${fixtureBase}/form`,
    runId: 'starter-form-e2e',
    fields: [{
      schemaVersion: 'form-draft-field/v1',
      field: 'Name',
      value: 'Ada',
      sensitivity: 'personal',
    }],
  })
  formInput.onEvent = (event) => formEvents.push(event)
  const form = await runWebTask(formInput)
  assert.equal(form.status, 'completed', `${form.summary}\n${JSON.stringify(formEvents, null, 2)}`)
  assert(form.evidence.some((item) => item.kind === 'form'))
  assert(form.actions?.some((item) => item.actionKind === 'submit' && item.outcome === 'not_performed'))
  assert(!form.actions?.some((item) => item.actionKind === 'submit' && item.outcome === 'performed'))

  console.log('starter-default-runtime-test: PASS')
} finally {
  await sessionManager.closeAll().catch(() => {})
  await closeServer(model)
  await closeServer(fixture)
  for (const [key, value] of Object.entries(previousEnvironment)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  await rm(root, { recursive: true, force: true })
}

function toolCall(id, name, args) {
  return {
    content: '',
    tool_calls: [{
      id,
      type: 'function',
      function: { name, arguments: JSON.stringify(args) },
    }],
  }
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
}

function address(server) {
  const value = server.address()
  if (!value || typeof value === 'string') throw new Error('Server did not bind to a TCP port.')
  return `http://127.0.0.1:${value.port}`
}

function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve()))
}
