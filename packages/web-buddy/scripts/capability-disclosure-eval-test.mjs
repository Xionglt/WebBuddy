#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'

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
    source: suite.cases[0].sources[0].path,
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
    sources: [{ path: '../outside.mjs', start: 'fixture', end: 'next' }],
  })),
  /source reference/i,
)
await assert.rejects(
  () => assertSourceEvidence(replaceCase(suite, 0, {
    ...suite.cases[0],
    requiredTools: [],
  })),
  /requiredTools must equal the complete source-bound tool call set/i,
)
await assert.rejects(
  () => assertSourceEvidence(replaceCase(suite, 0, {
    ...suite.cases[0],
    requiredTools: [...suite.cases[0].requiredTools, 'browser_open'],
  })),
  /requiredTools must equal the complete source-bound tool call set/i,
)
await assert.rejects(
  () => assertSourceEvidence(replaceCase(suite, 0, {
    ...suite.cases[0],
    sources: [{ ...suite.cases[0].sources[0], start: 'runLoopScenario({' }],
  })),
  /source start must be unique/i,
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
      const content = await readFile(new URL(`../${source.path}`, import.meta.url), 'utf8')
      assert.equal(countOccurrences(content, source.start), 1, `${evalCase.id}: source start must be unique`)
      assert.equal(countOccurrences(content, source.end), 1, `${evalCase.id}: source end must be unique`)
      const startIndex = content.indexOf(source.start)
      const endIndex = content.indexOf(source.end, startIndex + source.start.length)
      assert(endIndex > startIndex, `${evalCase.id}: source end must follow source start`)
      return content.slice(startIndex, endIndex)
    }))
    const observed = [...new Set(excerpts.flatMap(observedToolCalls))].sort()
    const required = [...evalCase.requiredTools].sort()
    assert.deepEqual(observed, required, `${evalCase.id}: requiredTools must equal the complete source-bound tool call set`)
  }
}

function observedToolCalls(excerpt) {
  const sourceFile = ts.createSourceFile('fixture.mjs', excerpt, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const tools = []
  visit(sourceFile)
  return tools

  function visit(node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'call') {
      const toolName = node.arguments[1]
      if (toolName && ts.isStringLiteral(toolName)) tools.push(toolName.text)
    }
    if (ts.isPropertyAssignment(node) && propertyName(node.name) === 'toolCalls' && ts.isArrayLiteralExpression(node.initializer)) {
      for (const element of node.initializer.elements) {
        if (!ts.isObjectLiteralExpression(element)) continue
        collectObjectToolName(element)
      }
    }
    if (ts.isPropertyAssignment(node) && propertyName(node.name) === 'call' && ts.isObjectLiteralExpression(node.initializer)) {
      collectObjectToolName(node.initializer)
    }
    ts.forEachChild(node, visit)
  }

  function collectObjectToolName(object) {
    const nameProperty = object.properties.find(
      (property) => ts.isPropertyAssignment(property) && propertyName(property.name) === 'name',
    )
    if (nameProperty && ts.isPropertyAssignment(nameProperty) && ts.isStringLiteral(nameProperty.initializer)) {
      tools.push(nameProperty.initializer.text)
    }
  }
}

function propertyName(name) {
  return ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : undefined
}

function countOccurrences(content, needle) {
  return content.split(needle).length - 1
}
