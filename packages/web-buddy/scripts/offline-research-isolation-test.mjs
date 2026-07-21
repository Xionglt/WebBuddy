#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const outputRoot = await mkdtemp(resolve(tmpdir(), 'web-buddy-offline-research-'))
const privateEndpoint = 'https://private-model.invalid/api'
const privateModel = 'private-model-fixture'
const privateResume = '/private/resume-fixture.pdf'

try {
  const { stdout } = await execFileAsync(
    process.execPath,
    ['./dist/cli/demo.js', 'demo-research', '--headless'],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        MODEL_PROVIDER: 'anthropic',
        ANTHROPIC_AUTH_TOKEN: 'private-token-fixture',
        ANTHROPIC_BASE_URL: privateEndpoint,
        ANTHROPIC_MODEL: privateModel,
        RESUME_PDF_PATH: privateResume,
        TRACE_OUT_DIR: outputRoot,
        PLAYWRIGHT_KEEP_BROWSER_OPEN: 'false',
        KEEP_BROWSER_OPEN: 'false',
      },
    },
  )

  assert.match(stdout, /model\s+: disabled \(offline fixture\)/)
  assert.doesNotMatch(stdout, new RegExp(privateEndpoint))
  assert.doesNotMatch(stdout, new RegExp(privateModel))
  assert.doesNotMatch(stdout, new RegExp(privateResume))

  const tracePath = stdout.match(/^ trace\s+: (.+)$/m)?.[1]
  assert(tracePath, 'demo-research output must include a trace path')
  const trace = await readFile(resolve(process.cwd(), tracePath), 'utf8')
  const boot = trace
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
    .find((entry) => entry.phase === 'boot')

  assert(boot, 'demo-research trace must include a boot event')
  assert.match(boot.action, /llm=false/)
  console.log('offline-research-isolation-test: PASS')
} finally {
  await rm(outputRoot, { recursive: true, force: true })
}
