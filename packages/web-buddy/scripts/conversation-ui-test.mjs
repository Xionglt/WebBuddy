#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWebControlServer } from '../dist/web/server.js'

const rootDir = await mkdtemp(join(tmpdir(), 'web-buddy-conversation-ui-'))
const control = createWebControlServer({ controlStoreDir: rootDir, disableExecution: true })

try {
  await new Promise((resolve, reject) => {
    control.server.once('error', reject)
    control.server.listen(0, '127.0.0.1', resolve)
  })
  const address = control.server.address()
  assert(address && typeof address === 'object')
  const html = await (await fetch(`http://127.0.0.1:${address.port}/`)).text()

  for (const id of [
    'conversationList',
    'welcomeView',
    'conversationView',
    'conversationShell',
    'conversationMain',
    'conversationHeader',
    'conversationScroller',
    'conversationComposer',
    'messageList',
    'followupInput',
    'newConversationBtn',
    'conversationApprovalList',
    'executionDetails',
    'executionPane',
    'executionDetailsToggle',
  ]) {
    assert.match(html, new RegExp(`id=["']${id}["']`), `missing Conversation UI element #${id}`)
  }
  assert.match(html, /继续追问/)
  assert.match(html, /执行详情/)
  assert.match(html, /\/api\/conversations/)
  assert.match(html, /\/turns/)
  assert.match(html, /function\s+renderMessages\s*\(/)
  assert.match(html, /function\s+renderMarkdown\s*\(/)
  assert.match(html, /function\s+setExecutionDetailsOpen\s*\(/)
  assert.match(html, /function\s+submitTurn\s*\(/)
  assert.match(html, /aria-controls=["']executionPane["']/)
  assert.match(html, /@media\s*\(max-width:\s*760px\)/)
  assert.doesNotMatch(
    html,
    /api\(['"]\/api\/runs['"]\s*,\s*\{\s*method:\s*['"]POST['"]/s,
    'ordinary Conversation send path must not create Runs directly from the browser',
  )

  console.log('conversation UI tests passed')
} finally {
  await control.close().catch(() => {})
  await rm(rootDir, { recursive: true, force: true })
}
