#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runAgentLoop } from '../dist/runtime/local/agent-loop.js'
import { ToolRegistry } from '../dist/runtime/local/tool-registry.js'
import { TraceRecorder } from '../dist/sdk/trace.js'
import { FileSessionRecorder, FileSessionStore, readJsonLines } from '../dist/session/index.js'

const legacyProfile = {
  name: 'Li Ming',
  email: 'li@example.com',
  phone: '13800001111',
  location: 'Hangzhou',
  summary: 'Full-stack engineer.',
  skills: ['TypeScript', 'React'],
  experience: [{ company: 'Acme', title: 'Engineer', period: '2021-now', summary: 'Built workflow tools.' }],
  education: [{ school: 'ZJU', degree: 'BS', major: 'Computer Science', period: '2017-2021' }],
  keywords: [],
  source: 'json',
}

const profileV2 = {
  schemaVersion: 'resume-profile/v2',
  name: { value: 'Li Ming', confidence: 0.9, evidence: 'fixture' },
  email: { value: 'li@example.com', confidence: 0.95, evidence: 'fixture' },
  phone: { value: '13800001111', confidence: 0.95, evidence: 'fixture' },
  location: { value: 'Hangzhou', confidence: 0.8, evidence: 'fixture' },
  summary: { value: 'Full-stack engineer.', confidence: 0.8, evidence: 'fixture' },
  targetRoles: { value: ['Frontend Engineer', 'Full-stack Engineer'], confidence: 0.8, evidence: 'fixture' },
  skills: { value: ['TypeScript', 'React', 'Playwright'], confidence: 0.9, evidence: 'fixture' },
  projects: {
    value: [
      {
        name: 'Autofill Console',
        role: 'Tech Lead',
        period: '2024',
        summary: 'Designed a browser form autofill workflow.',
        technologies: ['TypeScript', 'Playwright'],
      },
    ],
    confidence: 0.9,
    evidence: 'fixture',
  },
  experience: { value: legacyProfile.experience, confidence: 0.8, evidence: 'fixture' },
  education: { value: legacyProfile.education, confidence: 0.8, evidence: 'fixture' },
  keywords: { value: ['autofill'], confidence: 0.7, evidence: 'fixture' },
  source: {
    type: 'json',
    extractionWarnings: [],
    parser: 'json',
  },
}

class ResumeQueryLlm {
  constructor() {
    this.hasKey = true
    this.label = 'resume-query-test'
    this.turn = 0
    this.sawTool = false
  }

  async chatWithTools(_messages, options) {
    this.sawTool ||= options.tools.some((tool) => tool.function.name === 'resume_query')
    this.turn += 1
    if (this.turn === 1) {
      return {
        content: 'I need project details.',
        toolCalls: [
          {
            id: 'resume-projects',
            name: 'resume_query',
            arguments: { section: 'projects', query: 'project used for form project experience' },
          },
        ],
      }
    }
    return { content: 'I have the resume project details.', toolCalls: [] }
  }
}

const root = mkdtempSync(join(tmpdir(), 'mfa-resume-query-'))
const trace = new TraceRecorder(root, {
  runId: 'resume-query-test',
  source: 'local-runtime',
  scenario: 'resume-query-test',
  profile: 'test',
  goal: 'Verify resume_query.',
})
const store = new FileSessionStore({ rootDir: join(root, 'sessions') })
const session = await store.create({
  sessionId: 'resume-query-session',
  runId: 'resume-query-run',
  source: 'test',
  goal: 'Query resume projects.',
})
const recorder = new FileSessionRecorder(store, session)
const llm = new ResumeQueryLlm()
const gate = {
  async confirm() {
    throw new Error('resume_query must not request a dangerous-action gate')
  },
}

try {
  const result = await runAgentLoop({
    goal: 'Query resume projects.',
    resume: legacyProfile,
    resumeV2: profileV2,
    llm,
    registry: new ToolRegistry(),
    ctx: { sessionId: 'resume-query-browser', highlight: false, trace },
    gate,
    session: recorder,
    maxSteps: 2,
  })

  assert(llm.sawTool, 'resume_query should be exposed to the model')
  assert.equal(result.toolCalls, 1)

  const transcript = await readJsonLines(session.transcriptPath)
  const call = transcript.find((entry) => entry.type === 'tool_call' && entry.name === 'resume_query')
  assert(call, 'transcript should include resume_query tool_call')
  const toolResult = transcript.find((entry) => entry.type === 'tool_result' && entry.name === 'resume_query')
  assert(toolResult?.ok, 'resume_query should succeed')
  assert.match(toolResult.result.observation, /Autofill Console/)
  assert.match(toolResult.result.observation, /Tech Lead/)

  console.log('resume-query-test: PASS')
} finally {
  trace.finish()
  rmSync(root, { recursive: true, force: true })
}
