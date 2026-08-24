#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { browserOpen } from '../dist/browser/open.js'
import { observationManager } from '../dist/observation/observation-manager.js'
import { ApprovalQueue } from '../dist/permission/index.js'
import { runAgentLoop } from '../dist/runtime/local/agent-loop.js'
import { ToolRegistry } from '../dist/runtime/local/tool-registry.js'
import { FileSessionRecorder, FileSessionStore, readJsonLines } from '../dist/session/index.js'
import { sessionManager } from '../dist/session/manager.js'
import { TraceRecorder } from '../dist/sdk/trace.js'
import { ActionLedger } from '../dist/task/action-ledger.js'

class OneActionLlm {
  constructor(call) {
    this.hasKey = true
    this.label = 'invoice-single-action-fixture-llm'
    this.call = call
    this.turn = 0
  }

  async chatWithTools() {
    this.turn += 1
    return this.turn === 1
      ? { content: 'Requesting the exact invoice submit.', toolCalls: [this.call] }
      : { content: 'The deterministic Runtime evidence decides completion.', toolCalls: [] }
  }
}

class TwoActionLlm {
  constructor(calls) {
    this.hasKey = true
    this.label = 'invoice-two-action-fixture-llm'
    this.calls = calls
    this.turn = 0
  }

  async chatWithTools() {
    this.turn += 1
    return this.turn === 1
      ? { content: 'Requesting two exact invoice submits in one model turn.', toolCalls: this.calls }
      : { content: 'The deterministic Runtime evidence decides completion.', toolCalls: [] }
  }
}

class CountingLlm {
  constructor() {
    this.hasKey = true
    this.label = 'counting-fixture-llm'
    this.callCount = 0
  }

  async chatWithTools() {
    this.callCount += 1
    return { content: 'This model call should have been blocked by bootstrap reconciliation.', toolCalls: [] }
  }
}

class ExactExecutionGate {
  constructor() {
    this.requests = []
  }

  async confirm(kind, message, context) {
    this.requests.push({ kind, message, context })
    return 'approve_and_execute'
  }
}

const root = await mkdtemp(join(tmpdir(), 'web-buddy-invoice-runtime-single-'))
const sessionId = 'invoice-runtime-single-action'
const runId = 'invoice-runtime-single-action-run'
const invoiceId = 'INV-CN-EXECUTE-1'
const businessKey = `portal:customer-a:invoice:${invoiceId}`
const probeId = 'invoice-runtime-receipt-query/v1'
const receipts = new Map()
const toolCalls = []
const probeCalls = []
let durableProposalObservedBeforeFirstQuery = false
const queue = new ApprovalQueue()
const gate = new ExactExecutionGate()
const trace = new TraceRecorder(join(root, 'trace'), {
  runId,
  source: 'local-runtime',
  scenario: 'invoice-runtime-single-action',
  profile: 'deterministic-fixture',
  goal: 'Submit one exact invoice with durable execution authorization and independent reconciliation.',
})
const sessions = new FileSessionStore({ rootDir: join(root, 'sessions') })

try {
  await openFixture()
  seedObservation()
  const session = await sessions.create({
    sessionId,
    runId,
    source: 'test',
    goal: 'Submit one exact invoice with durable execution authorization and independent reconciliation.',
    mode: 'invoice-runtime-single-action',
    traceRunId: runId,
  })
  const recorder = new FileSessionRecorder(sessions, session)
  const probe = {
    schemaVersion: 'external-action-probe/v1',
    id: probeId,
    authority: 'read_only',
    async reconcile(request) {
      const confirmation = receipts.get(request.businessKey)
      probeCalls.push({
        businessKey: request.businessKey,
        actionStatus: request.action.status,
        observedState: confirmation ? 'committed' : 'not_committed',
      })
      if (!confirmation
        && request.businessKey === businessKey
        && request.action.status === 'proposed') {
        const durableEvents = await readJsonLines(session.eventsPath)
        durableProposalObservedBeforeFirstQuery = durableEvents.some((event) => (
          event.type === 'action_ledger_updated'
          && event.data?.entry?.actionId === request.action.actionId
          && event.data?.entry?.status === 'proposed'
        ))
      }
      return {
        schemaVersion: 'external-action-reconciliation/v1',
        actionId: request.action.actionId,
        businessKey: request.businessKey,
        state: confirmation ? 'committed' : 'not_committed',
        observedAt: new Date().toISOString(),
        verifier: this.id,
        independentlyObserved: true,
        evidenceIds: [confirmation ? `receipt:${confirmation}` : `query:${request.businessKey}:absent`],
        ...(confirmation ? { externalReference: confirmation } : { retrySafe: true }),
        ...(confirmation && request.action.externalBinding?.schemaVersion === 'external-action-binding/v2'
          ? { observedEffectDigest: request.action.externalBinding.effectDigest }
          : {}),
        summary: confirmation
          ? 'The controlled portal receipt registry contains the exact invoice confirmation.'
          : 'The controlled portal authoritatively reports that the exact invoice is absent.',
      }
    },
  }
  const registry = new ToolRegistry([{
    name: 'browser_click',
    description: 'Controlled opaque final-submit control.',
    category: 'action',
    parameters: { type: 'object', properties: {} },
    inherentRisk: 'L1',
    async run(args) {
      toolCalls.push(structuredClone(args))
      receipts.set(businessKey, 'CSP-INVOICE-EXECUTE-1')
      return {
        observation: 'The controlled invoice portal accepted the exact invoice.',
        pageChanged: true,
      }
    },
  }])
  const sinkRule = {
    id: 'invoice-submit-requires-exact-execution-approval',
    actionKinds: ['submit'],
    decision: 'ask',
    destinationOrigins: ['https://example.test'],
    requireApprovalBinding: true,
  }
  const taskContract = {
    schemaVersion: 'web-task-contract/v1',
    contractId: 'invoice-runtime-single-action',
    revision: 0,
    criteria: [
      {
        id: 'invoice-committed',
        kind: 'action_boundary',
        description: 'The exact invoice business key is independently committed.',
        actionKinds: ['submit'],
        outcome: 'performed',
        businessKeys: [businessKey],
      },
      {
        id: 'invoice-receipt-present',
        kind: 'artifact_present',
        description: 'The committed invoice has an immutable external receipt.',
        artifactKinds: ['external_action_receipt'],
        schemaVersions: ['external-action-receipt/v1'],
        minCount: 1,
        businessKeys: [businessKey],
      },
    ],
    sensitiveActions: [sinkRule],
  }
  const taskPolicy = {
    schemaVersion: 'task-policy/v1',
    defaultSensitiveAction: 'deny',
    rules: [sinkRule],
  }
  const externalActionIntentResolver = (request) => ({
    schemaVersion: 'external-action-intent/v1',
    actionKind: 'submit',
    binding: {
      schemaVersion: 'external-action-binding/v2',
      businessKey: `portal:customer-a:invoice:${request.args.invoiceId}`,
      probeId,
      effectPayload: {
        invoiceId: request.args.invoiceId,
        amount: request.args.amount,
        operation: 'submit_invoice',
      },
    },
  })
  const result = await runAgentLoop({
    goal: 'Submit exactly one invoice and prove the portal result.',
    llm: new OneActionLlm({
      id: 'submit-exact-invoice',
      name: 'browser_click',
      arguments: { ref: 'e1', invoiceId, amount: 48_600 },
    }),
    registry,
    ctx: { sessionId, highlight: false, trace },
    gate,
    approvalQueue: queue,
    session: recorder,
    sessionRef: sessionRefFor(sessionId, runId),
    maxSteps: 3,
    safetyMode: 'guarded',
    allowFinalSubmit: true,
    allowExternalActionExecution: true,
    requireExternalActionReconciliation: true,
    preflightExternalActions: true,
    taskContract,
    taskPolicy,
    externalActionIntentResolver,
    externalActionProbes: [probe],
  })

  const events = await readJsonLines(session.eventsPath)
  const ledgerStatuses = events
    .filter((event) => event.type === 'action_ledger_updated' && event.data?.entry?.actionKind === 'submit')
    .map((event) => event.data.entry.status)
  const committed = events.find((event) => (
    event.type === 'action_ledger_updated'
    && event.data?.entry?.actionKind === 'submit'
    && event.data?.entry?.status === 'committed'
  ))
  const approval = queue.snapshot().approved[0]
  const proposedEventIndex = events.findIndex((event) => (
    event.type === 'action_ledger_updated' && event.data?.entry?.status === 'proposed'
  ))
  const policyEventIndex = events.findIndex((event) => event.type === 'policy_evaluated')
  const preflightEventIndex = events.findIndex((event) => event.type === 'external_action_preflight')
  const approvalEventIndex = events.findIndex((event) => event.type === 'human_gate_requested')

  assert.deepEqual(ledgerStatuses, ['proposed', 'authorized', 'executing', 'executed', 'committed'])
  assert(policyEventIndex >= 0 && policyEventIndex < proposedEventIndex)
  assert(proposedEventIndex < preflightEventIndex)
  assert(preflightEventIndex < approvalEventIndex)
  assert.equal(events[preflightEventIndex]?.data?.verdict?.state, 'not_committed')
  assert.equal(approval?.resolution?.decision, 'approve_and_execute')
  assert.deepEqual(approval?.allowedDecisions, ['approve', 'approve_and_execute', 'decline', 'takeover'])
  assert.equal(
    approval?.context?.externalEffectPreview,
    '{"amount":48600,"invoiceId":"INV-CN-EXECUTE-1","operation":"submit_invoice"}',
  )
  assert.equal(approval?.risk, 'L3')
  assert.equal(toolCalls.length, 1)
  assert.deepEqual(probeCalls.map((call) => call.observedState), ['not_committed', 'committed'])
  assert.equal(durableProposalObservedBeforeFirstQuery, true)
  assert.equal(committed?.data?.reconciliation?.externalReference, 'CSP-INVOICE-EXECUTE-1')
  assert.equal(committed?.data?.receiptArtifact?.kind, 'external_action_receipt')
  assert.equal(result.done, true)
  assert.equal(result.blocked, false)
  assert.equal(result.workflowState?.humanHandoffRequired, undefined)
  assert(result.actions?.some((action) => (
    action.actionKind === 'submit'
    && action.outcome === 'performed'
    && action.businessKey === businessKey
    && action.localExecutionAttempted === true
  )))

  const secondRun = await runAlreadyCommittedScenario({
    root,
    sessions,
    probe,
    taskContract,
    taskPolicy,
    externalActionIntentResolver,
  })
  assert.deepEqual(probeCalls.map((call) => call.observedState), [
    'not_committed',
    'committed',
    'committed',
  ])
  const wrongTargetRun = await runCommittedWrongTargetScenario({
    root,
    sessions,
    probe,
    taskContract,
    taskPolicy,
    externalActionIntentResolver,
  })
  const sameTurnBatchRun = await runTwoActionsSameTurnScenario({ root, sessions })
  const ambiguousAfterExecutionRun = await runAmbiguousAfterExecutionBatchScenario({ root, sessions })
  const ambiguousBootstrapRun = await runAmbiguousBootstrapScenario({ root, sessions })
  const ambiguousRun = await runAmbiguousPreflightScenario({ root, sessions })

  console.log(JSON.stringify({
    schemaVersion: 'invoice-runtime-single-action-evidence/v1',
    fixture: true,
    businessKey,
    approval: {
      allowedDecisions: approval.allowedDecisions,
      decision: approval.resolution.decision,
      effectiveRisk: approval.risk,
    },
    toolInvocationCount: toolCalls.length,
    authoritativeProbeStates: probeCalls.map((call) => call.observedState),
    durableProposalVisibleBeforePreflight: durableProposalObservedBeforeFirstQuery,
    durableOrder: ['policy:gated', 'proposed', 'preflight:not_committed', 'approval_requested'],
    ledgerStatuses,
    externalReference: committed.data.reconciliation.externalReference,
    receiptArtifactKind: committed.data.receiptArtifact.kind,
    completion: {
      done: result.done,
      blocked: result.blocked,
      workflowPhase: result.workflowState?.phase,
      humanHandoffRequired: Boolean(result.workflowState?.humanHandoffRequired),
    },
    freshRunForSameBusinessKey: secondRun,
    committedWrongBusinessKey: wrongTargetRun,
    twoActionsInOneModelTurn: sameTurnBatchRun,
    ambiguousAfterExecution: ambiguousAfterExecutionRun,
    ambiguousBootstrap: ambiguousBootstrapRun,
    ambiguousPreflight: ambiguousRun,
  }, null, 2))
} finally {
  trace.finish()
  await sessionManager.closeAll().catch(() => {})
  await rm(root, { recursive: true, force: true })
}

async function runAlreadyCommittedScenario({
  root: evidenceRoot,
  sessions: sessionStore,
  probe,
  taskContract,
  taskPolicy,
  externalActionIntentResolver,
}) {
  const nextSessionId = 'invoice-runtime-fresh-run-same-key'
  const nextRunId = 'invoice-runtime-fresh-run-same-key-run'
  const nextTrace = new TraceRecorder(join(evidenceRoot, 'trace-fresh-run'), {
    runId: nextRunId,
    source: 'local-runtime',
    scenario: 'invoice-runtime-fresh-run-same-business-key',
    profile: 'deterministic-fixture',
    goal: 'Suppress a sequential duplicate from a fresh Run using authoritative preflight.',
  })
  try {
    await openFixture(nextSessionId)
    seedObservation(nextSessionId)
    const nextSession = await sessionStore.create({
      sessionId: nextSessionId,
      runId: nextRunId,
      source: 'test',
      goal: 'Suppress a sequential duplicate from a fresh Run using authoritative preflight.',
      mode: 'invoice-runtime-fresh-run-same-business-key',
      traceRunId: nextRunId,
    })
    const recorder = new FileSessionRecorder(sessionStore, nextSession)
    const duplicateToolCalls = []
    const nextQueue = new ApprovalQueue()
    const nextGate = new ExactExecutionGate()
    const nextRegistry = new ToolRegistry([{
      name: 'browser_click',
      description: 'This side effect must never run for an already committed business key.',
      category: 'action',
      parameters: { type: 'object', properties: {} },
      inherentRisk: 'L1',
      async run(args) {
        duplicateToolCalls.push(structuredClone(args))
        throw new Error('duplicate side effect invoked')
      },
    }])
    const result = await runAgentLoop({
      goal: 'Submit exactly one invoice and prove the portal result.',
      llm: new OneActionLlm({
        id: 'submit-exact-invoice-again',
        name: 'browser_click',
        arguments: { ref: 'e1', invoiceId, amount: 48_600 },
      }),
      registry: nextRegistry,
      ctx: { sessionId: nextSessionId, highlight: false, trace: nextTrace },
      gate: nextGate,
      approvalQueue: nextQueue,
      session: recorder,
      sessionRef: sessionRefFor(nextSessionId, nextRunId),
      maxSteps: 3,
      safetyMode: 'guarded',
      allowFinalSubmit: true,
      allowExternalActionExecution: true,
      requireExternalActionReconciliation: true,
      preflightExternalActions: true,
      taskContract,
      taskPolicy,
      externalActionIntentResolver,
      externalActionProbes: [probe],
    })
    const events = await readJsonLines(nextSession.eventsPath)
    const ledgerStatuses = events
      .filter((event) => event.type === 'action_ledger_updated' && event.data?.entry?.actionKind === 'submit')
      .map((event) => event.data.entry.status)
    const committed = events.find((event) => (
      event.type === 'action_ledger_updated'
      && event.data?.entry?.actionKind === 'submit'
      && event.data?.entry?.status === 'committed'
    ))
    const approvals = nextQueue.snapshot()
    const preflightEventIndex = events.findIndex((event) => event.type === 'external_action_preflight')
    const committedEventIndex = events.findIndex((event) => (
      event.type === 'action_ledger_updated' && event.data?.entry?.status === 'committed'
    ))

    assert.deepEqual(ledgerStatuses, ['proposed', 'committed'])
    assert(preflightEventIndex >= 0 && preflightEventIndex < committedEventIndex)
    assert.equal(events[preflightEventIndex]?.data?.verdict?.state, 'committed')
    assert.equal(duplicateToolCalls.length, 0)
    assert.equal(nextGate.requests.length, 0)
    assert.equal(approvals.pending.length, 0)
    assert.equal(approvals.approved.length, 0)
    assert.equal(result.done, true)
    assert.equal(result.blocked, false)
    assert.equal(committed?.data?.reconciliation?.externalReference, 'CSP-INVOICE-EXECUTE-1')
    assert.equal(committed?.data?.receiptArtifact?.kind, 'external_action_receipt')
    assert(result.actions?.some((action) => (
      action.actionKind === 'submit'
      && action.outcome === 'performed'
      && action.businessKey === businessKey
      && action.localExecutionAttempted === false
    )))
    assert.equal(result.actions?.some((action) => (
      action.actionKind === 'submit'
      && action.outcome === 'approved'
      && action.businessKey === businessKey
    )), false)

    return {
      authoritativePreflightState: 'committed',
      approvalRequestCount: nextGate.requests.length,
      toolInvocationCount: duplicateToolCalls.length,
      ledgerStatuses,
      externalReference: committed.data.reconciliation.externalReference,
      receiptArtifactKind: committed.data.receiptArtifact.kind,
      completion: { done: result.done, blocked: result.blocked },
    }
  } finally {
    nextTrace.finish()
  }
}

async function runCommittedWrongTargetScenario({
  root: evidenceRoot,
  sessions: sessionStore,
  probe,
  taskContract,
  taskPolicy,
  externalActionIntentResolver,
}) {
  const targetInvoiceId = 'INV-CN-DIFFERENT-TARGET'
  const targetBusinessKey = `portal:customer-a:invoice:${targetInvoiceId}`
  const targetSessionId = 'invoice-runtime-committed-wrong-target'
  const targetRunId = 'invoice-runtime-committed-wrong-target-run'
  const targetTrace = new TraceRecorder(join(evidenceRoot, 'trace-committed-wrong-target'), {
    runId: targetRunId,
    source: 'local-runtime',
    scenario: 'invoice-runtime-committed-wrong-target',
    profile: 'deterministic-fixture',
    goal: 'Do not confuse a real receipt for the wrong invoice with completion of the current contract.',
  })
  try {
    await openFixture(targetSessionId)
    seedObservation(targetSessionId)
    const targetSession = await sessionStore.create({
      sessionId: targetSessionId,
      runId: targetRunId,
      source: 'test',
      goal: 'Do not confuse a real receipt for the wrong invoice with completion of the current contract.',
      mode: 'invoice-runtime-committed-wrong-target',
      traceRunId: targetRunId,
    })
    const recorder = new FileSessionRecorder(sessionStore, targetSession)
    const targetQueue = new ApprovalQueue()
    const targetGate = new ExactExecutionGate()
    const forbiddenToolCalls = []
    const targetRegistry = new ToolRegistry([{
      name: 'browser_click',
      description: 'The wrong already-committed action must remain a no-op.',
      category: 'action',
      parameters: { type: 'object', properties: {} },
      inherentRisk: 'L1',
      async run(args) {
        forbiddenToolCalls.push(structuredClone(args))
        throw new Error('wrong-target preflight invoked the side effect')
      },
    }])
    const targetContract = {
      ...structuredClone(taskContract),
      contractId: 'invoice-runtime-committed-wrong-target',
      criteria: taskContract.criteria.map((criterion) => (
        criterion.kind === 'action_boundary' || criterion.kind === 'artifact_present'
          ? { ...structuredClone(criterion), businessKeys: [targetBusinessKey] }
          : structuredClone(criterion)
      )),
    }
    const result = await runAgentLoop({
      goal: `Submit ${targetInvoiceId}, not any other invoice.`,
      llm: new OneActionLlm({
        id: 'submit-already-committed-wrong-invoice',
        name: 'browser_click',
        arguments: { ref: 'e1', invoiceId, amount: 48_600 },
      }),
      registry: targetRegistry,
      ctx: { sessionId: targetSessionId, highlight: false, trace: targetTrace },
      gate: targetGate,
      approvalQueue: targetQueue,
      session: recorder,
      sessionRef: sessionRefFor(targetSessionId, targetRunId),
      maxSteps: 3,
      safetyMode: 'guarded',
      allowFinalSubmit: true,
      allowExternalActionExecution: true,
      requireExternalActionReconciliation: true,
      preflightExternalActions: true,
      taskContract: targetContract,
      taskPolicy,
      externalActionIntentResolver,
      externalActionProbes: [probe],
    })
    const events = await readJsonLines(targetSession.eventsPath)
    const preflight = events.find((event) => event.type === 'external_action_preflight')
    const toolBoundCompletionGate = events.find((event) => (
      event.type === 'completion_gate_evaluated'
      && event.toolCallId === 'submit-already-committed-wrong-invoice'
    ))
    const approvals = targetQueue.snapshot()

    assert.equal(preflight?.data?.verdict?.state, 'committed')
    assert.equal(toolBoundCompletionGate?.data?.action, 'reject')
    assert.match(String(toolBoundCompletionGate?.data?.reason), /invoice-committed|invoice-receipt-present/)
    assert.equal(forbiddenToolCalls.length, 0)
    assert.equal(targetGate.requests.length, 0)
    assert.equal(approvals.pending.length, 0)
    assert.equal(approvals.approved.length, 0)
    assert.equal(result.done, true)
    assert.equal(result.blocked, true)
    assert.match(result.summary, /invoice-committed|invoice-receipt-present/)
    assert.equal(result.actions?.some((action) => (
      action.businessKey === targetBusinessKey && action.outcome === 'performed'
    )), false)
    assert(result.actions?.some((action) => (
      action.businessKey === businessKey
      && action.outcome === 'performed'
      && action.localExecutionAttempted === false
    )))

    return {
      authoritativePreflightState: 'committed',
      observedBusinessKey: businessKey,
      requiredBusinessKey: targetBusinessKey,
      completionGateAction: toolBoundCompletionGate.data.action,
      approvalRequestCount: targetGate.requests.length,
      toolInvocationCount: forbiddenToolCalls.length,
      taskCompleted: result.done && !result.blocked,
      terminalStatus: result.blocked ? 'blocked' : 'completed',
    }
  } finally {
    targetTrace.finish()
  }
}

async function runTwoActionsSameTurnScenario({ root: evidenceRoot, sessions: sessionStore }) {
  const invoiceIds = ['INV-CN-BATCH-A', 'INV-CN-BATCH-B']
  const businessKeys = invoiceIds.map((id) => `portal:customer-a:invoice:${id}`)
  const batchProbeId = 'invoice-runtime-batch-query/v1'
  const targetSessionId = 'invoice-runtime-two-actions-one-turn'
  const targetRunId = 'invoice-runtime-two-actions-one-turn-run'
  const targetTrace = new TraceRecorder(join(evidenceRoot, 'trace-two-actions-one-turn'), {
    runId: targetRunId,
    source: 'local-runtime',
    scenario: 'invoice-runtime-two-actions-one-turn',
    profile: 'deterministic-fixture',
    goal: 'Serialize two external invoice submits emitted in one model turn.',
  })
  try {
    await openFixture(targetSessionId)
    seedObservation(targetSessionId)
    const targetSession = await sessionStore.create({
      sessionId: targetSessionId,
      runId: targetRunId,
      source: 'test',
      goal: 'Serialize two external invoice submits emitted in one model turn.',
      mode: 'invoice-runtime-two-actions-one-turn',
      traceRunId: targetRunId,
    })
    const recorder = new FileSessionRecorder(sessionStore, targetSession)
    const targetQueue = new ApprovalQueue()
    const targetGate = new ExactExecutionGate()
    const batchReceipts = new Map()
    const operationOrder = []
    const targetRegistry = new ToolRegistry([{
      name: 'browser_click',
      description: 'Controlled final-submit control for two ordered invoices.',
      category: 'action',
      parameters: { type: 'object', properties: {} },
      inherentRisk: 'L1',
      async run(args) {
        operationOrder.push(`tool:${args.invoiceId}`)
        batchReceipts.set(`portal:customer-a:invoice:${args.invoiceId}`, `CSP-${args.invoiceId}`)
        return {
          observation: `The controlled portal accepted ${args.invoiceId}.`,
          pageChanged: false,
        }
      },
    }])
    const sinkRule = {
      id: 'batch-invoice-submit-requires-exact-execution-approval',
      actionKinds: ['submit'],
      decision: 'ask',
      destinationOrigins: ['https://example.test'],
      requireApprovalBinding: true,
    }
    const targetContract = {
      schemaVersion: 'web-task-contract/v1',
      contractId: 'invoice-runtime-two-actions-one-turn',
      revision: 0,
      criteria: [
        {
          id: 'batch-invoices-committed',
          kind: 'action_boundary',
          description: 'Both exact invoice business keys are independently committed.',
          actionKinds: ['submit'],
          outcome: 'performed',
          businessKeys,
        },
        {
          id: 'batch-invoice-receipts-present',
          kind: 'artifact_present',
          description: 'Both committed invoices have immutable external receipts.',
          artifactKinds: ['external_action_receipt'],
          schemaVersions: ['external-action-receipt/v1'],
          minCount: 2,
          businessKeys,
        },
      ],
      sensitiveActions: [sinkRule],
    }
    const targetProbe = {
      schemaVersion: 'external-action-probe/v1',
      id: batchProbeId,
      authority: 'read_only',
      async reconcile(request) {
        const confirmation = batchReceipts.get(request.businessKey)
        const id = request.businessKey.split(':').at(-1)
        operationOrder.push(`probe:${id}:${confirmation ? 'committed' : 'not_committed'}`)
        return {
          schemaVersion: 'external-action-reconciliation/v1',
          actionId: request.action.actionId,
          businessKey: request.businessKey,
          state: confirmation ? 'committed' : 'not_committed',
          observedAt: new Date().toISOString(),
          verifier: this.id,
          independentlyObserved: true,
          evidenceIds: [confirmation ? `receipt:${confirmation}` : `query:${request.businessKey}:absent`],
          ...(confirmation ? { externalReference: confirmation } : { retrySafe: true }),
          ...(confirmation && request.action.externalBinding?.schemaVersion === 'external-action-binding/v2'
            ? { observedEffectDigest: request.action.externalBinding.effectDigest }
            : {}),
          summary: confirmation
            ? 'The exact batch invoice receipt exists.'
            : 'The exact batch invoice is authoritatively absent.',
        }
      },
    }
    const result = await runAgentLoop({
      goal: 'Submit exactly two invoices and prove both portal results.',
      llm: new TwoActionLlm(invoiceIds.map((id, index) => ({
        id: `submit-batch-invoice-${index + 1}`,
        name: 'browser_click',
        arguments: { ref: 'e1', invoiceId: id, amount: 10_000 + index },
      }))),
      registry: targetRegistry,
      ctx: { sessionId: targetSessionId, highlight: false, trace: targetTrace },
      gate: targetGate,
      approvalQueue: targetQueue,
      session: recorder,
      sessionRef: sessionRefFor(targetSessionId, targetRunId),
      maxSteps: 3,
      safetyMode: 'guarded',
      allowFinalSubmit: true,
      allowExternalActionExecution: true,
      requireExternalActionReconciliation: true,
      preflightExternalActions: true,
      taskContract: targetContract,
      taskPolicy: {
        schemaVersion: 'task-policy/v1',
        defaultSensitiveAction: 'deny',
        rules: [sinkRule],
      },
      externalActionIntentResolver(request) {
        return {
          schemaVersion: 'external-action-intent/v1',
          actionKind: 'submit',
          binding: {
            schemaVersion: 'external-action-binding/v2',
            businessKey: `portal:customer-a:invoice:${request.args.invoiceId}`,
            probeId: batchProbeId,
            effectPayload: {
              invoiceId: request.args.invoiceId,
              amount: request.args.amount,
              operation: 'submit_invoice',
            },
          },
        }
      },
      externalActionProbes: [targetProbe],
    })
    const approvals = targetQueue.snapshot().approved
    const expectedOrder = invoiceIds.flatMap((id) => [
      `probe:${id}:not_committed`,
      `tool:${id}`,
      `probe:${id}:committed`,
    ])

    assert.deepEqual(operationOrder, expectedOrder)
    assert.equal(approvals.length, 2)
    assert(approvals.every((approval) => approval.resolution?.decision === 'approve_and_execute'))
    assert.equal(result.done, true)
    assert.equal(result.blocked, false)
    assert.equal(result.artifacts?.filter((artifact) => artifact.kind === 'external_action_receipt').length, 2)
    assert.deepEqual(
      result.actions
        ?.filter((action) => action.actionKind === 'submit' && action.outcome === 'performed')
        .map((action) => action.businessKey),
      businessKeys,
    )

    return {
      modelToolCallCount: 2,
      approvalCount: approvals.length,
      operationOrder,
      receiptArtifactCount: result.artifacts.filter((artifact) => artifact.kind === 'external_action_receipt').length,
      completion: { done: result.done, blocked: result.blocked },
    }
  } finally {
    targetTrace.finish()
  }
}

async function runAmbiguousAfterExecutionBatchScenario({ root: evidenceRoot, sessions: sessionStore }) {
  const invoiceIds = ['INV-CN-IN-DOUBT-A', 'INV-CN-IN-DOUBT-B']
  const businessKeys = invoiceIds.map((id) => `portal:customer-a:invoice:${id}`)
  const targetProbeId = 'invoice-runtime-post-write-ambiguous-query/v1'
  const targetSessionId = 'invoice-runtime-post-write-ambiguous'
  const targetRunId = 'invoice-runtime-post-write-ambiguous-run'
  const targetTrace = new TraceRecorder(join(evidenceRoot, 'trace-post-write-ambiguous'), {
    runId: targetRunId,
    source: 'local-runtime',
    scenario: 'invoice-runtime-post-write-ambiguous',
    profile: 'deterministic-fixture',
    goal: 'Stop a batch when the first executed external effect cannot be reconciled.',
  })
  try {
    await openFixture(targetSessionId)
    seedObservation(targetSessionId)
    const targetSession = await sessionStore.create({
      sessionId: targetSessionId,
      runId: targetRunId,
      source: 'test',
      goal: 'Stop a batch when the first executed external effect cannot be reconciled.',
      mode: 'invoice-runtime-post-write-ambiguous',
      traceRunId: targetRunId,
    })
    const recorder = new FileSessionRecorder(sessionStore, targetSession)
    const targetQueue = new ApprovalQueue()
    const targetGate = new ExactExecutionGate()
    const operationOrder = []
    const executedBusinessKeys = new Set()
    const targetRegistry = new ToolRegistry([{
      name: 'browser_click',
      description: 'Controlled final-submit control whose first post-write query is indeterminate.',
      category: 'action',
      parameters: { type: 'object', properties: {} },
      inherentRisk: 'L1',
      async run(args) {
        const key = `portal:customer-a:invoice:${args.invoiceId}`
        operationOrder.push(`tool:${args.invoiceId}`)
        executedBusinessKeys.add(key)
        return {
          observation: `The browser returned after submitting ${args.invoiceId}.`,
          pageChanged: false,
        }
      },
    }])
    const sinkRule = {
      id: 'post-write-ambiguous-submit-requires-exact-execution-approval',
      actionKinds: ['submit'],
      decision: 'ask',
      destinationOrigins: ['https://example.test'],
      requireApprovalBinding: true,
    }
    const targetContract = {
      schemaVersion: 'web-task-contract/v1',
      contractId: 'invoice-runtime-post-write-ambiguous',
      revision: 0,
      criteria: [
        {
          id: 'batch-invoices-committed',
          kind: 'action_boundary',
          description: 'Both exact invoice business keys are independently committed.',
          actionKinds: ['submit'],
          outcome: 'performed',
          businessKeys,
        },
        {
          id: 'batch-invoice-receipts-present',
          kind: 'artifact_present',
          description: 'Both committed invoices have immutable external receipts.',
          artifactKinds: ['external_action_receipt'],
          schemaVersions: ['external-action-receipt/v1'],
          minCount: 2,
          businessKeys,
        },
      ],
      sensitiveActions: [sinkRule],
    }
    const targetProbe = {
      schemaVersion: 'external-action-probe/v1',
      id: targetProbeId,
      authority: 'read_only',
      async reconcile(request) {
        const invoiceId = request.businessKey.split(':').at(-1)
        const executed = executedBusinessKeys.has(request.businessKey)
        operationOrder.push(`probe:${invoiceId}:${executed ? 'ambiguous' : 'not_committed'}`)
        return {
          schemaVersion: 'external-action-reconciliation/v1',
          actionId: request.action.actionId,
          businessKey: request.businessKey,
          state: executed ? 'ambiguous' : 'not_committed',
          observedAt: new Date().toISOString(),
          verifier: this.id,
          independentlyObserved: !executed,
          evidenceIds: [executed
            ? `query:${request.businessKey}:visibility-window`
            : `query:${request.businessKey}:absent`],
          ...(!executed ? { retrySafe: true } : {}),
          summary: executed
            ? 'The write returned but the authoritative index is inside its visibility window.'
            : 'The exact invoice is authoritatively absent before execution.',
        }
      },
    }
    const result = await runAgentLoop({
      goal: 'Submit two invoices, but stop immediately if either external result is uncertain.',
      llm: new TwoActionLlm(invoiceIds.map((id, index) => ({
        id: `submit-in-doubt-invoice-${index + 1}`,
        name: 'browser_click',
        arguments: { ref: 'e1', invoiceId: id, amount: 20_000 + index },
      }))),
      registry: targetRegistry,
      ctx: { sessionId: targetSessionId, highlight: false, trace: targetTrace },
      gate: targetGate,
      approvalQueue: targetQueue,
      session: recorder,
      sessionRef: sessionRefFor(targetSessionId, targetRunId),
      maxSteps: 3,
      safetyMode: 'guarded',
      allowFinalSubmit: true,
      allowExternalActionExecution: true,
      requireExternalActionReconciliation: true,
      preflightExternalActions: true,
      taskContract: targetContract,
      taskPolicy: {
        schemaVersion: 'task-policy/v1',
        defaultSensitiveAction: 'deny',
        rules: [sinkRule],
      },
      externalActionIntentResolver(request) {
        return {
          schemaVersion: 'external-action-intent/v1',
          actionKind: 'submit',
          binding: {
            schemaVersion: 'external-action-binding/v2',
            businessKey: `portal:customer-a:invoice:${request.args.invoiceId}`,
            probeId: targetProbeId,
            effectPayload: {
              invoiceId: request.args.invoiceId,
              amount: request.args.amount,
              operation: 'submit_invoice',
            },
          },
        }
      },
      externalActionProbes: [targetProbe],
    })
    const events = await readJsonLines(targetSession.eventsPath)
    const ledgerStatuses = events
      .filter((event) => event.type === 'action_ledger_updated' && event.data?.entry?.actionKind === 'submit')
      .map((event) => event.data.entry.status)
    const approvals = targetQueue.snapshot().approved

    assert.deepEqual(operationOrder, [
      'probe:INV-CN-IN-DOUBT-A:not_committed',
      'tool:INV-CN-IN-DOUBT-A',
      'probe:INV-CN-IN-DOUBT-A:ambiguous',
    ])
    assert.deepEqual(ledgerStatuses, ['proposed', 'authorized', 'executing', 'executed', 'ambiguous'])
    assert.equal(approvals.length, 1)
    assert.equal(result.done, true)
    assert.equal(result.blocked, true)
    assert.equal(result.artifacts?.some((artifact) => artifact.kind === 'external_action_receipt'), false)
    assert(result.actions?.some((action) => (
      action.businessKey === businessKeys[0] && action.outcome === 'indeterminate'
    )))
    assert.equal(result.actions?.some((action) => action.businessKey === businessKeys[1]), false)

    return {
      modelToolCallCount: 2,
      approvalCount: approvals.length,
      externalToolInvocationCount: operationOrder.filter((item) => item.startsWith('tool:')).length,
      laterExternalToolInvocationCount: operationOrder.filter((item) => item === 'tool:INV-CN-IN-DOUBT-B').length,
      operationOrder,
      ledgerStatuses,
      completion: { done: result.done, blocked: result.blocked },
    }
  } finally {
    targetTrace.finish()
  }
}

async function runAmbiguousBootstrapScenario({ root: evidenceRoot, sessions: sessionStore }) {
  const targetInvoiceId = 'INV-CN-BOOTSTRAP-UNKNOWN'
  const targetBusinessKey = `portal:customer-a:invoice:${targetInvoiceId}`
  const targetProbeId = 'invoice-runtime-bootstrap-ambiguous-query/v1'
  const targetSessionId = 'invoice-runtime-bootstrap-ambiguous'
  const targetRunId = 'invoice-runtime-bootstrap-ambiguous-run'
  const targetTrace = new TraceRecorder(join(evidenceRoot, 'trace-bootstrap-ambiguous'), {
    runId: targetRunId,
    source: 'local-runtime',
    scenario: 'invoice-runtime-bootstrap-ambiguous',
    profile: 'deterministic-fixture',
    goal: 'Block model startup while a restored external effect remains in doubt.',
  })
  try {
    await openFixture(targetSessionId)
    seedObservation(targetSessionId)
    const targetSession = await sessionStore.create({
      sessionId: targetSessionId,
      runId: targetRunId,
      source: 'test',
      goal: 'Block model startup while a restored external effect remains in doubt.',
      mode: 'invoice-runtime-bootstrap-ambiguous',
      traceRunId: targetRunId,
    })
    const recorder = new FileSessionRecorder(sessionStore, targetSession)
    const restoredLedger = new ActionLedger(() => new Date('2026-08-12T00:00:00.000Z'))
    restoredLedger.propose({
      actionId: 'restored-bootstrap-submit',
      actionKind: 'submit',
      toolName: 'browser_click',
      externalBinding: {
        schemaVersion: 'external-action-binding/v2',
        businessKey: targetBusinessKey,
        probeId: targetProbeId,
        effectDigest: 'f'.repeat(64),
      },
    })
    restoredLedger.authorize('restored-bootstrap-submit')
    restoredLedger.begin('restored-bootstrap-submit')
    for (const entry of restoredLedger.snapshot()) {
      await recorder.eventDurably({
        type: 'action_ledger_updated',
        toolCallId: entry.actionId,
        message: `${entry.actionKind}: ${entry.status}`,
        data: { entry },
      })
    }
    const llm = new CountingLlm()
    const forbiddenToolCalls = []
    const targetRegistry = new ToolRegistry([{
      name: 'browser_click',
      description: 'No external tool may run while bootstrap truth is ambiguous.',
      category: 'action',
      parameters: { type: 'object', properties: {} },
      inherentRisk: 'L1',
      async run(args) {
        forbiddenToolCalls.push(structuredClone(args))
        throw new Error('bootstrap ambiguity reached the external tool')
      },
    }])
    const targetProbe = {
      schemaVersion: 'external-action-probe/v1',
      id: targetProbeId,
      authority: 'read_only',
      async reconcile(request) {
        return {
          schemaVersion: 'external-action-reconciliation/v1',
          actionId: request.action.actionId,
          businessKey: request.businessKey,
          state: 'ambiguous',
          observedAt: new Date().toISOString(),
          verifier: this.id,
          independentlyObserved: false,
          evidenceIds: ['query:bootstrap-ambiguous:visibility-window'],
          summary: 'The restored external effect cannot yet be proven present or absent.',
        }
      },
    }
    const result = await runAgentLoop({
      goal: 'Do not expand external effects while restored truth is unknown.',
      llm,
      registry: targetRegistry,
      ctx: { sessionId: targetSessionId, highlight: false, trace: targetTrace },
      gate: new ExactExecutionGate(),
      session: recorder,
      sessionRef: sessionRefFor(targetSessionId, targetRunId),
      maxSteps: 3,
      safetyMode: 'guarded',
      requireExternalActionReconciliation: true,
      actionLedger: restoredLedger,
      taskContract: {
        schemaVersion: 'web-task-contract/v1',
        contractId: 'invoice-runtime-bootstrap-ambiguous',
        revision: 0,
        criteria: [{
          id: 'invoice-committed',
          kind: 'action_boundary',
          description: 'The restored invoice must reach an authoritative terminal state.',
          actionKinds: ['submit'],
          outcome: 'performed',
          businessKeys: [targetBusinessKey],
        }],
      },
      taskPolicy: {
        schemaVersion: 'task-policy/v1',
        defaultSensitiveAction: 'deny',
        rules: [],
      },
      externalActionProbes: [targetProbe],
    })
    const events = await readJsonLines(targetSession.eventsPath)
    const ledgerStatuses = events
      .filter((event) => event.type === 'action_ledger_updated' && event.data?.entry?.actionKind === 'submit')
      .map((event) => event.data.entry.status)

    assert.deepEqual(ledgerStatuses, ['proposed', 'authorized', 'executing', 'ambiguous'])
    assert.equal(llm.callCount, 0)
    assert.equal(forbiddenToolCalls.length, 0)
    assert.equal(result.steps, 0)
    assert.equal(result.done, true)
    assert.equal(result.blocked, true)
    assert.match(result.summary, /remain in doubt after authoritative reconciliation/)

    return {
      authoritativeBootstrapState: 'ambiguous',
      modelCallCount: llm.callCount,
      toolInvocationCount: forbiddenToolCalls.length,
      ledgerStatuses,
      completion: { done: result.done, blocked: result.blocked },
    }
  } finally {
    targetTrace.finish()
  }
}

async function runAmbiguousPreflightScenario({ root: evidenceRoot, sessions: sessionStore }) {
  const targetInvoiceId = 'INV-CN-PREFLIGHT-UNKNOWN'
  const targetBusinessKey = `portal:customer-a:invoice:${targetInvoiceId}`
  const targetProbeId = 'invoice-runtime-ambiguous-query/v1'
  const targetSessionId = 'invoice-runtime-ambiguous-preflight'
  const targetRunId = 'invoice-runtime-ambiguous-preflight-run'
  const targetTrace = new TraceRecorder(join(evidenceRoot, 'trace-ambiguous-preflight'), {
    runId: targetRunId,
    source: 'local-runtime',
    scenario: 'invoice-runtime-ambiguous-preflight',
    profile: 'deterministic-fixture',
    goal: 'Fail closed before approval when authoritative preflight cannot prove absence.',
  })
  try {
    await openFixture(targetSessionId)
    seedObservation(targetSessionId)
    const targetSession = await sessionStore.create({
      sessionId: targetSessionId,
      runId: targetRunId,
      source: 'test',
      goal: 'Fail closed before approval when authoritative preflight cannot prove absence.',
      mode: 'invoice-runtime-ambiguous-preflight',
      traceRunId: targetRunId,
    })
    const recorder = new FileSessionRecorder(sessionStore, targetSession)
    const targetQueue = new ApprovalQueue()
    const targetGate = new ExactExecutionGate()
    const forbiddenToolCalls = []
    const targetRegistry = new ToolRegistry([{
      name: 'browser_click',
      description: 'This side effect must never run after an ambiguous preflight.',
      category: 'action',
      parameters: { type: 'object', properties: {} },
      inherentRisk: 'L1',
      async run(args) {
        forbiddenToolCalls.push(structuredClone(args))
        throw new Error('ambiguous preflight reached the side effect')
      },
    }])
    const sinkRule = {
      id: 'ambiguous-invoice-submit-requires-exact-execution-approval',
      actionKinds: ['submit'],
      decision: 'ask',
      destinationOrigins: ['https://example.test'],
      requireApprovalBinding: true,
    }
    const targetContract = {
      schemaVersion: 'web-task-contract/v1',
      contractId: 'invoice-runtime-ambiguous-preflight',
      revision: 0,
      criteria: [
        {
          id: 'invoice-committed',
          kind: 'action_boundary',
          description: 'The exact invoice business key is independently committed.',
          actionKinds: ['submit'],
          outcome: 'performed',
          businessKeys: [targetBusinessKey],
        },
        {
          id: 'invoice-receipt-present',
          kind: 'artifact_present',
          description: 'The committed invoice has an immutable external receipt.',
          artifactKinds: ['external_action_receipt'],
          schemaVersions: ['external-action-receipt/v1'],
          minCount: 1,
          businessKeys: [targetBusinessKey],
        },
      ],
      sensitiveActions: [sinkRule],
    }
    const targetProbe = {
      schemaVersion: 'external-action-probe/v1',
      id: targetProbeId,
      authority: 'read_only',
      async reconcile(request) {
        return {
          schemaVersion: 'external-action-reconciliation/v1',
          actionId: request.action.actionId,
          businessKey: request.businessKey,
          state: 'ambiguous',
          observedAt: new Date().toISOString(),
          verifier: this.id,
          independentlyObserved: false,
          evidenceIds: ['query:index-not-yet-stable'],
          summary: 'The portal index is inside its visibility window, so absence is not yet authoritative.',
        }
      },
    }
    const result = await runAgentLoop({
      goal: 'Submit exactly one invoice and prove the portal result.',
      llm: new OneActionLlm({
        id: 'submit-ambiguous-invoice',
        name: 'browser_click',
        arguments: { ref: 'e1', invoiceId: targetInvoiceId, amount: 48_600 },
      }),
      registry: targetRegistry,
      ctx: { sessionId: targetSessionId, highlight: false, trace: targetTrace },
      gate: targetGate,
      approvalQueue: targetQueue,
      session: recorder,
      sessionRef: sessionRefFor(targetSessionId, targetRunId),
      maxSteps: 3,
      safetyMode: 'guarded',
      allowFinalSubmit: true,
      allowExternalActionExecution: true,
      requireExternalActionReconciliation: true,
      preflightExternalActions: true,
      taskContract: targetContract,
      taskPolicy: {
        schemaVersion: 'task-policy/v1',
        defaultSensitiveAction: 'deny',
        rules: [sinkRule],
      },
      externalActionIntentResolver(request) {
        return {
          schemaVersion: 'external-action-intent/v1',
          actionKind: 'submit',
          binding: {
            schemaVersion: 'external-action-binding/v2',
            businessKey: `portal:customer-a:invoice:${request.args.invoiceId}`,
            probeId: targetProbeId,
            effectPayload: {
              invoiceId: request.args.invoiceId,
              amount: request.args.amount,
              operation: 'submit_invoice',
            },
          },
        }
      },
      externalActionProbes: [targetProbe],
    })
    const events = await readJsonLines(targetSession.eventsPath)
    const ledgerStatuses = events
      .filter((event) => event.type === 'action_ledger_updated' && event.data?.entry?.actionKind === 'submit')
      .map((event) => event.data.entry.status)
    const approvals = targetQueue.snapshot()
    const preflightEventIndex = events.findIndex((event) => event.type === 'external_action_preflight')
    const ambiguousEventIndex = events.findIndex((event) => (
      event.type === 'action_ledger_updated' && event.data?.entry?.status === 'ambiguous'
    ))

    assert.deepEqual(ledgerStatuses, ['proposed', 'ambiguous'])
    assert(preflightEventIndex >= 0 && preflightEventIndex < ambiguousEventIndex)
    assert.equal(events[preflightEventIndex]?.data?.verdict?.state, 'ambiguous')
    assert.equal(forbiddenToolCalls.length, 0)
    assert.equal(targetGate.requests.length, 0)
    assert.equal(approvals.pending.length, 0)
    assert.equal(approvals.approved.length, 0)
    assert.equal(result.done, true)
    assert.equal(result.blocked, true)
    assert.equal(result.artifacts?.some((artifact) => artifact.kind === 'external_action_receipt'), false)
    assert.equal(result.actions?.some((action) => action.outcome === 'performed'), false)

    return {
      authoritativePreflightState: 'ambiguous',
      approvalRequestCount: targetGate.requests.length,
      toolInvocationCount: forbiddenToolCalls.length,
      ledgerStatuses,
      receiptArtifactCount: result.artifacts?.filter((artifact) => artifact.kind === 'external_action_receipt').length ?? 0,
      completion: { done: result.done, blocked: result.blocked },
    }
  } finally {
    targetTrace.finish()
  }
}

async function openFixture(targetSessionId = sessionId) {
  const page = (await sessionManager.getOrCreate(targetSessionId)).page
  const url = 'https://example.test/invoices/review'
  await page.unroute(url)
  await page.route(url, (route) => route.fulfill({
    status: 200,
    contentType: 'text/html; charset=utf-8',
    body: '<!doctype html><html><head><title>Invoice review</title></head><body><input aria-label="Invoice number"><button type="submit">Submit invoice</button></body></html>',
  }))
  const opened = await browserOpen({ sessionId: targetSessionId, url, waitUntil: 'domcontentloaded' })
  assert.equal(opened.ok, true, opened.observation)
}

function seedObservation(targetSessionId = sessionId) {
  observationManager.refreshPageState({
    sessionId: targetSessionId,
    snapshot: {
      snapshotId: 'invoice-runtime-single-action-snapshot',
      url: 'https://example.test/invoices/review',
      title: 'Invoice review',
      textSummary: 'Review one invoice before final submit.',
      elements: [
        element('e0', 'input', 'Invoice number', 'L1'),
        element('e1', 'button', 'Submit invoice', 'L1'),
      ],
      stats: {
        elementCount: 2,
        interactiveCount: 2,
        formCount: 1,
        linkCount: 0,
        buttonCount: 1,
        inputCount: 1,
        truncated: false,
      },
    },
  })
}

function sessionRefFor(targetSessionId, targetRunId) {
  return {
    schemaVersion: 'session-ref/v1',
    provider: 'file-session-store',
    id: targetSessionId,
    runId: targetRunId,
    attempt: 1,
  }
}

function element(ref, tag, name, risk) {
  return {
    ref,
    tag,
    name,
    text: name,
    visible: true,
    risk,
    locatorHints: {},
    fingerprint: {},
  }
}
