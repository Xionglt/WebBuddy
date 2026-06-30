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
import { COMPACTED_RUN_CONTEXT_PREFIX } from '../dist/context/run-summary.js'
import { observationManager } from '../dist/observation/observation-manager.js'
import { ApprovalQueue } from '../dist/permission/index.js'
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
      { kind: 'done' },
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
    if (step.kind === 'done') {
      return { content: 'Done filling the draft.', toolCalls: [{ id: 'c3', name: 'agent_done', arguments: { summary: 'Filled name/email/phone; did not submit.', blocked: false } }] }
    }
    return { content: '', toolCalls: [] }
  }
}

const config = loadConfig()
config.browser.headless = true
config.browser.visualHighlight = false
config.browser.typeDelayMs = 0
config.browser.slowMoMs = 0
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
      'workflow_evidence',
      'workflow_evaluation',
      'workflow_snapshot',
      'tool_result',
    ])
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
    assert.equal(finalSubmit.toolCalls.length, 0, 'final submit tool must not execute')
    assert.equal(finalSubmit.gate.requests[0].kind, 'final_submit')
    assert.equal(finalSubmit.queue.snapshot().approved.length, 1)
    assert(finalSubmitWorkflow.calls.length >= 3, 'workflow engine should evaluate initial, approval, and final-submit blocker states')
    assert(
      finalSubmitWorkflow.calls.some((call) => call.policyFacts?.some((fact) => fact.gateKind === 'final_submit')),
      'workflow engine should receive final-submit policy facts',
    )
    assertTranscriptIncludes(finalSubmit.transcript, ['workflow_evidence', 'workflow_evaluation', 'workflow_snapshot'])

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
    assert.equal(agentDone.result.blocked, false, 'agent_done scenario should preserve unblocked completion')
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
    assertTranscriptIncludes(agentDone.transcript, ['workflow_evidence', 'workflow_evaluation', 'workflow_snapshot'])

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
    assert.equal(policyDeny.result.blocked, true, 'policy block should become permission deny')
    assert.equal(policyDeny.toolCalls.length, 0, 'permission deny should not execute the tool')
    assert.equal(policyDeny.gate.requests.length, 0, 'permission deny should not call HumanGate')
    assert.equal(policyDeny.queue.snapshot().all.length, 0, 'permission deny should not enqueue approval')
    const denyEntry = policyDeny.transcript.find((entry) => entry.type === 'permission_decision')
    assert.equal(denyEntry?.decision?.action, 'deny')

    const rawAutoConfirm = await runLoopScenario({
      trace,
      store,
      sessionId: 'permission-raw-auto-confirm',
      call: { id: 'raw-click', name: 'browser_click_text', arguments: { text: 'Submit application' } },
      risk: 'L3',
      safetyMode: 'raw',
      gateDecisions: ['takeover'],
      seedFresh: false,
      withSession: true,
    })
    assert.equal(rawAutoConfirm.result.blocked, false, 'raw auto_confirm should allow execution')
    assert.equal(rawAutoConfirm.toolCalls.length, 1, 'raw auto_confirm should execute the tool')
    assert.equal(rawAutoConfirm.toolCalls[0].args.confirmed, true, 'raw auto_confirm should set confirmed=true')
    assert.equal(rawAutoConfirm.gate.requests.length, 0, 'raw auto_confirm should not call HumanGate')
    assert.equal(rawAutoConfirm.queue.snapshot().all.length, 0, 'raw auto_confirm should not enqueue approval')
    const rawPermission = rawAutoConfirm.transcript.find((entry) => entry.type === 'permission_decision')
    assert.equal(rawPermission?.decision?.action, 'allow')

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
  gateDecisions,
  seedFresh,
  withSession = false,
  workflowEngine,
}) {
  if (seedFresh) seedFreshObservation(sessionId)
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

  const result = await runAgentLoop({
    goal: 'Exercise permission integration.',
    resume: testProfile(),
    llm: new OneToolThenDoneLlm(call),
    registry,
    ctx: { sessionId, highlight: false, trace },
    gate,
    maxSteps: 3,
    safetyMode,
    approvalQueue: queue,
    session,
    workflowEngine,
  })

  const transcript = session ? await readJsonLines(session.session.transcriptPath) : []
  const events = session ? await readJsonLines(session.session.eventsPath) : []
  return { result, toolCalls, queue, gate, transcript, events }
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
        maxInputTokens: 1200,
        compactThresholdRatio: 1,
        keepRecentMessages: 4,
      },
    })

    const transcript = await readJsonLines(session.session.transcriptPath)
    const events = await readJsonLines(session.session.eventsPath)
    const compactionEntry = transcript.find((entry) => entry.type === 'context_compaction')

    assert.equal(result.done, true, 'compaction scenario should finish')
    assert.equal(result.blocked, false, 'compaction scenario should not block')
    assert(llm.sawCompacted, 'LLM should receive COMPACTED_RUN_CONTEXT after compaction')
    assert.equal(markerCalls.length, 1, 'loop should execute a tool after compacting messages')
    assert(compactionEntry, 'transcript should include context_compaction')
    assert.equal(compactionEntry.summary.goal, 'Exercise context compaction integration.')
    assert(compactionEntry.summary.source.inputMessageCount > 0, 'summary should record source message count')
    assert(events.some((event) => event.type === 'token_budget_updated'), 'events should include token_budget_updated')
    assert(events.some((event) => event.type === 'context_compacted'), 'events should include context_compacted')
    assert.equal(llm.compactedMessages[0]?.role, 'system', 'compacted message set should keep the system message first')
    assert(
      llm.compactedMessages.some((message) => message.role === 'user' && message.content.startsWith(COMPACTED_RUN_CONTEXT_PREFIX)),
      'compacted message set should include COMPACTED_RUN_CONTEXT',
    )

    trace.finish()
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
  }

  async chatWithTools(messages) {
    this.turn += 1
    const sawCompacted = messages.some((message) => (
      message.role === 'user' && message.content.startsWith(COMPACTED_RUN_CONTEXT_PREFIX)
    ))
    if (sawCompacted) {
      this.sawCompacted = true
      this.compactedMessages = messages
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

function seedFreshObservation(sessionId) {
  observationManager.refreshPageState({
    sessionId,
    snapshot: {
      snapshotId: `snap-${sessionId}`,
      url: 'https://example.test/apply',
      title: 'Application form',
      textSummary: 'Application form with safe draft actions and a final submit button.',
      elements: [
        element('e1', 'button', 'Open details', 'L3'),
        element('e2', 'button', 'Submit application', 'L3'),
      ],
      stats: {
        elementCount: 2,
        interactiveCount: 2,
        formCount: 1,
        linkCount: 0,
        buttonCount: 2,
        inputCount: 0,
        truncated: false,
      },
    },
  })
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

console.log('\nagent-loop-test: PASS')

await sessionManager.closeAll()
