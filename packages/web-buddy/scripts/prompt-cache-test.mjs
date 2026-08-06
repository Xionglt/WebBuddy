#!/usr/bin/env node
import assert from 'node:assert/strict'
import { LlmGateway } from '../dist/sdk/llm.js'

const originalFetch = globalThis.fetch

try {
  await testOpenAiUsageAndRequestFields()
  await testAnthropicUsageAndBreakpoints()
  await testOpenAiStreamingTtft()
  await testAnthropicStreamingToolCallTtft()
  await testStreamingCompatibilityFallback()
  await testCompatibleProxyIsObserveOnlyByDefault()
  testProviderSpecificTtlValidation()
  console.log('prompt-cache-test: PASS')
} finally {
  globalThis.fetch = originalFetch
}

async function testOpenAiUsageAndRequestFields() {
  const requests = []
  let responseIndex = 0
  globalThis.fetch = async (_url, init) => {
    requests.push(JSON.parse(init.body))
    const cachedTokens = responseIndex++ === 0 ? 1_200 : 400
    return jsonResponse({
      choices: [{ message: { content: 'ok' } }],
      usage: {
        prompt_tokens: 2_000,
        completion_tokens: 100,
        total_tokens: 2_100,
        prompt_tokens_details: { cached_tokens: cachedTokens, cache_write_tokens: 400 },
      },
    })
  }

  const llm = new LlmGateway({
    provider: 'openai',
    apiKey: 'test-key',
    baseUrl: 'https://api.openai.com/v1',
    name: 'gpt-5.6',
  })
  const completion = await llm.chatWithTools([
    { role: 'system', content: 'stable system prompt' },
    {
      role: 'user',
      content: 'COMPACTED_RUN_CONTEXT\nstable checkpoint',
      cacheBoundary: 'compaction_checkpoint',
    },
    { role: 'user', content: 'continue' },
  ], {
    promptCacheNamespace: 'agent_loop',
    promptCacheKey: 'stable-key',
  })

  assert.equal(requests[0].prompt_cache_key, 'stable-key')
  assert.deepEqual(requests[0].prompt_cache_options, { ttl: '30m' })
  assert.equal(
    requests[0].messages.some((message) => 'cacheBoundary' in message),
    false,
    'internal cache-boundary metadata must not leak to OpenAI wire messages',
  )
  assert.equal(completion.usage.inputTokens, 2_000)
  assert.equal(completion.usage.cacheReadInputTokens, 1_200)
  assert.equal(completion.usage.cacheCreationInputTokens, 400)
  assert.equal(completion.usage.uncachedInputTokens, 800)
  assert.equal(completion.usage.cacheHitRatio, 0.6)

  await llm.chatWithTools([
    { role: 'system', content: 'stable system prompt' },
    { role: 'user', content: 'one more turn' },
  ], {
    promptCacheNamespace: 'agent_loop',
    promptCacheKey: 'stable-key',
  })

  const snapshot = llm.getPromptCacheSnapshot('agent_loop')
  assert.equal(snapshot.capability.requestMode, 'openai_automatic')
  assert.equal(snapshot.capability.ttl, '30m')
  assert.equal(snapshot.totals.requests, 2)
  assert.equal(snapshot.totals.cacheHitRatio, 0.4, 'cumulative hit rate must be token-weighted')
  assert.equal(snapshot.recentUsages.length, 2, 'recent cache usage should remain available to the compaction policy')
  assert(snapshot.cacheActivityAt, 'a cache read should refresh the observed cache activity clock')
}

async function testAnthropicUsageAndBreakpoints() {
  let request
  globalThis.fetch = async (_url, init) => {
    request = JSON.parse(init.body)
    return jsonResponse({
      content: [{ type: 'text', text: 'done' }],
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 500,
        cache_creation_input_tokens: 1_500,
      },
    })
  }

  const llm = new LlmGateway({
    provider: 'anthropic',
    apiKey: 'test-key',
    authToken: 'test-key',
    baseUrl: 'https://api.anthropic.com',
    name: 'claude-sonnet-4-5',
    promptCache: { ttl: '1h' },
  })
  const completion = await llm.chatWithTools([
    { role: 'system', content: 'stable system prompt' },
    {
      role: 'user',
      content: 'COMPACTED_RUN_CONTEXT\nstable checkpoint',
      cacheBoundary: 'compaction_checkpoint',
    },
    { role: 'user', content: 'continue the long task' },
  ], {
    promptCacheNamespace: 'agent_loop',
    tools: [{
      type: 'function',
      function: {
        name: 'browser_snapshot',
        description: 'Observe the page.',
        parameters: { type: 'object', properties: {} },
      },
    }],
  })

  assert.equal(request.system[0].cache_control.type, 'ephemeral')
  assert.equal(request.system[0].cache_control.ttl, '1h')
  assert.equal(request.tools.at(-1).cache_control.ttl, '1h')
  assert.equal(request.messages[0].content.at(-1).cache_control.ttl, '1h')
  assert.equal(request.messages.at(-1).content.at(-1).cache_control.ttl, '1h')
  assert.equal(
    (JSON.stringify(request).match(/"cache_control":/g) ?? []).length,
    4,
    'tools, system, compaction checkpoint, and rolling history should use exactly four breakpoints',
  )
  assert.equal(JSON.stringify(request).includes('cacheBoundary'), false)
  assert.equal(completion.usage.inputTokens, 2_100)
  assert.equal(completion.usage.cacheReadInputTokens, 500)
  assert.equal(completion.usage.cacheCreationInputTokens, 1_500)
  assert.equal(completion.usage.uncachedInputTokens, 1_600)

  const snapshot = llm.getPromptCacheSnapshot('agent_loop')
  assert.equal(snapshot.capability.requestMode, 'anthropic_explicit')
  assert.equal(snapshot.capability.ttlMs, 60 * 60_000)
  assert(snapshot.cacheActivityAt, 'cache creation should establish the observed cache activity clock')
}

async function testOpenAiStreamingTtft() {
  let request
  globalThis.fetch = async (_url, init) => {
    request = JSON.parse(init.body)
    return sseResponse([
      {
        choices: [{ delta: { role: 'assistant', content: '' } }],
      },
      {
        choices: [{ delta: { content: 'streamed ' } }],
      },
      {
        choices: [{ delta: { content: 'answer' } }],
      },
      {
        choices: [],
        usage: {
          prompt_tokens: 2_000,
          completion_tokens: 20,
          total_tokens: 2_020,
          prompt_tokens_details: { cached_tokens: 1_000, cache_write_tokens: 0 },
        },
      },
      '[DONE]',
    ])
  }

  const llm = new LlmGateway({
    provider: 'openai',
    apiKey: 'test-key',
    baseUrl: 'https://api.openai.com/v1',
    name: 'gpt-5.6',
  })
  const completion = await llm.chatWithTools([
    { role: 'system', content: 'system' },
    { role: 'user', content: 'stream' },
  ], {
    stream: true,
    promptCacheNamespace: 'agent_loop',
  })

  assert.equal(request.stream, true)
  assert.deepEqual(request.stream_options, { include_usage: true })
  assert.equal(completion.content, 'streamed answer')
  assert.equal(completion.usage.cacheReadInputTokens, 1_000)
  assert.equal(typeof completion.usage.ttftMs, 'number')
  assert(completion.usage.firstTokenAt)
}

async function testAnthropicStreamingToolCallTtft() {
  globalThis.fetch = async () => sseResponse([
    {
      type: 'message_start',
      message: {
        usage: {
          input_tokens: 100,
          output_tokens: 0,
          cache_read_input_tokens: 900,
          cache_creation_input_tokens: 0,
        },
      },
    },
    {
      type: 'content_block_start',
      index: 0,
      content_block: {
        type: 'tool_use',
        id: 'tool_1',
        name: 'browser_snapshot',
        input: {},
      },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '{"includeForms":true}' },
    },
    {
      type: 'message_delta',
      usage: { output_tokens: 12 },
    },
    { type: 'message_stop' },
  ])

  const llm = new LlmGateway({
    provider: 'anthropic',
    apiKey: 'test-key',
    authToken: 'test-key',
    baseUrl: 'https://api.anthropic.com',
    name: 'claude-sonnet-4-5',
  })
  const completion = await llm.chatWithTools([
    { role: 'system', content: 'system' },
    { role: 'user', content: 'inspect the form' },
  ], {
    stream: true,
    promptCacheNamespace: 'agent_loop',
  })

  assert.deepEqual(completion.toolCalls, [{
    id: 'tool_1',
    name: 'browser_snapshot',
    arguments: { includeForms: true },
  }])
  assert.equal(completion.usage.cacheReadInputTokens, 900)
  assert.equal(completion.usage.outputTokens, 12)
  assert.equal(typeof completion.usage.ttftMs, 'number')
}

async function testStreamingCompatibilityFallback() {
  const requests = []
  globalThis.fetch = async (_url, init) => {
    requests.push(JSON.parse(init.body))
    if (requests.length === 1) {
      return new Response('streaming is unsupported', {
        status: 422,
        headers: { 'content-type': 'text/plain' },
      })
    }
    return jsonResponse({
      choices: [{ message: { content: 'fallback response' } }],
      usage: {
        prompt_tokens: 1_100,
        completion_tokens: 10,
        total_tokens: 1_110,
        prompt_tokens_details: { cached_tokens: 0 },
      },
    })
  }

  const llm = new LlmGateway({
    provider: 'openai',
    apiKey: 'test-key',
    baseUrl: 'https://compatible.example.test/v1',
    name: 'compatible-model',
  })
  const completion = await llm.chatWithTools([
    { role: 'system', content: 'system' },
    { role: 'user', content: 'continue' },
  ], { stream: true })

  assert.equal(requests.length, 2)
  assert.equal(requests[0].stream, true)
  assert.equal(requests[1].stream, undefined)
  assert.equal(completion.content, 'fallback response')
  assert.equal(completion.usage.ttftMs, undefined, 'non-streaming fallback must not pretend to measure TTFT')
}

async function testCompatibleProxyIsObserveOnlyByDefault() {
  let request
  globalThis.fetch = async (_url, init) => {
    request = JSON.parse(init.body)
    return jsonResponse({
      content: [{ type: 'text', text: 'proxy response' }],
      usage: {
        input_tokens: 50,
        output_tokens: 10,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    })
  }

  const llm = new LlmGateway({
    provider: 'anthropic',
    apiKey: 'test-key',
    authToken: 'test-key',
    baseUrl: 'https://open.bigmodel.cn/api/anthropic',
    name: 'glm-4.7',
  })
  await llm.chatWithTools([
    { role: 'system', content: 'system' },
    { role: 'user', content: 'user' },
  ], { promptCacheNamespace: 'agent_loop' })

  assert.equal(typeof request.system, 'string')
  assert.equal(request.messages.at(-1).content, 'user')
  assert.equal(llm.getPromptCacheSnapshot('agent_loop').capability.requestMode, 'observe_only')
}

function jsonResponse(value) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function sseResponse(events) {
  const body = events
    .map((event) => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`)
    .join('')
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

function testProviderSpecificTtlValidation() {
  assert.throws(() => new LlmGateway({
    provider: 'anthropic',
    apiKey: 'test-key',
    baseUrl: 'https://api.anthropic.com',
    name: 'claude-sonnet-4-5',
    promptCache: { ttl: '30m' },
  }), /supports ttl=5m or ttl=1h/)
}
