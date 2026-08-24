#!/usr/bin/env node
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runAgentLoop } from '../dist/runtime/local/agent-loop.js'
import { ToolRegistry } from '../dist/runtime/local/tool-registry.js'
import { AutoHumanGate } from '../dist/sdk/human.js'
import { TraceRecorder } from '../dist/sdk/trace.js'
import { FileSessionStore, FileSessionRecorder, readJsonLines } from '../dist/session/index.js'

const keepOutput = process.env.KEEP_TOOL_RESULT_ARTIFACT_TEST_OUTPUT === '1'
const outputRoot = join(process.cwd(), 'output')
if (keepOutput) mkdirSync(outputRoot, { recursive: true })
const root = keepOutput
  ? mkdtempSync(join(outputRoot, 'tool-result-artifact-'))
  : mkdtempSync(join(tmpdir(), 'mfa-tool-result-artifact-'))

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
  const artifact = toolResult?.artifacts?.[0]
  assert(artifact, 'large tool_result should include an artifact reference')
  assert.equal(artifact.schemaVersion, 'tool-result-artifact-ref/v1')
  assert.equal(artifact.kind, 'generic_json')
  assert.equal(artifact.toolName, 'large_result')
  assert.equal(artifact.toolCallId, 'large-result-call')
  assert.equal(typeof artifact.sha256, 'string')
  assert(existsSync(artifact.uri), 'large tool_result artifact should exist')
  assert(
    events.some((event) => event.type === 'tool_completed' && event.data?.artifacts?.[0]?.artifactId === artifact.artifactId),
    'tool_completed event should include artifact metadata',
  )
  assert(
    events.some((event) => event.type === 'tool_result_artifact' && event.data?.artifact?.artifactId === artifact.artifactId),
    'events should include explicit tool_result_artifact metadata',
  )

  trace.finish()
  console.log('tool-result-artifact-test: PASS')
} finally {
  if (keepOutput) console.log(`tool-result-artifact-test: OUTPUT ${root}`)
  else rmSync(root, { recursive: true, force: true })
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
