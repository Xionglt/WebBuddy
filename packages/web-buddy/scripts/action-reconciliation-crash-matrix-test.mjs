#!/usr/bin/env node
import assert from 'node:assert/strict'
import { ActionLedger } from '../dist/task/action-ledger.js'
import {
  reconcileExternalAction,
  unresolvedActionEntries,
} from '../dist/task/action-reconciliation.js'

const now = () => new Date('2026-08-12T00:00:00.000Z')
const EFFECT_DIGEST = 'b'.repeat(64)

const crashPoints = [
  {
    name: 'after-preflight-proposal-before-terminal-observation',
    prepare() {},
    externallyCommitted: false,
    expected: 'not_committed',
  },
  {
    name: 'after-authorization-before-executing-journal',
    prepare(ledger, actionId) {
      ledger.authorize(actionId)
    },
    externallyCommitted: false,
    expected: 'not_committed',
  },
  {
    name: 'after-executing-journal-before-external-effect',
    prepare(ledger, actionId) {
      ledger.authorize(actionId)
      ledger.begin(actionId)
    },
    externallyCommitted: false,
    expected: 'not_committed',
  },
  {
    name: 'after-external-effect-before-tool-return',
    prepare(ledger, actionId) {
      ledger.authorize(actionId)
      ledger.begin(actionId)
    },
    externallyCommitted: true,
    expected: 'committed',
  },
  {
    name: 'after-tool-return-before-executed-journal',
    prepare(ledger, actionId) {
      ledger.authorize(actionId)
      ledger.begin(actionId)
    },
    externallyCommitted: true,
    expected: 'committed',
  },
  {
    name: 'after-executed-journal-before-committed-journal',
    prepare(ledger, actionId) {
      ledger.authorize(actionId)
      ledger.begin(actionId)
      ledger.markExecuted(actionId)
    },
    externallyCommitted: true,
    expected: 'committed',
  },
]

async function main() {
for (const point of crashPoints) {
  const portal = new FakePortal()
  const actionId = `action:${point.name}`
  const businessKey = `portal:customer-a:invoice:${point.name}`
  const beforeCrash = new ActionLedger(now)
  beforeCrash.propose({
    actionId,
    actionKind: 'submit',
    toolName: 'browser_click',
    externalBinding: {
      schemaVersion: 'external-action-binding/v2',
      businessKey,
      probeId: portal.id,
      effectDigest: EFFECT_DIGEST,
    },
  })
  point.prepare(beforeCrash, actionId)
  if (point.externallyCommitted) portal.submit(businessKey, `receipt:${point.name}`)

  const restored = ActionLedger.restore(beforeCrash.snapshot(), now)
  const submissionsBeforeRecovery = portal.submissionCount
  const reconciled = await reconcileExternalAction({ ledger: restored, actionId, probe: portal })

  assert.equal(reconciled.ledgerEntry.status, point.expected, point.name)
  assert.equal(portal.submissionCount, submissionsBeforeRecovery, `${point.name}: recovery must be read-only`)
  assert.equal(portal.reconcileCount, 1, `${point.name}: recovery must perform one authoritative query`)
  assert.equal(unresolvedActionEntries(restored.snapshot()).length, 0, `${point.name}: terminal query must converge`)
  const outcomes = restored.outcomes(['submit'])
  assert(
    outcomes.some((outcome) => outcome.outcome === (point.expected === 'committed' ? 'performed' : 'not_performed')),
    `${point.name}: completion projection must match authoritative external state`,
  )
}

const afterCommit = new ActionLedger(now)
afterCommit.propose({
  actionId: 'action:after-commit',
  actionKind: 'submit',
  toolName: 'browser_click',
  externalBinding: {
    schemaVersion: 'external-action-binding/v2',
    businessKey: 'portal:customer-a:invoice:after-commit',
    probeId: 'unused-probe/v1',
    effectDigest: EFFECT_DIGEST,
  },
})
afterCommit.authorize('action:after-commit')
afterCommit.begin('action:after-commit')
afterCommit.markExecuted('action:after-commit')
afterCommit.commit('action:after-commit', 'Receipt was durably recorded before the crash.')
const restoredAfterCommit = ActionLedger.restore(afterCommit.snapshot(), now)
assert.equal(unresolvedActionEntries(restoredAfterCommit.snapshot()).length, 0)
assert(restoredAfterCommit.outcomes(['submit']).some((outcome) => outcome.outcome === 'performed'))

console.log(`action-reconciliation-crash-matrix-test: PASS (${crashPoints.length + 1} crash boundaries)`)
}

class FakePortal {
  #receipts = new Map()
  schemaVersion = 'external-action-probe/v1'
  id = 'fake-crash-matrix-portal/v1'
  authority = 'read_only'
  submissionCount = 0
  reconcileCount = 0

  submit(businessKey, receipt) {
    this.submissionCount += 1
    assert.equal(this.#receipts.has(businessKey), false, `duplicate external effect for ${businessKey}`)
    this.#receipts.set(businessKey, receipt)
  }

  async reconcile(request) {
    this.reconcileCount += 1
    const receipt = this.#receipts.get(request.businessKey)
    return {
      schemaVersion: 'external-action-reconciliation/v1',
      actionId: request.action.actionId,
      businessKey: request.businessKey,
      state: receipt ? 'committed' : 'not_committed',
      observedAt: '2026-08-12T00:01:00.000Z',
      verifier: this.id,
      independentlyObserved: true,
      evidenceIds: [receipt ?? `absent:${request.businessKey}`],
      ...(receipt ? { externalReference: receipt } : { retrySafe: true }),
      ...(receipt ? { observedEffectDigest: request.action.externalBinding.effectDigest } : {}),
      summary: receipt
        ? 'The portal query found the committed invoice receipt.'
        : 'The portal query authoritatively proved that the invoice was not created and retry is safe.',
    }
  }
}

await main()
