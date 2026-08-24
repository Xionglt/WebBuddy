#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createWebControlServer } from '../dist/web/server.js'
import { createPendingContinuation } from '../dist/control/index.js'
import { FileSessionStore, restoreSessionState } from '../dist/session/index.js'

const rootDir = await mkdtemp(join(tmpdir(), 'web-buddy-control-api-'))
const previousTraceOutDir = process.env.TRACE_OUT_DIR
process.env.TRACE_OUT_DIR = rootDir
const token = 'control-web-api-test-token'
const scope = {
  schemaVersion: 'service-scope/v1',
  kind: 'tenant',
  tenantId: 'control-api-tenant',
  userId: 'control-api-user',
}
const ownerScope = {
  schemaVersion: 'owner-scope/v1',
  tenantId: scope.tenantId,
  userId: scope.userId,
}
const control = createWebControlServer({
  controlStoreDir: rootDir,
  disableExecution: true,
  serviceSecurity: {
    schemaVersion: 'web-service-security/v1',
    authenticate: ({ authorization }) => authorization === `Bearer ${token}`
      ? {
          schemaVersion: 'service-principal/v1',
          actorId: 'control-api-actor',
          authentication: 'bearer',
          scope,
        }
      : undefined,
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

  const createdResponse = await request(base, '/api/runs', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'api-create-c3' },
    body: JSON.stringify({
      mode: 'raw',
      startUrl: 'https://example.test/',
      taskPrompt: 'Inspect a fixture without submitting.',
    }),
  })
  assert.equal(createdResponse.status, 201)
  const created = await createdResponse.json()
  assert.equal(created.state, 'queued')
  const replayedCreate = await request(base, '/api/runs', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'api-create-c3' },
    body: JSON.stringify({
      mode: 'raw',
      startUrl: 'https://example.test/',
      taskPrompt: 'Inspect a fixture without submitting.',
    }),
  })
  assert.equal(replayedCreate.status, 201)
  assert.equal((await replayedCreate.json()).runId, created.runId, 'create idempotency returns the original run')
  const conflictingCreate = await request(base, '/api/runs', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'api-create-c3' },
    body: JSON.stringify({
      mode: 'raw',
      startUrl: 'https://different.example.test/',
      taskPrompt: 'Different input under the same key.',
    }),
  })
  assert.equal(conflictingCreate.status, 409)
  assert.equal((await conflictingCreate.json()).error, 'IDEMPOTENCY_CONFLICT')

  const listed = await json(base, '/api/runs')
  assert.equal(listed.items.length, 1)
  assert.equal(listed.items[0].runId, created.runId)
  assert.equal(Array.isArray(listed), false, 'run list has a forward-compatible page envelope')

  const detail = await json(base, `/api/runs/${encodeURIComponent(created.runId)}`)
  assert.equal(detail.schemaVersion, 'public-run/v1')
  assert.equal(detail.runId, created.runId)
  const events = await json(base, `/api/runs/${encodeURIComponent(created.runId)}/events`)
  assert.equal(events.items[0].type, 'run_created')

  const continuationCreateResponse = await request(base, '/api/run', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      mode: 'raw',
      startUrl: 'https://example.test/continuation',
      taskPrompt: 'Prepare a draft and stop before submission.',
    }),
  })
  assert.equal(continuationCreateResponse.status, 201)
  const continuationCreated = await continuationCreateResponse.json()
  await control.runService.start(
    continuationCreated.runId,
    'continuation-api-start-c3',
    { ownerScope },
  )
  const continuationSessionStore = new FileSessionStore({
    rootDir: join(rootDir, 'sessions'),
  })
  const continuationSession = await continuationSessionStore.create({
    sessionId: `session-${continuationCreated.runId}`,
    runId: continuationCreated.runId,
    source: 'test',
    goal: 'Prepare a draft and stop before submission.',
    mode: 'continuation-api-test',
  })
  let continuationRun = await control.runService.get(
    continuationCreated.runId,
    { ownerScope },
  )
  continuationRun = await control.runService.attachSession(
    continuationCreated.runId,
    {
      schemaVersion: 'session-ref/v1',
      provider: 'file-session-store',
      id: continuationSession.sessionId,
      runId: continuationCreated.runId,
      attempt: continuationRun.attempt,
    },
    'continuation-api-session-c3',
    { ownerScope },
  )
  const pendingContinuation = createPendingContinuation({
    runId: continuationRun.runId,
    runRevision: continuationRun.runRevision,
    attempt: continuationRun.attempt,
    sessionId: continuationSession.sessionId,
    goal: continuationRun.inputSnapshot.goal.instruction,
    goalRevision: continuationRun.inputSnapshot.contract.revision,
    contract: continuationRun.inputSnapshot.contract,
    field: 'company_name',
    question: 'Which company name should be used in the draft?',
    currentUrl: 'https://example.test/continuation',
  })
  await control.runService.requestContinuation(
    continuationRun.runId,
    pendingContinuation,
    'continuation-api-request-c3',
    { ownerScope },
  )
  const continuationDetail = await json(
    base,
    `/api/runs/${encodeURIComponent(continuationRun.runId)}`,
  )
  assert.equal(continuationDetail.state, 'blocked_on_human')
  assert.equal(continuationDetail.pendingContinuation.status, 'pending')
  assert.equal(continuationDetail.pendingContinuation.question.field, 'company_name')
  assert.equal('answer' in continuationDetail.pendingContinuation, false)

  const continuationResolveRequest = {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': 'continuation-api-answer-c3',
    },
    body: JSON.stringify({
      expectedRevision: continuationRun.runRevision,
      answer: 'Example Labs',
      intentPatch: 'Use it only in the draft; do not submit.',
    }),
  }
  const continuationResolvedResponse = await request(
    base,
    `/api/runs/${encodeURIComponent(continuationRun.runId)}/continuations/${encodeURIComponent(pendingContinuation.continuationId)}/resolve`,
    continuationResolveRequest,
  )
  assert.equal(continuationResolvedResponse.status, 202)
  const continuationResolved = await continuationResolvedResponse.json()
  assert.equal(continuationResolved.state, 'resuming')
  assert.equal(continuationResolved.revision, continuationRun.runRevision + 1)
  assert.equal(continuationResolved.attempt, continuationRun.attempt + 1)
  assert.equal(continuationResolved.pendingContinuation, undefined)
  const continuedRun = await control.runService.get(continuationRun.runId, { ownerScope })
  assert.equal(continuedRun.lastResumeCapsule?.answeredQuestion.answer, 'Example Labs')
  assert.equal(continuedRun.lastResumeCapsule?.priorApprovalsInvalid, true)
  const restoredContinuationSession = await restoreSessionState({
    session: continuationSession,
  })
  assert.equal(
    restoredContinuationSession.latestResumeCapsule?.continuationId,
    pendingContinuation.continuationId,
  )
  assert.match(
    restoredContinuationSession.restoredMessages.at(-1)?.content,
    /current page observation is authoritative/i,
  )

  const replayedContinuation = await request(
    base,
    `/api/runs/${encodeURIComponent(continuationRun.runId)}/continuations/${encodeURIComponent(pendingContinuation.continuationId)}/resolve`,
    continuationResolveRequest,
  )
  assert.equal(replayedContinuation.status, 200)
  assert.equal((await replayedContinuation.json()).revision, continuationRun.runRevision + 1)
  const conflictingContinuation = await request(
    base,
    `/api/runs/${encodeURIComponent(continuationRun.runId)}/continuations/${encodeURIComponent(pendingContinuation.continuationId)}/resolve`,
    {
      ...continuationResolveRequest,
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'continuation-api-conflict-c3',
      },
      body: JSON.stringify({
        expectedRevision: continuationRun.runRevision,
        answer: 'Different Company',
      }),
    },
  )
  assert.equal(conflictingContinuation.status, 409)
  const continuationMetrics = await json(base, '/api/continuations/metrics')
  assert.equal(continuationMetrics.schemaVersion, 'continuation-metrics/v1')
  assert.equal(continuationMetrics.requested, 1)
  assert.equal(continuationMetrics.answered, 1)
  assert.equal(continuationMetrics.resumed, 1)
  assert.equal(continuationMetrics.coldResumed, 1)
  assert.equal(continuationMetrics.activeAfterResume, 1)
  assert.equal(continuationMetrics.answerRate, 1)
  assert.equal(continuationMetrics.resumeRate, 1)

  const continuationRecoveryDecisions = await control.recoveryService.recoverStartupRuns({ ownerScope })
  assert.equal(continuationRecoveryDecisions.length, 1)
  assert.equal(continuationRecoveryDecisions[0].runId, continuationRun.runId)
  assert.equal(continuationRecoveryDecisions[0].toState, 'recoverable')
  const recoveredContinuationResponse = await request(
    base,
    `/api/runs/${encodeURIComponent(continuationRun.runId)}/resume`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'continuation-api-restart-resume-c3',
      },
      body: JSON.stringify({ expectedRevision: continuationRun.runRevision + 1 }),
    },
  )
  assert.equal(recoveredContinuationResponse.status, 202)
  const recoveredContinuation = await recoveredContinuationResponse.json()
  assert.equal(recoveredContinuation.state, 'resuming')
  assert.equal(recoveredContinuation.revision, continuationRun.runRevision + 2)
  assert.equal(recoveredContinuation.attempt, continuationRun.attempt + 2)
  const recoveredContinuationRecord = await control.runService.get(
    continuationRun.runId,
    { ownerScope },
  )
  assert.equal(
    recoveredContinuationRecord.lastResumeCapsule?.target.runRevision,
    continuationRun.runRevision + 2,
  )
  assert.equal(
    recoveredContinuationRecord.lastResumeCapsule?.target.attempt,
    continuationRun.attempt + 2,
  )
  assert.equal(recoveredContinuationRecord.sessionRef?.attempt, continuationRun.attempt + 2)

  await control.runService.start(created.runId, 'api-start-c3', { ownerScope })
  const pausedRequest = await json(base, `/api/runs/${encodeURIComponent(created.runId)}/pause`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'api-pause-c3' },
    body: JSON.stringify({ expectedRevision: created.revision }),
  })
  assert.equal(pausedRequest.state, 'pausing')
  const resumedWithoutCheckpoint = await request(base, `/api/runs/${encodeURIComponent(created.runId)}/resume`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'api-resume-c3' },
    body: JSON.stringify({ expectedRevision: created.revision }),
  })
  assert.equal(resumedWithoutCheckpoint.status, 409)
  assert.equal((await resumedWithoutCheckpoint.json()).error, 'resume_requires_safe_session')

  const trace = await json(base, `/api/runs/${encodeURIComponent(created.runId)}/trace`)
  assert.equal(trace.runId, created.runId)
  assert.equal(trace.state, 'pausing')
  assert.equal('resources' in trace, false)
  const artifacts = await json(base, `/api/runs/${encodeURIComponent(created.runId)}/artifacts`)
  assert.equal(artifacts.runId, created.runId)
  assert.equal(Array.isArray(artifacts.items), true)

  const cancelCreateResponse = await request(base, '/api/run', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      mode: 'demo-research',
      startUrl: 'https://example.test/research',
      taskPrompt: 'Research only.',
    }),
  })
  assert.equal(cancelCreateResponse.status, 201, 'legacy create route delegates to durable service')
  const cancelCreated = await cancelCreateResponse.json()
  const cancelRequest = {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'api-cancel-c3' },
    body: JSON.stringify({ expectedRevision: cancelCreated.revision }),
  }
  const cancelled = await json(base, `/api/runs/${encodeURIComponent(cancelCreated.runId)}/cancel`, cancelRequest)
  assert.equal(cancelled.state, 'cancelled')
  const cancelledAgain = await json(base, `/api/runs/${encodeURIComponent(cancelCreated.runId)}/cancel`, cancelRequest)
  assert.equal(cancelledAgain.state, 'cancelled', 'cancel endpoint is idempotent')

  const coldCreateResponse = await request(base, '/api/run', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      mode: 'demo-research',
      startUrl: 'https://example.test/cold-research',
      taskPrompt: 'Pause this read-only run at a safe boundary.',
    }),
  })
  assert.equal(coldCreateResponse.status, 201)
  const coldCreated = await coldCreateResponse.json()
  await control.runService.start(coldCreated.runId, 'cold-start-c3', { ownerScope })
  await control.runService.requestPause(coldCreated.runId, 'cold-pause-request-c3', { ownerScope })
  const coldPausing = await control.runService.get(coldCreated.runId, { ownerScope })
  await control.runService.acknowledgePause(coldCreated.runId, {
    schemaVersion: 'safe-turn-boundary-ref/v1',
    runId: coldCreated.runId,
    runRevision: coldPausing.runRevision,
    attempt: coldPausing.attempt,
    turnId: 'cold-safe-turn-c3',
    actionSeq: 1,
    observedAt: new Date().toISOString(),
  }, 'cold-pause-ack-c3', { ownerScope })
  const coldApprovalId = 'approval-cold-c3'
  const coldActionBinding = {
    schemaVersion: 'action-binding/v1',
    contractId: 'web-control-plane-legacy-adapter',
    contractRevision: 0,
    runId: coldCreated.runId,
    actionId: 'cold-submit-c3',
    toolName: 'browser_click',
    argsSha256: 'c'.repeat(64),
    sourceContentIds: ['cold-page-c3'],
    sourceSensitiveClasses: [],
    sourceOrigin: 'https://example.test',
    destinationOrigin: 'https://example.test',
    actionSeq: 1,
    expiresAt: '2030-01-01T00:00:00.000Z',
  }
  const coldRequestedAt = new Date().toISOString()
  await control.approvalService.enqueue({
    approvalId: coldApprovalId,
    runId: coldCreated.runId,
    runRevision: 0,
    attempt: 1,
    status: 'pending',
    ownerScope,
    actionBinding: coldActionBinding,
    allowedDecisions: ['approved', 'denied'],
    requestedAt: coldRequestedAt,
    expiresAt: '2030-01-01T00:00:00.000Z',
  }, 'enqueue-cold-c3')
  await control.runService.setPendingApproval(
    coldCreated.runId,
    coldApprovalId,
    true,
    'attach-cold-approval-c3',
    { ownerScope },
  )
  const coldCancelRequest = {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'api-cold-cancel-c3' },
    body: JSON.stringify({ expectedRevision: coldCreated.revision }),
  }
  const coldCancelled = await json(
    base,
    `/api/runs/${encodeURIComponent(coldCreated.runId)}/cancel`,
    coldCancelRequest,
  )
  assert.equal(coldCancelled.state, 'cancelled', 'a quiescent paused run must cancel atomically')
  const coldCancelledAgain = await json(
    base,
    `/api/runs/${encodeURIComponent(coldCreated.runId)}/cancel`,
    coldCancelRequest,
  )
  assert.equal(coldCancelledAgain.state, 'cancelled')
  assert.equal(
    (await control.approvalService.get(coldApprovalId, { ownerScope })).status,
    'cancelled',
    'cold cancel must invalidate pending approvals before returning',
  )
  assert.deepEqual(
    (await control.runService.get(coldCreated.runId, { ownerScope })).pendingApprovalIds,
    [],
  )

  const raceCreateResponse = await request(base, '/api/run', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      mode: 'demo-research',
      startUrl: 'https://example.test/race-research',
      taskPrompt: 'Exercise a stale control request.',
    }),
  })
  assert.equal(raceCreateResponse.status, 201)
  const raceCreated = await raceCreateResponse.json()
  await control.runService.start(raceCreated.runId, 'race-start-c3', { ownerScope })
  await control.runService.requestPause(raceCreated.runId, 'race-pause-c3', { ownerScope })
  const racePausing = await control.runService.get(raceCreated.runId, { ownerScope })
  await control.runService.acknowledgePause(raceCreated.runId, {
    schemaVersion: 'safe-turn-boundary-ref/v1',
    runId: raceCreated.runId,
    runRevision: racePausing.runRevision,
    attempt: racePausing.attempt,
    turnId: 'race-safe-turn-c3',
    actionSeq: 1,
    observedAt: new Date().toISOString(),
  }, 'race-pause-ack-c3', { ownerScope })

  const originalGet = control.runService.get.bind(control.runService)
  let injectNewEpoch = true
  control.runService.get = async (runId, query) => {
    const stale = await originalGet(runId, query)
    if (injectNewEpoch && runId === raceCreated.runId) {
      injectNewEpoch = false
      const resumed = await control.runService.resume(
        runId,
        'race-concurrent-resume-c3',
        query,
      )
      await control.runService.transition(runId, {
        to: 'running',
        idempotencyKey: 'race-concurrent-start-c3',
        expectedRunRevision: resumed.runRevision,
        expectedAttempt: resumed.attempt,
      }, query)
      const requestedAt = new Date().toISOString()
      await control.approvalService.enqueue({
        approvalId: 'race-new-epoch-approval-c3',
        runId,
        runRevision: resumed.runRevision,
        attempt: resumed.attempt,
        status: 'pending',
        ownerScope,
        actionBinding: {
          schemaVersion: 'action-binding/v1',
          contractId: 'web-control-plane-legacy-adapter',
          contractRevision: raceCreated.revision,
          runId,
          actionId: 'race-new-epoch-action-c3',
          toolName: 'browser_click',
          argsSha256: 'd'.repeat(64),
          sourceContentIds: ['race-new-page-c3'],
          sourceSensitiveClasses: [],
          sourceOrigin: 'https://example.test',
          destinationOrigin: 'https://example.test',
          actionSeq: 1,
          expiresAt: '2030-01-01T00:00:00.000Z',
        },
        allowedDecisions: ['approved', 'denied'],
        requestedAt,
        expiresAt: '2030-01-01T00:00:00.000Z',
      }, 'race-new-epoch-approval-enqueue-c3')
    }
    return stale
  }
  let staleCancelResponse
  try {
    staleCancelResponse = await request(base, `/api/runs/${encodeURIComponent(raceCreated.runId)}/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'api-stale-cancel-c3' },
      body: JSON.stringify({ expectedRevision: raceCreated.revision }),
    })
  } finally {
    control.runService.get = originalGet
  }
  assert.equal(staleCancelResponse.status, 409, 'stale cancel must fail its atomic epoch fence')
  const raceCurrent = await control.runService.get(raceCreated.runId, { ownerScope })
  assert.equal(raceCurrent.runRevision, 1)
  assert.equal(raceCurrent.attempt, 2)
  assert.equal(raceCurrent.state, 'running', 'stale cancel must not mutate the new attempt')
  assert.equal(
    (await control.approvalService.get('race-new-epoch-approval-c3', { ownerScope })).status,
    'pending',
    'stale cancel must not cancel an approval from the new attempt',
  )
  await control.approvalService.cancelPendingForRun(
    raceCreated.runId,
    'Race fixture cleanup.',
    'race-new-epoch-cleanup-c3',
    { ownerScope },
    { expectedRunRevision: 1, expectedAttempt: 2 },
  )

  const actionBinding = {
    schemaVersion: 'action-binding/v1',
    contractId: 'web-control-plane-legacy-adapter',
    contractRevision: 0,
    runId: created.runId,
    actionId: 'publish-api-c3',
    toolName: 'browser_click',
    argsSha256: 'b'.repeat(64),
    sourceContentIds: ['page-api-c3'],
    sourceSensitiveClasses: [],
    sourceOrigin: 'https://example.test',
    destinationOrigin: 'https://example.test',
    actionSeq: 2,
    expiresAt: '2030-01-01T00:00:00.000Z',
  }
  const requestedAt = new Date().toISOString()
  const approvalId = 'approval-api-c3'
  await control.approvalService.enqueue({
    approvalId,
    runId: created.runId,
    runRevision: 0,
    attempt: 1,
    status: 'pending',
    ownerScope,
    actionBinding,
    allowedDecisions: ['approved', 'denied'],
    requestedAt,
    expiresAt: '2030-01-01T00:00:00.000Z',
  }, 'enqueue-api-c3')

  const inbox = await json(base, '/api/approvals')
  assert.equal(inbox.items.length, 1)
  assert.equal(inbox.items[0].action.destinationOrigin, 'https://example.test')
  const resolveRequest = {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'resolve-api-c3' },
    body: JSON.stringify({ decision: 'denied', expectedRevision: 0 }),
  }
  const resolved = await json(base, `/api/approvals/${approvalId}/resolve`, resolveRequest)
  assert.equal(resolved.status, 'denied')
  const replayedResolution = await json(
    base,
    `/api/approvals/${approvalId}/resolve`,
    resolveRequest,
  )
  assert.equal(replayedResolution.status, 'denied', 'approval resolve retry is idempotent')
  const reused = await request(base, `/api/approvals/${approvalId}/resolve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'resolve-api-c3-second' },
    body: JSON.stringify({ decision: 'approved', expectedRevision: 0, expectedRecordRevision: 1 }),
  })
  assert.equal(reused.status, 409, 'resolved approval cannot cross a second action')

  const html = await (await request(base, '/')).text()
  assert.match(html, /data-contract="continuation-inbox"/)
  assert.match(html, /id="continuationSuccessRate"/)
  assert.match(html, /data-contract="approval-inbox"/)
  assert.match(html, /id="artifactLink"/)
  assert.match(html, /id="stopBtn"/)
  assert.match(html, /id="serviceToken"/)
  assert.match(html, /authorization.*Bearer/)
  assert.doesNotMatch(html, /new EventSource\(/, 'authenticated SSE must not put tokens in query parameters')

  console.log('control web API tests passed')
} finally {
  await control.close().catch(() => {})
  if (previousTraceOutDir === undefined) delete process.env.TRACE_OUT_DIR
  else process.env.TRACE_OUT_DIR = previousTraceOutDir
  await rm(rootDir, { recursive: true, force: true })
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
