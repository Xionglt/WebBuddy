import type { AgentRole, JsonValue, SensitiveActionRule } from './contracts.js'
import { PublicContractError } from './task.js'

export const PUBLIC_SKILL_MANIFEST_SCHEMA_VERSION = 'public-skill-manifest/v1' as const
export const PUBLIC_SKILL_SCAFFOLD_REQUEST_SCHEMA_VERSION = 'public-skill-scaffold-request/v1' as const
export const PUBLIC_SKILL_SCAFFOLD_SCHEMA_VERSION = 'public-skill-scaffold/v1' as const

export interface SkillManifest {
  schemaVersion: typeof PUBLIC_SKILL_MANIFEST_SCHEMA_VERSION
  id: string
  version: string
  name: string
  description: string
  taskKinds: Array<'research' | 'comparison' | 'form_draft' | 'custom'>
  capabilities: string[]
  inputContextKinds: string[]
  outputArtifactKinds: string[]
  role?: AgentRole
  policyRules: SensitiveActionRule[]
  configSchema?: JsonValue
}

export interface SkillScaffoldRequest {
  schemaVersion: typeof PUBLIC_SKILL_SCAFFOLD_REQUEST_SCHEMA_VERSION
  id: string
  version: string
  name: string
  description: string
  taskKinds: SkillManifest['taskKinds']
}

export interface SkillScaffoldFile {
  path: 'skill.json' | 'README.md'
  content: string
}

export interface SkillScaffold {
  schemaVersion: typeof PUBLIC_SKILL_SCAFFOLD_SCHEMA_VERSION
  manifest: SkillManifest
  files: SkillScaffoldFile[]
}

export function validateSkillManifest(value: unknown): SkillManifest {
  const manifest = plain(value, 'SkillManifest')
  closed(manifest, [
    'schemaVersion',
    'id',
    'version',
    'name',
    'description',
    'taskKinds',
    'capabilities',
    'inputContextKinds',
    'outputArtifactKinds',
    'role',
    'policyRules',
    'configSchema',
  ], 'SkillManifest')
  if (manifest.schemaVersion !== PUBLIC_SKILL_MANIFEST_SCHEMA_VERSION) unsupported('SkillManifest')
  const result: SkillManifest = {
    schemaVersion: PUBLIC_SKILL_MANIFEST_SCHEMA_VERSION,
    id: identifier(manifest.id, 'SkillManifest.id'),
    version: semanticVersion(manifest.version),
    name: text(manifest.name, 'SkillManifest.name'),
    description: text(manifest.description, 'SkillManifest.description'),
    taskKinds: taskKinds(manifest.taskKinds),
    capabilities: strings(manifest.capabilities, 'SkillManifest.capabilities'),
    inputContextKinds: strings(manifest.inputContextKinds, 'SkillManifest.inputContextKinds'),
    outputArtifactKinds: strings(manifest.outputArtifactKinds, 'SkillManifest.outputArtifactKinds'),
    ...(manifest.role ? { role: validateRole(manifest.role) } : {}),
    policyRules: policyRules(manifest.policyRules),
    ...(manifest.configSchema !== undefined
      ? { configSchema: jsonClone(manifest.configSchema, 'SkillManifest.configSchema') }
      : {}),
  }
  if (result.capabilities.some(forbiddenCapability)) {
    invalid('Skill capabilities cannot include Browser write, Approval resolution, Memory write or completion authority.')
  }
  return deepFreeze(result)
}

export function createSkillScaffold(requestValue: SkillScaffoldRequest): SkillScaffold {
  const request = plain(requestValue, 'SkillScaffoldRequest')
  closed(request, ['schemaVersion', 'id', 'version', 'name', 'description', 'taskKinds'], 'SkillScaffoldRequest')
  if (request.schemaVersion !== PUBLIC_SKILL_SCAFFOLD_REQUEST_SCHEMA_VERSION) unsupported('SkillScaffoldRequest')
  const manifest = validateSkillManifest({
    schemaVersion: PUBLIC_SKILL_MANIFEST_SCHEMA_VERSION,
    id: request.id,
    version: request.version,
    name: request.name,
    description: request.description,
    taskKinds: request.taskKinds,
    capabilities: ['context.read', 'artifact.read'],
    inputContextKinds: [],
    outputArtifactKinds: [],
    policyRules: [],
  })
  return deepFreeze({
    schemaVersion: PUBLIC_SKILL_SCAFFOLD_SCHEMA_VERSION,
    manifest,
    files: [
      {
        path: 'skill.json',
        content: `${JSON.stringify(manifest, null, 2)}\n`,
      },
      {
        path: 'README.md',
        content: `# ${manifest.name}\n\n${manifest.description}\n\nVersion: ${manifest.version}\n`,
      },
    ],
  })
}

function validateRole(value: unknown): AgentRole {
  const role = plain(value, 'SkillManifest.role')
  closed(role, [
    'schemaVersion',
    'id',
    'version',
    'capabilities',
    'authority',
    'inputArtifactKinds',
    'outputArtifactKind',
  ], 'SkillManifest.role')
  if (role.schemaVersion !== 'agent-role/v1') unsupported('AgentRole')
  const capabilities = strings(role.capabilities, 'AgentRole.capabilities')
  if (capabilities.some(forbiddenCapability)) invalid('AgentRole capabilities exceed the public read/recommend boundary.')
  if (role.authority !== 'read_only' && role.authority !== 'recommend_only') {
    invalid('AgentRole authority must be read_only or recommend_only.')
  }
  return {
    schemaVersion: 'agent-role/v1',
    id: identifier(role.id, 'AgentRole.id'),
    version: semanticVersion(role.version),
    capabilities,
    authority: role.authority,
    inputArtifactKinds: strings(role.inputArtifactKinds, 'AgentRole.inputArtifactKinds'),
    outputArtifactKind: identifier(role.outputArtifactKind, 'AgentRole.outputArtifactKind'),
  }
}

function policyRules(value: unknown): SensitiveActionRule[] {
  if (!Array.isArray(value)) invalid('SkillManifest.policyRules must be an array.')
  return value.map((rule, index) => {
    const item = plain(rule, `SkillManifest.policyRules[${index}]`)
    closed(item, [
      'id',
      'actionKinds',
      'decision',
      'sourceSensitivities',
      'destinationOrigins',
      'requireApprovalBinding',
    ], `SkillManifest.policyRules[${index}]`)
    if (item.decision !== 'ask' && item.decision !== 'deny') invalid('Skill policy rules cannot grant allow.')
    if (item.requireApprovalBinding !== true && item.requireApprovalBinding !== false) {
      invalid('Skill policy rule requireApprovalBinding must be boolean.')
    }
    const actionKinds = strings(item.actionKinds, `SkillManifest.policyRules[${index}].actionKinds`)
    if (actionKinds.some((kind) => !SENSITIVE_ACTIONS.has(kind))) invalid('Skill policy rule actionKinds is invalid.')
    const sourceSensitivities = item.sourceSensitivities === undefined
      ? undefined
      : strings(item.sourceSensitivities, `SkillManifest.policyRules[${index}].sourceSensitivities`)
    if (sourceSensitivities?.some((sensitivity) => !SENSITIVITIES.has(sensitivity))) {
      invalid('Skill policy rule sourceSensitivities is invalid.')
    }
    return {
      id: identifier(item.id, `SkillManifest.policyRules[${index}].id`),
      actionKinds: actionKinds as SensitiveActionRule['actionKinds'],
      decision: item.decision,
      ...(sourceSensitivities
        ? { sourceSensitivities: sourceSensitivities as SensitiveActionRule['sourceSensitivities'] }
        : {}),
      ...(item.destinationOrigins === undefined
        ? {}
        : { destinationOrigins: strings(item.destinationOrigins, `SkillManifest.policyRules[${index}].destinationOrigins`) }),
      requireApprovalBinding: item.requireApprovalBinding,
    }
  })
}

function forbiddenCapability(value: string): boolean {
  return /(?:browser[._-]?write|browser[._-]?(?:click|type|submit)|approval[._-]?(?:resolve|write)|memory[._-]?write|completion[._-]?authority|live[._-]?page)/i.test(value)
}

function plain(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`${label} must be a plain object.`)
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) invalid(`${label} must be a plain object.`)
  return value as Record<string, unknown>
}

function closed(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const allowed = new Set(keys)
  for (const key of Object.keys(value)) if (!allowed.has(key)) invalid(`${label} contains unsupported field ${key}.`)
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() !== value || value.length === 0) invalid(`${label} must be non-empty.`)
  return value
}

function identifier(value: unknown, label: string): string {
  const result = text(value, label)
  if (!/^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/.test(result)) invalid(`${label} is not a stable identifier.`)
  return result
}

function semanticVersion(value: unknown): string {
  const result = text(value, 'version')
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(result)) invalid('version must be semantic version syntax.')
  return result
}

function strings(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.length === 0)) {
    invalid(`${label} must be a string array.`)
  }
  if (new Set(value).size !== value.length) invalid(`${label} contains duplicates.`)
  return [...value] as string[]
}

function taskKinds(value: unknown): SkillManifest['taskKinds'] {
  const values = strings(value, 'SkillManifest.taskKinds')
  if (values.some((item) => !['research', 'comparison', 'form_draft', 'custom'].includes(item))) {
    invalid('SkillManifest.taskKinds contains an unsupported task kind.')
  }
  return values as SkillManifest['taskKinds']
}

function jsonClone(value: unknown, label: string): JsonValue {
  try {
    assertJsonSafe(value, label)
    const serialized = JSON.stringify(value)
    if (serialized === undefined) invalid(`${label} must be JSON-safe.`)
    return JSON.parse(serialized) as JsonValue
  } catch {
    invalid(`${label} must be JSON-safe.`)
  }
}

function assertJsonSafe(value: unknown, label: string, seen = new Set<object>()): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) invalid(`${label} contains a non-finite number.`)
    return
  }
  if (typeof value !== 'object') invalid(`${label} is not JSON-safe.`)
  if (seen.has(value)) invalid(`${label} contains a cycle.`)
  seen.add(value)
  if (Array.isArray(value)) {
    value.forEach((child, index) => assertJsonSafe(child, `${label}[${index}]`, seen))
  } else {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) invalid(`${label} contains a non-plain object.`)
    for (const [key, child] of Object.entries(value)) assertJsonSafe(child, `${label}.${key}`, seen)
  }
  seen.delete(value)
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}

function invalid(message: string): never {
  throw new PublicContractError('INVALID_CONTRACT', message)
}

function unsupported(label: string): never {
  throw new PublicContractError('UNSUPPORTED_SCHEMA_VERSION', `${label} schema version is not supported.`)
}

const SENSITIVE_ACTIONS = new Set<string>([
  'navigate',
  'type_or_paste',
  'upload',
  'send',
  'publish',
  'submit',
  'payment',
  'memory_write',
  'permission_write',
])
const SENSITIVITIES = new Set<string>(['public', 'internal', 'personal', 'auth', 'secret'])
