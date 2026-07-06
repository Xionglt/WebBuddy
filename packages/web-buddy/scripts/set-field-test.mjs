#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { browserFormSnapshot } from '../dist/browser/form-snapshot.js'
import { browserOpen } from '../dist/browser/open.js'
import { browserSetField } from '../dist/browser/set-field.js'
import { sessionManager } from '../dist/session/manager.js'

process.env.PLAYWRIGHT_HEADLESS = 'true'
process.env.PLAYWRIGHT_ALLOW_DATA_URLS = 'true'
process.env.PLAYWRIGHT_ACTION_TIMEOUT_MS = '1000'

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixturePath = join(__dirname, 'fixtures/set-field/set-field-form.html')
const html = readFileSync(fixturePath, 'utf8')
const sessionId = 'set-field-test'

try {
  const open = await browserOpen({
    sessionId,
    url: `data:text/html;charset=utf-8,${encodeURIComponent(html)}`,
    waitUntil: 'domcontentloaded',
  })
  assert.equal(open.ok, true, open.observation)

  const snapshot = await browserFormSnapshot({ sessionId })
  assert.equal(snapshot.ok, true, snapshot.observation)
  assert(snapshot.data.fields.some((field) => field.controlKind === 'select_custom'), 'fixture should expose custom select')
  assert(snapshot.data.fields.some((field) => field.controlKind === 'cascader'), 'fixture should expose cascader')

  await assertSet(
    {
      label: '受控姓名',
      controlKind: 'text',
      intendedValue: '李四',
      sessionId,
    },
    '李四',
  )

  await assertSet(
    {
      label: '个人简介',
      controlKind: 'textarea',
      intendedValue: '喜欢构建可靠的自动化系统',
      sessionId,
    },
    '喜欢构建可靠的自动化系统',
  )

  await assertSet(
    {
      label: '学历',
      controlKind: 'select_native',
      intendedValue: '硕士',
      sessionId,
    },
    '硕士',
  )

  await assertSet(
    {
      label: '城市',
      controlKind: 'select_custom',
      intendedValue: '上海',
      sessionId,
    },
    '上海',
  )

  await assertSet(
    {
      label: '地区',
      controlKind: 'cascader',
      intendedValue: ['浙江', '杭州'],
      sessionId,
    },
    '浙江 / 杭州',
  )

  await assertSet(
    {
      label: '入职日期',
      controlKind: 'date',
      intendedValue: '2026-07-03',
      sessionId,
    },
    '2026-07-03',
  )

  await assertSet(
    {
      label: '工作方式',
      controlKind: 'radio',
      intendedValue: '远程',
      sessionId,
    },
    '远程',
  )

  await assertSet(
    {
      label: '我同意协议',
      controlKind: 'checkbox',
      intendedValue: true,
      sessionId,
    },
    true,
  )

  const rejectedFile = await browserSetField({
    label: '简历文件',
    controlKind: 'file',
    intendedValue: '/tmp/resume.pdf',
    sessionId,
  })
  assert.equal(rejectedFile.ok, false)
  assert.equal(rejectedFile.error.code, 'INVALID_ARGUMENT')
  assert.match(rejectedFile.error.message, /browser_upload_file/)

  const page = sessionManager.get(sessionId).page
  const state = await page.evaluate(() => ({
    name: document.getElementById('controlled-name').value,
    bio: document.getElementById('bio').value,
    education: document.getElementById('education').selectedOptions[0].textContent.trim(),
    city: document.getElementById('city-select').textContent.trim(),
    region: document.getElementById('region-cascader').textContent.trim(),
    date: document.getElementById('start-date').value,
    workMode: document.querySelector('input[name="workMode"]:checked')?.closest('label')?.textContent.trim(),
    agreement: document.getElementById('agreement').checked,
  }))
  assert.deepEqual(state, {
    name: '李四',
    bio: '喜欢构建可靠的自动化系统',
    education: '硕士',
    city: '上海',
    region: '浙江 / 杭州',
    date: '2026-07-03',
    workMode: '远程',
    agreement: true,
  })

  console.log('set-field-test: PASS')
} finally {
  await sessionManager.closeAll().catch(() => {})
}

async function assertSet(input, expected) {
  const result = await browserSetField(input)
  assert.equal(result.ok, true, result.observation)
  if (typeof expected === 'boolean') {
    assert.equal(result.data.readback.value, expected)
  } else {
    assert.match(String(result.data.readback.value), new RegExp(escapeRegExp(expected)))
  }
  assert(result.data.attempts.some((attempt) => attempt.ok), 'set-field should have a verified attempt')
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
