#!/usr/bin/env node
import assert from 'node:assert/strict'
import { compactContextIfNeeded } from '../dist/context/compaction-pipeline.js'
import { COMPACTED_RUN_CONTEXT_PREFIX } from '../dist/context/run-summary.js'

class SemanticLlm {
  constructor() {
    this.calls = []
  }

  async chat(messages, options) {
    this.calls.push({ messages, options })
    return JSON.stringify({
      schemaVersion: 'semantic-compact-summary/v1',
      userIntent: 'Apply to the selected job without final submission.',
      importantDecisions: ['Final submit remains unapproved.'],
      attemptedPaths: [
        {
          action: 'Clicked Apply before checking the agreement checkbox.',
          result: 'The application did not advance.',
          reason: 'The agreement checkbox was required.',
          shouldAvoidRetry: true,
        },
      ],
      unresolvedQuestions: ['Expected salary still needs user confirmation.'],
      nextStrategy: ['Refresh form state, check required fields, then continue before final submit.'],
      riskNotes: ['Do not infer final-submit approval from application-entry actions.'],
    })
  }
}

const largeSnapshot = [
  'browser snapshot with element refs [e1] [e2]',
  'Apply button [e2]',
  'A'.repeat(12_000),
].join('\n')

const messages = [
  { role: 'system', content: 'system' },
  { role: 'user', content: 'Apply to this job, but stop before final submit.' },
  {
    role: 'assistant',
    content: '',
    tool_calls: [
      {
        id: 'old_snapshot',
        type: 'function',
        function: { name: 'browser_snapshot', arguments: '{}' },
      },
    ],
  },
  { role: 'tool', tool_call_id: 'old_snapshot', name: 'browser_snapshot', content: largeSnapshot },
  {
    role: 'assistant',
    content: '',
    tool_calls: [
      {
        id: 'recent_click',
        type: 'function',
        function: { name: 'browser_click', arguments: '{"ref":"e2"}' },
      },
    ],
  },
  { role: 'tool', tool_call_id: 'recent_click', name: 'browser_click', content: 'Click failed because an agreement checkbox is required.' },
]

const latestContext = {
  schemaVersion: 'context-snapshot/v1',
  sessionId: 'pipeline-session',
  goal: 'Apply to the selected job without final submission.',
  page: {
    schemaVersion: 'page-state/v1',
    url: 'https://jobs.example.test/apply',
    title: 'Application form',
    pageType: 'form',
    interactiveCount: 6,
    formCount: 1,
    linkCount: 1,
    buttonCount: 2,
    inputCount: 3,
    updatedAt: '2026-07-09T10:00:00.000Z',
  },
  freshness: {
    pageStateUpdatedAt: '2026-07-09T10:00:00.000Z',
    pageStateAgeMs: 120_000,
    pageStateStale: true,
    formStateStale: true,
    staleAfterMs: 30_000,
  },
  resumeSummary: '',
  recentActions: [],
  safetyNotes: [],
  blockers: [],
  updatedAt: '2026-07-09T10:02:00.000Z',
}

const semanticLlm = new SemanticLlm()
const full = await compactContextIfNeeded({
  sessionId: 'pipeline-session',
  runId: 'pipeline-run',
  turnId: 'turn_001',
  step: 7,
  goal: 'Apply to the selected job without final submission.',
  messages,
  latestContext,
  systemContent: 'system after compact',
  tokenBudgetOptions: {
    maxInputTokens: 300,
    compactThresholdRatio: 1,
  },
  keepRecentMessages: 4,
  semanticLlm,
})

assert.equal(full.fullCompactionApplied, true, 'full compaction should apply at token threshold')
assert.equal(full.compaction?.summary.compactMode, 'structured_semantic')
assert.equal(full.compaction.summary.semanticSummary?.userIntent, 'Apply to the selected job without final submission.')
assert.equal(full.compaction.summary.permissionContract?.finalSubmitRequiresExplicitApproval, true)
assert.equal(full.compaction.summary.staleRefs?.rule, 'old_browser_refs_are_not_actionable')
assert.equal(semanticLlm.calls.length, 1, 'semantic LLM should be called once')
assert(full.microCompaction?.applied, 'old large snapshot should be micro-compacted before full compact')
assert.equal(full.recentRawRetention?.selectionMode, 'message_count', 'explicit keepRecentMessages should preserve legacy behavior')
assert(full.messages[0].role === 'system', 'compacted messages should start with system')
assert(
  full.messages.some((message) => message.role === 'user' && message.content.startsWith(COMPACTED_RUN_CONTEXT_PREFIX)),
  'compacted messages should include COMPACTED_RUN_CONTEXT',
)
assertToolBoundariesIntact(full.messages)

const microOnly = await compactContextIfNeeded({
  sessionId: 'pipeline-session',
  runId: 'pipeline-run',
  turnId: 'turn_002',
  step: 8,
  goal: 'Micro compact only.',
  messages,
  latestContext,
  systemContent: 'system after compact',
  tokenBudgetOptions: {
    maxInputTokens: 120_000,
    compactThresholdRatio: 0.8,
  },
  keepRecentMessages: 4,
  semanticLlm,
})

assert.equal(microOnly.fullCompactionApplied, false, 'large tool result alone should not force full compact under a large budget')
assert.equal(microOnly.microCompaction?.applied, true, 'micro compact should still apply to oversized old tool results')
assert.equal(microOnly.messages.length, messages.length, 'micro compact should preserve message count')
assert(microOnly.messages[3].content.includes('[micro_compacted_tool_result'), 'old tool result should be replaced with a micro compact marker')
assert.equal(semanticLlm.calls.length, 1, 'micro-only path should not call semantic LLM')
assertToolBoundariesIntact(microOnly.messages)

const dynamicSemanticLlm = new SemanticLlm()
const dynamicMessages = [
  { role: 'system', content: 'system' },
  { role: 'user', content: `old-user-1 ${'A'.repeat(1600)}` },
  { role: 'assistant', content: `old-assistant-1 ${'B'.repeat(1600)}` },
  { role: 'user', content: `old-user-2 ${'C'.repeat(1600)}` },
  { role: 'assistant', content: `old-assistant-2 ${'D'.repeat(1600)}` },
  { role: 'user', content: `recent-user ${'E'.repeat(120)}` },
  { role: 'assistant', content: `recent-assistant ${'F'.repeat(120)}` },
]
const dynamicTail = await compactContextIfNeeded({
  sessionId: 'pipeline-session',
  runId: 'pipeline-run',
  turnId: 'turn_003',
  step: 9,
  goal: 'Retain a token-budgeted recent raw tail.',
  messages: dynamicMessages,
  latestContext,
  systemContent: 'system after compact',
  tokenBudgetOptions: {
    maxInputTokens: 2_000,
    compactThresholdRatio: 0.8,
  },
  semanticLlm: dynamicSemanticLlm,
})

assert.equal(dynamicTail.fullCompactionApplied, true, 'dynamic-tail fixture should cross the 80% full-compaction threshold')
assert.equal(dynamicTail.recentRawRetention?.selectionMode, 'token_ratio')
assert.equal(dynamicTail.recentRawRetention?.recentRawTokenRatio, 0.2)
assert.equal(dynamicTail.recentRawRetention?.targetTokens, 400)
assert(
  (dynamicTail.recentRawRetention?.retainedTokens ?? Infinity) <= 400,
  'recent raw history should stay within 20% of the model input window when boundary groups fit',
)
assert(
  (dynamicTail.recentRawRetention?.compactedHistoryTokens ?? 0) > (dynamicTail.recentRawRetention?.retainedTokens ?? Infinity),
  'the older history region should be handed to compaction instead of retained verbatim',
)
assert(dynamicTail.messages.some((message) => message.content.includes('recent-assistant')), 'latest raw context should remain verbatim')
assert(!dynamicTail.messages.some((message) => message.content.includes('old-user-1')), 'old raw context should be replaced by the compact summary')
const dynamicSemanticPrompt = dynamicSemanticLlm.calls[0].messages.map((message) => message.content).join('\n')
assert(dynamicSemanticPrompt.includes('old-user-1'), 'semantic compaction should consume the older history region')
assert(!dynamicSemanticPrompt.includes('recent-assistant'), 'semantic compaction should not duplicate the retained recent raw region')
assertToolBoundariesIntact(dynamicTail.messages)

console.log('compaction-pipeline-test: PASS')

function assertToolBoundariesIntact(messages) {
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]
    if (message.role !== 'assistant' || !message.tool_calls?.length) continue
    const expected = new Set(message.tool_calls.map((call) => call.id))
    let cursor = index + 1
    while (cursor < messages.length && messages[cursor].role === 'tool') {
      expected.delete(messages[cursor].tool_call_id)
      cursor += 1
    }
    assert.equal(expected.size, 0, `assistant tool_calls at index ${index} should keep matching tool results`)
  }
}
