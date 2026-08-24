#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  addAgentTaskV2,
  createAgentTaskGraphV2,
  createAgentTaskV2,
  finalizeAgentTaskGraphMutationV2,
} from '../dist/agents/task-graph.js'
import { FileTaskGraphStore } from '../dist/agents/task-graph-store.js'
import { AgentTaskScheduler } from '../dist/agents/task-scheduler.js'
import { RunnerRegistry } from '../dist/agents/runner-registry.js'
import { TaskNotificationQueue } from '../dist/agents/task-notification-queue.js'
import { ReadOnlyLlmSubagentRunner } from '../dist/agents/read-only-llm-runner.js'

const cases = []
const artifactBytes = Buffer.from('immutable trace evidence')

await check('T005 100 concurrent graph transactions preserve revisions/events', 'P0', testConcurrentTransactions)
for (const point of ['after_wal_commit', 'after_event_append', 'after_snapshot_commit']) {
  await check(`T016 graph commit recovery at ${point}`, 'P0', () => testGraphCrash(point))
}
await check('T006 dependency ordering and concurrency capacity', 'P1', testDependencyAndCapacity)
await check('T006 expired lease recovery fences the old attempt', 'P1', testLeaseRecovery)
await check('T007 timeout reaches terminal failure at max attempts', 'P1', testTimeout)
await check('T007 transient 5xx-style failure retries once', 'P1', testRetry)
await check('T007 cancel prevents late result/notification', 'P0', testCancel)
await check('T007 session abort kills all nonterminal tasks', 'P0', testSessionAbort)
await check('T007 dependency/retry auto-tick respects session abort fence', 'P0', testAutoTickAbortFence)
await check('T016 graph commit -> notification enqueue crash reconstructs delivery', 'P0', testEnqueueCrash)
await check('T016 notification ack durable-update crash is retryable', 'P0', testAckCrash)
await check('T015 stale result is assessed against current action clock', 'P0', testCommitTimeStaleAssessment)
await check('T010 tool call/result pairs and sidechain remain complete', 'P0', testSidechainBoundaries)

console.log(JSON.stringify({ schemaVersion: 'a9-async-task-chaos-result/v1', cases }, null, 2))
if (cases.some((item) => item.status === 'failed' && (item.severity === 'P0' || item.severity === 'P1'))) {
  process.exitCode = 1
}

async function check(name, severity, fn) {
  const started = Date.now()
  try {
    await fn()
    cases.push({ name, severity, status: 'passed', durationMs: Date.now() - started })
  } catch (error) {
    cases.push({
      name,
      severity,
      status: 'failed',
      durationMs: Date.now() - started,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

function ref(id = 'artifact_input') {
  return {
    schemaVersion: 'immutable-artifact-ref/v1', artifactId: id, artifactKind: 'trace',
    runId: 'run-a9', sessionId: 'session-a9',
    storage: { store: 'session_artifacts', relativeSegments: ['traces', `${id}.txt`] },
    mediaType: 'text/plain', byteLength: artifactBytes.byteLength,
    sha256: createHash('sha256').update(artifactBytes).digest('hex'),
    createdAt: '2026-07-10T00:00:00.000Z', actionBinding: { kind: 'not_action_bound' }, immutable: true,
  }
}

function idempotency(id) {
  return {
    schemaVersion: 'agent-task-idempotency/v1', scope: 'session', key: `key:${id}`,
    canonicalization: 'web-buddy-task-input-jcs/v1', digestAlgorithm: 'sha256',
    inputDigest: createHash('sha256').update(id).digest('hex'),
  }
}

function task(id, options = {}) {
  return createAgentTaskV2({
    id, kind: options.kind ?? 'memory_retrieval', title: id, priority: options.priority ?? 0,
    blockedBy: options.blockedBy ?? [], inputs: [{ kind: 'trace_artifact', artifactRef: ref(`artifact_${id}`) }],
    actionBinding: options.actionBinding ?? { kind: 'not_action_bound' }, idempotency: idempotency(id),
    maxAttempts: options.maxAttempts ?? 2, timeoutMs: options.timeoutMs ?? 500,
    leaseDurationMs: options.leaseDurationMs ?? 1_000, now: options.now ?? '2026-07-10T00:00:00.000Z',
  })
}

function graphWith(tasks, sessionId = 'session-a9', currentActionSeq = 0) {
  let graph = createAgentTaskGraphV2({ graphId: `graph-${sessionId}`, runId: 'run-a9', sessionId, currentActionSeq, now: '2026-07-10T00:00:00.000Z' })
  for (const item of tasks) graph = addAgentTaskV2(graph, item)
  return graph
}

function createdMutation(current, item, index = current.nextEventSeq) {
  const draft = addAgentTaskV2(current, item)
  const event = {
    schemaVersion: 'agent-task-event/v1', eventId: `event-create-${item.id}-${index}`,
    eventSeq: current.nextEventSeq, eventType: 'task_created', sessionId: current.sessionId,
    graphId: current.graphId, taskId: item.id, occurredAt: new Date(1_700_000_000_000 + index).toISOString(),
    revisionBefore: current.revision, revisionAfter: current.revision + 1,
    actionBinding: item.actionBinding, correlationId: `corr-${item.id}`,
    payload: { idempotency: item.idempotency }, authoritativeTaskState: true,
    authoritativeCompletionEvidence: false,
  }
  return finalizeAgentTaskGraphMutationV2(current, draft, event)
}

async function withStore(graph, fn, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'web-buddy-a9-'))
  try {
    const store = new FileTaskGraphStore({ rootDir: root, ...options })
    await store.create(graph)
    return await fn(store, root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

async function testConcurrentTransactions() {
  const initial = graphWith([], 'concurrent')
  await withStore(initial, async (store) => {
    await Promise.all(Array.from({ length: 100 }, (_, index) => store.transact('concurrent', (current) => (
      createdMutation(current, task(`tx-${index}`), index)
    ))))
    const loaded = await store.load('concurrent')
    const events = await store.readEvents('concurrent')
    assert.equal(loaded.revision, 100)
    assert.equal(loaded.nextEventSeq, 101)
    assert.equal(loaded.tasks.length, 100)
    assert.deepEqual(events.map((event) => event.eventSeq), Array.from({ length: 100 }, (_, i) => i + 1))
  })
}

async function testGraphCrash(point) {
  let injected = false
  const initial = graphWith([], `crash-${point}`)
  await withStore(initial, async (store, root) => {
    await assert.rejects(store.transact(initial.sessionId, (current) => createdMutation(current, task(`task-${point}`))), /injected/)
    const recovered = new FileTaskGraphStore({ rootDir: root })
    const graph = await recovered.load(initial.sessionId)
    const events = await recovered.readEvents(initial.sessionId)
    assert.equal(graph.revision, 1)
    assert.equal(graph.tasks.length, 1)
    assert.equal(events.length, 1)
  }, { faultInjector: (candidate) => { if (!injected && candidate === point) { injected = true; throw new Error(`injected ${point}`) } } })
}

function deterministicRunner(run) {
  return {
    contractVersion: 'agent-task-runner/v1', runnerId: 'a9-runner', runnerVersion: '1',
    kinds: ['memory_retrieval', 'workflow_evaluation', 'delivery_probe'], capacityClass: 'deterministic', runnerKind: 'deterministic', run,
  }
}

function success(request, freshness) {
  return {
    schemaVersion: 'agent-task-run-outcome/v1', outcome: 'succeeded_deterministic',
    result: {
      schemaVersion: 'deterministic-task-result/v1', runIdentity: request.runIdentity,
      outputRefs: [ref(`result_${request.task.id}_${request.runIdentity.attempt}`)],
      freshness: freshness ?? { kind: 'not_action_bound', validity: 'not_applicable' },
      requiresMainWorkflowVerification: true, authoritativeCompletionEvidence: false,
    },
  }
}

async function schedulerFixture(tasks, run, options = {}) {
  const graph = graphWith(tasks, options.sessionId ?? `scheduler-${Math.random()}`, options.currentActionSeq ?? 0)
  const root = await mkdtemp(join(tmpdir(), 'web-buddy-a9-scheduler-'))
  const store = new FileTaskGraphStore({ rootDir: root })
  await store.create(graph)
  const notifications = options.notifications ?? new TaskNotificationQueue()
  const scheduler = new AgentTaskScheduler({
    store: options.storeWrapper?.(store) ?? store,
    registry: new RunnerRegistry([deterministicRunner(run)]), notifications,
    schedulerId: 'scheduler-a9', retryDelayMs: 5,
    maxConcurrentDeterministicTasks: options.capacity ?? 2,
  })
  return { graph, root, store, notifications, scheduler, cleanup: () => rm(root, { recursive: true, force: true }) }
}

async function waitFor(predicate, message, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await predicate()
    if (value) return value
    await delay(5)
  }
  throw new Error(message)
}

async function testDependencyAndCapacity() {
  let active = 0
  let maxActive = 0
  const starts = []
  const run = async (request) => {
    starts.push(request.task.id); active += 1; maxActive = Math.max(maxActive, active)
    await delay(200); active -= 1
    return success(request)
  }
  const a = task('dep-a', { priority: 5 })
  const b = task('dep-b', { blockedBy: ['dep-a'], priority: 100 })
  const c = task('free-c', { priority: 4 })
  const d = task('free-d', { priority: 3 })
  const fx = await schedulerFixture([a, b, c, d], run, { capacity: 2, sessionId: 'dependency-capacity' })
  try {
    await fx.scheduler.tick(fx.graph.sessionId)
    await waitFor(async () => (await fx.store.load(fx.graph.sessionId)).tasks.every((item) => item.status === 'completed'), 'tasks did not complete')
    assert.equal(maxActive, 2)
    assert(starts.indexOf('dep-b') > starts.indexOf('dep-a'))
  } finally { await fx.cleanup() }
}

async function testLeaseRecovery() {
  const pending = task('expired', { maxAttempts: 2 })
  const expiredIdentity = { taskId: 'expired', attempt: 1, leaseId: 'lease-old', leaseOwnerId: 'scheduler-old' }
  const running = {
    ...pending, status: 'running', attempt: 1, lastStartedAt: '2020-01-01T00:00:00.000Z',
    lease: { schemaVersion: 'agent-task-lease/v1', leaseId: 'lease-old', ownerId: 'scheduler-old', acquiredAt: '2020-01-01T00:00:00.000Z', expiresAt: '2020-01-01T00:00:01.000Z', attempt: 1, claimedAtGraphRevision: 0 },
    attempts: [{ schemaVersion: 'agent-task-attempt-record/v1', runIdentity: expiredIdentity, startedAt: '2020-01-01T00:00:00.000Z', runnerKind: 'deterministic', outcome: 'running' }],
  }
  const fx = await schedulerFixture([running], async (request) => success(request), { sessionId: 'lease-recovery' })
  try {
    await fx.scheduler.tick(fx.graph.sessionId)
    await waitFor(async () => (await fx.store.load(fx.graph.sessionId)).tasks[0].status === 'completed', 'recovered task did not complete')
    const recovered = (await fx.store.load(fx.graph.sessionId)).tasks[0]
    assert.equal(recovered.attempt, 2)
    assert.equal(recovered.attempts[0].outcome, 'lease_expired')
    assert.equal(recovered.attempts[1].outcome, 'succeeded')
  } finally { await fx.cleanup() }
}

async function testTimeout() {
  const fx = await schedulerFixture([task('timeout', { timeoutMs: 10, maxAttempts: 1 })], async (request) => { await delay(100); return success(request) }, { sessionId: 'timeout' })
  try {
    await fx.scheduler.tick(fx.graph.sessionId)
    await waitFor(async () => (await fx.store.load(fx.graph.sessionId)).tasks[0].status === 'failed', 'timeout task did not fail')
    assert.equal((await fx.store.load(fx.graph.sessionId)).tasks[0].lastError.code, 'INVALID_TRANSITION')
  } finally { await fx.cleanup() }
}

async function testRetry() {
  const fx = await schedulerFixture([task('retry', { maxAttempts: 2 })], async (request) => request.runIdentity.attempt === 1
    ? { schemaVersion: 'agent-task-run-outcome/v1', outcome: 'failed', error: { schemaVersion: 'agent-task-runner-error/v1', code: 'LLM_TRANSIENT', category: 'transient', retryDisposition: 'retry_same_task', message: 'injected 503' } }
    : success(request), { sessionId: 'retry' })
  try {
    await fx.scheduler.tick(fx.graph.sessionId)
    await waitFor(async () => (await fx.store.load(fx.graph.sessionId)).tasks[0].status === 'completed', 'retry did not complete')
    assert.equal((await fx.store.load(fx.graph.sessionId)).tasks[0].attempt, 2)
  } finally { await fx.cleanup() }
}

async function testCancel() {
  const fx = await schedulerFixture([task('cancel')], async (request, control) => {
    await waitForAbort(control.abortSignal)
    return success(request)
  }, { sessionId: 'cancel' })
  try {
    await fx.scheduler.tick(fx.graph.sessionId)
    await waitFor(async () => (await fx.store.load(fx.graph.sessionId)).tasks[0].status === 'running', 'task not running')
    await fx.scheduler.cancelTask(fx.graph.sessionId, 'cancel')
    await fx.scheduler.waitForIdle(fx.graph.sessionId)
    const graph = await fx.store.load(fx.graph.sessionId)
    assert.equal(graph.tasks[0].status, 'killed')
    assert.equal(graph.notificationOutbox.length, 0)
  } finally { await fx.cleanup() }
}

async function testSessionAbort() {
  const fx = await schedulerFixture([task('abort-a'), task('abort-b'), task('abort-c')], async (request, control) => {
    await waitForAbort(control.abortSignal)
    return success(request)
  }, { capacity: 2, sessionId: 'session-abort' })
  try {
    await fx.scheduler.tick(fx.graph.sessionId)
    await fx.scheduler.abortSession(fx.graph.sessionId)
    assert((await fx.store.load(fx.graph.sessionId)).tasks.every((item) => item.status === 'killed'))
  } finally { await fx.cleanup() }
}

async function testAutoTickAbortFence() {
  let releaseParent
  const parentMayFinish = new Promise((resolve) => { releaseParent = resolve })
  const starts = []
  const parent = task('abort-parent')
  const child = task('abort-dependent', { blockedBy: ['abort-parent'] })
  const dependencyFx = await schedulerFixture([parent, child], async (request, control) => {
    starts.push(request.task.id)
    if (request.task.id === 'abort-parent') {
      await Promise.race([parentMayFinish, waitForAbort(control.abortSignal)])
    }
    return success(request)
  }, { sessionId: 'auto-tick-abort-dependency' })
  try {
    await dependencyFx.scheduler.tick(dependencyFx.graph.sessionId)
    await waitFor(async () => (await dependencyFx.store.load(dependencyFx.graph.sessionId)).tasks[0].status === 'running', 'parent task not running')
    releaseParent()
    await dependencyFx.scheduler.abortSession(dependencyFx.graph.sessionId)
    await delay(30)
    await dependencyFx.scheduler.tick(dependencyFx.graph.sessionId)
    const graph = await dependencyFx.store.load(dependencyFx.graph.sessionId)
    assert(graph.tasks.every((item) => item.status === 'completed' || item.status === 'killed'))
    assert.equal(starts.includes('abort-dependent'), false)
  } finally { await dependencyFx.cleanup() }

  const retryFx = await schedulerFixture([task('abort-retry', { maxAttempts: 2 })], async (request) => ({
    schemaVersion: 'agent-task-run-outcome/v1',
    outcome: 'failed',
    error: {
      schemaVersion: 'agent-task-runner-error/v1',
      code: 'LLM_TRANSIENT',
      category: 'transient',
      retryDisposition: 'retry_same_task',
      message: `retry attempt ${request.runIdentity.attempt}`,
    },
  }), { sessionId: 'auto-tick-abort-retry' })
  try {
    await retryFx.scheduler.tick(retryFx.graph.sessionId)
    await waitFor(async () => {
      const current = (await retryFx.store.load(retryFx.graph.sessionId)).tasks[0]
      return current.status === 'pending' && current.attempt === 1
    }, 'retry task did not become pending')
    await retryFx.scheduler.abortSession(retryFx.graph.sessionId)
    await delay(30)
    const taskAfterAbort = (await retryFx.store.load(retryFx.graph.sessionId)).tasks[0]
    assert.equal(taskAfterAbort.status, 'killed')
    assert.equal(taskAfterAbort.attempt, 1)
  } finally { await retryFx.cleanup() }
}

async function testEnqueueCrash() {
  const queue = new TaskNotificationQueue()
  const original = queue.enqueue.bind(queue)
  let fail = true
  queue.enqueue = (notification) => { if (fail) { fail = false; throw new Error('injected enqueue') } return original(notification) }
  const fx = await schedulerFixture([task('enqueue-crash')], async (request) => success(request), { notifications: queue, sessionId: 'enqueue-crash' })
  try {
    await fx.scheduler.tick(fx.graph.sessionId)
    await fx.scheduler.waitForIdle(fx.graph.sessionId)
    assert.equal((await fx.store.load(fx.graph.sessionId)).tasks[0].status, 'completed')
    assert.equal(queue.snapshot(fx.graph.sessionId).length, 0)
    await fx.scheduler.tick(fx.graph.sessionId)
    assert.equal(queue.snapshot(fx.graph.sessionId).length, 1)
  } finally { await fx.cleanup() }
}

async function testAckCrash() {
  let failAckCommit = true
  const fx = await schedulerFixture([task('ack-crash')], async (request) => success(request), {
    sessionId: 'ack-crash',
    storeWrapper: (base) => ({
      create: (...args) => base.create(...args), load: (...args) => base.load(...args), readEvents: (...args) => base.readEvents(...args),
      transact: (sessionId, reducer) => base.transact(sessionId, (current) => {
        const mutation = reducer(current)
        if (failAckCommit && mutation.event.eventType === 'task_notification_acknowledged') { failAckCommit = false; throw new Error('injected ack durable update') }
        return mutation
      }),
    }),
  })
  try {
    await fx.scheduler.tick(fx.graph.sessionId); await fx.scheduler.waitForIdle(fx.graph.sessionId)
    const [{ notification, delivery }] = await fx.notifications.claimAvailable(fx.graph.sessionId, 'main', 1_000)
    const ack = { schemaVersion: 'agent-task-notification-ack/v1', acknowledgementId: 'ack-a9', notificationId: notification.notificationId, deliveryId: delivery.deliveryId, claimId: delivery.claimId, injectedPromptMessageId: 'prompt-a9', acknowledgedAt: new Date().toISOString() }
    await assert.rejects(fx.scheduler.acknowledgeNotification(fx.graph.sessionId, ack), /injected/)
    assert.equal((await fx.store.load(fx.graph.sessionId)).notificationOutbox[0].state, 'pending_delivery')
    await fx.scheduler.acknowledgeNotification(fx.graph.sessionId, ack)
    assert.equal((await fx.store.load(fx.graph.sessionId)).notificationOutbox[0].state, 'acknowledged')
  } finally { await fx.cleanup() }
}

async function testCommitTimeStaleAssessment() {
  const bound = task('stale', { actionBinding: { kind: 'browser_action', sourceActionSeq: 7 } })
  const fx = await schedulerFixture([bound], async (request) => success(request, { kind: 'assessed', sourceActionSeq: 7, assessedAgainstActionSeq: 7, validity: 'unverified' }), { sessionId: 'stale', currentActionSeq: 8 })
  try {
    await fx.scheduler.tick(fx.graph.sessionId); await fx.scheduler.waitForIdle(fx.graph.sessionId)
    const output = (await fx.store.load(fx.graph.sessionId)).tasks[0].outputs[0]
    assert.equal(output.freshness.validity, 'stale', 'commit accepted runner-time freshness instead of assessing against graph actionClock=8')
    assert.equal(output.freshness.assessedAgainstActionSeq, 8)
  } finally { await fx.cleanup() }
}

async function testSidechainBoundaries() {
  const fixtureRoot = resolve('./test-fixtures/async-task')
  const envelope = JSON.parse(await readFile(join(fixtureRoot, 'context-envelope-v1.json'), 'utf8'))
  const graphFixture = JSON.parse(await readFile(join(fixtureRoot, 'task-graph-v2.json'), 'utf8'))
  const base = graphFixture.tasks[0]
  const identity = { taskId: base.id, attempt: 1, leaseId: 'lease-a9', leaseOwnerId: 'scheduler-a9' }
  const running = { ...base, status: 'running', attempt: 1, lastStartedAt: '2026-07-10T00:00:01.000Z', lease: { schemaVersion: 'agent-task-lease/v1', leaseId: identity.leaseId, ownerId: identity.leaseOwnerId, acquiredAt: '2026-07-10T00:00:01.000Z', expiresAt: '2026-07-10T00:10:01.000Z', attempt: 1, claimedAtGraphRevision: 2 }, attempts: [{ schemaVersion: 'agent-task-attempt-record/v1', runIdentity: identity, startedAt: '2026-07-10T00:00:01.000Z', runnerKind: 'read_only_llm', envelopeRef: envelope.outputSchemaRef, outcome: 'running' }] }
  const outputDir = await mkdtemp(join(tmpdir(), 'web-buddy-a9-sidechain-'))
  let turn = 0
  const runner = new ReadOnlyLlmSubagentRunner({
    sidechainOutputDir: outputDir, artifactReader: { read: async () => artifactBytes },
    llm: { chatWithTools: async () => ++turn === 1
      ? { content: '', toolCalls: [{ id: 'call-a9', name: 'artifact_read_text', arguments: { artifactId: 'artifact_trace_001' } }] }
      : { content: JSON.stringify({ summary: 'Trace evidence reviewed.', recommendations: ['Main Agent verifies current state.'], evidenceRefs: [{ kind: 'context_item', contextItemId: 'ctx_trace_001' }], uncertainties: ['No live page access.'] }), toolCalls: [] } },
  })
  try {
    const outcome = await runner.run({ schemaVersion: 'agent-task-run-input/v1', runnerKind: 'read_only_llm', runIdentity: identity, runnerId: runner.runnerId, runnerVersion: runner.runnerVersion, graphRevision: 2, task: running, limits: { maxTurns: 3, maxToolCalls: 2, maxInputTokens: 8_000, maxOutputTokens: 2_000, perRequestTimeoutMs: 500, overallTimeoutMs: 2_000 }, contextEnvelope: envelope }, { abortSignal: new AbortController().signal, reportProgress: async () => {} })
    assert.equal(outcome.outcome, 'succeeded')
    assert.equal(outcome.result.authoritativeCompletionEvidence, false)
    const transcriptPath = join(outputDir, ...outcome.result.sidechainTranscriptRef.storage.relativeSegments)
    const entries = (await readFile(transcriptPath, 'utf8')).trim().split('\n').map(JSON.parse)
    const calls = entries.filter((entry) => entry.type === 'sidechain_tool_call')
    const results = entries.filter((entry) => entry.type === 'sidechain_tool_result')
    assert.equal(calls.length, 1); assert.equal(results.length, 1)
    assert.equal(calls[0].data.toolCallId, results[0].data.toolCallId)
    assert(entries.some((entry) => entry.type === 'sidechain_completed'))
    assert.equal(entries.some((entry) => JSON.stringify(entry).includes('parent ReAct')), false)
  } finally { await rm(outputDir, { recursive: true, force: true }) }
}

function delay(ms) { return new Promise((resolveDelay) => setTimeout(resolveDelay, ms)) }

function waitForAbort(signal) {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolveAbort) => signal.addEventListener('abort', resolveAbort, { once: true }))
}
