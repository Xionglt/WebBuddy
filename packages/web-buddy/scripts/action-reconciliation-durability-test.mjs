#!/usr/bin/env node
import assert from 'node:assert/strict'
import { appendFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ActionLedger } from '../dist/task/action-ledger.js'
import { reconcileExternalAction } from '../dist/task/action-reconciliation.js'
import {
  persistExternalActionReconciliationAttempt,
  verifyExternalActionReceipt,
} from '../dist/task/action-reconciliation-artifact.js'
import {
  FileSessionRecorder,
  FileSessionStore,
  restoreSessionState,
} from '../dist/session/index.js'
import { FileToolResultStore } from '../dist/tools/tool-result-store.js'

const root = await mkdtemp(join(tmpdir(), 'web-buddy-action-durability-'))
try {
  await testFailureBeforeTerminalAppend()
  await testAckLossAfterTerminalFsync()
  await testRestoreRejectsWeakerVerdictShapes()
  await testPartialJournalTailFailsClosed()
  console.log('action-reconciliation-durability-test: PASS (pre-append orphan + post-fsync ACK loss + corrupt tail fail-closed)')
} finally {
  await rm(root, { recursive: true, force: true })
}

async function testFailureBeforeTerminalAppend() {
  const fixture = await createFixture('pre-append')
  let orphanReceipt
  await assert.rejects(
    () => persistExternalActionReconciliationAttempt({
      store: fixture.artifactStore,
      runId: fixture.session.runId,
      revision: 1,
      sessionId: fixture.session.sessionId,
      action: fixture.reconciled.ledgerEntry,
      verdict: fixture.reconciled.verdict,
      async persistLedgerEvent(receipt) {
        orphanReceipt = receipt
        throw new Error('injected failure before terminal event append')
      },
    }),
    /before terminal event append/,
  )
  assert(orphanReceipt)
  assert.equal(await fixture.artifactStore.exists(orphanReceipt.storageRef), true)

  const restored = await restoreSessionState({ session: fixture.session })
  assert.equal(
    ActionLedger.restore(restored.actionLedgerEntries).latest(fixture.actionId)?.status,
    'executing',
    'without a terminal event, the durable journal must remain unresolved',
  )
  assert.equal(restored.externalActionReceiptArtifacts.length, 0)
  assert.equal(restored.externalActionReceiptStorageRefs.length, 0)
}

async function testAckLossAfterTerminalFsync() {
  const fixture = await createFixture('post-fsync-ack-loss')
  let durableReceipt
  await assert.rejects(
    () => persistExternalActionReconciliationAttempt({
      store: fixture.artifactStore,
      runId: fixture.session.runId,
      revision: 1,
      sessionId: fixture.session.sessionId,
      action: fixture.reconciled.ledgerEntry,
      verdict: fixture.reconciled.verdict,
      async persistLedgerEvent(receipt) {
        durableReceipt = receipt
        await fixture.recorder.eventDurably({
          type: 'action_ledger_updated',
          toolCallId: fixture.actionId,
          message: 'submit: committed',
          data: {
            entry: fixture.reconciled.ledgerEntry,
            reconciliation: fixture.reconciled.verdict,
            receiptArtifact: receipt.artifact,
            receiptStorageRef: receipt.storageRef,
          },
        })
        throw new Error('injected ACK loss after terminal event fsync')
      },
    }),
    /ACK loss after terminal event fsync/,
  )
  assert(durableReceipt)

  const restored = await restoreSessionState({ session: fixture.session })
  const restoredLedger = ActionLedger.restore(restored.actionLedgerEntries)
  const committed = restoredLedger.latest(fixture.actionId)
  assert.equal(
    committed?.status,
    'committed',
    'restart must trust the durable terminal event even when the caller missed its acknowledgement',
  )
  assert.equal(restored.externalActionReceiptArtifacts.length, 1)
  assert.equal(restored.externalActionReceiptStorageRefs.length, 1)
  assert.equal(restored.externalActionReconciliationVerdicts.length, 1)
  await verifyExternalActionReceipt({
    store: fixture.artifactStore,
    artifact: restored.externalActionReceiptArtifacts[0],
    storageRef: restored.externalActionReceiptStorageRefs[0],
    sessionId: fixture.session.sessionId,
    action: committed,
    verdict: restored.externalActionReconciliationVerdicts[0],
  })
  await assert.rejects(
    () => verifyExternalActionReceipt({
      store: fixture.artifactStore,
      artifact: restored.externalActionReceiptArtifacts[0],
      storageRef: restored.externalActionReceiptStorageRefs[0],
      sessionId: fixture.session.sessionId,
      action: committed,
      verdict: {
        ...restored.externalActionReconciliationVerdicts[0],
        externalReference: 'FORGED-EVENT-REFERENCE',
      },
    }),
    /receipt content is invalid/,
    'the event verdict and immutable receipt payload must remain exactly bound',
  )
}

async function testPartialJournalTailFailsClosed() {
  const fixture = await createFixture('partial-journal-tail')
  await appendFile(
    fixture.session.eventsPath,
    '{"version":1,"type":"action_ledger_updated","data":{"entry":',
    'utf8',
  )
  await assert.rejects(
    () => restoreSessionState({ session: fixture.session }),
    (error) => error?.code === 'SESSION_JSONL_CORRUPT'
      && error.path === fixture.session.eventsPath
      && Number.isSafeInteger(error.lineNumber),
    'a partial journal tail must not be silently accepted or projected as a terminal action',
  )
}

async function testRestoreRejectsWeakerVerdictShapes() {
  const cases = [
    ['hidden-field', (verdict) => ({ ...verdict, hiddenCommitAuthority: true })],
    ['non-canonical-time', (verdict) => ({ ...verdict, observedAt: '2026-08-12T00:01:00Z' })],
    ['predates-action', (verdict) => ({ ...verdict, observedAt: '2026-08-11T23:59:59.999Z' })],
    ['duplicate-evidence', (verdict) => ({ ...verdict, evidenceIds: [verdict.evidenceIds[0], verdict.evidenceIds[0]] })],
    ['committed-retry-safe', (verdict) => ({ ...verdict, retrySafe: true })],
  ]
  for (const [suffix, mutate] of cases) {
    const fixture = await createFixture(`restore-verdict-${suffix}`)
    await persistExternalActionReconciliationAttempt({
      store: fixture.artifactStore,
      runId: fixture.session.runId,
      revision: 1,
      sessionId: fixture.session.sessionId,
      action: fixture.reconciled.ledgerEntry,
      verdict: fixture.reconciled.verdict,
      async persistLedgerEvent(receipt) {
        await fixture.recorder.eventDurably({
          type: 'action_ledger_updated',
          toolCallId: fixture.actionId,
          message: 'submit: committed with injected restore verdict',
          data: {
            entry: fixture.reconciled.ledgerEntry,
            reconciliation: mutate(fixture.reconciled.verdict),
            receiptArtifact: receipt.artifact,
            receiptStorageRef: receipt.storageRef,
          },
        })
      },
    })
    await assert.rejects(
      () => restoreSessionState({ session: fixture.session }),
      /missing a matching reconciliation verdict/i,
      `restore must reject the weaker ${suffix} verdict shape`,
    )
  }
}

async function createFixture(suffix) {
  const actionId = `durability:${suffix}`
  const businessKey = `portal:tenant-a:invoice:${suffix}`
  const probeId = `durability-probe-${suffix}/v1`
  const effectDigest = suffix === 'pre-append' ? 'a'.repeat(64) : 'b'.repeat(64)
  const store = new FileSessionStore({ rootDir: join(root, suffix, 'sessions') })
  const session = await store.create({
    sessionId: `session-${suffix}`,
    runId: `run-${suffix}`,
    source: 'test',
    goal: 'Verify external receipt/event durability ordering.',
    mode: 'test',
    now: '2026-08-12T00:00:00.000Z',
  })
  const recorder = new FileSessionRecorder(store, session)
  const artifactStore = new FileToolResultStore({ rootDir: join(root, suffix, 'artifacts') })
  const ledger = new ActionLedger(() => new Date('2026-08-12T00:00:00.000Z'))
  ledger.propose({
    actionId,
    actionKind: 'submit',
    toolName: 'browser_click',
    externalBinding: {
      schemaVersion: 'external-action-binding/v2',
      businessKey,
      probeId,
      effectDigest,
    },
  })
  ledger.authorize(actionId)
  ledger.begin(actionId)
  for (const entry of ledger.snapshot()) {
    await recorder.eventDurably({
      type: 'action_ledger_updated',
      toolCallId: actionId,
      message: `${entry.actionKind}: ${entry.status}`,
      data: { entry },
    })
  }
  const reconciled = await reconcileExternalAction({
    ledger,
    actionId,
    probe: {
      schemaVersion: 'external-action-probe/v1',
      id: probeId,
      authority: 'read_only',
      async reconcile(request) {
        return {
          schemaVersion: 'external-action-reconciliation/v1',
          actionId: request.action.actionId,
          businessKey: request.businessKey,
          state: 'committed',
          observedAt: '2026-08-12T00:01:00.000Z',
          verifier: probeId,
          independentlyObserved: true,
          evidenceIds: [`receipt:${suffix}`],
          externalReference: `CONFIRM-${suffix}`,
          observedEffectDigest: effectDigest,
          summary: 'The authoritative portal query found the exact committed effect.',
        }
      },
    },
  })
  return { actionId, artifactStore, recorder, reconciled, session }
}
