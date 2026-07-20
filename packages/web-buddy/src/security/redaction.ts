import type { JsonValue, SensitiveDataClass } from '../task/contracts.js'

export interface RedactionFinding {
  schemaVersion: 'redaction-finding/v1'
  path: string
  sensitiveClass: SensitiveDataClass
  reason: string
}

export interface RedactionResult {
  schemaVersion: 'redaction-result/v1'
  value: JsonValue
  findings: RedactionFinding[]
  changed: boolean
}

export type PersistenceSanitizer = (value: unknown) => unknown

const SECRET_KEY = /(?:password|passwd|secret|token|cookie|authorization|api[-_]?key|otp|captcha|storageState)/i
const PERSONAL_KEY = /(?:identity|id[-_]?number|passport|credit[-_]?card|card[-_]?number)/i
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi
const API_KEY = /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{12,}\b/g
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g

export function redactSensitiveData(value: unknown): RedactionResult {
  const findings: RedactionFinding[] = []
  const redacted = visit(value, '$', undefined, findings)
  return {
    schemaVersion: 'redaction-result/v1',
    value: redacted,
    findings,
    changed: findings.length > 0,
  }
}

export function sanitizeForPersistence(
  value: unknown,
  sanitizer?: PersistenceSanitizer,
): JsonValue {
  return redactSensitiveData(sanitizer ? sanitizer(value) : value).value
}

function visit(
  value: unknown,
  path: string,
  key: string | undefined,
  findings: RedactionFinding[],
): JsonValue {
  if (key && SECRET_KEY.test(key) && value !== null && value !== '') {
    findings.push(finding(path, secretClassForKey(key), `Sensitive key ${key} was redacted.`))
    return `[REDACTED:${secretClassForKey(key)}]`
  }
  if (key && PERSONAL_KEY.test(key) && value !== null && value !== '') {
    findings.push(finding(path, 'identity', `Identity-bearing key ${key} was redacted.`))
    return '[REDACTED:identity]'
  }
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : '[REDACTED:secret]'
  if (typeof value === 'string') return redactString(value, path, findings)
  if (Array.isArray(value)) {
    return value.map((item, index) => visit(item, `${path}[${index}]`, undefined, findings))
  }
  if (typeof value === 'object' && value) {
    const output: Record<string, JsonValue> = {}
    for (const [childKey, child] of Object.entries(value)) {
      output[childKey] = visit(child, `${path}.${childKey}`, childKey, findings)
    }
    return output
  }
  if (value === undefined) return null
  findings.push(finding(path, 'token', 'Non-JSON runtime value was removed.'))
  return '[REDACTED:secret]'
}

function redactString(
  value: string,
  path: string,
  findings: RedactionFinding[],
): string {
  let result = value
  result = replace(result, BEARER, '[REDACTED:token]', path, 'token', 'Bearer token', findings)
  result = replace(result, API_KEY, '[REDACTED:token]', path, 'token', 'API key', findings)
  result = replace(result, JWT, '[REDACTED:token]', path, 'token', 'JWT', findings)
  return result
}

function replace(
  input: string,
  pattern: RegExp,
  replacement: string,
  path: string,
  sensitiveClass: SensitiveDataClass,
  label: string,
  findings: RedactionFinding[],
): string {
  pattern.lastIndex = 0
  if (!pattern.test(input)) return input
  pattern.lastIndex = 0
  findings.push(finding(path, sensitiveClass, `${label} was redacted.`))
  return input.replace(pattern, replacement)
}

function secretClassForKey(key: string): SensitiveDataClass {
  if (/cookie/i.test(key)) return 'cookie'
  if (/password|passwd/i.test(key)) return 'password'
  if (/otp/i.test(key)) return 'otp'
  if (/captcha/i.test(key)) return 'captcha'
  return 'token'
}

function finding(
  path: string,
  sensitiveClass: SensitiveDataClass,
  reason: string,
): RedactionFinding {
  return {
    schemaVersion: 'redaction-finding/v1',
    path,
    sensitiveClass,
    reason,
  }
}
