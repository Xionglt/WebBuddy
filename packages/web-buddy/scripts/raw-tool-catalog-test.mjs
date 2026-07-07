import assert from 'node:assert/strict'
import { toolsForSafetyMode, RAW_MODE_EXCLUDED_TOOLS } from '../dist/runtime/local/agent-loop.js'
import { ToolRegistry } from '../dist/runtime/local/tool-registry.js'

const registry = new ToolRegistry()
const guardedTools = toolsForSafetyMode(registry, 'guarded').map((tool) => tool.function.name)
const rawTools = toolsForSafetyMode(registry, 'raw').map((tool) => tool.function.name)

for (const name of RAW_MODE_EXCLUDED_TOOLS) {
  assert(guardedTools.includes(name), `guarded mode should keep ${name}`)
  assert(!rawTools.includes(name), `raw mode must not expose structured helper ${name}`)
}

for (const name of [
  'browser_open',
  'browser_snapshot',
  'browser_click',
  'browser_click_text',
  'browser_form_snapshot',
  'browser_form_audit',
  'browser_fill_by_label',
  'browser_type',
  'browser_press_key',
  'browser_select',
  'browser_select_by_text',
  'browser_wait',
  'browser_screenshot',
  'resume_query',
  'ask_user',
  'browser_upload_file',
  'agent_done',
]) {
  assert(rawTools.includes(name), `raw mode should keep generic tool ${name}`)
}

assert(rawTools.length < guardedTools.length, 'raw mode should expose a smaller free-browsing tool surface')

console.log('raw-tool-catalog-test: PASS')
