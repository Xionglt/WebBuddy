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
  await recorder.transcript({
    type: 'workflow_evidence',
    turnId: 'turn-additive',
    evidence: {
      schemaVersion: 'workflow-evidence/v1',
      id: 'store-workflow-evidence',
      kind: 'workflow_state',
      summary: 'Workflow state evidence is append-only.',
      source: 'session-store-test',
      confidence: 'high',
      ts: '2026-06-28T00:00:01.000Z',
      phase: 'observing',
    },
  })
  await recorder.transcript({
    type: 'workflow_evaluation',
    turnId: 'turn-additive',
    evaluation: {
      state: { schemaVersion: 'workflow-state/v1', phase: 'observing' },
      evidenceIds: ['store-workflow-evidence'],
      missingCriteria: [],
      matchedCriteria: [],
      blockers: [],
    },
  })
  await recorder.transcript({
    type: 'context_compaction',
    turnId: 'turn-additive',
    summaryId: 'store-context-compaction',
    reason: 'session store additive entry check',
    tokenBudget: { compactRecommended: false, estimatedTokens: 64 },
    summary: {
      schemaVersion: 'compact-run-summary/v1',
      evidence: {
        total: 1,
        countsByKind: { workflow_state: 1 },
        recentKeyEvidence: [{ id: 'store-workflow-evidence', kind: 'workflow_state' }],
      },
    },
  })
  await recorder.event({ type: 'session_started', message: 'started' })
  await recorder.event({
    type: 'workflow_evidence_recorded',
    turnId: 'turn-additive',
    message: 'Workflow evidence recorded.',
    data: { evidenceId: 'store-workflow-evidence', kind: 'workflow_state' },
  })
  await recorder.event({
    type: 'workflow_evaluated',
    turnId: 'turn-additive',
    message: 'Workflow evaluated.',
    data: { evidenceIds: ['store-workflow-evidence'] },
  })
  await recorder.event({
    type: 'context_compacted',
    turnId: 'turn-additive',
    message: 'Context compacted.',
    data: { summaryId: 'store-context-compaction' },
  })
  await recorder.workflow({ schemaVersion: 'workflow-state/v1', phase: 'observing' })
  await recorder.updateStatus('completed')

  const saved = JSON.parse(readFileSync(join(session.outputDir, 'session.json'), 'utf8'))
  assert.equal(saved.status, 'completed')
  assert.equal(saved.sessionId, session.sessionId)
  assert(saved.completedAt, 'completedAt should be written for terminal status')

  const transcript = await readJsonLines(session.transcriptPath)
  assert.deepEqual(transcript.map((entry) => entry.type), [
    'user_message',
    'assistant_message',
    'workflow_evidence',
    'workflow_evaluation',
    'context_compaction',
  ])
  for (const entry of transcript) {
    assert.equal(entry.version, 1)
    assert.equal(entry.sessionId, session.sessionId)
    assert.equal(entry.runId, session.runId)
    assert(entry.entryId, 'transcript entries should have entry ids')
  }

  const events = await readJsonLines(session.eventsPath)
  assert(events.some((event) => event.type === 'session_created'), 'events should include session_created')
  assert(events.some((event) => event.type === 'session_started'), 'events should include session_started')
  assert(events.some((event) => event.type === 'workflow_evidence_recorded'), 'events should include workflow_evidence_recorded')
  assert(events.some((event) => event.type === 'workflow_evaluated'), 'events should include workflow_evaluated')
  assert(events.some((event) => event.type === 'context_compacted'), 'events should include context_compacted')

  const workflow = JSON.parse(readFileSync(session.workflowPath, 'utf8'))
  assert.equal(workflow.workflowState.phase, 'observing')

  const listed = await store.list({ status: 'completed' })
  assert.equal(listed.length, 1)
  assert.equal(listed[0].sessionId, session.sessionId)

  console.log('session-store-test: PASS')
} finally {
  rmSync(root, { recursive: true, force: true })
}
