import assert from 'node:assert/strict'
import { ToolExecutionBoundary } from '../dist/tools/tool-execution.js'
import { ToolRegistry } from '../dist/runtime/local/tool-registry.js'

const ctx = { sessionId: 'tool-execution-test', highlight: false, trace: {} }

const calls = []
const successRegistry = {
  async run(toolName, args, receivedCtx) {
    calls.push({ toolName, args, ctx: receivedCtx })
    return { observation: 'clicked', pageChanged: true, data: { ok: true } }
  },
}

const boundary = new ToolExecutionBoundary(successRegistry)
const args = { ref: 'e1' }
const metadata = { step: 3, riskLevel: 'L3', category: 'action', argBrief: 'ref=e1' }
const success = await boundary.execute({ toolName: 'browser_click', args, ctx, metadata })

assert.equal(calls.length, 1)
assert.deepEqual(calls[0], { toolName: 'browser_click', args, ctx })
assert.equal(success.toolName, 'browser_click')
assert.equal(success.args, args)
assert.deepEqual(success.metadata, metadata)
assert.deepEqual(success.result, { observation: 'clicked', pageChanged: true, data: { ok: true } })

const failedRegistry = {
  async run() {
    return { observation: 'FAILED (CONFIRMATION_REQUIRED): requires confirmed=true', pageChanged: false }
  },
}
const failed = await new ToolExecutionBoundary(failedRegistry).execute({ toolName: 'browser_click', args, ctx })
assert.equal(failed.result.observation, 'FAILED (CONFIRMATION_REQUIRED): requires confirmed=true')
assert.equal(failed.result.pageChanged, false)

const unknown = await new ToolExecutionBoundary(new ToolRegistry([])).execute({ toolName: 'missing_tool', args: {}, ctx })
assert.equal(unknown.result.observation, 'Unknown tool: missing_tool')

const throwingRegistry = {
  async run() {
    throw new Error('registry exploded')
  },
}
await assert.rejects(
  () => new ToolExecutionBoundary(throwingRegistry).execute({ toolName: 'boom', args: {}, ctx }),
  /registry exploded/,
)

console.log('tool-execution-test: PASS')
