import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { browserInspectOptions } from '../dist/browser/inspect-options.js'
import { browserOpen } from '../dist/browser/open.js'
import { sessionManager } from '../dist/session/manager.js'

process.env.PLAYWRIGHT_HEADLESS = 'true'
process.env.PLAYWRIGHT_ALLOW_DATA_URLS = 'true'

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixturePath = join(__dirname, 'fixtures/form-observation/form-controls.html')
const html = readFileSync(fixturePath, 'utf8')

async function main() {
  const open = await browserOpen({ url: `data:text/html,${encodeURIComponent(html)}` })
  if (!open.ok) throw new Error(open.error.message)

  const city = await browserInspectOptions({ label: '城市' })
  if (!city.ok) throw new Error(city.error.message)
  assert.equal(city.data.multiLevel, false)
  assert.deepEqual(
    city.data.options.map((option) => option.label),
    ['杭州', '上海', '北京'],
  )
  assert(city.data.options.some((option) => option.value === 'hangzhou'))

  const cascader = await browserInspectOptions({ label: '地区' })
  if (!cascader.ok) throw new Error(cascader.error.message)
  assert.equal(cascader.data.multiLevel, true)
  assert(cascader.data.options.some((option) => option.label === '浙江' && option.level === 0))
  assert(cascader.data.options.some((option) => option.label === '杭州' && option.level === 1))

  console.log('inspect-options-test: PASS')
}

main().catch(async (error) => {
  console.error('inspect-options-test: FAIL')
  console.error(error)
  process.exitCode = 1
}).finally(async () => {
  await sessionManager.closeAll()
})
