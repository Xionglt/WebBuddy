#!/usr/bin/env node
import assert from 'node:assert/strict'
import { browserClick } from '../dist/browser/click.js'
import { browserOpen } from '../dist/browser/open.js'
import { browserSnapshot } from '../dist/browser/snapshot.js'
import { sessionManager } from '../dist/session/manager.js'

process.env.PLAYWRIGHT_HEADLESS = 'true'
process.env.PLAYWRIGHT_ALLOW_DATA_URLS = 'true'
process.env.PLAYWRIGHT_ACTION_TIMEOUT_MS = '1000'

try {
  const html = `<!doctype html><html><body>
    <button id="old">Old target</button>
    <div id="status">initial</div>
  </body></html>`

  const open = await browserOpen({
    sessionId: 'stale-ref-retry-test',
    url: `data:text/html;charset=utf-8,${encodeURIComponent(html)}`,
    waitUntil: 'domcontentloaded',
  })
  assert.equal(open.ok, true, open.observation)

  const snapshot = await browserSnapshot({ sessionId: 'stale-ref-retry-test' })
  assert.equal(snapshot.ok, true, snapshot.observation)
  const staleRef = snapshot.data.elements.find((element) => element.name === 'Old target')?.ref
  assert.equal(staleRef, 'e1')

  const page = sessionManager.get('stale-ref-retry-test').page
  await page.evaluate(() => {
    document.body.innerHTML = `
      <main>
        <section>
          <button id="fresh" onclick="document.getElementById('status').textContent = 'fresh clicked'">Fresh target</button>
        </section>
        <div id="status">ready</div>
      </main>
    `
  })

  const clicked = await browserClick({ sessionId: 'stale-ref-retry-test', ref: staleRef })
  assert.equal(clicked.ok, true, clicked.observation)
  assert.match(clicked.observation, /Fresh target/)

  const status = await page.locator('#status').textContent()
  assert.equal(status, 'fresh clicked')

  console.log('stale-ref-retry-test: PASS')
} finally {
  await sessionManager.closeAll().catch(() => {})
}
