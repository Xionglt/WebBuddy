#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { browserClick } from '../dist/browser/click.js'
import { browserOpen } from '../dist/browser/open.js'
import { diffPostcondition } from '../dist/browser/postcondition.js'
import { browserSnapshot } from '../dist/browser/snapshot.js'
import { sessionManager } from '../dist/session/manager.js'

process.env.PLAYWRIGHT_HEADLESS = 'true'
process.env.PLAYWRIGHT_ALLOW_DATA_URLS = 'true'
process.env.PLAYWRIGHT_BLOCK_LOCALHOST = 'false'
process.env.PLAYWRIGHT_ACTION_TIMEOUT_MS = '1000'

const baseline = {
  url: 'https://example.test/a',
  bodyTextHash: '100',
  interactiveCount: 3,
  dialogOpen: false,
  focusedSelector: null,
  targetChecked: null,
  targetDisabled: false,
  targetValue: null,
}

assert.equal(diffPostcondition(baseline, { ...baseline, url: 'https://example.test/b' }).outcome, 'navigation')
assert.equal(diffPostcondition(baseline, { ...baseline, dialogOpen: true }).outcome, 'dialog_opened')
assert.equal(diffPostcondition({ ...baseline, dialogOpen: true }, baseline).outcome, 'dialog_closed')
assert.equal(diffPostcondition(baseline, { ...baseline, bodyTextHash: '200' }).outcome, 'state_changed')
assert.equal(diffPostcondition(baseline, { ...baseline }).outcome, 'no_op')
assert.equal(diffPostcondition(baseline, { ...baseline, focusedSelector: 'button#idle' }).outcome, 'uncertain')
assert.equal(diffPostcondition(baseline, { ...baseline, captureError: 'Execution context destroyed' }).outcome, 'uncertain')

let baseUrl = ''
const server = createServer((request, response) => {
  response.setHeader('content-type', 'text/html; charset=utf-8')
  if (request.url === '/next') {
    response.end('<!doctype html><html><body><h1>Next page</h1></body></html>')
    return
  }
  response.end(`<!doctype html><html><body>
    <button id="state" onclick="document.getElementById('status').textContent = 'changed'">Change state</button>
    <button id="idle">Idle button</button>
    <button id="nav" onclick="location.href = '/next'">Navigate</button>
    <button id="dialog-open" onclick="document.getElementById('modal').style.display = 'block'">Open dialog</button>
    <div id="status">idle</div>
    <div id="modal" role="dialog" aria-modal="true" style="display:none">Dialog ready</div>
  </body></html>`)
})

try {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert(address && typeof address === 'object')
  baseUrl = `http://127.0.0.1:${address.port}/`

  assert.equal(await clickOutcome('Change state'), 'state_changed')
  assert.equal(await clickOutcome('Idle button'), 'uncertain')
  assert.equal(await clickOutcome('Navigate'), 'navigation')
  assert.equal(await clickOutcome('Open dialog'), 'dialog_opened')

  console.log('browser-postcondition-test: PASS')
} finally {
  await sessionManager.closeAll().catch(() => {})
  server.close()
}

async function clickOutcome(name) {
  const open = await browserOpen({
    sessionId: 'browser-postcondition-test',
    url: baseUrl,
    waitUntil: 'domcontentloaded',
  })
  assert.equal(open.ok, true, open.observation)
  const snapshot = await browserSnapshot({ sessionId: 'browser-postcondition-test' })
  assert.equal(snapshot.ok, true, snapshot.observation)
  const ref = snapshot.data.elements.find((element) => element.name === name)?.ref
  assert(ref, `expected ref for ${name}`)
  const result = await browserClick({ sessionId: 'browser-postcondition-test', ref })
  assert.equal(result.ok, true, result.observation)
  return result.data.postcondition.outcome
}
