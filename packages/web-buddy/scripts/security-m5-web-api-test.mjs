#!/usr/bin/env node
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const fixture = JSON.parse(readFileSync(
  new URL('./fixtures/security/m5-service-security.json', import.meta.url),
  'utf8',
))
assert.equal(fixture.schemaVersion, 'security-m5-service/v1')

const root = await mkdtemp(join(tmpdir(), 'web-buddy-m5-security-'))
const traceRoot = join(root, 'trace')
const controlRoot = join(root, 'control')
const memoryRoot = join(root, 'memory')
const originalEnv = snapshotEnv([
  'MODEL_API_KEY',
  'MODEL_PROVIDER',
  'OPENAI_API_KEY',
  'DASHSCOPE_API_KEY',
  'TRACE_OUT_DIR',
  'WEB_BUDDY_CONTROL_STORE_DIR',
  'WEB_BUDDY_MEMORY_DIR',
])
process.env.MODEL_API_KEY = fixture.secretMarker
process.env.MODEL_PROVIDER = 'openai'
process.env.OPENAI_API_KEY = fixture.secretMarker
process.env.DASHSCOPE_API_KEY = fixture.secretMarker
process.env.TRACE_OUT_DIR = traceRoot
process.env.WEB_BUDDY_CONTROL_STORE_DIR = controlRoot
process.env.WEB_BUDDY_MEMORY_DIR = memoryRoot

await installSourceResolver()
const { createWebControlServer } = await import(new URL('../src/web/server.ts', import.meta.url))
const sdk = await import(new URL('../src/public/index.ts', import.meta.url))
const auditEvents = []
const capturedLogs = []
const restoreConsole = captureConsole(capturedLogs)
const control = createWebControlServer({
  controlStoreDir: controlRoot,
  disableExecution: true,
  serviceSecurity: {
    schemaVersion: 'web-service-security/v1',
    authenticate: async ({ authorization }) => authenticateFixture(authorization),
    quotaLimits: [{
      schemaVersion: 'quota-limit/v1',
      scope: tenantScope(fixture.principals.tenantA),
      dimension: 'runs_per_window',
      maximum: fixture.quota.runsPerWindow,
      windowMs: fixture.quota.windowMs,
    }],
    auditSink: {
      async append(event) {
        auditEvents.push(structuredClone(event))
      },
    },
  },
})
const results = []

try {
  await listen(control.server)
  const address = control.server.address()
  assert(address && typeof address === 'object')
  const base = `http://127.0.0.1:${address.port}`

  await check('unauthenticated API routes reject before lookup', async () => {
    for (const path of fixture.apiPaths) {
      const response = await fetch(`${base}${path}`)
      assert.equal(response.status, 401, `${path} must require authentication`)
      assertNoSecret(await response.text(), `${path} unauthenticated response`)
    }
  })

  await check('authentication runs before body validation and resource lookup', async () => {
    const invalidCreate = await fetch(`${base}/api/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{',
    })
    assert.equal(invalidCreate.status, 401)
    const guessed = await fetch(`${base}/api/runs/does-not-exist`)
    assert.equal(guessed.status, 401)
  })

  await check('authenticated request bodies fail closed at the service size limit', async () => {
    const response = await authenticatedFetch(base, '/api/runs', fixture.principals.tenantA, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'oversized-body',
      },
      body: JSON.stringify({ padding: 'x'.repeat(1024 * 1024 + 1) }),
    })
    assert.equal(response.status, 413)
    assertNoSecret(await response.text(), 'oversized request denial')
  })

  await check('service creation rejects private-network and sensitive-profile bypasses', async () => {
    const privateTarget = await authenticatedFetch(base, '/api/runs', fixture.principals.tenantB, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'private-target',
      },
      body: JSON.stringify({
        mode: 'raw',
        startUrl: 'http://127.0.0.1:8080/internal',
        taskPrompt: 'Inspect an internal service.',
      }),
    })
    assert.equal(privateTarget.status, 400)
    const profileBypass = await authenticatedFetch(base, '/api/runs', fixture.principals.tenantB, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'profile-bypass',
      },
      body: JSON.stringify({
        mode: 'raw',
        startUrl: 'https://profile-bypass.example.test/',
        taskPrompt: 'Use a local profile.',
        resumePath: '/tmp/private-resume.pdf',
      }),
    })
    assert.equal(profileBypass.status, 400)
  })

  const runBData = await createRun(base, fixture.principals.tenantB, 'tenant-b-data', 'm5-b-data')
  const runBControl = await createRun(base, fixture.principals.tenantB, 'tenant-b-control', 'm5-b-control')
  const ownerScopeB = ownerScope(fixture.principals.tenantB)

  await control.runService.start(runBData.runId, 'm5-start-b-data', { ownerScope: ownerScopeB })
  await control.runService.acceptResult({
    runId: runBData.runId,
    runRevision: 0,
    attempt: 1,
    terminalState: 'completed',
    idempotencyKey: 'm5-complete-b-data',
    resourceRefs: [{
      schemaVersion: 'control-resource-ref/v1',
      id: 'trace-b-secret',
      kind: 'trace',
      locator: `opaque:${fixture.secretMarker}`,
    }],
    ownerScope: ownerScopeB,
  })
  await seedTrace(traceRoot, runBData.runId, fixture.secretMarker)
  await control.serviceSecurity.redactTraceFiles([join(traceRoot, runBData.runId)])
  assertNoSecret(
    readFileSync(join(traceRoot, runBData.runId, 'trace.jsonl'), 'utf8'),
    'redacted trace persistence',
  )
  assertNoSecret(
    readFileSync(join(traceRoot, runBData.runId, 'summary.json'), 'utf8'),
    'redacted summary persistence',
  )

  await check('ordinary config response never contains token or token preview', async () => {
    const response = await authenticatedFetch(base, '/api/config', fixture.principals.tenantA)
    assert.equal(response.status, 200)
    const text = await response.text()
    assertNoSecret(text, 'config response')
    assert.equal(text.includes(fixture.secretPrefix), false, 'config leaked a stable token prefix')
  })

  await check('tenant cannot redirect the server credential provider through config', async () => {
    const response = await authenticatedFetch(base, '/api/config', fixture.principals.tenantA, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        provider: 'openai',
        baseUrl: 'https://credential-capture.example.test/',
        name: 'capture',
      }),
    })
    assert.equal(response.status, 403)
    assertNoSecret(await response.text(), 'config mutation denial')
  })

  await check('tenant A cannot list tenant B runs', async () => {
    const response = await authenticatedFetch(base, '/api/runs', fixture.principals.tenantA)
    assert.equal(response.status, 200)
    const payload = await response.json()
    assert.equal(
      JSON.stringify(payload).includes(runBData.runId)
        || JSON.stringify(payload).includes(runBControl.runId),
      false,
    )
  })

  await check('run id guessing cannot read a foreign run', async () => {
    const response = await authenticatedFetch(
      base,
      `/api/runs/${encodeURIComponent(runBData.runId)}`,
      fixture.principals.tenantA,
    )
    assertCrossTenantDenied(response)
    assertNoSecret(await response.text(), 'foreign run denial')
  })

  await check('foreign SSE subscription is denied before stream establishment', async () => {
    const response = await authenticatedFetch(
      base,
      `/api/events?id=${encodeURIComponent(runBData.runId)}`,
      fixture.principals.tenantA,
    )
    assertCrossTenantDenied(response)
    assert.notEqual(response.headers.get('content-type'), 'text/event-stream')
    await response.body?.cancel()
  })

  await check('tenant A cannot read tenant B trace or artifact resources', async () => {
    for (const suffix of ['trace', 'artifacts']) {
      const response = await authenticatedFetch(
        base,
        `/api/runs/${encodeURIComponent(runBData.runId)}/${suffix}`,
        fixture.principals.tenantA,
      )
      assertCrossTenantDenied(response)
      assertNoSecret(await response.text(), `foreign ${suffix} denial`)
    }
  })

  await check('owner trace response is redacted and contains no secret ancestry', async () => {
    const response = await authenticatedFetch(
      base,
      `/api/runs/${encodeURIComponent(runBData.runId)}/trace`,
      fixture.principals.tenantB,
    )
    assert.equal(response.status, 200)
    assertNoSecret(await response.text(), 'owner trace response')
  })

  await check('owner artifact response projects opaque public refs without secrets', async () => {
    const response = await authenticatedFetch(
      base,
      `/api/runs/${encodeURIComponent(runBData.runId)}/artifacts`,
      fixture.principals.tenantB,
    )
    assert.equal(response.status, 200)
    assertNoSecret(await response.text(), 'owner artifact response')
  })

  const approvalId = 'm5-approval-tenant-b'
  await seedApproval(control, runBControl.runId, approvalId, ownerScopeB)
  await check('approval id guessing cannot resolve a foreign approval', async () => {
    const response = await authenticatedFetch(
      base,
      `/api/approvals/${encodeURIComponent(approvalId)}/resolve`,
      fixture.principals.tenantA,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': 'm5-foreign-approval',
        },
        body: JSON.stringify({
          decision: 'approved',
          expectedRecordRevision: 0,
        }),
      },
    )
    assertCrossTenantDenied(response)
    const approval = await control.approvalService.get(approvalId, { ownerScope: ownerScopeB })
    assert.equal(approval?.status, 'pending', 'foreign request mutated approval')
  })

  await check('tenant A cannot cancel or otherwise control tenant B run', async () => {
    const response = await authenticatedFetch(
      base,
      `/api/runs/${encodeURIComponent(runBControl.runId)}/cancel`,
      fixture.principals.tenantA,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': 'm5-foreign-cancel',
        },
        body: JSON.stringify({}),
      },
    )
    assertCrossTenantDenied(response)
    assert.equal(
      (await control.runService.get(runBControl.runId, { ownerScope: ownerScopeB }))?.state,
      'queued',
    )
  })

  await check('authenticated owner-scoped Memory API exists', async () => {
    const ownerList = await authenticatedFetch(base, '/api/memories?limit=25', fixture.principals.tenantB)
    assert.equal(ownerList.status, 200, 'owner-scoped Memory list is missing')
    assertNoSecret(await ownerList.text(), 'owner memory list')
  })

  await check('Memory id guessing is denied before business lookup', async () => {
    const foreignGuess = await authenticatedFetch(
      base,
      '/api/memories/memory-tenant-b-guessed',
      fixture.principals.tenantA,
    )
    assertCrossTenantDenied(foreignGuess)
    assertNoSecret(await foreignGuess.text(), 'foreign memory denial')
  })

  let firstQuotaRun
  await check('quota reservation is idempotent and overflow fails closed', async () => {
    const first = await createRun(base, fixture.principals.tenantA, 'quota-first', 'm5-quota-one')
    firstQuotaRun = first
    const replay = await createRun(base, fixture.principals.tenantA, 'quota-first', 'm5-quota-one')
    assert.equal(replay.runId, first.runId, 'idempotent retry must replay the original reservation')
    const secondResponse = await createRunResponse(
      base,
      fixture.principals.tenantA,
      'quota-second',
      'm5-quota-two',
    )
    assert.equal(secondResponse.status, 429)
  })

  await check('cancel and retry cannot refund runs-per-window quota', async () => {
    assert(firstQuotaRun, 'quota setup run is missing')
    const cancelled = await authenticatedFetch(
      base,
      `/api/runs/${encodeURIComponent(firstQuotaRun.runId)}/cancel`,
      fixture.principals.tenantA,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': 'm5-quota-cancel' },
        body: JSON.stringify({ expectedRevision: firstQuotaRun.revision }),
      },
    )
    assert.equal(cancelled.status, 202)
    const cancelReplay = await authenticatedFetch(
      base,
      `/api/runs/${encodeURIComponent(firstQuotaRun.runId)}/cancel`,
      fixture.principals.tenantA,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': 'm5-quota-cancel' },
        body: JSON.stringify({ expectedRevision: firstQuotaRun.revision }),
      },
    )
    assert.equal(cancelReplay.status, 202)
    const afterCancel = await createRunResponse(
      base,
      fixture.principals.tenantA,
      'quota-after-cancel',
      'm5-quota-three',
    )
    assert.equal(afterCancel.status, 429, 'cancel/retry incorrectly refunded a runs-per-window quota')
  })

  await check('management and denial audit events are complete and redacted', async () => {
    for (const action of ['run.create', 'run.cancel', 'approval.resolve', 'quota.deny', 'auth.deny']) {
      const event = auditEvents.find((candidate) => candidate.action === action)
      assert(event, `missing audit event ${action}`)
      const validated = sdk.validateAuditEvent(event)
      assert.equal(validated.actor.scope.kind, 'tenant')
      assert.equal(typeof validated.target.kind, 'string')
      assert.equal(Number.isFinite(Date.parse(validated.occurredAt)), true)
      assertNoSecret(JSON.stringify(validated), `audit ${action}`)
    }
  })

  await check('redacted error messages and process logs contain no secret', async () => {
    const response = await authenticatedFetch(
      base,
      `/api/runs/${encodeURIComponent(fixture.secretMarker)}/cancel`,
      fixture.principals.tenantA,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      },
    )
    assert.equal(response.ok, false)
    assertNoSecret(await response.text(), 'error response')
    assertNoSecret(capturedLogs.join('\n'), 'process logs')
  })
} finally {
  restoreConsole()
  await control.close().catch(() => {})
  restoreEnv(originalEnv)
  await rm(root, { recursive: true, force: true })
}

for (const result of results) {
  console.log(`${result.status} ${result.name}${result.detail ? ` — ${result.detail}` : ''}`)
}
const passed = results.filter((result) => result.status === 'PASS').length
console.log(`security-m5-web-api-test: ${passed}/${results.length} assertions passed (production source)`)
if (passed !== results.length) process.exitCode = 1

function tenantScope(principal) {
  return {
    schemaVersion: 'service-scope/v1',
    kind: 'tenant',
    tenantId: principal.tenantId,
    userId: principal.userId,
  }
}

function ownerScope(principal) {
  return {
    schemaVersion: 'owner-scope/v1',
    tenantId: principal.tenantId,
    userId: principal.userId,
  }
}

function authenticateFixture(authorization) {
  const token = typeof authorization === 'string' && authorization.startsWith('Bearer ')
    ? authorization.slice('Bearer '.length)
    : undefined
  for (const principal of Object.values(fixture.principals)) {
    if (token === principal.token) {
      return {
        schemaVersion: 'service-principal/v1',
        actorId: principal.actorId,
        authentication: 'bearer',
        scope: tenantScope(principal),
      }
    }
  }
  return undefined
}

async function createRun(base, principal, label, idempotencyKey) {
  const response = await createRunResponse(base, principal, label, idempotencyKey)
  if (response.status !== 201) {
    const body = await response.text()
    assert.fail(`${label} create failed with ${response.status}: ${body}`)
  }
  return response.json()
}

function createRunResponse(base, principal, label, idempotencyKey) {
  return authenticatedFetch(base, '/api/runs', principal, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': idempotencyKey,
    },
    body: JSON.stringify({
      mode: 'raw',
      startUrl: `https://${label}.example.test/`,
      taskPrompt: `Inspect ${label} without writing.`,
      restartSafe: true,
    }),
  })
}

function authenticatedFetch(base, path, principal, options = {}) {
  const headers = new Headers(options.headers)
  headers.set('authorization', `Bearer ${principal.token}`)
  return fetch(`${base}${path}`, { ...options, headers })
}

function assertCrossTenantDenied(response) {
  assert(
    response.status === 403 || response.status === 404,
    `cross-tenant request must be 403/404, received ${response.status}`,
  )
}

function assertNoSecret(value, label) {
  const text = String(value)
  assert.equal(text.includes(fixture.secretMarker), false, `${label} leaked the secret marker`)
  for (const principal of Object.values(fixture.principals)) {
    assert.equal(text.includes(principal.token), false, `${label} leaked an API token`)
  }
}

async function seedTrace(rootDir, runId, secret) {
  const dir = join(rootDir, runId)
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, 'trace.jsonl'),
    `${JSON.stringify({ type: 'error', message: `Authorization: Bearer ${secret}` })}\n`,
    'utf8',
  )
  await writeFile(
    join(dir, 'summary.json'),
    JSON.stringify({ error: `upstream token=${secret}` }),
    'utf8',
  )
}

async function seedApproval(controlValue, runId, approvalId, approvalOwnerScope) {
  const requestedAt = '2026-07-18T00:00:00.000Z'
  await controlValue.approvalService.enqueue({
    approvalId,
    runId,
    runRevision: 0,
    attempt: 1,
    status: 'pending',
    ownerScope: approvalOwnerScope,
    actionBinding: {
      schemaVersion: 'action-binding/v1',
      contractId: 'm5-security-contract',
      contractRevision: 0,
      runId,
      actionId: 'm5-submit-b',
      toolName: 'browser_click',
      argsSha256: 'b'.repeat(64),
      sourceContentIds: ['m5-page-b'],
      sourceSensitiveClasses: [],
      sourceOrigin: 'https://source.example',
      destinationOrigin: 'https://destination.example',
      actionSeq: 1,
      expiresAt: '2030-01-01T00:00:00.000Z',
    },
    allowedDecisions: ['approved', 'denied'],
    requestedAt,
    expiresAt: '2030-01-01T00:00:00.000Z',
  }, 'm5-enqueue-approval-b')
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
}

async function check(name, operation) {
  try {
    await operation()
    results.push({ status: 'PASS', name })
  } catch (error) {
    results.push({
      status: 'FAIL',
      name,
      detail: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    })
  }
}

function snapshotEnv(keys) {
  return Object.fromEntries(keys.map((key) => [key, process.env[key]]))
}

function restoreEnv(snapshot) {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

function captureConsole(entries) {
  const originalLog = console.log
  const originalError = console.error
  console.log = (...args) => entries.push(args.map(String).join(' '))
  console.error = (...args) => entries.push(args.map(String).join(' '))
  return () => {
    console.log = originalLog
    console.error = originalError
  }
}

async function installSourceResolver() {
  const { registerHooks } = await import('node:module')
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL?.includes('/src/')) {
        const typescriptUrl = new URL(`${specifier.slice(0, -3)}.ts`, context.parentURL)
        if (existsSync(typescriptUrl)) return { url: typescriptUrl.href, shortCircuit: true }
      }
      return nextResolve(specifier, context)
    },
    load(url, context, nextLoad) {
      if (url.endsWith('.html')) {
        return {
          format: 'module',
          source: `export default ${JSON.stringify(readFileSync(new URL(url), 'utf8'))}`,
          shortCircuit: true,
        }
      }
      return nextLoad(url, context)
    },
  })
}
