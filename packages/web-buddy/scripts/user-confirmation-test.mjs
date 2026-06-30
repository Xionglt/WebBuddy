#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createUserConfirmation, FileSessionRecorder, FileSessionStore, readJsonLines } from '../dist/session/index.js'

const ts = '2026-06-30T12:00:00.000Z'
const metadata = {
  ui: { surface: 'task_cockpit' },
  tags: ['manual-review'],
}

const confirmation = createUserConfirmation({
  sessionId: 'session-1',
  runId: 'run-1',
  turnId: 'turn-1',
  confirmedBy: 'user',
  scope: 'completion',
  message: '  I reviewed the application and confirm the workflow is complete.\nPlease close it.  ',
  workflowPhase: 'done',
  ts,
  metadata,
})

assert.equal(confirmation.schemaVersion, 'user-confirmation/v1')
assert.match(confirmation.id, /^user_confirmation_[0-9a-f-]+$/)
assert.equal(confirmation.sessionId, 'session-1')
assert.equal(confirmation.runId, 'run-1')
assert.equal(confirmation.turnId, 'turn-1')
assert.equal(confirmation.confirmedBy, 'user')
assert.equal(confirmation.scope, 'completion')
assert.equal(confirmation.message, 'I reviewed the application and confirm the workflow is complete.\nPlease close it.')
assert.equal(confirmation.ts, ts)
assert.equal(confirmation.workflowPhase, 'done')
assert.deepEqual(confirmation.metadata, metadata)

assert.equal(confirmation.evidence.schemaVersion, 'workflow-evidence/v1')
assert.match(confirmation.evidence.id, /^evid_user_confirm_[0-9a-f-]+$/)
assert.equal(confirmation.evidence.kind, 'user_confirm')
assert.equal(confirmation.evidence.source, 'user_confirmation')
assert.equal(confirmation.evidence.confidence, 'high')
assert.equal(confirmation.evidence.ts, ts)
assert.equal(confirmation.evidence.phase, 'done')
assert.equal(confirmation.evidence.sessionId, 'session-1')
assert.equal(confirmation.evidence.runId, 'run-1')
assert.equal(confirmation.evidence.turnId, 'turn-1')
assert.equal(
  confirmation.evidence.summary,
  'I reviewed the application and confirm the workflow is complete. Please close it.',
)
assert.deepEqual(confirmation.evidence.data, {
  confirmationId: confirmation.id,
  confirmedBy: 'user',
  scope: 'completion',
  messageSummary: 'I reviewed the application and confirm the workflow is complete. Please close it.',
})
assert.deepEqual(confirmation.evidence.metadata, metadata)

metadata.ui.surface = 'mutated'
metadata.tags.push('mutated')
assert.equal(confirmation.metadata.ui.surface, 'task_cockpit')
assert.deepEqual(confirmation.metadata.tags, ['manual-review'])
assert.equal(confirmation.evidence.metadata.ui.surface, 'task_cockpit')
assert.deepEqual(confirmation.evidence.metadata.tags, ['manual-review'])

const controlCharConfirmation = createUserConfirmation({
  sessionId: 'session-2',
  runId: 'run-2',
  confirmedBy: 'user',
  scope: 'completion',
  message: `Confirmed\u0000with\tunsafe\nspacing. ${'x'.repeat(300)}`,
  ts,
})

assert.equal(controlCharConfirmation.evidence.summary.includes('\u0000'), false)
assert.equal(controlCharConfirmation.evidence.summary.includes('\n'), false)
assert.equal(controlCharConfirmation.evidence.summary.endsWith('...'), true)
assert(controlCharConfirmation.evidence.summary.length <= 240)

assert.throws(
  () =>
    createUserConfirmation({
      sessionId: 'session-1',
      runId: 'run-1',
      confirmedBy: 'assistant',
      scope: 'completion',
      message: 'The model says this is done.',
    }),
  /confirmed by user/i,
)

assert.throws(
  () =>
    createUserConfirmation({
      sessionId: 'session-1',
      runId: 'run-1',
      confirmedBy: 'user',
      scope: 'tool_result',
      message: 'Wrong scope.',
    }),
  /scope must be completion/i,
)

assert.throws(
  () =>
    createUserConfirmation({
      sessionId: 'session-1',
      runId: 'run-1',
      confirmedBy: 'user',
      scope: 'completion',
      message: '   ',
    }),
  /message must be a non-empty string/i,
)

const root = mkdtempSync(join(tmpdir(), 'mfa-user-confirmation-'))
try {
  const store = new FileSessionStore({ rootDir: root })
  const session = await store.create({
    sessionId: 'user-confirmation-session',
    runId: 'user-confirmation-run',
    source: 'test',
    goal: 'Verify user confirmation transcript and event entries.',
    now: ts,
  })
  const recorder = new FileSessionRecorder(store, session)

  await recorder.transcript({
    type: 'user_confirmation',
    turnId: 'turn-1',
    confirmation,
  })
  await recorder.transcript({
    type: 'workflow_evidence',
    turnId: 'turn-1',
    evidence: confirmation.evidence,
  })
  await recorder.event({
    type: 'user_confirmed',
    turnId: 'turn-1',
    message: 'User confirmed workflow completion.',
    data: {
      confirmationId: confirmation.id,
      evidenceId: confirmation.evidence.id,
      workflowPhase: confirmation.workflowPhase,
    },
  })

  const transcript = await readJsonLines(session.transcriptPath)
  assert.deepEqual(transcript.map((entry) => entry.type), ['user_confirmation', 'workflow_evidence'])
  assert.equal(transcript[0].confirmation.id, confirmation.id)
  assert.equal(transcript[1].evidence.kind, 'user_confirm')

  const events = await readJsonLines(session.eventsPath)
  const userConfirmedEvent = events.find((event) => event.type === 'user_confirmed')
  assert(userConfirmedEvent, 'events should accept additive user_confirmed event')
  assert.equal(userConfirmedEvent.data.confirmationId, confirmation.id)
  assert.equal(userConfirmedEvent.data.evidenceId, confirmation.evidence.id)
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log('user-confirmation-test: PASS')
