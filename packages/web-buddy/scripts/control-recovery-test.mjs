#!/usr/bin/env node
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  ApprovalService,
  FileApprovalStore,
  FileRunStore,
  RecoveryService,
  RunService,
} from '../dist/control/index.js'
import {
  FileSessionRecorder,
  FileSessionStore,
  restoreSessionState,
  sanitizeRestoredMessagesForResume,
} from '../dist/session/index.js'
import { snapshotWebTaskInput } from '../dist/task/contracts.js'

const rootDir = await mkdtemp(join(tmpdir(), 'web-buddy-control-recovery-'))
try {
  const controlRoot = join(rootDir, 'control')
  const sessionRoot = join(rootDir, 'sessions')
  const sessions = new FileSessionStore({ rootDir: sessionRoot })
  const runServiceA = new RunService(new FileRunStore({ rootDir: controlRoot }))
  const approvalServiceA = new ApprovalService(new FileApprovalStore({ rootDir: controlRoot }))

  const safeRunId = 'recovery-safe-read-only'
  const oldSession = await sessions.create({
    sessionId: 'old-session-recovery-c4',
    runId: safeRunId,
    source: 'web',
    goal: 'Research a fixture without write actions.',
    mode: 'demo-research',
  })
  const recorder = new FileSessionRecorder(sessions, oldSession)
  await recorder.transcript({ type: 'user_message', content: 'Research the current page.' })
  await recorder.transcript({ type: 'assistant_message', content: 'I will inspect the current page.' })
  await recorder.transcript({
    type: 'tool_call',
    toolCallId: 'old-unsettled-observation',
    name: 'browser_snapshot',
    args: { includeText: true },
  })
  await recorder.updateStatus('running')

  await runServiceA.create(snapshot(safeRunId, true, {
    schemaVersion: 'session-ref/v1',
    provider: 'file-session-store',
    id: oldSession.sessionId,
    runId: safeRunId,
    attempt: 1,
  }), { idempotencyKey: 'create-safe-c4' })
  await runServiceA.start(safeRunId, 'start-safe-c4')

  const actionBinding = {
    schemaVersion: 'action-binding/v1',
    contractId: 'recovery-c4',
    contractRevision: 0,
    runId: safeRunId,
    sessionRef: {
      schemaVersion: 'session-ref/v1',
      provider: 'file-session-store',
      id: oldSession.sessionId,
      runId: safeRunId,
      attempt: 1,
    },
    actionId: 'old-submit-c4',
    toolName: 'browser_click',
    argsSha256: 'c'.repeat(64),
    sourceContentIds: ['old-page-c4'],
    sourceSensitiveClasses: [],
    sourceOrigin: 'https://fixture.example',
    destinationOrigin: 'https://fixture.example',
    actionSeq: 4,
    expiresAt: '2030-01-01T00:00:00.000Z',
  }
  await approvalServiceA.enqueue({
    approvalId: 'old-approval-c4',
    runId: safeRunId,
    runRevision: 0,
    attempt: 1,
    status: 'pending',
    actionBinding,
    allowedDecisions: ['approved', 'denied'],
    sessionRef: actionBinding.sessionRef,
    requestedAt: new Date().toISOString(),
    expiresAt: '2030-01-01T00:00:00.000Z',
  }, 'enqueue-old-approval-c4')

  const unsafeRunId = 'recovery-unsafe-write'
  const unsafeSession = await sessions.create({
    sessionId: 'unsafe-session-recovery-c4',
    runId: unsafeRunId,
    source: 'web',
    goal: 'Fill a form.',
    mode: 'raw',
  })
  await runServiceA.create(snapshot(unsafeRunId, false, {
    schemaVersion: 'session-ref/v1',
    provider: 'file-session-store',
    id: unsafeSession.sessionId,
    runId: unsafeRunId,
    attempt: 1,
  }), { idempotencyKey: 'create-unsafe-c4' })
  await runServiceA.start(unsafeRunId, 'start-unsafe-c4')

  const missingSessionRunId = 'recovery-missing-session'
  await runServiceA.create(snapshot(missingSessionRunId, true, {
    schemaVersion: 'session-ref/v1',
    provider: 'file-session-store',
    id: 'missing-session-c4',
    runId: missingSessionRunId,
    attempt: 1,
  }), { idempotencyKey: 'create-missing-c4' })
  await runServiceA.start(missingSessionRunId, 'start-missing-c4')

  const corruptSessionRunId = 'recovery-corrupt-session'
  const corruptSession = await sessions.create({
    sessionId: 'corrupt-session-recovery-c4',
    runId: corruptSessionRunId,
    source: 'web',
    goal: 'This record has a future schema version.',
    mode: 'demo-research',
  })
  await writeFile(
    join(corruptSession.outputDir, 'session.json'),
    `${JSON.stringify({ ...corruptSession, version: 999 }, null, 2)}\n`,
  )
  await runServiceA.create(snapshot(corruptSessionRunId, true, {
    schemaVersion: 'session-ref/v1',
    provider: 'file-session-store',
    id: corruptSession.sessionId,
    runId: corruptSessionRunId,
    attempt: 1,
  }), { idempotencyKey: 'create-corrupt-c4' })
  await runServiceA.start(corruptSessionRunId, 'start-corrupt-c4')

  const cancellingRunId = 'recovery-cancelling'
  await runServiceA.create(snapshot(cancellingRunId, true), { idempotencyKey: 'create-cancelling-c4' })
  await runServiceA.start(cancellingRunId, 'start-cancelling-c4')
  await runServiceA.requestCancel(cancellingRunId, 'request-cancel-c4')

  // Simulate a fresh process by constructing entirely new Store/Service instances.
  const fileRunStoreB = new FileRunStore({ rootDir: controlRoot })
  const runServiceB = new RunService(fileRunStoreB)
  const approvalServiceB = new ApprovalService(new FileApprovalStore({ rootDir: controlRoot }))
  const recovery = new RecoveryService(runServiceB, approvalServiceB, {
    canRestoreSession: async (record) => Boolean(record.sessionRef && await sessions.get(record.sessionRef.id)),
  })
  const decisions = await recovery.recoverStartupRuns()
  assert.equal(decisions.length, 5)
  assert.equal((await runServiceB.get(safeRunId))?.state, 'recoverable')
  assert.equal((await runServiceB.get(unsafeRunId))?.state, 'failed')
  assert.equal((await runServiceB.get(missingSessionRunId))?.state, 'failed')
  assert.equal(
    (await runServiceB.get(corruptSessionRunId))?.state,
    'failed',
    'one unknown session version fails only its own run',
  )
  assert.equal((await runServiceB.get(cancellingRunId))?.state, 'failed')
  assert.equal(
    (await approvalServiceB.get('old-approval-c4'))?.status,
    'cancelled',
    'restart invalidates pending approvals from the abandoned attempt',
  )

  const safeEvents = (await runServiceB.events(safeRunId)).items
  assert.deepEqual(
    safeEvents.slice(-2).map((event) => event.eventType),
    ['state_transitioned', 'recovery_classified'],
  )
  assert.equal(
    safeEvents.some((event) => event.data?.replayedAction === true),
    false,
    'startup classification never reports or performs a replay',
  )

  const tenantOwnerScope = {
    schemaVersion: 'owner-scope/v1',
    tenantId: 'recovery-tenant',
    userId: 'recovery-user',
  }
  const tenantRunId = 'recovery-tenant-running'
  await runServiceB.create(
    snapshot(tenantRunId, false, undefined, tenantOwnerScope),
    { idempotencyKey: 'create-tenant-recovery-c4' },
  )
  await runServiceB.start(
    tenantRunId,
    'start-tenant-recovery-c4',
    { ownerScope: tenantOwnerScope },
  )
  assert.equal(
    (await recovery.recoverStartupRuns()).length,
    0,
    'unscoped recovery is not a wildcard over tenant runs',
  )
  assert.deepEqual(await fileRunStoreB.listOwnerScopes(), [tenantOwnerScope])
  const tenantDecisions = await recovery.recoverStartupRuns({ ownerScope: tenantOwnerScope })
  assert.equal(tenantDecisions.length, 1)
  assert.equal(
    (await runServiceB.get(tenantRunId, { ownerScope: tenantOwnerScope }))?.state,
    'failed',
  )

  const restored = await restoreSessionState({ store: sessions, sessionId: oldSession.sessionId })
  assert.equal(restored.session.runId, safeRunId)
  assert.equal(restored.transcriptCount, 3)
  const safeMessages = sanitizeRestoredMessagesForResume(restored.restoredMessages)
  assert.equal(
    safeMessages.some((message) => 'tool_calls' in message),
    false,
    'an unsettled old tool call is context only and is never reconstructed as an executable tool call',
  )

  const resuming = await runServiceB.resume(safeRunId, 'resume-safe-c4')
  assert.equal(resuming.runRevision, 1)
  assert.equal(resuming.attempt, 2)
  assert.equal(resuming.sessionRef, undefined, 'new attempt cannot reuse the old attempt binding')
  await runServiceB.transition(safeRunId, { to: 'running', idempotencyKey: 'restart-safe-c4' })

  const late = await runServiceB.acceptResult({
    runId: safeRunId,
    runRevision: 0,
    attempt: 1,
    terminalState: 'completed',
    idempotencyKey: 'late-safe-c4',
  })
  assert.equal(late.accepted, false)
  assert.equal(late.record.state, 'running')
  assert.equal((await runServiceB.events(safeRunId)).items.at(-1)?.eventType, 'late_result_rejected')

  const current = await runServiceB.acceptResult({
    runId: safeRunId,
    runRevision: 1,
    attempt: 2,
    terminalState: 'completed',
    reason: 'Fresh attempt re-observed and completed.',
    idempotencyKey: 'current-safe-c4',
  })
  assert.equal(current.accepted, true)
  assert.equal(current.record.state, 'completed')

  // Exercise the real server bootstrap in a second OS process.
  const childRunId = 'recovery-child-process'
  const traceRoot = join(rootDir, 'child-trace')
  const childSessions = new FileSessionStore({ rootDir: join(traceRoot, 'sessions') })
  const childSession = await childSessions.create({
    sessionId: 'child-session-recovery-c4',
    runId: childRunId,
    source: 'web',
    goal: 'Read-only child-process recovery.',
    mode: 'demo-research',
  })
  await runServiceB.create(snapshot(childRunId, true, {
    schemaVersion: 'session-ref/v1',
    provider: 'file-session-store',
    id: childSession.sessionId,
    runId: childRunId,
    attempt: 1,
  }), { idempotencyKey: 'create-child-c4' })
  await runServiceB.start(childRunId, 'start-child-c4')
  const futureTranscriptRunId = 'recovery-child-future-transcript'
  const futureTranscriptSession = await childSessions.create({
    sessionId: 'child-session-future-transcript-c4',
    runId: futureTranscriptRunId,
    source: 'web',
    goal: 'This session contains an unsupported future transcript entry.',
    mode: 'demo-research',
  })
  await writeFile(
    futureTranscriptSession.transcriptPath,
    `${JSON.stringify({
      version: 99,
      sessionId: futureTranscriptSession.sessionId,
      runId: futureTranscriptRunId,
      entryId: 'future-transcript-entry-c4',
      ts: '2026-07-17T00:00:00.000Z',
      type: 'user_message',
      content: 'Future transcript payload.',
    })}\n`,
  )
  await runServiceB.create(snapshot(futureTranscriptRunId, true, {
    schemaVersion: 'session-ref/v1',
    provider: 'file-session-store',
    id: futureTranscriptSession.sessionId,
    runId: futureTranscriptRunId,
    attempt: 1,
  }), { idempotencyKey: 'create-future-transcript-c4' })
  await runServiceB.start(futureTranscriptRunId, 'start-future-transcript-c4')
  const tenantChildRunId = 'recovery-child-process-tenant'
  await runServiceB.create(
    snapshot(tenantChildRunId, false, undefined, tenantOwnerScope),
    { idempotencyKey: 'create-child-tenant-c4' },
  )
  await runServiceB.start(
    tenantChildRunId,
    'start-child-tenant-c4',
    { ownerScope: tenantOwnerScope },
  )
  const port = await availablePort()
  await bootAndStopServer({
    PORT: String(port),
    TRACE_OUT_DIR: traceRoot,
    WEB_BUDDY_CONTROL_STORE_DIR: controlRoot,
  })
  const runServiceC = new RunService(new FileRunStore({ rootDir: controlRoot }))
  assert.equal(
    (await runServiceC.get(childRunId))?.state,
    'recoverable',
    'real server bootstrap classifies an abandoned running record from the prior process',
  )
  const futureTranscriptRun = await runServiceC.get(futureTranscriptRunId)
  assert.equal(
    futureTranscriptRun?.state,
    'failed',
    'future transcript versions fail only their run during real server recovery',
  )
  assert.match(futureTranscriptRun?.reason ?? '', /failed validation/i)
  assert.equal(
    (await runServiceC.get(tenantChildRunId, { ownerScope: tenantOwnerScope }))?.state,
    'failed',
    'real server bootstrap classifies abandoned tenant runs within their exact scope',
  )

  console.log('control recovery tests passed')
} finally {
  await rm(rootDir, { recursive: true, force: true })
}

function snapshot(runId, restartSafe, sessionRef, ownerScope) {
  return snapshotWebTaskInput({
    schemaVersion: 'web-task-input/v1',
    runId,
    revision: 0,
    goal: {
      instruction: restartSafe ? 'Research only.' : 'Potentially write to a form.',
      metadata: {
        executionAdapter: 'recruiting_compat',
        mode: restartSafe ? 'demo-research' : 'raw',
        restartSafe,
      },
    },
    startUrl: 'https://fixture.example/',
    ...(sessionRef ? { sessionRef } : {}),
    ...(ownerScope ? { ownerScope } : {}),
    contract: {
      schemaVersion: 'web-task-contract/v1',
      contractId: 'recovery-c4',
      revision: 0,
      criteria: [{
        id: 'main-observation',
        kind: 'evidence_present',
        description: 'Observe the current page.',
        evidenceKinds: ['page_observation'],
        minCount: 1,
        allowedAuthorities: ['main_runtime'],
      }],
    },
  })
}

function availablePort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      assert(address && typeof address === 'object')
      server.close((error) => error ? reject(error) : resolve(address.port))
    })
  })
}

function bootAndStopServer(extraEnv) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['dist/web/server.js'], {
      cwd: process.cwd(),
      env: { ...process.env, ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    const timeout = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`Timed out waiting for child server startup.\n${output}`))
    }, 10_000)
    const onData = (chunk) => {
      output += chunk.toString()
      if (!output.includes('Web Buddy Harness UI')) return
      child.stdout.off('data', onData)
      child.kill('SIGTERM')
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', (chunk) => { output += chunk.toString() })
    child.once('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.once('exit', (code, signal) => {
      clearTimeout(timeout)
      if (code === 0 || signal === 'SIGTERM') resolve()
      else reject(new Error(`Child server exited ${code ?? signal}.\n${output}`))
    })
  })
}
