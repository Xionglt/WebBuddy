#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { assertMemoryFormAssistanceSuite } from '../dist/evals/memory-form-assistance/schema.js'
import { memoryContentHash } from '../dist/memory/memory-write-policy.js'

const args = parseArgs(process.argv.slice(2))
const suite = JSON.parse(await readFile(args.cases, 'utf8'))
assertMemoryFormAssistanceSuite(suite)

const inputs = new Map()
for (const evalCase of suite.cases) {
  addInput('query', evalCase.goal.instruction)
  for (const write of evalCase.writes) {
    const text = canonicalJson(write.content)
    const sha256 = memoryContentHash(write.content)
    if (digest(text) !== sha256) throw new Error(`Canonical Memory hash drifted for ${evalCase.id}.`)
    addInput('memory_content', text, sha256)
  }
}
const manifest = {
  schemaVersion: 'memory-embedding-input-manifest/v1',
  inputs: [...inputs.values()].sort((left, right) => (
    left.kind.localeCompare(right.kind) || left.sha256.localeCompare(right.sha256)
  )),
}
await writeFile(args.out, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
console.log(JSON.stringify({ out: args.out, inputs: manifest.inputs.length }))

function addInput(kind, text, sha256 = digest(text)) {
  const key = `${kind}:${sha256}`
  const existing = inputs.get(key)
  if (existing && existing.text !== text) throw new Error(`Embedding input hash collision: ${key}`)
  inputs.set(key, { kind, sha256, text })
}

function parseArgs(values) {
  let cases = resolve('evals/memory-form-assistance/cases.json')
  let out = resolve('evals/memory-form-assistance/embedding-inputs.json')
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === '--cases') cases = resolve(requireValue(values, ++index, '--cases'))
    else if (values[index] === '--out') out = resolve(requireValue(values, ++index, '--out'))
    else throw new Error(`Unknown argument: ${values[index]}`)
  }
  return { cases, out }
}

function requireValue(values, index, label) {
  if (!values[index]) throw new Error(`${label} requires a value.`)
  return values[index]
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex')
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
}
