#!/usr/bin/env node
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runAgentLoop } from '../dist/runtime/local/agent-loop.js'
import { ToolRegistry } from '../dist/runtime/local/tool-registry.js'
import { AutoHumanGate } from '../dist/sdk/human.js'
import { TraceRecorder } from '../dist/sdk/trace.js'
import { FileSessionStore, FileSessionRecorder, readJsonLines } from '../dist/session/index.js'

const root = mkdtempSync(join(tmpdir(), 'mfa-tool-result-artifact-'))

class LargeResultLlm {
  constructor() {
    this.hasKey = true
    this.label = 'large-result-llm'
    this.turn = 0
  }

  async chatWithTools() {
    this.turn += 1
    if (this.turn === 1) {
      return {
        content: 'Capture the large observation.',
        toolCalls: [{ id: 'large-result-call', name: 'large_result', arguments: {} }],
      }
    }
    return { content: 'No further tools.', toolCalls: [] }
  }
}

try {
  const trace = new TraceRecorder(root, {
    runId: 'tool-result-artifact-run',
    source: 'local-runtime',
    scenario: 'tool-result-artifact-test',
    profile: 'test',
    goal: 'Verify persisted large tool result artifacts.',
  })
  const store = new FileSessionStore({ rootDir: join(root, 'sessions') })
  const session = await store.create({
    sessionId: 'tool-result-artifact-session',
    runId: 'tool-result-artifact-run',
    source: 'test',
    goal: 'Verify persisted large tool result artifacts.',
  })
  const recorder = new FileSessionRecorder(store, session)
  const registry = new ToolRegistry([
    {
      name: 'large_result',
      description: 'Returns a large tool result without browser dependencies.',
      category: 'observation',
      parameters: { type: 'object', properties: {} },
      inherentRisk: 'L1',
      async run() {
        return {
          observation: `large observation\n${'A'.repeat(24_000)}`,
          pageChanged: false,
          data: { rows: Array.from({ length: 200 }, (_, index) => ({ index, value: `row-${index}` })) },
        }
      },
    },
  ])

  const result = await runAgentLoop({
    goal: 'Verify persisted large tool result artifacts.',
    resume: testProfile(),
    llm: new LargeResultLlm(),
    registry,
    ctx: { sessionId: 'tool-result-artifact-session', highlight: false, trace },
    gate: new AutoHumanGate(),
    maxSteps: 2,
    session: recorder,
  })

  const transcript = await readJsonLines(session.transcriptPath)
  const events = await readJsonLines(session.eventsPath)
  const toolResult = transcript.find((entry) => entry.type === 'tool_result' && entry.name === 'large_result')
  assert.equal(result.toolCalls, 1)
  assert(toolResult?.result?.artifact, 'large tool_result should include an artifact reference')
  assert.equal(toolResult.result.artifact.kind, 'persisted_tool_result')
  assert(existsSync(toolResult.result.artifact.path), 'large tool_result artifact should exist')
  assert(
    events.some((event) => event.type === 'tool_completed' && event.data?.result?.artifact?.kind === 'persisted_tool_result'),
    'tool_completed event should include artifact metadata',
  )

  trace.finish()
  console.log('tool-result-artifact-test: PASS')
} finally {
  rmSync(root, { recursive: true, force: true })
}

function testProfile() {
  return {
    name: 'Test User',
    email: 'test@example.com',
    phone: '13800000000',
    location: 'Hangzhou',
    summary: 'Test engineer',
    skills: ['TypeScript'],
    experience: [{ title: 'Engineer', company: 'Example', period: '2024-now' }],
    education: [{ degree: 'BS', major: 'Computer Science', school: 'Example University' }],
    keywords: [],
    source: 'test',
  }
}
