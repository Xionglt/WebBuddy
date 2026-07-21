#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createServer as createHttpServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  FileSessionRecorder,
  FileSessionStore,
} from '../dist/session/index.js'
import { snapshotWebTaskInput } from '../dist/task/contracts.js'
import { createWebControlServer } from '../dist/web/server.js'

const root = await mkdtemp(join(tmpdir(), 'web-buddy-generic-resume-e2e-'))
const traceRoot = join(root, 'trace')
const controlRoot = join(root, 'control')
const token = 'generic-resume-e2e-token'
const scope = {
  schemaVersion: 'service-scope/v1',
  kind: 'tenant',
  tenantId: 'generic-resume-e2e-tenant',
  userId: 'generic-resume-e2e-user',
}
const ownerScope = {
  schemaVersion: 'owner-scope/v1',
  tenantId: scope.tenantId,
  userId: scope.userId,
}
const environmentKeys = [
  'TRACE_OUT_DIR',
  'PLAYWRIGHT_BLOCK_LOCALHOST',
  'PLAYWRIGHT_ALLOWED_DOMAINS',
  'PLAYWRIGHT_HEADLESS',
  'WEB_BUDDY_ALLOW_PRIVATE_NETWORK_FOR_TESTING',
  'AGENT_RUN_ID',
]
const previousEnvironment = Object.fromEntries(
  environmentKeys.map((key) => [key, process.env[key]]),
)
process.env.TRACE_OUT_DIR = traceRoot
process.env.PLAYWRIGHT_BLOCK_LOCALHOST = 'false'
process.env.PLAYWRIGHT_ALLOWED_DOMAINS = '127.0.0.1'
process.env.PLAYWRIGHT_HEADLESS = 'true'
process.env.WEB_BUDDY_ALLOW_PRIVATE_NETWORK_FOR_TESTING = 'true'

let releaseFirstPage
let firstPageResolve
const firstPage = new Promise((resolve) => {
  firstPageResolve = resolve
})
let pageRequests = 0
const fixture = createHttpServer((req, res) => {
  if (req.url !== '/slow') {
    res.writeHead(404).end()
    return
  }
  pageRequests += 1
  if (pageRequests === 1) {
    firstPageResolve()
    releaseFirstPage = () => {
      if (res.writableEnded) return
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<!doctype html><title>Read only fixture</title><main>Stable observation</main>')
    }
    return
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end('<!doctype html><title>Read only fixture</title><main>Fresh observation</main>')
})

let control
try {
  await listen(fixture)
  const fixtureUrl = `${address(fixture)}/slow`
  control = createControl()
  await listen(control.server)
  const base = address(control.server)

  const createdResponse = await requestJson(base, '/api/runs', {
    method: 'POST',
    headers: { 'idempotency-key': 'generic-resume-e2e-create' },
    body: {
      schemaVersion: 'run-client-create/v1',
      input: genericSnapshot('caller-generic-resume-e2e', fixtureUrl),
    },
  })
  assert.equal(createdResponse.status, 201, JSON.stringify(createdResponse.body))
  const runId = createdResponse.body.runId
  await withTimeout(firstPage, 15_000, 'built-in browser never requested the frozen start URL')
  let record = await waitForRun(
    control,
    runId,
    (candidate) => candidate.state === 'running' && candidate.sessionRef,
  )
  const firstSessionRef = structuredClone(record.sessionRef)

  const pause = await requestJson(base, `/api/runs/${encodeURIComponent(runId)}/pause`, {
    method: 'POST',
    headers: { 'idempotency-key': 'generic-resume-e2e-pause' },
    body: { expectedRevision: record.runRevision },
  })
  assert.equal(pause.status, 202, JSON.stringify(pause.body))
  assert.equal(pause.body.state, 'pausing')
  releaseFirstPage()
  record = await waitForRun(control, runId, (candidate) => candidate.state === 'paused')
  assert.equal(record.lastSafeBoundary.sessionRef.id, firstSessionRef.id)
  assert.equal(record.lastSafeBoundary.sessionRef.attempt, 1)

  const sessions = new FileSessionStore({ rootDir: join(traceRoot, 'sessions') })
  const session = await sessions.get(firstSessionRef.id)
  assert(session, 'built-in generic runtime did not create its durable session')
  const recorder = new FileSessionRecorder(sessions, session)
  await recorder.transcript({
    type: 'tool_call',
    toolCallId: 'e2e-unsettled-old-click',
    name: 'browser_click',
    args: { ref: 'e12' },
  })
  const transcriptBeforeResume = await readFile(session.transcriptPath, 'utf8')

  let resume
  for (let retry = 0; retry < 50; retry += 1) {
    resume = await requestJson(base, `/api/runs/${encodeURIComponent(runId)}/resume`, {
      method: 'POST',
      headers: { 'idempotency-key': 'generic-resume-e2e-attempt-2' },
      body: { expectedRevision: record.runRevision },
    })
    if (resume.status !== 409
      || resume.body.error !== 'generic_resume_requires_quiescent_run') break
    await delay(20)
  }
  assert.equal(resume.status, 202, JSON.stringify(resume.body))
  record = await waitForRun(
    control,
    runId,
    (candidate) => candidate.state === 'blocked_on_human',
  )
  assert.equal(record.inputSnapshot.revision, 0)
  assert.equal(record.inputSnapshot.contract.revision, 0)
  assert.equal(record.runRevision, 1)
  assert.equal(record.attempt, 2)
  assert.equal(record.sessionRef.id, firstSessionRef.id)
  assert.equal(record.sessionRef.attempt, 2)
  assert.equal(await readFile(session.transcriptPath, 'utf8'), transcriptBeforeResume)
  assert.equal(pageRequests, 2, 'resume did not perform exactly one fresh read-only re-observation')

  const events = await control.runService.events(runId, { ownerScope })
  assert.equal(
    events.items.some((event) => event.data?.replayedAction === true),
    false,
    'control-plane recovery reported a replayed action',
  )
  const trace = await requestJson(base, `/api/runs/${encodeURIComponent(runId)}/trace`)
  assert.equal(trace.status, 200)
  assert.equal(trace.body.runId, runId)
  assert.equal(trace.body.attempt, 2)
  const artifacts = await requestJson(base, `/api/runs/${encodeURIComponent(runId)}/artifacts`)
  assert.equal(artifacts.status, 200)
  assert.equal(artifacts.body.items.length, 2)
  assert.deepEqual(
    artifacts.body.items.map((artifact) => artifact.binding.sessionRef.attempt).sort(),
    [1, 2],
    'Control Store did not retain one immutable runtime outcome per attempt',
  )
  for (const artifact of artifacts.body.items) {
    assert.equal(artifact.kind, 'runtime_outcome')
    assert.equal(artifact.payloadSchemaVersion, 'generic-runtime-outcome/v1')
    assert.equal(artifact.locator, `artifact:${encodeURIComponent(artifact.id)}`)
    assert.equal(artifact.locator.includes(traceRoot), false, 'public artifact locator exposed the trace root')
    assert.equal(artifact.requiresMainWorkflowVerification, true)
    assert.equal(artifact.authoritativeCompletionEvidence, false)
    assert.deepEqual(artifact.ownerScope, ownerScope)
    assert.equal(artifact.binding.runId, runId)
    assert.equal(artifact.binding.revision, 0)
    assert.equal(artifact.binding.sessionRef.id, firstSessionRef.id)
  }

  await delay(50)
  const cancel = await requestJson(base, `/api/runs/${encodeURIComponent(runId)}/cancel`, {
    method: 'POST',
    headers: { 'idempotency-key': 'generic-resume-e2e-cancel' },
    body: { expectedRevision: record.runRevision },
  })
  assert.equal(cancel.status, 202)
  assert.equal(cancel.body.state, 'cancelled')

  await control.close()
  control = createControl()
  await control.recoverStartupRuns()
  await listen(control.server)
  const afterRestart = await requestJson(
    address(control.server),
    `/api/runs/${encodeURIComponent(runId)}`,
  )
  assert.equal(afterRestart.status, 200)
  assert.equal(afterRestart.body.state, 'cancelled')
  assert.equal(afterRestart.body.revision, 1)
  assert.equal(afterRestart.body.attempt, 2)
  const artifactsAfterRestart = await requestJson(
    address(control.server),
    `/api/runs/${encodeURIComponent(runId)}/artifacts`,
  )
  assert.equal(artifactsAfterRestart.status, 200)
  assert.deepEqual(artifactsAfterRestart.body.items, artifacts.body.items)

  console.log('control-generic-resume-e2e-test: PASS')
} finally {
  releaseFirstPage?.()
  await control?.close().catch(() => {})
  await closeServer(fixture)
  for (const [key, value] of Object.entries(previousEnvironment)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  await rm(root, { recursive: true, force: true })
}

function createControl() {
  return createWebControlServer({
    controlStoreDir: controlRoot,
    serviceSecurity: {
      schemaVersion: 'web-service-security/v1',
      authenticate: ({ authorization }) => authorization === `Bearer ${token}`
        ? {
            schemaVersion: 'service-principal/v1',
            actorId: 'generic-resume-e2e-actor',
            authentication: 'bearer',
            scope,
          }
        : undefined,
      secretProvider: {
        credentialConfigured() {
          return false
        },
        async injectModelCredential(config) {
          config.model.apiKey = null
          config.model.authToken = null
        },
        redact(value) {
          return structuredClone(value)
        },
      },
    },
  })
}

function genericSnapshot(runId, startUrl) {
  const denyRules = [{
    id: 'e2e-deny-writes',
    actionKinds: [
      'type_or_paste',
      'upload',
      'send',
      'publish',
      'submit',
      'payment',
      'memory_write',
      'permission_write',
    ],
    decision: 'deny',
    requireApprovalBinding: true,
  }]
  return snapshotWebTaskInput({
    schemaVersion: 'web-task-input/v1',
    runId,
    revision: 0,
    goal: {
      instruction: 'Observe the local fixture without performing a browser write.',
      scenario: 'research',
      metadata: { restartSafe: true },
    },
    startUrl,
    contract: {
      schemaVersion: 'web-task-contract/v1',
      contractId: 'generic-resume-e2e-read-only',
      revision: 0,
      criteria: [{
        id: 'fresh-page',
        kind: 'evidence_present',
        description: 'Fresh page evidence is required.',
        evidenceKinds: ['page'],
        minCount: 1,
        allowedAuthorities: ['main_runtime'],
      }],
      sensitiveActions: denyRules,
    },
    policy: {
      schemaVersion: 'task-policy/v1',
      defaultSensitiveAction: 'deny',
      rules: denyRules,
    },
  })
}

async function waitForRun(controlValue, runId, predicate, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  let latest
  while (Date.now() < deadline) {
    latest = await controlValue.runService.get(runId, { ownerScope })
    if (latest && predicate(latest)) return latest
    await delay(20)
  }
  throw new Error(`Timed out waiting for Run ${runId}; latest=${JSON.stringify(latest)}`)
}

async function requestJson(base, path, options = {}) {
  const response = await fetch(`${base}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...(options.headers ?? {}),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  })
  return {
    status: response.status,
    body: await response.json(),
  }
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
}

function closeServer(server) {
  if (!server.listening) return Promise.resolve()
  return new Promise((resolve) => server.close(() => resolve()))
}

function address(server) {
  const value = server.address()
  assert(value && typeof value === 'object')
  return `http://127.0.0.1:${value.port}`
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function withTimeout(promise, timeoutMs, message) {
  let timeout
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timeout)
  }
}
