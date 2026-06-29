#!/usr/bin/env node
import assert from 'node:assert/strict'
import { ToolExecutionService } from '../dist/tools/tool-execution-service.js'
import { toLegacyToolRunResult } from '../dist/tools/tool-result.js'
import { ToolRegistry } from '../dist/runtime/local/tool-registry.js'

const local = { sessionId: 'tool-execution-service-test', highlight: false, trace: {} }

function makeContext(toolCallId, overrides = {}) {
  const states = []
  const userOnStateChange = overrides.onStateChange
  const context = {
    schemaVersion: 'tool-use-context/v1',
    runId: 'tool-execution-service-test-run',
    sessionId: local.sessionId,
    turnId: 'turn_001',
    step: 1,
    toolCallId,
    local,
    ...overrides,
    onStateChange: (state) => {
      states.push(state)
      userOnStateChange?.(state)
    },
  }
  return { context, states }
}

function statuses(states) {
  return states.map((state) => state.status)
}

function assertTimedResult(result) {
  assert.equal(typeof result.status, 'string')
  assert.equal(typeof result.startedAt, 'string')
  assert.equal(typeof result.completedAt, 'string')
  assert.equal(typeof result.durationMs, 'number')
  assert(result.durationMs >= 0)
  assert.equal(result.state.status, result.status)
  assert.equal(result.state.startedAt, result.startedAt)
  assert.equal(result.state.completedAt, result.completedAt)
  assert.equal(result.state.durationMs, result.durationMs)
}

const successCalls = []
const successRegistry = {
  async run(toolName, args, receivedCtx) {
    successCalls.push({ toolName, args, ctx: receivedCtx })
    return { observation: 'clicked', pageChanged: true, data: { ok: true } }
  },
}
const successService = new ToolExecutionService(successRegistry)
const successArgs = { ref: 'e1' }
const successCtx = makeContext('call-success', {
  metadata: { step: 1, riskLevel: 'L1', category: 'action', argBrief: 'ref=e1' },
})
const success = await successService.execute(
  { id: 'call-success', name: 'browser_click', arguments: successArgs },
  successCtx.context,
)

assert.equal(successCalls.length, 1)
assert.deepEqual(successCalls[0], { toolName: 'browser_click', args: successArgs, ctx: local })
assert.deepEqual(statuses(successCtx.states), ['queued', 'running', 'succeeded'])
assert.equal(success.schemaVersion, 'normalized-tool-result/v1')
assert.equal(success.toolCallId, 'call-success')
assert.equal(success.name, 'browser_click')
assert.equal(success.args, successArgs)
assert.equal(success.ok, true)
assert.equal(success.status, 'succeeded')
assert.equal(success.observation, 'clicked')
assert.equal(success.pageChanged, true)
assert.equal(success.done, false)
assert.deepEqual(success.data, { ok: true })
assert.deepEqual(success.state.metadata, successCtx.context.metadata)
assertTimedResult(success)
assert.deepEqual(toLegacyToolRunResult(success), {
  observation: 'clicked',
  data: { ok: true },
  pageChanged: true,
})

const failedObservationCtx = makeContext('call-failed-observation')
const failedObservation = await new ToolExecutionService({
  async run() {
    return { observation: 'FAILED (CONFIRMATION_REQUIRED): requires confirmed=true', pageChanged: false }
  },
}).execute(
  { id: 'call-failed-observation', name: 'browser_click', arguments: { ref: 'submit' } },
  failedObservationCtx.context,
)
assert.deepEqual(statuses(failedObservationCtx.states), ['queued', 'running', 'failed'])
assert.equal(failedObservation.ok, false)
assert.equal(failedObservation.status, 'failed')
assert.equal(failedObservation.observation, 'FAILED (CONFIRMATION_REQUIRED): requires confirmed=true')
assert.equal(failedObservation.error.kind, 'tool_failed_observation')
assert.equal(failedObservation.error.code, 'CONFIRMATION_REQUIRED')

const unknownCtx = makeContext('call-unknown')
const unknown = await new ToolExecutionService(new ToolRegistry([])).execute(
  { id: 'call-unknown', name: 'missing_tool', arguments: {} },
  unknownCtx.context,
)
assert.deepEqual(statuses(unknownCtx.states), ['queued', 'running', 'failed'])
assert.equal(unknown.ok, false)
assert.equal(unknown.status, 'failed')
assert.equal(unknown.observation, 'Unknown tool: missing_tool')
assert.equal(unknown.error.kind, 'unknown_tool')
assert.equal(unknown.error.code, 'UNKNOWN_TOOL')
assert.equal(unknown.error.fatal, false)

let throwingToolCalls = 0
const throwingRegistry = {
  async run() {
    throwingToolCalls += 1
    throw new Error('registry exploded')
  },
}
const throwingCtx = makeContext('call-throwing')
const throwing = await new ToolExecutionService(throwingRegistry).execute(
  { id: 'call-throwing', name: 'throwing_tool', arguments: {} },
  throwingCtx.context,
)
assert.equal(throwingToolCalls, 1)
assert.deepEqual(statuses(throwingCtx.states), ['queued', 'running', 'failed'])
assert.equal(throwing.ok, false)
assert.equal(throwing.status, 'failed')
assert.equal(throwing.observation, 'FAILED (TOOL_EXCEPTION): Tool throwing_tool threw: registry exploded')
assert.equal(throwing.error.kind, 'registry_exception')
assert.equal(throwing.error.code, 'TOOL_EXCEPTION')
assert.equal(throwing.error.fatal, true)

let abortCalls = 0
const abortController = new AbortController()
abortController.abort('test abort before execution')
const abortCtx = makeContext('call-abort', { abortSignal: abortController.signal })
const abortResult = await new ToolExecutionService({
  async run() {
    abortCalls += 1
    return { observation: 'should not execute' }
  },
}).execute(
  { id: 'call-abort', name: 'abort_marker', arguments: {} },
  abortCtx.context,
)
assert.equal(abortCalls, 0)
assert.deepEqual(statuses(abortCtx.states), ['queued', 'cancelled'])
assert.equal(abortResult.ok, false)
assert.equal(abortResult.status, 'cancelled')
assert.equal(abortResult.observation, 'FAILED (ABORTED): test abort before execution')
assert.equal(abortResult.error.kind, 'aborted')
assert.equal(abortResult.startedAt, undefined)
assert.equal(typeof abortResult.completedAt, 'string')
assert.equal(typeof abortResult.durationMs, 'number')

let timeoutCalls = 0
const timeoutCtx = makeContext('call-timeout', { timeoutMs: 5 })
const timeout = await new ToolExecutionService({
  async run() {
    timeoutCalls += 1
    return await new Promise(() => {})
  },
}).execute(
  { id: 'call-timeout', name: 'slow_tool', arguments: {} },
  timeoutCtx.context,
)
assert.equal(timeoutCalls, 1)
assert.deepEqual(statuses(timeoutCtx.states), ['queued', 'running', 'timed_out'])
assert.equal(timeout.ok, false)
assert.equal(timeout.status, 'timed_out')
assert.equal(timeout.observation, 'FAILED (TOOL_TIMEOUT): Tool slow_tool timed out after 5ms.')
assert.equal(timeout.error.kind, 'timeout')
assert.equal(timeout.error.code, 'TOOL_TIMEOUT')
assertTimedResult(timeout)

console.log('tool-execution-service-test: PASS')
