#!/usr/bin/env node
import assert from 'node:assert/strict'
import { browserClick } from '../dist/browser/click.js'
import { browserClickText } from '../dist/browser/click-text.js'
import { browserOpen } from '../dist/browser/open.js'
import { browserSnapshot } from '../dist/browser/snapshot.js'
import { sessionManager } from '../dist/session/manager.js'

process.env.PLAYWRIGHT_HEADLESS = 'true'
process.env.PLAYWRIGHT_ALLOW_DATA_URLS = 'true'
process.env.PLAYWRIGHT_ACTION_TIMEOUT_MS = '5000'

try {
  const html = `<!doctype html><html><body>
    <button id="save" onclick="window.saved = true">保存</button>
    <div role="dialog" aria-modal="true" style="position:fixed;inset:0;background:rgba(0,0,0,.2)">
      <div style="margin:80px auto;padding:20px;width:320px;background:white">
        <p>是否根据您上传附件中的简历，刷新简历详情中的信息？</p>
        <button id="no">否，仅替换附件</button>
        <button id="yes" onclick="window.covered = true">是，覆盖掉</button>
      </div>
    </div>
  </body></html>`

  const open = await browserOpen({
    sessionId: 'click-modal-guard-test',
    url: `data:text/html;charset=utf-8,${encodeURIComponent(html)}`,
    waitUntil: 'domcontentloaded',
  })
  assert.equal(open.ok, true, open.observation)
  const snapshot = await browserSnapshot({ sessionId: 'click-modal-guard-test' })
  assert.equal(snapshot.ok, true, snapshot.observation)
  const saveRef = snapshot.data.elements.find((element) => element.name === '保存')?.ref
  assert(saveRef, 'expected save button ref')

  const started = Date.now()
  const blocked = await browserClick({ sessionId: 'click-modal-guard-test', ref: saveRef })
  assert.equal(blocked.ok, false)
  assert.equal(blocked.error.code, 'ACTIONABLE_DIALOG_PRESENT')
  assert(Date.now() - started < 2000, 'modal guard should fail fast instead of waiting for click timeout')
  assert.match(blocked.observation, /刷新简历详情/)
  assert.match(blocked.observation, /是，覆盖掉/)

  const modalClick = await browserClickText({ sessionId: 'click-modal-guard-test', text: '是，覆盖掉', exact: true })
  assert.equal(modalClick.ok, true, modalClick.observation)
  const covered = await sessionManager.get('click-modal-guard-test').page.evaluate(() => window.covered === true)
  assert.equal(covered, true)

  console.log('click-modal-guard-test: PASS')
} finally {
  await sessionManager.closeAll().catch(() => {})
}

