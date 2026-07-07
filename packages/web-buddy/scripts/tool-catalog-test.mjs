import assert from 'node:assert/strict'
import { TOOL_DEFINITIONS, getToolCategory, listLocalToolDefs, listMcpToolDefs, listToolDefs } from '../dist/tools/index.js'
import { createLocalTools } from '../dist/tools/local-adapter.js'

const all = listToolDefs()
const local = listLocalToolDefs()
const mcp = listMcpToolDefs()
const localRuntimeTools = createLocalTools()

assert(all.length >= 12, 'catalog should include browser tools plus agent_done')
assert.equal(new Set(all.map((tool) => tool.name)).size, all.length, 'catalog tool names must be unique')

for (const tool of all) {
  assert(tool.name, 'tool needs a name')
  assert(tool.description, `${tool.name} needs a description`)
  assert(['observation', 'action', 'human', 'eval'].includes(tool.category), `${tool.name} needs a valid category`)
  assert(['L0', 'L1', 'L2', 'L3', 'L4'].includes(tool.risk), `${tool.name} needs a valid risk`)
  assert.equal(typeof tool.local.enabled, 'boolean', `${tool.name} needs local.enabled`)
  assert.equal(typeof tool.mcp.enabled, 'boolean', `${tool.name} needs mcp.enabled`)
  assert.equal(tool.parameters?.type, 'object', `${tool.name} needs object parameters`)
}

const requiredLocal = [
  'browser_open',
  'browser_snapshot',
  'browser_form_snapshot',
  'browser_form_audit',
  'browser_inspect_options',
  'plan_form_fill',
  'browser_click',
  'browser_click_text',
  'browser_type',
  'browser_fill_by_label',
  'browser_select',
  'browser_select_by_text',
  'browser_set_field',
  'browser_wait',
  'browser_press_key',
  'browser_screenshot',
  'agent_done',
]

for (const name of requiredLocal) {
  assert(local.some((tool) => tool.name === name), `local catalog missing ${name}`)
  assert(localRuntimeTools.some((tool) => tool.name === name), `local adapter missing ${name}`)
}

assertLocalParams('browser_click', ['ref', 'timeoutMs', 'confirmed', 'highlight'])
assertLocalParams('browser_click_text', ['text', 'exact', 'nth', 'timeoutMs', 'confirmed', 'highlight'])
assertLocalParams('browser_type', ['ref', 'text', 'clear', 'timeoutMs', 'highlight', 'typeDelayMs'])
assertLocalParams('browser_press_key', ['key', 'ref', 'timeoutMs', 'highlight'])
assertLocalParams('browser_screenshot', ['label', 'outDir', 'fullPage', 'timeoutMs'])
assertLocalParams('browser_open', ['url', 'waitUntil'])
assertLocalParams('browser_wait', ['for', 'value', 'ms', 'timeoutMs'])
assertLocalParams('browser_select', ['ref', 'value', 'timeoutMs'])
assertLocalParams('browser_fill_by_label', ['label', 'text', 'exact', 'nth', 'clear', 'timeoutMs'])
assertLocalParams('browser_select_by_text', ['option', 'label', 'ref', 'exact', 'nth', 'optionNth', 'timeoutMs'])
assertLocalParams('browser_set_field', ['field', 'intendedValue', 'controlKind', 'label', 'ref', 'selector', 'fieldKey', 'fieldIndex', 'exact', 'nth', 'optionNth', 'clear', 'timeoutMs'])
assertLocalParams('browser_form_audit', ['maxFields', 'waitMs'])
assertLocalParams('browser_inspect_options', ['ref', 'label', 'exact', 'nth', 'maxOptions', 'open'])
assertLocalParams('plan_form_fill', ['refresh'])

const mcpNames = TOOL_DEFINITIONS.map((tool) => tool.name)
for (const name of [
  'browser_open',
  'browser_snapshot',
  'browser_click',
  'browser_click_text',
  'browser_form_snapshot',
  'browser_form_audit',
  'browser_inspect_options',
  'browser_upload_file',
  'browser_fill_by_label',
  'browser_select_by_text',
  'browser_set_field',
  'browser_type',
  'browser_press_key',
  'browser_select',
  'browser_wait',
  'browser_screenshot',
]) {
  assert(mcpNames.includes(name), `MCP definitions missing ${name}`)
}

assert(!mcpNames.includes('agent_done'), 'agent_done is local-only')
assert.equal(mcp.length, TOOL_DEFINITIONS.length, 'MCP adapter should project every MCP-enabled catalog tool')
assert.equal(getToolCategory('browser_snapshot'), 'observation')
assert.equal(getToolCategory('browser_form_audit'), 'observation')
assert.equal(getToolCategory('browser_inspect_options'), 'observation')
assert.equal(getToolCategory('browser_click'), 'action')
assert.equal(getToolCategory('agent_done'), 'human')

assertToolRisk('browser_form_snapshot', 'L0')
assertToolRisk('browser_form_audit', 'L0')
assertToolRisk('browser_inspect_options', 'L0')
assertToolRisk('plan_form_fill', 'L0')
assertToolRisk('browser_set_field', 'L2')
assertToolRisk('browser_press_key', 'L2')

console.log('tool-catalog-test: PASS')

function assertLocalParams(name, params) {
  const tool = localRuntimeTools.find((item) => item.name === name)
  assert(tool, `local adapter missing ${name}`)
  const properties = tool.parameters?.properties || {}
  assert(!Object.hasOwn(properties, 'sessionId'), `${name} local schema should not expose sessionId`)
  for (const param of params) {
    assert(Object.hasOwn(properties, param), `${name} local schema missing ${param}`)
  }
}

function assertToolRisk(name, risk) {
  const tool = all.find((item) => item.name === name)
  assert(tool, `catalog missing ${name}`)
  assert.equal(tool.risk, risk, `${name} should be ${risk}`)
}
