#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { emptyRunMetrics } from '../dist/metrics/schema.js'
import { digestCanonicalJson, snapshotWebTaskInput } from '../dist/task/contracts.js'
import { createWebControlServer } from '../dist/web/server.js'

const root = await mkdtemp(join(tmpdir(), 'web-buddy-m6-web-task-service-'))
const traceRoot = join(root, 'trace')
const controlRoot = join(root, 'control')
const token = 'm6-web-task-service-token'
const scope = {
  schemaVersion: 'service-scope/v1',
  kind: 'tenant',
  tenantId: 'm6-service-tenant',
  userId: 'm6-service-user',
}
const ownerScope = {
  schemaVersion: 'owner-scope/v1',
  tenantId: scope.tenantId,
  userId: scope.userId,
}
const priorTraceRoot = process.env.TRACE_OUT_DIR
process.env.TRACE_OUT_DIR = traceRoot
const driverRequests = []
let outcomeMode = 'artifact'

const driver = {
  async execute(request) {
    driverRequests.push(structuredClone({
      input: request.input,
      contextItems: request.contextItems,
    }))
    const artifactOwnerScope = outcomeMode === 'foreign-owner'
      ? {
          schemaVersion: 'owner-scope/v1',
          tenantId: 'foreign-tenant',
          userId: 'foreign-user',
        }
      : outcomeMode === 'missing-owner'
        ? undefined
        : request.input.ownerScope
    const artifact = comparisonArtifact(request.input.runId, request.input.revision, artifactOwnerScope)
    if (outcomeMode === 'foreign-session') {
      artifact.binding.sessionRef = {
        schemaVersion: 'session-ref/v1',
        provider: 'foreign-store',
        id: 'foreign-session',
        runId: 'foreign-run',
        attempt: 9,
      }
    }
    if (outcomeMode === 'negative-action-sequence') artifact.binding.actionSeq = -1
    return {
      status: 'completed',
      summary: outcomeMode === 'artifact'
        ? 'Comparison artifact produced.'
        : 'Runtime claimed completion without the required artifact.',
      evidence: [],
      artifacts: outcomeMode === 'missing-artifact' ? [] : [artifact],
      metrics: emptyRunMetrics({
        runId: request.input.runId,
        source: 'sdk',
        scenario: 'm6-service-fixture',
        profile: 'deterministic',
      }),
      actions: [{ actionKind: 'submit', outcome: 'not_performed' }],
      ...(outcomeMode === 'foreign-result-session'
        ? {
            sessionRef: {
              schemaVersion: 'session-ref/v1',
              provider: 'foreign-store',
              id: 'foreign-result-session',
              runId: 'foreign-run',
              attempt: 9,
            },
          }
        : {}),
      ...(outcomeMode === 'checkpoint-without-session'
        ? {
            checkpointRef: {
              schemaVersion: 'checkpoint-ref/v1',
              provider: 'orphan-checkpoint-store',
              id: 'orphan-checkpoint',
            },
          }
        : {}),
    }
  },
}

let control = createControl(driver)
try {
  await listen(control.server)
  let base = address(control.server)

  const staleDigest = genericSnapshot('client-stale-digest')
  staleDigest.goal.instruction = 'Tampered after the snapshot was signed.'
  await expectRejectedSnapshot(base, 'm6-stale-digest', staleDigest)

  const unknownInputVersion = genericSnapshot('client-unknown-input-version')
  unknownInputVersion.inputSchemaVersion = 'web-task-input/v999'
  rehashSnapshot(unknownInputVersion)
  await expectRejectedSnapshot(base, 'm6-unknown-input-version', unknownInputVersion)

  const unknownAuthorityField = genericSnapshot('client-unknown-authority-field')
  unknownAuthorityField.elevatedAuthority = 'browser_writer'
  rehashSnapshot(unknownAuthorityField)
  await expectRejectedSnapshot(base, 'm6-unknown-authority-field', unknownAuthorityField)

  const unknownGoalAuthority = genericSnapshot('client-unknown-goal-authority')
  unknownGoalAuthority.goal.authority = 'system_policy'
  rehashSnapshot(unknownGoalAuthority)
  await expectRejectedSnapshot(base, 'm6-unknown-goal-authority', unknownGoalAuthority)

  const unknownPolicyAuthority = genericSnapshot('client-unknown-policy-authority')
  unknownPolicyAuthority.policy.allowWithoutApproval = true
  rehashSnapshot(unknownPolicyAuthority)
  await expectRejectedSnapshot(base, 'm6-unknown-policy-authority', unknownPolicyAuthority)

  const unknownContextAuthority = genericSnapshot('client-unknown-context-authority')
  unknownContextAuthority.contextItems[0].browserWriteAuthority = true
  rehashSnapshot(unknownContextAuthority)
  await expectRejectedSnapshot(base, 'm6-unknown-context-authority', unknownContextAuthority)

  const completed = await createGenericRun(base, 'm6-generic-artifact', genericSnapshot('client-artifact'))
  const completedRun = await waitForState(base, completed.runId, ['completed', 'failed', 'blocked_on_human'])
  assert.equal(completedRun.state, 'completed')
  assert.equal(driverRequests.length, 1, 'generic snapshot did not execute through the injected runtime driver')
  assert.equal(
    driverRequests[0].input.sha256,
    snapshotDigest(driverRequests[0].input),
    'runtime driver received context that no longer matched the declared snapshot digest',
  )
  assert.equal(
    driverRequests[0].input.sha256,
    (await control.runService.get(completed.runId, { ownerScope })).inputDigest,
    'runtime driver input must remain the exact frozen server snapshot',
  )
  assert.equal(driverRequests[0].input.contract.contractId, 'm6-comparison-contract')
  assert.equal(driverRequests[0].contextItems[0].id, 'm6-comparison-context')
  assert.equal(driverRequests[0].input.policy.defaultSensitiveAction, 'deny')

  const artifacts = await json(base, `/api/runs/${encodeURIComponent(completed.runId)}/artifacts`)
  assert.equal(artifacts.items.length, 1, 'WebTaskResult ArtifactRef was not attached to the Run')
  assert.equal(artifacts.items[0].kind, 'comparison_table')
  assert.equal(artifacts.items[0].locator, `artifact:${encodeURIComponent('m6-comparison-artifact')}`)

  outcomeMode = 'missing-artifact'
  const premature = await createGenericRun(base, 'm6-generic-premature', genericSnapshot('client-premature'))
  const prematureRun = await waitForState(base, premature.runId, ['completed', 'failed', 'blocked_on_human'])
  assert.equal(
    prematureRun.state,
    'blocked_on_human',
    'a driver completion claim bypassed the runWebTask Completion Gate',
  )
  assert.match(prematureRun.reason, /Missing completion criteria/)

  outcomeMode = 'foreign-owner'
  const foreignArtifact = await createGenericRun(base, 'm6-generic-foreign-artifact', genericSnapshot('client-foreign'))
  const foreignArtifactRun = await waitForState(base, foreignArtifact.runId, ['completed', 'failed', 'blocked_on_human'])
  assert.equal(foreignArtifactRun.state, 'failed', 'a foreign-owner ArtifactRef was attached to the Run')
  assert.match(foreignArtifactRun.reason, /owner scope/)
  const rejectedArtifacts = await json(base, `/api/runs/${encodeURIComponent(foreignArtifact.runId)}/artifacts`)
  assert.equal(rejectedArtifacts.items.length, 0)

  for (const bindingMode of [
    'missing-owner',
    'foreign-session',
    'negative-action-sequence',
    'foreign-result-session',
    'checkpoint-without-session',
  ]) {
    outcomeMode = bindingMode
    const invalid = await createGenericRun(
      base,
      `m6-generic-${bindingMode}`,
      genericSnapshot(`client-${bindingMode}`),
    )
    const invalidRun = await waitForState(base, invalid.runId, ['completed', 'failed', 'blocked_on_human'])
    assert.equal(invalidRun.state, 'failed', `${bindingMode} was accepted by the service binding boundary`)
    const invalidArtifacts = await json(base, `/api/runs/${encodeURIComponent(invalid.runId)}/artifacts`)
    assert.equal(invalidArtifacts.items.length, 0, `${bindingMode} attached an ArtifactRef`)
  }

  outcomeMode = 'artifact'
  const genericCallsBeforeLegacy = driverRequests.length
  const legacyResponse = await request(base, '/api/run', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      mode: 'demo-research',
      startUrl: 'https://example.test/',
      taskPrompt: 'Run the legacy research compatibility entry.',
    }),
  })
  assert.equal(legacyResponse.status, 201)
  const legacy = await legacyResponse.json()
  await waitForState(base, legacy.runId, ['completed', 'failed', 'blocked_on_human'])
  assert.equal(driverRequests.length, genericCallsBeforeLegacy, 'legacy /api/run was routed into the generic test driver')
  const legacyRecord = await control.runService.get(legacy.runId, { ownerScope })
  assert.equal(legacyRecord.inputSnapshot.contract.contractId, 'web-control-plane-legacy-adapter')

  await control.close()
  control = createControl(undefined, true)
  await listen(control.server)
  base = address(control.server)
  const afterRestart = await json(base, `/api/runs/${encodeURIComponent(completed.runId)}/artifacts`)
  assert.equal(afterRestart.items.length, 1, 'ArtifactRef did not survive control-plane restart')
  assert.equal(afterRestart.items[0].id, 'm6-comparison-artifact')

  await prelaunchFailureIsDurable(join(root, 'prelaunch-control'))

  console.log('control-m6-web-task-service-test: PASS (generic gate/artifact/restart + legacy compatibility)')
} finally {
  await control.close().catch(() => {})
  if (priorTraceRoot === undefined) delete process.env.TRACE_OUT_DIR
  else process.env.TRACE_OUT_DIR = priorTraceRoot
  await rm(root, { recursive: true, force: true })
}

async function prelaunchFailureIsDurable(storeRoot) {
  const sentinel = 'm6-provider-secret-must-not-persist'
  let injectCalls = 0
  const secretProvider = {
    credentialConfigured() {
      return false
    },
    async injectModelCredential() {
      injectCalls += 1
      if (injectCalls === 1) throw new Error(`provider unavailable: ${sentinel}`)
    },
    redact(value) {
      return redactSentinel(value, sentinel)
    },
  }
  const prelaunch = createWebControlServer({
    controlStoreDir: storeRoot,
    webTaskRuntimeDriver: driver.execute ? driver : undefined,
    serviceSecurity: {
      schemaVersion: 'web-service-security/v1',
      secretProvider,
      authenticate: ({ authorization }) => authorization === `Bearer ${token}`
        ? {
            schemaVersion: 'service-principal/v1',
            actorId: 'm6-service-actor',
            authentication: 'bearer',
            scope,
          }
        : undefined,
    },
  })
  try {
    await listen(prelaunch.server)
    const base = address(prelaunch.server)
    const failedResponse = await request(base, '/api/runs', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'm6-prelaunch-failure',
      },
      body: JSON.stringify({
        schemaVersion: 'run-client-create/v1',
        input: genericSnapshot('client-prelaunch-failure'),
      }),
    })
    const failedPayload = await failedResponse.json()
    assert.equal(failedResponse.status, 500)
    assert.equal(JSON.stringify(failedPayload).includes(sentinel), false)

    const listed = await json(base, '/api/runs')
    const failedRun = listed.items.find((item) => item.state === 'failed')
    assert(failedRun, 'pre-launch exception left no durable failed Run')
    assert.equal((failedRun.reason ?? '').includes(sentinel), false)

    outcomeMode = 'artifact'
    const healthy = await createGenericRun(
      base,
      'm6-after-prelaunch-failure',
      genericSnapshot('client-after-prelaunch-failure'),
    )
    const healthyRun = await waitForState(base, healthy.runId, ['completed', 'failed', 'blocked_on_human'])
    assert.equal(healthyRun.state, 'completed', 'one provider failure poisoned a later same-tenant run')
    assert.equal((await json(base, `/api/runs/${encodeURIComponent(failedRun.runId)}`)).state, 'failed')
  } finally {
    await prelaunch.close().catch(() => {})
  }
  assert.equal((await readTree(storeRoot)).includes(sentinel), false, 'pre-launch secret reached durable storage')
}

function redactSentinel(value, sentinel) {
  if (typeof value === 'string') return value.split(sentinel).join('[REDACTED]')
  if (Array.isArray(value)) return value.map((item) => redactSentinel(item, sentinel))
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactSentinel(item, sentinel)]),
    )
  }
  return value
}

async function readTree(rootDir) {
  let output = ''
  for (const entry of await readdir(rootDir, { withFileTypes: true })) {
    const path = join(rootDir, entry.name)
    if (entry.isDirectory()) output += await readTree(path)
    else output += await readFile(path, 'utf8').catch(() => '')
  }
  return output
}

function createControl(webTaskRuntimeDriver, disableExecution = false) {
  return createWebControlServer({
    controlStoreDir: controlRoot,
    disableExecution,
    ...(webTaskRuntimeDriver ? { webTaskRuntimeDriver } : {}),
    serviceSecurity: {
      schemaVersion: 'web-service-security/v1',
      authenticate: ({ authorization }) => authorization === `Bearer ${token}`
        ? {
            schemaVersion: 'service-principal/v1',
            actorId: 'm6-service-actor',
            authentication: 'bearer',
            scope,
          }
        : undefined,
    },
  })
}

function genericSnapshot(runId) {
  return snapshotWebTaskInput({
    schemaVersion: 'web-task-input/v1',
    runId,
    revision: 0,
    goal: {
      instruction: 'Compare the candidates and return a structured comparison.',
      scenario: 'comparison',
      metadata: {
        executionAdapter: 'caller-must-not-control-this',
        restartSafe: true,
      },
    },
    contextItems: [contextItem()],
    policy: {
      schemaVersion: 'task-policy/v1',
      defaultSensitiveAction: 'deny',
      rules: [],
    },
    contract: {
      schemaVersion: 'web-task-contract/v1',
      contractId: 'm6-comparison-contract',
      revision: 0,
      criteria: [{
        id: 'comparison-required',
        kind: 'artifact_present',
        description: 'A comparison artifact is required.',
        artifactKinds: ['comparison_table'],
        minCount: 1,
        schemaVersions: ['comparison-table/v1'],
      }],
    },
  })
}

function contextItem() {
  return {
    schemaVersion: 'context-item/v1',
    id: 'm6-comparison-context',
    kind: 'candidate_set',
    content: { candidates: ['A', 'B'] },
    origin: 'user',
    trust: 'user_authorized',
    instructionAuthority: 'advisory',
    sensitivity: 'internal',
    provenance: {
      capturedAt: '2026-07-20T00:00:00.000Z',
      parentContentIds: [],
    },
    allowedUses: ['prompt', 'artifact'],
    freshness: { validity: 'current', revision: 0 },
    retention: { scope: 'run', deleteWithSession: true },
    sanitization: {
      policyId: 'm6-service-fixture/v1',
      status: 'unchanged',
      redactedFields: [],
      instructionNeutralized: false,
      transformedFrom: [],
    },
    integrity: { immutable: true, digestVerified: true },
  }
}

function comparisonArtifact(runId, revision, artifactOwnerScope) {
  return {
    schemaVersion: 'artifact-ref/v1',
    id: 'm6-comparison-artifact',
    kind: 'comparison_table',
    payloadSchemaVersion: 'comparison-table/v1',
    mediaType: 'application/json',
    byteLength: 128,
    sha256: 'a'.repeat(64),
    createdAt: '2026-07-20T00:00:01.000Z',
    immutable: true,
    locator: 'opaque:m6-comparison-artifact',
    producer: { id: 'm6-fixture-driver', version: '1' },
    parentEvidenceIds: [],
    parentArtifactIds: [],
    origin: 'artifact',
    trust: 'derived_untrusted',
    sensitivity: 'internal',
    retention: { scope: 'run', deleteWithSession: true },
    ...(artifactOwnerScope ? { ownerScope: artifactOwnerScope } : {}),
    binding: { runId, revision },
    requiresMainWorkflowVerification: false,
    authoritativeCompletionEvidence: true,
    redaction: { status: 'not_required', policyId: 'm6-fixture/v1' },
    scanner: { status: 'clean', scannerId: 'm6-fixture-scanner/v1' },
  }
}

async function createGenericRun(base, idempotencyKey, input) {
  const response = await request(base, '/api/runs', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': idempotencyKey,
    },
    body: JSON.stringify({
      schemaVersion: 'run-client-create/v1',
      input,
    }),
  })
  const payload = await response.json()
  assert.equal(response.status, 201, JSON.stringify(payload))
  return payload
}

async function expectRejectedSnapshot(base, idempotencyKey, input) {
  const response = await request(base, '/api/runs', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': idempotencyKey,
    },
    body: JSON.stringify({
      schemaVersion: 'run-client-create/v1',
      input,
    }),
  })
  assert.equal(response.status, 400, JSON.stringify(await response.json()))
  assert.equal(driverRequests.length, 0, 'invalid snapshot reached the runtime driver')
}

function rehashSnapshot(snapshot) {
  snapshot.sha256 = snapshotDigest(snapshot)
}

function snapshotDigest(snapshot) {
  const { sha256: _sha256, ...unsigned } = snapshot
  return digestCanonicalJson(unsigned)
}

async function waitForState(base, runId, states) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const run = await json(base, `/api/runs/${encodeURIComponent(runId)}`)
    if (states.includes(run.state)) return run
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`Timed out waiting for ${runId}: ${states.join(', ')}`)
}

function request(base, path, options) {
  const headers = new Headers(options?.headers)
  headers.set('authorization', `Bearer ${token}`)
  return fetch(`${base}${path}`, { ...options, headers })
}

async function json(base, path, options) {
  const response = await request(base, path, options)
  const payload = await response.json()
  assert.equal(response.ok, true, `${path} failed: ${JSON.stringify(payload)}`)
  return payload
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
  assert(value && typeof value === 'object')
  return `http://127.0.0.1:${value.port}`
}
