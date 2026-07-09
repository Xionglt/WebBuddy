#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentRuntime } from '../dist/agent/agent-runtime.js'
import { browserOpen } from '../dist/browser/open.js'
import { AutoHumanGate } from '../dist/sdk/human.js'
import { TraceRecorder } from '../dist/sdk/trace.js'
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

const traceRoot = mkdtempSync(join(tmpdir(), 'mfa-agent-runtime-workflow-'))
const trace = new TraceRecorder(traceRoot, {
  runId: 'agent-runtime-workflow-test',
  source: 'local-runtime',
  scenario: 'agent-runtime-workflow-test',
  profile: 'test',
  goal: 'Verify workflow handoff and final-submit boundaries.',
})

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
    if (this.calls === 2) {
      return {
        content: 'Login is cleared; I will audit the form before finishing.',
        toolCalls: [{ id: 'audit-after-login', name: 'browser_form_audit', arguments: {} }],
      }
    }
    assert(rendered.includes('Form audit scanned'), 'runtime should return form audit evidence before final agent_done')
    return {
      content: 'Login is cleared and the workflow can continue.',
      toolCalls: [{ id: 'done-after-login', name: 'agent_done', arguments: { summary: 'continued after login', blocked: false } }],
    }
  }
}

class ActionableDialogDoneLlm {
  constructor() {
    this.hasKey = true
    this.label = 'actionable-dialog-done-llm'
    this.calls = 0
  }

  async chatWithTools(messages) {
    this.calls += 1
    const rendered = JSON.stringify(messages)
    if (this.calls === 1) {
      return {
        content: 'The confirmation dialog looks final; I will stop.',
        toolCalls: [{ id: 'premature-done', name: 'agent_done', arguments: { summary: 'Blocked at confirmation dialog.', blocked: true } }],
      }
    }
    assert(
      rendered.includes('PREMATURE_AGENT_DONE_REJECTED'),
      'runtime should reject premature agent_done while actionable dialog controls are still open',
    )
    if (this.calls === 2) {
      return {
        content: 'I will cancel the dialog instead of ending the run.',
        toolCalls: [{ id: 'cancel-dialog', name: 'browser_click_text', arguments: { text: 'Cancel', exact: true } }],
      }
    }
    return {
      content: 'Dialog resolved.',
      toolCalls: [{ id: 'done-after-dialog', name: 'agent_done', arguments: { summary: 'Continued after resolving confirmation dialog.', blocked: false } }],
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
        rendered.includes('PREMATURE_AGENT_DONE_REJECTED') &&
          rendered.includes('scope=viewport') &&
          rendered.includes('missingRequired may be incomplete'),
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
    if (this.calls === 4) {
      assert(rendered.includes('pendingRequired=0'), 'FillLedger should show no pending required fields after browser_set_field')
      return {
        content: 'I will audit once more after filling.',
        toolCalls: [{ id: 'audit-after-fill', name: 'browser_form_audit', arguments: {} }],
      }
    }
    assert(rendered.includes('pendingRequired=0'), 'FillLedger should show no pending required fields after browser_set_field')
    return {
      content: 'The required field is filled and audited.',
      toolCalls: [{ id: 'done-after-fill', name: 'agent_done', arguments: { summary: 'Filled required fields.', blocked: false } }],
    }
  }
}

class RequiredSelectPlaceholderLlm {
  constructor() {
    this.hasKey = true
    this.label = 'required-select-placeholder-llm'
    this.calls = 0
  }

  async chatWithTools(messages) {
    this.calls += 1
    const rendered = JSON.stringify(messages)
    if (this.calls === 1) {
      return {
        content: 'I need a full audit before trusting required fields.',
        toolCalls: [{ id: 'audit-select-form', name: 'browser_form_audit', arguments: {} }],
      }
    }
    if (this.calls === 2) {
      assert(rendered.includes('formCoverage: scope=full_audit'), 'runtime prompt should include full audit coverage')
      assert(rendered.includes('Preferred role track'), 'runtime prompt should show the required select blocker')
      return {
        content: 'I think the select placeholder is acceptable.',
        toolCalls: [{ id: 'premature-select-done', name: 'agent_done', arguments: { summary: 'Required select is fine.', blocked: false } }],
      }
    }
    if (this.calls === 3) {
      assert(
        rendered.includes('PREMATURE_AGENT_DONE_REJECTED') && rendered.includes('Preferred role track'),
        'runtime should reject agent_done while required select placeholder remains missingRequired',
      )
      return {
        content: 'I will choose a real role track.',
        toolCalls: [{
          id: 'set-role-track',
          name: 'browser_set_field',
          arguments: {
            label: 'Preferred role track',
            fieldKey: 'role-track',
            fieldIndex: 0,
            controlKind: 'select_native',
            intendedValue: 'Frontend',
          },
        }],
      }
    }
    if (this.calls === 4) {
      return {
        content: 'I will audit again after selecting the required role.',
        toolCalls: [{ id: 'audit-after-select', name: 'browser_form_audit', arguments: {} }],
      }
    }
    assert(rendered.includes('missingRequiredCount: 0'), 'required select should clear missingRequired after selecting a real option')
    return {
      content: 'The required select is filled and audited.',
      toolCalls: [{ id: 'done-after-select', name: 'agent_done', arguments: { summary: 'Selected required role.', blocked: false } }],
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
      <form>
        <label for="name">Name</label><input id="name" required value="Zhang San" />
        <label for="email">Email</label><input id="email" required value="zhangsan@example.com" />
        <button type="button">Save draft</button>
      </form>
    </body></html>`)
    return 'approve'
  }
}

class BlockingWorkflowHandoffGate {
  async confirm(kind) {
    assert(kind === 'login' || kind === 'captcha')
    return 'takeover'
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
    gate: new BlockingWorkflowHandoffGate(),
    maxSteps: 3,
  })
  assert.equal(loginResult.done, true)
  assert.equal(loginResult.blocked, true)
  assert.equal(loginResult.stopReason, 'blocked')
  assert.equal(loginResult.workflowState?.phase, 'external_blocker')
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
    taskType: 'apply_entry',
    maxSteps: 5,
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
    gate: new BlockingWorkflowHandoffGate(),
    maxSteps: 3,
  })
  assert.equal(captchaResult.done, true)
  assert.equal(captchaResult.blocked, true)
  assert.equal(captchaResult.workflowState?.phase, 'external_blocker')
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
  assert.equal(finalLlm.calls, 0, 'runtime should stop at initial final-submit boundary before asking the model to click')
  assert.equal(finalResult.done, true)
  assert.equal(finalResult.blocked, true)
  assert.equal(finalResult.stopReason, 'blocked')
  assert.equal(finalResult.workflowState?.phase, 'final_submit_boundary')
  assert.match(finalResult.workflowState?.blocker ?? '', /Final submit/i)
  assert.match(finalResult.summary, /Final submit requires human takeover/i)

  await openHtml('workflow-actionable-dialog', `<!doctype html><html><head><title>Application Dialog</title></head><body>
    <h1>Application confirmation</h1>
    <div role="dialog" aria-label="Application confirmation">
      <p>Please confirm whether to continue this application step.</p>
      <button onclick="document.querySelector('[role=dialog]').remove()">Cancel</button>
      <button>Continue</button>
    </div>
  </body></html>`)
  const dialogPage = sessionManager.get('workflow-actionable-dialog')?.page
  assert(dialogPage, 'actionable dialog test page should exist')
  const dialogDoneLlm = new ActionableDialogDoneLlm()
  const dialogDoneResult = await runtime.run({
    goal: 'Continue the application flow.',
    resume: profile,
    llm: dialogDoneLlm,
    ctx: { sessionId: 'workflow-actionable-dialog', highlight: false, trace },
    gate: new AutoHumanGate(),
    taskType: 'apply_entry',
    maxSteps: 5,
  })
  assert.equal(dialogDoneLlm.calls >= 2, true, 'runtime should continue after premature dialog agent_done')
  assert.equal(await dialogPage.locator('[role="dialog"]').count(), 0, 'test model should get a chance to resolve the dialog')
  assert.equal(dialogDoneResult.done, true)

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
    maxSteps: 7,
  })
  assert.equal(prematureFillLlm.calls >= 4, true, 'runtime should continue after premature fill agent_done')
  assert.equal(prematureFillResult.done, false)
  assert.equal(prematureFillResult.blocked, false)
  assert.equal(prematureFillResult.stopReason, 'step_budget')
  assert.match(prematureFillResult.summary, /Reached step budget/i)
  assert.equal(await sessionManager.get('workflow-premature-fill-done')?.page.locator('#name').inputValue(), 'Zhang San')

  await openHtml('workflow-required-select-placeholder', `<!doctype html><html><head><title>Application Form</title></head><body>
    <h1>Application form</h1>
    <form>
      <label for="role-track">Preferred role track *</label>
      <select id="role-track" name="role-track" required>
        <option value="" selected>Select one</option>
        <option value="Frontend">Frontend</option>
        <option value="Backend">Backend</option>
      </select>
      <button type="button">Save draft</button>
    </form>
  </body></html>`)
  const requiredSelectLlm = new RequiredSelectPlaceholderLlm()
  const requiredSelectResult = await runtime.run({
    goal: 'Fill the current application form.',
    resume: profile,
    llm: requiredSelectLlm,
    ctx: { sessionId: 'workflow-required-select-placeholder', highlight: false, trace },
    gate: new AutoHumanGate(),
    maxSteps: 7,
  })
  assert.equal(requiredSelectLlm.calls >= 5, true, 'runtime should continue after required select placeholder agent_done')
  assert.equal(requiredSelectResult.done, false)
  assert.equal(requiredSelectResult.blocked, false)
  assert.equal(requiredSelectResult.stopReason, 'step_budget')
  assert.match(requiredSelectResult.summary, /Reached step budget/i)
  assert.equal(await sessionManager.get('workflow-required-select-placeholder')?.page.locator('#role-track').inputValue(), 'Frontend')

  console.log('agent-runtime-workflow-test: PASS')
} finally {
  trace.finish()
  await sessionManager.closeAll().catch(() => {})
  rmSync(traceRoot, { recursive: true, force: true })
}

async function openHtml(sessionId, html) {
  const result = await browserOpen({
    sessionId,
    url: `data:text/html,${encodeURIComponent(html)}`,
    waitUntil: 'domcontentloaded',
  })
  assert.equal(result.ok, true, result.observation)
}
