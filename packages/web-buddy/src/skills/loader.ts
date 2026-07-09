import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { LoadedSkill, SkillDefinition, SkillScope } from './types.js'

export interface SkillLoaderOptions {
  builtinRoot?: string
  projectRoots?: string[]
  userRoots?: string[]
  now?: Date
}

const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/m

export function loadSkills(options: SkillLoaderOptions = {}): LoadedSkill[] {
  const now = options.now ?? new Date()
  const roots = [
    { scope: 'builtin' as const, paths: [options.builtinRoot ?? defaultBuiltinRoot()] },
    { scope: 'project' as const, paths: options.projectRoots ?? readRootList('WEB_BUDDY_PROJECT_SKILL_ROOTS') },
    { scope: 'user' as const, paths: options.userRoots ?? readRootList('WEB_BUDDY_USER_SKILL_ROOTS') },
  ]
  const loaded: LoadedSkill[] = []

  for (const group of roots) {
    for (const root of group.paths) {
      loaded.push(...loadSkillRoot(root, group.scope, now))
    }
  }

  return loaded
}

export function loadSkillRoot(root: string, fallbackScope: SkillScope, now = new Date()): LoadedSkill[] {
  const resolvedRoot = resolve(root)
  if (!existsSync(resolvedRoot)) return []
  return findSkillFiles(resolvedRoot)
    .map((file) => loadSkillFile(file, fallbackScope, now))
    .filter((skill): skill is LoadedSkill => Boolean(skill))
}

export function loadSkillFile(file: string, fallbackScope: SkillScope, now = new Date()): LoadedSkill | undefined {
  const raw = readFileSync(file, 'utf8')
  const match = raw.match(FRONTMATTER_RE)
  if (!match) return undefined
  const manifest = JSON.parse(match[1]) as Omit<SkillDefinition, 'sourceUri' | 'loadedAt' | 'bodyHash'>
  const body = match[2].trim()
  const definition: SkillDefinition = {
    ...manifest,
    scope: manifest.scope ?? fallbackScope,
    sourceUri: file,
    loadedAt: now.toISOString(),
    bodyHash: createHash('sha256').update(body).digest('hex'),
  }
  validateSkillDefinition(definition, file)
  return { definition, body }
}

function findSkillFiles(root: string): string[] {
  const stats = statSync(root)
  if (stats.isFile()) return root.endsWith('.md') ? [root] : []
  const files: string[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) {
      files.push(...findSkillFiles(path))
    } else if (entry.isFile() && entry.name === 'SKILL.md') {
      files.push(path)
    }
  }
  return files.sort()
}

function validateSkillDefinition(definition: SkillDefinition, file: string): void {
  if (definition.schemaVersion !== 'web-buddy-skill/v1') throw new Error(`Invalid skill schemaVersion in ${file}`)
  if (!definition.id) throw new Error(`Missing skill id in ${file}`)
  if (!definition.name) throw new Error(`Missing skill name in ${file}`)
  if (!['managed', 'builtin', 'project', 'user'].includes(definition.scope)) throw new Error(`Invalid skill scope in ${file}`)
  if (!Number.isFinite(definition.priority)) throw new Error(`Invalid skill priority in ${file}`)
}

function defaultBuiltinRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  const sourceRoot = resolve(here, '..', '..', 'skills')
  if (existsSync(sourceRoot)) return sourceRoot
  return resolve(process.cwd(), 'skills')
}

function readRootList(envName: string): string[] {
  const raw = process.env[envName]
  if (!raw) return []
  return raw.split(':').map((part) => part.trim()).filter(Boolean)
}

