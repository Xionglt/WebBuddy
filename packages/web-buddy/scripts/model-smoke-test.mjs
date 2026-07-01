#!/usr/bin/env node
import assert from 'node:assert/strict'
import { loadConfig } from '../dist/sdk/config.js'
import { LlmGateway } from '../dist/sdk/llm.js'

const config = loadConfig()
const llm = new LlmGateway(config.model)

console.log('model-smoke: provider', config.model.provider)
console.log('model-smoke: model', config.model.name)
console.log('model-smoke: baseUrl', config.model.baseUrl)
console.log('model-smoke: key', llm.hasKey ? 'set' : 'NOT SET')
if (config.model.extraBody) {
  console.log('model-smoke: extraBody', JSON.stringify(config.model.extraBody))
}

if (!llm.hasKey) {
  throw new Error('No model key configured. Set MODEL_API_KEY or DASHSCOPE_API_KEY in the root .env.')
}

const text = await llm.chat([
  { role: 'system', content: 'You are a concise smoke-test assistant.' },
  { role: 'user', content: 'Reply with exactly: pong' },
], {
  temperature: 0,
  maxTokens: 32,
})
assert(text.trim(), 'plain chat should return text')
console.log('model-smoke: chat OK ->', text.trim().slice(0, 120))

const completion = await llm.chatWithTools([
  { role: 'system', content: 'You must use tools when a suitable tool is provided.' },
  { role: 'user', content: 'Use the add_numbers tool to add 2 and 3.' },
], {
  temperature: 0,
  maxTokens: 128,
  tools: [{
    type: 'function',
    function: {
      name: 'add_numbers',
      description: 'Add two numbers and return the sum.',
      parameters: {
        type: 'object',
        properties: {
          a: { type: 'number' },
          b: { type: 'number' },
        },
        required: ['a', 'b'],
        additionalProperties: false,
      },
    },
  }],
  toolChoice: 'auto',
})

assert(
  completion.toolCalls.some((call) => call.name === 'add_numbers'),
  `tool calling smoke test expected add_numbers, got ${JSON.stringify(completion.toolCalls)}`,
)
console.log('model-smoke: tool calling OK ->', JSON.stringify(completion.toolCalls))
console.log('model-smoke: PASS')
