import * as esbuild from 'esbuild'
import { mkdir, readdir } from 'node:fs/promises'
import { join } from 'node:path'

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
  target: 'node18',
  outdir: 'dist',
  sourcemap: true,
})

await esbuild.build({
  entryPoints: ['src/server.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  outfile: 'dist/server.js',
  banner: {
    js: '#!/usr/bin/env node',
  },
  external: ['playwright'],
})
