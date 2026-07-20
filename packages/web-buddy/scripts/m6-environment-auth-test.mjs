#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWebControlServer } from '../dist/web/server.js'

const token = `m6-environment-auth-${crypto.randomUUID()}`
const previousToken = process.env.WEB_BUDDY_API_TOKEN
const previousTokensJson = process.env.WEB_BUDDY_API_TOKENS_JSON
const root = await mkdtemp(join(tmpdir(), 'web-buddy-m6-environment-auth-'))
let configured
let unconfigured
try {
  delete process.env.WEB_BUDDY_API_TOKENS_JSON
  process.env.WEB_BUDDY_API_TOKEN = token
  configured = createWebControlServer({
    controlStoreDir: join(root, 'configured'),
    disableExecution: true,
  })
  const configuredBase = await listen(configured.server)
  assert.equal((await fetch(`${configuredBase}/api/config`)).status, 401)
  assert.equal((await fetch(`${configuredBase}/api/config`, {
    headers: { authorization: 'Bearer wrong-token' },
  })).status, 401)
  const authenticated = await fetch(`${configuredBase}/api/config`, {
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(authenticated.status, 200)
  assert.equal((await authenticated.text()).includes(token), false, 'service token leaked in config response')
  await configured.close()
  configured = undefined

  delete process.env.WEB_BUDDY_API_TOKEN
  unconfigured = createWebControlServer({
    controlStoreDir: join(root, 'unconfigured'),
    disableExecution: true,
  })
  const unconfiguredBase = await listen(unconfigured.server)
  assert.equal((await fetch(`${unconfiguredBase}/api/config`, {
    headers: { authorization: `Bearer ${token}` },
  })).status, 401, 'a service with no configured principal must fail closed')

  console.log('m6-environment-auth-test: PASS')
} finally {
  await configured?.close().catch(() => {})
  await unconfigured?.close().catch(() => {})
  if (previousToken === undefined) delete process.env.WEB_BUDDY_API_TOKEN
  else process.env.WEB_BUDDY_API_TOKEN = previousToken
  if (previousTokensJson === undefined) delete process.env.WEB_BUDDY_API_TOKENS_JSON
  else process.env.WEB_BUDDY_API_TOKENS_JSON = previousTokensJson
  await rm(root, { recursive: true, force: true })
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert(address && typeof address === 'object')
  return `http://127.0.0.1:${address.port}`
}
