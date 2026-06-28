#!/usr/bin/env node
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { browserOpen } from '../dist/browser/open.js'
import { runAgentLoop } from '../dist/runtime/local/agent-loop.js'
import { ToolRegistry } from '../dist/runtime/local/tool-registry.js'
import { AutoHumanGate } from '../dist/sdk/human.js'
import { TraceRecorder } from '../dist/sdk/trace.js'
import { sessionManager } from '../dist/session/manager.js'
import { FileSessionRecorder, FileSessionStore, readJsonLines } from '../dist/session/index.js'

process.env.PLAYWRIGHT_HEADLESS = 'true'
process.env.PLAYWRIGHT_ALLOW_DATA_URLS = 'true'
process.env.PLAYWRIGHT_TYPE_DELAY_MS = '0'
process.env.PLAYWRIGHT_SLOWMO_MS = '0'
process.env.AGENT_TRACE_MODE = 'redacted'

const root = mkdtempSync(join(tmpdir(), 'mfa-session-runtime-'))
const browserSessionId = 'session-runtime-smoke-browser'
const trace = new TraceRecorder(root, {
  runId: 'session-runtime-smoke-run',
  source: 'local-runtime',
  scenario: 'session-runtime-smoke',
  profile: 'test',
  goal: 'Verify runtime session recording.',
})

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

class SmokeLlm {
  constructor() {
    this.hasKey = true
    this.label = 'session-smoke-llm'
    this.turn = 0
  }

  async chatWithTools() {
    this.turn += 1
    if (this.turn === 1) {
      return {
        content: 'I will inspect the page.',
        toolCalls: [{ id: 'smoke-snapshot', name: 'browser_snapshot', arguments: { maxElements: 20 } }],
      }
    }
    return {
      content: 'The page is readable.',
      toolCalls: [{ id: 'smoke-done', name: 'agent_done', arguments: { summary: 'Observed the page.', blocked: false } }],
    }
  }
}

try {
  const open = await browserOpen({
    sessionId: browserSessionId,
    url: `data:text/html,${encodeURIComponent('<!doctype html><html><body><h1>Session Smoke</h1><button>Save draft</button></body></html>')}`,
    waitUntil: 'domcontentloaded',
  })
  assert.equal(open.ok, true, open.observation)

  const store = new FileSessionStore({ rootDir: join(root, 'sessions') })
  const session = await store.create({
    sessionId: 'session-runtime-smoke',
    runId: trace.runId,
    source: 'test',
    goal: 'Verify runtime session recording.',
    mode: 'test',
    traceRunId: trace.runId,
  })
  const recorder = new FileSessionRecorder(store, session)

  const result = await runAgentLoop({
    goal: 'Inspect the current page and finish.',
    resume: profile,
    llm: new SmokeLlm(),
    registry: new ToolRegistry(),
    ctx: { sessionId: browserSessionId, highlight: false, trace },
    gate: new AutoHumanGate(),
    maxSteps: 3,
    session: recorder,
  })

  assert.equal(result.done, true)
  assert.equal(result.blocked, false)

  const updated = await store.get(session.sessionId)
  assert.equal(updated?.status, 'completed')
  assert(existsSync(session.workflowPath), 'workflow.json should exist after runtime run')

  const transcript = await readJsonLines(session.transcriptPath)
  const types = transcript.map((entry) => entry.type)
  for (const expected of ['user_message', 'assistant_message', 'tool_call', 'tool_result', 'workflow_snapshot', 'final_result']) {
    assert(types.includes(expected), `transcript should include ${expected}`)
  }

  const events = await readJsonLines(session.eventsPath)
  assert(events.some((event) => event.type === 'session_started'), 'events should include session_started')
  assert(events.some((event) => event.type === 'tool_completed'), 'events should include tool_completed')
  assert(events.some((event) => event.type === 'session_completed'), 'events should include session_completed')

  const workflow = JSON.parse(readFileSync(session.workflowPath, 'utf8'))
  assert.equal(workflow.workflowState.schemaVersion, 'workflow-state/v1')

  trace.finish()
  console.log('session-runtime-smoke-test: PASS')
} finally {
  await sessionManager.closeAll().catch(() => {})
  rmSync(root, { recursive: true, force: true })
}
