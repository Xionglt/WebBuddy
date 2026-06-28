#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentRuntime } from '../dist/agent/agent-runtime.js'
import { AgentKernel, DefaultAgentRunController } from '../dist/kernel/index.js'
import { ToolRegistry } from '../dist/runtime/local/tool-registry.js'
import { AutoHumanGate } from '../dist/sdk/human.js'
import { TraceRecorder } from '../dist/sdk/trace.js'
import { FileSessionRecorder, FileSessionStore, readJsonLines } from '../dist/session/index.js'
import { sessionManager } from '../dist/session/manager.js'

process.env.PLAYWRIGHT_HEADLESS = 'true'
process.env.PLAYWRIGHT_ALLOW_DATA_URLS = 'true'
process.env.PLAYWRIGHT_TYPE_DELAY_MS = '0'
process.env.PLAYWRIGHT_SLOWMO_MS = '0'
process.env.AGENT_TRACE_MODE = 'redacted'

const profile = {
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

class DoneLlm {
  constructor(summary = 'Kernel run completed.') {
    this.hasKey = true
    this.label = 'kernel-done-llm'
    this.summary = summary
  }

  async chatWithTools() {
    return {
      content: this.summary,
      toolCalls: [{ id: `done-${this.summary.length}`, name: 'agent_done', arguments: { summary: this.summary, blocked: false } }],
    }
  }
}

class AbortBeforeToolLlm {
  constructor(controller) {
    this.hasKey = true
    this.label = 'kernel-abort-llm'
    this.controller = controller
  }

  async chatWithTools() {
    this.controller.abort('test abort before tool execution')
    return {
      content: 'Attempt the marker tool.',
      toolCalls: [{ id: 'abort-marker-call', name: 'abort_marker', arguments: {} }],
    }
  }
}

const root = mkdtempSync(join(tmpdir(), 'mfa-agent-kernel-'))
const trace = new TraceRecorder(root, {
  runId: 'agent-kernel-test-run',
  source: 'local-runtime',
  scenario: 'agent-kernel-test',
  profile: 'test',
  goal: 'Verify AgentKernel skeleton.',
})

try {
  const store = new FileSessionStore({ rootDir: join(root, 'sessions') })
  const kernelSession = await store.create({
    sessionId: 'agent-kernel-test-session',
    runId: trace.runId,
    source: 'test',
    goal: 'Verify AgentKernel success path.',
    mode: 'test',
    traceRunId: trace.runId,
  })
  const kernelRecorder = new FileSessionRecorder(store, kernelSession)
  const kernelEvents = []
  const runtimeEvents = []

  const kernel = new AgentKernel()
  const kernelResult = await kernel.start({
    goal: 'Complete through the kernel.',
    resume: profile,
    llm: new DoneLlm('Kernel success.'),
    registry: new ToolRegistry(),
    ctx: { sessionId: 'agent-kernel-browser-session', highlight: false, trace },
    gate: new AutoHumanGate(),
    maxSteps: 2,
    session: kernelRecorder,
    onEvent: (event) => kernelEvents.push(event),
    onRuntimeEvent: (event) => runtimeEvents.push(event),
  })

  assert.equal(kernelResult.schemaVersion, 'agent-kernel-result/v1')
  assert.equal(kernelResult.runtime, 'agent-kernel')
  assert.equal(kernelResult.status, 'completed')
  assert.equal(kernelResult.stopReason, 'agent_done')
  assert.equal(kernelResult.done, true)
  assert.equal(kernelResult.blocked, false)
  assert(kernelResult.turnState, 'kernel result should include a turn snapshot')
  assert(kernelEvents.some((event) => event.type === 'session_started'), 'kernel events should include session_started')
  assert(kernelEvents.some((event) => event.type === 'session_completed'), 'kernel events should include session_completed')
  assert(runtimeEvents.some((event) => event.schemaVersion === 'agent-runtime-event/v1'), 'runtime events should still flow')

  const transcript = await readJsonLines(kernelSession.transcriptPath)
  const transcriptTypes = transcript.map((entry) => entry.type)
  for (const expected of ['user_message', 'assistant_message', 'tool_call', 'tool_result', 'workflow_snapshot', 'final_result']) {
    assert(transcriptTypes.includes(expected), `transcript should include ${expected}`)
  }
  const sessionEvents = await readJsonLines(kernelSession.eventsPath)
  assert(sessionEvents.some((event) => event.type === 'session_started'), 'session events should include session_started')
  assert(sessionEvents.some((event) => event.type === 'session_completed'), 'session events should include session_completed')

  const runtimeKernelEvents = []
  const runtime = new AgentRuntime()
  const runtimeResult = await runtime.run({
    goal: 'Complete through AgentRuntime.',
    resume: profile,
    llm: new DoneLlm('Runtime success.'),
    registry: new ToolRegistry(),
    ctx: { sessionId: 'agent-runtime-kernel-browser-session', highlight: false, trace },
    gate: new AutoHumanGate(),
    maxSteps: 2,
    onKernelEvent: (event) => runtimeKernelEvents.push(event),
  })

  assert.equal(runtimeResult.schemaVersion, 'agent-runtime-result/v1')
  assert.equal(runtimeResult.runtime, 'local-agent-loop')
  assert.equal(runtimeResult.stopReason, 'agent_done')
  assert.equal(runtimeResult.done, true)
  assert(runtimeKernelEvents.some((event) => event.type === 'session_started'), 'AgentRuntime should delegate through AgentKernel')

  const abortController = new DefaultAgentRunController()
  let abortMarkerExecuted = 0
  const abortRegistry = new ToolRegistry([
    {
      name: 'abort_marker',
      description: 'Test-only marker tool that must not execute after abort.',
      category: 'action',
      parameters: { type: 'object', properties: {} },
      inherentRisk: 'L0',
      async run() {
        abortMarkerExecuted += 1
        return { observation: 'abort marker executed', done: true }
      },
    },
  ])
  const abortSession = await store.create({
    sessionId: 'agent-kernel-abort-session',
    runId: `${trace.runId}-abort`,
    source: 'test',
    goal: 'Verify abort before tool execution.',
    mode: 'test',
    traceRunId: trace.runId,
  })
  const abortRecorder = new FileSessionRecorder(store, abortSession)
  const abortEvents = []

  const abortResult = await kernel.start({
    goal: 'Abort before the marker tool runs.',
    resume: profile,
    llm: new AbortBeforeToolLlm(abortController),
    registry: abortRegistry,
    ctx: { sessionId: 'agent-kernel-abort-browser-session', highlight: false, trace },
    gate: new AutoHumanGate(),
    maxSteps: 2,
    session: abortRecorder,
    controller: abortController,
    onEvent: (event) => abortEvents.push(event),
  })

  assert.equal(abortResult.schemaVersion, 'agent-kernel-result/v1')
  assert.equal(abortResult.status, 'aborted')
  assert.equal(abortResult.stopReason, 'aborted')
  assert.equal(abortResult.done, false)
  assert.equal(abortResult.blocked, true)
  assert.equal(abortMarkerExecuted, 0, 'abort should stop before tool execution')
  assert(abortEvents.some((event) => event.type === 'session_aborted'), 'kernel events should include session_aborted')

  const updatedAbortSession = await store.get(abortSession.sessionId)
  assert.equal(updatedAbortSession?.status, 'aborted')
  const abortTranscript = await readJsonLines(abortSession.transcriptPath)
  assert(abortTranscript.some((entry) => entry.type === 'final_result' && entry.status === 'aborted'), 'abort transcript should include aborted final_result')

  trace.finish()
  console.log('agent-kernel-test: PASS')
} finally {
  await sessionManager.closeAll().catch(() => {})
  rmSync(root, { recursive: true, force: true })
}
