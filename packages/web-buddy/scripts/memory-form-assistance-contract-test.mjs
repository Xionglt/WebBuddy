#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import {
  assertMemoryFormAssistanceSuite,
  memoryEvalKeywordOverlap,
} from '../dist/evals/memory-form-assistance/schema.js'
import { MEMORY_EVAL_FORM_DEFINITION } from '../dist/evals/memory-form-assistance/form-definition.js'

const suite = JSON.parse(await readFile(
  new URL('../evals/memory-form-assistance/cases.json', import.meta.url),
  'utf8',
))
const fixture = await readFile(
  new URL('./fixtures/memory-form-assistance/form.html', import.meta.url),
  'utf8',
)

assert.doesNotThrow(() => assertMemoryFormAssistanceSuite(suite))
assert.equal(suite.cases.length, 10)
assert.deepEqual(
  Object.fromEntries([...new Set(suite.cases.map((item) => item.category))].map((category) => [
    category,
    suite.cases.filter((item) => item.category === category).length,
  ])),
  {
    fact_update: 2,
    preference_conflict: 2,
    expired: 2,
    fuzzy_recall: 2,
    pollution: 2,
  },
)

for (const evalCase of suite.cases) {
  assert.deepEqual(evalCase.form, MEMORY_EVAL_FORM_DEFINITION, `${evalCase.id}: form fixture drifted`)
  const target = evalCase.writes.find((step) => (
    step.alias === evalCase.expected.targetWriteAlias
    || step.contentVersionAlias === evalCase.expected.targetWriteAlias
  ))
  assert(target, `${evalCase.id}: targetWriteAlias must resolve to one write`)
  const overlap = memoryEvalKeywordOverlap(evalCase.goal.instruction, target.content)
  if (evalCase.category === 'fuzzy_recall') assert.equal(overlap.length, 0, evalCase.id)
  if (['fact_update', 'preference_conflict', 'expired'].includes(evalCase.category)) {
    assert(overlap.length >= 1, evalCase.id)
  }
}

const expiredCases = suite.cases.filter((item) => item.category === 'expired')
assert.equal(expiredCases.filter((item) => item.writes[0].ttlMs !== undefined).length, 1)
assert.equal(expiredCases.filter((item) => item.writes[0].expiresAt !== undefined).length, 1)
for (const evalCase of suite.cases.filter((item) => item.category === 'pollution')) {
  assert.equal(evalCase.writes[0].expectedStatus, 'policy_denied', evalCase.id)
}

const first = suite.cases[0]
assertRejects({ ...suite, extra: true }, /unknown field.*extra/i)
assertRejects({ ...suite, schemaVersion: 'memory-form-assistance-suite/v999' }, /unsupported.*suite/i)
assertRejects(replaceCase(first.id, { ...first, extra: true }), /unknown field.*extra/i)
assertRejects(replaceCase(first.id, { ...first, clock: { ...first.clock, runAt: 'not-a-date' } }), /runAt.*UTC/i)
assertRejects(replaceCase(first.id, { ...first, writes: [first.writes[0], first.writes[0]] }), /duplicate.*alias/i)
assertRejects(replaceCase(first.id, {
  ...first,
  writes: [{ ...first.writes[0], supersedes: ['missing-alias'] }, ...first.writes.slice(1)],
}), /supersedes.*missing-alias/i)
assertRejects(replaceCase(first.id, {
  ...first,
  writes: [first.writes[0], { ...first.writes[1], conflicts: ['missing-alias'] }],
}), /conflicts.*missing-alias/i)
assertRejects(replaceCase(first.id, {
  ...first,
  writes: [first.writes[0], { ...first.writes[1], entryAlias: 'missing-alias' }],
}), /entryAlias.*missing-alias/i)
assertRejects(replaceCase(first.id, {
  ...first,
  writes: [first.writes[0], { ...first.writes[1], contentVersionAlias: first.writes[0].alias }],
}), /duplicate.*alias/i)
assertRejects(replaceCase(first.id, {
  ...first,
  expected: { ...first.expected, targetWriteAlias: 'missing-alias' },
}), /targetWriteAlias.*missing-alias/i)
assertRejects(replaceCase(first.id, {
  ...first,
  expected: { ...first.expected, targetWriteAliases: [first.expected.targetWriteAlias] },
}), /unknown field.*targetWriteAliases/i)
assertRejects(replaceCase(first.id, {
  ...first,
  expected: { ...first.expected, fields: { notAFormField: 'x' } },
}), /notAFormField.*form field/i)
assertRejects(replaceCase(first.id, {
  ...first,
  form: {
    fields: first.form.fields.map((field, index) => index === 0 ? { ...field, key: 'otherCity' } : field),
  },
}), /fixed fixture/i)
assertRejects({ ...suite, cases: [...suite.cases, structuredClone(first)] }, /duplicate.*case id/i)
assertRejects({ ...suite, cases: suite.cases.slice(1) }, /exactly 2.*fact_update/i)

const fuzzy = suite.cases.find((item) => item.category === 'fuzzy_recall')
assert(fuzzy)
const fuzzyTarget = fuzzy.writes.find((step) => (
  step.alias === fuzzy.expected.targetWriteAlias
  || step.contentVersionAlias === fuzzy.expected.targetWriteAlias
))
assert(fuzzyTarget)
assertRejects(replaceCase(fuzzy.id, {
  ...fuzzy,
  goal: { ...fuzzy.goal, instruction: `Use ${fuzzyTarget.content.fieldKey}` },
}), /fuzzy.*keyword overlap/i)

assert.match(fixture, /id="city"/)
assert.match(fixture, /id="language"/)
assert.match(fixture, /name="workMode"/)
assert.match(fixture, /id="timezone"/)
assert.match(fixture, /name="notificationChannel"/)
assert.match(fixture, /<input\s+id="city"\s+name="city"\s+type="text"\s+required>/)
assert.match(fixture, /<select\s+id="language"\s+name="language"\s+required>/)
assert.match(fixture, /<input\s+name="workMode"\s+type="radio"\s+value="Remote"\s+required>/)
assert.match(fixture, /<input\s+id="timezone"\s+name="timezone"\s+type="text"\s+required>/)
assert.match(fixture, /<input\s+name="notificationChannel"\s+type="radio"\s+value="Email"\s+required>/)
assert.doesNotMatch(fixture, /type=["']submit["']|<form\b|\.submit\s*\(/i)

console.log('memory-form-assistance-contract-test: PASS')

function replaceCase(id, replacement) {
  return {
    ...suite,
    cases: suite.cases.map((item) => item.id === id ? replacement : item),
  }
}

function assertRejects(value, pattern) {
  assert.throws(() => assertMemoryFormAssistanceSuite(value), pattern)
}
