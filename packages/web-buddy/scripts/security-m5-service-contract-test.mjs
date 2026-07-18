#!/usr/bin/env node
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'

const fixture = JSON.parse(readFileSync(
  new URL('./fixtures/security/m5-service-security.json', import.meta.url),
  'utf8',
))
assert.equal(fixture.schemaVersion, 'security-m5-service/v1')

const sourceUrl = new URL('../src/public/index.ts', import.meta.url)
const distUrl = new URL('../dist/public/index.js', import.meta.url)
const useSource = process.env.WEB_BUDDY_TEST_SOURCE === '1' || !existsSync(distUrl)
if (useSource) await installSourceResolver()
const sdk = await import(useSource ? sourceUrl : distUrl)
const results = []

const scopeA = tenantScope(fixture.principals.tenantA)
const scopeB = tenantScope(fixture.principals.tenantB)
const scopeAOtherUser = {
  ...scopeA,
  userId: 'user-a-foreign',
}

await check('tenant and user scopes are exact, never wildcard', async () => {
  assert.throws(() => sdk.assertServiceScopeAccess(scopeA, scopeB), scopeMismatch)
  assert.throws(() => sdk.assertServiceScopeAccess(scopeA, scopeAOtherUser), scopeMismatch)
  assert.throws(() => sdk.assertServiceScopeAccess(
    { schemaVersion: 'service-scope/v1', kind: 'local' },
    scopeA,
  ), scopeMismatch)
})

await check('missing or forged service scope fails closed', async () => {
  assert.throws(() => sdk.validateServiceScope(undefined), invalidContract)
  assert.throws(() => sdk.validateServiceScope({
    schemaVersion: 'service-scope/v1',
    kind: 'tenant',
    tenantId: scopeA.tenantId,
  }), invalidContract)
  assert.throws(() => sdk.validateServiceScope({
    ...scopeA,
    token: fixture.principals.tenantA.token,
  }), invalidContract)
})

for (const resourceKind of fixture.resourceKinds) {
  await check(`${resourceKind} Store query preserves exact tenant scope`, async () => {
    const query = sdk.validateServiceStoreQuery({
      schemaVersion: 'service-store-query/v1',
      scope: scopeA,
      resourceKind,
      resourceId: `${resourceKind}-a`,
      limit: 25,
    })
    assert.deepEqual(query.scope, scopeA)
    assert.equal(query.resourceKind, resourceKind)
  })
}

await check('quota counts used plus reserved plus requested and denies overflow', async () => {
  const denied = sdk.evaluateQuota(
    quotaLimit(scopeA, 'runs_per_window', 1, fixture.quota.windowMs),
    quotaUsage(scopeA, 'runs_per_window', 0, 1),
    1,
    new Date('2026-07-18T00:00:01.000Z'),
  )
  assert.equal(denied.decision, 'deny')
  assert.equal(denied.reasonCode, 'quota_exceeded')
  assert.equal(denied.projected, 2)
})

await check('quota scope mismatch and invalid accounting fail closed', async () => {
  assert.throws(
    () => sdk.evaluateQuota(
      quotaLimit(scopeA, 'concurrent_runs', 1),
      quotaUsage(scopeB, 'concurrent_runs', 0, 0),
      1,
    ),
    scopeMismatch,
  )
  assert.throws(
    () => sdk.evaluateQuota(
      quotaLimit(scopeA, 'concurrent_runs', 1),
      quotaUsage(scopeA, 'concurrent_runs', 0, 0),
      -1,
    ),
    invalidContract,
  )
})

await check('management audit requires actor tenant action target time and result', async () => {
  const event = auditEvent(scopeA)
  assert.equal(sdk.validateAuditEvent(event).action, 'run.cancel')
  for (const field of ['actor', 'action', 'target', 'occurredAt', 'result']) {
    const missing = structuredClone(event)
    delete missing[field]
    assert.throws(() => sdk.validateAuditEvent(missing), invalidContract)
  }
  const missingTenant = structuredClone(event)
  delete missingTenant.actor.scope.tenantId
  assert.throws(() => sdk.validateAuditEvent(missingTenant), invalidContract)
})

await check('audit metadata rejects a secret-bearing key', async () => {
  assert.throws(() => sdk.validateAuditEvent({
    ...auditEvent(scopeA),
    metadata: { authorizationToken: fixture.secretMarker },
  }), invalidContract)
})

await check('audit metadata rejects Bearer material hidden in an ordinary message value', async () => {
  assert.throws(() => sdk.validateAuditEvent({
    ...auditEvent(scopeA),
    redaction: 'redacted',
    metadata: {
      message: `upstream failed with Authorization: Bearer ${fixture.secretMarker}`,
    },
  }), invalidContract)
})

await check('audit reasonCode cannot carry secret material', async () => {
  assert.throws(() => sdk.validateAuditEvent({
    ...auditEvent(scopeA),
    result: 'failed',
    reasonCode: `Bearer ${fixture.secretMarker}`,
    redaction: 'redacted',
  }), invalidContract)
})

await check('Run client rejects foreign list and detail resources', async () => {
  const listClient = sdk.createRunClient({
    scope: scopeA,
    transport: transportReturning(publicRunList(scopeB)),
  })
  await assert.rejects(
    listClient.list({ schemaVersion: 'run-client-list/v1' }),
    scopeMismatch,
  )
  const getClient = sdk.createRunClient({
    scope: scopeA,
    transport: transportReturning(publicRun(scopeB)),
  })
  await assert.rejects(
    getClient.get({ schemaVersion: 'run-client-get/v1', runId: 'run-b' }),
    scopeMismatch,
  )
})

await check('Run control rejects a foreign-scope response', async () => {
  const client = sdk.createRunClient({
    scope: scopeA,
    transport: transportReturning(publicRun(scopeB)),
  })
  await assert.rejects(
    client.cancel({
      schemaVersion: 'run-client-control/v1',
      runId: 'run-b',
      expectedRevision: 0,
      idempotencyKey: 'cancel-run-b',
    }),
    scopeMismatch,
  )
})

await check('Approval client rejects foreign list and guessed-id responses', async () => {
  const listClient = sdk.createApprovalClient({
    scope: scopeA,
    transport: transportReturning(publicApprovalList(scopeB)),
  })
  await assert.rejects(
    listClient.list({ schemaVersion: 'approval-client-list/v1' }),
    scopeMismatch,
  )
  const resolveClient = sdk.createApprovalClient({
    scope: scopeA,
    transport: transportReturning(publicApproval(scopeB)),
  })
  await assert.rejects(
    resolveClient.resolve({
      schemaVersion: 'approval-client-resolve/v1',
      approvalId: 'approval-b',
      expectedRevision: 0,
      decision: 'approved',
      idempotencyKey: 'guess-approval-b',
    }),
    scopeMismatch,
  )
})

await check('Run events response must carry and validate tenant scope', async () => {
  const client = sdk.createRunClient({
    scope: scopeA,
    transport: transportReturning([{
      schemaVersion: 'web-task-event/v1',
      type: 'run_started',
      runId: 'run-b',
      sequence: 1,
      occurredAt: '2026-07-18T00:00:00.000Z',
      scope: scopeB,
    }]),
  })
  await assert.rejects(
    client.events({ schemaVersion: 'run-client-events/v1', runId: 'run-b' }),
    scopeMismatch,
  )
})

await check('Run artifacts response must carry and validate tenant scope', async () => {
  const client = sdk.createRunClient({
    scope: scopeA,
    transport: transportReturning([{
      schemaVersion: 'artifact-ref/v1',
      id: 'artifact-b',
      scope: scopeB,
      locator: 'opaque:artifact-b',
    }]),
  })
  await assert.rejects(
    client.artifacts({ schemaVersion: 'run-client-artifacts/v1', runId: 'run-b' }),
    scopeMismatch,
  )
})

for (const result of results) {
  console.log(`${result.status} ${result.name}${result.detail ? ` — ${result.detail}` : ''}`)
}
const passed = results.filter((result) => result.status === 'PASS').length
console.log(`security-m5-service-contract-test: ${passed}/${results.length} assertions passed (${useSource ? 'source' : 'dist'})`)
if (passed !== results.length) process.exitCode = 1

function tenantScope(principal) {
  return {
    schemaVersion: 'service-scope/v1',
    kind: 'tenant',
    tenantId: principal.tenantId,
    userId: principal.userId,
  }
}

function quotaLimit(scope, dimension, maximum, windowMs) {
  return {
    schemaVersion: 'quota-limit/v1',
    scope,
    dimension,
    maximum,
    ...(windowMs === undefined ? {} : { windowMs }),
  }
}

function quotaUsage(scope, dimension, used, reserved) {
  return {
    schemaVersion: 'quota-usage/v1',
    scope,
    dimension,
    used,
    reserved,
    measuredAt: '2026-07-18T00:00:00.000Z',
    ...(dimension === 'runs_per_window'
      ? { windowStartedAt: '2026-07-18T00:00:00.000Z' }
      : {}),
  }
}

function auditEvent(scope) {
  return {
    schemaVersion: 'audit-event/v1',
    eventId: 'audit-m5-1',
    requestId: 'request-m5-1',
    actor: {
      schemaVersion: 'audit-actor/v1',
      actorId: 'actor-a',
      scope,
      authentication: 'bearer',
    },
    action: 'run.cancel',
    target: { kind: 'run', id: 'run-a' },
    occurredAt: '2026-07-18T00:00:00.000Z',
    result: 'succeeded',
    redaction: 'not_required',
  }
}

function publicRun(scope) {
  return {
    schemaVersion: 'public-run/v1',
    runId: 'run-b',
    revision: 0,
    attempt: 1,
    state: 'running',
    scope,
    updatedAt: '2026-07-18T00:00:00.000Z',
  }
}

function publicRunList(scope) {
  return {
    schemaVersion: 'public-run-list/v1',
    items: [publicRun(scope)],
  }
}

function publicApproval(scope) {
  return {
    schemaVersion: 'public-approval/v1',
    approvalId: 'approval-b',
    runId: 'run-b',
    revision: 0,
    attempt: 1,
    status: 'pending',
    scope,
    action: {
      actionId: 'action-b',
      kind: 'browser_click',
      sourceOrigin: 'https://source.example',
      destinationOrigin: 'https://destination.example',
    },
    requestedAt: '2026-07-18T00:00:00.000Z',
    expiresAt: '2030-01-01T00:00:00.000Z',
  }
}

function publicApprovalList(scope) {
  return {
    schemaVersion: 'public-approval-list/v1',
    items: [publicApproval(scope)],
  }
}

function transportReturning(value) {
  return {
    async send() {
      return structuredClone(value)
    },
  }
}

function invalidContract(error) {
  return error?.code === 'INVALID_CONTRACT'
}

function scopeMismatch(error) {
  return error?.code === 'SCOPE_MISMATCH'
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
  })
}
