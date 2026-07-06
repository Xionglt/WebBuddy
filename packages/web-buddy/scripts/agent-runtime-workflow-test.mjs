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
    this.calls = 0
  }

  async chatWithTools(messages) {
    this.calls += 1
    const rendered = JSON.stringify(messages)
    assert(rendered.includes('## WORKFLOW_STATE'), 'runtime prompt should include workflow state')
    if (this.calls > 1) {
      assert(rendered.includes('FINAL_SUBMIT_NOT_EXECUTED_AUTOMATICALLY'), 'runtime should return final-submit gate observation to the model')
      return {
        content: 'Final submit is a manual boundary; stopping for the human.',
        toolCalls: [{ id: 'done-after-final-submit-gate', name: 'agent_done', arguments: { summary: 'Stopped before final submit for human review.', blocked: true } }],
      }
    }
    return {
      content: 'The application is ready to submit.',
      toolCalls: [{ id: 'final-submit', name: 'browser_click_text', arguments: { text: 'Submit application', exact: true } }],
    }
  }
}

class ContinueAfterLoginLlm {
  constructor() {
    this.hasKey = true
    this.label = 'continue-after-login-llm'
    this.calls = 0
  }

  async chatWithTools(messages) {
    this.calls += 1
    const rendered = JSON.stringify(messages)
    assert(rendered.includes('Application form'), 'runtime should refresh context after login handoff')
    if (this.calls === 1) {
      return {
        content: 'Login is cleared but I am unsure whether to continue.',
        toolCalls: [{ id: 'premature-done-after-login', name: 'agent_done', arguments: { summary: 'Blocked after login handoff.', blocked: true } }],
      }
    }
    assert(
      rendered.includes('PREMATURE_AGENT_DONE_REJECTED') && rendered.includes('login/captcha handoff has cleared'),
      'runtime should reject premature blocked=true after login handoff returns to the application flow',
    )
    return {
      content: 'Login is cleared and the workflow can continue.',
      toolCalls: [{ id: 'done-after-login', name: 'agent_done', arguments: { summary: 'continued after login', blocked: false } }],
    }
  }
}

class AlibabaConfirmationDoneLlm {
  constructor() {
    this.hasKey = true
    this.label = 'alibaba-confirmation-done-llm'
    this.calls = 0
  }

  async chatWithTools(messages) {
    this.calls += 1
    const rendered = JSON.stringify(messages)
    if (this.calls === 1) {
      return {
        content: 'The Alibaba confirmation dialog looks final; I will stop.',
        toolCalls: [{ id: 'premature-done', name: 'agent_done', arguments: { summary: 'Blocked at Alibaba confirmation dialog.', blocked: true } }],
      }
    }
    assert(
      rendered.includes('ALIBABA_APPLICATION_CONFIRMATION_STILL_OPEN'),
      'runtime should reject premature agent_done while Alibaba confirmation dialog is still open',
    )
    if (this.calls === 2) {
      return {
        content: 'I will cancel the dialog instead of ending the run.',
        toolCalls: [{ id: 'cancel-dialog', name: 'browser_click_text', arguments: { text: '取消', exact: true } }],
      }
    }
    return {
      content: 'Dialog resolved.',
      toolCalls: [{ id: 'done-after-dialog', name: 'agent_done', arguments: { summary: 'Stopped after resolving Alibaba confirmation dialog.', blocked: true } }],
    }
  }
}

class PrematureFillDoneLlm {
  constructor() {
    this.hasKey = true
    this.label = 'premature-fill-done-llm'
    this.calls = 0
  }

  async chatWithTools(messages) {
    this.calls += 1
    const rendered = JSON.stringify(messages)
    if (this.calls === 1) {
      assert(rendered.includes('pendingRequired=1'), 'runtime prompt should include FillLedger pending required summary')
      return {
        content: 'The form looks simple; I will stop early.',
        toolCalls: [{ id: 'premature-fill-done', name: 'agent_done', arguments: { summary: 'Done without filling.', blocked: false } }],
      }
    }
    if (this.calls === 2) {
      assert(
        rendered.includes('fill_form_coverage_scrolled_bottom') && rendered.includes('fill_pending_required_zero'),
        'runtime should return executable fill-completeness gaps to the model',
      )
      return {
        content: 'I need a full form audit first.',
        toolCalls: [{ id: 'audit-form', name: 'browser_form_audit', arguments: {} }],
      }
    }
    if (this.calls === 3) {
      return {
        content: 'Now I will fill the required name field.',
        toolCalls: [{
          id: 'set-name',
          name: 'browser_set_field',
          arguments: {
            label: 'Name',
            fieldKey: 'name',
            fieldIndex: 0,
            controlKind: 'text',
            intendedValue: 'Zhang San',
          },
        }],
      }
    }
    assert(rendered.includes('pendingRequired=0'), 'FillLedger should show no pending required fields after browser_set_field')
    return {
      content: 'The required field is filled and audited.',
      toolCalls: [{ id: 'done-after-fill', name: 'agent_done', arguments: { summary: 'Filled required fields.', blocked: false } }],
    }
  }
}

class LoginClearingGate {
  async confirm(kind) {
    assert.equal(kind, 'login')
    const page = sessionManager.get('workflow-login-resume')?.page
    assert(page, 'test page should exist')
    await page.setContent(`<!doctype html><html><head><title>Application form</title></head><body>
      <h1>Application form</h1>
      <label for="name">Name</label><input id="name" value="Zhang San" />
      <label for="email">Email</label><input id="email" value="zhangsan@example.com" />
    </body></html>`)
    return 'approve'
  }
}

class ApprovingFinalSubmitGate {
  async confirm(kind) {
    assert.equal(kind, 'final_submit')
    return 'approve'
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

  await openHtml('workflow-login-resume', `<!doctype html><html><head><title>Application Shell</title></head><body>
  </body></html>`)
  await sessionManager.get('workflow-login-resume')?.page.setContent(`<!doctype html><html><head><title>SSO Login</title></head><body>
    <h1>Sign in</h1>
    <p>请登录 SSO 后继续申请。</p>
    <input aria-label="password" type="password" />
  </body></html>`)
  const loginResumeLlm = new ContinueAfterLoginLlm()
  const loginResumeResult = await runtime.run({
    goal: 'Fill the current application.',
    resume: profile,
    llm: loginResumeLlm,
    ctx: { sessionId: 'workflow-login-resume', highlight: false, trace },
    gate: new LoginClearingGate(),
    maxSteps: 3,
  })
  assert.equal(loginResumeLlm.calls >= 2, true, 'runtime should continue after premature blocked=true once login is cleared')
  assert.equal(loginResumeResult.done, true)
  assert.equal(loginResumeResult.workflowState?.phase, 'done')
  assert.doesNotMatch(loginResumeResult.summary, /Human login required/i)

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
    <nav>首页 社会招聘 校园招聘 个人中心 登录</nav>
    <h1>Review application</h1>
    <label for="name">Name</label><input id="name" value="Zhang San" />
    <label for="email">Email</label><input id="email" value="zhangsan@example.com" />
    <button type="button">Submit application</button>
  </body></html>`)
  const finalLlm = new FinalSubmitLlm()
  const finalResult = await runtime.run({
    goal: 'Submit the current application.',
    resume: profile,
    llm: finalLlm,
    ctx: { sessionId: 'workflow-final-submit', highlight: false, trace },
    gate: new ApprovingFinalSubmitGate(),
    maxSteps: 4,
  })
  assert.equal(finalLlm.calls >= 2, true, 'runtime should continue after final-submit gate instead of stopping immediately')
  assert.equal(finalResult.done, true)
  assert.equal(finalResult.blocked, true)
  assert.equal(finalResult.stopReason, 'blocked')
  assert.equal(finalResult.workflowState?.phase, 'blocked')
  assert.match(finalResult.workflowState?.blocker ?? '', /Final submit/i)
  assert.match(finalResult.summary, /Stopped before final submit/i)

  await openHtml('workflow-alibaba-confirmation', `<!doctype html><html><head><title>Application Shell</title></head><body></body></html>`)
  const alibabaPage = sessionManager.get('workflow-alibaba-confirmation')?.page
  assert(alibabaPage, 'Alibaba confirmation test page should exist')
  await alibabaPage.route('https://talent-holding.alibaba.com/off-campus/position-detail?*', (route) => route.fulfill({
    status: 200,
    contentType: 'text/html; charset=utf-8',
    body: `<!doctype html><html lang="zh"><head><title>阿里岗位详情</title></head><body>
      <h1>集团安全部-大模型训练算法工程师/专家-数据安全</h1>
      <div role="dialog" aria-label="温馨提示">
        <p>温馨提示：你暂未申请职位，本月能申请5个职位，请慎重选择！</p>
        <button onclick="document.querySelector('[role=dialog]').remove()">取消</button>
        <button>投递</button>
      </div>
    </body></html>`,
  }))
  await alibabaPage.goto('https://talent-holding.alibaba.com/off-campus/position-detail?lang=zh&positionId=fixture')
  const alibabaDoneLlm = new AlibabaConfirmationDoneLlm()
  const alibabaDoneResult = await runtime.run({
    goal: 'Continue the Alibaba application flow.',
    resume: profile,
    llm: alibabaDoneLlm,
    ctx: { sessionId: 'workflow-alibaba-confirmation', highlight: false, trace },
    gate: new AutoHumanGate(),
    maxSteps: 5,
  })
  assert.equal(alibabaDoneLlm.calls >= 2, true, 'runtime should continue after premature Alibaba dialog agent_done')
  assert.equal(await alibabaPage.locator('[role="dialog"]').count(), 0, 'test model should get a chance to resolve the dialog')
  assert.equal(alibabaDoneResult.done, true)

  await openHtml('workflow-premature-fill-done', `<!doctype html><html><head><title>Application Form</title></head><body>
    <h1>Application form</h1>
    <label for="name">Name</label><input id="name" required />
  </body></html>`)
  const prematureFillLlm = new PrematureFillDoneLlm()
  const prematureFillResult = await runtime.run({
    goal: 'Fill the current application form.',
    resume: profile,
    llm: prematureFillLlm,
    ctx: {
      sessionId: 'workflow-premature-fill-done',
      highlight: false,
      trace,
      fieldPlan: {
        schemaVersion: 'field-plan/v1',
        planned: [{
          fieldKey: 'name',
          fieldIndex: 0,
          label: 'Name',
          controlKind: 'text',
          required: true,
          requiredConfidence: 1,
          intendedValue: 'Zhang San',
          valueSource: 'resume',
          confidence: 1,
        }],
        fieldCount: 1,
        updatedAt: '2026-06-30T00:00:00.000Z',
      },
    },
    gate: new AutoHumanGate(),
    maxSteps: 6,
  })
  assert.equal(prematureFillLlm.calls >= 4, true, 'runtime should continue after premature fill agent_done')
  assert.equal(prematureFillResult.done, true)
  assert.equal(prematureFillResult.blocked, true)
  assert.match(prematureFillResult.summary, /required workflow evidence is missing/i)
  assert.equal(await sessionManager.get('workflow-premature-fill-done')?.page.locator('#name').inputValue(), 'Zhang San')

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
