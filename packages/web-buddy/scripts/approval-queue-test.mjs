#!/usr/bin/env node
import assert from 'node:assert/strict'
import { ApprovalQueue, ApprovalQueueError } from '../dist/permission/index.js'

const times = [
  '2026-06-29T00:00:00.000Z',
  '2026-06-29T00:00:01.000Z',
  '2026-06-29T00:00:02.000Z',
  '2026-06-29T00:00:03.000Z',
  '2026-06-29T00:00:04.000Z',
  '2026-06-29T00:00:05.000Z',
  '2026-06-29T00:00:06.000Z',
  '2026-06-29T00:00:07.000Z',
]
let cursor = 0
const queue = new ApprovalQueue({
  now: () => new Date(times[cursor++] ?? times.at(-1)),
})

const events = []
const unsubscribe = queue.subscribe((event) => {
  events.push(event.type)
})
queue.subscribe(() => {
  throw new Error('listener failures should not corrupt queue state')
})

const approval = queue.enqueue({
  id: 'appr-turn-1-call-1',
  runId: 'run-1',
  sessionId: 'session-1',
  turnId: 'turn-1',
  toolCallId: 'call-1',
  permissionRequestId: 'perm-turn-1-call-1',
  reason: 'High-risk click requires approval.',
  gateKind: 'high_risk_action',
  risk: 'L3',
  riskLevel: 'high',
  context: { toolName: 'browser_click', argBrief: 'ref=e1' },
})

assert.equal(approval.status, 'pending')
assert.equal(approval.createdAt, '2026-06-29T00:00:00.000Z')
assert.equal(approval.updatedAt, approval.createdAt)
assert.equal(approval.runId, 'run-1')
assert.equal(approval.sessionId, 'session-1')
assert.equal(approval.turnId, 'turn-1')
assert.equal(approval.toolCallId, 'call-1')
assert.equal(approval.permissionRequestId, 'perm-turn-1-call-1')
assert.equal(approval.reason, 'High-risk click requires approval.')
assert.equal(approval.gateKind, 'high_risk_action')
assert.equal(approval.risk, 'L3')
assert.equal(approval.riskLevel, 'high')
assert.deepEqual(approval.allowedDecisions, ['approve', 'decline', 'takeover'])
assert.equal(queue.listPending().length, 1)
assert.equal(queue.listAll().length, 1)
assert.equal(queue.get(approval.id).id, approval.id)

approval.status = 'approved'
assert.equal(queue.get(approval.id).status, 'pending', 'returned approvals should not mutate queue state')

const duplicate = queue.enqueue({
  id: 'appr-turn-1-call-1',
  runId: 'run-1',
  sessionId: 'session-1',
  reason: 'duplicate should not replace existing',
  gateKind: 'final_submit',
})
assert.equal(duplicate.status, 'pending')
assert.equal(duplicate.gateKind, 'high_risk_action')

const approved = queue.resolve(approval.id, { decision: 'approve', source: 'scripted_gate', reason: 'test approved' })
assert.equal(approved.status, 'approved')
assert.equal(approved.resolvedAt, '2026-06-29T00:00:01.000Z')
assert.equal(approved.resolution.decision, 'approve')
assert.equal(approved.resolution.source, 'scripted_gate')
assert.equal(approved.resolution.reason, 'test approved')
assert.equal(approved.resolution.permissionRequestId, 'perm-turn-1-call-1')
assert.equal(queue.listPending().length, 0)

assert.throws(
  () => queue.resolve(approval.id, 'denied'),
  (error) => error instanceof ApprovalQueueError && error.code === 'approval_not_pending',
)
assert.throws(
  () => queue.resolve('missing', 'approved'),
  (error) => error instanceof ApprovalQueueError && error.code === 'unknown_approval',
)

const denied = queue.enqueue({
  id: 'appr-denied',
  runId: 'run-1',
  sessionId: 'session-1',
  reason: 'User declined.',
  gateKind: 'upload_resume',
})
queue.resolve(denied.id, 'deny')
assert.equal(queue.get(denied.id).status, 'denied')
assert.equal(queue.get(denied.id).resolution.decision, 'decline')
assert.equal(queue.get(denied.id).resolution.source, 'human_gate')

const expired = queue.enqueue({
  id: 'appr-expired',
  runId: 'run-1',
  sessionId: 'session-1',
  reason: 'Timed out.',
  gateKind: 'captcha',
})
queue.expire(expired.id, 'No response before timeout.')
assert.equal(queue.get(expired.id).status, 'expired')
assert.equal(queue.get(expired.id).resolution.source, 'timeout')

const cancelled = queue.enqueue({
  id: 'appr-cancelled',
  runId: 'run-1',
  sessionId: 'session-1',
  reason: 'Manual takeover.',
  gateKind: 'final_submit',
})
queue.resolve(cancelled.id, 'takeover')
assert.equal(queue.get(cancelled.id).status, 'cancelled')

const snapshot = queue.snapshot()
assert.equal(snapshot.version, 1)
assert.equal(snapshot.pending.length, 0)
assert.equal(snapshot.approved.length, 1)
assert.equal(snapshot.denied.length, 1)
assert.equal(snapshot.expired.length, 1)
assert.equal(snapshot.cancelled.length, 1)
assert.equal(snapshot.resolved.length, 4)
assert.equal(snapshot.all.length, 4)

unsubscribe()
assert.deepEqual(events, [
  'approval_enqueued',
  'approval_resolved',
  'approval_enqueued',
  'approval_resolved',
  'approval_enqueued',
  'approval_resolved',
  'approval_enqueued',
  'approval_resolved',
])

console.log('approval-queue-test: PASS')
