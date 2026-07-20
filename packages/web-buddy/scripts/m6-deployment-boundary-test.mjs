#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repositoryRoot = resolve(packageRoot, '..', '..')
const [dockerfile, compose, environmentExample, rootReadme, packageReadme] = await Promise.all([
  readFile(resolve(repositoryRoot, 'Dockerfile'), 'utf8'),
  readFile(resolve(repositoryRoot, 'docker-compose.yml'), 'utf8'),
  readFile(resolve(repositoryRoot, 'configs', 'agent.env.example'), 'utf8'),
  readFile(resolve(repositoryRoot, 'README.md'), 'utf8'),
  readFile(resolve(packageRoot, 'README.md'), 'utf8'),
])

assert.match(
  compose,
  /WEB_BUDDY_API_TOKEN:\s*"\$\{WEB_BUDDY_API_TOKEN:\?WEB_BUDDY_API_TOKEN is required\}"/,
  'Compose must require an operator-provided API token.',
)
assert.equal(
  (compose.match(/^\s+WEB_BUDDY_API_TOKEN:/gm) ?? []).length,
  1,
  'Compose must define the service-token boundary exactly once.',
)
assert.doesNotMatch(
  compose,
  /WEB_BUDDY_API_TOKEN:[^\n]*\$\{WEB_BUDDY_API_TOKEN:-/,
  'Compose must not fall back to a default API token.',
)
assert.match(
  dockerfile,
  /process\.env\.WEB_BUDDY_API_TOKEN/,
  'The container healthcheck must use the configured API token.',
)
assert.match(
  dockerfile,
  /authorization:\s*'Bearer '\s*\+\s*token/i,
  'The container healthcheck must authenticate its API request.',
)
assert.match(dockerfile, /127\.0\.0\.1:5178\/api\/config/, 'The healthcheck must target the protected config API.')
assert.match(
  dockerfile,
  /if\s*\(!token\)\s*process\.exit\(1\)/,
  'The container healthcheck must fail closed when no token is configured.',
)
assert.match(
  environmentExample,
  /^WEB_BUDDY_API_TOKEN=$/m,
  'The environment template must expose an empty service-token setting.',
)

for (const [label, readme] of [
  ['root README', rootReadme],
  ['package README', packageReadme],
]) {
  const bashBlocks = [...readme.matchAll(/```bash\n([\s\S]*?)```/g)]
    .map((match) => match[1])
    .join('\n')
  const unauthenticatedWebLaunch = [...readme.matchAll(/```bash\n([\s\S]*?)```/g)]
    .map((match) => match[1])
    .flatMap((block) => {
      let tokenConfigured = false
      return block.split('\n').filter((line) => {
        if (/^(?:export\s+)?WEB_BUDDY_API_TOKEN=/.test(line.trim())) tokenConfigured = true
        return /\bnpm run web\b/.test(line)
          && !line.trimStart().startsWith('#')
          && !tokenConfigured
          && !/WEB_BUDDY_API_TOKEN=/.test(line)
      })
    })[0]
  assert.equal(
    unauthenticatedWebLaunch,
    undefined,
    `${label} contains an unauthenticated Web launch command.`,
  )
  assert.match(
    bashBlocks,
    /WEB_BUDDY_API_TOKEN=[^\n]+\s+npm run web/,
    `${label} must show an authenticated service launch.`,
  )
  assert.match(
    bashBlocks,
    /export WEB_BUDDY_API_TOKEN=[^\n]+\n(?:docker compose build\n)?docker compose up agent/,
    `${label} must configure the service token before Compose startup.`,
  )
  assert.match(
    bashBlocks,
    /export WEB_BUDDY_API_TOKEN="\$\(openssl rand -hex 32\)"/,
    `${label} must generate a non-predictable example service token.`,
  )
  assert.doesNotMatch(readme, /local-dev-token/, `${label} must not recommend a predictable service token.`)
}

console.log('m6-deployment-boundary-test: PASS')
