import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { browserFormAudit } from '../dist/browser/form-audit.js'
import { browserFormSnapshot } from '../dist/browser/form-snapshot.js'
import { browserOpen } from '../dist/browser/open.js'
import { observationManager } from '../dist/observation/observation-manager.js'
import { sessionManager } from '../dist/session/manager.js'

process.env.PLAYWRIGHT_HEADLESS = 'true'
process.env.PLAYWRIGHT_ALLOW_DATA_URLS = 'true'

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixturePath = join(__dirname, 'fixtures/form-observation/form-controls.html')
const html = readFileSync(fixturePath, 'utf8')

async function main() {
  const open = await browserOpen({ url: `data:text/html,${encodeURIComponent(html)}` })
  if (!open.ok) throw new Error(open.error.message)

  const firstScreen = await browserFormSnapshot({ maxFields: 40 })
  if (!firstScreen.ok) throw new Error(firstScreen.error.message)
  assert(!firstScreen.data.fields.some((field) => field.label.includes('作品链接')), 'plain snapshot should not see below-fold field')

  const audit = await browserFormAudit({ maxFields: 80, waitMs: 40 })
  if (!audit.ok) throw new Error(audit.error.message)

  assert.equal(audit.data.formCoverage.schemaVersion, 'form-coverage/v1')
  assert.equal(audit.data.formCoverage.scrolledTop, true)
  assert.equal(audit.data.formCoverage.scrolledBottom, true)
  assert(audit.data.formCoverage.segments >= 2, 'expected multi-segment audit')
  assert(audit.data.formCoverage.totalFieldsSeen >= 6, 'expected merged fields from top and bottom')

  const fields = audit.data.fields
  const byLabel = (text) => fields.find((field) => field.label.includes(text))
  const city = byLabel('城市')
  const cascader = byLabel('地区')
  const agreement = byLabel('协议')
  const portfolio = byLabel('作品链接')
  const source = byLabel('信息来源')

  assert(city, 'expected Ant Select city field')
  assert.equal(city.controlKind, 'select_custom')
  assert.equal(city.required, true)
  assert(city.requiredConfidence >= 0.9)
  assert(city.fieldKey)
  assert(city.locatorHints?.css)

  assert(cascader, 'expected cascader field')
  assert.equal(cascader.controlKind, 'cascader')

  assert(agreement, 'expected checked agreement field')
  assert.equal(agreement.controlKind, 'checkbox')
  assert.equal(agreement.checked, true)
  assert.equal(agreement.filled, true)

  assert(portfolio, 'expected below-fold required field')
  assert.equal(portfolio.required, true)
  assert(portfolio.requiredConfidence >= 0.9)
  assert.equal(portfolio.filled, false)
  assert.equal(portfolio.invalid, true)
  assert.match(portfolio.error, /不能为空/)

  assert(source, 'expected below-fold native select')
  assert.equal(source.controlKind, 'select_native')
  assert.equal(source.filled, true)
  assert(source.options.some((option) => option.label === '朋友推荐' && option.selected))

  const formState = observationManager.getFormState('default')
  assert(formState, 'expected observation manager form state')
  assert.equal(formState.formCoverage.scrolledBottom, true)
  assert(formState.missingRequired.some((field) => field.label.includes('作品链接')))
  assert(formState.filledFields.some((field) => field.label.includes('协议')))

  console.log('form-audit-test: PASS')
}

main().catch(async (error) => {
  console.error('form-audit-test: FAIL')
  console.error(error)
  process.exitCode = 1
}).finally(async () => {
  await sessionManager.closeAll()
})
