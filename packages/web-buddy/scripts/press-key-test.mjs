#!/usr/bin/env node
import assert from 'node:assert/strict'
import { browserOpen } from '../dist/browser/open.js'
import { browserPressKey } from '../dist/browser/press-key.js'
import { browserSnapshot } from '../dist/browser/snapshot.js'
import { browserType } from '../dist/browser/type.js'
import { sessionManager } from '../dist/session/manager.js'

process.env.PLAYWRIGHT_HEADLESS = 'true'
process.env.PLAYWRIGHT_ALLOW_DATA_URLS = 'true'
process.env.PLAYWRIGHT_ACTION_TIMEOUT_MS = '1000'

try {
  const html = `<!doctype html><html><body>
    <label>Search jobs <input id="search" aria-label="Search jobs"></label>
    <div id="status">idle</div>
    <script>
      document.getElementById('search').addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          document.getElementById('status').textContent = 'searched:' + event.currentTarget.value;
        }
      });
    </script>
  </body></html>`

  const open = await browserOpen({
    sessionId: 'press-key-test',
    url: `data:text/html;charset=utf-8,${encodeURIComponent(html)}`,
    waitUntil: 'domcontentloaded',
  })
  assert.equal(open.ok, true, open.observation)

  const snapshot = await browserSnapshot({ sessionId: 'press-key-test' })
  assert.equal(snapshot.ok, true, snapshot.observation)
  const ref = snapshot.data.elements.find((element) => element.name === 'Search jobs')?.ref
  assert(ref, 'expected search input ref')

  const type = await browserType({ sessionId: 'press-key-test', ref, text: 'React' })
  assert.equal(type.ok, true, type.observation)

  const press = await browserPressKey({ sessionId: 'press-key-test', ref, key: 'Enter' })
  assert.equal(press.ok, true, press.observation)

  const status = await sessionManager.get('press-key-test').page.locator('#status').textContent()
  assert.equal(status, 'searched:React')

  const invalid = await browserPressKey({ sessionId: 'press-key-test', key: 'A' })
  assert.equal(invalid.ok, false)
  assert.equal(invalid.error.code, 'INVALID_ARGUMENT')

  console.log('press-key-test: PASS')
} finally {
  await sessionManager.closeAll().catch(() => {})
}
