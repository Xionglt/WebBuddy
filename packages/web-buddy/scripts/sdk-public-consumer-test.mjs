#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const root = await mkdtemp(join(tmpdir(), 'web-buddy-sdk-consumer-'))
try {
  const consumerSource = consumerFixture()
  assert.equal(consumerSource.includes('/src/'), false)
  assert.equal(consumerSource.includes('@multi-functional-agent/web-buddy/'), false)
  await writeFile(join(root, 'package.json'), JSON.stringify({
    name: 'web-buddy-external-consumer-fixture',
    private: true,
    type: 'module',
  }, null, 2))
  await writeFile(join(root, 'consumer.mjs'), consumerSource)
  await writeFile(join(root, 'consumer.ts'), typeConsumerFixture())

  let tarball = process.env.WEB_BUDDY_TARBALL
  if (!tarball && process.env.WEB_BUDDY_PACK_CURRENT === '1') {
    const packed = JSON.parse(execFileSync('npm', [
      'pack',
      '--json',
      '--ignore-scripts',
      '--pack-destination',
      root,
    ], {
      cwd: packageRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
    }))
    if (!Array.isArray(packed) || typeof packed[0]?.filename !== 'string') {
      throw new Error('npm pack did not return a tarball filename')
    }
    assertPackageContents(packed[0])
    tarball = join(root, packed[0].filename)
  }
  if (tarball) {
    execFileSync('npm', [
      'install',
      '--ignore-scripts',
      '--no-package-lock',
      '--no-audit',
      '--no-fund',
      resolve(tarball),
    ], { cwd: root, stdio: 'inherit' })
    execFileSync(join(packageRoot, 'node_modules', '.bin', 'tsc'), [
      '--noEmit',
      '--strict',
      '--target',
      'ES2022',
      '--module',
      'NodeNext',
      '--moduleResolution',
      'NodeNext',
      '--skipLibCheck',
      'consumer.ts',
    ], { cwd: root, stdio: 'inherit' })
    execFileSync(process.execPath, ['consumer.mjs'], { cwd: root, stdio: 'inherit' })
  } else {
    await installSourcePackageProxy(root)
    const hook = join(root, 'source-hooks.mjs')
    await writeFile(hook, sourceHooks())
    execFileSync(process.execPath, [
      '--experimental-transform-types',
      '--import',
      hook,
      'consumer.mjs',
    ], { cwd: root, stdio: 'inherit' })
  }
  assertDeepImportBlocked(root)

  for (const example of [
    'examples/research/index.mjs',
    'examples/comparison/index.mjs',
    'examples/form-draft/index.mjs',
  ]) {
    const source = readFileSync(join(packageRoot, example), 'utf8')
    assert.equal(source.includes("from '@multi-functional-agent/web-buddy'"), true)
    assert.equal(source.includes('/src/'), false)
    assert.equal(source.includes('@multi-functional-agent/web-buddy/'), false)
  }
  console.log(`sdk-public-consumer-test: PASS (${tarball ? 'installed-tarball' : 'source-package-proxy'})`)
} finally {
  await rm(root, { recursive: true, force: true })
}

function assertPackageContents(pack) {
  const paths = new Set((pack.files ?? []).map((file) => file.path))
  for (const required of [
    'dist/public/index.js',
    'dist/public/index.d.ts',
    'examples/research/index.mjs',
    'examples/comparison/index.mjs',
    'examples/form-draft/index.mjs',
  ]) {
    assert(paths.has(required), `package is missing ${required}`)
  }
  assert.equal([...paths].some((path) => path.startsWith('src/')), false, 'package leaked source files')
}

function assertDeepImportBlocked(projectRoot) {
  const program = `
try {
  await import('@multi-functional-agent/web-buddy/dist/sdk/web-task.js')
  process.exitCode = 2
} catch (error) {
  if (error?.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') throw error
}
`
  execFileSync(process.execPath, ['--input-type=module', '--eval', program], {
    cwd: projectRoot,
    stdio: 'inherit',
  })
}

async function installSourcePackageProxy(projectRoot) {
  const proxyRoot = join(projectRoot, 'node_modules', '@multi-functional-agent', 'web-buddy')
  await mkdir(proxyRoot, { recursive: true })
  await writeFile(join(proxyRoot, 'package.json'), JSON.stringify({
    name: '@multi-functional-agent/web-buddy',
    version: '0.1.0-source-fixture',
    type: 'module',
    exports: {
      '.': './index.mjs',
    },
  }, null, 2))
  const publicSource = pathToFileURL(join(packageRoot, 'src', 'public', 'index.ts')).href
  await writeFile(join(proxyRoot, 'index.mjs'), `export * from ${JSON.stringify(publicSource)}\n`)
}

function consumerFixture() {
  return `import assert from 'node:assert/strict'
import {
  PUBLIC_SDK_VERSION,
  createResearchStarter,
  createSkillScaffold,
  runWebTask,
  snapshotWebTaskInput,
} from '@multi-functional-agent/web-buddy'

assert.equal(PUBLIC_SDK_VERSION, '1.0.0')
const input = createResearchStarter({
  schemaVersion: 'research-starter/v1',
  goal: 'External package consumer fixture.',
  startUrl: 'https://example.com/',
  runId: 'external-consumer-run',
})
assert.equal(snapshotWebTaskInput(input).runId, 'external-consumer-run')
assert.equal(createSkillScaffold({
  schemaVersion: 'public-skill-scaffold-request/v1',
  id: 'consumer-skill',
  version: '1.0.0',
  name: 'Consumer Skill',
  description: 'External fixture.',
  taskKinds: ['research'],
}).manifest.id, 'consumer-skill')
const result = await runWebTask({
  ...input,
  contextProviders: [{
    id: 'external-fixture-provider',
    version: '1.0.0',
    async provide() {
      throw new Error('external fixture completed before browser runtime')
    },
  }],
})
assert.equal(result.schemaVersion, 'web-task-result/v1')
assert.equal(result.status, 'failed')
assert.match(result.summary, /external fixture completed before browser runtime/)
console.log('external-consumer-fixture: PASS')
`
}

function typeConsumerFixture() {
  return `import {
  createResearchStarter,
  type PolicyHook,
  type RunClient,
  type SkillManifest,
  type WebTaskInput,
  type WebTaskResult,
} from '@multi-functional-agent/web-buddy'

const input: WebTaskInput = createResearchStarter({
  schemaVersion: 'research-starter/v1',
  goal: 'Type-only external fixture.',
  startUrl: 'https://example.com/',
})
declare const result: WebTaskResult
declare const hook: PolicyHook
declare const client: RunClient
declare const skill: SkillManifest
void [input, result, hook, client, skill]
`
}

function sourceHooks() {
  const sourceRoot = pathToFileURL(join(packageRoot, 'src')).href
  return `import { registerHooks } from 'node:module'
import { existsSync } from 'node:fs'
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      specifier.startsWith('.')
      && specifier.endsWith('.js')
      && context.parentURL?.startsWith(${JSON.stringify(sourceRoot)})
    ) {
      const url = new URL(specifier.slice(0, -3) + '.ts', context.parentURL)
      if (existsSync(url)) return { url: url.href, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
})
`
}
