#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  buildContinuationMetrics,
  createPendingContinuation,
  FileRunStore,
  renderResumeCapsule,
  RunService,
  validateResumeCapsule,
} from '../dist/control/index.js'
import { snapshotWebTaskInput } from '../dist/task/contracts.js'

const rootDir = await mkdtemp(join(tmpdir(), 'web-buddy-continuation-control-'))

try {
  const runId = 'cold-continuation-run'
  const goal = 'Prepare a registration draft without submitting it.'
  const contract = {
    schemaVersion: 'web-task-contract/v1',
    contractId: 'cold-continuation-contract',
    revision: 0,
    criteria: [{
      id: 'draft-only',
      kind: 'action_boundary',
      description: 'Submission is forbidden',
      actionKinds: ['submit'],
      outcome: 'not_performed',
    }],
  }
  const runs = new RunService(new FileRunStore({ rootDir }))
  await runs.create(snapshotWebTaskInput({
    schemaVersion: 'web-task-input/v1',
    runId,
    revision: 0,
    goal: { instruction: goal },
    contract,
    sessionRef: {
      schemaVersion: 'session-ref/v1',
      provider: 'file-session-store',
      id: 'cold-continuation-session',
      runId,
      attempt: 1,
    },
  }), { idempotencyKey: 'create-cold-continuation' })
  await runs.start(runId, 'start-cold-continuation')

  const continuation = createPendingContinuation({
    runId,
    runRevision: 0,
    attempt: 1,
    sessionId: 'cold-continuation-session',
    goal,
    goalRevision: 0,
    contract,
    field: 'company_name',
    question: 'Which company name should be placed in the draft?',
    currentUrl: 'https://fixture.example/form',
    now: '2026-07-26T00:00:00.000Z',
  })
  const blocked = await runs.requestContinuation(
    runId,
    continuation,
    'request-cold-continuation',
  )
  assert.equal(blocked.state, 'blocked_on_human')
  assert.equal(blocked.pendingContinuation?.continuationId, continuation.continuationId)

  const answered = await runs.answerContinuation(runId, {
    continuationId: continuation.continuationId,
    answer: 'Example Labs',
    intentPatch: 'Keep the original draft-only constraint.',
    idempotencyKey: 'answer-cold-continuation',
    expectedRecordRevision: blocked.recordRevision,
    expectedRunRevision: 0,
    expectedAttempt: 1,
  })
  assert.equal(answered.changed, true)
  assert.equal(answered.record.pendingContinuation?.status, 'answered')

  const replayedAnswer = await runs.answerContinuation(runId, {
    continuationId: continuation.continuationId,
    answer: 'Example Labs',
    intentPatch: 'Keep the original draft-only constraint.',
    idempotencyKey: 'answer-cold-continuation',
    expectedRecordRevision: answered.record.recordRevision,
    expectedRunRevision: 0,
    expectedAttempt: 1,
  })
  assert.equal(replayedAnswer.changed, false)

  await assert.rejects(
    runs.answerContinuation(runId, {
      continuationId: continuation.continuationId,
      answer: 'Different Company',
      idempotencyKey: 'conflicting-answer-cold-continuation',
      expectedRecordRevision: answered.record.recordRevision,
      expectedRunRevision: 0,
      expectedAttempt: 1,
    }),
    /already answered with different content/,
  )

  const resuming = await runs.resumeAnsweredContinuation(
    runId,
    continuation.continuationId,
    'resume-cold-continuation',
  )
  assert.equal(resuming.state, 'resuming')
  assert.equal(resuming.runRevision, 1)
  assert.equal(resuming.attempt, 2)
  assert.equal(resuming.pendingContinuation, undefined)
  assert.equal(resuming.pendingApprovalIds.length, 0)
  assert.equal(resuming.sessionRef?.id, 'cold-continuation-session')
  assert.equal(resuming.sessionRef?.attempt, 2)
  assert.equal(resuming.lastResumeCapsule?.source.runRevision, 0)
  assert.equal(resuming.lastResumeCapsule?.source.attempt, 1)
  assert.equal(resuming.lastResumeCapsule?.target.runRevision, 1)
  assert.equal(resuming.lastResumeCapsule?.target.attempt, 2)
  assert.equal(resuming.lastResumeCapsule?.answeredQuestion.answer, 'Example Labs')
  assert.equal(resuming.lastResumeCapsule?.priorApprovalsInvalid, true)
  validateResumeCapsule(resuming.lastResumeCapsule, runId)
  assert.match(renderResumeCapsule(resuming.lastResumeCapsule), /current page observation is authoritative/i)
  assert.match(renderResumeCapsule(resuming.lastResumeCapsule), /browser element refs.*stale/i)

  const lateResult = await runs.acceptResult({
    runId,
    runRevision: 0,
    attempt: 1,
    terminalState: 'completed',
    idempotencyKey: 'late-old-attempt-result',
  })
  assert.equal(lateResult.accepted, false)
  const afterLateResult = await runs.get(runId)
  assert.equal(afterLateResult?.state, 'resuming')
  assert.equal(afterLateResult?.runRevision, 1)
  assert.equal(afterLateResult?.attempt, 2)

  const runningAgain = await runs.transition(runId, {
    to: 'running',
    idempotencyKey: 'start-cold-continuation-attempt-2',
    expectedRunRevision: 1,
    expectedAttempt: 2,
  })
  const completed = await runs.acceptResult({
    runId,
    runRevision: runningAgain.runRevision,
    attempt: runningAgain.attempt,
    terminalState: 'completed',
    reason: 'Draft completed after durable continuation.',
    idempotencyKey: 'complete-cold-continuation-attempt-2',
  })
  assert.equal(completed.accepted, true)
  assert.equal(completed.record.state, 'completed')

  const events = await runs.events(runId)
  assert(events.items.some((event) => event.eventType === 'continuation_requested'))
  assert(events.items.some((event) => event.eventType === 'continuation_answered'))
  assert(events.items.some((event) => event.eventType === 'continuation_resumed'))
  assert(events.items.some((event) => event.eventType === 'late_result_rejected'))
  const metrics = buildContinuationMetrics(events.items)
  assert.equal(metrics.requested, 1)
  assert.equal(metrics.answered, 1)
  assert.equal(metrics.resumed, 1)
  assert.equal(metrics.coldResumed, 1)
  assert.equal(metrics.completedAfterResume, 1)
  assert.equal(metrics.lateAttemptResultsRejected, 1)
  assert.equal(metrics.answerRate, 1)
  assert.equal(metrics.resumeRate, 1)
  assert.equal(metrics.settledSuccessRate, 1)
  assert.equal(metrics.reblockRate, 0)
  assert.equal(metrics.answerLatency.count, 1)
  assert.equal(metrics.answerToResumeLatency.count, 1)

  console.log('control continuation tests passed')
} finally {
  await rm(rootDir, { recursive: true, force: true })
}
