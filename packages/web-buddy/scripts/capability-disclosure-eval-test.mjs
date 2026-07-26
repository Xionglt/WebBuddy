#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import {
  assertCapabilityDisclosureSuite,
  evaluateCapabilityDisclosure,
} from '../dist/evals/capability-disclosure.js'
import { ToolRegistry } from '../dist/runtime/local/tool-registry.js'

const suite = JSON.parse(await readFile(
  new URL('../evals/capability-disclosure/cases.json', import.meta.url),
  'utf8',
))
assert.doesNotThrow(() => assertCapabilityDisclosureSuite(suite))
assert(suite.cases.every((item) => Array.isArray(item.sources) && item.sources.length > 0))
assert(suite.cases.every((item) => !Object.hasOwn(item, 'source')))
await assertSourceEvidence(suite)

const report = evaluateCapabilityDisclosure({ suite, registry: new ToolRegistry() })
assert.equal(report.schemaVersion, 'capability-disclosure-report/v1')
assert.equal(report.caseCount, 7)
assert.equal(report.requiredToolRecall, 1)
assert.equal(report.fullSchemaTokens, 25_456)
assert.equal(report.selectedSchemaTokens, 17_708)
assert.equal(report.schemaTokenReduction, 1 - 17_708 / 25_456)
assert(report.schemaTokenReduction >= 0.3)
assert(report.cases.every((item) => item.missingRequiredTools.length === 0))
assert(report.cases.every((item) => item.requiredTools.every((tool) => item.fullTools.includes(tool))))
assert(report.cases.every((item) => item.selectedTools.every((tool) => item.fullTools.includes(tool))))
assert(Math.abs(report.byTaskType.fill_form.schemaTokenReduction - 0.05) < 1e-12)
assert(report.byTaskType.explore.schemaTokenReduction > 0.4)
assert(report.findings.some((item) => item.includes('fill_form')))
assert(report.findings.some((item) => item.includes('final_review') && item.includes('no frozen cases')))

const asyncCase = report.cases.find((item) => item.id === 'async-workflow-evaluation')
assert(asyncCase)
assert(asyncCase.selectedTools.includes('agent_task_spawn'))
const syncExplore = report.cases.find((item) => item.id === 'explore-handoff')
assert(syncExplore)
assert(!syncExplore.selectedTools.includes('agent_task_spawn'))
assert(!syncExplore.fullTools.includes('agent_task_spawn'))

assert.throws(
  () => assertCapabilityDisclosureSuite({ ...suite, extra: true }),
  /unknown field.*extra/i,
)
assert.throws(
  () => assertCapabilityDisclosureSuite({ ...suite, cases: [...suite.cases, suite.cases[0]] }),
  /duplicate.*case id/i,
)
assert.throws(
  () => assertCapabilityDisclosureSuite(replaceCase(suite, 0, {
    ...suite.cases[0],
    requiredTools: [...suite.cases[0].requiredTools, 'not_a_tool'],
  })),
  /unknown required tool/i,
)
assert.throws(
  () => assertCapabilityDisclosureSuite(replaceCase(suite, 0, {
    ...suite.cases[0],
    taskType: 'unknown',
  })),
  /taskType/i,
)
assert.throws(
  () => assertCapabilityDisclosureSuite(replaceCase(suite, 0, {
    ...suite.cases[0],
    source: suite.cases[0].sources[0],
  })),
  /unknown field.*source/i,
)
assert.throws(
  () => assertCapabilityDisclosureSuite(replaceCase(suite, 0, {
    ...suite.cases[0],
    sources: [],
  })),
  /sources.*non-empty array/i,
)
assert.throws(
  () => assertCapabilityDisclosureSuite(replaceCase(suite, 0, {
    ...suite.cases[0],
    sources: ['../outside.mjs#fixture'],
  })),
  /source reference/i,
)

console.log('capability-disclosure-eval-test: PASS')

function replaceCase(value, index, replacement) {
  return {
    ...value,
    cases: value.cases.map((item, itemIndex) => itemIndex === index ? replacement : item),
  }
}

async function assertSourceEvidence(value) {
  for (const evalCase of value.cases) {
    const excerpts = await Promise.all(evalCase.sources.map(async (source) => {
      const [relativePath, anchor] = source.split('#')
      const content = await readFile(new URL(`../${relativePath}`, import.meta.url), 'utf8')
      const anchorIndex = content.indexOf(anchor)
      assert.notEqual(anchorIndex, -1, `${evalCase.id}: missing source anchor ${source}`)
      return content.slice(Math.max(0, anchorIndex - 4_000), anchorIndex + 8_000)
    }))
    for (const tool of evalCase.requiredTools) {
      const callPattern = new RegExp(
        `(?:name\\s*:\\s*['\"]${tool}['\"]|call\\(\\s*['\"][^'\"]+['\"]\\s*,\\s*['\"]${tool}['\"])`,
      )
      assert(excerpts.some((excerpt) => callPattern.test(excerpt)), `${evalCase.id}: ${tool} is not called near its source anchor`)
    }
  }
}
