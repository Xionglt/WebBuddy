#!/usr/bin/env node
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium } from 'playwright'
import { inspectDirectSubmitReviewPage } from '../dist/workflow/direct-submit.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixtureDir = join(__dirname, 'fixtures', 'direct-submit-flow')
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage()

try {
  await page.goto(fixtureUrl('direct-submit-review.html'))
  const direct = await inspectDirectSubmitReviewPage(page)
  assert.equal(direct.detected, true)
  assert.equal(direct.nextStep, 'final_submit')
  assert.equal(direct.signals.loginWall, false)
  assert.equal(direct.signals.realFillableFieldCount, 0)
  assert.equal(direct.signals.agreementCheckboxCount, 1)
  assert.equal(direct.signals.submitApplyButtonCount, 1)
  assert.match(direct.userMessage ?? '', /在线简历\/直接投递模式/)
  assert.match(direct.userMessage ?? '', /没有可填写/)
  assert.match(direct.userMessage ?? '', /final_submit/)

  await page.goto(fixtureUrl('ordinary-form-submit.html'))
  const ordinary = await inspectDirectSubmitReviewPage(page)
  assert.equal(ordinary.detected, false)
  assert(ordinary.signals.realFillableFieldCount >= 3)
  assert.match(ordinary.reason, /fillable application fields/i)

  await page.goto(fixtureUrl('login-wall.html'))
  const login = await inspectDirectSubmitReviewPage(page)
  assert.equal(login.detected, false)
  assert.equal(login.signals.loginWall, true)
  assert.match(login.reason, /login wall/i)

  console.log('direct-submit-flow-test: PASS')
} finally {
  await browser.close()
}

function fixtureUrl(name) {
  return pathToFileURL(join(fixtureDir, name)).toString()
}
