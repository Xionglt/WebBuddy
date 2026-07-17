#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AnswerStore } from '../dist/context/answer-store.js'
import { ensureMemdir, queryMemdir, renderMemorySearchResult } from '../dist/memory/index.js'
import { buildPromptSections } from '../dist/context/prompt-sections.js'

const root = mkdtempSync(join(tmpdir(), 'mfa-memory-system-'))

try {
  const store = new AnswerStore()
  store.put({
    field: 'Preferred city',
    question: 'Which city should we use for applications?',
    answer: 'Hangzhou',
    at: '2026-07-09T00:00:00.000Z',
    source: 'ask_user',
    scope: 'user',
    expiresAt: '2099-01-01T00:00:00.000Z',
  })
  store.put({
    field: '短信验证码',
    question: '请输入验证码',
    answer: '123456',
    at: '2026-07-09T00:01:00.000Z',
    source: 'ask_user',
  })
  store.put({
    field: 'password',
    question: 'Account password?',
    answer: 'correct-horse-battery-staple',
    at: '2026-07-09T00:02:00.000Z',
    source: 'ask_user',
  })
  store.put({
    field: 'Expired note',
    question: 'Temporary value?',
    answer: 'do-not-reuse',
    at: '2026-07-09T00:03:00.000Z',
    source: 'ask_user',
    expiresAt: '2000-01-01T00:00:00.000Z',
  })

  assert.equal(store.get('Preferred city')?.answer, 'Hangzhou')
  assert.equal(store.get('短信验证码'), undefined)
  assert.equal(store.get('password'), undefined)
  assert.equal(store.get('Expired note'), undefined)
  assert.equal(store.all().length, 1)

  const memdir = await ensureMemdir(root)
  assert(readFileSync(memdir.index, 'utf8').includes('Web Buddy Memory'))
  writeFileSync(memdir.user, `${JSON.stringify({
    schemaVersion: 'memory-record/v1',
    id: 'mem-user-city',
    kind: 'user_answer',
    scope: 'user',
    createdAt: '2026-07-09T00:00:00.000Z',
    updatedAt: '2026-07-09T00:00:00.000Z',
    source: { type: 'answer_store' },
    sensitivity: 'personal',
    tags: ['application'],
    confidence: 0.9,
    question: 'Which city should applications use?',
    field: 'Preferred city',
    answer: 'Hangzhou',
    reusable: true,
  })}\n`)
  writeFileSync(memdir.topic, `${JSON.stringify({
    schemaVersion: 'memory-record/v1',
    id: 'mem-secret-token',
    kind: 'semantic_note',
    scope: 'user',
    createdAt: '2026-07-09T00:00:00.000Z',
    updatedAt: '2026-07-09T00:00:00.000Z',
    source: { type: 'user' },
    sensitivity: 'secret',
    tags: ['auth'],
    confidence: 1,
    title: 'Token',
    body: 'Bearer SECRET',
    topics: ['token'],
  })}\n`)

  const result = await queryMemdir(root, {
    schemaVersion: 'memory-query/v1',
    runId: 'run-memory-test',
    sessionId: 'sess-memory-test',
    scope: ['user'],
    kinds: ['user_answer', 'semantic_note'],
    field: 'Preferred city',
    topics: ['application'],
    maxResults: 5,
    includeSensitive: false,
  })
  const rendered = renderMemorySearchResult(result)
  assert.equal(result.records.length, 1)
  assert(rendered.includes('Hangzhou'))
  assert(!rendered.includes('SECRET'))

  const sections = buildPromptSections({
    schemaVersion: 'context-snapshot/v1',
    sessionId: 'sess-memory-test',
    goal: 'Fill the application form.',
    relevantMemories: rendered,
    freshness: { pageStateStale: true, formStateStale: true, staleAfterMs: 30_000 },
    contextItems: [],
    contextSummary: 'name: Test User',
    recentActions: [],
    safetyNotes: [],
    blockers: [],
    updatedAt: '2026-07-09T00:00:00.000Z',
  })
  const memorySection = sections.find((section) => section.id === 'RELEVANT_MEMORIES')
  assert(memorySection, 'prompt should include RELEVANT_MEMORIES section')
  assert(memorySection.content.includes('Hangzhou'))
  assert(!memorySection.content.includes('SECRET'))

  console.log('memory-system-test: PASS')
} finally {
  rmSync(root, { recursive: true, force: true })
}
