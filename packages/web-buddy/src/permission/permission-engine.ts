import { defaultPermissionRules, type PermissionRule } from './permission-rules.js'
import type { PermissionDecision, PermissionRequest } from './permission-types.js'

export interface PermissionEngineOptions {
  now?: () => Date
  rules?: PermissionRule[]
}

export class PermissionEngine {
  private readonly now: () => Date
  private readonly rules: PermissionRule[]

  constructor(options: PermissionEngineOptions = {}) {
    this.now = options.now ?? (() => new Date())
    this.rules = options.rules ?? defaultPermissionRules()
  }

  evaluate(request: PermissionRequest): PermissionDecision {
    for (const rule of this.rules) {
      const decision = rule.evaluate(request, { now: this.now })
      if (decision) return decision
    }
    throw new Error('PermissionEngine has no rule capable of evaluating the request.')
  }
}

export const permissionEngine = new PermissionEngine()
