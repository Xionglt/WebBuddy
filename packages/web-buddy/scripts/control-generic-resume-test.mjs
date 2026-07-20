#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  FileSessionRecorder,
  FileSessionStore,
} from '../dist/session/index.js'
import { snapshotWebTaskInput } from '../dist/task/contracts.js'
import { createWebControlServer } from '../dist/web/server.js'

const root = await mkdtemp(join(tmpdir(), 'web-buddy-generic-control-resume-'))
const traceRoot = join(root, 'trace')
const controlRoot = join(root, 'control')
const customControlRoot = join(root, 'custom-control')
const token = 'generic-control-resume-token'
const scope = {
  schemaVersion: 'service-scope/v1',
  kind: 'tenant',
  tenantId: 'generic-resume-tenant',
  userId: 'generic-resume-user',
}
const ownerScope = {
  schemaVersion: 'owner-scope/v1',
  tenantId: scope.tenantId,
  userId: scope.userId,
}
const previousTraceRoot = process.env.TRACE_OUT_DIR
process.env.TRACE_OUT_DIR = traceRoot

let control = createControl(controlRoot)
try {
  await listen(control.server)
  let base = address(control.server)

  let record = (await control.runService.create(
    serverAuthorizedSnapshot('generic-read-only-resume-run'),
    { idempotencyKey: 'generic-read-only-resume-create' },
  )).record
  assert.equal(record.inputSnapshot.goal.metadata.restartSafe, true)
  assert.equal(record.inputSnapshot.goal.metadata.recoveryMode, 'read_only_reobserve/v1')

  const sessionStore = new FileSessionStore({
    rootDir: join(traceRoot, 'sessions'),
  })
  const session = await sessionStore.create({
    sessionId: `control-${record.runId}-a1`,
    runId: record.runId,
    source: 'web',
    goal: record.inputSnapshot.goal.instruction,
    mode: 'generic-web-task',
    traceRunId: record.runId,
  })
  const recorder = new FileSessionRecorder(sessionStore, session)
  await recorder.transcript({
    type: 'user_message',
    content: 'Observe the frozen start URL without writing.',
  })
  await recorder.transcript({
    type: 'tool_call',
    toolCallId: 'unsettled-old-write',
    name: 'browser_click',
    args: { ref: 'e7' },
  })
  const transcriptBefore = await readFile(session.transcriptPath, 'utf8')

  record = await control.runService.start(
    record.runId,
    'generic-resume-start-attempt-1',
    { ownerScope },
  )
  record = await control.runService.attachSession(record.runId, {
    schemaVersion: 'session-ref/v1',
    provider: 'file-session-store',
    id: session.sessionId,
    runId: record.runId,
    attempt: record.attempt,
  }, 'generic-resume-attach-attempt-1', { ownerScope })

  const pause = await requestJson(base, `/api/runs/${encodeURIComponent(record.runId)}/pause`, {
    method: 'POST',
    headers: { 'idempotency-key': 'generic-resume-pause-attempt-1' },
    body: { expectedRevision: record.runRevision },
  })
  assert.equal(pause.status, 202)
  assert.equal(pause.body.state, 'pausing')
  record = await requireRun(control, record.runId)
  record = await control.runService.acknowledgePause(record.runId, {
    schemaVersion: 'safe-turn-boundary-ref/v1',
    runId: record.runId,
    runRevision: record.runRevision,
    attempt: record.attempt,
    turnId: 'generic-resume-safe-turn-attempt-1',
    actionSeq: 0,
    observedAt: new Date().toISOString(),
    sessionRef: record.sessionRef,
  }, 'generic-resume-pause-ack-attempt-1', { ownerScope })
  assert.equal(record.state, 'paused')

  const firstResume = await requestJson(base, `/api/runs/${encodeURIComponent(record.runId)}/resume`, {
    method: 'POST',
    headers: { 'idempotency-key': 'generic-resume-attempt-2' },
    body: { expectedRevision: record.runRevision },
  })
  assert.equal(firstResume.status, 202)
  assert.equal(firstResume.body.state, 'resuming')
  assert.equal(firstResume.body.revision, 1)
  assert.equal(firstResume.body.attempt, 2)
  record = await requireRun(control, record.runId)
  assert.equal(record.sessionRef.id, session.sessionId)
  assert.equal(record.sessionRef.attempt, 2)
  assert.equal(await readFile(session.transcriptPath, 'utf8'), transcriptBefore)

  const ineligible = await createGenericRun(
    base,
    'generic-form-resume-create',
    genericSnapshot('caller-generic-form', { formCriterion: true }),
  )
  const ineligibleRecord = await requireRun(control, ineligible.runId)
  assert.equal(ineligibleRecord.inputSnapshot.goal.metadata.restartSafe, false)
  assert.equal('recoveryMode' in ineligibleRecord.inputSnapshot.goal.metadata, false)

  const notOptedIn = await createGenericRun(
    base,
    'generic-read-only-without-opt-in',
    genericSnapshot('caller-generic-without-opt-in', { requestRestartSafe: false }),
  )
  const notOptedInRecord = await requireRun(control, notOptedIn.runId)
  assert.equal(notOptedInRecord.inputSnapshot.goal.metadata.restartSafe, false)
  assert.equal('recoveryMode' in notOptedInRecord.inputSnapshot.goal.metadata, false)

  const legacySpoof = await requestJson(base, '/api/runs', {
    method: 'POST',
    headers: { 'idempotency-key': 'legacy-raw-restart-safe-spoof' },
    body: {
      mode: 'raw',
      startUrl: 'https://example.test/',
      taskPrompt: 'Caller metadata must not make this write-capable run restart-safe.',
      restartSafe: true,
    },
  })
  assert.equal(legacySpoof.status, 201)
  const legacyRecord = await requireRun(control, legacySpoof.body.runId)
  assert.equal(legacyRecord.inputSnapshot.goal.metadata.restartSafe, false)

  const runId = record.runId
  await control.close()
  control = createControl(controlRoot)
  await control.recoverStartupRuns()
  record = await requireRun(control, runId)
  assert.equal(record.state, 'recoverable')
  assert.equal(record.runRevision, 1)
  assert.equal(record.attempt, 2)
  await listen(control.server)
  base = address(control.server)

  const secondResume = await requestJson(base, `/api/runs/${encodeURIComponent(runId)}/resume`, {
    method: 'POST',
    headers: { 'idempotency-key': 'generic-resume-attempt-3' },
    body: { expectedRevision: record.runRevision },
  })
  assert.equal(secondResume.status, 202)
  assert.equal(secondResume.body.state, 'resuming')
  assert.equal(secondResume.body.revision, 2)
  assert.equal(secondResume.body.attempt, 3)
  record = await requireRun(control, runId)
  assert.equal(record.sessionRef.id, session.sessionId)
  assert.equal(record.sessionRef.attempt, 3)
  assert.equal(await readFile(session.transcriptPath, 'utf8'), transcriptBefore)

  await control.close()
  control = createControl(customControlRoot, {
    webTaskRuntimeDriver: {
      async execute() {
        throw new Error('custom driver must not execute in this fixture')
      },
    },
  })
  await listen(control.server)
  base = address(control.server)
  const custom = await createGenericRun(
    base,
    'custom-driver-restart-safe-spoof',
    genericSnapshot('caller-custom-driver'),
  )
  const customRecord = await requireRun(control, custom.runId)
  assert.equal(customRecord.inputSnapshot.goal.metadata.restartSafe, false)
  assert.equal('recoveryMode' in customRecord.inputSnapshot.goal.metadata, false)
  const customResume = await requestJson(
    base,
    `/api/runs/${encodeURIComponent(custom.runId)}/resume`,
    {
      method: 'POST',
      headers: { 'idempotency-key': 'custom-driver-resume-rejected' },
      body: { expectedRevision: customRecord.runRevision },
    },
  )
  assert.equal(customResume.status, 409)
  assert.equal(customResume.body.error, 'generic_resume_requires_quiescent_run')

  const forgedSnapshot = serverAuthorizedSnapshot('custom-driver-forged-safe-record')
  let forged = (await control.runService.create(
    forgedSnapshot,
    { idempotencyKey: 'custom-driver-forged-create' },
  )).record
  const forgedSessionStore = new FileSessionStore({
    rootDir: join(traceRoot, 'sessions'),
  })
  const forgedSession = await forgedSessionStore.create({
    sessionId: 'custom-driver-forged-session',
    runId: forged.runId,
    source: 'web',
    goal: forged.inputSnapshot.goal.instruction,
    mode: 'generic-web-task',
    traceRunId: forged.runId,
  })
  forged = await control.runService.start(
    forged.runId,
    'custom-driver-forged-start',
    { ownerScope },
  )
  forged = await control.runService.attachSession(forged.runId, {
    schemaVersion: 'session-ref/v1',
    provider: 'file-session-store',
    id: forgedSession.sessionId,
    runId: forged.runId,
    attempt: forged.attempt,
  }, 'custom-driver-forged-attach', { ownerScope })
  forged = await control.runService.requestPause(
    forged.runId,
    'custom-driver-forged-pause',
    { ownerScope },
  )
  forged = await control.runService.acknowledgePause(forged.runId, {
    schemaVersion: 'safe-turn-boundary-ref/v1',
    runId: forged.runId,
    runRevision: forged.runRevision,
    attempt: forged.attempt,
    turnId: 'custom-driver-forged-safe-turn',
    actionSeq: 0,
    observedAt: new Date().toISOString(),
    sessionRef: forged.sessionRef,
  }, 'custom-driver-forged-pause-ack', { ownerScope })
  const forgedResume = await requestJson(
    base,
    `/api/runs/${encodeURIComponent(forged.runId)}/resume`,
    {
      method: 'POST',
      headers: { 'idempotency-key': 'custom-driver-forged-resume' },
      body: { expectedRevision: forged.runRevision },
    },
  )
  assert.equal(forgedResume.status, 409)
  assert.equal(forgedResume.body.error, 'generic_resume_requires_read_only_runtime')
  const unchangedForged = await requireRun(control, forged.runId)
  assert.equal(unchangedForged.state, 'paused')
  assert.equal(unchangedForged.runRevision, forged.runRevision)
  assert.equal(unchangedForged.attempt, forged.attempt)

  console.log('control-generic-resume-test: PASS')
} finally {
  await control.close().catch(() => {})
  if (previousTraceRoot === undefined) delete process.env.TRACE_OUT_DIR
  else process.env.TRACE_OUT_DIR = previousTraceRoot
  await rm(root, { recursive: true, force: true })
}

function createControl(controlStoreDir, extra = {}) {
  return createWebControlServer({
    controlStoreDir,
    disableExecution: true,
    ...extra,
    serviceSecurity: {
      schemaVersion: 'web-service-security/v1',
      authenticate: ({ authorization }) => authorization === `Bearer ${token}`
        ? {
            schemaVersion: 'service-principal/v1',
            actorId: 'generic-resume-test-actor',
            authentication: 'bearer',
            scope,
          }
        : undefined,
    },
  })
}

function genericSnapshot(runId, options = {}) {
  const criteria = options.formCriterion
    ? [{
        id: 'draft-form',
        kind: 'form_state',
        description: 'Drafting changes browser state and must not be restart-safe.',
        requireFullAudit: true,
        requiredFieldCoverage: 1,
        allowVisibleErrors: false,
        requireDraftOnly: true,
      }]
    : [{
        id: 'fresh-page-evidence',
        kind: 'evidence_present',
        description: 'A fresh observation from the main runtime is required.',
        evidenceKinds: ['page'],
        minCount: 1,
        allowedAuthorities: ['main_runtime'],
      }]
  const denyRules = [{
    id: 'deny-browser-writes',
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
      instruction: 'Observe the frozen page and report evidence without writing.',
      scenario: 'research',
      metadata: {
        restartSafe: options.requestRestartSafe !== false,
        recoveryMode: 'caller-controlled-marker-must-be-replaced',
      },
    },
    startUrl: 'https://example.test/',
    contract: {
      schemaVersion: 'web-task-contract/v1',
      contractId: options.formCriterion
        ? 'generic-form-not-restart-safe'
        : 'generic-read-only-restart-safe',
      revision: 0,
      criteria,
      sensitiveActions: denyRules,
    },
    policy: {
      schemaVersion: 'task-policy/v1',
      defaultSensitiveAction: 'deny',
      rules: denyRules,
    },
  })
}

function serverAuthorizedSnapshot(runId) {
  const input = genericSnapshot(runId)
  return snapshotWebTaskInput({
    schemaVersion: 'web-task-input/v1',
    runId,
    revision: input.revision,
    goal: {
      ...input.goal,
      metadata: {
        ...input.goal.metadata,
        executionAdapter: 'generic_web_task',
        restartSafe: true,
        recoveryMode: 'read_only_reobserve/v1',
      },
    },
    startUrl: input.startUrl,
    contract: input.contract,
    policy: input.policy,
    ownerScope,
  })
}

async function createGenericRun(base, idempotencyKey, input) {
  const response = await requestJson(base, '/api/runs', {
    method: 'POST',
    headers: { 'idempotency-key': idempotencyKey },
    body: {
      schemaVersion: 'run-client-create/v1',
      input,
    },
  })
  assert.equal(response.status, 201, JSON.stringify(response.body))
  return response.body
}

async function requireRun(controlValue, runId) {
  const record = await controlValue.runService.get(runId, { ownerScope })
  assert(record, `missing Run ${runId}`)
  return record
}

async function requestJson(base, path, options = {}) {
  const headers = {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
    ...(options.headers ?? {}),
  }
  const response = await fetch(`${base}${path}`, {
    method: options.method ?? 'GET',
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  })
  return {
    status: response.status,
    body: await response.json(),
  }
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
}

function address(server) {
  const value = server.address()
  assert(value && typeof value === 'object')
  return `http://127.0.0.1:${value.port}`
}
