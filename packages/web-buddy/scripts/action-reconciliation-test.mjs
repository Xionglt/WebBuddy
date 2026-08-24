#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { ActionLedger } from '../dist/task/action-ledger.js'
import {
  bindExternalActionRequest,
  externalActionDestinationOrigin,
  externalActionEffectDigest,
  externalActionProbeById,
  externalActionProbeTimeoutForBudget,
  reconcileExternalAction,
  resolveExternalActionIntentKind,
  unresolvedActionEntries,
} from '../dist/task/action-reconciliation.js'
import {
  materializeExternalActionReceipt,
  persistExternalActionReconciliationAttempt,
} from '../dist/task/action-reconciliation-artifact.js'
import { evaluateCompletionContract } from '../dist/task/completion-contract.js'

const now = () => new Date('2026-08-12T00:00:00.000Z')
const EFFECT_DIGEST = 'a'.repeat(64)
async function main() {
  const portal = new FakeInvoicePortal()
  const actionId = 'turn-7:submit-invoice-260601'
  const businessKey = 'portal:customer-a:invoice:INV-CN-260601'
  const rollbackClock = [
    new Date('2026-08-12T00:00:01.000Z'),
    new Date('2026-08-12T00:00:00.000Z'),
  ]
  const monotonicLedger = new ActionLedger(() => rollbackClock.shift() ?? new Date('2026-08-12T00:00:00.000Z'))
  monotonicLedger.propose({
    actionId: 'clock-rollback-action',
    actionKind: 'submit',
    toolName: 'browser_click',
  })
  monotonicLedger.authorize('clock-rollback-action')
  assert.deepEqual(
    monotonicLedger.snapshot().map((entry) => entry.recordedAt),
    ['2026-08-12T00:00:01.000Z', '2026-08-12T00:00:01.000Z'],
    'ActionLedger must preserve a non-decreasing durable clock across wall-clock rollback',
  )
  ActionLedger.restore(monotonicLedger.snapshot())
  const opaqueClickIntent = {
    schemaVersion: 'external-action-intent/v1',
    actionKind: 'submit',
    binding: {
      schemaVersion: 'external-action-binding/v2',
      businessKey,
      probeId: portal.id,
    },
  }
  assert.equal(
    resolveExternalActionIntentKind(opaqueClickIntent, undefined),
    'submit',
    'a trusted site adapter may upgrade an otherwise opaque click into the durable external-action path',
  )
  assert.equal(
    resolveExternalActionIntentKind({
      schemaVersion: 'external-action-intent/v1',
      actionKind: 'non_external',
    }, undefined),
    undefined,
    'a trusted strict-site adapter may explicitly attest that an opaque control has no external business effect',
  )
  assert.throws(
    () => resolveExternalActionIntentKind({
      schemaVersion: 'external-action-intent/v1',
      actionKind: 'non_external',
    }, 'submit'),
    /EXTERNAL_ACTION_CLASSIFICATION_CONFLICT/,
    'a non_external attestation must not downgrade a sensitive kind already inferred by the Runtime',
  )
  assert.throws(
    () => resolveExternalActionIntentKind({ ...opaqueClickIntent, adapterNote: 'must not cross the trust boundary' }, undefined),
    /EXTERNAL_ACTION_INTENT_INVALID/,
    'the intent projection must reject undeclared top-level adapter fields instead of silently widening the contract',
  )
  assert.throws(
    () => resolveExternalActionIntentKind(opaqueClickIntent, 'type_or_paste'),
    /EXTERNAL_ACTION_CLASSIFICATION_CONFLICT/,
    'a site adapter must not replace a sensitive classification already inferred by the Runtime',
  )
  const canonicalBinding = bindExternalActionRequest({
    schemaVersion: 'external-action-binding/v2',
    businessKey,
    probeId: portal.id,
    unexpectedSecret: 'Bearer must-not-enter-the-ledger',
  }, {
    actionId,
    actionKind: 'submit',
    toolName: 'browser_click',
    args: { invoiceId: 'INV-CN-260601', amount: 48_600 },
    currentUrl: 'https://portal.example.test/invoices',
  })
  assert.deepEqual(
    Object.keys(canonicalBinding).sort(),
    ['businessKey', 'effectDigest', 'probeId', 'schemaVersion'].sort(),
    'the runtime must whitelist binding fields instead of persisting adapter extensions',
  )
  assert.notEqual(
    externalActionEffectDigest({
      actionId,
      actionKind: 'submit',
      toolName: 'browser_click',
      args: { invoiceId: 'INV-CN-260601' },
      currentUrl: 'https://shell.example.test/task',
      destinationOrigin: 'https://portal-a.example.test',
    }),
    externalActionEffectDigest({
      actionId,
      actionKind: 'submit',
      toolName: 'browser_click',
      args: { invoiceId: 'INV-CN-260601' },
      currentUrl: 'https://shell.example.test/task',
      destinationOrigin: 'https://portal-b.example.test',
    }),
    'the same payload sent to another sink origin must be a different external effect',
  )
  const crossSiteRequest = {
    actionId: 'cross-site-submit',
    actionKind: 'submit',
    toolName: 'browser_click',
    args: { selector: '#submit' },
    currentUrl: 'https://shell.example.test/task',
  }
  const crossSiteCandidate = {
    schemaVersion: 'external-action-binding/v2',
    businessKey: 'portal:customer-a:invoice:CROSS-SITE',
    probeId: portal.id,
    destinationOrigin: 'https://actual-portal.example.test',
    effectPayload: { invoiceId: 'CROSS-SITE', amount: 500 },
  }
  assert.equal(
    externalActionDestinationOrigin(crossSiteCandidate, crossSiteRequest),
    'https://actual-portal.example.test',
    'the trusted site adapter must be able to replace the visible shell with the actual sink origin',
  )
  assert.equal(
    bindExternalActionRequest(crossSiteCandidate, crossSiteRequest).effectDigest,
    externalActionEffectDigest({
      ...crossSiteRequest,
      destinationOrigin: 'https://actual-portal.example.test',
      effectPayload: { invoiceId: 'CROSS-SITE', amount: 500 },
    }),
  )
  assert.throws(
    () => externalActionDestinationOrigin(
      { destinationOrigin: 'https://actual-portal.example.test/path' },
      crossSiteRequest,
    ),
    /canonical absolute origin/,
  )
  assert.equal(
    externalActionEffectDigest({
      actionId: 'click-a',
      actionKind: 'submit',
      toolName: 'browser_click',
      args: { selector: '#submit-row-17' },
      destinationOrigin: 'https://portal-a.example.test',
      effectPayload: { invoiceId: 'INV-CN-260601', amount: 48_600, attachmentSha256: '1'.repeat(64) },
    }),
    externalActionEffectDigest({
      actionId: 'click-b',
      actionKind: 'submit',
      toolName: 'browser_click_text',
      args: { text: 'Submit invoice' },
      destinationOrigin: 'https://portal-a.example.test',
      effectPayload: { attachmentSha256: '1'.repeat(64), amount: 48_600, invoiceId: 'INV-CN-260601' },
    }),
    'volatile selectors/tool mechanisms must not change the same canonical business effect',
  )
  assert.notEqual(
    externalActionEffectDigest({
      actionId: 'click-same-selector-before-edit',
      actionKind: 'submit',
      toolName: 'browser_click',
      args: { selector: '#submit' },
      destinationOrigin: 'https://portal-a.example.test',
      effectPayload: { invoiceId: 'INV-CN-260601', amount: 48_600 },
    }),
    externalActionEffectDigest({
      actionId: 'click-same-selector-after-edit',
      actionKind: 'submit',
      toolName: 'browser_click',
      args: { selector: '#submit' },
      destinationOrigin: 'https://portal-a.example.test',
      effectPayload: { invoiceId: 'INV-CN-260601', amount: 49_100 },
    }),
    'the same click must become a different effect when a canonical business field changes',
  )
assert.equal(
  externalActionProbeTimeoutForBudget({
      perActionTimeoutMs: 10_000,
      recoveryBudgetMs: 30_000,
      startedAtMs: 1_000,
      nowMs: 25_000,
    }),
    6_000,
    'the last probe must be clipped to the remaining whole-recovery budget',
  )
  assert.equal(
    externalActionProbeTimeoutForBudget({
      perActionTimeoutMs: 10_000,
      recoveryBudgetMs: 30_000,
      startedAtMs: 1_000,
      nowMs: 31_000,
    }),
    undefined,
  'no new probe may start after the whole-recovery budget is exhausted',
)

const fairRecoveryOrder = new ActionLedger(now)
for (const suffix of ['A', 'B', 'C']) {
  const fairActionId = `fair-recovery-${suffix}`
  fairRecoveryOrder.propose({ actionId: fairActionId, actionKind: 'submit', toolName: 'browser_click' })
  fairRecoveryOrder.authorize(fairActionId)
  fairRecoveryOrder.begin(fairActionId)
}
fairRecoveryOrder.markAmbiguous('fair-recovery-A', 'The first probe consumed this startup attempt.')
assert.deepEqual(
  unresolvedActionEntries(fairRecoveryOrder.snapshot()).map((entry) => entry.actionId),
  ['fair-recovery-B', 'fair-recovery-C', 'fair-recovery-A'],
  'an attempted ambiguous action must move behind actions not reached before the recovery budget expired',
)

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
beforeCrash.authorize(actionId, 'User approved this exact invoice and portal origin.')
beforeCrash.begin(actionId, 'Durable execution boundary.')

assert.throws(
  () => beforeCrash.perform(actionId, 'A local tool result is not an external receipt.'),
  /cannot use legacy performed/,
  'an externally bound action must never bypass reconciliation through the legacy performed terminal',
)
const forgedLegacyTerminal = beforeCrash.snapshot().map((entry) => structuredClone(entry))
forgedLegacyTerminal.push({
  ...structuredClone(forgedLegacyTerminal.at(-1)),
  sequence: forgedLegacyTerminal.length + 1,
  status: 'performed',
})
assert.throws(
  () => ActionLedger.restore(forgedLegacyTerminal, now),
  /cannot use legacy performed/,
  'durable restore must reject the same compatibility bypass',
)

const crossKindBusinessKey = 'portal:customer-a:invoice:CROSS-KIND-REUSE'
const crossKindLedger = new ActionLedger(now)
crossKindLedger.propose({
  actionId: 'cross-kind:send',
  actionKind: 'send',
  toolName: 'send_invoice',
  externalBinding: {
    schemaVersion: 'external-action-binding/v2',
    businessKey: crossKindBusinessKey,
    probeId: portal.id,
    effectDigest: 'b'.repeat(64),
  },
})
crossKindLedger.authorize('cross-kind:send')
crossKindLedger.begin('cross-kind:send')
crossKindLedger.markNotCommitted('cross-kind:send', 'The original send effect was authoritatively absent.')
assert.throws(
  () => crossKindLedger.propose({
    actionId: 'cross-kind:submit',
    actionKind: 'submit',
    toolName: 'browser_click',
    externalBinding: {
      schemaVersion: 'external-action-binding/v2',
      businessKey: crossKindBusinessKey,
      probeId: portal.id,
      effectDigest: 'c'.repeat(64),
    },
  }),
  /changed its action kind/,
  'a business key must be unique across all externally reconciled action kinds, not only within one classifier label',
)
assert.throws(
  () => crossKindLedger.propose({
    actionId: 'cross-kind:submit-same-digest',
    actionKind: 'submit',
    toolName: 'browser_click',
    externalBinding: {
      schemaVersion: 'external-action-binding/v2',
      businessKey: crossKindBusinessKey,
      probeId: portal.id,
      effectDigest: 'b'.repeat(64),
    },
  }),
  /changed its action kind/,
  'the Ledger must enforce action-kind stability even if a direct caller forges a reused digest',
)
const forgedCrossKindHistory = crossKindLedger.snapshot().map((entry) => structuredClone(entry))
forgedCrossKindHistory.push({
  schemaVersion: 'action-ledger-entry/v1',
  sequence: forgedCrossKindHistory.length + 1,
  actionId: 'cross-kind:forged-submit',
  actionKind: 'submit',
  toolName: 'browser_click',
  status: 'proposed',
  recordedAt: '2026-08-12T00:00:01.000Z',
  externalBinding: {
    schemaVersion: 'external-action-binding/v2',
    businessKey: crossKindBusinessKey,
    probeId: portal.id,
    effectDigest: 'c'.repeat(64),
  },
})
assert.throws(
  () => ActionLedger.restore(forgedCrossKindHistory, now),
  /changed its action kind/,
  'restore must reject the same cross-kind business-key reuse even if the online guard was bypassed',
)
forgedCrossKindHistory.at(-1).externalBinding.effectDigest = 'b'.repeat(64)
assert.throws(
  () => ActionLedger.restore(forgedCrossKindHistory, now),
  /changed its action kind/,
  'restore must enforce action-kind stability independently from digest integrity',
)

for (const mutationTarget of ['request', 'nested-action']) {
  const mutationActionId = `probe-mutation:${mutationTarget}`
  const mutationBusinessKey = `portal:customer-a:invoice:PROBE-MUTATION-${mutationTarget}`
  const mutationLedger = new ActionLedger(now)
  mutationLedger.propose({
    actionId: mutationActionId,
    actionKind: 'submit',
    toolName: 'browser_click',
    externalBinding: {
      schemaVersion: 'external-action-binding/v2',
      businessKey: mutationBusinessKey,
      probeId: `mutating-probe-${mutationTarget}/v1`,
      effectDigest: 'd'.repeat(64),
    },
  })
  mutationLedger.authorize(mutationActionId)
  mutationLedger.begin(mutationActionId)
  const mutatingProbe = {
    schemaVersion: 'external-action-probe/v1',
    id: `mutating-probe-${mutationTarget}/v1`,
    authority: 'read_only',
    async reconcile(request) {
      if (mutationTarget === 'request') request.businessKey = 'portal:attacker:invoice:FORGED'
      else request.action.externalBinding.effectDigest = 'e'.repeat(64)
      return {
        schemaVersion: 'external-action-reconciliation/v1',
        actionId: mutationActionId,
        businessKey: mutationBusinessKey,
        state: 'ambiguous',
        observedAt: '2026-08-12T00:00:01.000Z',
        verifier: this.id,
        independentlyObserved: false,
        evidenceIds: [],
        summary: 'must not be reached after mutation',
      }
    },
  }
  await assert.rejects(
    () => reconcileExternalAction({
      ledger: mutationLedger,
      actionId: mutationActionId,
      probe: mutatingProbe,
    }),
    TypeError,
    'a Probe must not be able to rewrite either its request envelope or the expected durable action',
  )
  assert.equal(
    mutationLedger.latest(mutationActionId)?.status,
    'executing',
    'a rejected Probe mutation must not move the in-memory ledger to a terminal state',
  )
}

const mutableProbeIdAction = 'probe-mutation:verifier-id'
const mutableProbeIdBusinessKey = 'portal:customer-a:invoice:PROBE-ID-TOCTOU'
const mutableProbeIdLedger = new ActionLedger(now)
mutableProbeIdLedger.propose({
  actionId: mutableProbeIdAction,
  actionKind: 'submit',
  toolName: 'browser_click',
  externalBinding: {
    schemaVersion: 'external-action-binding/v2',
    businessKey: mutableProbeIdBusinessKey,
    probeId: 'stable-probe-id/v1',
    effectDigest: 'f'.repeat(64),
  },
})
mutableProbeIdLedger.authorize(mutableProbeIdAction)
mutableProbeIdLedger.begin(mutableProbeIdAction)
const mutableIdentityProbe = {
  schemaVersion: 'external-action-probe/v1',
  id: 'stable-probe-id/v1',
  authority: 'read_only',
  async reconcile() {
    this.id = 'changed-after-await/v1'
    return {
      schemaVersion: 'external-action-reconciliation/v1',
      actionId: mutableProbeIdAction,
      businessKey: mutableProbeIdBusinessKey,
      state: 'committed',
      observedAt: '2026-08-12T00:00:01.000Z',
      verifier: this.id,
      independentlyObserved: true,
      evidenceIds: ['mutable-probe-id-evidence'],
      externalReference: 'MUTABLE-PROBE-ID-REF',
      observedEffectDigest: 'f'.repeat(64),
      summary: 'A mutable verifier identity must not authorize this terminal.',
    }
  },
}
await assert.rejects(
  () => reconcileExternalAction({
    ledger: mutableProbeIdLedger,
    actionId: mutableProbeIdAction,
    probe: mutableIdentityProbe,
  }),
  /verifier must match probe stable-probe-id\/v1/,
  'the verifier identity must be snapshotted before awaiting external code',
)
assert.equal(mutableProbeIdLedger.latest(mutableProbeIdAction)?.status, 'executing')

const accessorVerdictAction = 'probe-mutation:accessor-verdict'
const accessorVerdictBusinessKey = 'portal:customer-a:invoice:ACCESSOR-VERDICT'
const accessorVerdictLedger = new ActionLedger(now)
accessorVerdictLedger.propose({
  actionId: accessorVerdictAction,
  actionKind: 'submit',
  toolName: 'browser_click',
  externalBinding: {
    schemaVersion: 'external-action-binding/v2',
    businessKey: accessorVerdictBusinessKey,
    probeId: 'accessor-verdict-probe/v1',
    effectDigest: '1'.repeat(64),
  },
})
accessorVerdictLedger.authorize(accessorVerdictAction)
accessorVerdictLedger.begin(accessorVerdictAction)
let accessorStateReads = 0
const accessorVerdictProbe = {
  schemaVersion: 'external-action-probe/v1',
  id: 'accessor-verdict-probe/v1',
  authority: 'read_only',
  async reconcile() {
    return {
      schemaVersion: 'external-action-reconciliation/v1',
      actionId: accessorVerdictAction,
      businessKey: accessorVerdictBusinessKey,
      get state() {
        accessorStateReads += 1
        return accessorStateReads === 1 ? 'committed' : 'not_committed'
      },
      observedAt: '2026-08-12T00:00:01.000Z',
      verifier: this.id,
      independentlyObserved: true,
      evidenceIds: ['accessor-verdict-evidence'],
      externalReference: 'ACCESSOR-VERDICT-REF',
      observedEffectDigest: '1'.repeat(64),
      summary: 'The Runtime must validate one detached verdict snapshot.',
    }
  },
}
const accessorVerdictResult = await reconcileExternalAction({
  ledger: accessorVerdictLedger,
  actionId: accessorVerdictAction,
  probe: accessorVerdictProbe,
})
assert.equal(accessorStateReads, 1, 'a Probe verdict accessor must be materialized only once before validation')
assert.equal(accessorVerdictResult.verdict.state, 'committed')
assert.equal(accessorVerdictLedger.latest(accessorVerdictAction)?.status, 'committed')

const verdictExtensionAction = 'probe-contract:unknown-verdict-field'
const verdictExtensionBusinessKey = 'portal:customer-a:invoice:UNKNOWN-VERDICT-FIELD'
const verdictExtensionLedger = new ActionLedger(now)
verdictExtensionLedger.propose({
  actionId: verdictExtensionAction,
  actionKind: 'submit',
  toolName: 'browser_click',
  externalBinding: {
    schemaVersion: 'external-action-binding/v2',
    businessKey: verdictExtensionBusinessKey,
    probeId: 'unknown-verdict-field-probe/v1',
    effectDigest: '3'.repeat(64),
  },
})
verdictExtensionLedger.authorize(verdictExtensionAction)
verdictExtensionLedger.begin(verdictExtensionAction)
await assert.rejects(
  () => reconcileExternalAction({
    ledger: verdictExtensionLedger,
    actionId: verdictExtensionAction,
    probe: {
      schemaVersion: 'external-action-probe/v1',
      id: 'unknown-verdict-field-probe/v1',
      authority: 'read_only',
      async reconcile() {
        return {
          schemaVersion: 'external-action-reconciliation/v1',
          actionId: verdictExtensionAction,
          businessKey: verdictExtensionBusinessKey,
          state: 'committed',
          observedAt: '2026-08-12T00:00:01.000Z',
          verifier: this.id,
          independentlyObserved: true,
          evidenceIds: ['unknown-verdict-field-evidence'],
          externalReference: 'UNKNOWN-VERDICT-FIELD-REF',
          observedEffectDigest: '3'.repeat(64),
          summary: 'Unknown authority fields must fail closed.',
          writeAuthority: 'execute',
        }
      },
    },
  }),
  /unsupported field\(s\): writeAuthority/,
  'a read-only Probe cannot smuggle undeclared authority through a verdict extension',
)
assert.equal(
  verdictExtensionLedger.latest(verdictExtensionAction)?.status,
  'executing',
  'a rejected verdict extension must not move the Action Ledger to a terminal state',
)

const wrongBusinessKeyAction = 'probe-binding:wrong-business-key'
const boundBusinessKey = 'portal:customer-a:invoice:BOUND-KEY'
const wrongBusinessKeyLedger = new ActionLedger(now)
wrongBusinessKeyLedger.propose({
  actionId: wrongBusinessKeyAction,
  actionKind: 'submit',
  toolName: 'browser_click',
  externalBinding: {
    schemaVersion: 'external-action-binding/v2',
    businessKey: boundBusinessKey,
    probeId: 'wrong-business-key-probe/v1',
    effectDigest: '2'.repeat(64),
  },
})
wrongBusinessKeyLedger.authorize(wrongBusinessKeyAction)
wrongBusinessKeyLedger.begin(wrongBusinessKeyAction)
let wrongBusinessKeyProbeCalls = 0
await assert.rejects(
  () => reconcileExternalAction({
    ledger: wrongBusinessKeyLedger,
    actionId: wrongBusinessKeyAction,
    businessKey: 'portal:customer-a:invoice:DIFFERENT-KEY',
    probe: {
      schemaVersion: 'external-action-probe/v1',
      id: 'wrong-business-key-probe/v1',
      authority: 'read_only',
      async reconcile() {
        wrongBusinessKeyProbeCalls += 1
        throw new Error('must not query the wrong identity')
      },
    },
  }),
  /is bound to .*BOUND-KEY, received .*DIFFERENT-KEY/,
  'a caller-supplied query key must never override the durable Action binding',
)
assert.equal(wrongBusinessKeyProbeCalls, 0)
assert.equal(wrongBusinessKeyLedger.latest(wrongBusinessKeyAction)?.status, 'executing')

const unboundReconciliationLedger = new ActionLedger(now)
unboundReconciliationLedger.propose({
  actionId: 'probe-binding:unbound-action',
  actionKind: 'send',
  toolName: 'send_invoice',
})
unboundReconciliationLedger.authorize('probe-binding:unbound-action')
unboundReconciliationLedger.begin('probe-binding:unbound-action')
let unboundProbeCalls = 0
await assert.rejects(
  () => reconcileExternalAction({
    ledger: unboundReconciliationLedger,
    actionId: 'probe-binding:unbound-action',
    businessKey: 'portal:customer-a:invoice:CALLER-INVENTED-KEY',
    probe: {
      schemaVersion: 'external-action-probe/v1',
      id: 'unbound-reconciliation-probe/v1',
      authority: 'read_only',
      async reconcile() {
        unboundProbeCalls += 1
        throw new Error('must not reconcile a caller-invented identity')
      },
    },
  }),
  /has no durable business\/probe binding to reconcile/,
  'a caller must not retrofit an unbound action with a business identity after the execution boundary',
)
assert.equal(unboundProbeCalls, 0)
assert.equal(unboundReconciliationLedger.latest('probe-binding:unbound-action')?.status, 'executing')

// The customer portal commits, then the process dies before the local ledger
// receives the confirmation number.
portal.submit(businessKey, 'CSP-884120')
const restored = ActionLedger.restore(beforeCrash.snapshot(), now)
const hiddenLedgerField = structuredClone(beforeCrash.snapshot())
hiddenLedgerField[0].hiddenExecutionAuthority = true
assert.throws(
  () => ActionLedger.restore(hiddenLedgerField, now),
  /Invalid restored action ledger entry at sequence 1/,
  'durable ActionLedger entries must use a closed schema',
)
const nonCanonicalLedgerTime = structuredClone(beforeCrash.snapshot())
nonCanonicalLedgerTime[0].recordedAt = '2026-08-12T00:00:00Z'
assert.throws(
  () => ActionLedger.restore(nonCanonicalLedgerTime, now),
  /Invalid restored action ledger entry at sequence 1/,
  'durable ActionLedger timestamps must be canonical',
)
const regressingLedgerTime = structuredClone(beforeCrash.snapshot())
regressingLedgerTime[1].recordedAt = '2026-08-11T23:59:59.999Z'
assert.throws(
  () => ActionLedger.restore(regressingLedgerTime, now),
  /Invalid restored action ledger entry at sequence 2/,
  'durable ActionLedger time must not move backwards',
)
const nonStringLedgerIdentity = structuredClone(beforeCrash.snapshot())
nonStringLedgerIdentity[0].actionId = 17
assert.throws(
  () => ActionLedger.restore(nonStringLedgerIdentity, now),
  /Invalid restored action ledger entry at sequence 1/,
  'durable ActionLedger identities must be canonical strings',
)
assert.equal(restored.latest(actionId)?.status, 'executing')
assert.equal(portal.submissionCount, 1)
assert.deepEqual(unresolvedActionEntries(restored.snapshot()).map((entry) => entry.actionId), [actionId])

const ambiguousActions = restored.outcomes(['submit'])
assert(ambiguousActions.some((action) => action.outcome === 'indeterminate'))
assert(!ambiguousActions.some((action) => action.outcome === 'not_performed'))
assert.equal(completionFor('not_performed', ambiguousActions), false)
assert.equal(completionFor('performed', ambiguousActions), false)

const reconciled = await reconcileExternalAction({
  ledger: restored,
  actionId,
  probe: portal,
})
assert.equal(reconciled.resolved, true)
assert.equal(reconciled.verdict.externalReference, 'CSP-884120')
assert.equal(reconciled.ledgerEntry.status, 'committed')
assert.equal(portal.submissionCount, 1, 'recovery must query by business key instead of clicking submit again')
assert.equal(unresolvedActionEntries(restored.snapshot()).length, 0)
assert.equal(completionFor('performed', restored.outcomes(['submit'])), true)

const receiptFailureOrder = []
await assert.rejects(
  () => persistExternalActionReconciliationAttempt({
    store: memoryDurableStore(receiptFailureOrder, { failWrite: true }),
    runId: 'run-receipt-write-fails',
    revision: 1,
    sessionId: 'session-receipt-write-fails',
    action: reconciled.ledgerEntry,
    verdict: reconciled.verdict,
    async persistLedgerEvent() {
      receiptFailureOrder.push('terminal-event')
    },
  }),
  /injected durable receipt failure/,
)
assert.deepEqual(
  receiptFailureOrder,
  ['receipt-write'],
  'a failed durable receipt write must prevent the committed event callback entirely',
)

const eventFailureOrder = []
await assert.rejects(
  () => persistExternalActionReconciliationAttempt({
    store: memoryDurableStore(eventFailureOrder),
    runId: 'run-event-write-fails',
    revision: 1,
    sessionId: 'session-event-write-fails',
    action: reconciled.ledgerEntry,
    verdict: reconciled.verdict,
    async persistLedgerEvent(receipt) {
      assert(receipt, 'the committed event callback must receive the already durable receipt refs')
      eventFailureOrder.push('terminal-event-attempt')
      throw new Error('injected committed event failure')
    },
  }),
  /injected committed event failure/,
)
assert.deepEqual(eventFailureOrder, ['receipt-write', 'terminal-event-attempt'])

const alteredReceiptOrder = []
await assert.rejects(
  () => persistExternalActionReconciliationAttempt({
    store: memoryDurableStore(alteredReceiptOrder, {
      mutateContent(content) {
        return { ...content, businessKey: 'portal:another-tenant:invoice:INV-CN-260601' }
      },
    }),
    runId: 'run-altered-receipt',
    revision: 1,
    sessionId: 'session-altered-receipt',
    action: reconciled.ledgerEntry,
    verdict: reconciled.verdict,
    async persistLedgerEvent() {
      alteredReceiptOrder.push('terminal-event')
    },
  }),
  /receipt content is invalid/,
  'the current process must re-read semantic receipt fields before they become completion evidence',
)
assert.deepEqual(alteredReceiptOrder, ['receipt-write'])

await assert.rejects(
  () => materializeExternalActionReceipt({
    store: {
      async write() { throw new Error('ordinary write must not be reached') },
      async read() { throw new Error('not used') },
      async exists() { return false },
    },
    runId: 'run-nondurable-store',
    revision: 1,
    sessionId: 'session-nondurable-store',
    action: reconciled.ledgerEntry,
    verdict: reconciled.verdict,
  }),
  /EXTERNAL_ACTION_RECEIPT_DURABILITY_REQUIRED/,
  'a committed event must never depend on an artifact store that only buffers ordinary writes',
)

const legacyKey = 'portal:customer-a:invoice:LEGACY-V1'
const legacyV1 = ActionLedger.restore([
  {
    schemaVersion: 'action-ledger-entry/v1',
    sequence: 1,
    actionId: 'legacy-v1-submit',
    actionKind: 'submit',
    toolName: 'browser_click',
    status: 'proposed',
    recordedAt: '2026-08-12T00:00:00.000Z',
    externalBinding: {
      schemaVersion: 'external-action-binding/v1',
      businessKey: legacyKey,
      probeId: portal.id,
    },
  },
  {
    schemaVersion: 'action-ledger-entry/v1',
    sequence: 2,
    actionId: 'legacy-v1-submit',
    actionKind: 'submit',
    toolName: 'browser_click',
    status: 'authorized',
    recordedAt: '2026-08-12T00:00:00.000Z',
    externalBinding: {
      schemaVersion: 'external-action-binding/v1',
      businessKey: legacyKey,
      probeId: portal.id,
    },
  },
  {
    schemaVersion: 'action-ledger-entry/v1',
    sequence: 3,
    actionId: 'legacy-v1-submit',
    actionKind: 'submit',
    toolName: 'browser_click',
    status: 'executing',
    recordedAt: '2026-08-12T00:00:00.000Z',
    externalBinding: {
      schemaVersion: 'external-action-binding/v1',
      businessKey: legacyKey,
      probeId: portal.id,
    },
  },
], now)
portal.submit(legacyKey, 'CSP-LEGACY-1')
assert.equal(
  (await reconcileExternalAction({ ledger: legacyV1, actionId: 'legacy-v1-submit', probe: portal })).ledgerEntry.status,
  'committed',
  'v1 histories must remain recoverable even though they cannot authorize a new replay',
)
assert.throws(
  () => new ActionLedger(now).propose({
    actionId: 'new-action-with-legacy-binding',
    actionKind: 'submit',
    toolName: 'browser_click',
    externalBinding: {
      schemaVersion: 'external-action-binding/v1',
      businessKey: 'portal:customer-a:invoice:NEW-BUT-LEGACY',
      probeId: portal.id,
    },
  }),
  /may be restored but cannot be proposed/i,
  'new actions must never regress to the legacy binding without an effect digest',
)

const toolOnly = new ActionLedger(now)
toolOnly.propose({ actionId: 'tool-only-submit', actionKind: 'submit', toolName: 'browser_click' })
toolOnly.authorize('tool-only-submit')
toolOnly.begin('tool-only-submit')
toolOnly.markExecuted('tool-only-submit', 'The click returned after a visible page change.')
assert.equal(completionFor('performed', toolOnly.outcomes(['submit'])), false)
assert(
  toolOnly.outcomes(['submit']).some((action) => action.outcome === 'indeterminate'),
  'a successful click is not an authoritative business receipt',
)

const failedAfterBoundary = new ActionLedger(now)
failedAfterBoundary.propose({ actionId: 'failed-submit', actionKind: 'submit', toolName: 'browser_click' })
failedAfterBoundary.authorize('failed-submit')
failedAfterBoundary.begin('failed-submit')
failedAfterBoundary.fail('failed-submit', 'The connection closed after the request may have left the process.')
assert(
  failedAfterBoundary.outcomes(['submit']).some((action) => action.outcome === 'indeterminate'),
  'a failed call after the execution boundary must remain indeterminate',
)
assert.equal(completionFor('not_performed', failedAfterBoundary.outcomes(['submit'])), false)

const batch = new ActionLedger(now)
for (const [id, key] of [['batch-a', 'portal:customer-a:invoice:A'], ['batch-b', 'portal:customer-a:invoice:B']]) {
  batch.propose({
    actionId: id,
    actionKind: 'submit',
    toolName: 'browser_click',
    externalBinding: {
      schemaVersion: 'external-action-binding/v2',
      businessKey: key,
      probeId: portal.id,
      effectDigest: EFFECT_DIGEST,
    },
  })
  batch.authorize(id)
  batch.begin(id)
  batch.markExecuted(id)
}
batch.commit('batch-a', 'Receipt A confirmed.')
assert.equal(
  completionFor('performed', batch.outcomes(['submit']), ['portal:customer-a:invoice:A', 'portal:customer-a:invoice:B']),
  false,
  'one confirmed invoice must not complete a batch while another invoice is unresolved',
)
batch.commit('batch-b', 'Receipt B confirmed.')
assert.equal(completionFor('performed', batch.outcomes(['submit']), ['portal:customer-a:invoice:A', 'portal:customer-a:invoice:B']), true)

const mixedBatch = new ActionLedger(now)
for (const [id, key] of [
  ['mixed-a', 'portal:customer-a:invoice:MIXED-A'],
  ['mixed-b', 'portal:customer-a:invoice:MIXED-B'],
]) {
  mixedBatch.propose({
    actionId: id,
    actionKind: 'submit',
    toolName: 'browser_click',
    externalBinding: {
      schemaVersion: 'external-action-binding/v2',
      businessKey: key,
      probeId: portal.id,
      effectDigest: EFFECT_DIGEST,
    },
  })
  mixedBatch.authorize(id)
  mixedBatch.begin(id)
}
mixedBatch.commit('mixed-a', 'Receipt exists.')
mixedBatch.markNotCommitted('mixed-b', 'Authoritative absence proof.')
assert.equal(
  completionFor('performed', mixedBatch.outcomes(['submit'])),
  false,
  'a generic performed boundary must not pass a mixed performed/not-performed batch',
)
assert.equal(
  completionFor('not_performed', mixedBatch.outcomes(['submit'])),
  false,
  'a generic not-performed boundary must not ignore another performed action',
)

const retry = new ActionLedger(now)
for (const id of ['invoice-retry-1', 'invoice-retry-2']) {
  retry.propose({
    actionId: id,
    actionKind: 'submit',
    toolName: 'browser_click',
    externalBinding: {
      schemaVersion: 'external-action-binding/v2',
      businessKey: 'portal:customer-a:invoice:RETRY',
      probeId: portal.id,
      effectDigest: EFFECT_DIGEST,
    },
  })
  retry.authorize(id)
  retry.begin(id)
  if (id.endsWith('1')) retry.markNotCommitted(id, 'Authoritative query proved retry safe.')
  else {
    retry.markExecuted(id)
    retry.commit(id, 'Retry returned receipt.')
  }
}
assert.equal(completionFor('performed', retry.outcomes(['submit']), ['portal:customer-a:invoice:RETRY']), true)
assert.throws(
  () => retry.propose({
    actionId: 'invoice-retry-3-after-commit',
    actionKind: 'submit',
    toolName: 'browser_click',
    externalBinding: {
      schemaVersion: 'external-action-binding/v2',
      businessKey: 'portal:customer-a:invoice:RETRY',
      probeId: portal.id,
      effectDigest: EFFECT_DIGEST,
    },
  }),
  /cannot be reproposed from committed/i,
  'a confirmed logical action must never be superseded by a later retry record',
)
assert.throws(
  () => retry.propose({
    actionId: 'invoice-retry-with-changed-effect',
    actionKind: 'submit',
    toolName: 'browser_click',
    externalBinding: {
      schemaVersion: 'external-action-binding/v2',
      businessKey: 'portal:customer-a:invoice:RETRY',
      probeId: portal.id,
      effectDigest: 'd'.repeat(64),
    },
  }),
  /changed its effect digest/i,
  'one business key must never silently alias a changed external effect',
)

const restoredReproposal = structuredClone(retry.snapshot())
restoredReproposal.push({
  schemaVersion: 'action-ledger-entry/v1',
  sequence: restoredReproposal.length + 1,
  actionId: 'forged-retry-after-commit',
  actionKind: 'submit',
  toolName: 'browser_click',
  status: 'proposed',
  recordedAt: '2026-08-12T00:00:01.000Z',
  externalBinding: {
    schemaVersion: 'external-action-binding/v2',
    businessKey: 'portal:customer-a:invoice:RETRY',
    probeId: portal.id,
    effectDigest: EFFECT_DIGEST,
  },
})
assert.throws(
  () => ActionLedger.restore(restoredReproposal, now),
  /reproposed from committed/i,
  'restoration must reject histories that overwrite a confirmed logical action with a fresh attempt',
)

const absent = new ActionLedger(now)
absent.propose({
  actionId: 'absent-submit',
  actionKind: 'submit',
  toolName: 'browser_click',
  externalBinding: {
    schemaVersion: 'external-action-binding/v2',
    businessKey: 'portal:customer-a:invoice:INV-CN-DOES-NOT-EXIST',
    probeId: portal.id,
    effectDigest: '3'.repeat(64),
  },
})
absent.authorize('absent-submit')
absent.begin('absent-submit')
absent.markAmbiguous('absent-submit', 'Connection closed without a result.')
const absentResult = await reconcileExternalAction({
  ledger: absent,
  actionId: 'absent-submit',
  businessKey: 'portal:customer-a:invoice:INV-CN-DOES-NOT-EXIST',
  probe: portal,
})
assert.equal(absentResult.ledgerEntry.status, 'not_committed')
assert.equal(completionFor('not_performed', absent.outcomes(['submit'])), true)

const eventuallyConsistent = new ActionLedger(now)
eventuallyConsistent.propose({
  actionId: 'eventual-submit',
  actionKind: 'submit',
  toolName: 'browser_click',
  externalBinding: {
    schemaVersion: 'external-action-binding/v2',
    businessKey: 'portal:customer-a:invoice:INV-CN-EVENTUAL',
    probeId: 'eventually-consistent-index/v1',
    effectDigest: '4'.repeat(64),
  },
})
eventuallyConsistent.authorize('eventual-submit')
await assert.rejects(
  reconcileExternalAction({
    ledger: eventuallyConsistent,
    actionId: 'eventual-submit',
    businessKey: 'portal:customer-a:invoice:INV-CN-EVENTUAL',
    probe: {
      schemaVersion: 'external-action-probe/v1',
      id: 'eventually-consistent-index/v1',
      authority: 'read_only',
      async reconcile(request) {
        return verdict({
          actionId: request.action.actionId,
          businessKey: request.businessKey,
          state: 'not_committed',
          verifier: this.id,
          independentlyObserved: true,
          evidenceIds: ['eventual-index:empty'],
          retrySafe: false,
        })
      },
    },
  }),
  /prove that retry is safe/i,
)

const spoofed = new ActionLedger(now)
spoofed.propose({
  actionId: 'spoofed-submit',
  actionKind: 'submit',
  toolName: 'browser_click',
  externalBinding: {
    schemaVersion: 'external-action-binding/v2',
    businessKey: 'portal:customer-a:invoice:INV-CN-SPOOFED',
    probeId: 'spoofed-probe/v1',
    effectDigest: '5'.repeat(64),
  },
})
spoofed.authorize('spoofed-submit')
await assert.rejects(
  reconcileExternalAction({
    ledger: spoofed,
    actionId: 'spoofed-submit',
    businessKey: 'portal:customer-a:invoice:INV-CN-SPOOFED',
    probe: {
      schemaVersion: 'external-action-probe/v1',
      id: 'spoofed-probe/v1',
      authority: 'read_only',
      async reconcile() {
        return verdict({
          actionId: 'spoofed-submit',
          businessKey: 'portal:customer-a:invoice:INV-CN-SPOOFED',
          state: 'committed',
          verifier: this.id,
          independentlyObserved: false,
          evidenceIds: [],
          externalReference: 'page-text-says-success',
        })
      },
    },
  }),
  /requires independent evidence/i,
)

const contradictory = new ActionLedger(now)
contradictory.propose({
  actionId: 'contradictory-submit',
  actionKind: 'submit',
  toolName: 'browser_click',
  externalBinding: {
    schemaVersion: 'external-action-binding/v2',
    businessKey: 'portal:customer-a:invoice:INV-CN-CONTRADICTORY',
    probeId: 'contradictory-probe/v1',
    effectDigest: '6'.repeat(64),
  },
})
contradictory.authorize('contradictory-submit')
await assert.rejects(
  reconcileExternalAction({
    ledger: contradictory,
    actionId: 'contradictory-submit',
    businessKey: 'portal:customer-a:invoice:INV-CN-CONTRADICTORY',
    probe: {
      schemaVersion: 'external-action-probe/v1',
      id: 'contradictory-probe/v1',
      authority: 'read_only',
      async reconcile() {
        return verdict({
          actionId: 'contradictory-submit',
          businessKey: 'portal:customer-a:invoice:INV-CN-CONTRADICTORY',
          state: 'not_committed',
          verifier: this.id,
          independentlyObserved: true,
          evidenceIds: ['absence:1'],
          externalReference: 'receipt-that-contradicts-absence',
          retrySafe: true,
        })
      },
    },
  }),
  /not_committed verdict cannot carry an externalReference/i,
)

const stale = new ActionLedger(() => new Date('2026-08-12T00:10:00.000Z'))
stale.propose({
  actionId: 'stale-submit',
  actionKind: 'submit',
  toolName: 'browser_click',
  externalBinding: {
    schemaVersion: 'external-action-binding/v2',
    businessKey: 'portal:customer-a:invoice:INV-CN-STALE',
    probeId: 'stale-probe/v1',
    effectDigest: '7'.repeat(64),
  },
})
stale.authorize('stale-submit')
await assert.rejects(
  reconcileExternalAction({
    ledger: stale,
    actionId: 'stale-submit',
    businessKey: 'portal:customer-a:invoice:INV-CN-STALE',
    probe: {
      schemaVersion: 'external-action-probe/v1',
      id: 'stale-probe/v1',
      authority: 'read_only',
      async reconcile() {
        return verdict({
          actionId: 'stale-submit',
          businessKey: 'portal:customer-a:invoice:INV-CN-STALE',
          state: 'committed',
          observedAt: '2026-08-12T00:09:59.000Z',
          verifier: this.id,
          independentlyObserved: true,
          evidenceIds: ['receipt:from-before-this-action'],
          externalReference: 'CSP-STALE',
        })
      },
    },
  }),
  /predates the latest durable action state/i,
)

const tamperedEntries = structuredClone(beforeCrash.snapshot())
tamperedEntries[1].externalBinding.businessKey = 'portal:customer-a:invoice:DIFFERENT'
assert.throws(
  () => ActionLedger.restore(tamperedEntries, now),
  /identity changed/i,
  'restoration must reject a business-key change within one action history',
)

const authorizedHistory = new ActionLedger(now)
authorizedHistory.propose({ actionId: 'authorization-tamper', actionKind: 'submit', toolName: 'browser_click' })
authorizedHistory.authorize(
  'authorization-tamper',
  'Exact approval.',
  {
    schemaVersion: 'action-decision-ref/v1',
    source: 'human_gate',
    decisionRef: 'approval:original',
    actionBindingSha256: 'e'.repeat(64),
  },
)
authorizedHistory.begin('authorization-tamper')
const tamperedAuthorization = structuredClone(authorizedHistory.snapshot())
tamperedAuthorization.at(-1).actionDecision.decisionRef = 'approval:forged'
assert.throws(
  () => ActionLedger.restore(tamperedAuthorization, now),
  /authorization changed/i,
  'restoration must reject an approval reference that changes after authorization',
)

assert.throws(
  () => new ActionLedger(now).propose({
    actionId: 'non-canonical-binding',
    actionKind: 'submit',
    toolName: 'browser_click',
    externalBinding: {
      schemaVersion: 'external-action-binding/v2',
      businessKey: ' portal:customer-a:invoice:WHITESPACE ',
      probeId: portal.id,
      effectDigest: EFFECT_DIGEST,
    },
  }),
  /invalid external reconciliation binding/i,
)

let unsafeProbeCalls = 0
await assert.rejects(
  reconcileExternalAction({
    ledger: restored,
    actionId,
    probe: {
      schemaVersion: 'external-action-probe/v1',
      id: portal.id,
      authority: 'browser_write',
      async reconcile() {
        unsafeProbeCalls += 1
        throw new Error('an unsafe recovery adapter must never run')
      },
    },
  }),
  /read_only external-action-probe\/v1 contract/i,
  'a recovery adapter with write authority must fail before it can touch the portal',
)
assert.equal(unsafeProbeCalls, 0)
assert.throws(
  () => externalActionProbeById([portal, portal], portal.id),
  /registered more than once/i,
  'a duplicate adapter id must not be resolved by array order',
)

  console.log('action-reconciliation-test: PASS (crash window reconciled without duplicate submission)')
}

class FakeInvoicePortal {
  #receipts = new Map()
  schemaVersion = 'external-action-probe/v1'
  id = 'fake-invoice-portal-query/v1'
  authority = 'read_only'
  submissionCount = 0

  submit(key, confirmation) {
    this.submissionCount += 1
    if (this.#receipts.has(key)) throw new Error(`Duplicate invoice submission: ${key}`)
    this.#receipts.set(key, confirmation)
  }

  async reconcile(request) {
    const confirmation = this.#receipts.get(request.businessKey)
    return confirmation
      ? verdict({
          actionId: request.action.actionId,
          businessKey: request.businessKey,
          state: 'committed',
          independentlyObserved: true,
          evidenceIds: [`receipt:${confirmation}`],
          externalReference: confirmation,
          ...(request.action.externalBinding?.schemaVersion === 'external-action-binding/v2'
            ? { observedEffectDigest: request.action.externalBinding.effectDigest }
            : {}),
          summary: 'Portal receipt query found the invoice confirmation number.',
        })
      : verdict({
          actionId: request.action.actionId,
          businessKey: request.businessKey,
          state: 'not_committed',
          independentlyObserved: true,
          evidenceIds: [`portal-query:${request.businessKey}:absent`],
          retrySafe: true,
          summary: 'Authoritative portal query found no invoice record for the business key.',
        })
  }
}

function verdict(overrides) {
  return {
    schemaVersion: 'external-action-reconciliation/v1',
    actionId: 'action',
    businessKey: 'business-key',
    state: 'ambiguous',
    observedAt: '2026-08-12T00:01:00.000Z',
    verifier: 'fake-invoice-portal-query/v1',
    independentlyObserved: false,
    evidenceIds: [],
    summary: 'The external state remains ambiguous.',
    ...overrides,
  }
}

function memoryDurableStore(order, options = {}) {
  let envelope
  return {
    async write() {
      throw new Error('ordinary write must not be used for an external receipt')
    },
    async writeDurably(input) {
      order.push('receipt-write')
      if (options.failWrite) throw new Error('injected durable receipt failure')
      const content = options.mutateContent ? options.mutateContent(input.content) : input.content
      const mediaType = input.mediaType ?? 'application/json'
      const bytes = Buffer.from(JSON.stringify(content) ?? 'null', 'utf8')
      const ref = {
        schemaVersion: 'tool-result-artifact-ref/v1',
        artifactId: `memory-artifact-${order.length}`,
        runId: input.runId,
        sessionId: input.sessionId,
        toolCallId: input.toolCallId,
        toolName: input.toolName,
        kind: input.kind,
        uri: `memory:${input.toolCallId}`,
        mediaType,
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        createdAt: '2026-08-12T00:02:00.000Z',
        retention: {
          scope: input.retention?.scope ?? 'run',
          deleteWithSession: input.retention?.deleteWithSession ?? true,
        },
        sensitivity: input.sensitivity ?? 'internal',
        redaction: { status: 'not_needed' },
      }
      envelope = {
        schemaVersion: 'stored-tool-result/v1',
        ref,
        content,
      }
      return ref
    },
    async read(ref) {
      assert(envelope)
      assert.equal(ref.artifactId, envelope.ref.artifactId)
      return structuredClone(envelope)
    },
    async exists() {
      return true
    },
  }
}

function completionFor(outcome, actions, businessKeys) {
  return evaluateCompletionContract({
    contract: {
      schemaVersion: 'web-task-contract/v1',
      contractId: `invoice-${outcome}`,
      revision: 0,
      criteria: [{
        id: `submit-${outcome}`,
        kind: 'action_boundary',
        description: `Invoice submit must be ${outcome}.`,
        actionKinds: ['submit'],
        outcome,
        ...(businessKeys ? { businessKeys } : {}),
      }],
    },
    runId: 'invoice-reconciliation-run',
    revision: 0,
    evidence: [],
    artifacts: [],
    actions,
  }).completed
}

await main()
