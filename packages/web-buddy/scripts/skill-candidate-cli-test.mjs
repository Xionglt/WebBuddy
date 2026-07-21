#!/usr/bin/env node
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { writeSkillCandidateFixture } from './skill-candidate-fixture.mjs'

const root = await mkdtemp(join(tmpdir(), 'web-buddy-skill-candidate-cli-'))

try {
  const storeDir = join(root, 'candidate-store')
  const fixtureRoot = join(root, 'generate-traces')
  const firstFixture = await writeSkillCandidateFixture(fixtureRoot, {
    name: 'first',
    runId: 'skill-candidate-cli-first',
  })

  const generated = await runCli([
    'candidate',
    'generate',
    '--trace-dir',
    firstFixture.traceDir,
    '--store',
    storeDir,
  ])
  assert.equal(generated.code, 0, generated.stderr)
  const generatedResult = JSON.parse(generated.stdout)
  assert.equal(generatedResult.status, 'generated')
  const candidateId = generatedResult.receipt.candidateId
  assert.match(candidateId, /^candidate_[a-f0-9]{24}$/)

  const replayed = await runCli([
    'candidate',
    'generate',
    '--trace-dir',
    firstFixture.traceDir,
    '--store',
    storeDir,
  ])
  assert.equal(replayed.code, 0, replayed.stderr)
  assert.equal(JSON.parse(replayed.stdout).status, 'generated')

  const secondFixture = await writeSkillCandidateFixture(fixtureRoot, {
    name: 'second',
    runId: 'skill-candidate-cli-second',
  })
  const duplicate = await runCli([
    'candidate',
    'generate',
    '--trace-dir',
    secondFixture.traceDir,
    '--store',
    storeDir,
  ])
  assert.equal(duplicate.code, 0, duplicate.stderr)
  assert.equal(JSON.parse(duplicate.stdout).status, 'duplicate')

  const listed = await runCli(['candidate', 'list', '--store', storeDir])
  assert.equal(listed.code, 0, listed.stderr)
  const candidates = JSON.parse(listed.stdout)
  assert.equal(candidates.length, 1)
  assert.equal(candidates[0].candidateId, candidateId)
  assert.equal(listed.stdout.includes(firstFixture.traceDir), false)

  const shown = await runCli(['candidate', 'show', candidateId, '--store', storeDir])
  assert.equal(shown.code, 0, shown.stderr)
  assert.equal(JSON.parse(shown.stdout).candidateId, candidateId)
  assert.equal(shown.stdout.includes(firstFixture.traceDir), false)

  const missing = await runCli(['candidate', 'show', 'missing', '--store', storeDir])
  assert.equal(missing.code, 2)
  assert.match(missing.stderr, /skill candidates: ERROR:/)

  const missingTraceDir = await runCli(['candidate', 'generate', '--store', storeDir])
  assert.equal(missingTraceDir.code, 2)
  assert.match(missingTraceDir.stderr, /Missing required option: --trace-dir/)

  const ineligibleFixture = await writeSkillCandidateFixture(root, {
    name: 'ineligible',
    runId: 'skill-candidate-cli-ineligible',
    outcomeStatus: 'blocked',
  })
  const ineligible = await runCli([
    'candidate',
    'generate',
    '--trace-dir',
    ineligibleFixture.traceDir,
    '--store',
    join(root, 'ineligible-store'),
  ])
  assert.equal(ineligible.code, 1, ineligible.stderr)
  assert.equal(JSON.parse(ineligible.stdout).status, 'ineligible')

  const pendingRoot = join(root, 'pending-traces')
  await Promise.all([
    writeSkillCandidateFixture(pendingRoot, {
      name: 'trace-a',
      runId: 'skill-candidate-cli-pending-a',
    }),
    writeSkillCandidateFixture(pendingRoot, {
      name: 'trace-b',
      runId: 'skill-candidate-cli-pending-b',
    }),
  ])
  const pendingStore = join(root, 'pending-store')
  const processed = await runCli([
    'candidate',
    'process-pending',
    '--trace-root',
    pendingRoot,
    '--store',
    pendingStore,
  ])
  assert.equal(processed.code, 0, processed.stderr)
  const processedResults = JSON.parse(processed.stdout)
  assert.equal(processedResults.length, 2)
  assert.deepEqual(
    processedResults.map((result) => result.status).sort(),
    ['duplicate', 'generated'],
  )
  assert.equal(processed.stdout.includes(pendingRoot), false)

  const pendingCandidates = await runCli(['candidate', 'list', '--store', pendingStore])
  assert.equal(pendingCandidates.code, 0, pendingCandidates.stderr)
  assert.equal(JSON.parse(pendingCandidates.stdout).length, 1)

  console.log('skill-candidate-cli-test: PASS')
} finally {
  await rm(root, { recursive: true, force: true })
}

async function runCli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['dist/cli/skill-candidates.js', ...args], {
      cwd: new URL('..', import.meta.url),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}
