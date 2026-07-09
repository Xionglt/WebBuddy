import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { PermissionDecision, PermissionMode, PermissionRequest } from './permission-types.js'
import type { PermissionRule, PermissionRuleContext } from './permission-rules.js'

export interface PersistentPermissionRule {
  schemaVersion: 'persistent-permission-rule/v1'
  id: string
  action: Extract<PermissionDecision['action'], 'allow' | 'deny'>
  scope: 'session' | 'always'
  gateKind?: string
  toolName?: string
  policyCode?: string
  origin?: string
  reason: string
  createdAt: string
  updatedAt: string
}

export interface PersistentPermissionRulesFile {
  schemaVersion: 'persistent-permission-rules/v1'
  updatedAt: string
  rules: PersistentPermissionRule[]
}

export async function loadPersistentPermissionRules(filePath: string): Promise<PersistentPermissionRule[]> {
  try {
    const raw = await readFile(filePath, 'utf8')
    const parsed = JSON.parse(raw)
    if (!isRecord(parsed) || parsed.schemaVersion !== 'persistent-permission-rules/v1' || !Array.isArray(parsed.rules)) {
      return []
    }
    return parsed.rules.filter(isPersistentPermissionRule)
  } catch (error) {
    if (isFileNotFound(error)) return []
    throw error
  }
}

export async function savePersistentPermissionRules(
  filePath: string,
  rules: PersistentPermissionRule[],
  updatedAt = new Date().toISOString(),
): Promise<void> {
  const payload: PersistentPermissionRulesFile = {
    schemaVersion: 'persistent-permission-rules/v1',
    updatedAt,
    rules: rules.map(clonePersistentPermissionRule),
  }
  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
}

export async function appendPersistentPermissionRule(
  filePath: string,
  rule: PersistentPermissionRule,
  updatedAt = new Date().toISOString(),
): Promise<PersistentPermissionRule[]> {
  const rules = await loadPersistentPermissionRules(filePath)
  const next = upsertPersistentPermissionRule(rules, rule, updatedAt)
  await savePersistentPermissionRules(filePath, next, updatedAt)
  return next
}

export function upsertPersistentPermissionRule(
  rules: PersistentPermissionRule[],
  rule: PersistentPermissionRule,
  updatedAt = new Date().toISOString(),
): PersistentPermissionRule[] {
  const next = rules.map(clonePersistentPermissionRule)
  const index = next.findIndex((item) =>
    item.action === rule.action &&
    item.scope === rule.scope &&
    item.gateKind === rule.gateKind &&
    item.toolName === rule.toolName &&
    item.policyCode === rule.policyCode &&
    item.origin === rule.origin
  )
  const value = { ...rule, updatedAt, createdAt: index >= 0 ? next[index]!.createdAt : rule.createdAt }
  if (index >= 0) next[index] = value
  else next.push(value)
  return next
}

export function persistentPermissionRuleSet(rules: PersistentPermissionRule[]): PermissionRule {
  const rememberedRules = rules.map(clonePersistentPermissionRule)
  return {
    id: 'permission.persistent_rule_set.v1',
    evaluate(request, context) {
      const matched = rememberedRules.find((rule) => matchesPersistentRule(rule, request))
      if (!matched) return undefined
      return buildPersistentDecision(matched, request, context)
    },
  }
}

export function persistentPermissionRuleFromDecision(input: {
  id: string
  decision: PermissionDecision
  request: PermissionRequest
  rememberScope?: 'session' | 'always'
  now?: string
}): PersistentPermissionRule | undefined {
  if (input.decision.action !== 'allow' && input.decision.action !== 'deny') return undefined
  const gateKind = input.decision.gateKind ?? input.request.gateKind
  if (isHardGate(gateKind)) return undefined
  if (gateKind && gateKind !== 'high_risk_action') return undefined
  if (input.request.subject.kind !== 'tool_call') return undefined
  const now = input.now ?? new Date().toISOString()
  return {
    schemaVersion: 'persistent-permission-rule/v1',
    id: input.id,
    action: input.decision.action,
    scope: input.rememberScope ?? 'always',
    ...(gateKind ? { gateKind } : {}),
    toolName: input.request.subject.toolName,
    policyCode: input.request.policy.policyCode,
    ...(originFor(input.request.currentUrl) ? { origin: originFor(input.request.currentUrl) } : {}),
    reason: input.decision.reason,
    createdAt: now,
    updatedAt: now,
  }
}

function matchesPersistentRule(rule: PersistentPermissionRule, request: PermissionRequest): boolean {
  if (isHardGate(request.gateKind)) return false
  if (rule.gateKind && rule.gateKind !== request.gateKind) return false
  if (rule.toolName && (request.subject.kind !== 'tool_call' || rule.toolName !== request.subject.toolName)) return false
  if (rule.policyCode && rule.policyCode !== request.policy.policyCode) return false
  if (rule.origin && rule.origin !== originFor(request.currentUrl)) return false
  return true
}

function buildPersistentDecision(
  rule: PersistentPermissionRule,
  request: PermissionRequest,
  context: PermissionRuleContext,
): PermissionDecision {
  return {
    schemaVersion: 'permission-decision/v1',
    requestId: request.requestId,
    action: rule.action,
    source: 'runtime_rule',
    ruleId: rule.id,
    policyCode: request.policy.policyCode,
    risk: request.risk,
    riskLevel: request.riskLevel,
    permissionMode: context.permissionMode as PermissionMode,
    reason: rule.reason,
    decidedAt: context.now().toISOString(),
    ...(rule.gateKind ? { gateKind: rule.gateKind as PermissionDecision['gateKind'] } : {}),
    rememberable: false,
    remember: {
      supportedScopes: ['once'],
      defaultScope: 'once',
    },
    auditTags: [
      `permission:${rule.action}`,
      'source:runtime_rule',
      'permission:persistent',
      `permission_mode:${context.permissionMode}`,
      `risk:${request.riskLevel}`,
      ...(rule.gateKind ? [`gate:${rule.gateKind}`] : []),
      ...request.policy.auditTags,
    ],
  }
}

function clonePersistentPermissionRule(rule: PersistentPermissionRule): PersistentPermissionRule {
  return { ...rule }
}

function isPersistentPermissionRule(value: unknown): value is PersistentPermissionRule {
  if (!isRecord(value)) return false
  return value.schemaVersion === 'persistent-permission-rule/v1' &&
    typeof value.id === 'string' &&
    (value.action === 'allow' || value.action === 'deny') &&
    (value.scope === 'session' || value.scope === 'always') &&
    typeof value.reason === 'string' &&
    typeof value.createdAt === 'string' &&
    typeof value.updatedAt === 'string' &&
    (value.gateKind === undefined || typeof value.gateKind === 'string') &&
    (value.toolName === undefined || typeof value.toolName === 'string') &&
    (value.policyCode === undefined || typeof value.policyCode === 'string') &&
    (value.origin === undefined || typeof value.origin === 'string')
}

function originFor(url: string | undefined): string | undefined {
  if (!url) return undefined
  try {
    return new URL(url).origin
  } catch {
    return undefined
  }
}

function isHardGate(gateKind: string | undefined): boolean {
  return gateKind === 'final_submit' ||
    gateKind === 'login' ||
    gateKind === 'captcha' ||
    gateKind === 'upload_resume' ||
    gateKind === 'save_resume'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFileNotFound(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT'
}
