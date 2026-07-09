import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { AnswerStore } from '../dist/context/answer-store.js'
import {
  createRunMemory,
  renderRunMemory,
  updateRunMemoryFromModel,
  updateRunMemoryFromTool,
} from '../dist/context/run-memory.js'

const memory = createRunMemory('2026-07-06T00:00:00.000Z')

assert.equal(updateRunMemoryFromTool({
  memory,
  toolName: 'browser_type',
  args: { ref: 'searchbox', text: 'React' },
  result: { observation: 'Typed into search field.', pageChanged: false },
  ok: true,
  now: '2026-07-06T00:00:01.000Z',
}), true)

assert.equal(updateRunMemoryFromTool({
  memory,
  toolName: 'browser_snapshot',
  args: {},
  result: { observation: 'No results found for this query. Try another keyword.', pageChanged: false },
  ok: true,
  now: '2026-07-06T00:00:02.000Z',
}), true)

assert.deepEqual(memory.searchedKeywords, ['React'])
assert.deepEqual(memory.emptyResultKeywords, ['React'])

assert.equal(updateRunMemoryFromModel({
  memory,
  content: [
    '候选岗位: AI Agent 研发工程师 | reason=matches agent/runtime/backend experience.',
    '候选岗位: Web Platform Engineer | reason=matches frontend platform work.',
    '排除: Hardware Frontend Engineer | reason=embedded hardware frontend is not a fit.',
    'current best candidate: AI Agent 研发工程师 | reason=strongest fit.',
  ].join('\n'),
  now: '2026-07-06T00:00:03.000Z',
}), true)

assert(memory.candidateJobs.some((job) => job.title.includes('AI Agent 研发工程师')))
assert(memory.excludedCandidates.some((job) => job.title.includes('Hardware Frontend Engineer')))
assert.equal(memory.currentBestCandidate?.title.includes('AI Agent 研发工程师'), true)

const beforeNoiseCandidates = memory.candidateJobs.length
assert.equal(updateRunMemoryFromTool({
  memory,
  toolName: 'browser_click',
  args: { ref: 'e12' },
  result: {
    observation: 'FAILED (ELEMENT_NOT_FOUND): Failed to click ref e12: locator.click: Timeout 20000ms exceeded. \x1b[2m - <div role="dialog">...</div> subtree intercepts pointer events\x1b[22m',
    pageChanged: false,
  },
  ok: false,
  currentUrl: 'https://talent-holding.alibaba.com/personal/social-resume?lang=zh',
  now: '2026-07-06T00:00:04.000Z',
}), false)
assert.equal(memory.candidateJobs.length, beforeNoiseCandidates)

assert.equal(updateRunMemoryFromTool({
  memory,
  toolName: 'browser_snapshot',
  args: {},
  result: {
    observation: '温馨提示 你已申请2个职位，本月还能再申请3个，请慎重选择！ 投递取消',
    pageChanged: false,
  },
  ok: true,
  currentUrl: 'https://talent-holding.alibaba.com/off-campus/position-detail',
  now: '2026-07-06T00:00:05.000Z',
}), false)
assert.equal(memory.candidateJobs.length, beforeNoiseCandidates)

assert.equal(updateRunMemoryFromTool({
  memory,
  toolName: 'browser_click_text',
  args: { text: '个人中心' },
  result: {
    observation: 'Clicked visible text "个人中心" (li role=option).',
    pageChanged: true,
  },
  ok: true,
  currentUrl: 'https://talent-holding.alibaba.com/personal/social-application?lang=zh',
  now: '2026-07-06T00:00:06.000Z',
}), false)
assert.equal(memory.candidateJobs.length, beforeNoiseCandidates)

const rendered = renderRunMemory(memory)
assert(rendered.includes('emptyResultKeywords: React'))
assert(rendered.includes('candidateJobs:'))
assert(rendered.includes('currentBestCandidate:'))

const root = mkdtempSync(join(tmpdir(), 'mfa-answer-store-'))
try {
  const answerPath = join(root, 'answers.json')
  const answerStore = new AnswerStore()
  answerStore.put({
    field: 'Expected salary',
    question: 'What salary do you expect?',
    answer: 'Negotiable',
    at: '2026-07-06T00:00:07.000Z',
    source: 'ask_user',
    options: ['Negotiable', '30k'],
  })
  await answerStore.save(answerPath, '2026-07-06T00:00:08.000Z')
  assert(readFileSync(answerPath, 'utf8').includes('"schemaVersion": "answer-store/v1"'))

  const restoredAnswers = await AnswerStore.load(answerPath)
  assert.equal(restoredAnswers.get('expected salary')?.answer, 'Negotiable')
  assert.deepEqual(restoredAnswers.get('EXPECTED SALARY')?.options, ['Negotiable', '30k'])

  const missingAnswers = await AnswerStore.load(join(root, 'missing.json'))
  assert.deepEqual(missingAnswers.all(), [])
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log('run-memory-test: PASS')
