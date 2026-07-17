#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createWebControlServer } from '../dist/web/server.js'

const rootDir = await mkdtemp(join(tmpdir(), 'web-buddy-control-api-'))
const control = createWebControlServer({ controlStoreDir: rootDir, disableExecution: true })
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
  assert.equal(detail.run.inputSnapshot.schemaVersion, 'web-task-input-snapshot/v1')
  assert.equal(detail.events[0].eventType, 'run_created')

  await control.runService.start(created.runId, 'api-start-c3')
  const pausedRequest = await json(base, `/api/runs/${encodeURIComponent(created.runId)}/pause`, { method: 'POST' })
  assert.equal(pausedRequest.run.state, 'pausing')
  const resumedWithoutCheckpoint = await request(base, `/api/runs/${encodeURIComponent(created.runId)}/resume`, { method: 'POST' })
  assert.equal(resumedWithoutCheckpoint.status, 409)
  assert.equal((await resumedWithoutCheckpoint.json()).error, 'resume_requires_safe_session')

  const trace = await json(base, `/api/runs/${encodeURIComponent(created.runId)}/trace`)
  assert.equal(trace.id, created.runId)
  assert.equal(trace.state, 'pausing')
  assert.equal(Array.isArray(trace.resources), true)
  const artifacts = await json(base, `/api/runs/${encodeURIComponent(created.runId)}/artifacts`)
  assert.equal(artifacts.runId, created.runId)
  assert.equal(Array.isArray(artifacts.discovered), true)

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
  const cancelled = await json(base, `/api/runs/${encodeURIComponent(cancelCreated.runId)}/cancel`, { method: 'POST' })
  assert.equal(cancelled.run.state, 'cancelled')
  const cancelledAgain = await json(base, `/api/runs/${encodeURIComponent(cancelCreated.runId)}/cancel`, { method: 'POST' })
  assert.equal(cancelledAgain.run.state, 'cancelled', 'cancel endpoint is idempotent')

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
    actionBinding,
    allowedDecisions: ['approved', 'denied'],
    requestedAt,
    expiresAt: '2030-01-01T00:00:00.000Z',
  }, 'enqueue-api-c3')

  const inbox = await json(base, '/api/approvals')
  assert.equal(inbox.items.length, 1)
  assert.equal(inbox.items[0].actionBinding.destinationOrigin, 'https://example.test')
  const resolved = await json(base, `/api/approvals/${approvalId}/resolve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'resolve-api-c3' },
    body: JSON.stringify({ decision: 'denied', expectedRecordRevision: 0 }),
  })
  assert.equal(resolved.approval.status, 'denied')
  const reused = await request(base, `/api/approvals/${approvalId}/resolve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ decision: 'approved', expectedRecordRevision: 1 }),
  })
  assert.equal(reused.status, 409, 'resolved approval cannot cross a second action')

  const html = await (await request(base, '/')).text()
  assert.match(html, /Approval Inbox/)
  assert.match(html, /Artifacts API/)
  assert.match(html, /Pause/)

  console.log('control web API tests passed')
} finally {
  await control.close().catch(() => {})
  await rm(rootDir, { recursive: true, force: true })
}

function request(base, path, options) {
  return fetch(`${base}${path}`, options)
}

async function json(base, path, options) {
  const response = await request(base, path, options)
  const payload = await response.json()
  assert.equal(response.ok, true, `${path} failed: ${JSON.stringify(payload)}`)
  return payload
}
