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
  assert.throws(
    () => sdk.validateAuditEvent({ ...event, occurredAt: '2026-07-18T00:00:00Z' }),
    invalidContract,
  )
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
  const wrongIdClient = sdk.createRunClient({
    scope: scopeA,
    transport: transportReturning(publicRun(scopeA)),
  })
  await assert.rejects(
    wrongIdClient.cancel({
      schemaVersion: 'run-client-control/v1',
      runId: 'run-a-requested',
      expectedRevision: 0,
      idempotencyKey: 'cancel-wrong-response-id',
    }),
    /PublicRun.runId does not match the request/,
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
  const wrongIdClient = sdk.createApprovalClient({
    scope: scopeA,
    transport: transportReturning(publicApproval(scopeA)),
  })
  await assert.rejects(
    wrongIdClient.resolve({
      schemaVersion: 'approval-client-resolve/v1',
      approvalId: 'approval-a-requested',
      expectedRevision: 0,
      decision: 'approved',
      idempotencyKey: 'resolve-wrong-response-id',
    }),
    /PublicApproval.approvalId does not match the request/,
  )
})

await check('Approval list items bind the requested Run even within one tenant', async () => {
  const client = sdk.createApprovalClient({
    scope: scopeA,
    transport: transportReturning({
      schemaVersion: 'public-approval-list/v1',
      items: [publicApproval(scopeA, { runId: 'run-foreign-same-tenant' })],
    }),
  })
  await assert.rejects(
    client.list({ schemaVersion: 'approval-client-list/v1', runId: 'run-b' }),
    transportFailure,
  )
})

await check('Approval client preserves an explicitly offered exact execution decision', async () => {
  const requests = []
  const client = sdk.createApprovalClient({
    scope: scopeA,
    transport: {
      async send(request) {
        requests.push(structuredClone(request))
        return publicApproval(scopeA, {
          approvalId: 'approval-a-execute',
          status: 'approved',
          allowedDecisions: ['approved', 'approved_and_execute', 'denied'],
          externalBusinessKey: 'opaque:m5-tenant-a:invoice:execute-1',
          externalEffectDigest: 'e'.repeat(64),
          externalProbeId: 'm5-read-only-probe/v1',
          externalActionKind: 'submit',
          externalEffectPreview: '{"amount":48600,"operation":"submit_invoice"}',
        })
      },
    },
  })
  const approval = await client.resolve({
    schemaVersion: 'approval-client-resolve/v1',
    approvalId: 'approval-a-execute',
    expectedRevision: 0,
    decision: 'approved_and_execute',
    idempotencyKey: 'execute-approval-a',
  })
  assert.deepEqual(approval.allowedDecisions, ['approved', 'approved_and_execute', 'denied'])
  assert.equal(approval.action.externalBusinessKey, 'opaque:m5-tenant-a:invoice:execute-1')
  assert.equal(approval.action.externalEffectDigest, 'e'.repeat(64))
  assert.equal(approval.action.externalProbeId, 'm5-read-only-probe/v1')
  assert.equal(approval.action.externalActionKind, 'submit')
  assert.equal(approval.action.externalEffectPreview, '{"amount":48600,"operation":"submit_invoice"}')
  assert.equal(requests.length, 1)
  assert.equal(requests[0].body.decision, 'approved_and_execute')
})

await check('Approval client rejects unreviewable execution offers from transport', async () => {
  const cases = [
    {
      externalActionKind: 'submit',
      externalProbeId: 'm5-read-only-probe/v1',
      externalEffectPreview: undefined,
    },
    {
      externalActionKind: 'submit',
      externalProbeId: 'm5-read-only-probe/v1',
      externalEffectPreview: 'not-json',
    },
    {
      externalActionKind: 'type_or_paste',
      externalProbeId: 'm5-read-only-probe/v1',
      externalEffectPreview: '{"operation":"type"}',
    },
    {
      externalActionKind: 'submit',
      externalProbeId: undefined,
      externalEffectPreview: '{"operation":"submit_invoice"}',
    },
    {
      externalActionKind: 'submit',
      externalProbeId: 'm5-read-only-probe/v1',
      externalEffectPreview: '{"operation":"submit_invoice","amount":48600}',
    },
    {
      externalActionKind: 'submit',
      externalProbeId: 'm5-read-only-probe/v1',
      externalEffectPreview: '{"apiToken":"must-not-render","operation":"submit_invoice"}',
    },
  ]
  for (const [index, item] of cases.entries()) {
    const client = sdk.createApprovalClient({
      scope: scopeA,
      transport: transportReturning(publicApproval(scopeA, {
        approvalId: `approval-unsafe-${index}`,
        status: 'pending',
        allowedDecisions: ['approved', 'approved_and_execute', 'denied'],
        externalBusinessKey: `opaque:m5-tenant-a:invoice:unsafe-${index}`,
        externalEffectDigest: 'e'.repeat(64),
        ...(item.externalProbeId ? { externalProbeId: item.externalProbeId } : {}),
        externalActionKind: item.externalActionKind,
        ...(item.externalEffectPreview ? { externalEffectPreview: item.externalEffectPreview } : {}),
      })),
    })
    await assert.rejects(
      client.resolve({
        schemaVersion: 'approval-client-resolve/v1',
        approvalId: `approval-unsafe-${index}`,
        expectedRevision: 0,
        decision: 'approved',
        idempotencyKey: `unsafe-approval-${index}`,
      }),
      /reviewable|external identity|must be (?:canonical )?JSON|secret-bearing|externalActionKind is invalid/i,
    )
  }
  const duplicateDecisionClient = sdk.createApprovalClient({
    scope: scopeA,
    transport: transportReturning(publicApproval(scopeA, {
      approvalId: 'approval-duplicate-decisions',
      allowedDecisions: ['approved', 'approved', 'denied'],
    })),
  })
  await assert.rejects(
    duplicateDecisionClient.resolve({
      schemaVersion: 'approval-client-resolve/v1',
      approvalId: 'approval-duplicate-decisions',
      expectedRevision: 0,
      decision: 'approved',
      idempotencyKey: 'duplicate-decisions',
    }),
    /allowedDecisions is invalid/i,
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

await check('Run event items bind the exact Run and closed event schema', async () => {
  const envelope = (event) => ({
    schemaVersion: 'public-run-events/v1',
    scope: scopeA,
    runId: 'run-b',
    items: [event],
  })
  const validClient = sdk.createRunClient({
    scope: scopeA,
    transport: transportReturning(envelope(publicRunEvent())),
  })
  assert.equal((await validClient.events({
    schemaVersion: 'run-client-events/v1',
    runId: 'run-b',
  })).length, 1)
  for (const event of [
    publicRunEvent({ runId: 'run-foreign' }),
    publicRunEvent({ hiddenRunAuthority: true }),
    publicRunEvent({ timestamp: '2026-07-18T00:00:00Z' }),
    publicRunEvent({
      snapshot: {
        schemaVersion: 'run-snapshot/v1',
        runId: 'run-b',
        revision: 0,
        attempt: 1,
        state: 'running',
        updatedAt: '2026-07-18T00:00:00.000Z',
        sessionRef: {
          schemaVersion: 'session-ref/v1',
          provider: 'file-session-store',
          id: 'session-foreign-run',
          runId: 'run-foreign',
          attempt: 1,
        },
      },
    }),
  ]) {
    const client = sdk.createRunClient({
      scope: scopeA,
      transport: transportReturning(envelope(event)),
    })
    await assert.rejects(
      client.events({ schemaVersion: 'run-client-events/v1', runId: 'run-b' }),
      transportFailure,
    )
  }
  for (const items of [
    [
      publicRunEvent({ sequence: 1 }),
      publicRunEvent({ sequence: 1, timestamp: '2026-07-18T00:00:00.001Z' }),
    ],
    [
      publicRunEvent({ sequence: 1, timestamp: '2026-07-18T00:00:00.001Z' }),
      publicRunEvent({ sequence: 2, timestamp: '2026-07-18T00:00:00.000Z' }),
    ],
  ]) {
    const client = sdk.createRunClient({
      scope: scopeA,
      transport: transportReturning({
        schemaVersion: 'public-run-events/v1',
        scope: scopeA,
        runId: 'run-b',
        items,
      }),
    })
    await assert.rejects(
      client.events({ schemaVersion: 'run-client-events/v1', runId: 'run-b' }),
      transportFailure,
    )
  }
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

await check('Run artifact items bind the exact run, owner and closed Artifact schema', async () => {
  const envelope = (artifact) => ({
    schemaVersion: 'public-artifact-list/v1',
    scope: scopeA,
    runId: 'run-b',
    items: [artifact],
  })
  const validClient = sdk.createRunClient({
    scope: scopeA,
    transport: transportReturning(envelope(publicArtifact(scopeA))),
  })
  assert.equal((await validClient.artifacts({
    schemaVersion: 'run-client-artifacts/v1',
    runId: 'run-b',
  })).length, 1)

  for (const artifact of [
    publicArtifact(scopeA, { binding: { runId: 'run-foreign', revision: 0 } }),
    publicArtifact(scopeB),
    publicArtifact(scopeA, { hiddenArtifactAuthority: true }),
  ]) {
    const client = sdk.createRunClient({
      scope: scopeA,
      transport: transportReturning(envelope(artifact)),
    })
    await assert.rejects(
      client.artifacts({ schemaVersion: 'run-client-artifacts/v1', runId: 'run-b' }),
      transportFailure,
    )
  }
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

function publicArtifact(scope, overrides = {}) {
  return {
    schemaVersion: 'artifact-ref/v1',
    id: 'artifact-b',
    kind: 'external_action_receipt',
    payloadSchemaVersion: 'external-action-receipt/v1',
    mediaType: 'application/json',
    byteLength: 128,
    sha256: 'a'.repeat(64),
    createdAt: '2026-07-18T00:00:00.000Z',
    immutable: true,
    locator: 'opaque:artifact-b',
    producer: { id: 'main-runtime', version: '1' },
    parentEvidenceIds: [],
    parentArtifactIds: [],
    origin: 'artifact',
    trust: 'trusted_runtime',
    sensitivity: 'internal',
    retention: { scope: 'run', deleteWithSession: true },
    ownerScope: {
      schemaVersion: 'owner-scope/v1',
      tenantId: scope.tenantId,
      userId: scope.userId,
    },
    binding: { runId: 'run-b', revision: 0 },
    requiresMainWorkflowVerification: false,
    authoritativeCompletionEvidence: true,
    redaction: { status: 'not_required', policyId: 'redaction/v1' },
    scanner: { status: 'clean', scannerId: 'scanner/v1' },
    ...overrides,
  }
}

function publicRunEvent(overrides = {}) {
  return {
    schemaVersion: 'web-task-event/v1',
    sequence: 0,
    type: 'run_created',
    timestamp: '2026-07-18T00:00:00.000Z',
    runId: 'run-b',
    revision: 0,
    ...overrides,
  }
}

function publicApproval(scope, options = {}) {
  return {
    schemaVersion: 'public-approval/v1',
    approvalId: options.approvalId ?? 'approval-b',
    runId: options.runId ?? 'run-b',
    revision: 0,
    attempt: 1,
    status: options.status ?? 'pending',
    scope,
    action: {
      actionId: 'action-b',
      kind: 'browser_click',
      sourceOrigin: 'https://source.example',
      destinationOrigin: 'https://destination.example',
      ...(options.externalBusinessKey ? { externalBusinessKey: options.externalBusinessKey } : {}),
      ...(options.externalEffectDigest ? { externalEffectDigest: options.externalEffectDigest } : {}),
      ...(options.externalProbeId ? { externalProbeId: options.externalProbeId } : {}),
      ...(options.externalActionKind ? { externalActionKind: options.externalActionKind } : {}),
      ...(options.externalEffectPreview ? { externalEffectPreview: options.externalEffectPreview } : {}),
    },
    allowedDecisions: options.allowedDecisions ?? ['approved', 'denied'],
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

function transportFailure(error) {
  return error?.code === 'TRANSPORT_ERROR'
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
