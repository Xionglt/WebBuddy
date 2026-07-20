#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { browserClickText } from '../dist/browser/click-text.js'
import { browserOpen } from '../dist/browser/open.js'
import { sessionManager } from '../dist/session/manager.js'

const priorLocalhost = process.env.PLAYWRIGHT_BLOCK_LOCALHOST
const priorHeadless = process.env.PLAYWRIGHT_HEADLESS
process.env.PLAYWRIGHT_BLOCK_LOCALHOST = 'false'
process.env.PLAYWRIGHT_HEADLESS = 'true'

let foreignHits = 0
let sameOriginRedirectHopHits = 0
const foreign = createServer((_request, response) => {
  foreignHits += 1
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  response.end('<h1>foreign origin must never load</h1>')
})
await listen(foreign)
const foreignAddress = foreign.address()
assert(foreignAddress && typeof foreignAddress === 'object')
const foreignOrigin = `http://127.0.0.1:${foreignAddress.port}`

const source = createServer((request, response) => {
  if (request.url === '/redirect') {
    response.writeHead(302, { location: `${foreignOrigin}/redirect-target` })
    response.end()
    return
  }
  if (request.url === '/chain') {
    response.writeHead(302, { location: '/redirect-hop' })
    response.end()
    return
  }
  if (request.url === '/redirect-hop') {
    sameOriginRedirectHopHits += 1
    response.writeHead(302, { location: `${foreignOrigin}/chain-target` })
    response.end()
    return
  }
  if (request.url === '/same') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end('<h1>same origin reached</h1>')
    return
  }
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  response.end(`<!doctype html>
    <a href="/same">Same origin</a>
    <a href="${foreignOrigin}/click-target">Cross origin</a>
    <a href="${foreignOrigin}/popup-target" target="_blank">Cross popup</a>`)
})
await listen(source)
const sourceAddress = source.address()
assert(sourceAddress && typeof sourceAddress === 'object')
const sourceOrigin = `http://127.0.0.1:${sourceAddress.port}`
const sessionId = 'm6-navigation-boundary'

try {
  const redirected = await browserOpen({ url: `${sourceOrigin}/redirect`, sessionId })
  assert.equal(redirected.ok, false, 'cross-origin redirect must fail')
  assert.equal(redirected.error.code, 'NAVIGATION_BLOCKED')
  assert.equal(foreignHits, 0, 'redirect target received a request before policy denial')

  const chained = await browserOpen({ url: `${sourceOrigin}/chain`, sessionId })
  assert.equal(chained.ok, false, 'a same-origin first redirect must not hide a later cross-origin hop')
  assert.equal(chained.error.code, 'NAVIGATION_BLOCKED')
  assert.equal(sameOriginRedirectHopHits, 0, 'the redirect chain advanced without explicit reauthorization')
  assert.equal(foreignHits, 0)

  const openedPage = await browserOpen({ url: `${sourceOrigin}/page`, sessionId })
  assert.equal(openedPage.ok, true, `source page failed to reopen: ${JSON.stringify(openedPage)}`)
  const sameOrigin = await browserClickText({ text: 'Same origin', exact: true, sessionId })
  assert.equal(sameOrigin.ok, true, 'same-origin click navigation should remain compatible')
  assert.equal(new URL(sessionManager.get(sessionId).page.url()).origin, sourceOrigin)

  const reopenedPage = await browserOpen({ url: `${sourceOrigin}/page`, sessionId })
  assert.equal(reopenedPage.ok, true, `source page failed before cross-origin click: ${JSON.stringify(reopenedPage)}`)
  const crossOrigin = await browserClickText({ text: 'Cross origin', exact: true, sessionId })
  assert.equal(crossOrigin.ok, false, 'cross-origin click must fail')
  assert.equal(crossOrigin.error.code, 'NAVIGATION_BLOCKED')
  assert.equal(foreignHits, 0, 'cross-origin click target received a request')
  assert.equal(new URL(sessionManager.get(sessionId).page.url()).origin, sourceOrigin)

  const popupPage = await browserOpen({ url: `${sourceOrigin}/page`, sessionId })
  assert.equal(popupPage.ok, true, `source page failed before popup: ${JSON.stringify(popupPage)}`)
  const popup = await browserClickText({ text: 'Cross popup', exact: true, sessionId })
  assert.equal(popup.ok, false, 'cross-origin popup must be quarantined')
  assert.equal(popup.error.code, 'NAVIGATION_BLOCKED')
  await new Promise((resolve) => setTimeout(resolve, 100))
  const current = sessionManager.get(sessionId)
  assert(current)
  assert.equal(new URL(current.page.url()).origin, sourceOrigin, 'blocked popup became the active page')
  assert.equal(foreignHits, 0, 'popup target received a request')

  const afterBlockedPopup = await browserOpen({ url: `${sourceOrigin}/page`, sessionId })
  assert.equal(afterBlockedPopup.ok, true, 'a blocked popup must not poison the next action')
  const sameOriginAfterBlock = await browserClickText({ text: 'Same origin', exact: true, sessionId })
  assert.equal(sameOriginAfterBlock.ok, true, 'stale blocked-navigation state leaked into a later action')
} finally {
  await sessionManager.closeAll()
  await close(source)
  await close(foreign)
  if (priorLocalhost === undefined) delete process.env.PLAYWRIGHT_BLOCK_LOCALHOST
  else process.env.PLAYWRIGHT_BLOCK_LOCALHOST = priorLocalhost
  if (priorHeadless === undefined) delete process.env.PLAYWRIGHT_HEADLESS
  else process.env.PLAYWRIGHT_HEADLESS = priorHeadless
}

console.log('security-m6-navigation-boundary-test: PASS (redirect/click/popup pre-network full-origin enforcement)')

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
}
