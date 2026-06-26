#!/usr/bin/env node
import assert from 'node:assert/strict'
import { AgentRuntime } from '../dist/agent/agent-runtime.js'
import { browserOpen } from '../dist/browser/open.js'
import { AutoHumanGate } from '../dist/sdk/human.js'
import { sessionManager } from '../dist/session/manager.js'

process.env.PLAYWRIGHT_HEADLESS = 'true'
process.env.PLAYWRIGHT_ALLOW_DATA_URLS = 'true'
process.env.PLAYWRIGHT_TYPE_DELAY_MS = '0'
process.env.PLAYWRIGHT_SLOWMO_MS = '0'

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

const trace = {
  record() {},
}

const runtime = new AgentRuntime()

class UnexpectedLlm {
  constructor() {
    this.hasKey = true
    this.label = 'unexpected-workflow-llm'
  }

  async chatWithTools() {
    throw new Error('LLM should not be called for workflow handoff pages')
  }
}

class FinalSubmitLlm {
  constructor() {
    this.hasKey = true
    this.label = 'final-submit-workflow-llm'
  }

  async chatWithTools(messages) {
    const rendered = JSON.stringify(messages)
    assert(rendered.includes('## WORKFLOW_STATE'), 'runtime prompt should include workflow state')
    return {
      content: 'The application is ready to submit.',
      toolCalls: [{ id: 'final-submit', name: 'browser_click_text', arguments: { text: 'Submit application', exact: true } }],
    }
  }
}

try {
  await openHtml('workflow-login', `<!doctype html><html><head><title>SSO Login</title></head><body>
    <h1>Sign in</h1>
    <p>请登录 SSO 后继续申请。</p>
    <input aria-label="password" type="password" />
  </body></html>`)
  const loginResult = await runtime.run({
    goal: 'Fill the current application.',
    resume: profile,
    llm: new UnexpectedLlm(),
    ctx: { sessionId: 'workflow-login', highlight: false, trace },
    gate: new AutoHumanGate(),
    maxSteps: 3,
  })
  assert.equal(loginResult.done, true)
  assert.equal(loginResult.blocked, true)
  assert.equal(loginResult.stopReason, 'blocked')
  assert.equal(loginResult.workflowState?.phase, 'login_required')
  assert.match(loginResult.summary, /Human login required/i)
  assert.equal(loginResult.workflowState?.humanHandoffRequired, true)

  await openHtml('workflow-captcha', `<!doctype html><html><head><title>Security check</title></head><body>
    <h1>人机验证</h1>
    <p>Please verify you are human before continuing.</p>
  </body></html>`)
  const captchaResult = await runtime.run({
    goal: 'Fill the current application.',
    resume: profile,
    llm: new UnexpectedLlm(),
    ctx: { sessionId: 'workflow-captcha', highlight: false, trace },
    gate: new AutoHumanGate(),
    maxSteps: 3,
  })
  assert.equal(captchaResult.done, true)
  assert.equal(captchaResult.blocked, true)
  assert.equal(captchaResult.workflowState?.phase, 'captcha_required')
  assert.match(captchaResult.summary, /Human verification required/i)

  await openHtml('workflow-final-submit', `<!doctype html><html><head><title>Application Review</title></head><body>
    <h1>Review application</h1>
    <label for="name">Name</label><input id="name" value="Zhang San" />
    <label for="email">Email</label><input id="email" value="zhangsan@example.com" />
    <button type="button">Submit application</button>
  </body></html>`)
  const finalResult = await runtime.run({
    goal: 'Submit the current application.',
    resume: profile,
    llm: new FinalSubmitLlm(),
    ctx: { sessionId: 'workflow-final-submit', highlight: false, trace },
    gate: new AutoHumanGate(),
    maxSteps: 3,
  })
  assert.equal(finalResult.done, true)
  assert.equal(finalResult.blocked, true)
  assert.equal(finalResult.stopReason, 'blocked')
  assert.equal(finalResult.workflowState?.phase, 'blocked')
  assert.match(finalResult.workflowState?.blocker ?? '', /Final submit/i)

  console.log('agent-runtime-workflow-test: PASS')
} finally {
  await sessionManager.closeAll().catch(() => {})
}

async function openHtml(sessionId, html) {
  const result = await browserOpen({
    sessionId,
    url: `data:text/html,${encodeURIComponent(html)}`,
    waitUntil: 'domcontentloaded',
  })
  assert.equal(result.ok, true, result.observation)
}
