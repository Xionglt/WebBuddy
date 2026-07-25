#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import { createBlindMemoryFormDriver } from '../dist/evals/memory-form-assistance/blind-form-driver.js'
import { MEMORY_EVAL_FORM_DEFINITION } from '../dist/evals/memory-form-assistance/form-definition.js'

const source = await readFile(
  new URL('../src/evals/memory-form-assistance/blind-form-driver.ts', import.meta.url),
  'utf8',
)
for (const forbiddenImport of ['./schema', './runner', './report', 'memory-lifecycle', 'embedding-snapshot']) {
  assert(!source.includes(forbiddenImport), `blind driver must not import ${forbiddenImport}`)
}
for (const forbiddenIdentity of ['targetWriteAlias', 'forbiddenValues', '.memoryId', '.entryId']) {
  assert(!source.includes(forbiddenIdentity), `blind driver must not select answers through ${forbiddenIdentity}`)
}

await singleSafeValueIsFilled()
await selectedRadioValueIsReadBack()
await conflictingValuesAbstain()
await conflictBindingAbstains()
await unknownFieldsAreIgnored()
await readbackFailureBlocks()
await noContextBlocks()

console.log('memory-form-assistance-driver-test: PASS')

async function singleSafeValueIsFilled() {
  const harness = fakeBrowser()
  const runtime = createBlindMemoryFormDriver({
    form: MEMORY_EVAL_FORM_DEFINITION,
    browser: harness.browser,
    now: () => new Date('2026-07-26T00:00:00.000Z'),
  })
  const result = await runtime.driver.execute(request([
    memoryContext('language', 'English'),
  ], 'ORACLE_MUST_NOT_REACH_DRIVER'))
  assert.equal(result.status, 'completed')
  assert.deepEqual(harness.setCalls, [{
    sessionId: 'blind-driver-session',
    label: 'Language',
    fieldKey: 'select_native:name:language:1',
    fieldIndex: 1,
    controlKind: 'select_native',
    intendedValue: 'English',
  }])
  assert.equal(runtime.diagnostics().filledFields.language, 'English')
  assert.equal(runtime.diagnostics().runtimeSteps, 4)
  assert.equal(result.formState.submitted, false)
  assert.deepEqual(result.actions, [{ actionKind: 'submit', outcome: 'not_performed' }])
  assert(!JSON.stringify({ result, diagnostics: runtime.diagnostics(), calls: harness.setCalls })
    .includes('ORACLE_MUST_NOT_REACH_DRIVER'))
}

async function selectedRadioValueIsReadBack() {
  const harness = fakeBrowser({ radioGroupSnapshots: true })
  const runtime = createBlindMemoryFormDriver({ form: MEMORY_EVAL_FORM_DEFINITION, browser: harness.browser })
  const result = await runtime.driver.execute(request([
    memoryContext('workMode', 'Remote'),
  ]))
  assert.equal(result.status, 'completed')
  assert.deepEqual(runtime.diagnostics().filledFields, { workMode: 'Remote' })
  assert.deepEqual(runtime.diagnostics().failedFields, [])
}

async function conflictingValuesAbstain() {
  const harness = fakeBrowser()
  const runtime = createBlindMemoryFormDriver({ form: MEMORY_EVAL_FORM_DEFINITION, browser: harness.browser })
  const result = await runtime.driver.execute(request([
    memoryContext('city', 'Shanghai'),
    memoryContext('city', 'Shenzhen'),
  ]))
  assert.equal(result.status, 'blocked')
  assert.deepEqual(harness.setCalls, [])
  assert.deepEqual(runtime.diagnostics().abstainedFields, ['city'])
}

async function conflictBindingAbstains() {
  const harness = fakeBrowser()
  const runtime = createBlindMemoryFormDriver({ form: MEMORY_EVAL_FORM_DEFINITION, browser: harness.browser })
  const result = await runtime.driver.execute(request([
    memoryContext('workMode', 'Remote', { conflictIds: ['other-memory'] }),
  ]))
  assert.equal(result.status, 'blocked')
  assert.deepEqual(harness.setCalls, [])
  assert.deepEqual(runtime.diagnostics().abstainedFields, ['workMode'])
}

async function unknownFieldsAreIgnored() {
  const harness = fakeBrowser()
  const runtime = createBlindMemoryFormDriver({ form: MEMORY_EVAL_FORM_DEFINITION, browser: harness.browser })
  const result = await runtime.driver.execute(request([
    memoryContext('notAFormField', 'ignore me'),
  ]))
  assert.equal(result.status, 'blocked')
  assert.deepEqual(harness.setCalls, [])
}

async function readbackFailureBlocks() {
  const harness = fakeBrowser({ failField: 'timezone' })
  const runtime = createBlindMemoryFormDriver({ form: MEMORY_EVAL_FORM_DEFINITION, browser: harness.browser })
  const result = await runtime.driver.execute(request([
    memoryContext('timezone', 'UTC+8'),
  ]))
  assert.equal(result.status, 'blocked')
  assert.deepEqual(runtime.diagnostics().filledFields, {})
  assert.deepEqual(runtime.diagnostics().failedFields, ['timezone'])
}

async function noContextBlocks() {
  const harness = fakeBrowser()
  const runtime = createBlindMemoryFormDriver({ form: MEMORY_EVAL_FORM_DEFINITION, browser: harness.browser })
  const result = await runtime.driver.execute(request([]))
  assert.equal(result.status, 'blocked')
  assert.deepEqual(harness.setCalls, [])
  assert.equal(result.formState.submitted, false)
}

function fakeBrowser({ failField, radioGroupSnapshots = false } = {}) {
  const values = {}
  const setCalls = []
  const browser = {
    async open() {
      return { ok: true, data: { sessionId: 'blind-driver-session' }, observation: 'opened' }
    },
    async snapshot() {
      const fields = MEMORY_EVAL_FORM_DEFINITION.fields.flatMap((field, index) => {
        if (field.key !== 'workMode' || !radioGroupSnapshots) {
          return [{
            index,
            fieldKey: `${field.controlKind}:name:${field.key}:${index}`,
            label: field.label,
            name: field.key,
            controlKind: field.controlKind,
            required: field.required,
            value: values[field.key] ?? '',
            filled: Boolean(values[field.key]),
          }]
        }
        return ['Remote', 'Hybrid', 'Office'].map((value, optionIndex) => ({
          index: index + optionIndex,
          fieldKey: `radio:name:workMode:${optionIndex}`,
          label: value,
          name: 'workMode',
          controlKind: 'radio',
          required: optionIndex === 0,
          value: values.workMode === value ? value : '',
          filled: values.workMode === value,
        }))
      })
      return {
        ok: true,
        observation: 'snapshot',
        data: {
          fields,
          visibleErrors: [],
        },
      }
    },
    async setField(input) {
      setCalls.push(input)
      const field = MEMORY_EVAL_FORM_DEFINITION.fields.find((item) => item.label === input.label)
      if (field?.key === failField) {
        return { ok: false, observation: 'readback mismatch', error: { code: 'UNKNOWN', message: 'mismatch' } }
      }
      values[field.key] = input.intendedValue
      return {
        ok: true,
        observation: 'verified',
        data: { readback: { value: input.intendedValue }, attempts: [{ ok: true }] },
      }
    },
  }
  return { browser, setCalls }
}

function request(contextItems, oracleSentinel) {
  return {
    schemaVersion: 'web-task-runtime-request/v1',
    input: {
      schemaVersion: 'web-task-input-snapshot/v1',
      inputSchemaVersion: 'web-task-input/v1',
      runId: 'blind-driver-run',
      revision: 0,
      sha256: 'a'.repeat(64),
      goal: { instruction: 'Fill safe remembered preferences.', scenario: 'form_draft' },
      contract: { schemaVersion: 'web-task-contract/v1', contractId: 'blind', revision: 0, criteria: [] },
      startUrl: 'http://127.0.0.1:5199/form',
      contextItems: [],
      contextProviders: [],
      ...(oracleSentinel ? { oracleSentinel } : {}),
    },
    contextItems,
    runtime: { headless: true },
    emit() {},
  }
}

function memoryContext(fieldKey, value, memory = {}) {
  return {
    content: { kind: 'form_preference', fieldKey, value, statement: `${fieldKey} preference` },
    memory: { conflictIds: [], ...memory },
  }
}
