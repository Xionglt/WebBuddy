/**
 * Agent-loop integration test — drives the generic LLM agent loop with a MOCK
 * LLM (no real model key needed) to prove the loop plumbing works: the "model"
 * reads the snapshot, picks refs, types, and calls agent_done. Validates tool
 * dispatch, page-view refresh, risk gating, and the no-submit contract.
 *
 *   npm run test:agent-loop   (after build)
 */
import assert from 'node:assert'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ContextCompactor } from '../dist/context/compaction.js'
import { COMPACTED_RUN_CONTEXT_PREFIX } from '../dist/context/run-summary.js'
import { estimateTokenBudget } from '../dist/kernel/token-budget.js'
import { observationManager } from '../dist/observation/observation-manager.js'
import { ApprovalQueue } from '../dist/permission/index.js'
import { ActionLedger } from '../dist/task/action-ledger.js'
import { externalActionEffectDigest } from '../dist/task/action-reconciliation.js'
import { browserOpen } from '../dist/browser/open.js'
import { runJobApplicationAgent } from '../dist/sdk/orchestrator.js'
import { loadConfig } from '../dist/sdk/config.js'
import { writeSampleResumePdf } from '../dist/sdk/resume.js'
import { TraceRecorder } from '../dist/sdk/trace.js'
import { FileSessionRecorder, FileSessionStore, readJsonLines } from '../dist/session/index.js'
import { sessionManager } from '../dist/session/manager.js'
import { runAgentLoop } from '../dist/runtime/local/agent-loop.js'
import { ToolRegistry } from '../dist/runtime/local/tool-registry.js'
import { WorkflowEngine } from '../dist/workflow/workflow-engine.js'

// A minimal LlmGateway stand-in: returns scripted tool calls. Each turn it
// inspects the latest snapshot to find the right ref for the field it fills —
// exactly what a real model would do after reading the page view.
class MockLlm {
  constructor() {
    this.hasKey = true
    this.label = 'mock-llm'
    this._plan = [
      { kind: 'snapshot' },
      { kind: 'type', field: /name|姓名/i, value: 'Zhang San' },
      { kind: 'type', field: /email|邮箱/i, value: 'zhangsan@example.com' },
      { kind: 'type', field: /phone|手机/i, value: '13800001234' },
      { kind: 'type', field: /city|期望城市/i, value: 'Hangzhou' },
      { kind: 'finish' },
    ]
    this._i = 0
  }

  _findRef(regex) {
    const snap = sessionManager.get('default')?.latestSnapshot
    if (!snap) return undefined
    for (const [ref, stored] of snap.refMap) {
      const hay = [stored.name, stored.text, stored.aria].filter(Boolean).join(' ')
      if (regex.test(hay) && (stored.tag === 'input' || stored.tag === 'textarea')) return ref
    }
    return undefined
  }

  async chatWithTools(_messages, _opts) {
    const step = this._plan[this._i++]
    if (!step) return { content: 'no more steps', toolCalls: [] }
    if (step.kind === 'snapshot') {
      return { content: 'Let me look at the form.', toolCalls: [{ id: 'c1', name: 'browser_snapshot', arguments: {} }] }
    }
    if (step.kind === 'type') {
      const ref = this._findRef(step.field)
      assert(ref, `mock could not find ref for ${step.field}`)
      return { content: `Filling ${step.field}.`, toolCalls: [{ id: 'c2', name: 'browser_type', arguments: { ref, text: step.value } }] }
    }
    if (step.kind === 'finish') {
      const ref = this._findRef(/summary|个人简介/i)
      assert(ref, 'mock could not find ref for the summary field')
      return {
        content: 'Filling the final field, auditing the draft, and stopping before submit.',
        toolCalls: [
          { id: 'c-summary', name: 'browser_type', arguments: { ref, text: 'Frontend engineer' } },
          { id: 'c-audit', name: 'browser_form_audit', arguments: {} },
          { id: 'c-done', name: 'agent_done', arguments: { summary: 'Filled name/email/phone/city/summary; did not submit.', blocked: false } },
        ],
      }
    }
    return { content: '', toolCalls: [] }
  }
}

class NarrationOnlyLlm {
  constructor() {
    this.hasKey = true
    this.label = 'narration-only-llm'
  }

  async chatWithTools() {
    return { content: 'The form looks ready.', toolCalls: [] }
  }
}

const config = loadConfig()
config.browser.headless = true
config.browser.visualHighlight = false
config.browser.typeDelayMs = 0
config.browser.slowMoMs = 0
config.browser.allowedDomains = ['example.test']
config.human.mode = 'auto'
config.resumePath = '/tmp/mfa-agent-loop-resume.pdf'
writeSampleResumePdf(config.resumePath)

const events = []
const result = await runJobApplicationAgent({
  config,
  mode: 'demo-form',
  llm: new MockLlm(),
  onEvent: (e) => events.push(e),
})

console.log('events:')
for (const e of events) console.log(`  [${e.level}] ${e.phase}: ${e.message}`)
console.log('result:', result.finalState, '—', result.message.slice(0, 80))

assert.strictEqual(result.finalState, 'filled', `expected filled, got ${result.finalState}`)
assert(/did not submit|not submitted/i.test(result.message), 'must state it did not submit')
const demoPage = sessionManager.get('default')?.page
assert.equal(demoPage?.url(), 'https://demo-form.web-buddy.invalid/application')
assert.match(
  await demoPage.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content'),
  /default-src 'none'/,
  'offline demo must ship a fail-closed CSP',
)

const traceDir = join(config.trace.outDir, 'traces', `run_${result.summary.runId}`)
const metricsPath = join(traceDir, 'metrics.json')
const agentStatePath = join(traceDir, 'agent-state.json')
assert(existsSync(metricsPath), `expected metrics.json at ${metricsPath}`)
assert(existsSync(agentStatePath), `expected agent-state.json at ${agentStatePath}`)
const metrics = JSON.parse(readFileSync(metricsPath, 'utf8'))
const agentState = JSON.parse(readFileSync(agentStatePath, 'utf8'))
assert.strictEqual(metrics.source, 'local-runtime')
assert.strictEqual(metrics.scenario, 'demo-form')
assert.strictEqual(agentState.schemaVersion, 'agent-state/v1')
assert.strictEqual(agentState.finalStatus, 'completed')

// The agent must have used the agent loop (think/act/observe events).
const sawAct = events.some((e) => e.level === 'act' && /browser_type/.test(e.message))
assert(sawAct, 'agent loop should have typed via browser_type')

const narrationOnly = await runJobApplicationAgent({
  config: {
    ...config,
    agent: { ...config.agent, maxSteps: 2 },
  },
  mode: 'demo-form',
  taskType: 'explore',
  llm: new NarrationOnlyLlm(),
})
assert.equal(
  narrationOnly.finalState,
  'blocked',
  'caller-supplied explore must not weaken demo-form completion or accept narration-only completion',
)

async function runPermissionScenarios() {
  const root = mkdtempSync(join(tmpdir(), 'mfa-agent-loop-permission-'))
  const trace = new TraceRecorder(root, {
    runId: 'agent-loop-permission-run',
    source: 'local-runtime',
    scenario: 'agent-loop-permission-test',
    profile: 'test',
    goal: 'Verify PermissionEngine integration.',
  })
  const store = new FileSessionStore({ rootDir: join(root, 'sessions') })

  try {
    const approve = await runLoopScenario({
      trace,
      store,
      sessionId: 'permission-approve',
      call: { id: 'approve-click', name: 'browser_click_text', arguments: { text: 'Open details' } },
      risk: 'L3',
      gateDecisions: ['approve'],
      seedFresh: true,
      withSession: true,
    })
    assert.equal(approve.toolCalls.length, 1, 'approved high-risk action should execute')
    assert.equal(approve.toolCalls[0].args.confirmed, true, 'approved high-risk action should receive confirmed=true')
    assert.equal(approve.gate.requests[0].kind, 'high_risk_action')
    assert.equal(approve.queue.snapshot().approved.length, 1)
    assertTranscriptIncludes(approve.transcript, [
      'policy_decision',
      'permission_decision',
      'approval_request',
      'approval_decision',
      'skill_context',
      'workflow_evidence',
      'workflow_evaluation',
      'workflow_snapshot',
      'tool_result',
    ])
    const skillContext = approve.transcript.find((entry) => entry.type === 'skill_context')
    assert(skillContext?.context?.skills?.length > 0, 'transcript should include resolved skill context')
    assert(approve.events.some((event) => event.type === 'skill_resolved'), 'events should include skill_resolved')
    assert(approve.events.some((event) => event.type === 'permission_evaluated'), 'events should include permission_evaluated')
    assert(approve.events.some((event) => event.type === 'approval_requested'), 'events should include approval_requested')
    assert(approve.events.some((event) => event.type === 'approval_resolved'), 'events should include approval_resolved')
    assert(approve.events.some((event) => event.type === 'workflow_evidence_recorded'), 'events should include workflow_evidence_recorded')
    assert(approve.events.some((event) => event.type === 'workflow_evaluated'), 'events should include workflow_evaluated')
    assert(approve.events.some((event) => event.type === 'human_gate_requested'), 'old human_gate_requested event should remain')
    assert(approve.events.some((event) => event.type === 'human_gate_resolved'), 'old human_gate_resolved event should remain')
    assert(!approve.transcript.some((entry) => entry.type === 'context_compaction'), 'unset maxInputTokens should not compact')

    const finalSubmitWorkflow = new RecordingWorkflowEngine()
    const finalSubmit = await runLoopScenario({
      trace,
      store,
      sessionId: 'permission-final-submit',
      call: { id: 'final-submit-click', name: 'browser_click_text', arguments: { text: 'Submit application' } },
      risk: 'L3',
      gateDecisions: ['approve'],
      seedFresh: true,
      withSession: true,
      workflowEngine: finalSubmitWorkflow,
    })
    assert.equal(finalSubmit.result.blocked, true, 'final submit should remain blocked after approval')
    assert.equal(finalSubmit.result.steps >= 1, true, 'final submit approval should be recorded before the run stops')
    assert.equal(finalSubmit.result.workflowState?.phase, 'final_submit_boundary')
    assert.equal(finalSubmit.toolCalls.length, 0, 'final submit tool must not execute')
    assert.equal(finalSubmit.gate.requests[0].kind, 'final_submit')
    assert.equal(finalSubmit.queue.snapshot().approved.length, 1)
    assert(finalSubmitWorkflow.calls.length >= 3, 'workflow engine should evaluate initial, approval, and final-submit blocker states')
    assert(
      finalSubmitWorkflow.calls.some((call) => call.policyFacts?.some((fact) => fact.gateKind === 'final_submit')),
      'workflow engine should receive final-submit policy facts',
    )
    assertTranscriptIncludes(finalSubmit.transcript, ['workflow_evidence', 'workflow_evaluation', 'workflow_snapshot'])
    const finalSubmitEvidence = workflowEvidenceEntries(finalSubmit.transcript)
    assert(
      finalSubmitEvidence.some(
        (evidence) =>
          evidence.kind === 'policy' &&
          evidence.toolCallId === 'final-submit-click' &&
          evidence.data?.gateKind === 'final_submit',
      ),
      'final submit should record policy evidence with the final_submit gate',
    )
    assert(
      finalSubmitEvidence.some(
        (evidence) =>
          evidence.kind === 'permission' &&
          evidence.toolCallId === 'final-submit-click' &&
          evidence.data?.decision?.gateKind === 'final_submit',
      ),
      'final submit should record permission evidence',
    )
    assert(
      finalSubmitEvidence.some(
        (evidence) =>
          evidence.kind === 'approval' &&
          evidence.toolCallId === 'final-submit-click' &&
          evidence.data?.approval?.status === 'approved' &&
          evidence.data?.resolution?.decision === 'approve',
      ),
      'final submit should retain the human approval evidence even though runtime still blocks execution',
    )
    assert(
      finalSubmitEvidence.some((evidence) => evidence.kind === 'workflow_state' && evidence.phase === 'final_submit_boundary'),
      'final submit should record final_submit_boundary workflow_state evidence after returning control',
    )
    const finalSubmitCompletionGate = completionGateEntries(finalSubmit.transcript).at(-1)
    if (finalSubmitCompletionGate) {
      assert.equal(finalSubmitCompletionGate.action, 'block')
      assert.equal(finalSubmitCompletionGate.workflowPhase, 'final_submit_boundary')
    }

    let unauthorizedExecuteCalls = 0
    await assert.rejects(
      () => runLoopScenario({
        trace,
        store,
        sessionId: 'permission-final-submit-unoffered-execute',
        call: { id: 'unoffered-final-submit', name: 'browser_click_text', arguments: { text: 'Submit application' } },
        risk: 'L4',
        gateDecisions: ['approve_and_execute'],
        seedFresh: true,
        withSession: true,
        toolRun() {
          unauthorizedExecuteCalls += 1
          return { observation: 'must not execute', pageChanged: true }
        },
      }),
      /approve_and_execute is not allowed/,
      'a HumanGate cannot invent machine-execution authority when the request did not offer it',
    )
    assert.equal(unauthorizedExecuteCalls, 0)

    const agentDoneWorkflow = new RecordingWorkflowEngine()
    const agentDone = await runLoopScenario({
      trace,
      store,
      sessionId: 'workflow-agent-done',
      call: { id: 'agent-done-call', name: 'agent_done', arguments: { summary: 'Workflow complete.', blocked: false } },
      risk: 'L1',
      gateDecisions: [],
      seedFresh: true,
      withSession: true,
      workflowEngine: agentDoneWorkflow,
    })
    assert.equal(agentDone.result.done, true, 'agent_done scenario should finish')
    assert.equal(agentDone.result.blocked, false, 'rejected agent_done should return control to the model')
    assert(agentDoneWorkflow.calls.length >= 3, 'workflow engine should evaluate initial, before agent_done, and after agent_done')
    assert(
      agentDoneWorkflow.calls.some((call) => {
        const latest = call.recentActions?.at(-1)
        return latest?.toolName === 'agent_done' && !latest.toolResult
      }),
      'workflow engine should be called before agent_done execution',
    )
    assert(
      agentDoneWorkflow.calls.some((call) => {
        const latest = call.recentActions?.at(-1)
        return latest?.toolName === 'agent_done' && latest.toolResult?.done === true
      }),
      'workflow engine should be called after agent_done execution',
    )
    assertTranscriptIncludes(agentDone.transcript, ['workflow_evidence', 'workflow_evaluation', 'workflow_snapshot', 'completion_gate'])
    const agentDoneEvidence = workflowEvidenceEntries(agentDone.transcript)
    assert(
      agentDoneEvidence.some(
        (evidence) =>
          evidence.kind === 'tool_result' &&
          evidence.toolCallId === 'agent-done-call' &&
          evidence.source === 'agent_done' &&
          evidence.data?.done === true,
      ),
      'agent_done should record tool_result workflow evidence',
    )
    assert(
      workflowEvaluationEntries(agentDone.transcript).some((evaluation) =>
        evaluation.state?.phase === 'done' &&
        evaluation.missingCriteria?.some(
          (criterion) =>
            criterion.id === 'done-requires-explicit-completion-evidence' &&
            criterion.missingEvidenceKinds?.includes('user_confirm'),
        )
      ),
      'agent_done should surface missing explicit user confirmation evidence',
    )
    const agentDoneCompletionGate = completionGateEntries(agentDone.transcript).at(-1)
    assert(agentDoneCompletionGate, 'agent_done should record completion_gate transcript entry')
    assert.equal(agentDoneCompletionGate.action, 'reject')
    assert.equal(agentDoneCompletionGate.recommendedStatus, 'unchanged')
    assert(
      agentDoneCompletionGate.missingCriteria.some(
        (criterion) =>
          criterion.id === 'done-requires-explicit-completion-evidence' &&
          criterion.missingEvidenceKinds?.includes('user_confirm'),
      ),
      'completion gate should retain missing user_confirm evidence details',
    )
    const agentDoneCompletionGateEvent = agentDone.events.find((event) => event.type === 'completion_gate_evaluated')
    assert(agentDoneCompletionGateEvent, 'events should include completion_gate_evaluated')
    assert.equal(agentDoneCompletionGateEvent.data.action, 'reject')
    assert.equal(agentDoneCompletionGateEvent.data.recommendedStatus, 'unchanged')
    assert.match(String(agentDoneCompletionGateEvent.data.reason), /task completion evidence is missing|required workflow evidence is missing/i)
    assert(
      agentDoneCompletionGateEvent.data.missingCriteria.some(
        (criterion) =>
          criterion.id === 'done-requires-explicit-completion-evidence' &&
          criterion.missingEvidenceKinds?.includes('user_confirm'),
      ),
      'completion gate event should retain missing user_confirm evidence details',
    )

    const injectedAllowGate = new RecordingCompletionGate('allow')
    const agentDoneAllow = await runLoopScenario({
      trace,
      store,
      sessionId: 'workflow-agent-done-allow',
      call: { id: 'agent-done-allow-call', name: 'agent_done', arguments: { summary: 'Workflow complete.', blocked: false } },
      risk: 'L1',
      gateDecisions: [],
      seedFresh: true,
      withSession: true,
      workflowEngine: new RecordingWorkflowEngine(),
      completionGate: injectedAllowGate,
    })
    assert.equal(agentDoneAllow.result.done, true, 'injected allow gate scenario should finish')
    assert.equal(agentDoneAllow.result.blocked, false, 'injected allow gate should preserve unblocked completion')
    assert.equal(injectedAllowGate.inputs.length, 1, 'injected completion gate should receive the agent_done evaluation')
    assert(injectedAllowGate.inputs[0].workflowEvaluation, 'injected completion gate should receive workflowEvaluation')
    const allowGateDecision = completionGateEntries(agentDoneAllow.transcript).at(-1)
    assert.equal(allowGateDecision?.action, 'allow')
    assert.equal(allowGateDecision?.recommendedStatus, 'completed')

    const rawReadOnlyResumeGate = new RecordingCompletionGate('allow')
    await runLoopScenario({
      trace,
      store,
      sessionId: 'raw-read-only-resume-contract',
      call: { id: 'raw-read-only-done-call', name: 'agent_done', arguments: { summary: 'Stopped at human handoff.', blocked: true } },
      risk: 'L1',
      gateDecisions: [],
      seedFresh: true,
      withSession: true,
      safetyMode: 'raw',
      taskType: 'explore',
      extraContext: [
        'Current task resume file path: /tmp/current-resume.pdf',
        'Use this resume path as read-only context for matching.',
      ].join('\n'),
      workflowEngine: new RecordingWorkflowEngine(),
      completionGate: rawReadOnlyResumeGate,
    })
    assert(rawReadOnlyResumeGate.inputs.length >= 1, 'raw read-only resume scenario should evaluate completion gate')
    assert(
      rawReadOnlyResumeGate.inputs.every((input) => input.requiresCurrentResumeUpload === false),
      'raw mode must not infer required resume upload from read-only resume path context',
    )

    const policyDeny = await runLoopScenario({
      trace,
      store,
      sessionId: 'permission-policy-deny',
      call: { id: 'deny-click', name: 'browser_click_text', arguments: { text: 'Open details' } },
      risk: 'L3',
      gateDecisions: ['approve'],
      seedFresh: false,
      withSession: true,
    })
    assert.equal(policyDeny.result.blocked, false, 'stale-context policy deny should let the loop continue after observation')
    assert.equal(policyDeny.toolCalls.length, 0, 'permission deny should not execute the tool')
    assert.equal(policyDeny.gate.requests.length, 0, 'permission deny should not call HumanGate')
    assert.equal(policyDeny.queue.snapshot().all.length, 0, 'permission deny should not enqueue approval')
    const denyEntry = policyDeny.transcript.find((entry) => entry.type === 'permission_decision')
    assert.equal(denyEntry?.decision?.action, 'deny')

    const rawGate = await runLoopScenario({
      trace,
      store,
      sessionId: 'permission-raw-gate',
      call: { id: 'raw-click', name: 'browser_click_text', arguments: { text: 'Submit application' } },
      risk: 'L3',
      safetyMode: 'raw',
      gateDecisions: ['takeover'],
      seedFresh: true,
      withSession: true,
    })
    assert.equal(rawGate.result.blocked, true, 'raw L3 click should block on human takeover')
    assert.equal(rawGate.toolCalls.length, 0, 'raw L3 click should not execute without approval')
    assert.equal(rawGate.gate.requests.length, 1, 'raw L3 click should call HumanGate')
    assert.equal(rawGate.queue.snapshot().all.length, 1, 'raw L3 click should enqueue approval')
    const rawPermission = rawGate.transcript.find((entry) => entry.type === 'permission_decision')
    assert.equal(rawPermission?.decision?.action, 'ask')

    const upload = await runLoopScenario({
      trace,
      store,
      sessionId: 'permission-upload',
      call: { id: 'upload-file', name: 'browser_upload_file', arguments: { filePath: '/tmp/resume.pdf' } },
      risk: 'L4',
      gateDecisions: ['approve'],
      seedFresh: true,
      withSession: true,
    })
    assert.equal(upload.toolCalls.length, 1, 'approved upload should execute')
    assert.equal(upload.toolCalls[0].args.confirmed, true, 'approved upload should receive confirmed=true')
    assert.equal(upload.gate.requests[0].kind, 'upload_resume')

    await assert.rejects(
      runLoopScenario({
        trace,
        store,
        sessionId: 'permission-session-ref-mismatch',
        call: { id: 'mismatched-session-click', name: 'browser_click_text', arguments: { text: 'Open details' } },
        risk: 'L3',
        gateDecisions: ['approve'],
        seedFresh: true,
        withSession: true,
        sessionRef: {
          schemaVersion: 'session-ref/v1',
          provider: 'file-session-store',
          id: 'foreign-session',
          runId: `${trace.runId}-permission-session-ref-mismatch`,
          attempt: 1,
        },
      }),
      /AGENT_LOOP_SESSION_BINDING_MISMATCH/,
      'an approval-bearing SessionRef must match the durable Agent Loop recorder before model or tool work',
    )

    await assert.rejects(
      runLoopScenario({
        trace,
        store,
        sessionId: 'permission-upload-without-journal',
        call: { id: 'upload-without-journal', name: 'browser_upload_file', arguments: { filePath: '/tmp/resume.pdf' } },
        risk: 'L4',
        gateDecisions: ['approve'],
        seedFresh: true,
      }),
      /DURABLE_ACTION_JOURNAL_REQUIRED: upload/,
      'an external side effect must fail closed when no durable execution journal exists',
    )

    let strictUnboundToolCalls = 0
    await assert.rejects(
      runLoopScenario({
        trace,
        store,
        sessionId: 'permission-strict-unbound-new-action',
        call: { id: 'strict-unbound-send', name: 'send_invoice', arguments: { invoiceId: 'STRICT-UNBOUND' } },
        risk: 'L1',
        gateDecisions: ['approve'],
        seedFresh: true,
        withSession: true,
        requireExternalActionReconciliation: true,
        toolRun() {
          strictUnboundToolCalls += 1
          return { observation: 'must not execute', pageChanged: false }
        },
      }),
      /EXTERNAL_ACTION_BINDING_REQUIRED: strict reconciliation mode blocked unbound send/,
      'a production-strict host must reject the first unadapted external write before approval or execution',
    )
    assert.equal(strictUnboundToolCalls, 0)

    let strictUnclassifiedClickCalls = 0
    await assert.rejects(
      runLoopScenario({
        trace,
        store,
        sessionId: 'permission-strict-unclassified-click',
        call: { id: 'strict-unclassified-click', name: 'browser_click', arguments: { ref: 'e1' } },
        risk: 'L1',
        gateDecisions: [],
        seedFresh: true,
        withSession: true,
        requireExternalActionReconciliation: true,
        toolRun() {
          strictUnclassifiedClickCalls += 1
          return { observation: 'must not execute', pageChanged: false }
        },
      }),
      /EXTERNAL_ACTION_INTENT_REQUIRED: strict reconciliation mode requires an explicit external or non_external classification/,
      'strict mode must not confuse an absent opaque-click classification with a safe non-external control',
    )
    assert.equal(strictUnclassifiedClickCalls, 0)

    let policyDeniedPreflightCalls = 0
    const policyDeniedPreflight = await runLoopScenario({
      trace,
      store,
      sessionId: 'permission-policy-denied-before-preflight',
      call: {
        id: 'policy-denied-submit',
        name: 'browser_click',
        arguments: { ref: 'e1', invoiceId: 'POLICY-DENIED' },
      },
      risk: 'L1',
      gateDecisions: [],
      seedFresh: true,
      withSession: true,
      adapterSinkKind: 'submit',
      sinkRuleDecision: 'deny',
      requireExternalActionReconciliation: true,
      preflightExternalActions: true,
      externalActionIntentResolver() {
        return {
          schemaVersion: 'external-action-intent/v1',
          actionKind: 'submit',
          binding: {
            schemaVersion: 'external-action-binding/v2',
            businessKey: 'portal:customer-a:invoice:POLICY-DENIED',
            probeId: 'policy-denied-preflight-probe/v1',
            effectPayload: { invoiceId: 'POLICY-DENIED' },
          },
        }
      },
      externalActionProbes: [{
        schemaVersion: 'external-action-probe/v1',
        id: 'policy-denied-preflight-probe/v1',
        authority: 'read_only',
        async reconcile() {
          policyDeniedPreflightCalls += 1
          throw new Error('policy-blocked action must not reach the Probe')
        },
      }],
    })
    assert.equal(policyDeniedPreflightCalls, 0, 'Sink Policy must run before any external preflight query')
    assert.equal(policyDeniedPreflight.toolCalls.length, 0)
    assert.equal(policyDeniedPreflight.gate.requests.length, 0)
    assert.equal(
      policyDeniedPreflight.events.some((event) => event.type === 'external_action_preflight'),
      false,
      'a policy-blocked sink must not mint a false preflight audit event',
    )
    assert.deepEqual(
      policyDeniedPreflight.events
        .filter((event) => event.type === 'action_ledger_updated')
        .map((event) => event.data?.entry?.status),
      [],
      'a policy-blocked action must remain a Policy audit, not a recoverable Ledger proposal',
    )

    let missingPolicyPreflightCalls = 0
    const missingPolicyPreflight = await runLoopScenario({
      trace,
      store,
      sessionId: 'permission-missing-policy-before-preflight',
      call: {
        id: 'missing-policy-submit',
        name: 'browser_click',
        arguments: { ref: 'e1', invoiceId: 'MISSING-POLICY' },
      },
      risk: 'L1',
      gateDecisions: [],
      seedFresh: true,
      withSession: true,
      adapterSinkKind: 'submit',
      omitTaskPolicy: true,
      requireExternalActionReconciliation: true,
      preflightExternalActions: true,
      externalActionIntentResolver() {
        return {
          schemaVersion: 'external-action-intent/v1',
          actionKind: 'submit',
          binding: {
            schemaVersion: 'external-action-binding/v2',
            businessKey: 'portal:customer-a:invoice:MISSING-POLICY',
            probeId: 'missing-policy-preflight-probe/v1',
            effectPayload: { invoiceId: 'MISSING-POLICY' },
          },
        }
      },
      externalActionProbes: [{
        schemaVersion: 'external-action-probe/v1',
        id: 'missing-policy-preflight-probe/v1',
        authority: 'read_only',
        async reconcile() {
          missingPolicyPreflightCalls += 1
          throw new Error('a missing TaskPolicy must fail closed before the Probe')
        },
      }],
    })
    assert.equal(missingPolicyPreflightCalls, 0, 'missing TaskPolicy must deny before any external read')
    assert.equal(missingPolicyPreflight.toolCalls.length, 0)
    assert.equal(missingPolicyPreflight.gate.requests.length, 0)
    assert.equal(
      missingPolicyPreflight.events.some((event) => event.type === 'external_action_preflight'),
      false,
    )
    assert.deepEqual(
      missingPolicyPreflight.events
        .filter((event) => event.type === 'action_ledger_updated')
        .map((event) => event.data?.entry?.status),
      [],
    )

    const policyBarrierSessionId = 'permission-policy-durable-before-proposal-crash'
    let policyBarrierProbeCalls = 0
    let policyBarrierToolCalls = 0
    await assert.rejects(
      runLoopScenario({
        trace,
        store,
        sessionId: policyBarrierSessionId,
        call: {
          id: 'policy-barrier-submit',
          name: 'browser_click',
          arguments: { ref: 'e1', invoiceId: 'POLICY-BARRIER' },
        },
        risk: 'L1',
        gateDecisions: ['approve_and_execute'],
        seedFresh: true,
        withSession: true,
        adapterSinkKind: 'submit',
        requireExternalActionReconciliation: true,
        preflightExternalActions: true,
        allowFinalSubmit: true,
        allowExternalActionExecution: true,
        sessionDecorator(recorder) {
          let durableEventCount = 0
          return new Proxy(recorder, {
            get(target, property) {
              if (property === 'eventDurably') {
                return async (event) => {
                  durableEventCount += 1
                  if (durableEventCount === 2) {
                    throw new Error('injected crash after durable policy before proposal')
                  }
                  return target.eventDurably(event)
                }
              }
              const value = target[property]
              return typeof value === 'function' ? value.bind(target) : value
            },
          })
        },
        toolRun() {
          policyBarrierToolCalls += 1
          return { observation: 'must not execute', pageChanged: false }
        },
        externalActionIntentResolver(request) {
          return {
            schemaVersion: 'external-action-intent/v1',
            actionKind: 'submit',
            binding: {
              schemaVersion: 'external-action-binding/v2',
              businessKey: `portal:customer-a:invoice:${request.args.invoiceId}`,
              probeId: 'policy-barrier-preflight-probe/v1',
              effectPayload: { invoiceId: request.args.invoiceId },
            },
          }
        },
        externalActionProbes: [{
          schemaVersion: 'external-action-probe/v1',
          id: 'policy-barrier-preflight-probe/v1',
          authority: 'read_only',
          async reconcile() {
            policyBarrierProbeCalls += 1
            throw new Error('proposal failure must prevent preflight')
          },
        }],
      }),
      /injected crash after durable policy before proposal/,
    )
    const policyBarrierSession = await store.get(`session-${policyBarrierSessionId}`)
    assert(policyBarrierSession)
    const policyBarrierEvents = await readJsonLines(policyBarrierSession.eventsPath)
    assert.equal(policyBarrierEvents.some((event) => event.type === 'policy_evaluated'), true)
    assert.equal(policyBarrierEvents.some((event) => event.type === 'action_ledger_updated'), false)
    assert.equal(policyBarrierEvents.some((event) => event.type === 'external_action_preflight'), false)
    assert.equal(policyBarrierProbeCalls, 0)
    assert.equal(policyBarrierToolCalls, 0)

    const strictNonExternalClick = await runLoopScenario({
      trace,
      store,
      sessionId: 'permission-strict-explicit-non-external-click',
      call: { id: 'strict-non-external-click', name: 'browser_click', arguments: { ref: 'e1' } },
      risk: 'L1',
      gateDecisions: [],
      seedFresh: true,
      withSession: true,
      requireExternalActionReconciliation: true,
      externalActionIntentResolver() {
        return {
          schemaVersion: 'external-action-intent/v1',
          actionKind: 'non_external',
        }
      },
    })
    assert.equal(strictNonExternalClick.toolCalls.length, 1)
    assert.equal(
      strictNonExternalClick.events.some((event) => event.type === 'action_ledger_updated'),
      false,
      'an explicit non_external control must not mint a fake external Action Ledger entry',
    )

    const restoredStrictUnboundLedger = new ActionLedger()
    restoredStrictUnboundLedger.propose({
      actionId: 'restored:strict-unbound-send',
      actionKind: 'send',
      toolName: 'send_invoice',
    })
    restoredStrictUnboundLedger.authorize('restored:strict-unbound-send')
    restoredStrictUnboundLedger.begin('restored:strict-unbound-send')
    let restoredStrictUnboundToolCalls = 0
    await assert.rejects(
      runLoopScenario({
        trace,
        store,
        sessionId: 'permission-strict-unbound-restored-action',
        call: { id: 'ordinary-control-after-unbound-restore', name: 'browser_click_text', arguments: { text: 'Open details' } },
        risk: 'L1',
        gateDecisions: ['approve'],
        seedFresh: true,
        withSession: true,
        actionLedger: restoredStrictUnboundLedger,
        requireExternalActionReconciliation: true,
        toolRun() {
          restoredStrictUnboundToolCalls += 1
          return { observation: 'must not execute', pageChanged: false }
        },
      }),
      /EXTERNAL_ACTION_BINDING_REQUIRED: strict reconciliation mode cannot continue restored:strict-unbound-send/,
      'strict recovery must stop before the model when historical external work has no durable retry identity',
    )
    assert.equal(restoredStrictUnboundToolCalls, 0)

    let duplicateBootstrapProbeCalls = 0
    const alreadyReconciledProbe = {
      schemaVersion: 'external-action-probe/v1',
      id: 'already-reconciled-bootstrap-probe/v1',
      authority: 'read_only',
      async reconcile(request) {
        duplicateBootstrapProbeCalls += 1
        return {
          schemaVersion: 'external-action-reconciliation/v1',
          actionId: request.action.actionId,
          businessKey: request.businessKey,
          state: 'ambiguous',
          observedAt: new Date().toISOString(),
          verifier: this.id,
          independentlyObserved: false,
          evidenceIds: [],
          summary: 'The embedding Runtime already attempted this query once.',
        }
      },
    }
    const alreadyReconciledLedger = new ActionLedger()
    alreadyReconciledLedger.propose({
      actionId: 'bootstrap:unresolved-send',
      actionKind: 'send',
      toolName: 'send_invoice',
      externalBinding: {
        schemaVersion: 'external-action-binding/v2',
        businessKey: 'portal:customer-a:invoice:BOOTSTRAP-AMBIGUOUS',
        probeId: alreadyReconciledProbe.id,
        effectDigest: 'f'.repeat(64),
      },
    })
    alreadyReconciledLedger.authorize('bootstrap:unresolved-send')
    alreadyReconciledLedger.begin('bootstrap:unresolved-send')
    alreadyReconciledLedger.markAmbiguous('bootstrap:unresolved-send', 'Bootstrap attempt already ran.')
    const alreadyReconciled = await runLoopScenario({
      trace,
      store,
      sessionId: 'permission-skip-duplicate-bootstrap-reconciliation',
      call: { id: 'ordinary-click-after-bootstrap', name: 'browser_click_text', arguments: { text: 'Open details' } },
      risk: 'L3',
      gateDecisions: ['approve'],
      seedFresh: true,
      withSession: true,
      actionLedger: alreadyReconciledLedger,
      externalActionProbes: [alreadyReconciledProbe],
      externalActionBootstrapReconciled: true,
      requireExternalActionReconciliation: true,
    })
    assert.equal(
      duplicateBootstrapProbeCalls,
      0,
      'Agent Loop must not immediately repeat an ambiguous bootstrap query already attempted by the SDK',
    )
    assert.equal(
      alreadyReconciled.toolCalls.length,
      0,
      'a bootstrap handoff flag must not let strict mode start another tool while the ledger remains ambiguous',
    )
    assert.equal(alreadyReconciled.result.blocked, true)
    assert.match(alreadyReconciled.result.summary, /remain in doubt after authoritative reconciliation/)

    const invoiceReceipts = new Map()
    let invoiceProbeCalls = 0
    const invoiceProbe = {
      schemaVersion: 'external-action-probe/v1',
      id: 'invoice-receipt-query/v1',
      authority: 'read_only',
      async reconcile(request) {
        invoiceProbeCalls += 1
        const receipt = invoiceReceipts.get(request.businessKey)
        return {
          schemaVersion: 'external-action-reconciliation/v1',
          actionId: request.action.actionId,
          businessKey: request.businessKey,
          state: receipt ? 'committed' : 'not_committed',
          observedAt: new Date().toISOString(),
          verifier: this.id,
          independentlyObserved: true,
          evidenceIds: [receipt ? `receipt:${receipt}` : `invoice-query:${request.businessKey}:absent`],
          ...(receipt ? { externalReference: receipt } : {}),
          ...(receipt && request.action.externalBinding?.schemaVersion === 'external-action-binding/v2'
            ? { observedEffectDigest: request.action.externalBinding.effectDigest }
            : {}),
          ...(!receipt ? { retrySafe: true } : {}),
          summary: receipt ? 'Invoice receipt query confirmed the external send.' : 'Invoice receipt query found no send.',
        }
      },
    }
    const reconciledSend = await runLoopScenario({
      trace,
      store,
      sessionId: 'permission-send-reconciled',
      call: { id: 'send-invoice', name: 'send_invoice', arguments: { invoiceId: 'INV-CN-260601' } },
      risk: 'L3',
      gateDecisions: ['approve_and_execute'],
      seedFresh: true,
      withSession: true,
      allowFinalSubmit: true,
      allowExternalActionExecution: true,
      requireExternalActionReconciliation: true,
      preflightExternalActions: true,
      expectedExternalBusinessKeys: ['portal:customer-a:invoice:INV-CN-260601'],
      toolRun(args) {
        invoiceReceipts.set(`portal:customer-a:invoice:${args.invoiceId}`, 'CSP-884120')
        return { observation: 'Send request returned.', pageChanged: false }
      },
      externalActionBindingResolver(request) {
        return {
          schemaVersion: 'external-action-binding/v2',
          businessKey: `portal:customer-a:invoice:${request.args.invoiceId}`,
          probeId: invoiceProbe.id,
        }
      },
      externalActionProbes: [invoiceProbe],
    })
    const sendStatuses = reconciledSend.events
      .filter((event) => event.type === 'action_ledger_updated' && event.data?.entry?.actionKind === 'send')
      .map((event) => event.data.entry.status)
    assert.deepEqual(
      sendStatuses,
      ['proposed', 'authorized', 'executing', 'executed', 'committed'],
      'tool success must remain executed until an independent receipt query proves the business commit',
    )
    const committedSendEvent = reconciledSend.events.find((event) => (
      event.type === 'action_ledger_updated'
      && event.data?.entry?.actionKind === 'send'
      && event.data?.entry?.status === 'committed'
    ))
    assert.equal(committedSendEvent?.data?.reconciliation?.externalReference, 'CSP-884120')
    assert.deepEqual(committedSendEvent?.data?.reconciliation?.evidenceIds, ['receipt:CSP-884120'])
    assert.equal(
      reconciledSend.gate.requests[0]?.context?.externalBusinessKey,
      'portal:customer-a:invoice:INV-CN-260601',
      'the approval view must surface the business identity covered by its action digest',
    )
    assert.match(reconciledSend.gate.requests[0]?.context?.externalEffectDigest ?? '', /^[a-f0-9]{64}$/)
    const authorizedSend = reconciledSend.events.find((event) => (
      event.type === 'action_ledger_updated'
      && event.data?.entry?.actionKind === 'send'
      && event.data?.entry?.status === 'authorized'
    ))?.data?.entry
    assert.match(authorizedSend?.actionDecision?.actionBindingSha256 ?? '', /^[a-f0-9]{64}$/)
    assert.equal(committedSendEvent?.data?.receiptArtifact?.kind, 'external_action_receipt')
    assert.equal(committedSendEvent?.data?.receiptArtifact?.payloadSchemaVersion, 'external-action-receipt/v1')
    assert.equal(
      reconciledSend.result.artifacts.some((artifact) => artifact.kind === 'external_action_receipt'),
      true,
      'a committed external action must surface an immutable receipt artifact',
    )
    assert(reconciledSend.result.actions.some((action) => action.actionKind === 'send' && action.outcome === 'performed'))

    const retryPreflightBusinessKey = 'portal:customer-a:invoice:RETRY-PREFLIGHT'
    const retryPreflightLedger = new ActionLedger()
    retryPreflightLedger.propose({
      actionId: 'retry-preflight-send-1',
      actionKind: 'send',
      toolName: 'send_invoice',
      externalBinding: {
        schemaVersion: 'external-action-binding/v2',
        businessKey: retryPreflightBusinessKey,
        probeId: invoiceProbe.id,
        effectDigest: sendEffectDigest('RETRY-PREFLIGHT'),
      },
    })
    retryPreflightLedger.authorize('retry-preflight-send-1')
    retryPreflightLedger.begin('retry-preflight-send-1')
    retryPreflightLedger.markNotCommitted(
      'retry-preflight-send-1',
      'An earlier authoritative query proved this attempt absent.',
    )
    // Another trusted/manual path commits after the earlier absence verdict but
    // before this retry attempt. The retry must query again before approval.
    invoiceReceipts.set(retryPreflightBusinessKey, 'CSP-RETRY-PREFLIGHT-EXTERNAL')
    const probeCallsBeforeRetry = invoiceProbeCalls
    const retryPreflight = await runLoopScenario({
      trace,
      store,
      sessionId: 'permission-retry-rechecks-before-approval',
      call: {
        id: 'retry-preflight-send-2',
        name: 'send_invoice',
        arguments: { invoiceId: 'RETRY-PREFLIGHT' },
      },
      risk: 'L3',
      gateDecisions: [],
      seedFresh: true,
      withSession: true,
      actionLedger: retryPreflightLedger,
      externalActionBootstrapReconciled: true,
      requireExternalActionReconciliation: true,
      preflightExternalActions: true,
      expectedExternalBusinessKeys: [retryPreflightBusinessKey],
      externalActionBindingResolver(request) {
        return {
          schemaVersion: 'external-action-binding/v2',
          businessKey: `portal:customer-a:invoice:${request.args.invoiceId}`,
          probeId: invoiceProbe.id,
        }
      },
      externalActionProbes: [invoiceProbe],
    })
    assert.equal(invoiceProbeCalls, probeCallsBeforeRetry + 1)
    assert.equal(retryPreflight.gate.requests.length, 0)
    assert.equal(retryPreflight.toolCalls.length, 0)
    assert.deepEqual(
      retryPreflight.events
        .filter((event) => (
          event.type === 'action_ledger_updated'
          && event.data?.entry?.actionId === 'turn_001:retry-preflight-send-2'
        ))
        .map((event) => event.data.entry.status),
      ['proposed', 'committed'],
      'every reproposed not_committed attempt must re-query and no-op if another writer completed the effect',
    )
    assert(
      retryPreflight.result.actions.some((action) => (
        action.actionKind === 'send'
        && action.outcome === 'performed'
        && action.businessKey === retryPreflightBusinessKey
        && action.localExecutionAttempted === false
      )),
    )

    const adaptedClick = await runLoopScenario({
      trace,
      store,
      sessionId: 'permission-opaque-click-upgraded-to-send',
      call: { id: 'opaque-create-record-click', name: 'browser_click', arguments: { ref: 'e1', invoiceId: 'OPAQUE-CLICK' } },
      risk: 'L1',
      gateDecisions: ['approve_and_execute'],
      seedFresh: true,
      withSession: true,
      allowFinalSubmit: true,
      allowExternalActionExecution: true,
      requireExternalActionReconciliation: true,
      preflightExternalActions: true,
      adapterSinkKind: 'send',
      expectedExternalBusinessKeys: ['portal:customer-a:invoice:OPAQUE-CLICK'],
      toolRun(args) {
        invoiceReceipts.set(`portal:customer-a:invoice:${args.invoiceId}`, 'CSP-OPAQUE-1')
        return { observation: 'Opaque site control created the record.', pageChanged: true }
      },
      externalActionIntentResolver(request) {
        assert.equal(request.inferredActionKind, undefined)
        return {
          schemaVersion: 'external-action-intent/v1',
          actionKind: 'send',
          binding: {
            schemaVersion: 'external-action-binding/v2',
            businessKey: `portal:customer-a:invoice:${request.args.invoiceId}`,
            probeId: invoiceProbe.id,
            effectPayload: { invoiceId: request.args.invoiceId, operation: 'create_record' },
          },
        }
      },
      externalActionProbes: [invoiceProbe],
    })
    assert.equal(adaptedClick.toolCalls.length, 1)
    assert.equal(adaptedClick.gate.requests.length, 1)
    assert.deepEqual(
      adaptedClick.queue.snapshot().approved[0]?.allowedDecisions,
      ['approve', 'approve_and_execute', 'decline', 'takeover'],
      'a reconciled send must offer machine execution separately from awareness approval',
    )
    assert.equal(
      adaptedClick.queue.snapshot().approved[0]?.resolution?.decision,
      'approve_and_execute',
    )
    assert.equal(
      adaptedClick.queue.snapshot().approved[0]?.risk,
      'L3',
      'the durable approval risk must be elevated after an opaque L1 control is classified as an external send',
    )
    assert.equal(
      adaptedClick.gate.requests[0]?.context?.externalBusinessKey,
      'portal:customer-a:invoice:OPAQUE-CLICK',
      'intent upgrade must re-run Sink Policy and exact approval even when the opaque control looked low-risk',
    )
    assert.deepEqual(
      adaptedClick.events
        .filter((event) => event.type === 'action_ledger_updated' && event.data?.entry?.actionKind === 'send')
        .map((event) => event.data.entry.status),
      ['proposed', 'authorized', 'executing', 'executed', 'committed'],
      'a trusted adapter must be able to upgrade an opaque click before it reaches the external boundary',
    )

    let awarenessOnlySendWrites = 0
    const awarenessOnlySend = await runLoopScenario({
      trace,
      store,
      sessionId: 'permission-opaque-send-awareness-does-not-execute',
      call: { id: 'opaque-awareness-click', name: 'browser_click', arguments: { ref: 'e1', invoiceId: 'AWARENESS-ONLY' } },
      risk: 'L1',
      gateDecisions: ['approve'],
      seedFresh: true,
      withSession: true,
      allowFinalSubmit: true,
      allowExternalActionExecution: true,
      requireExternalActionReconciliation: true,
      preflightExternalActions: true,
      adapterSinkKind: 'send',
      expectedExternalBusinessKeys: ['portal:customer-a:invoice:AWARENESS-ONLY'],
      toolRun() {
        awarenessOnlySendWrites += 1
        return { observation: 'awareness-only send must not execute', pageChanged: true }
      },
      externalActionIntentResolver(request) {
        return {
          schemaVersion: 'external-action-intent/v1',
          actionKind: 'send',
          binding: {
            schemaVersion: 'external-action-binding/v2',
            businessKey: `portal:customer-a:invoice:${request.args.invoiceId}`,
            probeId: invoiceProbe.id,
            effectPayload: { invoiceId: request.args.invoiceId, operation: 'create_record' },
          },
        }
      },
      externalActionProbes: [invoiceProbe],
    })
    assert.equal(awarenessOnlySendWrites, 0)
    assert.equal(awarenessOnlySend.toolCalls.length, 0)
    assert.equal(awarenessOnlySend.queue.snapshot().approved[0]?.resolution?.decision, 'approve')
    assert.deepEqual(
      awarenessOnlySend.events
        .filter((event) => event.type === 'action_ledger_updated' && event.data?.entry?.actionKind === 'send')
        .map((event) => event.data.entry.status),
      ['proposed', 'authorized', 'skipped'],
      'awareness approval must be durable but cannot cross an external send boundary',
    )

    let noPreflightSendWrites = 0
    const noPreflightSend = await runLoopScenario({
      trace,
      store,
      sessionId: 'permission-send-without-preflight-cannot-offer-execution',
      call: { id: 'send-without-preflight', name: 'send_invoice', arguments: { invoiceId: 'NO-PREFLIGHT' } },
      risk: 'L3',
      gateDecisions: ['approve'],
      seedFresh: true,
      withSession: true,
      allowExternalActionExecution: true,
      requireExternalActionReconciliation: true,
      expectedExternalBusinessKeys: ['portal:customer-a:invoice:NO-PREFLIGHT'],
      toolRun() {
        noPreflightSendWrites += 1
        return { observation: 'a machine write without authoritative preflight must not execute', pageChanged: false }
      },
      externalActionBindingResolver(request) {
        return {
          schemaVersion: 'external-action-binding/v2',
          businessKey: `portal:customer-a:invoice:${request.args.invoiceId}`,
          probeId: invoiceProbe.id,
        }
      },
      externalActionProbes: [invoiceProbe],
    })
    assert.deepEqual(
      noPreflightSend.queue.snapshot().approved[0]?.allowedDecisions,
      ['approve', 'decline', 'takeover'],
      'strict binding without authoritative fresh-run preflight must still be awareness-only',
    )
    assert.equal(noPreflightSendWrites, 0)
    assert.equal(noPreflightSend.toolCalls.length, 0)

    const nonDurableGate = new RecordingGate(['approve_and_execute'])
    let nonDurableProbeCalls = 0
    let nonDurableToolCalls = 0
    await assert.rejects(
      () => runLoopScenario({
        trace,
        store,
        sessionId: 'permission-nondurable-session-cannot-reach-external-approval',
        call: { id: 'send-without-durable-session', name: 'send_invoice', arguments: { invoiceId: 'NO-DURABLE' } },
        risk: 'L3',
        gateDecisions: [],
        gateOverride: nonDurableGate,
        seedFresh: true,
        withSession: true,
        allowExternalActionExecution: true,
        requireExternalActionReconciliation: true,
        preflightExternalActions: true,
        expectedExternalBusinessKeys: ['portal:customer-a:invoice:NO-DURABLE'],
        sessionDecorator(recorder) {
          return new Proxy(recorder, {
            get(target, property) {
              if (property === 'durability') return 'none'
              const value = target[property]
              return typeof value === 'function' ? value.bind(target) : value
            },
          })
        },
        toolRun() {
          nonDurableToolCalls += 1
          return { observation: 'a non-durable session must not execute', pageChanged: false }
        },
        externalActionBindingResolver(request) {
          return {
            schemaVersion: 'external-action-binding/v2',
            businessKey: `portal:customer-a:invoice:${request.args.invoiceId}`,
            probeId: 'non-durable-probe/v1',
          }
        },
        externalActionProbes: [{
          schemaVersion: 'external-action-probe/v1',
          id: 'non-durable-probe/v1',
          authority: 'read_only',
          async reconcile() {
            nonDurableProbeCalls += 1
            throw new Error('a non-durable run must fail before probing')
          },
        }],
      }),
      /DURABLE_ACTION_JOURNAL_REQUIRED: send preflight evidence requires a durable session/,
    )
    assert.equal(nonDurableGate.requests.length, 0)
    assert.equal(nonDurableProbeCalls, 0)
    assert.equal(nonDurableToolCalls, 0)

    const probeCallsBeforeMissingSessionRef = invoiceProbeCalls
    let missingSessionRefWrites = 0
    const missingSessionRef = await runLoopScenario({
      trace,
      store,
      sessionId: 'permission-missing-session-ref-cannot-offer-execution',
      call: { id: 'send-without-session-ref', name: 'send_invoice', arguments: { invoiceId: 'NO-SESSION-REF' } },
      risk: 'L3',
      gateDecisions: ['approve'],
      seedFresh: true,
      withSession: true,
      omitSessionRef: true,
      allowExternalActionExecution: true,
      requireExternalActionReconciliation: true,
      preflightExternalActions: true,
      expectedExternalBusinessKeys: ['portal:customer-a:invoice:NO-SESSION-REF'],
      toolRun() {
        missingSessionRefWrites += 1
        return { observation: 'a missing execution epoch must not write', pageChanged: false }
      },
      externalActionBindingResolver(request) {
        return {
          schemaVersion: 'external-action-binding/v2',
          businessKey: `portal:customer-a:invoice:${request.args.invoiceId}`,
          probeId: invoiceProbe.id,
        }
      },
      externalActionProbes: [invoiceProbe],
    })
    assert.equal(invoiceProbeCalls, probeCallsBeforeMissingSessionRef + 1)
    assert.deepEqual(
      missingSessionRef.queue.snapshot().approved[0]?.allowedDecisions,
      ['approve', 'decline', 'takeover'],
      'a durable file without an exact SessionRef/attempt may support awareness but not machine execution',
    )
    assert.equal(missingSessionRefWrites, 0)
    assert.equal(missingSessionRef.toolCalls.length, 0)

    const adaptedPaymentClick = await runLoopScenario({
      trace,
      store,
      sessionId: 'permission-opaque-click-upgraded-to-payment',
      call: { id: 'opaque-payment-click', name: 'browser_click', arguments: { ref: 'e1', invoiceId: 'PAYMENT-CLICK' } },
      risk: 'L1',
      gateDecisions: ['approve_and_execute'],
      seedFresh: true,
      withSession: true,
      allowFinalSubmit: true,
      allowExternalActionExecution: true,
      requireExternalActionReconciliation: true,
      preflightExternalActions: true,
      adapterSinkKind: 'payment',
      toolRun(args) {
        invoiceReceipts.set(`portal:customer-a:invoice:${args.invoiceId}`, 'CSP-PAYMENT-1')
        return { observation: 'Opaque site control initiated the authorized payment effect.', pageChanged: true }
      },
      externalActionIntentResolver(request) {
        return {
          schemaVersion: 'external-action-intent/v1',
          actionKind: 'payment',
          binding: {
            schemaVersion: 'external-action-binding/v2',
            businessKey: `portal:customer-a:invoice:${request.args.invoiceId}`,
            probeId: invoiceProbe.id,
            effectPayload: { invoiceId: request.args.invoiceId, operation: 'payment' },
          },
        }
      },
      externalActionProbes: [invoiceProbe],
      expectedExternalBusinessKeys: ['portal:customer-a:invoice:PAYMENT-CLICK'],
    })
    assert.equal(adaptedPaymentClick.queue.snapshot().approved[0]?.risk, 'L4')
    assert.equal(adaptedPaymentClick.queue.snapshot().approved[0]?.riskLevel, 'critical')
    assert.deepEqual(
      adaptedPaymentClick.queue.snapshot().approved[0]?.allowedDecisions,
      ['approve', 'approve_and_execute', 'decline', 'takeover'],
      'machine execution must be an explicitly offered decision, distinct from awareness approval',
    )
    assert.equal(
      adaptedPaymentClick.queue.snapshot().approved[0]?.resolution?.decision,
      'approve_and_execute',
      'payment must preserve the distinct machine-execution decision in the approval audit',
    )
    assert(
      adaptedPaymentClick.result.actions.some((action) => (
        action.actionKind === 'payment' && action.outcome === 'performed'
      )),
    )
    assert.equal(adaptedPaymentClick.toolCalls.length, 1)
    assert.deepEqual(
      adaptedPaymentClick.events
        .filter((event) => event.type === 'action_ledger_updated' && event.data?.entry?.actionKind === 'payment')
        .map((event) => event.data.entry.status),
      ['proposed', 'authorized', 'executing', 'executed', 'committed'],
      'approve_and_execute must still cross the durable journal and read-only reconciliation path',
    )

    let offContractSubmitToolCalls = 0
    const offContractSubmit = await runLoopScenario({
      trace,
      store,
      sessionId: 'permission-off-contract-submit-cannot-execute',
      call: {
        id: 'off-contract-submit-click',
        name: 'browser_click',
        arguments: { ref: 'e1', invoiceId: 'OFF-CONTRACT' },
      },
      risk: 'L1',
      gateDecisions: ['approve'],
      seedFresh: true,
      withSession: true,
      allowFinalSubmit: true,
      allowExternalActionExecution: true,
      requireExternalActionReconciliation: true,
      preflightExternalActions: true,
      adapterSinkKind: 'submit',
      expectedExternalBusinessKeys: ['portal:customer-a:invoice:CONTRACT-TARGET'],
      toolRun() {
        offContractSubmitToolCalls += 1
        return { observation: 'off-contract submit must not execute', pageChanged: true }
      },
      externalActionIntentResolver(request) {
        return {
          schemaVersion: 'external-action-intent/v1',
          actionKind: 'submit',
          binding: {
            schemaVersion: 'external-action-binding/v2',
            businessKey: `portal:customer-a:invoice:${request.args.invoiceId}`,
            probeId: invoiceProbe.id,
            effectPayload: { invoiceId: request.args.invoiceId, operation: 'submit_invoice' },
          },
        }
      },
      externalActionProbes: [invoiceProbe],
    })
    const offContractApproval = offContractSubmit.queue.snapshot().approved[0]
    assert.deepEqual(
      offContractApproval?.allowedDecisions,
      ['approve', 'decline', 'takeover'],
      'a final-submit business key outside the exact TaskContract must never offer machine execution',
    )
    assert.equal(offContractApproval?.resolution?.decision, 'approve')
    assert.equal(offContractSubmitToolCalls, 0)
    assert.equal(offContractSubmit.toolCalls.length, 0)
    assert.equal(
      offContractSubmit.result.actions.some((action) => (
        action.businessKey === 'portal:customer-a:invoice:OFF-CONTRACT'
        && action.outcome === 'performed'
      )),
      false,
    )

    let optionalContractSubmitToolCalls = 0
    const optionalContractSubmit = await runLoopScenario({
      trace,
      store,
      sessionId: 'permission-optional-contract-submit-cannot-execute',
      call: {
        id: 'optional-contract-submit-click',
        name: 'browser_click',
        arguments: { ref: 'e1', invoiceId: 'OPTIONAL-CONTRACT' },
      },
      risk: 'L1',
      gateDecisions: ['approve'],
      seedFresh: true,
      withSession: true,
      allowFinalSubmit: true,
      allowExternalActionExecution: true,
      requireExternalActionReconciliation: true,
      preflightExternalActions: true,
      adapterSinkKind: 'submit',
      expectedExternalBusinessKeys: ['portal:customer-a:invoice:REQUIRED-TARGET'],
      optionalExternalBusinessKeys: ['portal:customer-a:invoice:OPTIONAL-CONTRACT'],
      toolRun() {
        optionalContractSubmitToolCalls += 1
        return { observation: 'optional contract submit must not execute', pageChanged: true }
      },
      externalActionIntentResolver(request) {
        return {
          schemaVersion: 'external-action-intent/v1',
          actionKind: 'submit',
          binding: {
            schemaVersion: 'external-action-binding/v2',
            businessKey: `portal:customer-a:invoice:${request.args.invoiceId}`,
            probeId: invoiceProbe.id,
            effectPayload: { invoiceId: request.args.invoiceId, operation: 'submit_invoice' },
          },
        }
      },
      externalActionProbes: [invoiceProbe],
    })
    const optionalContractApproval = optionalContractSubmit.queue.snapshot().approved[0]
    assert.deepEqual(
      optionalContractApproval?.allowedDecisions,
      ['approve', 'decline', 'takeover'],
      'an optional Contract criterion may request evidence but must never authorize machine execution',
    )
    assert.equal(optionalContractApproval?.resolution?.decision, 'approve')
    assert.equal(optionalContractSubmitToolCalls, 0)
    assert.equal(optionalContractSubmit.toolCalls.length, 0)
    assert.equal(
      optionalContractSubmit.result.actions.some((action) => (
        action.businessKey === 'portal:customer-a:invoice:OPTIONAL-CONTRACT'
        && action.outcome === 'performed'
      )),
      false,
    )

    const unreviewableEffects = [
      {
        label: 'secret',
        invoiceId: 'UNREVIEWABLE-SECRET',
        effectPayload: {
          invoiceId: 'UNREVIEWABLE-SECRET',
          operation: 'submit_invoice',
          apiToken: 'secret-must-not-enter-the-approval-view',
        },
      },
      {
        label: 'oversized',
        invoiceId: 'UNREVIEWABLE-OVERSIZED',
        effectPayload: {
          invoiceId: 'UNREVIEWABLE-OVERSIZED',
          operation: 'submit_invoice',
          attachmentManifest: 'x'.repeat(1_100),
        },
      },
    ]
    for (const scenario of unreviewableEffects) {
      let unreviewableToolCalls = 0
      const targetBusinessKey = `portal:customer-a:invoice:${scenario.invoiceId}`
      const unreviewable = await runLoopScenario({
        trace,
        store,
        sessionId: `permission-${scenario.label}-effect-cannot-execute`,
        call: {
          id: `${scenario.label}-effect-submit-click`,
          name: 'browser_click',
          arguments: { ref: 'e1', invoiceId: scenario.invoiceId },
        },
        risk: 'L1',
        gateDecisions: ['approve'],
        seedFresh: true,
        withSession: true,
        allowFinalSubmit: true,
        allowExternalActionExecution: true,
        requireExternalActionReconciliation: true,
        preflightExternalActions: true,
        adapterSinkKind: 'submit',
        expectedExternalBusinessKeys: [targetBusinessKey],
        toolRun() {
          unreviewableToolCalls += 1
          return { observation: 'unreviewable effect must not execute', pageChanged: true }
        },
        externalActionIntentResolver() {
          return {
            schemaVersion: 'external-action-intent/v1',
            actionKind: 'submit',
            binding: {
              schemaVersion: 'external-action-binding/v2',
              businessKey: targetBusinessKey,
              probeId: invoiceProbe.id,
              effectPayload: scenario.effectPayload,
            },
          }
        },
        externalActionProbes: [invoiceProbe],
      })
      const approval = unreviewable.queue.snapshot().approved[0]
      assert.deepEqual(
        approval?.allowedDecisions,
        ['approve', 'decline', 'takeover'],
        `${scenario.label} effects that cannot be reviewed completely must not offer machine execution`,
      )
      assert.equal(approval?.context?.externalEffectPreview, undefined)
      assert.equal(unreviewableToolCalls, 0)
      assert.equal(unreviewable.toolCalls.length, 0)
    }

    const adaptedInvoiceSubmitClick = await runLoopScenario({
      trace,
      store,
      sessionId: 'permission-opaque-click-upgraded-to-invoice-submit',
      call: {
        id: 'opaque-invoice-submit-click',
        name: 'browser_click',
        arguments: { ref: 'e1', invoiceId: 'INV-CN-EXECUTE-1', amount: 48_600 },
      },
      risk: 'L1',
      gateDecisions: ['approve_and_execute'],
      seedFresh: true,
      withSession: true,
      allowFinalSubmit: true,
      allowExternalActionExecution: true,
      requireExternalActionReconciliation: true,
      preflightExternalActions: true,
      adapterSinkKind: 'submit',
      toolRun(args) {
        invoiceReceipts.set(`portal:customer-a:invoice:${args.invoiceId}`, 'CSP-INVOICE-EXECUTE-1')
        return { observation: 'The controlled invoice portal accepted the exact invoice.', pageChanged: true }
      },
      externalActionIntentResolver(request) {
        return {
          schemaVersion: 'external-action-intent/v1',
          actionKind: 'submit',
          binding: {
            schemaVersion: 'external-action-binding/v2',
            businessKey: `portal:customer-a:invoice:${request.args.invoiceId}`,
            probeId: invoiceProbe.id,
            effectPayload: {
              invoiceId: request.args.invoiceId,
              amount: request.args.amount,
              operation: 'submit_invoice',
            },
          },
        }
      },
      externalActionProbes: [invoiceProbe],
      expectedExternalBusinessKeys: ['portal:customer-a:invoice:INV-CN-EXECUTE-1'],
    })
    assert.equal(adaptedInvoiceSubmitClick.queue.snapshot().approved[0]?.risk, 'L3')
    assert.equal(adaptedInvoiceSubmitClick.queue.snapshot().approved[0]?.riskLevel, 'high')
    assert.equal(
      adaptedInvoiceSubmitClick.queue.snapshot().approved[0]?.resolution?.decision,
      'approve_and_execute',
      'the invoice scenario must preserve execution authorization rather than reuse awareness approval',
    )
    assert.equal(
      adaptedInvoiceSubmitClick.queue.snapshot().approved[0]?.context?.externalEffectPreview,
      '{"amount":48600,"invoiceId":"INV-CN-EXECUTE-1","operation":"submit_invoice"}',
      'the approver must see canonical business fields, not only an opaque effect digest',
    )
    assert.equal(adaptedInvoiceSubmitClick.toolCalls.length, 1)
    assert.deepEqual(
      adaptedInvoiceSubmitClick.events
        .filter((event) => event.type === 'action_ledger_updated' && event.data?.entry?.actionKind === 'submit')
        .map((event) => event.data.entry.status),
      ['proposed', 'authorized', 'executing', 'executed', 'committed'],
      'the interview invoice scenario must run through the generic Agent Loop, not only the batch POC harness',
    )
    const committedInvoiceSubmit = adaptedInvoiceSubmitClick.events.find((event) => (
      event.type === 'action_ledger_updated'
      && event.data?.entry?.actionKind === 'submit'
      && event.data?.entry?.status === 'committed'
    ))
    assert.equal(
      committedInvoiceSubmit?.data?.reconciliation?.externalReference,
      'CSP-INVOICE-EXECUTE-1',
    )
    assert.equal(committedInvoiceSubmit?.data?.receiptArtifact?.kind, 'external_action_receipt')
    assert.equal(adaptedInvoiceSubmitClick.result.done, true)
    assert.equal(
      adaptedInvoiceSubmitClick.result.blocked,
      false,
      'the single-invoice Completion Contract must require both the committed key and its receipt artifact',
    )
    assert(
      adaptedInvoiceSubmitClick.result.actions.some((action) => (
        action.actionKind === 'submit' && action.outcome === 'performed'
      )),
    )

    const partialInvoiceSubmit = await runLoopScenario({
      trace,
      store,
      sessionId: 'permission-partial-invoice-submit-stays-blocked',
      call: {
        id: 'partial-invoice-submit-click',
        name: 'browser_click',
        arguments: { ref: 'e1', invoiceId: 'INV-CN-PARTIAL-1', amount: 36_000 },
      },
      risk: 'L1',
      gateDecisions: ['approve_and_execute'],
      seedFresh: true,
      withSession: true,
      allowFinalSubmit: true,
      allowExternalActionExecution: true,
      requireExternalActionReconciliation: true,
      preflightExternalActions: true,
      adapterSinkKind: 'submit',
      toolRun(args) {
        invoiceReceipts.set(`portal:customer-a:invoice:${args.invoiceId}`, 'CSP-INVOICE-PARTIAL-1')
        return { observation: 'Only the first controlled invoice was accepted.', pageChanged: true }
      },
      externalActionIntentResolver(request) {
        return {
          schemaVersion: 'external-action-intent/v1',
          actionKind: 'submit',
          binding: {
            schemaVersion: 'external-action-binding/v2',
            businessKey: `portal:customer-a:invoice:${request.args.invoiceId}`,
            probeId: invoiceProbe.id,
            effectPayload: {
              invoiceId: request.args.invoiceId,
              amount: request.args.amount,
              operation: 'submit_invoice',
            },
          },
        }
      },
      externalActionProbes: [invoiceProbe],
      expectedExternalBusinessKeys: [
        'portal:customer-a:invoice:INV-CN-PARTIAL-1',
        'portal:customer-a:invoice:INV-CN-PARTIAL-2',
      ],
    })
    assert.equal(partialInvoiceSubmit.toolCalls.length, 1)
    assert.equal(partialInvoiceSubmit.result.done, true)
    assert.equal(
      partialInvoiceSubmit.result.blocked,
      true,
      'one committed invoice must not release a two-business-key Completion Contract',
    )
    assert.equal(partialInvoiceSubmit.result.workflowState?.phase, 'final_submit_boundary')

    let conflictingClassifierToolCalls = 0
    await assert.rejects(
      runLoopScenario({
        trace,
        store,
        sessionId: 'permission-external-classification-conflict',
        call: { id: 'already-send', name: 'send_invoice', arguments: { invoiceId: 'CLASSIFICATION-CONFLICT' } },
        risk: 'L3',
        gateDecisions: ['approve'],
        seedFresh: true,
        withSession: true,
        toolRun() {
          conflictingClassifierToolCalls += 1
          return { observation: 'must not execute', pageChanged: false }
        },
        externalActionIntentResolver(request) {
          return {
            schemaVersion: 'external-action-intent/v1',
            actionKind: 'upload',
            binding: {
              schemaVersion: 'external-action-binding/v2',
              businessKey: `portal:customer-a:invoice:${request.args.invoiceId}`,
              probeId: invoiceProbe.id,
            },
          }
        },
        externalActionProbes: [invoiceProbe],
      }),
      /EXTERNAL_ACTION_CLASSIFICATION_CONFLICT: runtime inferred send, adapter returned upload/,
    )
    assert.equal(conflictingClassifierToolCalls, 0)

    const mutatingIntentCall = {
      id: 'mutating-intent-adapter',
      name: 'browser_click',
      arguments: { ref: 'e1', invoiceId: 'IMMUTABLE-INTENT' },
    }
    let mutatingIntentToolCalls = 0
    await assert.rejects(
      runLoopScenario({
        trace,
        store,
        sessionId: 'permission-external-intent-input-immutable',
        call: mutatingIntentCall,
        risk: 'L3',
        gateDecisions: ['approve'],
        seedFresh: true,
        withSession: true,
        adapterSinkKind: 'send',
        toolRun() {
          mutatingIntentToolCalls += 1
          return { observation: 'must not execute', pageChanged: false }
        },
        externalActionIntentResolver(request) {
          request.args.invoiceId = 'MUTATED-BY-ADAPTER'
          return undefined
        },
        externalActionProbes: [invoiceProbe],
      }),
      TypeError,
      'an intent adapter must receive a deep-frozen clone, not the executable tool arguments',
    )
    assert.equal(mutatingIntentToolCalls, 0)
    assert.equal(mutatingIntentCall.arguments.invoiceId, 'IMMUTABLE-INTENT')

    const mutatingBindingCall = {
      id: 'mutating-binding-adapter',
      name: 'send_invoice',
      arguments: { invoiceId: 'IMMUTABLE-BINDING' },
    }
    let mutatingBindingToolCalls = 0
    await assert.rejects(
      runLoopScenario({
        trace,
        store,
        sessionId: 'permission-external-binding-input-immutable',
        call: mutatingBindingCall,
        risk: 'L3',
        gateDecisions: ['approve'],
        seedFresh: true,
        withSession: true,
        toolRun() {
          mutatingBindingToolCalls += 1
          return { observation: 'must not execute', pageChanged: false }
        },
        externalActionBindingResolver(request) {
          request.args.invoiceId = 'MUTATED-BY-ADAPTER'
          return undefined
        },
        externalActionProbes: [invoiceProbe],
      }),
      TypeError,
      'a binding adapter must receive the same immutable argument snapshot',
    )
    assert.equal(mutatingBindingToolCalls, 0)
    assert.equal(mutatingBindingCall.arguments.invoiceId, 'IMMUTABLE-BINDING')

    await assert.rejects(
      runLoopScenario({
        trace,
        store,
        sessionId: 'permission-send-missing-probe',
        call: { id: 'send-with-missing-probe', name: 'send_invoice', arguments: { invoiceId: 'INV-CN-NO-PROBE' } },
        risk: 'L3',
        gateDecisions: ['approve'],
        seedFresh: true,
        withSession: true,
        externalActionBindingResolver(request) {
          return {
            schemaVersion: 'external-action-binding/v2',
            businessKey: `portal:customer-a:invoice:${request.args.invoiceId}`,
            probeId: 'missing-invoice-probe/v1',
          }
        },
        externalActionProbes: [],
      }),
      /EXTERNAL_ACTION_PROBE_REQUIRED: missing-invoice-probe\/v1/,
      'a configured business binding without its deterministic probe must fail before the side effect',
    )

    let unsafeProbeToolCalls = 0
    await assert.rejects(
      runLoopScenario({
        trace,
        store,
        sessionId: 'permission-send-unsafe-probe',
        call: { id: 'send-with-unsafe-probe', name: 'send_invoice', arguments: { invoiceId: 'INV-CN-UNSAFE-PROBE' } },
        risk: 'L3',
        gateDecisions: ['approve'],
        seedFresh: true,
        withSession: true,
        toolRun() {
          unsafeProbeToolCalls += 1
          return { observation: 'unsafe', pageChanged: false }
        },
        externalActionBindingResolver(request) {
          return {
            schemaVersion: 'external-action-binding/v2',
            businessKey: `portal:customer-a:invoice:${request.args.invoiceId}`,
            probeId: 'unsafe-invoice-probe/v1',
          }
        },
        externalActionProbes: [{
          schemaVersion: 'external-action-probe/v1',
          id: 'unsafe-invoice-probe/v1',
          authority: 'browser_write',
          async reconcile() {
            throw new Error('unsafe probe must never be invoked')
          },
        }],
      }),
      /read_only external-action-probe\/v1 contract/i,
      'the runtime must reject a write-capable recovery probe before executing the side effect',
    )
    assert.equal(unsafeProbeToolCalls, 0)

    const retryAfterAbsenceLedger = new ActionLedger(() => new Date('2026-08-12T00:03:00.000Z'))
    retryAfterAbsenceLedger.propose({
      actionId: 'prior-attempt:send-invoice',
      actionKind: 'send',
      toolName: 'send_invoice',
      externalBinding: {
        schemaVersion: 'external-action-binding/v2',
        businessKey: 'portal:customer-a:invoice:INV-CN-RETRY',
        probeId: invoiceProbe.id,
        effectDigest: sendEffectDigest('INV-CN-RETRY'),
      },
    })
    retryAfterAbsenceLedger.authorize(
      'prior-attempt:send-invoice',
      'Approval for the first attempt only.',
      {
        schemaVersion: 'action-decision-ref/v1',
        source: 'human_gate',
        decisionRef: 'approval:first-attempt-only',
      },
    )
    retryAfterAbsenceLedger.begin('prior-attempt:send-invoice')
    retryAfterAbsenceLedger.markNotCommitted(
      'prior-attempt:send-invoice',
      'Authoritative portal query proved absence and retry safety.',
    )
    const retriedAfterAbsence = await runLoopScenario({
      trace,
      store,
      sessionId: 'permission-send-retry-after-proven-absence',
      call: { id: 'fresh-retry-send', name: 'send_invoice', arguments: { invoiceId: 'INV-CN-RETRY' } },
      risk: 'L3',
      gateDecisions: ['approve_and_execute'],
      seedFresh: true,
      withSession: true,
      allowFinalSubmit: true,
      allowExternalActionExecution: true,
      requireExternalActionReconciliation: true,
      preflightExternalActions: true,
      expectedExternalBusinessKeys: ['portal:customer-a:invoice:INV-CN-RETRY'],
      actionLedger: retryAfterAbsenceLedger,
      toolRun(args) {
        invoiceReceipts.set(`portal:customer-a:invoice:${args.invoiceId}`, 'CSP-RETRY-1')
        return { observation: 'Freshly approved retry returned.', pageChanged: false }
      },
      externalActionBindingResolver(request) {
        return {
          schemaVersion: 'external-action-binding/v2',
          businessKey: `portal:customer-a:invoice:${request.args.invoiceId}`,
          probeId: invoiceProbe.id,
        }
      },
      externalActionProbes: [invoiceProbe],
    })
    assert.equal(retriedAfterAbsence.gate.requests.length, 1, 'retry must request a fresh approval')
    assert.equal(retriedAfterAbsence.toolCalls.length, 1, 'only the newly approved retry may execute')
    const retryAuthorization = retryAfterAbsenceLedger.snapshot().filter((entry) => (
      entry.actionKind === 'send' && entry.status === 'authorized'
    )).at(-1)?.actionDecision
    assert.equal(retryAuthorization?.source, 'human_gate')
    assert.notEqual(retryAuthorization?.decisionRef, 'approval:first-attempt-only')
    const persistedRetryDecision = retriedAfterAbsence.events.filter((event) => (
      event.type === 'action_ledger_updated'
      && event.data?.entry?.actionKind === 'send'
      && event.data?.entry?.status === 'authorized'
    )).at(-1)?.data?.entry?.actionDecision
    assert.deepEqual(
      persistedRetryDecision,
      retryAuthorization,
      'the persistence sanitizer must retain the structured decision audit reference',
    )
    assert(
      retriedAfterAbsence.result.actions.some((action) => (
        action.actionKind === 'send'
        && action.businessKey === 'portal:customer-a:invoice:INV-CN-RETRY'
        && action.outcome === 'performed'
      )),
    )

    const collidingEffectLedger = new ActionLedger(() => new Date('2026-08-12T00:03:30.000Z'))
    collidingEffectLedger.propose({
      actionId: 'prior-attempt:send-colliding-invoice',
      actionKind: 'send',
      toolName: 'send_invoice',
      externalBinding: {
        schemaVersion: 'external-action-binding/v2',
        businessKey: 'portal:customer-a:invoice:INV-CN-COLLISION',
        probeId: invoiceProbe.id,
        effectDigest: sendEffectDigest('INV-CN-COLLISION', { amount: 100 }),
      },
    })
    collidingEffectLedger.authorize('prior-attempt:send-colliding-invoice')
    collidingEffectLedger.begin('prior-attempt:send-colliding-invoice')
    collidingEffectLedger.markNotCommitted('prior-attempt:send-colliding-invoice', 'Safe to retry the original payload.')
    let collidingEffectToolCalls = 0
    await assert.rejects(
      runLoopScenario({
        trace,
        store,
        sessionId: 'permission-send-key-collision',
        call: {
          id: 'changed-payload-same-key',
          name: 'send_invoice',
          arguments: { invoiceId: 'INV-CN-COLLISION', amount: 200 },
        },
        risk: 'L3',
        gateDecisions: ['approve'],
        seedFresh: true,
        withSession: true,
        actionLedger: collidingEffectLedger,
        toolRun() {
          collidingEffectToolCalls += 1
          return { observation: 'must not execute', pageChanged: false }
        },
        externalActionBindingResolver(request) {
          return {
            schemaVersion: 'external-action-binding/v2',
            businessKey: `portal:customer-a:invoice:${request.args.invoiceId}`,
            probeId: invoiceProbe.id,
          }
        },
        externalActionProbes: [invoiceProbe],
      }),
      /EXTERNAL_ACTION_KEY_COLLISION/i,
      'a changed payload must not reuse an old business key or prior confirmation',
    )
    assert.equal(collidingEffectToolCalls, 0)

    const crossKindCollisionLedger = new ActionLedger(() => new Date('2026-08-12T00:03:35.000Z'))
    crossKindCollisionLedger.propose({
      actionId: 'prior-attempt:send-cross-kind-invoice',
      actionKind: 'send',
      toolName: 'send_invoice',
      externalBinding: {
        schemaVersion: 'external-action-binding/v2',
        businessKey: 'portal:customer-a:invoice:INV-CN-CROSS-KIND',
        probeId: invoiceProbe.id,
        effectDigest: sendEffectDigest('INV-CN-CROSS-KIND', { amount: 100 }),
      },
    })
    crossKindCollisionLedger.authorize('prior-attempt:send-cross-kind-invoice')
    crossKindCollisionLedger.begin('prior-attempt:send-cross-kind-invoice')
    crossKindCollisionLedger.markNotCommitted(
      'prior-attempt:send-cross-kind-invoice',
      'The original send effect was authoritatively absent.',
    )
    let crossKindCollisionToolCalls = 0
    await assert.rejects(
      runLoopScenario({
        trace,
        store,
        sessionId: 'permission-cross-kind-business-key-collision',
        call: {
          id: 'same-key-reclassified-as-submit',
          name: 'browser_click',
          arguments: { ref: 'e1', invoiceId: 'INV-CN-CROSS-KIND', amount: 100 },
        },
        risk: 'L1',
        gateDecisions: ['approve'],
        seedFresh: true,
        withSession: true,
        adapterSinkKind: 'submit',
        actionLedger: crossKindCollisionLedger,
        toolRun() {
          crossKindCollisionToolCalls += 1
          return { observation: 'must not execute', pageChanged: false }
        },
        externalActionIntentResolver(request) {
          return {
            schemaVersion: 'external-action-intent/v1',
            actionKind: 'submit',
            binding: {
              schemaVersion: 'external-action-binding/v2',
              businessKey: `portal:customer-a:invoice:${request.args.invoiceId}`,
              probeId: invoiceProbe.id,
              effectPayload: { invoiceId: request.args.invoiceId, amount: request.args.amount },
            },
          }
        },
        externalActionProbes: [invoiceProbe],
      }),
      /EXTERNAL_ACTION_KEY_COLLISION/i,
      'changing the classifier label must not create a second retry namespace for the same business effect',
    )
    assert.equal(crossKindCollisionToolCalls, 0)

    const legacyBindingBase = {
      schemaVersion: 'action-ledger-entry/v1',
      actionId: 'legacy-attempt:send-invoice',
      actionKind: 'send',
      toolName: 'send_invoice',
      recordedAt: '2026-08-12T00:03:40.000Z',
      externalBinding: {
        schemaVersion: 'external-action-binding/v1',
        businessKey: 'portal:customer-a:invoice:INV-CN-LEGACY',
        probeId: invoiceProbe.id,
      },
    }
    const legacyBindingLedger = ActionLedger.restore(
      ['proposed', 'authorized', 'executing', 'not_committed'].map((status, index) => ({
        ...legacyBindingBase,
        sequence: index + 1,
        status,
      })),
      () => new Date('2026-08-12T00:03:40.000Z'),
    )
    let legacyReplayToolCalls = 0
    await assert.rejects(
      runLoopScenario({
        trace,
        store,
        sessionId: 'permission-send-legacy-binding',
        call: { id: 'legacy-replay', name: 'send_invoice', arguments: { invoiceId: 'INV-CN-LEGACY' } },
        risk: 'L3',
        gateDecisions: ['approve'],
        seedFresh: true,
        withSession: true,
        actionLedger: legacyBindingLedger,
        toolRun() {
          legacyReplayToolCalls += 1
          return { observation: 'must not execute', pageChanged: false }
        },
        externalActionBindingResolver(request) {
          return {
            schemaVersion: 'external-action-binding/v2',
            businessKey: `portal:customer-a:invoice:${request.args.invoiceId}`,
            probeId: invoiceProbe.id,
          }
        },
        externalActionProbes: [invoiceProbe],
      }),
      /EXTERNAL_ACTION_LEGACY_BINDING_REQUIRES_REVIEW/i,
      'a legacy binding may be reconciled but must not authorize an automatic replay without an effect digest',
    )
    assert.equal(legacyReplayToolCalls, 0)

    const restoredSendLedger = new ActionLedger(() => new Date('2026-08-12T00:04:00.000Z'))
    restoredSendLedger.propose({
      actionId: 'restored-turn:send-invoice',
      actionKind: 'send',
      toolName: 'send_invoice',
      externalBinding: {
        schemaVersion: 'external-action-binding/v2',
        businessKey: 'portal:customer-a:invoice:INV-CN-RESTORED',
        probeId: invoiceProbe.id,
        effectDigest: sendEffectDigest('INV-CN-RESTORED'),
      },
    })
    restoredSendLedger.authorize('restored-turn:send-invoice')
    restoredSendLedger.begin('restored-turn:send-invoice')
    invoiceReceipts.set('portal:customer-a:invoice:INV-CN-RESTORED', 'CSP-RESTORED-1')
    const recoveredBeforeReplay = await runLoopScenario({
      trace,
      store,
      sessionId: 'permission-send-restored-before-replay',
      call: { id: 'model-replays-send', name: 'send_invoice', arguments: { invoiceId: 'INV-CN-RESTORED' } },
      risk: 'L3',
      gateDecisions: ['approve'],
      seedFresh: true,
      withSession: true,
      toolRun() {
        throw new Error('the already committed invoice must never be sent again')
      },
      actionLedger: restoredSendLedger,
      externalActionBindingResolver(request) {
        return {
          schemaVersion: 'external-action-binding/v2',
          businessKey: `portal:customer-a:invoice:${request.args.invoiceId}`,
          probeId: invoiceProbe.id,
        }
      },
      externalActionProbes: [invoiceProbe],
      expectedExternalBusinessKeys: ['portal:customer-a:invoice:INV-CN-RESTORED'],
    })
    assert.equal(recoveredBeforeReplay.toolCalls.length, 0)
    assert.match(recoveredBeforeReplay.result.summary, /EXTERNAL_ACTION_ALREADY_COMMITTED/)
    const recoveredStatuses = recoveredBeforeReplay.events
      .filter((event) => event.type === 'action_ledger_updated' && event.data?.entry?.actionKind === 'send')
      .map((event) => event.data.entry.status)
    assert.deepEqual(recoveredStatuses, ['proposed', 'authorized', 'executing', 'committed'])

    const unresolvedWithoutResolverLedger = new ActionLedger()
    unresolvedWithoutResolverLedger.propose({
      actionId: 'restored-turn:send-without-resolver',
      actionKind: 'send',
      toolName: 'send_invoice',
      externalBinding: {
        schemaVersion: 'external-action-binding/v2',
        businessKey: 'portal:customer-a:invoice:INV-CN-NO-RESOLVER',
        probeId: 'temporarily-unavailable-probe/v1',
        effectDigest: sendEffectDigest('INV-CN-NO-RESOLVER'),
      },
    })
    unresolvedWithoutResolverLedger.authorize('restored-turn:send-without-resolver')
    unresolvedWithoutResolverLedger.begin('restored-turn:send-without-resolver')
    await assert.rejects(
      runLoopScenario({
        trace,
        store,
        sessionId: 'permission-send-restored-without-resolver',
        call: { id: 'model-replays-unbound-send', name: 'send_invoice', arguments: { invoiceId: 'INV-CN-NO-RESOLVER' } },
        risk: 'L3',
        gateDecisions: ['approve'],
        seedFresh: true,
        withSession: true,
        actionLedger: unresolvedWithoutResolverLedger,
        toolRun() {
          throw new Error('an unbound replay must never reach the external tool')
        },
      }),
      /EXTERNAL_ACTION_BINDING_REQUIRED: send has 1 unresolved external action/,
      'missing binding resolution must not bypass an existing in-doubt action of the same kind',
    )

    let resolveLateProbe
    let timeoutProbeSignalAborted = false
    let timeoutProbeCalls = 0
    const timeoutProbe = {
      schemaVersion: 'external-action-probe/v1',
      id: 'invoice-timeout-query/v1',
      authority: 'read_only',
      async reconcile(request) {
        timeoutProbeCalls += 1
        if (timeoutProbeCalls === 1) {
          return {
            schemaVersion: 'external-action-reconciliation/v1',
            actionId: request.action.actionId,
            businessKey: request.businessKey,
            state: 'not_committed',
            observedAt: new Date().toISOString(),
            verifier: this.id,
            independentlyObserved: true,
            evidenceIds: ['invoice-timeout-preflight:absent'],
            retrySafe: true,
            summary: 'Authoritative preflight proved the exact effect absent and safe to attempt.',
          }
        }
        request.signal?.addEventListener('abort', () => {
          timeoutProbeSignalAborted = true
        }, { once: true })
        return new Promise((resolve) => {
          resolveLateProbe = () => resolve({
            schemaVersion: 'external-action-reconciliation/v1',
            actionId: request.action.actionId,
            businessKey: request.businessKey,
            state: 'committed',
            observedAt: new Date().toISOString(),
            verifier: this.id,
            independentlyObserved: true,
            evidenceIds: ['receipt:CSP-LATE'],
            externalReference: 'CSP-LATE',
            observedEffectDigest: request.action.externalBinding.effectDigest,
            summary: 'This result arrived after the runtime deadline.',
          })
        })
      },
    }
    const timeoutLedger = new ActionLedger()
    const timedOutSend = await runLoopScenario({
      trace,
      store,
      sessionId: 'permission-send-probe-timeout',
      call: { id: 'send-timeout', name: 'send_invoice', arguments: { invoiceId: 'INV-CN-TIMEOUT' } },
      risk: 'L3',
      gateDecisions: ['approve_and_execute'],
      seedFresh: true,
      withSession: true,
      allowFinalSubmit: true,
      allowExternalActionExecution: true,
      requireExternalActionReconciliation: true,
      preflightExternalActions: true,
      expectedExternalBusinessKeys: ['portal:customer-a:invoice:INV-CN-TIMEOUT'],
      toolRun() {
        return { observation: 'Send request returned without an authoritative receipt.', pageChanged: false }
      },
      externalActionBindingResolver(request) {
        return {
          schemaVersion: 'external-action-binding/v2',
          businessKey: `portal:customer-a:invoice:${request.args.invoiceId}`,
          probeId: timeoutProbe.id,
        }
      },
      externalActionProbes: [timeoutProbe],
      externalActionProbeTimeoutMs: 10,
      actionLedger: timeoutLedger,
    })
    const timedOutStatuses = timedOutSend.events
      .filter((event) => event.type === 'action_ledger_updated' && event.data?.entry?.actionKind === 'send')
      .map((event) => event.data.entry.status)
    assert.deepEqual(timedOutStatuses, ['proposed', 'authorized', 'executing', 'executed', 'ambiguous'])
    assert.equal(timeoutProbeCalls, 2, 'the post-execution timeout scenario must first pass authoritative preflight')
    assert(timedOutSend.result.actions.some((action) => action.actionKind === 'send' && action.outcome === 'indeterminate'))
    assert.equal(timeoutProbeSignalAborted, true, 'the runtime must abort a probe at its deadline')
    resolveLateProbe()
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(
      timeoutLedger.snapshot().at(-1)?.status,
      'ambiguous',
      'a late probe result must not mutate the ledger after timeout',
    )

    const declined = await runLoopScenario({
      trace,
      store,
      sessionId: 'permission-decline',
      call: { id: 'decline-click', name: 'browser_click_text', arguments: { text: 'Open details' } },
      risk: 'L3',
      gateDecisions: ['decline'],
      seedFresh: true,
    })
    assert.equal(declined.result.blocked, true, 'HumanGate decline should block the workflow')
    assert.equal(declined.toolCalls.length, 0, 'HumanGate decline should not execute the tool')
    assert.equal(declined.queue.snapshot().denied.length, 1)

    const takeover = await runLoopScenario({
      trace,
      store,
      sessionId: 'permission-takeover',
      call: { id: 'takeover-click', name: 'browser_click_text', arguments: { text: 'Open details' } },
      risk: 'L3',
      gateDecisions: ['takeover'],
      seedFresh: true,
    })
    assert.equal(takeover.result.blocked, true, 'HumanGate takeover should block the workflow')
    assert.equal(takeover.toolCalls.length, 0, 'HumanGate takeover should not execute the tool')
    assert.equal(takeover.queue.snapshot().cancelled.length, 1)

    trace.finish()
  } finally {
    await sessionManager.closeAll().catch(() => {})
    rmSync(root, { recursive: true, force: true })
  }
}

async function runLoopScenario({
  trace,
  store,
  sessionId,
  call,
  risk,
  safetyMode = 'guarded',
  taskType,
  extraContext,
  gateDecisions,
  gateOverride,
  seedFresh,
  withSession = false,
  workflowEngine,
  completionGate,
  toolRun,
  externalActionBindingResolver,
  externalActionIntentResolver,
  adapterSinkKind,
  externalActionProbes,
  requireExternalActionReconciliation,
  preflightExternalActions,
  allowFinalSubmit,
  allowExternalActionExecution,
  externalActionProbeTimeoutMs,
  externalActionBootstrapReconciled,
  actionLedger,
  expectedExternalBusinessKeys,
  optionalExternalBusinessKeys,
  sinkRuleDecision = 'ask',
  omitTaskPolicy = false,
  sessionDecorator,
  sessionRef,
  omitSessionRef = false,
}) {
  if (seedFresh) {
    await openPermissionFixture(sessionId)
    seedFreshObservation(sessionId)
  }
  const toolCalls = []
  const queue = new ApprovalQueue()
  const gate = gateOverride ?? new RecordingGate(gateDecisions)
  const registry = new ToolRegistry([
    {
      name: call.name,
      description: `Test tool ${call.name}`,
      category: 'action',
      parameters: { type: 'object', properties: {} },
      inherentRisk: risk,
      async run(args) {
        toolCalls.push({ name: call.name, args: { ...args } })
        if (toolRun) return toolRun(args)
        if (call.name === 'agent_done') {
          return {
            observation: `agent_done: ${args.summary}`,
            done: true,
            data: { blocked: Boolean(args.blocked) },
            pageChanged: false,
          }
        }
        return { observation: `${call.name} executed`, pageChanged: false }
      },
    },
  ])
  const baseSession = withSession
    ? await createRecorder(store, `session-${sessionId}`, `${trace.runId}-${sessionId}`)
    : undefined
  const session = baseSession && sessionDecorator ? sessionDecorator(baseSession) : baseSession
  const effectiveSessionRef = sessionRef ?? (!omitSessionRef && session && allowExternalActionExecution
    ? {
        schemaVersion: 'session-ref/v1',
        provider: 'file-session-store',
        id: session.session.sessionId,
        runId: session.session.runId,
        attempt: 1,
      }
    : undefined)
  if (session && actionLedger) {
    for (const entry of actionLedger.snapshot()) {
      await session.eventDurably({
        type: 'action_ledger_updated',
        toolCallId: entry.actionId,
        message: `${entry.actionKind}: ${entry.status}`,
        data: { entry },
      })
    }
  }
  const sinkKind = adapterSinkKind ?? (call.name === 'browser_upload_file'
    ? 'upload'
    : /send|message|email/i.test(call.name)
      ? 'send'
    : call.name === 'browser_click_text' && /submit/i.test(String(call.arguments.text ?? ''))
      ? 'submit'
      : undefined)
  const sinkRule = sinkKind
    ? {
        id: `permission-fixture-${sinkKind}`,
        actionKinds: [sinkKind],
        decision: sinkRuleDecision,
        destinationOrigins: ['https://example.test'],
        requireApprovalBinding: true,
      }
    : undefined

  const result = await runAgentLoop({
    goal: 'Exercise permission integration.',
    resume: testProfile(),
    llm: new OneToolThenDoneLlm(call),
    registry,
    ctx: { sessionId, highlight: false, trace },
    gate,
    maxSteps: 3,
    safetyMode,
    taskType,
    extraContext,
    approvalQueue: queue,
    session,
    sessionRef: effectiveSessionRef,
    workflowEngine,
    completionGate,
    ...(sinkRule && !omitTaskPolicy ? {
      taskContract: {
        schemaVersion: 'web-task-contract/v1',
        contractId: `permission-fixture-${sessionId}`,
        revision: 0,
        criteria: expectedExternalBusinessKeys?.length
          ? [
              {
                id: 'external-action-committed',
                kind: 'action_boundary',
                description: 'Every expected external business key must be independently committed.',
                actionKinds: [sinkKind],
                outcome: 'performed',
                businessKeys: expectedExternalBusinessKeys,
              },
              {
                id: 'external-action-receipt-present',
                kind: 'artifact_present',
                description: 'Every committed external business key must have an immutable receipt artifact.',
                artifactKinds: ['external_action_receipt'],
                schemaVersions: ['external-action-receipt/v1'],
                minCount: expectedExternalBusinessKeys.length,
                businessKeys: expectedExternalBusinessKeys,
              },
              ...(optionalExternalBusinessKeys?.length ? [
                {
                  id: 'optional-external-action-committed',
                  kind: 'action_boundary',
                  description: 'Optional external action evidence must not authorize machine execution.',
                  required: false,
                  actionKinds: [sinkKind],
                  outcome: 'performed',
                  businessKeys: optionalExternalBusinessKeys,
                },
                {
                  id: 'optional-external-action-receipt-present',
                  kind: 'artifact_present',
                  description: 'Optional receipt evidence must not authorize machine execution.',
                  required: false,
                  artifactKinds: ['external_action_receipt'],
                  schemaVersions: ['external-action-receipt/v1'],
                  minCount: optionalExternalBusinessKeys.length,
                  businessKeys: optionalExternalBusinessKeys,
                },
              ] : []),
            ]
          : [
              {
                id: 'final-submit-not-performed',
                kind: 'action_boundary',
                description: 'The permission fixture must not perform final submission.',
                actionKinds: [sinkKind],
                outcome: 'not_performed',
              },
              ...(sinkKind === 'submit' ? [{
                id: 'final-submit-human-completion-missing',
                kind: 'human_confirmation',
                description: 'Approving awareness of a final-submit boundary is not evidence that the human completed submission.',
                confirmationKind: 'final_submit_completed',
              }] : []),
            ],
        sensitiveActions: [sinkRule],
      },
      taskPolicy: {
        schemaVersion: 'task-policy/v1',
        defaultSensitiveAction: 'deny',
        rules: [sinkRule],
      },
    } : {}),
    externalActionBindingResolver,
    externalActionIntentResolver,
    externalActionProbes,
    requireExternalActionReconciliation,
    preflightExternalActions,
    allowFinalSubmit,
    allowExternalActionExecution,
    externalActionProbeTimeoutMs,
    externalActionBootstrapReconciled,
    actionLedger,
  })

  const transcript = session ? await readJsonLines(session.session.transcriptPath) : []
  const events = session ? await readJsonLines(session.session.eventsPath) : []
  return { result, toolCalls, queue, gate, transcript, events }
}

async function openPermissionFixture(sessionId) {
  const url = 'https://example.test/apply'
  const page = (await sessionManager.getOrCreate(sessionId)).page
  await page.unroute(url)
  await page.route(url, (route) => route.fulfill({
    status: 200,
    contentType: 'text/html; charset=utf-8',
    body: '<!doctype html><html><head><title>Application form</title></head><body><input aria-label="Applicant name"><button type="button">Open details</button><button type="submit">Submit application</button></body></html>',
  }))
  const opened = await browserOpen({ sessionId, url, waitUntil: 'domcontentloaded' })
  assert.equal(opened.ok, true, opened.observation)
}

function sendEffectDigest(invoiceId, extraArgs = {}) {
  return externalActionEffectDigest({
    actionId: 'digest-does-not-depend-on-attempt-id',
    actionKind: 'send',
    toolName: 'send_invoice',
    args: { invoiceId, ...extraArgs },
    currentUrl: 'https://example.test/apply',
  })
}

async function runCompactionScenario() {
  const root = mkdtempSync(join(tmpdir(), 'mfa-agent-loop-compaction-'))
  const trace = new TraceRecorder(root, {
    runId: 'agent-loop-compaction-run',
    source: 'local-runtime',
    scenario: 'agent-loop-compaction-test',
    profile: 'test',
    goal: 'Verify runAgentLoop context compaction integration.',
  })
  const store = new FileSessionStore({ rootDir: join(root, 'sessions') })
  const sessionId = 'compaction-loop'
  const markerCalls = []
  const llm = new CompactionAwareLlm()
  const registry = new ToolRegistry([
    {
      name: 'make_large_context',
      description: 'Create enough observation text to trigger compaction.',
      category: 'observation',
      parameters: { type: 'object', properties: {} },
      inherentRisk: 'L1',
      async run() {
        return { observation: `large observation\n${'A'.repeat(24_000)}`, pageChanged: false }
      },
    },
    {
      name: 'compaction_marker',
      description: 'Records that the loop continued after compaction.',
      category: 'action',
      parameters: {
        type: 'object',
        properties: {
          marker: { type: 'string' },
        },
      },
      inherentRisk: 'L1',
      async run(args) {
        markerCalls.push({ ...args })
        return { observation: 'compaction marker executed', pageChanged: false }
      },
    },
  ])

  try {
    seedFreshObservation(sessionId)
    const session = await createRecorder(
      store,
      'session-compaction-loop',
      `${trace.runId}-session`,
      'Exercise context compaction integration.',
    )
    const result = await runAgentLoop({
      goal: 'Exercise context compaction integration.',
      resume: testProfile(),
      llm,
      registry,
      ctx: { sessionId, highlight: false, trace },
      gate: new RecordingGate([]),
      maxSteps: 4,
      session,
      contextBudget: {
        maxInputTokens: 3000,
        compactThresholdRatio: 1,
        keepRecentMessages: 4,
      },
    })

    const transcript = await readJsonLines(session.session.transcriptPath)
    const events = await readJsonLines(session.session.eventsPath)
    const traceEvents = readFileSync(join(trace.agentTrace.dir, 'events.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
    const compactionEntry = transcript.find((entry) => entry.type === 'context_compaction')
    const requestBudgetEvent = traceEvents.find((event) => (
      event.event === 'token_budget_updated'
      && event.data?.value?.turnId === 'turn_002'
    ))
    const compactedRequest = llm.requests.find((request) => request.messages.some((message) => (
      message.role === 'user' && message.content.startsWith(COMPACTED_RUN_CONTEXT_PREFIX)
    )))

    assert.equal(result.done, true, 'compaction scenario should finish')
    assert.equal(result.blocked, false, 'compaction scenario should not block')
    assert(llm.sawCompacted, 'LLM should receive COMPACTED_RUN_CONTEXT after compaction')
    assert(compactedRequest, 'mock LLM should retain the compacted request snapshot')
    assert.equal(markerCalls.length, 1, 'loop should execute a tool after compacting messages')
    assert(compactionEntry, 'transcript should include context_compaction')
    assert.equal(compactionEntry.summary.goal, 'Exercise context compaction integration.')
    assert(compactionEntry.summary.source.inputMessageCount > 0, 'summary should record source message count')
    assert(compactionEntry.summary.evidence, 'context compaction should retain workflow evidence summary')
    assert(compactionEntry.summary.evidence.total > 0, 'workflow evidence summary should count recorded evidence')
    assert(
      compactionEntry.summary.evidence.recentKeyEvidence.some(
        (evidence) => evidence.kind === 'tool_result' && evidence.source === 'make_large_context',
      ),
      'compaction summary should retain recent tool_result workflow evidence',
    )
    assert(
      compactionEntry.summary.evidence.recentKeyEvidence.some((evidence) => evidence.kind === 'workflow_state'),
      'compaction summary should retain workflow_state evidence',
    )
    assert(
      compactionEntry.summary.evidence.recentKeyEvidence.every((evidence) => evidence.data === undefined),
      'compaction evidence summary should not retain raw evidence data payloads',
    )
    assert(compactionEntry.summary.completion?.reason, 'context compaction should retain workflow evaluation reason')
    assert(events.some((event) => event.type === 'token_budget_updated'), 'events should include token_budget_updated')
    assert(events.some((event) => event.type === 'context_compacted'), 'events should include context_compacted')
    assert(requestBudgetEvent, 'Agent Trace should include the final request token budget for the compacted turn')
    assert.equal(requestBudgetEvent.data.value.schemaVersion, 'token-budget-event/v1')
    assert.equal(requestBudgetEvent.data.value.requestBudget.unit, 'estimated_tokens')
    assert.equal(requestBudgetEvent.data.value.requestBudget.selectedTools, 2)
    assert(requestBudgetEvent.data.value.requestBudget.estimatedToolSchemas > 0)
    assert.equal(
      requestBudgetEvent.data.value.requestBudget.estimatedRequest,
      requestBudgetEvent.data.value.requestBudget.estimatedMessages
        + requestBudgetEvent.data.value.requestBudget.estimatedToolResults
        + requestBudgetEvent.data.value.requestBudget.estimatedToolSchemas,
      'Agent Trace should record messages, tool results, and selected tool schemas in the request total',
    )
    assert.equal(
      requestBudgetEvent.data.value.requestBudget.estimatedRequest,
      estimateTokenBudget(
        compactedRequest.messages,
        { maxInputTokens: 3000, compactThresholdRatio: 1 },
        compactedRequest.tools,
      ).estimatedTotalTokens,
      'Agent Trace should record the post-compaction budget sent to the model',
    )
    assert.equal(llm.compactedMessages[0]?.role, 'system', 'compacted message set should keep the system message first')
    assert(
      llm.compactedMessages.some((message) => message.role === 'user' && message.content.startsWith(COMPACTED_RUN_CONTEXT_PREFIX)),
      'compacted message set should include COMPACTED_RUN_CONTEXT',
    )
    assertToolBoundariesIntact(llm.compactedMessages)

    trace.finish()
  } finally {
    await sessionManager.closeAll().catch(() => {})
    rmSync(root, { recursive: true, force: true })
  }
}

async function runAbortAfterCompactionScenario() {
  const root = mkdtempSync(join(tmpdir(), 'mfa-agent-loop-abort-after-compaction-'))
  const trace = new TraceRecorder(root, {
    runId: 'agent-loop-abort-after-compaction-run',
    source: 'local-runtime',
    scenario: 'agent-loop-abort-after-compaction-test',
    profile: 'test',
    goal: 'Do not record a request budget when abort wins before the model call.',
  })
  const controller = new AbortController()
  const llm = new AbortAfterCompactionLlm()
  const registry = new ToolRegistry([{
    name: 'make_large_context',
    description: 'Create enough observation text to trigger compaction.',
    category: 'observation',
    parameters: { type: 'object', properties: {} },
    inherentRisk: 'L1',
    async run() {
      return { observation: `large observation\n${'A'.repeat(24_000)}`, pageChanged: false }
    },
  }])
  const compactor = new ContextCompactor()

  try {
    const sessionId = 'abort-after-compaction-loop'
    seedFreshObservation(sessionId)
    const result = await runAgentLoop({
      goal: 'Do not record a request budget when abort wins before the model call.',
      resume: testProfile(),
      llm,
      registry,
      ctx: { sessionId, highlight: false, trace },
      gate: new RecordingGate([]),
      maxSteps: 3,
      abortSignal: controller.signal,
      contextBudget: { maxInputTokens: 3000, compactThresholdRatio: 1 },
      contextCompactor: {
        compact(input) {
          controller.abort('stop before the compacted request is sent')
          return compactor.compact(input)
        },
      },
    })
    const traceEvents = readFileSync(join(trace.agentTrace.dir, 'events.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
    const requestTurns = traceEvents
      .filter((event) => event.event === 'token_budget_updated')
      .map((event) => event.data?.value?.turnId)

    assert.equal(result.blocked, true)
    assert.equal(llm.calls, 1, 'abort should prevent the compacted request from reaching the model')
    assert.deepEqual(requestTurns, ['turn_001'], 'Agent Trace should only count requests that reach the model boundary')
  } finally {
    await sessionManager.closeAll().catch(() => {})
    rmSync(root, { recursive: true, force: true })
  }
}

async function createRecorder(store, sessionId, runId, goal = 'Exercise permission integration.') {
  const session = await store.create({
    sessionId,
    runId,
    source: 'test',
    goal,
    mode: 'test',
    traceRunId: runId,
  })
  return new FileSessionRecorder(store, session)
}

class CompactionAwareLlm {
  constructor() {
    this.hasKey = true
    this.label = 'compaction-loop-llm'
    this.turn = 0
    this.sawCompacted = false
    this.afterCompactionToolRequested = false
    this.compactedMessages = []
    this.requests = []
  }

  async chatWithTools(messages, options) {
    this.turn += 1
    const request = {
      messages: structuredClone(messages),
      tools: structuredClone(options.tools ?? []),
    }
    this.requests.push(request)
    const sawCompacted = request.messages.some((message) => (
      message.role === 'user' && message.content.startsWith(COMPACTED_RUN_CONTEXT_PREFIX)
    ))
    if (sawCompacted) {
      this.sawCompacted = true
      this.compactedMessages = request.messages
    }
    if (sawCompacted && !this.afterCompactionToolRequested) {
      this.afterCompactionToolRequested = true
      return {
        content: 'Compacted context is available; continuing with the next tool.',
        toolCalls: [{ id: 'compact-after', name: 'compaction_marker', arguments: { marker: 'after_compaction' } }],
      }
    }
    if (!sawCompacted && this.turn === 1) {
      return {
        content: 'Creating a large observation before compaction.',
        toolCalls: [{ id: 'compact-before', name: 'make_large_context', arguments: {} }],
      }
    }
    return { content: 'Compaction scenario complete.', toolCalls: [] }
  }
}

class OneToolThenDoneLlm {
  constructor(call) {
    this.hasKey = true
    this.label = 'permission-loop-llm'
    this.call = call
    this.turn = 0
  }

  async chatWithTools() {
    this.turn += 1
    if (this.turn === 1) {
      return { content: 'Requesting one tool.', toolCalls: [this.call] }
    }
    return { content: 'Permission scenario complete.', toolCalls: [] }
  }
}

class AbortAfterCompactionLlm {
  constructor() {
    this.hasKey = true
    this.label = 'abort-after-compaction-llm'
    this.calls = 0
  }

  async chatWithTools() {
    this.calls += 1
    assert.equal(this.calls, 1, 'model should not receive a request after abort')
    return {
      content: 'Creating a large observation before compaction.',
      toolCalls: [{ id: 'abort-before-request', name: 'make_large_context', arguments: {} }],
    }
  }
}

class RecordingGate {
  constructor(decisions) {
    this.decisions = [...decisions]
    this.requests = []
  }

  async confirm(kind, message, context) {
    this.requests.push({ kind, message, context })
    return this.decisions.shift() ?? 'takeover'
  }
}

class RecordingWorkflowEngine {
  constructor() {
    this.inner = new WorkflowEngine()
    this.calls = []
    this.evaluations = []
  }

  evaluate(input) {
    this.calls.push(input)
    const evaluation = this.inner.evaluate(input)
    this.evaluations.push(evaluation)
    return evaluation
  }
}

class RecordingCompletionGate {
  constructor(action) {
    this.action = action
    this.inputs = []
  }

  evaluate(input) {
    this.inputs.push(input)
    return {
      schemaVersion: 'completion-gate-decision/v1',
      action: this.action,
      recommendedStatus: this.action === 'allow' ? 'completed' : this.action === 'block' ? 'blocked' : 'unchanged',
      reason: `Injected completion gate returned ${this.action}.`,
      missingCriteria: input.workflowEvaluation?.missingCriteria ?? [],
      blockers: input.workflowEvaluation?.blockers ?? [],
      workflowPhase: input.workflowEvaluation?.state?.phase,
      evidenceIds: input.workflowEvaluation?.evidenceIds ?? [],
    }
  }
}

function seedFreshObservation(sessionId) {
  observationManager.refreshPageState({
    sessionId,
    snapshot: {
      snapshotId: `snap-${sessionId}`,
      url: 'https://example.test/apply',
      title: 'Application form',
      textSummary: 'Application form with safe draft actions.',
      elements: [
        element('e0', 'input', 'Applicant name', 'L1'),
        element('e1', 'button', 'Open details', 'L3'),
        element('e2', 'button', 'Save draft', 'L1'),
      ],
      stats: {
        elementCount: 2,
        interactiveCount: 2,
        formCount: 1,
        linkCount: 0,
        buttonCount: 2,
        inputCount: 1,
        truncated: false,
      },
    },
  })
}

function assertToolBoundariesIntact(messages) {
  const satisfiedToolCalls = new Set()
  for (const message of messages) {
    if (message.role === 'assistant') {
      for (const toolCall of message.tool_calls ?? []) satisfiedToolCalls.add(toolCall.id)
      continue
    }
    if (message.role === 'tool') {
      assert(
        satisfiedToolCalls.has(message.tool_call_id),
        `tool result ${message.tool_call_id} must retain its assistant tool_call boundary`,
      )
    }
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

function assertTranscriptIncludes(transcript, expectedTypes) {
  const types = transcript.map((entry) => entry.type)
  for (const expected of expectedTypes) {
    assert(types.includes(expected), `transcript should include ${expected}`)
  }
}

function workflowEvidenceEntries(transcript) {
  return transcript
    .filter((entry) => entry.type === 'workflow_evidence')
    .map((entry) => entry.evidence)
}

function workflowEvaluationEntries(transcript) {
  return transcript
    .filter((entry) => entry.type === 'workflow_evaluation')
    .map((entry) => entry.evaluation)
}

function completionGateEntries(transcript) {
  return transcript
    .filter((entry) => entry.type === 'completion_gate')
    .map((entry) => entry.decision)
}

function testProfile() {
  return {
    name: 'Zhang San',
    email: 'zhangsan@example.com',
    phone: '13800001234',
    location: 'Hangzhou',
    summary: 'Frontend engineer',
    skills: ['TypeScript', 'Playwright'],
    experience: [],
    education: [],
    keywords: [],
    source: 'json',
  }
}

await runPermissionScenarios()
await runCompactionScenario()
await runAbortAfterCompactionScenario()

console.log('\nagent-loop-test: PASS')

await sessionManager.closeAll()
