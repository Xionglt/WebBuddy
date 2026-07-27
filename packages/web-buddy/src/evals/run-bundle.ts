import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join, relative, resolve, sep } from 'node:path'
import type { RunSource } from '../metrics/trace-inputs.js'
import {
  sanitizeForPersistence,
  type PersistenceSanitizer,
} from '../security/redaction.js'
import {
  evaluateCompletionContract,
  type CompletionContractEvaluation,
} from '../task/completion-contract.js'
import {
  digestCanonicalJson,
  validateArtifactRef,
  validateEvidenceRef,
  validateWebTaskInputSnapshot,
  type WebTaskInputSnapshot,
  type WebTaskResult,
} from '../task/contracts.js'
import type { RuntimeEvalSignals } from './runtime-schema.js'
import type { ExperimentRunPlan } from './experiment.js'

export type RunBundleFileRole =
  | 'input'
  | 'result'
  | 'completionEvaluation'
  | 'metrics'
  | 'signals'
  | 'traceSession'
  | 'spans'
  | 'events'
  | 'contexts'

export interface RunBundleFileRef {
  path: string
  bytes: number
  sha256: string
}

export interface RunBundleFingerprints {
  /** Digest of the immutable source snapshot before bundle redaction. */
  taskInputSha256: string
  /** Digest of the stored, potentially redacted snapshot. */
  persistedTaskInputSha256: string
  /** Digest of the source result before bundle redaction. */
  sourceResultSha256: string
  /** Digest of the stored, potentially redacted result. */
  persistedResultSha256: string
  /** Digest of the source completion contract. */
  completionContractSha256: string
  /** Digest of the completion contract stored in the bundle. */
  persistedCompletionContractSha256: string
  codeCommit?: string
  codeBranch?: string
  model?: string
  provider?: string
  modelParametersSha256?: string
  harnessVersion?: string
  harnessConfigSha256?: string
  systemPromptSha256?: string
  skillSetSha256?: string
  toolSchemaSha256?: string
  mcpSchemaSha256?: string
  contextPolicySha256?: string
  taskFixtureSha256?: string
  environmentSha256?: string
}

export interface RunBundleFiles {
  input?: RunBundleFileRef
  result?: RunBundleFileRef
  completionEvaluation?: RunBundleFileRef
  metrics?: RunBundleFileRef
  signals?: RunBundleFileRef
  traceSession?: RunBundleFileRef
  spans?: RunBundleFileRef
  events?: RunBundleFileRef
  contexts?: RunBundleFileRef
}

export interface RunBundleManifest {
  schemaVersion: 'run-bundle/v1'
  runId: string
  sessionId?: string
  revision: number
  source: RunSource
  scenario?: string
  profile?: string
  experiment?: ExperimentRunPlan
  createdAt: string
  persistence: {
    mode: 'redacted' | 'full'
    redactionApplied: boolean
  }
  fingerprints: RunBundleFingerprints
  missingFingerprints: string[]
  files: RunBundleFiles
  artifacts: RunBundleFileRef[]
  /** ArtifactRef payloads that could not be resolved from their opaque locators. */
  unbundledResultArtifactIds: string[]
  metadata?: Record<string, unknown>
  integrity: {
    algorithm: 'sha256'
    contentSha256: string
  }
}

export interface WriteRunBundleInput {
  outDir: string
  source: RunSource
  input: WebTaskInputSnapshot
  result: WebTaskResult
  sessionId?: string
  scenario?: string
  profile?: string
  experiment?: ExperimentRunPlan
  traceDir?: string
  signals?: RuntimeEvalSignals
  fingerprints?: Partial<Omit<
    RunBundleFingerprints,
    | 'taskInputSha256'
    | 'persistedTaskInputSha256'
    | 'sourceResultSha256'
    | 'persistedResultSha256'
    | 'completionContractSha256'
    | 'persistedCompletionContractSha256'
  >>
  persistenceMode?: 'redacted' | 'full'
  sanitize?: PersistenceSanitizer
  metadata?: Record<string, unknown>
  now?: Date
}

export interface WriteRunBundleResult {
  dir: string
  manifestPath: string
  manifest: RunBundleManifest
  completionEvaluation: CompletionContractEvaluation
}

export interface LoadedRunBundle {
  dir: string
  manifest: RunBundleManifest
  input: WebTaskInputSnapshot
  result: WebTaskResult
  completionEvaluation: CompletionContractEvaluation
  signals?: RuntimeEvalSignals
}

export interface VerifyRunBundleResult {
  valid: boolean
  errors: string[]
  manifest?: RunBundleManifest
}

const MANIFEST_FILE = 'run-bundle.json'
const RECOMMENDED_FINGERPRINTS: ReadonlyArray<keyof RunBundleFingerprints> = [
  'codeCommit',
  'model',
  'provider',
  'harnessVersion',
  'systemPromptSha256',
  'skillSetSha256',
  'toolSchemaSha256',
  'mcpSchemaSha256',
  'contextPolicySha256',
  'taskFixtureSha256',
  'environmentSha256',
]

export function writeRunBundle(input: WriteRunBundleInput): WriteRunBundleResult {
  validateBundleBindings(input.input, input.result)
  const outDir = resolve(input.outDir)
  mkdirSync(outDir, { recursive: true })
  const createdAt = (input.now ?? new Date()).toISOString()
  const persistenceMode = input.persistenceMode ?? 'redacted'
  const persistedInput = persistInput(input.input, persistenceMode, input.sanitize)
  const persistedResult = persistResult(input.result, persistenceMode, input.sanitize)
  const persistedSignals = input.signals
    ? persistSignals(input.signals, persistenceMode, input.sanitize)
    : undefined
  validateBundleBindings(persistedInput, persistedResult)
  const completionEvaluation = evaluateCompletionContract({
    contract: persistedInput.contract,
    runId: persistedResult.runId,
    revision: persistedResult.revision,
    evidence: persistedResult.evidence,
    artifacts: persistedResult.artifacts,
    formState: persistedResult.formState,
    actions: persistedResult.actions,
    now: new Date(createdAt),
  })
  const files = emptyBundleFiles()
  files.input = writeJsonArtifact(outDir, 'input.json', persistedInput)
  files.result = writeJsonArtifact(outDir, 'result.json', persistedResult)
  files.completionEvaluation = writeJsonArtifact(
    outDir,
    'completion-evaluation.json',
    completionEvaluation,
  )
  files.metrics = writeJsonArtifact(outDir, 'metrics.json', persistedResult.metrics)
  if (persistedSignals) files.signals = writeJsonArtifact(outDir, 'eval-signals.json', persistedSignals)

  const artifacts: RunBundleFileRef[] = []
  if (input.traceDir) {
    const traceDir = resolve(input.traceDir)
    files.traceSession = copyBundleFile(traceDir, 'session.json', outDir, 'trace/session.json')
    files.spans = copyBundleFile(traceDir, 'spans.jsonl', outDir, 'trace/spans.jsonl')
    files.events = copyBundleFile(traceDir, 'events.jsonl', outDir, 'trace/events.jsonl')
    files.contexts = copyBundleFile(traceDir, 'contexts.jsonl', outDir, 'trace/contexts.jsonl')
    artifacts.push(...copyArtifactTree(join(traceDir, 'artifacts'), outDir))
  }

  const fingerprints: RunBundleFingerprints = {
    ...persistValue(input.fingerprints ?? {}, persistenceMode, input.sanitize) as Partial<RunBundleFingerprints>,
    taskInputSha256: input.input.sha256,
    persistedTaskInputSha256: persistedInput.sha256,
    sourceResultSha256: digestCanonicalJson(compactJson(input.result)),
    persistedResultSha256: digestCanonicalJson(compactJson(persistedResult)),
    completionContractSha256: digestCanonicalJson(input.input.contract),
    persistedCompletionContractSha256: digestCanonicalJson(persistedInput.contract),
  }
  const missingFingerprints = RECOMMENDED_FINGERPRINTS
    .filter((key) => !fingerprints[key])
    .map(String)
  const unsigned = compactJson({
    schemaVersion: 'run-bundle/v1' as const,
    runId: input.result.runId,
    sessionId: input.sessionId ?? input.result.sessionRef?.id,
    revision: input.result.revision,
    source: input.source,
    scenario: input.scenario ?? input.input.goal.scenario,
    profile: input.profile,
    experiment: input.experiment,
    createdAt,
    persistence: {
      mode: persistenceMode,
      redactionApplied: input.input.sha256 !== persistedInput.sha256
        || fingerprints.sourceResultSha256 !== fingerprints.persistedResultSha256,
    },
    fingerprints,
    missingFingerprints,
    files,
    artifacts,
    unbundledResultArtifactIds: persistedResult.artifacts.map((artifact) => artifact.id),
    metadata: input.metadata
      ? persistValue(input.metadata, persistenceMode, input.sanitize)
      : undefined,
  })
  const manifest: RunBundleManifest = {
    ...unsigned as Omit<RunBundleManifest, 'integrity'>,
    integrity: {
      algorithm: 'sha256',
      contentSha256: digestCanonicalJson(unsigned),
    },
  }
  const manifestPath = join(outDir, MANIFEST_FILE)
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  return { dir: outDir, manifestPath, manifest, completionEvaluation }
}

export function verifyRunBundle(dir: string): VerifyRunBundleResult {
  const bundleDir = resolve(dir)
  const errors: string[] = []
  let manifest: RunBundleManifest
  try {
    manifest = readJson<RunBundleManifest>(join(bundleDir, MANIFEST_FILE))
  } catch (error) {
    return {
      valid: false,
      errors: [`failed to read ${MANIFEST_FILE}: ${message(error)}`],
    }
  }
  if (manifest.schemaVersion !== 'run-bundle/v1') {
    errors.push(`unsupported run bundle schema: ${String(manifest.schemaVersion)}`)
    return { valid: false, errors, manifest }
  }
  if (manifest.experiment) {
    if (manifest.experiment.schemaVersion !== 'experiment-run-plan/v1') {
      errors.push(`unsupported experiment run plan schema: ${String(manifest.experiment.schemaVersion)}`)
    }
    if (!Number.isSafeInteger(manifest.experiment.repetition)
      || manifest.experiment.repetition < 1) {
      errors.push('experiment repetition must be a positive integer')
    }
    if (!/^[a-f0-9]{64}$/i.test(manifest.experiment.definitionSha256)) {
      errors.push('experiment definitionSha256 must be a SHA-256 hex digest')
    }
    if (manifest.scenario && manifest.experiment.taskId !== manifest.scenario) {
      errors.push('experiment taskId does not match run bundle scenario')
    }
  }
  const { integrity, ...unsigned } = manifest
  const actualManifestDigest = digestCanonicalJson(unsigned)
  if (!integrity
    || integrity.algorithm !== 'sha256'
    || integrity.contentSha256 !== actualManifestDigest) {
    errors.push('run bundle manifest integrity mismatch')
  }
  if (!manifest.files || typeof manifest.files !== 'object' || Array.isArray(manifest.files)) {
    errors.push('run bundle files index is missing or invalid')
  } else {
    for (const [role, ref] of Object.entries(manifest.files)) {
      if (ref) verifyFileRef(bundleDir, ref, role, errors)
    }
  }
  if (!Array.isArray(manifest.artifacts)) {
    errors.push('run bundle artifacts index is missing or invalid')
  } else {
    manifest.artifacts.forEach((ref, index) => verifyFileRef(bundleDir, ref, `artifact[${index}]`, errors))
  }
  try {
    const input = readJson<WebTaskInputSnapshot>(bundleFilePath(bundleDir, requiredFile(manifest, 'input')))
    const result = readJson<WebTaskResult>(bundleFilePath(bundleDir, requiredFile(manifest, 'result')))
    const savedEvaluation = readJson<CompletionContractEvaluation>(
      bundleFilePath(bundleDir, requiredFile(manifest, 'completionEvaluation')),
    )
    const savedMetrics = readJson<WebTaskResult['metrics']>(
      bundleFilePath(bundleDir, requiredFile(manifest, 'metrics')),
    )
    validateWebTaskInputSnapshot(input)
    validateBundleBindings(input, result)
    if (manifest.runId !== result.runId || manifest.revision !== result.revision) {
      errors.push('run bundle manifest binding does not match result')
    }
    if (manifest.fingerprints.taskInputSha256 !== input.sha256) {
      if (manifest.persistence.mode === 'full') errors.push('source task input fingerprint mismatch')
    }
    if (manifest.fingerprints.persistedTaskInputSha256 !== input.sha256) {
      errors.push('persisted task input fingerprint mismatch')
    }
    if (manifest.fingerprints.persistedResultSha256 !== digestCanonicalJson(compactJson(result))) {
      errors.push('persisted result fingerprint mismatch')
    }
    if (manifest.fingerprints.persistedCompletionContractSha256 !== digestCanonicalJson(input.contract)) {
      errors.push('persisted completion contract fingerprint mismatch')
    }
    const unresolvedArtifactIds = [...result.artifacts.map((artifact) => artifact.id)].sort()
    if (!Array.isArray(manifest.unbundledResultArtifactIds)
      || digestCanonicalJson([...manifest.unbundledResultArtifactIds].sort())
        !== digestCanonicalJson(unresolvedArtifactIds)) {
      errors.push('unbundled result artifact index does not match result artifacts')
    }
    if (manifest.persistence.mode === 'full') {
      if (manifest.persistence.redactionApplied) {
        errors.push('full persistence bundle cannot report redactionApplied=true')
      }
      if (manifest.fingerprints.sourceResultSha256 !== manifest.fingerprints.persistedResultSha256) {
        errors.push('full persistence result fingerprints differ')
      }
      if (manifest.fingerprints.completionContractSha256
        !== manifest.fingerprints.persistedCompletionContractSha256) {
        errors.push('full persistence completion contract fingerprints differ')
      }
    }
    const recomputedEvaluation = evaluateCompletionContract({
      contract: input.contract,
      runId: result.runId,
      revision: result.revision,
      evidence: result.evidence,
      artifacts: result.artifacts,
      formState: result.formState,
      actions: result.actions,
      now: new Date(manifest.createdAt),
    })
    if (digestCanonicalJson(savedEvaluation) !== digestCanonicalJson(recomputedEvaluation)) {
      errors.push('saved completion evaluation does not match independently recomputed evaluation')
    }
    if (digestCanonicalJson(savedMetrics) !== digestCanonicalJson(result.metrics)) {
      errors.push('standalone metrics do not match result metrics')
    }
    if (manifest.files.signals) {
      const signals = readJson<RuntimeEvalSignals>(bundleFilePath(bundleDir, manifest.files.signals))
      if (signals.schemaVersion !== 'runtime-eval-signals/v1') {
        errors.push(`unsupported runtime eval signals schema: ${String(signals.schemaVersion)}`)
      }
    }
  } catch (error) {
    errors.push(`run bundle payload validation failed: ${message(error)}`)
  }
  return { valid: errors.length === 0, errors, manifest }
}

export function loadRunBundle(dir: string): LoadedRunBundle {
  const verified = verifyRunBundle(dir)
  if (!verified.valid || !verified.manifest) {
    throw new Error(`Invalid run bundle: ${verified.errors.join('; ')}`)
  }
  const bundleDir = resolve(dir)
  const manifest = verified.manifest
  const input = readJson<WebTaskInputSnapshot>(bundleFilePath(bundleDir, requiredFile(manifest, 'input')))
  const result = readJson<WebTaskResult>(bundleFilePath(bundleDir, requiredFile(manifest, 'result')))
  const completionEvaluation = readJson<CompletionContractEvaluation>(
    bundleFilePath(bundleDir, requiredFile(manifest, 'completionEvaluation')),
  )
  const signalsRef = manifest.files.signals
  const signals = signalsRef
    ? readJson<RuntimeEvalSignals>(bundleFilePath(bundleDir, signalsRef))
    : undefined
  return {
    dir: bundleDir,
    manifest,
    input,
    result,
    completionEvaluation,
    signals,
  }
}

function validateBundleBindings(input: WebTaskInputSnapshot, result: WebTaskResult): void {
  validateWebTaskInputSnapshot(input)
  if (result.schemaVersion !== 'web-task-result/v1') {
    throw new Error(`Unsupported run bundle result schema: ${String(result.schemaVersion)}.`)
  }
  if (!['completed', 'blocked', 'failed', 'cancelled'].includes(result.status)) {
    throw new Error(`Unsupported run bundle result status: ${String(result.status)}.`)
  }
  if (typeof result.summary !== 'string') throw new Error('Run bundle result summary must be text.')
  if (!Array.isArray(result.evidence) || !Array.isArray(result.artifacts)) {
    throw new Error('Run bundle result evidence and artifacts must be arrays.')
  }
  if (input.runId !== result.runId) {
    throw new Error(`Run bundle runId mismatch: input=${input.runId}, result=${result.runId}.`)
  }
  if (input.revision !== result.revision || input.contract.revision !== result.revision) {
    throw new Error('Run bundle revision does not match its input and completion contract.')
  }
  result.evidence.forEach((evidence) => validateEvidenceRef(evidence, result.runId, result.revision))
  result.artifacts.forEach((artifact) => validateArtifactRef(artifact, result.runId, result.revision))
  if (result.metrics?.schemaVersion !== 'run-metrics/v1') {
    throw new Error(`Unsupported run metrics schema: ${String(result.metrics?.schemaVersion)}.`)
  }
  if (result.metrics.runId && result.metrics.runId !== result.runId) {
    throw new Error('Run bundle metrics runId does not match the result.')
  }
}

function emptyBundleFiles(): RunBundleFiles {
  return {}
}

function writeJsonArtifact(dir: string, name: string, value: unknown): RunBundleFileRef {
  const path = join(dir, name)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  return fileRef(dir, path)
}

function copyBundleFile(
  sourceDir: string,
  sourceName: string,
  outDir: string,
  targetName: string,
): RunBundleFileRef | undefined {
  const source = join(sourceDir, sourceName)
  if (!existsSync(source) || !lstatSync(source).isFile()) return undefined
  const target = join(outDir, targetName)
  mkdirSync(dirname(target), { recursive: true })
  copyFileSync(source, target)
  return fileRef(outDir, target)
}

function copyArtifactTree(sourceDir: string, outDir: string): RunBundleFileRef[] {
  if (!existsSync(sourceDir) || !lstatSync(sourceDir).isDirectory()) return []
  const refs: RunBundleFileRef[] = []
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const source = join(dir, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        visit(source)
        continue
      }
      if (!entry.isFile()) continue
      const target = join(outDir, 'artifacts', relative(sourceDir, source))
      mkdirSync(dirname(target), { recursive: true })
      copyFileSync(source, target)
      refs.push(fileRef(outDir, target))
    }
  }
  visit(sourceDir)
  return refs.sort((left, right) => left.path.localeCompare(right.path))
}

function fileRef(root: string, path: string): RunBundleFileRef {
  const bytes = statSync(path).size
  return {
    path: relative(root, path).split(sep).join('/'),
    bytes,
    sha256: sha256File(path),
  }
}

function verifyFileRef(
  bundleDir: string,
  ref: RunBundleFileRef,
  label: string,
  errors: string[],
): void {
  let path: string
  try {
    path = bundleFilePath(bundleDir, ref)
  } catch (error) {
    errors.push(`${label}: ${message(error)}`)
    return
  }
  if (!existsSync(path) || !lstatSync(path).isFile()) {
    errors.push(`${label}: file not found: ${ref.path}`)
    return
  }
  if (statSync(path).size !== ref.bytes) errors.push(`${label}: byte length mismatch`)
  if (sha256File(path) !== ref.sha256) errors.push(`${label}: sha256 mismatch`)
}

function bundleFilePath(bundleDir: string, ref: RunBundleFileRef): string {
  if (!ref.path || ref.path.startsWith('/') || ref.path.includes('\0')) {
    throw new Error(`unsafe bundle path: ${JSON.stringify(ref.path)}`)
  }
  const path = resolve(bundleDir, ref.path)
  const prefix = `${resolve(bundleDir)}${sep}`
  if (!path.startsWith(prefix)) throw new Error(`bundle path escapes root: ${ref.path}`)
  return path
}

function requiredFile(
  manifest: RunBundleManifest,
  role: RunBundleFileRole,
): RunBundleFileRef {
  const ref = manifest.files[role]
  if (!ref) throw new Error(`run bundle is missing required file role ${role}`)
  return ref
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T
}

function persistInput(
  input: WebTaskInputSnapshot,
  mode: 'redacted' | 'full',
  sanitizer: PersistenceSanitizer | undefined,
): WebTaskInputSnapshot {
  const projection = mode === 'redacted'
    ? {
        ...input,
        contextItems: input.contextItems.map((item) => (
          item.sensitivity === 'public' || item.sensitivity === 'internal'
            ? item
            : { ...item, content: `[REDACTED:${item.sensitivity}]` }
        )),
      }
    : input
  const persisted = persistValue(projection, mode, sanitizer) as unknown as WebTaskInputSnapshot
  const { sha256: _sourceSha256, ...unsigned } = persisted
  return {
    ...unsigned,
    sha256: digestCanonicalJson(unsigned),
  }
}

function persistResult(
  result: WebTaskResult,
  mode: 'redacted' | 'full',
  sanitizer: PersistenceSanitizer | undefined,
): WebTaskResult {
  const projection = mode === 'redacted'
    ? {
        ...result,
        evidence: result.evidence.map((item) => (
          item.sensitivity === 'public' || item.sensitivity === 'internal'
            ? item
            : { ...item, summary: `[REDACTED:${item.sensitivity}]` }
        )),
      }
    : result
  return persistValue(projection, mode, sanitizer) as unknown as WebTaskResult
}

function persistValue(
  value: unknown,
  mode: 'redacted' | 'full',
  sanitizer: PersistenceSanitizer | undefined,
): unknown {
  if (mode === 'redacted') return sanitizeForPersistence(value, sanitizer)
  return compactJson(sanitizer ? sanitizer(value) : value)
}

function persistSignals(
  signals: RuntimeEvalSignals,
  mode: 'redacted' | 'full',
  sanitizer: PersistenceSanitizer | undefined,
): RuntimeEvalSignals {
  const notes = signals.notes
    ? persistValue(signals.notes, mode, sanitizer) as string[]
    : undefined
  return compactJson({
    ...signals,
    ...(notes ? { notes } : {}),
  })
}

function compactJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
