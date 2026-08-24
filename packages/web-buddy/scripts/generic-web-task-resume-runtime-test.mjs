#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createWebTaskRuntimeDriver,
  listGenericWebTaskToolDefs,
} from '../dist/sdk/web-task.js'
import { loadConfig } from '../dist/sdk/config.js'
import {
  FileSessionRecorder,
  FileSessionStore,
  restoreSessionState,
  sanitizeRestoredMessagesForResume,
} from '../dist/session/index.js'
import { snapshotWebTaskInput } from '../dist/task/contracts.js'
import { ActionLedger } from '../dist/task/action-ledger.js'
import {
  answerPendingContinuation,
  createPendingContinuation,
  createResumeCapsule,
} from '../dist/control/index.js'

const root = await mkdtemp(join(tmpdir(), 'web-buddy-generic-resume-runtime-'))
const traceRoot = join(root, 'trace')
const previousEnvironment = Object.fromEntries([
  'TRACE_OUT_DIR',
  'MODEL_API_KEY',
  'OPENAI_API_KEY',
  'DASHSCOPE_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
].map((key) => [key, process.env[key]]))
try {
  process.env.TRACE_OUT_DIR = traceRoot
  delete process.env.MODEL_API_KEY
  delete process.env.OPENAI_API_KEY
  delete process.env.DASHSCOPE_API_KEY
  delete process.env.ANTHROPIC_AUTH_TOKEN

  const runId = 'generic-resume-runtime-run'
  const sessionId = 'generic-resume-runtime-session'
  const store = new FileSessionStore({ rootDir: join(traceRoot, 'sessions') })
  const session = await store.create({
    sessionId,
    runId,
    source: 'web',
    goal: 'Restore a read-only observation task.',
    mode: 'generic-web-task',
    traceRunId: runId,
  })
  const recorder = new FileSessionRecorder(store, session)
  await recorder.transcript({ type: 'user_message', content: 'Inspect the current page.' })
  await recorder.transcript({
    type: 'tool_call',
    toolCallId: 'unsettled-write-call',
    name: 'browser_click',
    args: { ref: 'e9' },
  })
  const restored = await restoreSessionState({ session })
  const sanitizedMessages = sanitizeRestoredMessagesForResume(restored.restoredMessages)
  assert.equal(
    sanitizedMessages.some((message) => (
      message.role === 'assistant'
      && message.tool_calls?.some((call) => call.id === 'unsettled-write-call')
    )),
    false,
    'an unsettled pre-restart write call remained replayable',
  )
  assert.equal(
    sanitizedMessages.some((message) => (
      message.role === 'tool' && message.tool_call_id === 'unsettled-write-call'
    )),
    false,
    'an orphaned tool result remained replayable',
  )
  const beforeTranscript = await readFile(session.transcriptPath, 'utf8')
  const lateLedger = new ActionLedger(() => new Date('2026-08-12T00:00:00.000Z'))
  lateLedger.propose({
    actionId: 'late-durable-submit',
    actionKind: 'submit',
    toolName: 'browser_click',
    externalBinding: {
      schemaVersion: 'external-action-binding/v2',
      businessKey: 'portal:resume-fixture:invoice:LATE',
      probeId: 'resume-fixture-probe/v1',
      effectDigest: 'c'.repeat(64),
    },
  })
  lateLedger.authorize('late-durable-submit')
  lateLedger.begin('late-durable-submit')
  lateLedger.propose({
    actionId: 'preflight-proposed-submit',
    actionKind: 'submit',
    toolName: 'browser_click',
    externalBinding: {
      schemaVersion: 'external-action-binding/v2',
      businessKey: 'portal:resume-fixture:invoice:PREFLIGHT',
      probeId: 'resume-fixture-probe/v1',
      effectDigest: 'd'.repeat(64),
    },
  })
  for (const entry of lateLedger.snapshot()) {
    await recorder.eventDurably({
      type: 'action_ledger_updated',
      toolCallId: entry.actionId,
      message: `${entry.actionKind}: ${entry.status}`,
      data: { entry },
    })
  }
  let lateProbeCalls = 0
  const lateProbe = {
    schemaVersion: 'external-action-probe/v1',
    id: 'resume-fixture-probe/v1',
    authority: 'read_only',
    async reconcile(request) {
      lateProbeCalls += 1
      return {
        schemaVersion: 'external-action-reconciliation/v1',
        actionId: request.action.actionId,
        businessKey: request.businessKey,
        state: 'committed',
        observedAt: '2026-08-12T00:01:00.000Z',
        verifier: this.id,
        independentlyObserved: true,
        evidenceIds: [`receipt:${request.businessKey}`],
        externalReference: request.businessKey.endsWith(':PREFLIGHT') ? 'PREFLIGHT' : 'LATE',
        observedEffectDigest: request.action.externalBinding.effectDigest,
        summary: 'The late durable action exists in the external portal.',
      }
    },
  }
  const config = loadConfig()
  config.model.apiKey = null
  config.model.authToken = null
  config.trace.outDir = traceRoot
  const sessionRef = {
    schemaVersion: 'session-ref/v1',
    provider: 'file-session-store',
    id: sessionId,
    runId,
    attempt: 2,
  }
  const snapshot = snapshotWebTaskInput({
    schemaVersion: 'web-task-input/v1',
    runId,
    revision: 4,
    ownerScope: {
      schemaVersion: 'owner-scope/v1',
      tenantId: 'resume-fixture-tenant',
      userId: 'resume-fixture-user',
    },
    goal: { instruction: 'Restore a read-only observation task.' },
    contract: {
      schemaVersion: 'web-task-contract/v1',
      contractId: 'generic-resume-runtime-contract',
      revision: 4,
      criteria: [{
        id: 'observed',
        kind: 'evidence_present',
        description: 'Observe the current page after recovery.',
        evidenceKinds: ['page'],
        minCount: 1,
        allowedAuthorities: ['main_runtime'],
      }],
    },
    policy: {
      schemaVersion: 'task-policy/v1',
      defaultSensitiveAction: 'deny',
      rules: [],
    },
  })
  const runtimeRequest = (ref, execution = {}) => ({
    schemaVersion: 'web-task-runtime-request/v1',
    input: snapshot,
    contextItems: [],
    runtime: {
      executionContext: {
        schemaVersion: 'run-execution-context/v1',
        runRevision: 5,
        attempt: 2,
        sessionRef: ref,
        recoveryMode: 'read_only_reobserve/v1',
        ...execution,
      },
    },
    emit() {},
  })
  let readySession
  const driver = createWebTaskRuntimeDriver({
    config,
    durableSession: true,
    sessionId,
    restoredSession: restored,
    readOnlyAuthority: true,
    externalActionProbes: [lateProbe],
    onSessionReady(value) { readySession = value },
  })
  const outcome = await driver.execute(runtimeRequest(sessionRef))
  assert.equal(outcome.status, 'blocked', 'no-key recovery fixture should stop without browser writes')
  assert.deepEqual(outcome.sessionRef, sessionRef)
  assert.equal(readySession.sessionId, sessionId)
  assert.equal(lateProbeCalls, 2, 'recovery must reconcile both executing and preflight-proposed actions appended after the caller snapshot')
  const afterFreshRecovery = await restoreSessionState({ session: readySession })
  assert.equal(
    ActionLedger.restore(afterFreshRecovery.actionLedgerEntries).latest('late-durable-submit')?.status,
    'committed',
    'the current durable session, not the stale caller snapshot, must own recovery truth',
  )
  assert.equal(
    ActionLedger.restore(afterFreshRecovery.actionLedgerEntries).latest('preflight-proposed-submit')?.status,
    'committed',
    'a crash after durable preflight proposal must recover through the read-only Probe before model startup',
  )
  assert.equal(afterFreshRecovery.externalActionReceiptArtifacts.length, 2)
  assert.equal(afterFreshRecovery.externalActionReceiptStorageRefs.length, 2)
  assert.equal(afterFreshRecovery.externalActionReceiptArtifacts[0].kind, 'external_action_receipt')
  const recoveredReceiptStorageRef = afterFreshRecovery.externalActionReceiptStorageRefs[0]
  const recoveredReceiptArtifact = outcome.artifacts.find((artifact) => artifact.kind === 'external_action_receipt')
  assert(recoveredReceiptArtifact, 'no-key recovery must still return the restored receipt artifact')
  assert.deepEqual(
    recoveredReceiptArtifact.ownerScope,
    snapshot.ownerScope,
    'a recovered external receipt must leave the SDK with the same tenant owner scope as its run',
  )
  assert.deepEqual(recoveredReceiptArtifact.binding.sessionRef, sessionRef)
  assert.equal(
    await readFile(session.transcriptPath, 'utf8'),
    beforeTranscript,
    'recovery must reuse rather than recreate or truncate the durable transcript',
  )

  for (const strictFixture of [
    {
      suffix: 'unbound',
      expected: /strict reconciliation mode cannot continue strict-sdk-unbound without a durable binding/,
    },
    {
      suffix: 'missing-probe',
      expected: /strict reconciliation mode cannot continue strict-sdk-missing-probe without absent-sdk-probe\/v1/,
    },
  ]) {
    const strictSessionId = `generic-resume-strict-${strictFixture.suffix}`
    const strictSession = await store.create({
      sessionId: strictSessionId,
      runId,
      source: 'web',
      goal: 'Reject unreconciled durable external work before model startup.',
      mode: 'generic-web-task',
      traceRunId: runId,
    })
    const strictRecorder = new FileSessionRecorder(store, strictSession)
    const strictLedger = new ActionLedger(() => new Date('2026-08-12T00:02:00.000Z'))
    const strictActionId = `strict-sdk-${strictFixture.suffix}`
    strictLedger.propose({
      actionId: strictActionId,
      actionKind: 'send',
      toolName: 'send_invoice',
      ...(strictFixture.suffix === 'missing-probe' ? {
        externalBinding: {
          schemaVersion: 'external-action-binding/v2',
          businessKey: 'portal:resume-fixture:invoice:STRICT-MISSING-PROBE',
          probeId: 'absent-sdk-probe/v1',
          effectDigest: 'd'.repeat(64),
        },
      } : {}),
    })
    strictLedger.authorize(strictActionId)
    strictLedger.begin(strictActionId)
    for (const entry of strictLedger.snapshot()) {
      await strictRecorder.eventDurably({
        type: 'action_ledger_updated',
        toolCallId: entry.actionId,
        message: `${entry.actionKind}: ${entry.status}`,
        data: { entry },
      })
    }
    const strictRestored = await restoreSessionState({ session: strictSession })
    const strictSessionRef = { ...sessionRef, id: strictSessionId }
    const strictDriver = createWebTaskRuntimeDriver({
      config,
      durableSession: true,
      sessionId: strictSessionId,
      restoredSession: strictRestored,
      readOnlyAuthority: true,
      requireExternalActionReconciliation: true,
    })
    const strictOutcome = await strictDriver.execute(runtimeRequest(strictSessionRef))
    assert.equal(strictOutcome.status, 'failed')
    assert.match(strictOutcome.summary, strictFixture.expected)
  }

  const strictAmbiguousSessionId = 'generic-resume-strict-ambiguous'
  const strictAmbiguousSession = await store.create({
    sessionId: strictAmbiguousSessionId,
    runId,
    source: 'web',
    goal: 'Stop before model startup when an external effect remains in doubt.',
    mode: 'generic-web-task',
    traceRunId: runId,
  })
  const strictAmbiguousRecorder = new FileSessionRecorder(store, strictAmbiguousSession)
  const strictAmbiguousLedger = new ActionLedger(() => new Date('2026-08-12T00:03:00.000Z'))
  strictAmbiguousLedger.propose({
    actionId: 'strict-sdk-ambiguous',
    actionKind: 'submit',
    toolName: 'browser_click',
    externalBinding: {
      schemaVersion: 'external-action-binding/v2',
      businessKey: 'portal:resume-fixture:invoice:STRICT-AMBIGUOUS',
      probeId: 'strict-sdk-ambiguous-probe/v1',
      effectDigest: 'e'.repeat(64),
    },
  })
  strictAmbiguousLedger.authorize('strict-sdk-ambiguous')
  strictAmbiguousLedger.begin('strict-sdk-ambiguous')
  for (const entry of strictAmbiguousLedger.snapshot()) {
    await strictAmbiguousRecorder.eventDurably({
      type: 'action_ledger_updated',
      toolCallId: entry.actionId,
      message: `${entry.actionKind}: ${entry.status}`,
      data: { entry },
    })
  }
  let strictAmbiguousProbeCalls = 0
  const strictAmbiguousProbe = {
    schemaVersion: 'external-action-probe/v1',
    id: 'strict-sdk-ambiguous-probe/v1',
    authority: 'read_only',
    async reconcile(request) {
      strictAmbiguousProbeCalls += 1
      return {
        schemaVersion: 'external-action-reconciliation/v1',
        actionId: request.action.actionId,
        businessKey: request.businessKey,
        state: 'ambiguous',
        observedAt: '2026-08-12T00:04:00.000Z',
        verifier: this.id,
        independentlyObserved: false,
        evidenceIds: ['query:strict-sdk-ambiguous:visibility-window'],
        summary: 'The authoritative index is still inside its visibility window.',
      }
    },
  }
  const strictAmbiguousRestored = await restoreSessionState({ session: strictAmbiguousSession })
  const strictAmbiguousSessionRef = { ...sessionRef, id: strictAmbiguousSessionId }
  const strictAmbiguousDriver = createWebTaskRuntimeDriver({
    config,
    durableSession: true,
    sessionId: strictAmbiguousSessionId,
    restoredSession: strictAmbiguousRestored,
    readOnlyAuthority: true,
    requireExternalActionReconciliation: true,
    externalActionProbes: [strictAmbiguousProbe],
  })
  const strictAmbiguousOutcome = await strictAmbiguousDriver.execute(
    runtimeRequest(strictAmbiguousSessionRef),
  )
  assert.equal(strictAmbiguousProbeCalls, 1)
  assert.equal(strictAmbiguousOutcome.status, 'blocked')
  assert.match(strictAmbiguousOutcome.summary, /remain in doubt after authoritative reconciliation/)
  assert.doesNotMatch(strictAmbiguousOutcome.summary, /no model key/)
  const strictAmbiguousAfterRecovery = await restoreSessionState({ session: strictAmbiguousSession })
  assert.equal(
    ActionLedger.restore(strictAmbiguousAfterRecovery.actionLedgerEntries)
      .latest('strict-sdk-ambiguous')?.status,
    'ambiguous',
  )

  const pendingContinuation = createPendingContinuation({
    runId,
    runRevision: 5,
    attempt: 2,
    sessionId,
    goal: snapshot.goal.instruction,
    goalRevision: snapshot.revision,
    contract: snapshot.contract,
    field: 'company_name',
    question: 'Which company name should be used?',
    now: '2026-07-26T00:00:00.000Z',
  })
  const continuationCapsule = createResumeCapsule(
    answerPendingContinuation(pendingContinuation, {
      answer: 'Example Labs',
      intentPatch: 'Continue the original task after re-observing.',
      answeredAt: '2026-07-26T00:00:01.000Z',
    }),
    { runRevision: 6, attempt: 3 },
    '2026-07-26T00:00:02.000Z',
  )
  await recorder.transcript({
    type: 'user_continuation',
    continuationId: continuationCapsule.continuationId,
    questionId: continuationCapsule.answeredQuestion.questionId,
    field: continuationCapsule.answeredQuestion.field,
    answer: continuationCapsule.answeredQuestion.answer,
    intentPatch: continuationCapsule.intentPatch,
    capsule: continuationCapsule,
  })
  const restoredContinuation = await restoreSessionState({ session })
  assert.match(
    restoredContinuation.restoredMessages.at(-1)?.content,
    /current page observation is authoritative/i,
  )
  const continuationSessionRef = { ...sessionRef, attempt: 3 }
  const continuationDriver = createWebTaskRuntimeDriver({
    config,
    durableSession: true,
    sessionId,
    restoredSession: restoredContinuation,
    continuationAuthority: true,
  })
  const continuationOutcome = await continuationDriver.execute(runtimeRequest(
    continuationSessionRef,
    {
      runRevision: 6,
      attempt: 3,
      recoveryMode: 'continuation_reobserve/v1',
    },
  ))
  assert.equal(continuationOutcome.status, 'blocked')
  assert.deepEqual(continuationOutcome.sessionRef, continuationSessionRef)
  assert(
    listGenericWebTaskToolDefs(false).some((tool) => tool.name === 'browser_click'),
    'authorized continuation recovery must retain normal tools behind the existing policy gates',
  )

  const unauthorizedContinuationDriver = createWebTaskRuntimeDriver({
    config,
    durableSession: true,
    sessionId,
    restoredSession: restoredContinuation,
    continuationAuthority: false,
  })
  const unauthorizedContinuation = await unauthorizedContinuationDriver.execute(runtimeRequest(
    continuationSessionRef,
    {
      runRevision: 6,
      attempt: 3,
      recoveryMode: 'continuation_reobserve/v1',
    },
  ))
  assert.equal(unauthorizedContinuation.status, 'failed')
  assert.match(unauthorizedContinuation.summary, /durable restored session.*continuation authority/)

  const recoveryDefs = listGenericWebTaskToolDefs(true)
  assert(recoveryDefs.some((tool) => tool.name === 'browser_snapshot'))
  assert(recoveryDefs.some((tool) => tool.name === 'agent_done'))
  assert(recoveryDefs.every((tool) => tool.execution.readOnly || tool.name === 'agent_done'))
  for (const forbidden of [
    'browser_open',
    'browser_click',
    'browser_click_text',
    'browser_type',
    'browser_fill_by_label',
    'browser_select',
    'browser_upload_file',
  ]) {
    assert.equal(recoveryDefs.some((tool) => tool.name === forbidden), false, `${forbidden} leaked into recovery`)
  }

  const unsafeDriver = createWebTaskRuntimeDriver({
    config,
    durableSession: true,
    sessionId,
    restoredSession: restored,
    readOnlyAuthority: false,
  })
  const unsafeOutcome = await unsafeDriver.execute(runtimeRequest(sessionRef))
  assert.equal(unsafeOutcome.status, 'failed')
  assert.match(unsafeOutcome.summary, /durable restored session.*read-only authority/)

  const missingSessionRef = {
    ...sessionRef,
    id: 'generic-resume-missing-restored-session',
  }
  const missingRestoredDriver = createWebTaskRuntimeDriver({
    config,
    durableSession: true,
    sessionId: missingSessionRef.id,
    readOnlyAuthority: true,
  })
  const missingRestored = await missingRestoredDriver.execute(runtimeRequest(missingSessionRef))
  assert.equal(missingRestored.status, 'failed')
  assert.match(missingRestored.summary, /durable restored session.*read-only authority/)
  assert.equal(
    await store.get(missingSessionRef.id),
    undefined,
    'recoveryMode without restored state created a replacement session',
  )

  const nonDurableDriver = createWebTaskRuntimeDriver({
    config,
    durableSession: false,
    sessionId,
    restoredSession: restored,
    readOnlyAuthority: true,
  })
  const nonDurable = await nonDurableDriver.execute(runtimeRequest(sessionRef))
  assert.equal(nonDurable.status, 'failed')
  assert.match(nonDurable.summary, /durable restored session.*read-only authority/)

  const missingRecoveryModeDriver = createWebTaskRuntimeDriver({
    config,
    durableSession: true,
    sessionId,
    restoredSession: restored,
    readOnlyAuthority: true,
  })
  const missingRecoveryMode = await missingRecoveryModeDriver.execute(
    runtimeRequest(sessionRef, { recoveryMode: undefined }),
  )
  assert.equal(missingRecoveryMode.status, 'failed')
  assert.match(missingRecoveryMode.summary, /explicit recovery mode/)

  const storedReceiptEnvelope = JSON.parse(await readFile(recoveredReceiptStorageRef.uri, 'utf8'))
  storedReceiptEnvelope.content.summary = 'Tampered after the durable committed event.'
  await writeFile(recoveredReceiptStorageRef.uri, `${JSON.stringify(storedReceiptEnvelope, null, 2)}\n`, 'utf8')
  const tamperedRestored = await restoreSessionState({ session: readySession })
  const tamperedDriver = createWebTaskRuntimeDriver({
    config,
    durableSession: true,
    sessionId,
    restoredSession: tamperedRestored,
    readOnlyAuthority: true,
  })
  const tamperedOutcome = await tamperedDriver.execute(runtimeRequest(sessionRef))
  assert.equal(tamperedOutcome.status, 'failed')
  assert.match(
    tamperedOutcome.summary,
    /artifact integrity check failed/i,
    'a tampered receipt payload must be rejected before it can satisfy Completion',
  )

  const eventLines = (await readFile(readySession.eventsPath, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  const committedEvent = eventLines.find((event) => (
    event.type === 'action_ledger_updated' && event.data?.entry?.status === 'committed'
  ))
  assert(committedEvent, 'fixture must contain a durable committed external action event')
  delete committedEvent.data.reconciliation
  await writeFile(readySession.eventsPath, `${eventLines.map((event) => JSON.stringify(event)).join('\n')}\n`, 'utf8')
  await assert.rejects(
    restoreSessionState({ session: readySession }),
    /missing a matching reconciliation verdict/i,
    'deleting only the terminal verdict must invalidate the otherwise intact receipt event',
  )

  console.log('generic-web-task-resume-runtime-test: PASS')
} finally {
  for (const [key, value] of Object.entries(previousEnvironment)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  await rm(root, { recursive: true, force: true })
}
