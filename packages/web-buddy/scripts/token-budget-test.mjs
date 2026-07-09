#!/usr/bin/env node
import assert from 'node:assert/strict'
import {
  DEFAULT_MAX_INPUT_TOKENS,
  TokenBudget,
  createTokenBudgetSnapshot,
  estimateChatMessages,
  estimateTokenBudget,
  estimateTokens,
  estimateToolObservationTokens,
} from '../dist/kernel/token-budget.js'

assert.equal(estimateTokens(''), 0)
assert.equal(estimateTokens('abcd'), 1)
assert.equal(estimateTokens('abcde'), 2)

const inputBudget = new TokenBudget()
inputBudget.recordInputText('abcd')
inputBudget.recordInputText('abcde')
assert.deepEqual(inputBudget.snapshot(), {
  version: 1,
  maxInputTokens: DEFAULT_MAX_INPUT_TOKENS,
  compactThresholdRatio: 0.8,
  compactThresholdTokens: Math.ceil(DEFAULT_MAX_INPUT_TOKENS * 0.8),
  estimatedInputTokens: 3,
  estimatedToolResultTokens: 0,
  estimatedTotalTokens: 3,
  compactRecommended: false,
  usingDefaultMaxInputTokens: true,
  warnings: [
    `No model context window configured; using conservative default ${DEFAULT_MAX_INPUT_TOKENS} input tokens.`,
  ],
})

const toolBudget = new TokenBudget()
toolBudget.recordToolResultText('abcdefgh')
toolBudget.recordToolObservation({ observation: 'abcd' })
assert.equal(toolBudget.snapshot().estimatedInputTokens, 0)
assert.equal(toolBudget.snapshot().estimatedToolResultTokens, 8)
assert.equal(toolBudget.snapshot().estimatedTotalTokens, 8)

const messages = [
  { role: 'system', content: 'system context' },
  { role: 'user', content: 'find the submit button' },
  {
    role: 'assistant',
    content: '',
    tool_calls: [
      {
        id: 'call_1',
        type: 'function',
        function: { name: 'browser_snapshot', arguments: '{"includeText":true}' },
      },
    ],
  },
  {
    role: 'tool',
    tool_call_id: 'call_1',
    name: 'browser_snapshot',
    content: 'A'.repeat(80),
  },
]

const chatEstimate = estimateChatMessages(messages)
assert(chatEstimate.inputTokens > 0, 'system/user/assistant messages should count as input tokens')
assert(chatEstimate.toolResultTokens > 0, 'tool messages should count as tool result tokens')
assert.equal(chatEstimate.totalTokens, chatEstimate.inputTokens + chatEstimate.toolResultTokens)

const recordedMessages = new TokenBudget()
recordedMessages.recordChatMessages(messages)
assert.equal(recordedMessages.snapshot().estimatedInputTokens, chatEstimate.inputTokens)
assert.equal(recordedMessages.snapshot().estimatedToolResultTokens, chatEstimate.toolResultTokens)
assert.equal(recordedMessages.snapshot().estimatedTotalTokens, chatEstimate.totalTokens)

const thresholdHit = estimateTokenBudget(messages, {
  maxInputTokens: chatEstimate.totalTokens,
  compactThresholdRatio: 1,
})
assert.equal(thresholdHit.maxInputTokens, chatEstimate.totalTokens)
assert.equal(thresholdHit.compactThresholdRatio, 1)
assert.equal(thresholdHit.compactThresholdTokens, chatEstimate.totalTokens)
assert.equal(thresholdHit.compactRecommended, true)

const thresholdMiss = estimateTokenBudget(messages, {
  maxInputTokens: chatEstimate.totalTokens + 1,
  compactThresholdRatio: 1,
})
assert.equal(thresholdMiss.compactRecommended, false)

const ratioThreshold = estimateTokenBudget(messages, {
  maxInputTokens: chatEstimate.totalTokens * 2,
  compactThresholdRatio: 0.5,
})
assert.equal(ratioThreshold.compactThresholdTokens, chatEstimate.totalTokens)
assert.equal(ratioThreshold.compactRecommended, true)

const noMax = estimateTokenBudget([{ role: 'tool', content: 'B'.repeat(8000), tool_call_id: 'call_2' }])
assert(noMax.estimatedTotalTokens > 1000, 'messages should still be estimated without maxInputTokens')
assert.equal(noMax.maxInputTokens, DEFAULT_MAX_INPUT_TOKENS)
assert.equal(noMax.compactRecommended, false, 'default maxInputTokens should avoid compacting small transcripts')

const defaultThresholdHit = estimateTokenBudget([{ role: 'tool', content: 'B'.repeat(DEFAULT_MAX_INPUT_TOKENS * 4), tool_call_id: 'call_default' }])
assert.equal(defaultThresholdHit.usingDefaultMaxInputTokens, true)
assert(defaultThresholdHit.warnings?.length > 0, 'default budget should include a warning')
assert.equal(defaultThresholdHit.compactRecommended, true, 'unset maxInputTokens should still compact very large transcripts')

const knownModel = estimateTokenBudget(messages, { modelName: 'gpt-5-mini' })
assert.equal(knownModel.modelName, 'gpt-5-mini')
assert.equal(knownModel.maxInputTokens, 120_000)
assert.equal(knownModel.usingDefaultMaxInputTokens, undefined)
assert.equal(knownModel.warnings, undefined)

const unknownModel = estimateTokenBudget(messages, { modelName: 'mystery-model' })
assert.equal(unknownModel.modelName, 'mystery-model')
assert.equal(unknownModel.maxInputTokens, DEFAULT_MAX_INPUT_TOKENS)
assert.equal(unknownModel.usingDefaultMaxInputTokens, true)
assert.match(unknownModel.warnings?.[0] ?? '', /Unknown model context window/)

const longObservation = estimateChatMessages([{ role: 'tool', content: 'C'.repeat(4000), tool_call_id: 'call_3' }])
const shortObservation = estimateChatMessages([{ role: 'tool', content: 'ok', tool_call_id: 'call_4' }])
assert(longObservation.toolResultTokens > shortObservation.toolResultTokens + 900)

assert.equal(estimateToolObservationTokens({ observation: 'D'.repeat(40) }), estimateTokens(JSON.stringify({ observation: 'D'.repeat(40) })))

assert.deepEqual(createTokenBudgetSnapshot(), {
  version: 1,
  maxInputTokens: DEFAULT_MAX_INPUT_TOKENS,
  compactThresholdRatio: 0.8,
  compactThresholdTokens: Math.ceil(DEFAULT_MAX_INPUT_TOKENS * 0.8),
  estimatedInputTokens: 0,
  estimatedToolResultTokens: 0,
  estimatedTotalTokens: 0,
  compactRecommended: false,
  usingDefaultMaxInputTokens: true,
  warnings: [
    `No model context window configured; using conservative default ${DEFAULT_MAX_INPUT_TOKENS} input tokens.`,
  ],
})

console.log('token-budget-test: PASS')
