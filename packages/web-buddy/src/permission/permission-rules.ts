import type { GateKind } from '../sdk/human.js'
import type { PermissionDecision, PermissionMode, PermissionRequest, PermissionRememberScope } from './permission-types.js'

export interface PermissionRuleContext {
  now: () => Date
  permissionMode: PermissionMode
  allowFinalSubmit: boolean
}

export interface PermissionRule {
  id: string
  evaluate(request: PermissionRequest, context: PermissionRuleContext): PermissionDecision | undefined
}

export function defaultPermissionRules(): PermissionRule[] {
  return [
    policyBlockRule(),
    rawAutoConfirmRule(),
    finalSubmitRule(),
    uploadRule(),
    loginCaptchaRule(),
    permissionModeAutoAllowRule(),
    policyGateRule(),
    highRiskRule(),
    policyAllowRule(),
    defaultAllowRule(),
  ]
}

function policyBlockRule(): PermissionRule {
  return {
    id: 'permission.policy_block.deny.v1',
    evaluate(request, context) {
      if (request.policy.action !== 'block') return undefined
      return buildDecision(request, context, {
        action: 'deny',
        source: 'policy',
        ruleId: request.policy.ruleId,
        reason: request.policy.reason,
      })
    },
  }
}

function rawAutoConfirmRule(): PermissionRule {
  return {
    id: 'permission.raw_auto_confirm.allow.v1',
    evaluate(request, context) {
      if (request.policy.action !== 'auto_confirm') return undefined
      return buildDecision(request, context, {
        action: 'allow',
        source: 'policy',
        ruleId: request.policy.ruleId,
        reason: request.policy.reason,
        extraAuditTags: ['permission:raw_auto_confirm', 'compat:auto_confirm'],
      })
    },
  }
}

function finalSubmitRule(): PermissionRule {
  return {
    id: 'permission.final_submit.ask.v1',
    evaluate(request, context) {
      if (gateKindFor(request) !== 'final_submit') return undefined
      if (context.permissionMode === 'autopilot' && context.allowFinalSubmit) {
        return buildDecision(request, context, {
          action: 'allow',
          source: 'config_rule',
          ruleId: 'permission.mode.autopilot.final_submit.allow.v1',
          reason: 'Final-submit action was explicitly allowed by allowFinalSubmit in autopilot mode.',
          gateKind: 'final_submit',
          extraAuditTags: [
            'permission:auto_allow',
            'auto_allow:permission_mode',
            'allow_final_submit:true',
          ],
        })
      }
      return buildDecision(request, context, {
        action: 'ask',
        source: 'policy',
        ruleId: request.policy.ruleId,
        reason: request.policy.reason,
        gateKind: 'final_submit',
      })
    },
  }
}

function uploadRule(): PermissionRule {
  return {
    id: 'permission.upload_resume.ask.v1',
    evaluate(request, context) {
      if (request.subject.kind === 'tool_call' && request.subject.toolName !== 'browser_upload_file') {
        if (gateKindFor(request) !== 'upload_resume') return undefined
      }
      if (request.subject.kind !== 'tool_call' && gateKindFor(request) !== 'upload_resume') return undefined
      return buildDecision(request, context, {
        action: 'ask',
        source: 'policy',
        ruleId: request.policy.ruleId,
        reason: request.policy.reason,
        gateKind: 'upload_resume',
      })
    },
  }
}

function loginCaptchaRule(): PermissionRule {
  return {
    id: 'permission.workflow_handoff.ask.v1',
    evaluate(request, context) {
      const gateKind = workflowHandoffKindFor(request)
      if (!gateKind) return undefined
      return buildDecision(request, context, {
        action: 'ask',
        source: 'policy',
        ruleId: request.policy.ruleId,
        reason: request.policy.reason,
        gateKind,
      })
    },
  }
}

function permissionModeAutoAllowRule(): PermissionRule {
  return {
    id: 'permission.mode.auto_allow.v1',
    evaluate(request, context) {
      if (!isPermissionModeAutoAllowable(request, context)) return undefined
      return buildDecision(request, context, {
        action: 'allow',
        source: 'config_rule',
        ruleId: `permission.mode.${context.permissionMode}.auto_allow.v1`,
        reason: autoAllowReasonForMode(context.permissionMode),
        gateKind: gateKindFor(request) ?? 'high_risk_action',
        extraAuditTags: [
          'permission:auto_allow',
          'auto_allow:permission_mode',
          `auto_allowed_by:${context.permissionMode}`,
        ],
      })
    },
  }
}

function policyGateRule(): PermissionRule {
  return {
    id: 'permission.policy_gate.ask.v1',
    evaluate(request, context) {
      if (request.policy.action !== 'gate') return undefined
      return buildDecision(request, context, {
        action: 'ask',
        source: 'policy',
        ruleId: request.policy.ruleId,
        reason: request.policy.reason,
        gateKind: gateKindFor(request) ?? 'high_risk_action',
      })
    },
  }
}

function highRiskRule(): PermissionRule {
  return {
    id: 'permission.high_risk.ask.v1',
    evaluate(request, context) {
      if (!isHighRisk(request)) return undefined
      return buildDecision(request, context, {
        action: 'ask',
        source: 'default_rule',
        ruleId: 'permission.high_risk.ask.v1',
        reason: 'High-risk action requires permission before execution.',
        gateKind: gateKindFor(request) ?? 'high_risk_action',
      })
    },
  }
}

function policyAllowRule(): PermissionRule {
  return {
    id: 'permission.policy_allow.allow.v1',
    evaluate(request, context) {
      if (request.policy.action !== 'allow') return undefined
      return buildDecision(request, context, {
        action: 'allow',
        source: 'policy',
        ruleId: request.policy.ruleId,
        reason: request.policy.reason,
      })
    },
  }
}

function defaultAllowRule(): PermissionRule {
  return {
    id: 'permission.default_allow.v1',
    evaluate(request, context) {
      return buildDecision(request, context, {
        action: 'allow',
        source: 'default_rule',
        ruleId: 'permission.default_allow.v1',
        reason: 'No permission rule required a user approval or denial.',
      })
    },
  }
}

function buildDecision(
  request: PermissionRequest,
  context: PermissionRuleContext,
  input: {
    action: PermissionDecision['action']
    source: PermissionDecision['source']
    ruleId: string
    reason: string
    gateKind?: GateKind
    extraAuditTags?: string[]
  },
): PermissionDecision {
  const gateKind = input.gateKind ?? gateKindFor(request)
  const rememberScopes = rememberScopesFor(input.action, gateKind)
  return {
    schemaVersion: 'permission-decision/v1',
    requestId: request.requestId,
    action: input.action,
    source: input.source,
    ruleId: input.ruleId,
    policyCode: request.policy.policyCode,
    risk: request.risk,
    riskLevel: request.riskLevel,
    permissionMode: context.permissionMode,
    reason: input.reason,
    decidedAt: context.now().toISOString(),
    ...(gateKind ? { gateKind } : {}),
    ...(request.policy.requiresFreshContext ? { requiresFreshContext: true } : {}),
    rememberable: rememberScopes.length > 1,
    remember: {
      supportedScopes: rememberScopes,
      defaultScope: 'once',
    },
    auditTags: unique([
      `permission:${input.action}`,
      `source:${input.source}`,
      `risk:${request.riskLevel}`,
      `permission_mode:${context.permissionMode}`,
      ...(gateKind ? [`gate:${gateKind}`] : []),
      ...request.policy.auditTags,
      ...(input.extraAuditTags ?? []),
    ]),
  }
}

function rememberScopesFor(action: PermissionDecision['action'], gateKind: GateKind | undefined): PermissionRememberScope[] {
  if (action !== 'ask') return ['once']
  if (gateKind === 'high_risk_action') return ['once', 'session']
  return ['once']
}

function gateKindFor(request: PermissionRequest): GateKind | undefined {
  return request.gateKind
}

function workflowHandoffKindFor(request: PermissionRequest): Extract<GateKind, 'login' | 'captcha'> | undefined {
  if (request.subject.kind === 'workflow_handoff') return request.subject.handoffKind
  if (request.gateKind === 'login' || request.gateKind === 'captcha') return request.gateKind
  if (request.workflowPhase === 'login_required') return 'login'
  if (request.workflowPhase === 'captcha_required') return 'captcha'
  return undefined
}

function isPermissionModeAutoAllowable(request: PermissionRequest, context: PermissionRuleContext): boolean {
  if (context.permissionMode === 'safe') return false
  if (request.policy.action !== 'gate') return false
  if (request.subject.kind === 'workflow_handoff') return false
  if (!isHighRisk(request)) return false
  if (request.risk === 'L4' || request.riskLevel === 'critical') return false

  const gateKind = gateKindFor(request)
  if (isSensitiveGate(gateKind)) return false
  return gateKind === undefined || gateKind === 'high_risk_action'
}

function isSensitiveGate(gateKind: GateKind | undefined): boolean {
  return gateKind === 'login' ||
    gateKind === 'captcha' ||
    gateKind === 'upload_resume' ||
    gateKind === 'save_resume' ||
    gateKind === 'final_submit'
}

function isHighRisk(request: PermissionRequest): boolean {
  return request.risk === 'L3' || request.risk === 'L4' || request.riskLevel === 'high' || request.riskLevel === 'critical'
}

function autoAllowReasonForMode(mode: PermissionMode): string {
  if (mode === 'review') {
    return 'Review permission mode auto-allows non-final L3 high-risk actions while keeping sensitive gates human-controlled.'
  }
  if (mode === 'trusted') {
    return 'Trusted permission mode auto-allows non-final L3 application-flow actions while keeping sensitive gates human-controlled.'
  }
  return 'Autopilot permission mode auto-allows non-final high-risk actions while final submit remains gated by default.'
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))]
}
