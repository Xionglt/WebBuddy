#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWebControlServer } from '../dist/web/server.js'

const rootDir = await mkdtemp(join(tmpdir(), 'web-buddy-conversation-api-'))
const principals = {
  a: {
    token: 'conversation-api-token-a',
    actorId: 'conversation-api-actor-a',
    tenantId: 'conversation-api-tenant-a',
    userId: 'conversation-api-user-a',
  },
  b: {
    token: 'conversation-api-token-b',
    actorId: 'conversation-api-actor-b',
    tenantId: 'conversation-api-tenant-b',
    userId: 'conversation-api-user-b',
  },
}
const control = createWebControlServer({
  controlStoreDir: rootDir,
  disableExecution: true,
  serviceSecurity: {
    schemaVersion: 'web-service-security/v1',
    authenticate: ({ authorization }) => {
      const principal = Object.values(principals).find(({ token }) => authorization === `Bearer ${token}`)
      return principal ? {
        schemaVersion: 'service-principal/v1',
        actorId: principal.actorId,
        authentication: 'bearer',
        scope: {
          schemaVersion: 'service-scope/v1',
          kind: 'tenant',
          tenantId: principal.tenantId,
          userId: principal.userId,
        },
      } : undefined
    },
  },
})

try {
  await new Promise((resolve, reject) => {
    control.server.once('error', reject)
    control.server.listen(0, '127.0.0.1', resolve)
  })
  const address = control.server.address()
  assert(address && typeof address === 'object')
  const base = `http://127.0.0.1:${address.port}`

  const createBody = {
    schemaVersion: 'conversation-create/v1',
    goal: 'Complete this job application.',
    startUrl: 'https://example.test/jobs/42',
    headless: true,
    idempotencyKey: 'conversation-create-main',
  }
  const createdResponse = await request(base, principals.a, '/api/conversations', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': createBody.idempotencyKey },
    body: JSON.stringify(createBody),
  })
  assert.equal(createdResponse.status, 201)
  const created = await createdResponse.json()
  assert.equal(created.schemaVersion, 'public-conversation/v1')
  assert.equal(created.goal, createBody.goal)
  assert.equal(created.revision, 0)
  assert.deepEqual(created.turns, [])

  const replayedCreate = await json(base, principals.a, '/api/conversations', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': createBody.idempotencyKey },
    body: JSON.stringify(createBody),
  }, 201)
  assert.equal(replayedCreate.conversationId, created.conversationId)
  const conflictingCreate = await request(base, principals.a, '/api/conversations', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': createBody.idempotencyKey },
    body: JSON.stringify({ ...createBody, goal: 'Different goal under the same key.' }),
  })
  assert.equal(conflictingCreate.status, 409)
  assert.equal((await conflictingCreate.json()).error, 'IDEMPOTENCY_CONFLICT')

  const listA = await json(base, principals.a, '/api/conversations?limit=25')
  assert.equal(listA.schemaVersion, 'public-conversation-list/v1')
  assert.equal(listA.items.length, 1)
  assert.equal(listA.items[0].conversationId, created.conversationId)
  assert.equal(listA.items[0].turnCount, 0)
  const listB = await json(base, principals.b, '/api/conversations?limit=25')
  assert.deepEqual(listB.items, [])

  const firstTurnBody = {
    schemaVersion: 'conversation-turn-create/v1',
    message: 'Research the role requirements first.',
    expectedRevision: 0,
    idempotencyKey: 'conversation-turn-main-1',
  }
  const firstTurnConversation = await json(
    base,
    principals.a,
    `/api/conversations/${encodeURIComponent(created.conversationId)}/turns`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': firstTurnBody.idempotencyKey },
      body: JSON.stringify(firstTurnBody),
    },
    201,
  )
  assert.equal(firstTurnConversation.revision, 1)
  assert.equal(firstTurnConversation.turns.length, 1)
  assert.equal(firstTurnConversation.turns[0].userMessage, firstTurnBody.message)
  assert.equal(firstTurnConversation.turns[0].run.state, 'queued')
  const firstRunId = firstTurnConversation.turns[0].run.runId

  const replayedTurn = await json(
    base,
    principals.a,
    `/api/conversations/${encodeURIComponent(created.conversationId)}/turns`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': firstTurnBody.idempotencyKey },
      body: JSON.stringify(firstTurnBody),
    },
    201,
  )
  assert.equal(replayedTurn.revision, 1)
  assert.equal(replayedTurn.turns[0].run.runId, firstRunId)

  const busyTurn = await request(
    base,
    principals.a,
    `/api/conversations/${encodeURIComponent(created.conversationId)}/turns`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'conversation-turn-busy' },
      body: JSON.stringify({
        schemaVersion: 'conversation-turn-create/v1',
        message: 'Start another Run before the first one settles.',
        expectedRevision: 1,
        idempotencyKey: 'conversation-turn-busy',
      }),
    },
  )
  assert.equal(busyTurn.status, 409)
  assert.equal((await busyTurn.json()).error, 'conversation_has_active_run')

  const ownerScopeA = ownerScope(principals.a)
  await control.runService.start(firstRunId, 'conversation-first-start', { ownerScope: ownerScopeA })
  await control.runService.acceptResult({
    runId: firstRunId,
    runRevision: 0,
    attempt: 1,
    terminalState: 'completed',
    reason: 'The role requires TypeScript, browser automation, and evaluation experience.',
    artifactRefs: [artifactRef(firstRunId, ownerScopeA)],
    idempotencyKey: 'conversation-first-complete',
    ownerScope: ownerScopeA,
  })

  const secondTurnBody = {
    schemaVersion: 'conversation-turn-create/v1',
    message: 'Compare those requirements with my background.',
    expectedRevision: 1,
    idempotencyKey: 'conversation-turn-main-2',
  }
  const secondTurnConversation = await json(
    base,
    principals.a,
    `/api/conversations/${encodeURIComponent(created.conversationId)}/turns`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': secondTurnBody.idempotencyKey },
      body: JSON.stringify(secondTurnBody),
    },
    201,
  )
  assert.equal(secondTurnConversation.revision, 2)
  assert.equal(secondTurnConversation.turns.length, 2)
  const secondRunId = secondTurnConversation.turns[1].run.runId
  assert.notEqual(secondRunId, firstRunId, 'every Conversation Turn must create a distinct Run')
  assert.equal(
    secondTurnConversation.turns[0].run.summary,
    'The role requires TypeScript, browser automation, and evaluation experience.',
  )
  assert.equal(secondTurnConversation.turns[0].run.artifacts[0].kind, 'research_report')

  const secondRun = await control.runService.get(secondRunId, { ownerScope: ownerScopeA })
  assert(secondRun)
  assert.equal(
    secondRun.inputSnapshot.goal.instruction,
    '持续目标：Complete this job application.\n\n本轮请求：Compare those requirements with my background.',
  )
  assert.deepEqual(
    secondRun.inputSnapshot.contextItems.map((item) => [item.kind, item.origin, item.trust, item.instructionAuthority]),
    [
      ['conversation_user_history', 'user', 'user_authorized', 'user_goal'],
      ['conversation_run_history', 'derived', 'non_authoritative', 'data_only'],
    ],
  )
  assert.equal(JSON.stringify(secondRun.inputSnapshot.contextItems).includes('artifact-first'), true)
  assert.equal(JSON.stringify(secondRun.inputSnapshot.contextItems).includes('locator'), false)

  const staleTurn = await request(
    base,
    principals.a,
    `/api/conversations/${encodeURIComponent(created.conversationId)}/turns`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'conversation-turn-stale' },
      body: JSON.stringify({
        schemaVersion: 'conversation-turn-create/v1',
        message: 'Use a stale revision.',
        expectedRevision: 1,
        idempotencyKey: 'conversation-turn-stale',
      }),
    },
  )
  assert.equal(staleTurn.status, 409)
  assert.equal((await staleTurn.json()).error, 'REVISION_CONFLICT')

  const detail = await json(
    base,
    principals.a,
    `/api/conversations/${encodeURIComponent(created.conversationId)}`,
  )
  assert.equal(detail.turns.length, 2)
  assert.equal(detail.turns[1].run.runId, secondRunId)

  for (const [method, suffix, body] of [
    ['GET', '', undefined],
    ['POST', '/turns', {
      schemaVersion: 'conversation-turn-create/v1',
      message: 'Foreign append.',
      expectedRevision: 2,
      idempotencyKey: 'conversation-turn-foreign',
    }],
  ]) {
    const foreign = await request(
      base,
      principals.b,
      `/api/conversations/${encodeURIComponent(created.conversationId)}${suffix}`,
      {
        method,
        ...(body ? {
          headers: { 'content-type': 'application/json', 'idempotency-key': body.idempotencyKey },
          body: JSON.stringify(body),
        } : {}),
      },
    )
    assert.equal(foreign.status, 404)
    assert.equal((await foreign.json()).error, 'resource_not_visible')
  }

  const privateTarget = await request(base, principals.a, '/api/conversations', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'conversation-private' },
    body: JSON.stringify({
      schemaVersion: 'conversation-create/v1',
      goal: 'Inspect a private target.',
      startUrl: 'http://127.0.0.1:8080/private',
      headless: true,
      idempotencyKey: 'conversation-private',
    }),
  })
  assert.equal(privateTarget.status, 400)

  const oversized = await request(base, principals.a, '/api/conversations', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'conversation-oversized' },
    body: JSON.stringify({
      schemaVersion: 'conversation-create/v1',
      goal: 'x'.repeat(8193),
      startUrl: 'https://example.test/oversized',
      headless: true,
      idempotencyKey: 'conversation-oversized',
    }),
  })
  assert.equal(oversized.status, 400)
  assert.equal((await oversized.json()).error, 'INVALID_RECORD')

  console.log('conversation web API tests passed')
} finally {
  await control.close().catch(() => {})
  await rm(rootDir, { recursive: true, force: true })
}

function ownerScope(principal) {
  return {
    schemaVersion: 'owner-scope/v1',
    tenantId: principal.tenantId,
    userId: principal.userId,
  }
}

function artifactRef(runId, scope) {
  return {
    schemaVersion: 'artifact-ref/v1',
    id: 'artifact-first',
    kind: 'research_report',
    payloadSchemaVersion: 'research-report/v1',
    mediaType: 'application/json',
    byteLength: 2,
    sha256: 'a'.repeat(64),
    createdAt: '2026-07-28T10:30:00.000Z',
    immutable: true,
    locator: 'artifact:first',
    producer: { id: 'conversation-api-test', version: '1' },
    parentEvidenceIds: [],
    parentArtifactIds: [],
    origin: 'artifact',
    trust: 'non_authoritative',
    sensitivity: 'internal',
    retention: { scope: 'run', deleteWithSession: true },
    ownerScope: scope,
    binding: { runId, revision: 0 },
    requiresMainWorkflowVerification: true,
    authoritativeCompletionEvidence: false,
    redaction: { status: 'not_required', policyId: 'conversation-api-test' },
    scanner: { status: 'clean', scannerId: 'conversation-api-test' },
  }
}

function request(base, principal, path, options) {
  const headers = new Headers(options?.headers)
  headers.set('authorization', `Bearer ${principal.token}`)
  return fetch(`${base}${path}`, { ...options, headers })
}

async function json(base, principal, path, options, expectedStatus = 200) {
  const response = await request(base, principal, path, options)
  const payload = await response.json()
  assert.equal(response.status, expectedStatus, `${path} failed: ${JSON.stringify(payload)}`)
  return payload
}
