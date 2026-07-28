#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { createWebControlServer } from '../dist/web/server.js'

const rootDir = await mkdtemp(join(tmpdir(), 'web-buddy-conversation-workspace-ui-'))
const control = createWebControlServer({ controlStoreDir: rootDir, disableExecution: true })
let browser

try {
  await new Promise((resolve, reject) => {
    control.server.once('error', reject)
    control.server.listen(0, '127.0.0.1', resolve)
  })
  const address = control.server.address()
  assert(address && typeof address === 'object')

  browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  await page.goto(`http://127.0.0.1:${address.port}/`, { waitUntil: 'domcontentloaded' })

  const markdown = await page.evaluate(() => {
    window.__markdownScriptExecuted = false
    window.__markdownEventExecuted = false
    const fixture = document.createElement('section')
    fixture.id = 'markdownFixture'
    document.body.appendChild(fixture)
    renderMarkdown(fixture, [
      '# 结果',
      '',
      '- 第一项',
      '- 第二项',
      '',
      '1. 第一步',
      '2. 第二步',
      '',
      '> 引用内容',
      '',
      '*斜体* 和 `行内代码`',
      '',
      '```js',
      'const safe = true',
      '```',
      '',
      '| 名称 | 值 |',
      '| --- | --- |',
      '| 安全 | 是 |',
      '',
      '[安全链接](https://example.com)',
      '[相对链接](./local)',
      '',
      '<script>window.__markdownScriptExecuted = true</script>',
      '<img src="missing" onerror="window.__markdownEventExecuted = true">',
      '[危险链接](javascript:window.__markdownScriptExecuted=true)',
    ].join('\n'))
    const link = fixture.querySelector('a')
    const result = {
      heading: fixture.querySelector('h1')?.textContent,
      unorderedItems: fixture.querySelectorAll('ul li').length,
      orderedItems: fixture.querySelectorAll('ol li').length,
      quote: fixture.querySelector('blockquote')?.textContent,
      emphasis: fixture.querySelector('em')?.textContent,
      inlineCode: fixture.querySelector('p code')?.textContent,
      code: fixture.querySelector('pre code')?.textContent,
      tableCells: fixture.querySelectorAll('th, td').length,
      safeLink: link ? { href: link.href, target: link.target, rel: link.rel } : null,
      rawHtmlNodeCount: fixture.querySelectorAll('script, img').length,
      rawHtmlVisible: fixture.textContent.includes('<script>') && fixture.textContent.includes('<img'),
      scriptExecuted: window.__markdownScriptExecuted,
      eventExecuted: window.__markdownEventExecuted,
      unsafeLinkCount: fixture.querySelectorAll('a[href^="javascript:"]').length,
      linkCount: fixture.querySelectorAll('a').length,
      bodyHeightBeforeCleanup: document.documentElement.scrollHeight,
    }
    fixture.remove()
    result.bodyHeightAfterCleanup = document.documentElement.scrollHeight
    return result
  })

  assert.equal(markdown.heading, '结果')
  assert.equal(markdown.unorderedItems, 2)
  assert.equal(markdown.orderedItems, 2)
  assert.equal(markdown.quote, '引用内容')
  assert.equal(markdown.emphasis, '斜体')
  assert.equal(markdown.inlineCode, '行内代码')
  assert.equal(markdown.code, 'const safe = true')
  assert.equal(markdown.tableCells, 4)
  assert.deepEqual(markdown.safeLink, {
    href: 'https://example.com/',
    target: '_blank',
    rel: 'noopener noreferrer',
  })
  assert.equal(markdown.rawHtmlNodeCount, 0)
  assert.equal(markdown.rawHtmlVisible, true)
  assert.equal(markdown.scriptExecuted, false)
  assert.equal(markdown.eventExecuted, false)
  assert.equal(markdown.unsafeLinkCount, 0)
  assert.equal(markdown.linkCount, 1)
  assert(markdown.bodyHeightAfterCleanup < markdown.bodyHeightBeforeCleanup)

  await seedConversation(page, 40)
  const messageMarkdown = await page.evaluate(() => ({
    userHeading: document.querySelector('.message.user h2')?.textContent,
    agentStrong: document.querySelector('.message.agent strong')?.textContent,
  }))
  assert.equal(messageMarkdown.userHeading, '用户标题 1')
  assert.equal(messageMarkdown.agentStrong, 'Agent 结果 1')

  const scrollBehavior = await page.evaluate(() => {
    const scroller = document.getElementById('conversationScroller')
    scroller.style.overflowAnchor = 'none'
    const originalScrollConversationToBottom = scrollConversationToBottom
    let scrollCalls = 0
    scrollConversationToBottom = () => { scrollCalls += 1 }
    const appendTurn = (sequence) => {
      const next = {
        ...activeConversation,
        revision: activeConversation.revision + 1,
        turns: [...activeConversation.turns, {
          turnId: `turn-${sequence}`,
          sequence,
          userMessage: `## 新消息 ${sequence}\n\n保持阅读位置。`,
          createdAt: new Date(1700000000000 + sequence * 1000).toISOString(),
          run: {
            runId: `run-${sequence}`,
            revision: 1,
            attempt: 1,
            state: 'completed',
            summary: `**新结果 ${sequence}**`,
            artifacts: [],
          },
        }],
      }
      showConversation(next)
    }
    scroller.scrollTop = 0
    appendTurn(41)
    const preservedTop = scroller.scrollTop
    const callsAtTop = scrollCalls
    scroller.scrollTop = scroller.scrollHeight
    appendTurn(42)
    const callsAtBottom = scrollCalls
    scrollConversationToBottom = originalScrollConversationToBottom
    scrollConversationToBottom()
    return {
      preservedTop,
      distanceFromBottom: scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight,
      callsAtTop,
      callsAtBottom,
    }
  })
  assert(scrollBehavior.preservedTop <= 1, 'reading older messages should not be interrupted')
  assert.equal(scrollBehavior.callsAtTop, 0)
  assert.equal(scrollBehavior.callsAtBottom, 1)
  assert(scrollBehavior.distanceFromBottom <= 1, 'a reader already at the bottom should follow new messages')

  const layout = await page.evaluate(() => {
    const rect = (selector) => {
      const value = document.querySelector(selector).getBoundingClientRect()
      return { x: value.x, y: value.y, width: value.width, height: value.height }
    }
    const selectors = ['.appbar', '.history-pane', '#conversationHeader', '#conversationComposer', '#executionPane']
    const before = Object.fromEntries(selectors.map((selector) => [selector, rect(selector)]))
    const scroller = document.getElementById('conversationScroller')
    scroller.scrollTop = 640
    const after = Object.fromEntries(selectors.map((selector) => [selector, rect(selector)]))
    return {
      before,
      after,
      scrollTop: scroller.scrollTop,
      bodyScrollHeight: document.documentElement.scrollHeight,
      viewportHeight: window.innerHeight,
      overflowing: Array.from(document.querySelectorAll('body *'))
        .map((element) => ({
          selector: element.id ? `#${element.id}` : element.className ? `.${String(element.className).trim().replace(/\s+/g, '.')}` : element.tagName,
          bottom: Math.round(element.getBoundingClientRect().bottom),
          scrollHeight: element.scrollHeight,
          clientHeight: element.clientHeight,
        }))
        .filter((item) => item.bottom > window.innerHeight + 1)
        .slice(0, 12),
    }
  })
  assert(layout.scrollTop > 0, 'the conversation region should scroll')
  for (const selector of Object.keys(layout.before)) {
    assertRectStable(layout.before[selector], layout.after[selector], selector)
  }
  assert(
    layout.bodyScrollHeight <= layout.viewportHeight + 1,
    `desktop document should not scroll: ${layout.bodyScrollHeight}/${layout.viewportHeight} ${JSON.stringify(layout.overflowing)}`,
  )

  const independent = await page.evaluate(() => {
    const list = document.getElementById('conversationList')
    list.replaceChildren(...Array.from({ length: 80 }, (_, index) => {
      const row = document.createElement('button')
      row.className = 'run-row'
      row.textContent = `对话 ${index + 1}`
      return row
    }))
    const spans = document.getElementById('spans')
    spans.replaceChildren(...Array.from({ length: 80 }, (_, index) => {
      const row = document.createElement('div')
      row.className = 'span-row'
      row.textContent = `span ${index + 1}`
      return row
    }))
    const messages = document.getElementById('conversationScroller')
    const execution = document.getElementById('executionPane')
    messages.scrollTop = 320
    const messageBefore = messages.scrollTop
    list.scrollTop = 220
    const messageAfterLeft = messages.scrollTop
    execution.scrollTop = 220
    return {
      listScrollTop: list.scrollTop,
      executionScrollTop: execution.scrollTop,
      messageBefore,
      messageAfterLeft,
    }
  })
  assert(independent.listScrollTop > 0, 'the Chat overview should scroll independently')
  assert(independent.executionScrollTop > 0, 'execution details should scroll independently')
  assert.equal(independent.messageAfterLeft, independent.messageBefore)

  assert.equal(await page.locator('#executionDetailsToggle').getAttribute('aria-expanded'), 'true')
  await page.locator('#executionDetailsToggle').click()
  assert.equal(await page.locator('#executionDetailsToggle').getAttribute('aria-expanded'), 'false')
  assert.equal(await page.locator('#executionPane').isHidden(), true)
  await page.locator('#executionDetailsToggle').click()
  assert.equal(await page.locator('#executionPane').isVisible(), true)

  await page.setViewportSize({ width: 1000, height: 900 })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await seedConversation(page, 2)
  assert.equal(await page.locator('#executionDetailsToggle').getAttribute('aria-expanded'), 'false')
  await page.locator('#executionDetailsToggle').click()
  assert.equal(await page.locator('#executionPane').isVisible(), true)

  await page.setViewportSize({ width: 760, height: 900 })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await seedConversation(page, 20)
  const mobile = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    clientHeight: document.documentElement.clientHeight,
    scrollHeight: document.documentElement.scrollHeight,
    bodyOverflow: getComputedStyle(document.body).overflow,
  }))
  assert(mobile.scrollWidth <= mobile.clientWidth, '760px layout should not overflow horizontally')
  assert(mobile.scrollHeight > mobile.clientHeight, 'mobile layout should retain document scrolling')
  assert.notEqual(mobile.bodyOverflow, 'hidden')

  console.log('conversation workspace UI tests passed')
} finally {
  await browser?.close().catch(() => {})
  await control.close().catch(() => {})
  await rm(rootDir, { recursive: true, force: true })
}

async function seedConversation(page, turnCount) {
  await page.evaluate((count) => {
    connected = true
    const turns = Array.from({ length: count }, (_, index) => ({
      turnId: `turn-${index + 1}`,
      sequence: index + 1,
      userMessage: `## 用户标题 ${index + 1}\n\n- 条件 A\n- 条件 B\n\n这是一段用于验证滚动区域的较长消息。`,
      createdAt: new Date(1700000000000 + index * 1000).toISOString(),
      run: {
        runId: `run-${index + 1}`,
        revision: 1,
        attempt: 1,
        state: 'completed',
        summary: `**Agent 结果 ${index + 1}**\n\n> 已完成本轮任务。\n\n\`inline\``,
        artifacts: [],
      },
    }))
    showConversation({
      conversationId: 'conversation-layout-test',
      goal: '验证 Codex 式对话工作台',
      startUrl: 'https://example.test/',
      revision: count,
      turns,
    })
  }, turnCount)
}

function assertRectStable(before, after, selector) {
  for (const key of ['x', 'y', 'width', 'height']) {
    assert(Math.abs(before[key] - after[key]) <= 1, `${selector} ${key} moved while messages scrolled`)
  }
}
