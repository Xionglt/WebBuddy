#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { browserOpen } from '../dist/browser/open.js'
import { observationManager } from '../dist/observation/observation-manager.js'
import { runAgentLoop } from '../dist/runtime/local/agent-loop.js'
import { ToolRegistry } from '../dist/runtime/local/tool-registry.js'
import { TraceRecorder } from '../dist/sdk/trace.js'
import { FileSessionRecorder, FileSessionStore, readJsonLines, restoreSessionState } from '../dist/session/index.js'
import { sessionManager } from '../dist/session/manager.js'

process.env.PLAYWRIGHT_HEADLESS = 'true'
process.env.PLAYWRIGHT_ALLOW_DATA_URLS = 'true'
process.env.PLAYWRIGHT_TYPE_DELAY_MS = '0'
process.env.PLAYWRIGHT_SLOWMO_MS = '0'
process.env.PLAYWRIGHT_BLOCK_LOCALHOST = 'false'
process.env.PLAYWRIGHT_ALLOWED_DOMAINS = '127.0.0.1'

class FirstRunLlm {
  constructor() {
    this.hasKey = true
    this.label = 'gpt-5-mini'
  }

  async chatWithTools() {
    return {
      content: 'Recording the resume probe before interruption.',
      toolCalls: [{ id: 'resume-probe-call', name: 'resume_probe', arguments: {} }],
    }
  }
}

class HandoffResumeLlm {
  constructor(resumePath) {
    this.hasKey = true
    this.label = 'gpt-5-mini'
    this.resumePath = resumePath
    this.calls = []
  }

  async chatWithTools(messages) {
    this.calls.push(messages)
    assertToolBoundariesIntact(messages)
    const rendered = renderMessagesForAssertion(messages)
    assert(
      rendered.includes('RESUME_PROBE_OBSERVATION'),
      'restored tool result must enter the resumed runAgentLoop model call',
    )
    assert(
      rendered.includes('Application form') && rendered.includes('CURRENT_FORM_STATE'),
      'runtime should refresh page/form state after login/captcha handoff before resuming model work',
    )

    if (this.calls.length === 1) {
      assert(rendered.includes('Upload resume'), 'resumed context should show the upload form after handoff clears')
      return {
        content: 'Login and verification are cleared; I will refresh the upload form before acting.',
        toolCalls: [{ id: 'handoff-form-snapshot', name: 'browser_form_snapshot', arguments: {} }],
      }
    }

    if (this.calls.length === 2) {
      assert(
        rendered.includes('uploadHints') || rendered.includes('resume-upload'),
        'browser_form_snapshot should expose upload evidence before resume upload',
      )
      return {
        content: 'The resume upload field is visible and the upload gate can ask the human.',
        toolCalls: [{
          id: 'handoff-upload-resume',
          name: 'browser_upload_file',
          arguments: { filePath: this.resumePath, selector: '#resume-upload' },
        }],
      }
    }

    if (this.calls.length === 3) {
      assert(rendered.includes('Submit application'), 'after upload the final-submit control should be visible')
      return {
        content: 'I see the final submit boundary; I will request the protected action.',
        toolCalls: [{ id: 'handoff-final-submit', name: 'browser_click_text', arguments: { text: 'Submit application', exact: true } }],
      }
    }

    assert(
      rendered.includes('FINAL_SUBMIT_NOT_EXECUTED_AUTOMATICALLY'),
      'final-submit approval awareness must return control without executing the click',
    )
    return {
      content: 'Final submit remains a manual boundary.',
      toolCalls: [{ id: 'handoff-done-at-final-submit', name: 'agent_done', arguments: { summary: 'Stopped before final submit.', blocked: true } }],
    }
  }
}

class AutoGate {
  async confirm() {
    return 'approve'
  }
}

class HandoffFixtureGate {
  constructor(sessionId) {
    this.sessionId = sessionId
    this.calls = []
  }

  async confirm(kind) {
    this.calls.push(kind)
    const page = sessionManager.get(this.sessionId)?.page
    assert(page, 'handoff fixture page should exist')

    if (kind === 'login') {
      await setFixturePage(page, 'captcha')
      return 'approve'
    }
    if (kind === 'captcha') {
      await setFixturePage(page, 'upload')
      return 'approve'
    }
    if (kind === 'upload_resume') return 'approve'
    if (kind === 'final_submit') return 'approve'
    return 'approve'
  }

  count(kind) {
    return this.calls.filter((call) => call === kind).length
  }
}

function renderMessagesForAssertion(messages) {
  return messages.map((message) => {
    const toolCalls = (message.tool_calls || [])
      .map((call) => `${call.id}:${call.function?.name || ''}`)
      .join(',')
    return [
      `role=${message.role}`,
      message.name ? `name=${message.name}` : '',
      toolCalls ? `toolCalls=${toolCalls}` : '',
      String(message.content || '').slice(0, 8000),
    ].filter(Boolean).join('\n')
  }).join('\n\n')
}

function seedFreshObservation(sessionId) {
  observationManager.refreshPageState({
    sessionId,
    snapshot: {
      snapshotId: `snap-${sessionId}`,
      url: 'https://example.test/resume',
      title: 'Resume probe page',
      textSummary: 'Stable resume probe context.',
      elements: [],
      stats: {
        elementCount: 0,
        interactiveCount: 0,
        formCount: 0,
        linkCount: 0,
        buttonCount: 0,
        inputCount: 0,
        truncated: false,
      },
    },
  })
}

function assertToolBoundariesIntact(messages) {
  let restoredProbeBoundarySeen = false

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]
    if (message.role !== 'assistant' || !message.tool_calls?.length) continue

    const expectedIds = new Set(message.tool_calls.map((toolCall) => toolCall.id))
    const matchedIds = new Set()
    let cursor = index + 1
    while (cursor < messages.length && messages[cursor].role === 'tool') {
      const toolCallId = messages[cursor].tool_call_id
      if (toolCallId && expectedIds.has(toolCallId)) matchedIds.add(toolCallId)
      cursor += 1
    }
    for (const expectedId of expectedIds) {
      assert(matchedIds.has(expectedId), `assistant tool_call ${expectedId} is missing its adjacent tool_result`)
    }
    if (expectedIds.has('resume-probe-call')) restoredProbeBoundarySeen = true
  }

  assert(restoredProbeBoundarySeen, 'restored resume-probe tool_call/tool_result boundary should be preserved')
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

async function main() {
  const root = mkdtempSync(join(tmpdir(), 'mfa-resume-loop-e2e-'))
  let handoffServer

  try {
    const resumePath = join(root, 'fixture-resume.txt')
    writeFileSync(resumePath, 'Fixture resume for upload handoff evidence.\n')
    const trace = new TraceRecorder(root, {
      runId: 'resume-loop-e2e-run',
      source: 'local-runtime',
      scenario: 'resume-loop-e2e-test',
      profile: 'test',
      goal: 'Verify interrupted session resume.',
    })
    const store = new FileSessionStore({ rootDir: join(root, 'sessions') })
    const session = await store.create({
      sessionId: 'resume-loop-e2e-session',
      runId: 'resume-loop-e2e-run',
      source: 'test',
      goal: 'Verify restoredMessages enter the next runAgentLoop call.',
      mode: 'test',
      traceRunId: trace.runId,
    })
    const recorder = new FileSessionRecorder(store, session)
    const firstRegistry = new ToolRegistry([
      {
        name: 'resume_probe',
        description: 'Writes a resume marker into the transcript.',
        category: 'observation',
        parameters: { type: 'object', properties: {} },
        inherentRisk: 'L1',
        async run() {
          return {
            observation: 'RESUME_PROBE_OBSERVATION from interrupted run',
            pageChanged: false,
          }
        },
      },
    ])

    seedFreshObservation('resume-loop-e2e')
    const interrupted = await runAgentLoop({
      goal: 'Verify restoredMessages enter the next runAgentLoop call.',
      resume: testProfile(),
      llm: new FirstRunLlm(),
      registry: firstRegistry,
      ctx: { sessionId: 'resume-loop-e2e', highlight: false, trace },
      gate: new AutoGate(),
      maxSteps: 1,
      session: recorder,
      contextBudget: { modelName: 'gpt-5-mini' },
    })

    assert.equal(interrupted.done, false, 'first run should stop before natural completion')
    const restored = await restoreSessionState({ store, sessionId: session.sessionId, now: '2026-07-09T00:00:00.000Z' })
    assert(
      restored.restoredMessages.some((message) => message.role === 'tool' && message.content.includes('RESUME_PROBE_OBSERVATION')),
      'restoreSessionState must rebuild tool result messages from the session transcript',
    )
    assertToolBoundariesIntact(restored.restoredMessages)

    handoffServer = await openHandoffFixture('resume-loop-e2e')
    const handoffGate = new HandoffFixtureGate('resume-loop-e2e')
    const resumeLlm = new HandoffResumeLlm(resumePath)
    const resumed = await runAgentLoop({
      goal: 'Continue the local handoff fixture after login, captcha, and resume upload, but stop before final submit.',
      resume: testProfile(),
      llm: resumeLlm,
      registry: new ToolRegistry(),
      ctx: { sessionId: 'resume-loop-e2e', highlight: false, trace },
      gate: handoffGate,
      maxSteps: 6,
      session: recorder,
      restoredMessages: restored.restoredMessages,
      requiresCurrentResumeUpload: true,
      taskType: 'fill_form',
      taskContract: {
        schemaVersion: 'web-task-contract/v1',
        contractId: 'resume-loop-e2e-explicit-sinks',
        revision: 0,
        criteria: [{
          id: 'final-submit-not-performed',
          kind: 'action_boundary',
          description: 'The fixture must stop before final submit.',
          actionKinds: ['submit'],
          outcome: 'not_performed',
        }],
        sensitiveActions: [{
          id: 'resume-loop-explicit-sink-contract',
          actionKinds: ['upload', 'submit'],
          decision: 'ask',
          requireApprovalBinding: true,
        }],
      },
      taskPolicy: {
        schemaVersion: 'task-policy/v1',
        defaultSensitiveAction: 'deny',
        rules: [{
          id: 'resume-loop-explicit-upload-approval',
          actionKinds: ['upload', 'submit'],
          decision: 'ask',
          requireApprovalBinding: true,
        }],
      },
      contextBudget: { modelName: 'gpt-5-mini' },
    })

    assert.equal(handoffGate.count('login'), 1, 'login should be a human handoff, not auto approval')
    assert.equal(handoffGate.count('captcha'), 1, 'captcha should be a human handoff, not auto approval')
    assert.equal(handoffGate.count('upload_resume'), 1, 'resume upload should require explicit human approval')
    assert.equal(resumeLlm.calls.length >= 2, true, 'runtime should continue into model work after handoff clears')
    assertToolBoundariesIntact(resumeLlm.calls[0])
    assert.equal(resumed.done, true, 'resumed fixture run should stop at a terminal boundary')
    assert.equal(resumed.blocked, true, 'final submit should keep the resumed fixture blocked by default')
    assert.equal(resumed.workflowState?.phase, 'final_submit_boundary')

    const fixtureState = await sessionManager.get('resume-loop-e2e')?.page.evaluate(() => window.__handoffFixture.getState())
    assert.equal(fixtureState.fileCount, 1, 'approved upload should execute exactly once')
    assert.match(fixtureState.fileName, /fixture-resume\.txt/)
    assert.equal(fixtureState.sent, false, 'final submit must not execute by default')

    const transcript = await readJsonLines(session.transcriptPath)
    assert(transcript.some((entry) => entry.type === 'tool_result' && entry.name === 'resume_probe'))
    assert(transcript.some((entry) => entry.type === 'tool_result' && entry.name === 'browser_upload_file'))
    assert(transcript.some((entry) => entry.type === 'approval_request' && JSON.stringify(entry.request).includes('upload_resume')))
    assert(transcript.some((entry) => entry.type === 'workflow_evidence' && JSON.stringify(entry.evidence).includes('final_submit')))

    trace.finish()
    console.log('resume-loop-e2e-test: PASS')
  } finally {
    await sessionManager.closeAll().catch(() => {})
    await closeServer(handoffServer)
    rmSync(root, { recursive: true, force: true })
  }
}

async function openHandoffFixture(sessionId) {
  const html = readFileSync(new URL('./fixtures/handoff-resume-flow.html', import.meta.url), 'utf8')
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(html)
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert(address && typeof address === 'object')
  const result = await browserOpen({
    sessionId,
    url: `http://127.0.0.1:${address.port}/handoff`,
    waitUntil: 'domcontentloaded',
  })
  assert.equal(result.ok, true, result.observation)
  const page = sessionManager.get(sessionId)?.page
  assert(page, 'handoff fixture page should exist after browser_open')
  await setFixturePage(page, 'login')
  return server
}

function closeServer(server) {
  if (!server?.listening) return Promise.resolve()
  return new Promise((resolve) => server.close(() => resolve()))
}

async function setFixturePage(page, kind) {
  await page.setContent(fixturePageHtml(kind), { waitUntil: 'domcontentloaded' })
}

function fixturePageHtml(kind) {
  if (kind === 'login') {
    return `<!doctype html><html><head><title>SSO Login</title></head><body>
      <h1>SSO Login</h1>
      <p>Please sign in with the company account before continuing the application.</p>
      <label for="password">Password</label>
      <input id="password" aria-label="password" type="password" autocomplete="current-password">
    </body></html>`
  }

  if (kind === 'captcha') {
    return `<!doctype html><html><head><title>Security check</title></head><body>
      <h1>Human verification</h1>
      <p>Captcha challenge: please verify you are human before continuing.</p>
      <button type="button">I completed the captcha</button>
    </body></html>`
  }

  if (kind === 'upload') {
    return `<!doctype html><html><head><title>Application form</title></head><body>
      <h1>Application form</h1>
      <form>
        <label for="name">Name</label>
        <input id="name" name="name" required value="Zhang San">
        <label for="email">Email</label>
        <input id="email" name="email" type="email" required value="zhangsan@example.com">
        <label for="resume-upload">Upload resume</label>
        <input id="resume-upload" name="resume" type="file" accept=".txt,.pdf,.doc,.docx">
        <p id="upload-status">Upload pending</p>
        <button id="final-submit" type="button" hidden>Submit application</button>
      </form>
      <script>
        (() => {
          const state = { fileCount: 0, fileName: '', sent: false }
          document.getElementById('resume-upload').addEventListener('change', (event) => {
            const file = event.target.files && event.target.files[0]
            state.fileCount += 1
            state.fileName = file ? file.name : ''
            document.getElementById('upload-status').textContent = file ? 'Uploaded ' + file.name : 'Upload pending'
            document.getElementById('final-submit').hidden = false
          })
          document.getElementById('final-submit').addEventListener('click', () => {
            state.sent = true
            document.body.setAttribute('data-final-action-executed', 'true')
            document.getElementById('upload-status').textContent = 'FINAL ACTION EXECUTED'
          })
          window.__handoffFixture = { getState: () => ({ ...state }) }
        })()
      </script>
    </body></html>`
  }

  throw new Error(`Unknown fixture page: ${kind}`)
}

await main()
