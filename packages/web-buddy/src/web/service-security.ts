import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto'
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  writeFile,
} from 'node:fs/promises'
import type { IncomingMessage } from 'node:http'
import { dirname, join } from 'node:path'
import {
  AUDIT_ACTOR_SCHEMA_VERSION,
  AUDIT_EVENT_SCHEMA_VERSION,
  SERVICE_SCOPE_SCHEMA_VERSION,
  evaluateQuota,
  serviceScopeKey,
  validateAuditEvent,
  validateServiceScope,
  type AuditAction,
  type AuditEvent,
  type AuditTarget,
  type QuotaLimit,
  type ServiceScope,
} from '../public/service-contracts.js'
import { redactSensitiveData } from '../security/redaction.js'
import type { AgentConfig } from '../sdk/config.js'
import {
  digestCanonicalJson,
  type JsonObject,
  type JsonValue,
  type OwnerScope,
} from '../task/contracts.js'

export const SERVICE_PRINCIPAL_SCHEMA_VERSION = 'service-principal/v1' as const
export const WEB_SERVICE_SECURITY_SCHEMA_VERSION = 'web-service-security/v1' as const

export interface ServicePrincipal {
  schemaVersion: typeof SERVICE_PRINCIPAL_SCHEMA_VERSION
  actorId: string
  authentication: 'api_token' | 'bearer'
  scope: ServiceScope
}

export interface ServiceAuthenticationRequest {
  authorization?: string
  apiToken?: string
  method?: string
  path?: string
}

export interface ServiceAuditSink {
  append(event: Readonly<AuditEvent>): Promise<void>
}

export interface ServiceSecretProvider {
  credentialConfigured(): boolean
  injectModelCredential(config: AgentConfig): Promise<void>
  redact(value: unknown): JsonValue
}

export interface WebServiceSecurityOptions {
  schemaVersion: typeof WEB_SERVICE_SECURITY_SCHEMA_VERSION
  authenticate?: (
    request: Readonly<ServiceAuthenticationRequest>,
  ) => ServicePrincipal | undefined | Promise<ServicePrincipal | undefined>
  quotaLimits?: QuotaLimit[]
  auditSink?: ServiceAuditSink
  secretProvider?: ServiceSecretProvider
}

export interface QuotaReservation {
  decision: 'allow' | 'deny'
  replayed: boolean
  reasonCode: 'within_limit' | 'quota_exceeded' | 'idempotency_conflict' | 'quota_store_failed'
  reservationId?: string
}

interface QuotaLedgerReservation {
  requestDigest: string
  decision: 'allow' | 'deny'
  reasonCode: QuotaReservation['reasonCode']
  reservationId?: string
}

interface QuotaLedgerFile {
  schemaVersion: 'service-quota-ledger/v1'
  usage: Record<string, number>
  reservations: Record<string, QuotaLedgerReservation>
}

interface EnvironmentPrincipalRecord {
  digest: Buffer
  principal: ServicePrincipal
}

export class WebServiceSecurityBoundary {
  readonly secretProvider: ServiceSecretProvider
  private readonly quotaLimits: QuotaLimit[]
  private readonly quotaLedger: FileQuotaLedger
  private readonly auditFile: string
  private readonly auditSink?: ServiceAuditSink
  private readonly authenticateOverride?: WebServiceSecurityOptions['authenticate']
  private readonly environmentAuthenticator: EnvironmentTokenAuthenticator

  constructor(input: {
    rootDir: string
    options?: WebServiceSecurityOptions
  }) {
    if (input.options?.schemaVersion !== undefined
      && input.options.schemaVersion !== WEB_SERVICE_SECURITY_SCHEMA_VERSION) {
      throw new Error('Unsupported Web service security schema version.')
    }
    this.secretProvider = input.options?.secretProvider ?? new EnvironmentSecretProvider()
    this.quotaLimits = (input.options?.quotaLimits ?? []).map((limit) => structuredClone(limit))
    this.quotaLedger = new FileQuotaLedger(join(input.rootDir, 'service-security', 'quota-ledger.json'))
    this.auditFile = join(input.rootDir, 'service-security', 'audit.jsonl')
    this.auditSink = input.options?.auditSink
    this.authenticateOverride = input.options?.authenticate
    this.environmentAuthenticator = new EnvironmentTokenAuthenticator()
  }

  async authenticate(req: IncomingMessage, path: string): Promise<ServicePrincipal | undefined> {
    const authorization = singleHeader(req.headers.authorization)
    const apiToken = singleHeader(req.headers['x-api-token'])
    try {
      const raw = this.authenticateOverride
        ? await this.authenticateOverride({
            ...(authorization ? { authorization } : {}),
            ...(apiToken ? { apiToken } : {}),
            ...(req.method ? { method: req.method } : {}),
            path,
          })
        : this.environmentAuthenticator.authenticate(authorization, apiToken)
      return raw ? validatePrincipal(raw) : undefined
    } catch {
      return undefined
    }
  }

  ownerScope(principal: ServicePrincipal): OwnerScope | undefined {
    if (principal.scope.kind === 'local') return undefined
    return {
      schemaVersion: 'owner-scope/v1',
      tenantId: principal.scope.tenantId,
      userId: principal.scope.userId,
    }
  }

  async reserveRun(
    principal: ServicePrincipal,
    input: {
      idempotencyKey: string
      requestDigest: string
      requestedAt?: Date
    },
  ): Promise<QuotaReservation> {
    const limits = this.quotaLimits.filter((limit) => (
      limit.dimension === 'runs_per_window'
      && serviceScopeKey(validateServiceScope(limit.scope)) === serviceScopeKey(principal.scope)
    ))
    if (limits.length === 0) {
      return { decision: 'allow', replayed: false, reasonCode: 'within_limit' }
    }
    try {
      return await this.quotaLedger.reserve({
        scope: principal.scope,
        limits,
        idempotencyKey: input.idempotencyKey,
        requestDigest: input.requestDigest,
        now: input.requestedAt ?? new Date(),
      })
    } catch {
      return { decision: 'deny', replayed: false, reasonCode: 'quota_store_failed' }
    }
  }

  async audit(input: {
    principal?: ServicePrincipal
    requestId: string
    action: AuditAction
    target: AuditTarget
    result: AuditEvent['result']
    reasonCode?: string
    metadata?: JsonObject
  }): Promise<void> {
    // The public v1 AuditActor requires an authenticated scope. Anonymous
    // denials stay response-only rather than being forged as a tenant actor.
    if (!input.principal) return
    const sanitizedReason = input.reasonCode === undefined
      ? undefined
      : String(this.secretProvider.redact(input.reasonCode))
    const sanitizedMetadata = input.metadata === undefined
      ? undefined
      : this.secretProvider.redact(input.metadata)
    const event = validateAuditEvent({
      schemaVersion: AUDIT_EVENT_SCHEMA_VERSION,
      eventId: randomUUID(),
      requestId: boundedId(input.requestId, 'request'),
      actor: {
        schemaVersion: AUDIT_ACTOR_SCHEMA_VERSION,
        actorId: input.principal.actorId,
        scope: input.principal.scope,
        authentication: input.principal.authentication,
      },
      action: input.action,
      target: {
        kind: input.target.kind,
        ...(input.target.id
          ? { id: boundedId(String(this.secretProvider.redact(input.target.id)), 'target') }
          : {}),
      },
      occurredAt: new Date().toISOString(),
      result: input.result,
      ...(sanitizedReason ? { reasonCode: sanitizedReason } : {}),
      redaction: digestCanonicalJson({
        reason: input.reasonCode ?? null,
        metadata: input.metadata ?? null,
      }) === digestCanonicalJson({
        reason: sanitizedReason ?? null,
        metadata: sanitizedMetadata ?? null,
      }) ? 'not_required' : 'redacted',
      ...(sanitizedMetadata && typeof sanitizedMetadata === 'object' && !Array.isArray(sanitizedMetadata)
        ? { metadata: sanitizedMetadata as JsonObject }
        : {}),
    })
    await appendDurableJsonLine(this.auditFile, event)
    await this.auditSink?.append(event)
  }

  sanitize<T>(value: T): T {
    return this.secretProvider.redact(value) as T
  }

  bindIdempotencyKey(principal: ServicePrincipal, externalKey: string): string {
    return `service-idempotency:${createHash('sha256')
      .update(`${serviceScopeKey(principal.scope)}\u0000${externalKey}`)
      .digest('hex')}`
  }

  async redactTraceFiles(roots: readonly string[]): Promise<void> {
    for (const root of roots) {
      await redactTraceTree(root, (value) => this.secretProvider.redact(value))
    }
  }
}

class FileQuotaLedger {
  private tail = Promise.resolve()

  constructor(private readonly file: string) {}

  reserve(input: {
    scope: ServiceScope
    limits: QuotaLimit[]
    idempotencyKey: string
    requestDigest: string
    now: Date
  }): Promise<QuotaReservation> {
    const run = this.tail.then(() => this.reserveLocked(input))
    this.tail = run.then(() => undefined, () => undefined)
    return run
  }

  private async reserveLocked(input: {
    scope: ServiceScope
    limits: QuotaLimit[]
    idempotencyKey: string
    requestDigest: string
    now: Date
  }): Promise<QuotaReservation> {
    const ledger = await readQuotaLedger(this.file)
    const scopeKey = serviceScopeKey(input.scope)
    const reservationKey = `${scopeKey}:${input.idempotencyKey}`
    const existing = ledger.reservations[reservationKey]
    if (existing) {
      if (existing.requestDigest !== input.requestDigest) {
        return {
          decision: 'deny',
          replayed: true,
          reasonCode: 'idempotency_conflict',
        }
      }
      return {
        decision: existing.decision,
        replayed: true,
        reasonCode: existing.reasonCode,
        ...(existing.reservationId ? { reservationId: existing.reservationId } : {}),
      }
    }

    for (const limit of input.limits) {
      const windowMs = limit.windowMs ?? 1
      const windowStart = Math.floor(input.now.getTime() / windowMs) * windowMs
      const usageKey = `${scopeKey}:${limit.dimension}:${windowStart}`
      const used = ledger.usage[usageKey] ?? 0
      const decision = evaluateQuota(limit, {
        schemaVersion: 'quota-usage/v1',
        scope: input.scope,
        dimension: limit.dimension,
        used,
        reserved: 0,
        measuredAt: input.now.toISOString(),
        ...(limit.windowMs ? { windowStartedAt: new Date(windowStart).toISOString() } : {}),
      }, 1, input.now)
      if (decision.decision === 'deny') {
        ledger.reservations[reservationKey] = {
          requestDigest: input.requestDigest,
          decision: 'deny',
          reasonCode: 'quota_exceeded',
        }
        await writeQuotaLedger(this.file, ledger)
        return { decision: 'deny', replayed: false, reasonCode: 'quota_exceeded' }
      }
    }

    const reservationId = randomUUID()
    for (const limit of input.limits) {
      const windowMs = limit.windowMs ?? 1
      const windowStart = Math.floor(input.now.getTime() / windowMs) * windowMs
      const usageKey = `${scopeKey}:${limit.dimension}:${windowStart}`
      ledger.usage[usageKey] = (ledger.usage[usageKey] ?? 0) + 1
    }
    ledger.reservations[reservationKey] = {
      requestDigest: input.requestDigest,
      decision: 'allow',
      reasonCode: 'within_limit',
      reservationId,
    }
    await writeQuotaLedger(this.file, ledger)
    return {
      decision: 'allow',
      replayed: false,
      reasonCode: 'within_limit',
      reservationId,
    }
  }
}

class EnvironmentTokenAuthenticator {
  private readonly key = randomBytes(32)
  private readonly records: EnvironmentPrincipalRecord[]

  constructor() {
    this.records = environmentPrincipals().map(({ token, principal }) => ({
      digest: this.digest(token),
      principal,
    }))
  }

  authenticate(authorization?: string, apiToken?: string): ServicePrincipal | undefined {
    const token = bearerToken(authorization) ?? apiToken
    if (!token) return undefined
    const digest = this.digest(token)
    const matched = this.records.find((record) => (
      record.digest.length === digest.length && timingSafeEqual(record.digest, digest)
    ))
    return matched ? structuredClone(matched.principal) : undefined
  }

  private digest(token: string): Buffer {
    return createHmac('sha256', this.key).update(token).digest()
  }
}

class EnvironmentSecretProvider implements ServiceSecretProvider {
  private readonly secrets: string[]
  private readonly apiKey: string | undefined
  private readonly authToken: string | undefined

  constructor() {
    this.apiKey = firstSecret('MODEL_API_KEY', 'OPENAI_API_KEY', 'DASHSCOPE_API_KEY')
    this.authToken = firstSecret('ANTHROPIC_AUTH_TOKEN')
    this.secrets = [
      this.apiKey,
      this.authToken,
      process.env.WEB_BUDDY_API_TOKEN,
      ...tokensFromJson(),
    ].filter((value): value is string => Boolean(value))
      .sort((left, right) => right.length - left.length)
  }

  credentialConfigured(): boolean {
    return Boolean(this.apiKey || this.authToken)
  }

  async injectModelCredential(config: AgentConfig): Promise<void> {
    config.model.apiKey = this.apiKey ?? null
    config.model.authToken = this.authToken ?? this.apiKey ?? null
  }

  redact(value: unknown): JsonValue {
    const exact = redactExactSecrets(value, this.secrets)
    return redactSensitiveData(exact).value
  }
}

function validatePrincipal(value: unknown): ServicePrincipal {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Service principal must be an object.')
  }
  const input = value as Record<string, unknown>
  const allowed = new Set(['schemaVersion', 'actorId', 'authentication', 'scope'])
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) throw new Error(`Service principal field ${key} is unsupported.`)
  }
  if (input.schemaVersion !== SERVICE_PRINCIPAL_SCHEMA_VERSION) {
    throw new Error('Unsupported service principal schema.')
  }
  if (input.authentication !== 'api_token' && input.authentication !== 'bearer') {
    throw new Error('Unsupported service authentication.')
  }
  return Object.freeze({
    schemaVersion: SERVICE_PRINCIPAL_SCHEMA_VERSION,
    actorId: boundedId(input.actorId, 'actor'),
    authentication: input.authentication,
    scope: validateServiceScope(input.scope),
  })
}

function environmentPrincipals(): Array<{ token: string; principal: ServicePrincipal }> {
  const records: Array<{ token: string; actorId: string; tenantId: string; userId: string }> = []
  const raw = process.env.WEB_BUDDY_API_TOKENS_JSON
  if (raw) {
    try {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (item && typeof item === 'object'
            && typeof item.token === 'string'
            && typeof item.actorId === 'string'
            && typeof item.tenantId === 'string'
            && typeof item.userId === 'string') {
            records.push(item)
          }
        }
      }
    } catch {
      // Invalid auth configuration fails closed with no principals.
    }
  }
  const single = process.env.WEB_BUDDY_API_TOKEN
  if (single) {
    records.push({
      token: single,
      actorId: process.env.WEB_BUDDY_ACTOR_ID || 'local-operator',
      tenantId: process.env.WEB_BUDDY_TENANT_ID || 'local-tenant',
      userId: process.env.WEB_BUDDY_USER_ID || 'local-user',
    })
  }
  return records.map((record) => ({
    token: record.token,
    principal: {
      schemaVersion: SERVICE_PRINCIPAL_SCHEMA_VERSION,
      actorId: record.actorId,
      authentication: 'bearer',
      scope: {
        schemaVersion: SERVICE_SCOPE_SCHEMA_VERSION,
        kind: 'tenant',
        tenantId: record.tenantId,
        userId: record.userId,
      },
    },
  }))
}

function tokensFromJson(): string[] {
  try {
    const parsed = JSON.parse(process.env.WEB_BUDDY_API_TOKENS_JSON || '[]')
    return Array.isArray(parsed)
      ? parsed.map((item) => item?.token).filter((value): value is string => typeof value === 'string')
      : []
  } catch {
    return []
  }
}

function bearerToken(value?: string): string | undefined {
  if (!value) return undefined
  const match = /^Bearer ([^\s]+)$/.exec(value)
  return match?.[1]
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

function firstSecret(...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = process.env[key]?.trim()
    if (value) return value
  }
  return undefined
}

function redactExactSecrets(value: unknown, secrets: string[]): JsonValue {
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string') {
    let output = value
    for (const secret of secrets) {
      if (secret) output = output.split(secret).join('[REDACTED:secret]')
    }
    return output
  }
  if (Array.isArray(value)) return value.map((item) => redactExactSecrets(item, secrets))
  if (value && typeof value === 'object') {
    const output = Object.create(null) as JsonObject
    for (const [key, child] of Object.entries(value)) {
      output[key] = redactExactSecrets(child, secrets)
    }
    return output
  }
  return null
}

async function readQuotaLedger(file: string): Promise<QuotaLedgerFile> {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as QuotaLedgerFile
    if (parsed.schemaVersion !== 'service-quota-ledger/v1'
      || !parsed.usage || typeof parsed.usage !== 'object'
      || !parsed.reservations || typeof parsed.reservations !== 'object') {
      throw new Error('Invalid quota ledger.')
    }
    return parsed
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        schemaVersion: 'service-quota-ledger/v1',
        usage: {},
        reservations: {},
      }
    }
    throw error
  }
}

async function writeQuotaLedger(file: string, value: QuotaLedgerFile): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(temp, `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode: 0o600 })
  const handle = await open(temp, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(temp, file)
}

async function appendDurableJsonLine(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const handle = await open(file, 'a', 0o600)
  try {
    await handle.appendFile(`${JSON.stringify(value)}\n`, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function redactTraceTree(
  root: string,
  redact: (value: unknown) => JsonValue,
  depth = 0,
): Promise<void> {
  if (depth > 8) return
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  for (const entry of entries) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) {
      await redactTraceTree(path, redact, depth + 1)
      continue
    }
    if (!entry.isFile() || !/\.(?:json|jsonl|log|txt)$/i.test(entry.name)) continue
    const raw = await readFile(path, 'utf8')
    const redacted = raw.length > 32 * 1024 * 1024
      ? '[REDACTED:oversize trace omitted]\n'
      : redactTraceText(raw, entry.name, redact)
    if (redacted !== raw) await atomicWritePrivateText(path, redacted)
  }
}

function redactTraceText(
  raw: string,
  name: string,
  redact: (value: unknown) => JsonValue,
): string {
  try {
    if (/\.json$/i.test(name)) {
      return `${JSON.stringify(redact(JSON.parse(raw)))}\n`
    }
    if (/\.jsonl$/i.test(name)) {
      const trailingNewline = raw.endsWith('\n')
      const lines = raw.split('\n').filter((line) => line.length > 0)
      const output = lines.map((line) => {
        try {
          return JSON.stringify(redact(JSON.parse(line)))
        } catch {
          return String(redact(line))
        }
      }).join('\n')
      return `${output}${trailingNewline ? '\n' : ''}`
    }
  } catch {
    // Malformed trace material is treated as opaque text and still redacted.
  }
  return String(redact(raw))
}

async function atomicWritePrivateText(file: string, value: string): Promise<void> {
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(temp, value, { encoding: 'utf8', mode: 0o600 })
  await rename(temp, file)
}

function boundedId(value: unknown, prefix: string): string {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (raw && raw.length <= 512) return raw
  return `${prefix}-${createHash('sha256').update(String(value)).digest('hex').slice(0, 24)}`
}
