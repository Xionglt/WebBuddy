#!/usr/bin/env node
import assert from 'node:assert/strict'
import { ActionLedger } from '../dist/task/action-ledger.js'
import { reconcileExternalAction } from '../dist/task/action-reconciliation.js'

const fixtureVersion = '2026-08-12'
const fixtures = [
  {
    name: 'correct committed receipt',
    expected: 'committed',
    oracle: 'committed',
    verdict: { state: 'committed', independentlyObserved: true, evidenceIds: ['receipt:CSP-1'], externalReference: 'CSP-1', observedEffectDigest: '$expected' },
  },
  {
    name: 'correct authoritative absence',
    expected: 'not_committed',
    oracle: 'not_committed',
    verdict: { state: 'not_committed', independentlyObserved: true, evidenceIds: ['query:absent'], retrySafe: true },
  },
  {
    name: 'honest ambiguity',
    expected: 'ambiguous',
    oracle: 'ambiguous',
    verdict: { state: 'ambiguous', independentlyObserved: false, evidenceIds: [] },
  },
  {
    name: 'false success without independent evidence',
    expected: 'rejected',
    oracle: 'false_terminal',
    verdict: { state: 'committed', independentlyObserved: false, evidenceIds: [], externalReference: 'page-text-success', observedEffectDigest: '$expected' },
  },
  {
    name: 'terminal verdict for the wrong business key',
    expected: 'rejected',
    oracle: 'false_terminal',
    verdict: {
      state: 'committed',
      independentlyObserved: true,
      evidenceIds: ['receipt:WRONG'],
      externalReference: 'WRONG',
      observedEffectDigest: '$expected',
      businessKey: 'portal:tenant-a:invoice:WRONG',
    },
  },
  {
    name: 'terminal verdict older than the durable action state',
    expected: 'rejected',
    oracle: 'false_terminal',
    verdict: {
      state: 'committed',
      independentlyObserved: true,
      evidenceIds: ['receipt:STALE'],
      externalReference: 'STALE',
      observedEffectDigest: '$expected',
      observedAt: '2026-08-11T23:59:59.000Z',
    },
  },
  {
    name: 'receipt fields do not match the authorized effect',
    expected: 'rejected',
    oracle: 'false_terminal',
    verdict: {
      state: 'committed',
      independentlyObserved: true,
      evidenceIds: ['receipt:WRONG-AMOUNT'],
      externalReference: 'WRONG-AMOUNT',
      observedEffectDigest: 'f'.repeat(64),
    },
  },
  {
    name: 'eventually consistent empty query marked retryable',
    expected: 'rejected',
    oracle: 'false_terminal',
    verdict: { state: 'not_committed', independentlyObserved: true, evidenceIds: ['index:empty'], retrySafe: false },
  },
  {
    name: 'terminal verdict timestamp is implausibly far in the future',
    expected: 'rejected',
    oracle: 'false_terminal',
    verdict: {
      state: 'committed',
      independentlyObserved: true,
      evidenceIds: ['receipt:FUTURE'],
      externalReference: 'FUTURE',
      observedEffectDigest: '$expected',
      observedAt: '2099-01-01T00:00:00.000Z',
    },
  },
]

const cases = []
for (const [index, fixture] of fixtures.entries()) {
  const actionId = `eval-action-${index + 1}`
  const businessKey = `portal:tenant-a:invoice:EVAL-${index + 1}`
  const probeId = `eval-probe-${index + 1}/v1`
  const expectedEffectDigest = String((index % 6) + 1).repeat(64)
  const ledger = new ActionLedger(() => new Date('2026-08-12T00:00:00.000Z'))
  ledger.propose({
    actionId,
    actionKind: 'submit',
    toolName: 'browser_click',
    externalBinding: {
      schemaVersion: 'external-action-binding/v2',
      businessKey,
      probeId,
      effectDigest: expectedEffectDigest,
    },
  })
  ledger.authorize(actionId)
  ledger.begin(actionId)

  let actual = 'rejected'
  let error
  try {
    const result = await reconcileExternalAction({
      ledger,
      actionId,
      probe: {
        schemaVersion: 'external-action-probe/v1',
        id: probeId,
        authority: 'read_only',
        async reconcile() {
          const fixtureVerdict = {
            ...fixture.verdict,
            ...(fixture.verdict.observedEffectDigest === '$expected'
              ? { observedEffectDigest: expectedEffectDigest }
              : {}),
          }
          return {
            schemaVersion: 'external-action-reconciliation/v1',
            actionId,
            businessKey,
            state: 'ambiguous',
            observedAt: '2026-08-12T00:01:00.000Z',
            verifier: probeId,
            independentlyObserved: false,
            evidenceIds: [],
            summary: fixture.name,
            ...fixtureVerdict,
          }
        },
      },
    })
    actual = result.ledgerEntry.status
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught)
  }
  const passed = actual === fixture.expected
  cases.push({ name: fixture.name, oracle: fixture.oracle, expected: fixture.expected, actual, passed, ...(error ? { error } : {}) })
}

const falseTerminalCases = cases.filter((item) => item.oracle === 'false_terminal')
const falseTerminalAcceptedCount = falseTerminalCases.filter((item) => item.actual !== 'rejected').length
const passedCount = cases.filter((item) => item.passed).length
const result = {
  schemaVersion: 'external-action-reconciliation-eval/v1',
  fixtureVersion,
  scenarioCount: cases.length,
  passedCount,
  passRate: passedCount / cases.length,
  falseTerminalAttemptCount: falseTerminalCases.length,
  falseTerminalAcceptedCount,
  falseTerminalAcceptanceRate: falseTerminalAcceptedCount / falseTerminalCases.length,
  cases,
}

assert.equal(result.passedCount, result.scenarioCount)
assert.equal(result.falseTerminalAcceptedCount, 0)
console.log(JSON.stringify(result))
