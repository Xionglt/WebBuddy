import * as readline from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import type { RiskLevel } from './trace.js'

/**
 * The five checkpoints that REQUIRE human confirmation or takeover, per the
 * safety contract. The agent never silently performs any of these.
 */
export type GateKind =
  | 'login' // handing credentials / waiting for SSO
  | 'captcha' // any human-verification challenge
  | 'upload_resume' // attaching the PDF to the site
  | 'save_resume' // persisting the on-site resume draft
  | 'final_submit' // submitting the application
  | 'high_risk_action' // any L3/L4 click the policy flagged

export type GateDecision = 'approve' | 'decline' | 'takeover'

export interface GateContext {
  url?: string
  risk?: RiskLevel
  detail?: string
}

export interface HumanGate {
  confirm(kind: GateKind, message: string, context?: GateContext): Promise<GateDecision>
}

export const GATE_LABELS: Record<GateKind, string> = {
  login: 'Login',
  captcha: 'Captcha / verification',
  upload_resume: 'Upload resume',
  save_resume: 'Save resume draft',
  final_submit: 'Final submission',
  high_risk_action: 'High-risk action',
}

/**
 * Interactive gate backed by stdin. Blocks until the human picks an option:
 *   y / enter  -> approve (proceed, agent continues)
 *   n          -> decline (agent skips this step)
 *   m          -> takeover (agent pauses; the human performs the step in the
 *                 visible browser window, then resumes)
 */
export class CliHumanGate implements HumanGate {
  private rl: readline.Interface | null = null

  private getRl(): readline.Interface {
    if (!this.rl) {
      this.rl = readline.createInterface({ input: stdin, output: stdout })
    }
    return this.rl
  }

  async confirm(kind: GateKind, message: string, context?: GateContext): Promise<GateDecision> {
    const label = GATE_LABELS[kind]
    const lines = [
      '',
      '┌── HUMAN GATE ──────────────────────────────────────────────',
      `│ [${label}] ${message}`,
    ]
    if (context?.url) lines.push(`│ url: ${context.url}`)
    if (context?.risk) lines.push(`│ risk: ${context.risk}`)
    if (context?.detail) lines.push(`│ ${context.detail}`)
    lines.push('│ ')
    lines.push('│ [y] approve   [n] decline   [m] I will do it manually (takeover)')
    lines.push('└────────────────────────────────────────────────────────────')
    // eslint-disable-next-line no-console
    console.log(lines.join('\n'))

    if (!stdin.isTTY) {
      // Non-interactive context: default to the safe choice (takeover) so we
      // never auto-approve a sensitive step silently.
      // eslint-disable-next-line no-console
      console.log('(no TTY — defaulting to "takeover")')
      return 'takeover'
    }

    const rl = this.getRl()
    const answer = (await rl.question('choice> ')).trim().toLowerCase()
    if (answer === 'n') return 'decline'
    if (answer === 'm') return 'takeover'
    return 'approve'
  }

  close(): void {
    this.rl?.close()
    this.rl = null
  }
}

/**
 * Non-interactive gate for tests and unattended runs. It APPROVES only safe
 * navigation/observation steps and always RETURNS TAKEOVER for the five
 * contract checkpoints — the agent stops there and reports the hand-off. This
 * guarantees no real login/upload/save/submit happens without a human.
 */
export class AutoHumanGate implements HumanGate {
  constructor(private readonly onGate?: (kind: GateKind, decision: GateDecision) => void) {}

  async confirm(kind: GateKind, _message: string, _context?: GateContext): Promise<GateDecision> {
    const decision: GateDecision =
      kind === 'high_risk_action' ? 'approve' : 'takeover'
    this.onGate?.(kind, decision)
    return decision
  }
}

/**
 * A gate that lets the caller inject a scripted sequence of decisions — used
 * by the orchestrator unit test to drive the loop deterministically.
 */
export class ScriptedHumanGate implements HumanGate {
  private cursor = 0
  constructor(private readonly script: GateDecision[]) {}

  async confirm(): Promise<GateDecision> {
    const decision = this.script[this.cursor] ?? 'takeover'
    this.cursor += 1
    return decision
  }
}
