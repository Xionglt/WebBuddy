import { defaultPermissionRules, type PermissionRule } from './permission-rules.js'
import type { PermissionDecision, PermissionMode, PermissionRequest } from './permission-types.js'

export interface PermissionEngineOptions {
  now?: () => Date
  rules?: PermissionRule[]
  permissionMode?: PermissionMode
  allowFinalSubmit?: boolean
}

export class PermissionEngine {
  private readonly now: () => Date
  private readonly rules: PermissionRule[]
  private readonly permissionMode: PermissionMode
  private readonly allowFinalSubmit: boolean

  constructor(options: PermissionEngineOptions = {}) {
    this.now = options.now ?? (() => new Date())
    this.rules = options.rules ?? defaultPermissionRules()
    this.permissionMode = options.permissionMode ?? 'safe'
    this.allowFinalSubmit = options.allowFinalSubmit ?? false
  }

  decide(request: PermissionRequest): PermissionDecision {
    return this.evaluate(request)
  }

  evaluate(request: PermissionRequest): PermissionDecision {
    for (const rule of this.rules) {
      const decision = rule.evaluate(request, {
        now: this.now,
        permissionMode: this.permissionMode,
        allowFinalSubmit: this.allowFinalSubmit,
      })
      if (decision) return decision
    }
    throw new Error('PermissionEngine has no rule capable of evaluating the request.')
  }
}

export const permissionEngine = new PermissionEngine()
