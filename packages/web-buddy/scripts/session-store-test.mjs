#!/usr/bin/env node
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileSessionRecorder, FileSessionStore, readJsonLines } from '../dist/session/index.js'

const root = mkdtempSync(join(tmpdir(), 'mfa-session-store-'))

try {
  const store = new FileSessionStore({ rootDir: root })
  const session = await store.create({
    sessionId: 'store-test-session',
    runId: 'store-test-run',
    source: 'test',
    goal: 'Verify FileSessionStore.',
    mode: 'test',
    traceRunId: 'trace-store-test-run',
    now: '2026-06-28T00:00:00.000Z',
  })
  const recorder = new FileSessionRecorder(store, session)

  assert(existsSync(join(session.outputDir, 'session.json')), 'session.json should exist')
  assert(existsSync(session.transcriptPath), 'transcript.jsonl should exist')
  assert(existsSync(session.eventsPath), 'events.jsonl should exist')
  assert(existsSync(session.workflowPath), 'workflow.json should exist')

  await recorder.updateStatus('running')
  await recorder.transcript({ type: 'user_message', content: 'hello session' })
  await recorder.transcript({ type: 'assistant_message', content: { text: 'hello human' } })
  await recorder.event({ type: 'session_started', message: 'started' })
  await recorder.workflow({ schemaVersion: 'workflow-state/v1', phase: 'observing' })
  await recorder.updateStatus('completed')

  const saved = JSON.parse(readFileSync(join(session.outputDir, 'session.json'), 'utf8'))
  assert.equal(saved.status, 'completed')
  assert.equal(saved.sessionId, session.sessionId)
  assert(saved.completedAt, 'completedAt should be written for terminal status')

  const transcript = await readJsonLines(session.transcriptPath)
  assert.deepEqual(transcript.map((entry) => entry.type), ['user_message', 'assistant_message'])
  for (const entry of transcript) {
    assert.equal(entry.version, 1)
    assert.equal(entry.sessionId, session.sessionId)
    assert.equal(entry.runId, session.runId)
    assert(entry.entryId, 'transcript entries should have entry ids')
  }

  const events = await readJsonLines(session.eventsPath)
  assert(events.some((event) => event.type === 'session_created'), 'events should include session_created')
  assert(events.some((event) => event.type === 'session_started'), 'events should include session_started')

  const workflow = JSON.parse(readFileSync(session.workflowPath, 'utf8'))
  assert.equal(workflow.workflowState.phase, 'observing')

  const listed = await store.list({ status: 'completed' })
  assert.equal(listed.length, 1)
  assert.equal(listed[0].sessionId, session.sessionId)

  console.log('session-store-test: PASS')
} finally {
  rmSync(root, { recursive: true, force: true })
}
