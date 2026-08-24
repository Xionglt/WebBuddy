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
    })
    assert.equal(upload.toolCalls.length, 1, 'approved upload should execute')
    assert.equal(upload.toolCalls[0].args.confirmed, true, 'approved upload should receive confirmed=true')
    assert.equal(upload.gate.requests[0].kind, 'upload_resume')

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
  seedFresh,
  withSession = false,
  workflowEngine,
  completionGate,
}) {
  if (seedFresh) {
    await openPermissionFixture(sessionId)
    seedFreshObservation(sessionId)
  }
  const toolCalls = []
  const queue = new ApprovalQueue()
  const gate = new RecordingGate(gateDecisions)
  const registry = new ToolRegistry([
    {
      name: call.name,
      description: `Test tool ${call.name}`,
      category: 'action',
      parameters: { type: 'object', properties: {} },
      inherentRisk: risk,
      async run(args) {
        toolCalls.push({ name: call.name, args: { ...args } })
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
  const session = withSession
    ? await createRecorder(store, `session-${sessionId}`, `${trace.runId}-${sessionId}`)
    : undefined
  const sinkKind = call.name === 'browser_upload_file'
    ? 'upload'
    : call.name === 'browser_click_text' && /submit/i.test(String(call.arguments.text ?? ''))
      ? 'submit'
      : undefined
  const sinkRule = sinkKind
    ? {
        id: `permission-fixture-${sinkKind}`,
        actionKinds: [sinkKind],
        decision: 'ask',
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
    workflowEngine,
    completionGate,
    ...(sinkRule ? {
      taskContract: {
        schemaVersion: 'web-task-contract/v1',
        contractId: `permission-fixture-${sessionId}`,
        revision: 0,
        criteria: [
          {
            id: 'final-submit-not-performed',
            kind: 'action_boundary',
            description: 'The permission fixture must not perform final submission.',
            actionKinds: ['submit'],
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
