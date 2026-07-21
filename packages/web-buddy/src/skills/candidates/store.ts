import { createHash, randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import {
  link,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import {
  assertSkillCandidate,
  assertSkillGenerationReceipt,
  assertSkillGenerationRequest,
  type SkillCandidateV1,
  type SkillGenerationReceiptV1,
  type SkillGenerationRequestV1,
} from './contracts.js'
import { skillCandidateFingerprint } from './validator.js'

const SAFE_ID = /^[a-zA-Z0-9._-]{1,120}$/
const SHA256 = /^[a-f0-9]{64}$/

export function generationRequestId(input: {
  runId: string
  revision: number
  sessionId: string
  attempt: number
  outcomeArtifactId: string
  outcomeSha256: string
}): string {
  return `request_${sha256Canonical({
    runId: input.runId,
    revision: input.revision,
    sessionId: input.sessionId,
    attempt: input.attempt,
    outcomeArtifactId: input.outcomeArtifactId,
    outcomeSha256: input.outcomeSha256,
  }).slice(0, 24)}`
}

export function candidateIdForFingerprint(fingerprint: string): string {
  if (!SHA256.test(fingerprint)) throw new Error('INVALID_CANDIDATE_FINGERPRINT')
  return `candidate_${fingerprint.slice(0, 24)}`
}

export function defaultSkillCandidateRoot(
  env: Record<string, string | undefined> = process.env,
): string {
  return resolve(env.WEB_BUDDY_SKILL_CANDIDATE_ROOT || join(process.cwd(), 'output', 'skill-candidates'))
}

export class FileSkillCandidateStore {
  private readonly rootDir: string

  constructor(options: {
    rootDir: string
    now?: () => Date
    env?: Record<string, string | undefined>
  }) {
    this.rootDir = resolve(options.rootDir)
    assertCandidateRootSeparated(this.rootDir, options.env ?? process.env)
  }

  async writeRequest(traceDir: string, request: SkillGenerationRequestV1): Promise<string> {
    assertSkillGenerationRequest(request)
    assertRequestId(request.requestId)
    const traceRoot = await existingDirectory(traceDir, 'TRACE_DIR_NOT_FOUND')
    const requestDir = join(resolve(traceDir), 'skill-learning', 'requests')
    await mkdir(requestDir, { recursive: true })
    await assertDirectoryWithin(requestDir, traceRoot, 'REQUEST_PATH_OUTSIDE_TRACE')
    const target = join(requestDir, `${request.requestId}.json`)
    if (request.requestId !== generationRequestId(request)) {
      if (await regularFileExists(target)) {
        throw new Error('GENERATION_REQUEST_CONFLICT: request id is bound to different evidence')
      }
      throw new Error('INVALID_REQUEST_ID: request id does not match bound evidence')
    }
    const result = await writeImmutableJson(
      target,
      request,
      'GENERATION_REQUEST_CONFLICT',
      equivalentGenerationRequest,
    )
    return result.path
  }

  async readRequest(path: string): Promise<SkillGenerationRequestV1> {
    const resolvedPath = resolve(path)
    const request = await readValidatedJson(resolvedPath, assertSkillGenerationRequest)
    if (basename(resolvedPath) !== `${request.requestId}.json`) {
      throw new Error('REQUEST_FILE_ID_MISMATCH')
    }
    if (request.requestId !== generationRequestId(request)) {
      throw new Error('INVALID_REQUEST_ID: request id does not match bound evidence')
    }
    return request
  }

  async writeCandidate(candidate: SkillCandidateV1): Promise<{ path: string; created: boolean }> {
    assertSkillCandidate(candidate)
    assertCandidateId(candidate.candidateId)
    assertCandidateIntegrity(candidate)
    const dir = await this.storeDirectory('candidates')
    return writeImmutableJson(
      join(dir, `${candidate.candidateId}.json`),
      candidate,
      'SKILL_CANDIDATE_CONFLICT',
    )
  }

  async findCandidate(candidateId: string): Promise<SkillCandidateV1 | undefined> {
    assertCandidateId(candidateId)
    const dir = await this.readStoreDirectory('candidates')
    if (!dir) return undefined
    const path = join(dir, `${candidateId}.json`)
    if (!await regularFileExists(path)) return undefined
    const candidate = await readValidatedJson(path, assertSkillCandidate)
    if (candidate.candidateId !== candidateId) throw new Error('CANDIDATE_FILE_ID_MISMATCH')
    assertCandidateIntegrity(candidate)
    return candidate
  }

  async readCandidate(candidateId: string): Promise<SkillCandidateV1> {
    assertCandidateId(candidateId)
    const dir = await this.readStoreDirectory('candidates')
    const path = join(dir ?? join(this.rootDir, 'candidates'), `${candidateId}.json`)
    const candidate = await readValidatedJson(path, assertSkillCandidate)
    if (candidate.candidateId !== candidateId) throw new Error('CANDIDATE_FILE_ID_MISMATCH')
    assertCandidateIntegrity(candidate)
    return candidate
  }

  async listCandidates(): Promise<SkillCandidateV1[]> {
    const dir = await this.readStoreDirectory('candidates')
    if (!dir) return []
    let names: string[]
    try {
      names = await readdir(dir)
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return []
      throw error
    }
    const candidates: SkillCandidateV1[] = []
    for (const name of names.filter((entry) => entry.endsWith('.json')).sort()) {
      const candidateId = name.slice(0, -'.json'.length)
      assertCandidateId(candidateId)
      const candidate = await readValidatedJson(join(dir, name), assertSkillCandidate)
      if (candidate.candidateId !== candidateId) throw new Error('CANDIDATE_FILE_ID_MISMATCH')
      assertCandidateIntegrity(candidate)
      candidates.push(candidate)
    }
    return candidates
  }

  async writeReceipt(receipt: SkillGenerationReceiptV1): Promise<{ path: string; created: boolean }> {
    assertSkillGenerationReceipt(receipt)
    assertRequestId(receipt.requestId)
    const dir = await this.storeDirectory('receipts')
    return writeImmutableJson(
      join(dir, `${receipt.requestId}.json`),
      receipt,
      'GENERATION_RECEIPT_CONFLICT',
    )
  }

  async readReceipt(requestId: string): Promise<SkillGenerationReceiptV1 | undefined> {
    assertRequestId(requestId)
    const dir = await this.readStoreDirectory('receipts')
    if (!dir) return undefined
    const path = join(dir, `${requestId}.json`)
    if (!await regularFileExists(path)) return undefined
    const receipt = await readValidatedJson(path, assertSkillGenerationReceipt)
    if (receipt.requestId !== requestId) throw new Error('RECEIPT_FILE_ID_MISMATCH')
    return receipt
  }

  private async storeDirectory(name: 'candidates' | 'receipts'): Promise<string> {
    await mkdir(this.rootDir, { recursive: true })
    const root = await realpath(this.rootDir)
    const dir = join(this.rootDir, name)
    await mkdir(dir, { recursive: true })
    await assertDirectoryWithin(dir, root, 'CANDIDATE_STORE_PATH_OUTSIDE_ROOT')
    return dir
  }

  private async readStoreDirectory(name: 'candidates' | 'receipts'): Promise<string | undefined> {
    let root: string
    let dir: string
    try {
      root = await realpath(this.rootDir)
      dir = await realpath(join(this.rootDir, name))
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return undefined
      throw error
    }
    if (!isWithin(dir, root)) throw new Error(`CANDIDATE_STORE_PATH_OUTSIDE_ROOT: ${dir}`)
    const stats = await lstat(dir)
    if (!stats.isDirectory()) throw new Error(`INVALID_CANDIDATE_STORE_DIRECTORY: ${dir}`)
    return dir
  }
}

function assertCandidateIntegrity(candidate: SkillCandidateV1): void {
  if (candidate.candidateId !== candidateIdForFingerprint(candidate.fingerprint)) {
    throw new Error('INVALID_CANDIDATE_ID: candidate id does not match fingerprint')
  }
  if (candidate.fingerprint !== skillCandidateFingerprint(candidate.proposedSkill)) {
    throw new Error('CANDIDATE_FINGERPRINT_MISMATCH')
  }
  const evidence = candidate.evidenceSummary
  const provenance = candidate.provenance
  if (
    provenance.runId !== evidence.runId
    || provenance.revision !== evidence.revision
    || provenance.sessionId !== evidence.sessionId
    || provenance.attempt !== evidence.attempt
    || provenance.outcomeArtifactId !== evidence.source.outcomeArtifactId
    || provenance.traceSha256 !== evidence.source.traceSha256
  ) {
    throw new Error('CANDIDATE_BINDING_MISMATCH')
  }
}

function assertCandidateRootSeparated(
  candidateRoot: string,
  env: Record<string, string | undefined>,
): void {
  const physicalCandidateRoot = physicalPath(candidateRoot)
  for (const name of ['WEB_BUDDY_PROJECT_SKILL_ROOTS', 'WEB_BUDDY_USER_SKILL_ROOTS']) {
    for (const root of (env[name] ?? '').split(':').map((part) => part.trim()).filter(Boolean)) {
      const skillRoot = physicalPath(root)
      if (isWithin(physicalCandidateRoot, skillRoot) || isWithin(skillRoot, physicalCandidateRoot)) {
        throw new Error(`CANDIDATE_STORE_OVERLAPS_SKILL_ROOT: ${name}`)
      }
    }
  }
}

function physicalPath(path: string): string {
  let current = resolve(path)
  const suffix: string[] = []
  while (true) {
    try {
      return resolve(realpathSync(current), ...suffix.reverse())
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error
      const parent = dirname(current)
      if (parent === current) return resolve(path)
      suffix.push(basename(current))
      current = parent
    }
  }
}

async function writeImmutableJson(
  target: string,
  value: unknown,
  conflictCode: string,
  equivalent: (existing: unknown, incoming: unknown) => boolean = (existing, incoming) => (
    canonicalJson(existing) === canonicalJson(incoming)
  ),
): Promise<{ path: string; created: boolean }> {
  const dir = dirname(target)
  await mkdir(dir, { recursive: true })
  const temp = join(dir, `.${process.pid}.${randomUUID()}.tmp-json`)
  const content = `${JSON.stringify(value, null, 2)}\n`
  await writeFile(temp, content, { encoding: 'utf8', flag: 'wx' })
  try {
    try {
      await link(temp, target)
      return { path: target, created: true }
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error
      const targetStats = await lstat(target)
      if (targetStats.isSymbolicLink() || !targetStats.isFile()) {
        throw new Error(`UNSAFE_IMMUTABLE_TARGET: ${target}`)
      }
      const existing = await readFile(target, 'utf8')
      let parsed: unknown
      try {
        parsed = JSON.parse(existing)
      } catch {
        throw new Error(`${conflictCode}: existing file is not valid JSON`)
      }
      if (!equivalent(parsed, value)) {
        throw new Error(`${conflictCode}: immutable file already exists with different content`)
      }
      return { path: target, created: false }
    }
  } finally {
    await unlink(temp).catch(() => {})
  }
}

function equivalentGenerationRequest(existing: unknown, incoming: unknown): boolean {
  try {
    assertSkillGenerationRequest(existing)
    assertSkillGenerationRequest(incoming)
  } catch {
    return false
  }
  if (
    existing.requestId !== generationRequestId(existing)
    || incoming.requestId !== generationRequestId(incoming)
  ) {
    return false
  }
  const { createdAt: _existingCreatedAt, ...existingBound } = existing
  const { createdAt: _incomingCreatedAt, ...incomingBound } = incoming
  return canonicalJson(existingBound) === canonicalJson(incomingBound)
}

async function readValidatedJson<T>(
  path: string,
  assertValue: (value: unknown) => asserts value is T,
): Promise<T> {
  const stats = await lstat(path)
  if (stats.isSymbolicLink() || !stats.isFile()) throw new Error(`UNSAFE_JSON_FILE: ${path}`)
  const raw = await readFile(path, 'utf8')
  const value: unknown = JSON.parse(raw)
  assertValue(value)
  return value
}

async function existingDirectory(path: string, code: string): Promise<string> {
  try {
    const resolved = await realpath(resolve(path))
    const stats = await lstat(resolved)
    if (!stats.isDirectory()) throw new Error(`${code}: ${path}`)
    return resolved
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(`${code}:`)) throw error
    throw new Error(`${code}: ${path}`)
  }
}

async function assertDirectoryWithin(path: string, root: string, code: string): Promise<void> {
  const resolvedPath = await realpath(path)
  if (!isWithin(resolvedPath, root)) throw new Error(`${code}: ${resolvedPath}`)
}

function isWithin(path: string, root: string): boolean {
  const relation = relative(root, path)
  return relation === ''
    || (!relation.startsWith(`..${sep}`) && relation !== '..' && !isAbsolute(relation))
}

async function regularFileExists(path: string): Promise<boolean> {
  try {
    const stats = await lstat(path)
    if (stats.isSymbolicLink()) throw new Error(`UNSAFE_JSON_FILE: ${path}`)
    return stats.isFile()
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return false
    throw error
  }
}

function assertRequestId(value: string): void {
  if (!safeExternalId(value) || !/^request_[a-f0-9]{24}$/.test(value)) {
    throw new Error('INVALID_REQUEST_ID')
  }
}

function assertCandidateId(value: string): void {
  if (!safeExternalId(value) || !/^candidate_[a-f0-9]{24}$/.test(value)) {
    throw new Error('INVALID_CANDIDATE_ID')
  }
}

function safeExternalId(value: string): boolean {
  return SAFE_ID.test(value) && value !== '..' && !value.includes('..')
}

function sha256Canonical(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const item = value as Record<string, unknown>
  return `{${Object.keys(item).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(item[key])}`
  )).join(',')}}`
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined
}
