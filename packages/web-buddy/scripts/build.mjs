import * as esbuild from 'esbuild'
import { execFile } from 'node:child_process'
import { mkdir, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

await mkdir('dist', { recursive: true })

async function collectEntryPoints(dir, base = 'src') {
  const entries = []
  for (const name of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, name.name)
    if (name.isDirectory()) {
      entries.push(...(await collectEntryPoints(path, base)))
      continue
    }
    if (name.name.endsWith('.ts')) {
      entries.push(path)
    }
  }
  return entries
}

const entryPoints = await collectEntryPoints('src')

await esbuild.build({
  entryPoints,
  bundle: false,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outdir: 'dist',
  sourcemap: true,
})

// Bundled, executable entry points. play* heavy deps stay external:
//  - playwright (the browser driver, already a runtime dep)
//  - pdfjs-dist (dynamic-imported by the resume parser at runtime)
const EXTERNAL = ['playwright', 'pdfjs-dist']

await esbuild.build({
  entryPoints: ['src/server.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: 'dist/server.js',
  banner: { js: '#!/usr/bin/env node' },
  external: EXTERNAL,
})

await esbuild.build({
  entryPoints: ['src/cli/demo.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: 'dist/cli/demo.js',
  banner: { js: '#!/usr/bin/env node' },
  external: EXTERNAL,
})

await esbuild.build({
  entryPoints: ['src/cli/job-agent.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: 'dist/cli/job-agent.js',
  banner: { js: '#!/usr/bin/env node' },
  external: EXTERNAL,
})

await esbuild.build({
  entryPoints: ['src/cli/runtime-artifact-eval.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: 'dist/cli/runtime-artifact-eval.js',
  banner: { js: '#!/usr/bin/env node' },
})

await esbuild.build({
  entryPoints: ['src/cli/skill-candidates.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: 'dist/cli/skill-candidates.js',
  banner: { js: '#!/usr/bin/env node' },
})

// Web UI server. index.html is inlined as a text module (single-file bundle).
await esbuild.build({
  entryPoints: ['src/web/server.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: 'dist/web/server.js',
  banner: { js: '#!/usr/bin/env node' },
  external: EXTERNAL,
  loader: { '.html': 'text' },
})

await esbuild.build({
  entryPoints: ['src/web/job-agent-web.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: 'dist/web/job-agent-web.js',
  banner: { js: '#!/usr/bin/env node' },
  external: EXTERNAL,
  loader: { '.html': 'text' },
})

await execFileAsync(process.execPath, [
  './node_modules/typescript/bin/tsc',
  '--project',
  'tsconfig.public.json',
])

const publicDeclarationFiles = (await readdir('dist/public'))
  .filter((name) => name.endsWith('.d.ts'))
for (const name of publicDeclarationFiles) {
  const declaration = await readFile(join('dist/public', name), 'utf8')
  if (/\bfrom\s+['"]\.\.\//.test(declaration)) {
    throw new Error(`Public declaration graph escapes the stable public directory: ${name}`)
  }
  for (const forbidden of [
    'playwright',
    'WebTaskRuntimeDriver',
    'RuntimeOptions',
    'RunService',
    'FileRunStore',
    'FileApprovalStore',
    'runJobApplicationAgent',
    'AgentRunResult',
  ]) {
    if (declaration.includes(forbidden)) {
      throw new Error(`Public declaration exposes forbidden symbol ${forbidden}: ${name}`)
    }
  }
}
