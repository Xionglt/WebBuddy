#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { createWebControlServer } from '../dist/web/server.js'

const root = await mkdtemp(join(tmpdir(), 'web-buddy-invoice-poc-'))
const control = createWebControlServer({
  controlStoreDir: join(root, 'control'),
  memoryDir: join(root, 'memory'),
  disableExecution: true,
})

await new Promise((resolve, reject) => {
  control.server.once('error', reject)
  control.server.listen(0, '127.0.0.1', resolve)
})
const address = control.server.address()
assert(address && typeof address === 'object')
const baseUrl = `http://127.0.0.1:${address.port}`

const browser = await chromium.launch({ headless: true })
try {
  for (const path of ['/poc/invoice-portal', '/poc/invoice-portal/']) {
    const response = await fetch(`${baseUrl}${path}`)
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type') || '', /^text\/html/)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.match(await response.text(), /接手 · 客户门户代办箱/)
  }

  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  await page.goto(`${baseUrl}/poc/invoice-portal`, { waitUntil: 'domcontentloaded' })

  await assertText(page, 'h1', '6 项回款资料，4 项可以直接提交')
  await assertText(page, '.browser-name', '华东智造 · 财务共享门户')
  await assertState(page, (state) => {
    assert.equal(state.committedSubmissions, 0)
    assert.equal(state.receiptCount, 0)
    assert.equal(state.invoiceStatuses['INV-CN-260598'], 'duplicate')
    assert.equal(state.invoiceStatuses['INV-CN-260605'], 'exception')
  })

  if (process.env.POC_INITIAL_SCREENSHOT) {
    await page.screenshot({ path: process.env.POC_INITIAL_SCREENSHOT, fullPage: true })
  }
  if (process.env.POC_MOBILE_SCREENSHOT) {
    const mobilePage = await browser.newPage({ viewport: { width: 390, height: 844 } })
    await mobilePage.goto(`${baseUrl}/poc/invoice-portal`, { waitUntil: 'domcontentloaded' })
    await mobilePage.screenshot({ path: process.env.POC_MOBILE_SCREENSHOT, fullPage: true })
    await mobilePage.close()
  }

  await page.getByRole('button', { name: '开始准备这 4 项' }).click()
  await page.waitForFunction(() => window.__INVOICE_POC_STATE__?.awaitingInput === true)
  await assertText(page, '#attentionCard', '缺少服务期间')
  await assertState(page, (state) => {
    assert.equal(state.committedSubmissions, 0)
    assert.equal(state.awaitingInput, true)
  })

  await page.getByLabel('选择服务期间').selectOption('2026年第二季度')
  await page.getByRole('button', { name: '补充并继续' }).click()
  await page.locator('#approvalModal').waitFor({ state: 'visible', timeout: 15_000 })
  await assertText(page, '#approvalModal', '任何字段变化都会重新请求批准')
  await assertState(page, (state) => {
    assert.equal(state.committedSubmissions, 0)
    assert.equal(state.approved, false)
    assert.equal(Object.values(state.invoiceStatuses).filter((status) => status === 'ready').length, 4)
  })

  await page.getByRole('button', { name: '批准并提交 4 张' }).click()
  await page.waitForFunction(() => window.__INVOICE_POC_STATE__?.committedSubmissions === 4)
  await page.locator('#receiptModal').waitFor({ state: 'visible' })
  await assertText(page, '#receiptModal', '4 张发票已被门户接受')
  await assertState(page, (state) => {
    assert.equal(state.receiptCount, 4)
    assert.equal(state.committedSubmissions, 4)
    assert.equal(state.invoiceStatuses['INV-CN-260598'], 'duplicate')
    assert.equal(state.invoiceStatuses['INV-CN-260605'], 'exception')
  })

  const screenshotPath = process.env.POC_SCREENSHOT
  if (screenshotPath) await page.screenshot({ path: screenshotPath, fullPage: true })

  await page.getByRole('button', { name: '生成待审核门户 Recipe' }).click()
  await assertText(page, '#toast', '已生成待审核 Recipe')
  console.log('invoice-portal-poc-test: passed')
} finally {
  await browser.close()
  await control.close()
  await rm(root, { recursive: true, force: true })
}

async function assertState(page, assertion) {
  const state = await page.evaluate(() => window.__INVOICE_POC_STATE__)
  assertion(state)
}

async function assertText(root, selector, expected) {
  const text = (await root.locator(selector).textContent())?.replace(/\s+/g, '') || ''
  assert(
    text.includes(expected.replace(/\s+/g, '')),
    `Expected ${selector} to contain "${expected}", got "${text}"`,
  )
}
