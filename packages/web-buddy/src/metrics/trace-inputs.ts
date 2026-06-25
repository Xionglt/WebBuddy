import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

export type RunSource =
  | 'sdk'
  | 'local-runtime'
  | 'cli-demo'
  | 'web-ui'
  | 'benchmark'
  | 'claude-runtime'
  | 'claude-adapter'
  | 'mcp-server'
  | 'unknown'

export interface TraceInputFiles {
  sessionJson?: string
  spansJsonl?: string
  eventsJsonl?: string
  legacyTraceJsonl?: string
  summaryJson?: string
  stdoutLog?: string
  stderrLog?: string
  streamJsonl?: string
  runLog?: string
  prompt?: string
}

export interface RunManifest {
  schemaVersion: 'run-manifest/v1'
  runId: string
  sessionId: string
  source: RunSource
  scenario?: string
  profile?: string
  runDir?: string
  traceDir: string
  legacyTraceDir?: string
  createdAt: string
  files: TraceInputFiles
  metadata?: Record<string, unknown>
}

export interface BuildRunManifestInput {
  runId: string
  sessionId: string
  source: RunSource
  scenario?: string
  profile?: string
  runDir?: string
  traceDir: string
  legacyTraceDir?: string
  files?: TraceInputFiles
  metadata?: Record<string, unknown>
}

export interface ResolveTraceInputsOptions {
  runId?: string
  sessionId?: string
  source?: RunSource
  scenario?: string
  profile?: string
  traceDir?: string
  runDir?: string
  outputDir?: string
}

export interface ResolvedTraceInputs {
  runId?: string
  sessionId?: string
  source: RunSource
  scenario?: string
  profile?: string
  traceDir?: string
  runDir?: string
  legacyTraceDir?: string
  manifestPath?: string
  files: TraceInputFiles
  warnings: string[]
}

const MANIFEST_NAME = 'run-manifest.json'

export function manifestPathForTraceDir(traceDir: string): string {
  return join(traceDir, MANIFEST_NAME)
}

export function buildRunManifest(input: BuildRunManifestInput): RunManifest {
  const traceDir = resolve(input.traceDir)
  const runDir = input.runDir ? resolve(input.runDir) : undefined
  const legacyTraceDir = input.legacyTraceDir ? resolve(input.legacyTraceDir) : undefined
  const defaultFiles: TraceInputFiles = {
    sessionJson: join(traceDir, 'session.json'),
    spansJsonl: join(traceDir, 'spans.jsonl'),
    eventsJsonl: join(traceDir, 'events.jsonl'),
    legacyTraceJsonl: legacyTraceDir ? join(legacyTraceDir, 'trace.jsonl') : undefined,
    summaryJson: legacyTraceDir ? join(legacyTraceDir, 'summary.json') : undefined,
    stdoutLog: runDir ? join(runDir, 'stdout.log') : undefined,
    stderrLog: runDir ? join(runDir, 'stderr.log') : undefined,
    streamJsonl: runDir ? join(runDir, 'stream.jsonl') : undefined,
    runLog: runDir ? join(runDir, 'run-events.log') : undefined,
  }

  return stripUndefined({
    schemaVersion: 'run-manifest/v1',
    runId: input.runId,
    sessionId: input.sessionId,
    source: input.source,
    scenario: input.scenario,
    profile: input.profile,
    runDir,
    traceDir,
    legacyTraceDir,
    createdAt: new Date().toISOString(),
    files: stripUndefined({ ...defaultFiles, ...input.files }),
    metadata: input.metadata,
  }) as RunManifest
}

export function writeRunManifest(manifest: RunManifest, path = manifestPathForTraceDir(manifest.traceDir)): string {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(manifest, null, 2))
  return path
}

export function resolveTraceInputs(options: ResolveTraceInputsOptions = {}): ResolvedTraceInputs {
  const warnings: string[] = []
  const outputDir = resolve(options.outputDir || join(process.cwd(), 'output'))
  const manifest = readBestManifest(options, outputDir, warnings)
  if (manifest) return resolveFromManifest(manifest.path, manifest.value, options, warnings)

  const source = options.source || 'unknown'
  const runId = options.runId
  const sessionId = options.sessionId || inferSessionId({ runId, source, outputDir })
  const traceDir = options.traceDir
    ? resolve(options.traceDir)
    : sessionId
      ? join(outputDir, 'traces', sessionId)
      : undefined
  const runDir = options.runDir
    ? resolve(options.runDir)
    : runId && (source === 'claude-runtime' || source === 'claude-adapter')
      ? join(outputDir, 'claude-runtime', runId)
      : undefined
  const legacyTraceDir = runId ? join(outputDir, runId) : undefined

  const files = collectExistingFiles({
    sessionJson: traceDir ? join(traceDir, 'session.json') : undefined,
    spansJsonl: traceDir ? join(traceDir, 'spans.jsonl') : undefined,
    eventsJsonl: traceDir ? join(traceDir, 'events.jsonl') : undefined,
    legacyTraceJsonl: legacyTraceDir ? join(legacyTraceDir, 'trace.jsonl') : undefined,
    summaryJson: legacyTraceDir ? join(legacyTraceDir, 'summary.json') : undefined,
    stdoutLog: runDir ? join(runDir, 'stdout.log') : undefined,
    stderrLog: runDir ? join(runDir, 'stderr.log') : undefined,
    streamJsonl: runDir ? join(runDir, 'stream.jsonl') : undefined,
    runLog: runDir ? join(runDir, 'run-events.log') : undefined,
  }, warnings)

  const session = readSessionFallback(files.sessionJson, warnings)
  const resolvedRunId = runId || session?.runId
  const resolvedSessionId = sessionId || session?.sessionId
  const resolvedSource = options.source || normalizeRunSource(session?.source) || source
  const resolvedScenario = options.scenario || session?.scenario
  const resolvedProfile = options.profile || session?.profile

  if (!runId && !sessionId && !traceDir && !runDir) {
    warnings.push('No runId, sessionId, traceDir, or runDir was provided; trace inputs could not be inferred.')
  }
  if (traceDir && !existsSync(traceDir)) warnings.push(`Trace directory not found: ${traceDir}`)
  if (runDir && !existsSync(runDir)) warnings.push(`Runtime directory not found: ${runDir}`)

  return stripUndefined({
    runId: resolvedRunId,
    sessionId: resolvedSessionId,
    source: resolvedSource,
    scenario: resolvedScenario,
    profile: resolvedProfile,
    traceDir,
    runDir,
    legacyTraceDir,
    files,
    warnings,
  }) as ResolvedTraceInputs
}

function readBestManifest(
  options: ResolveTraceInputsOptions,
  outputDir: string,
  warnings: string[],
): { path: string; value: RunManifest } | undefined {
  const candidates: string[] = []
  if (options.traceDir) candidates.push(manifestPathForTraceDir(resolve(options.traceDir)))
  if (options.runId) {
    const sessionCandidates = [
      options.sessionId,
      `run_${options.runId}`,
      `claude_${options.runId}`,
    ].filter((item): item is string => Boolean(item))
    for (const sessionId of sessionCandidates) {
      candidates.push(manifestPathForTraceDir(join(outputDir, 'traces', sessionId)))
    }
  }

  for (const path of unique(candidates)) {
    if (!existsSync(path)) continue
    try {
      const value = JSON.parse(readFileSync(path, 'utf8')) as RunManifest
      if (value.schemaVersion !== 'run-manifest/v1') {
        warnings.push(`Ignoring unsupported run manifest schema at ${path}.`)
        continue
      }
      return { path, value }
    } catch (error) {
      warnings.push(`Failed to read run manifest ${path}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return undefined
}

function resolveFromManifest(
  path: string,
  manifest: RunManifest,
  options: ResolveTraceInputsOptions,
  warnings: string[],
): ResolvedTraceInputs {
  const traceDir = resolve(manifest.traceDir)
  const runDir = manifest.runDir ? resolve(manifest.runDir) : undefined
  const legacyTraceDir = manifest.legacyTraceDir ? resolve(manifest.legacyTraceDir) : undefined
  const files = collectExistingFiles(normalizeFiles(manifest.files), warnings)

  if (!existsSync(traceDir)) warnings.push(`Trace directory not found: ${traceDir}`)
  if (runDir && !existsSync(runDir)) warnings.push(`Runtime directory not found: ${runDir}`)

  return stripUndefined({
    runId: manifest.runId,
    sessionId: manifest.sessionId,
    source: manifest.source,
    scenario: manifest.scenario,
    profile: manifest.profile || options.profile,
    traceDir,
    runDir,
    legacyTraceDir,
    manifestPath: path,
    files,
    warnings,
  }) as ResolvedTraceInputs
}

function normalizeFiles(files: TraceInputFiles): TraceInputFiles {
  const out: TraceInputFiles = {}
  for (const [key, value] of Object.entries(files) as Array<[keyof TraceInputFiles, string | undefined]>) {
    if (value) out[key] = resolve(value)
  }
  return out
}

function readSessionFallback(
  file: string | undefined,
  warnings: string[],
): { runId?: string; sessionId?: string; source?: string; scenario?: string; profile?: string } | undefined {
  if (!file || !existsSync(file)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as {
      runId?: string
      sessionId?: string
      source?: string
      scenario?: string
      profile?: string
      metadata?: { value?: { profile?: string }; profile?: string }
    }
    return {
      runId: parsed.runId,
      sessionId: parsed.sessionId,
      source: parsed.source,
      scenario: parsed.scenario,
      profile: parsed.profile || parsed.metadata?.profile || parsed.metadata?.value?.profile,
    }
  } catch (error) {
    warnings.push(`Failed to read trace session fallback ${file}: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
}

function collectExistingFiles(files: TraceInputFiles, warnings: string[]): TraceInputFiles {
  const out: TraceInputFiles = {}
  for (const [key, value] of Object.entries(files) as Array<[keyof TraceInputFiles, string | undefined]>) {
    if (!value) continue
    if (existsSync(value)) out[key] = value
    else warnings.push(`Trace input file not found: ${key}=${value}`)
  }
  return out
}

function inferSessionId(input: { runId?: string; source: RunSource; outputDir: string }): string | undefined {
  const { runId, source, outputDir } = input
  if (!runId) return undefined
  if (source === 'sdk' || source === 'local-runtime' || source === 'cli-demo' || source === 'web-ui' || source === 'benchmark') return `run_${runId}`
  if (source === 'claude-runtime' || source === 'claude-adapter') return `claude_${runId}`

  const sdk = `run_${runId}`
  if (existsSync(join(outputDir, 'traces', sdk))) return sdk
  const claude = `claude_${runId}`
  if (existsSync(join(outputDir, 'traces', claude))) return claude
  return sdk
}

function normalizeRunSource(value: string | undefined): RunSource | undefined {
  if (!value) return undefined
  const sources: RunSource[] = [
    'sdk',
    'local-runtime',
    'cli-demo',
    'web-ui',
    'benchmark',
    'claude-runtime',
    'claude-adapter',
    'mcp-server',
    'unknown',
  ]
  return sources.includes(value as RunSource) ? value as RunSource : undefined
}

function stripUndefined<T>(value: T): T {
  if (!value || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map((item) => stripUndefined(item)) as T
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (item === undefined) continue
    out[key] = stripUndefined(item)
  }
  return out as T
}

function unique(items: string[]): string[] {
  return [...new Set(items)]
}

export function inferRunIdFromSessionId(sessionId: string): string {
  if (sessionId.startsWith('run_')) return sessionId.slice('run_'.length)
  if (sessionId.startsWith('claude_')) return sessionId.slice('claude_'.length)
  return basename(sessionId)
}
