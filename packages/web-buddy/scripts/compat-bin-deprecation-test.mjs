#!/usr/bin/env node
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'

for (const fixture of [
  {
    name: 'job-agent',
    entry: './dist/cli/job-agent.js',
    replacement: 'web-agent',
  },
  {
    name: 'job-agent-web',
    entry: './dist/web/job-agent-web.js',
    replacement: 'web-agent-web',
  },
]) {
  const result = spawnSync(process.execPath, [fixture.entry, '--help'], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, `${fixture.name} compatibility wrapper failed: ${result.stderr}`)
  assert.match(result.stderr, /\[deprecated\]/)
  assert.match(result.stderr, new RegExp(fixture.name))
  assert.match(result.stderr, new RegExp(fixture.replacement))
}

console.log('compat-bin-deprecation-test: PASS')
