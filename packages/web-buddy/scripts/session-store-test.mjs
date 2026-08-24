#!/usr/bin/env node
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileSessionRecorder, FileSessionStore, migrateTranscriptEntry, readJsonLines } from '../dist/session/index.js'

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
  const completionGateDecision = {
    schemaVersion: 'completion-gate-decision/v1',
    action: 'allow',
    recommendedStatus: 'completed',
    reason: 'Workflow evidence is sufficient for completion.',
    missingCriteria: [],
    blockers: [],
    workflowPhase: 'in_target_flow',
    evidenceIds: ['store-workflow-evidence'],
  }

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
      phase: 'in_target_flow',
    },
  })
  await recorder.transcript({
    type: 'workflow_evaluation',
    turnId: 'turn-additive',
    evaluation: {
      state: { schemaVersion: 'workflow-state/v1', phase: 'in_target_flow' },
      evidenceIds: ['store-workflow-evidence'],
      missingCriteria: [],
      matchedCriteria: [],
      blockers: [],
    },
  })
  await recorder.transcript({
    type: 'completion_gate',
    turnId: 'turn-additive',
    decision: completionGateDecision,
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
    type: 'completion_gate_evaluated',
    turnId: 'turn-additive',
    message: 'Completion gate evaluated.',
    data: completionGateDecision,
  })
  await recorder.event({
    type: 'context_compacted',
    turnId: 'turn-additive',
    message: 'Context compacted.',
    data: { summaryId: 'store-context-compaction' },
  })
  await recorder.workflow({ schemaVersion: 'workflow-state/v1', phase: 'in_target_flow' })
  await recorder.updateStatus('completed')

  const saved = JSON.parse(readFileSync(join(session.outputDir, 'session.json'), 'utf8'))
  assert.equal(saved.status, 'completed')
  assert.equal(saved.sessionId, session.sessionId)
  assert(saved.completedAt, 'completedAt should be written for terminal status')
  const legacySaved = { ...saved }
  delete legacySaved.version
  writeFileSync(join(session.outputDir, 'session.json'), `${JSON.stringify(legacySaved, null, 2)}\n`)
  const migratedSession = await store.get(session.sessionId)
  assert.equal(migratedSession?.version, 1, 'FileSessionStore should migrate legacy session files without version')
  writeFileSync(join(session.outputDir, 'session.json'), `${JSON.stringify(saved, null, 2)}\n`)

  const transcript = await readJsonLines(session.transcriptPath)
  assert.deepEqual(transcript.map((entry) => entry.type), [
    'user_message',
    'assistant_message',
    'workflow_evidence',
    'workflow_evaluation',
    'completion_gate',
    'context_compaction',
  ])
  for (const entry of transcript) {
    assert.equal(entry.version, 1)
    assert.equal(entry.sessionId, session.sessionId)
    assert.equal(entry.runId, session.runId)
    assert(entry.entryId, 'transcript entries should have entry ids')
  }
  const completionGate = transcript.find((entry) => entry.type === 'completion_gate')
  assert(completionGate, 'transcript should include completion_gate')
  assert.equal(completionGate.decision.action, 'allow')
  assert.equal(completionGate.decision.recommendedStatus, 'completed')
  assert.deepEqual(completionGate.decision.evidenceIds, ['store-workflow-evidence'])
  const legacyEntry = { ...transcript[0] }
  delete legacyEntry.version
  assert.equal(migrateTranscriptEntry(legacyEntry).version, 1, 'transcript migration should default legacy entries to v1')

  const events = await readJsonLines(session.eventsPath)
  assert(events.some((event) => event.type === 'session_created'), 'events should include session_created')
  assert(events.some((event) => event.type === 'session_started'), 'events should include session_started')
  assert(events.some((event) => event.type === 'workflow_evidence_recorded'), 'events should include workflow_evidence_recorded')
  assert(events.some((event) => event.type === 'workflow_evaluated'), 'events should include workflow_evaluated')
  const completionGateEvent = events.find((event) => event.type === 'completion_gate_evaluated')
  assert(completionGateEvent, 'events should include completion_gate_evaluated')
  assert.equal(completionGateEvent.data.action, 'allow')
  assert.equal(completionGateEvent.data.recommendedStatus, 'completed')
  assert.deepEqual(completionGateEvent.data.evidenceIds, ['store-workflow-evidence'])
  assert(events.some((event) => event.type === 'context_compacted'), 'events should include context_compacted')

  const workflow = JSON.parse(readFileSync(session.workflowPath, 'utf8'))
  assert.equal(workflow.workflowState.phase, 'in_target_flow')

  const listed = await store.list({ status: 'completed' })
  assert.equal(listed.length, 1)
  assert.equal(listed[0].sessionId, session.sessionId)

  const frozenFiles = {
    session: readFileSync(join(session.outputDir, 'session.json'), 'utf8'),
    transcript: readFileSync(session.transcriptPath, 'utf8'),
    events: readFileSync(session.eventsPath, 'utf8'),
    workflow: readFileSync(session.workflowPath, 'utf8'),
  }
  await assert.rejects(
    store.create({
      sessionId: session.sessionId,
      runId: session.runId,
      source: 'test',
      goal: 'This duplicate create must not overwrite durable state.',
      mode: 'test',
      now: '2026-06-28T01:00:00.000Z',
    }),
    /already exists/,
    'creating an existing durable session must fail closed',
  )
  assert.deepEqual({
    session: readFileSync(join(session.outputDir, 'session.json'), 'utf8'),
    transcript: readFileSync(session.transcriptPath, 'utf8'),
    events: readFileSync(session.eventsPath, 'utf8'),
    workflow: readFileSync(session.workflowPath, 'utf8'),
  }, frozenFiles, 'a duplicate create must not overwrite transcript or workflow state')

  console.log('session-store-test: PASS')
} finally {
  rmSync(root, { recursive: true, force: true })
}
