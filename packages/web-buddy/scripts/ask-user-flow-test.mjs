#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runAgentLoop } from '../dist/runtime/local/agent-loop.js'
import { ToolRegistry } from '../dist/runtime/local/tool-registry.js'
import { TraceRecorder } from '../dist/sdk/trace.js'
import { FileSessionRecorder, FileSessionStore, readJsonLines } from '../dist/session/index.js'

const profile = {
  name: 'Wang Fang',
  email: 'wang@example.com',
  phone: '13900002222',
  location: 'Shanghai',
  summary: 'Backend engineer.',
  skills: ['Node.js'],
  experience: [],
  education: [],
  keywords: [],
  source: 'json',
}

class AskUserLlm {
  constructor() {
    this.hasKey = true
    this.label = 'ask-user-test'
    this.turn = 0
    this.sawTool = false
  }

  async chatWithTools(_messages, options) {
    this.sawTool ||= options.tools.some((tool) => tool.function.name === 'ask_user')
    this.turn += 1
    if (this.turn === 1) {
      return {
        content: 'Expected salary is missing from the resume, so I will ask.',
        toolCalls: [
          {
            id: 'ask-salary-1',
            name: 'ask_user',
            arguments: {
              field: 'expected_salary',
              question: 'What expected salary should I put on this application?',
              options: ['30k-40k', '40k-50k'],
            },
          },
        ],
      }
    }
    if (this.turn === 2) {
      return {
        content: 'I will verify that the stored answer is reusable.',
        toolCalls: [
          {
            id: 'ask-salary-2',
            name: 'ask_user',
            arguments: {
              field: 'expected_salary',
              question: 'What expected salary should I put on this application?',
            },
          },
        ],
      }
    }
    return { content: 'Salary answer captured.', toolCalls: [] }
  }
}

class ScriptedInfoGate {
  constructor(answer) {
    this.answer = answer
    this.infoRequests = []
  }

  async confirm() {
    throw new Error('ask_user must not use the dangerous-action gate')
  }

  async requestInfo(request) {
    this.infoRequests.push(request)
    return { answer: this.answer }
  }
}

const root = mkdtempSync(join(tmpdir(), 'mfa-ask-user-'))
const trace = new TraceRecorder(root, {
  runId: 'ask-user-flow-test',
  source: 'local-runtime',
  scenario: 'ask-user-flow-test',
  profile: 'test',
  goal: 'Verify ask_user.',
})
const store = new FileSessionStore({ rootDir: join(root, 'sessions') })
const session = await store.create({
  sessionId: 'ask-user-session',
  runId: 'ask-user-run',
  source: 'test',
  goal: 'Ask user for missing form information.',
})
const recorder = new FileSessionRecorder(store, session)
const llm = new AskUserLlm()
const gate = new ScriptedInfoGate('30k-40k')

try {
  const result = await runAgentLoop({
    goal: 'Ask user for expected salary.',
    resume: profile,
    llm,
    registry: new ToolRegistry(),
    ctx: { sessionId: 'ask-user-browser', highlight: false, trace },
    gate,
    session: recorder,
    maxSteps: 3,
  })

  assert(llm.sawTool, 'ask_user should be exposed to the model')
  assert.equal(result.toolCalls, 2)
  assert.equal(gate.infoRequests.length, 1, 'AnswerStore should prevent repeated questions for the same field')
  assert.equal(gate.infoRequests[0].field, 'expected_salary')
  assert.equal(gate.infoRequests[0].options.length, 2)

  const transcript = await readJsonLines(session.transcriptPath)
  const answers = transcript.filter((entry) => entry.type === 'user_answer')
  assert.equal(answers.length, 2, 'transcript should record the original answer and the reuse')
  assert.deepEqual(answers.map((entry) => entry.answer), ['30k-40k', '30k-40k'])
  assert(answers.every((entry) => entry.source === 'ask_user'))
  assert(transcript.some((entry) => entry.type === 'tool_result' && entry.name === 'ask_user' && entry.ok))

  console.log('ask-user-flow-test: PASS')
} finally {
  trace.finish()
  rmSync(root, { recursive: true, force: true })
}
