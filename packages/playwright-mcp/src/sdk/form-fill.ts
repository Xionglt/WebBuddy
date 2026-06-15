import type { ElementRef } from '../types.js'
import { browserClick } from '../browser/click.js'
import { browserSnapshot } from '../browser/snapshot.js'
import { browserType } from '../browser/type.js'
import { sessionManager } from '../session/manager.js'
import type { HumanGate } from './human.js'
import type { ResumeProfile } from './resume.js'
import type { TraceRecorder } from './trace.js'

interface FieldPlan {
  label: string
  ref: string
  value: string
}

const FIELD_MATCHERS: Array<{ key: keyof ResumeProfile; re: RegExp; label: string }> = [
  { key: 'name', re: /name|姓名|全名|真实姓名/i, label: 'name' },
  { key: 'email', re: /email|邮箱|e-mail|电子邮箱/i, label: 'email' },
  { key: 'phone', re: /phone|tel|手机|电话|mobile/i, label: 'phone' },
]

function scoreElementForField(el: ElementRef, re: RegExp): number {
  const haystack = [el.name, el.text, el.locatorHints.aria, el.locatorHints.text]
    .filter(Boolean)
    .join(' ')
  return re.test(haystack) ? 1 : 0
}

/** Map parsed-resume values onto visible form inputs by label/placeholder. */
function planFields(elements: ElementRef[], profile: ResumeProfile): FieldPlan[] {
  const plans: FieldPlan[] = []
  for (const { key, re, label } of FIELD_MATCHERS) {
    const value = profile[key]
    if (!value) continue
    const ref = elements
      .filter((e) => e.tag === 'input' || e.tag === 'textarea')
      .filter((e) => e.risk === 'L2' || e.risk === 'L4' || !e.risk)
      .find((e) => scoreElementForField(e, re) > 0)?.ref
    if (ref) plans.push({ label, ref, value: String(value) })
  }
  return plans
}

export interface FillResult {
  filled: Array<{ label: string; ref: string; ok: boolean; observation: string }>
  saveButton?: ElementRef
  submitButton?: ElementRef
  stoppedAt: 'save' | 'submit' | 'complete' | 'no_fields'
}

/**
 * Fill a resume-draft form on the current page using the parsed profile.
 *
 * Safety contract:
 *   - Every typed field is L2 (non-destructive).
 *   - Before clicking SAVE, the human gate ('save_resume') is consulted.
 *   - The final SUBMIT is NEVER clicked — the gate ('final_submit') is always
 *     raised and the loop stops there, returning stoppedAt='submit'.
 */
export async function fillResumeDraft(
  sessionId: string,
  profile: ResumeProfile,
  gate: HumanGate,
  trace: TraceRecorder,
  highlight: boolean,
): Promise<FillResult> {
  const snap = await browserSnapshot({ sessionId })
  if (!snap.ok) {
    trace.record({
      phase: 'fill_draft',
      action: `Snapshot failed: ${snap.error.message}`,
      status: 'error',
    })
    return { filled: [], stoppedAt: 'no_fields' }
  }

  const elements = snap.data.elements
  const plans = planFields(elements, profile)
  const saveButton = elements.find((e) => isSaveButton(e))
  const submitButton = elements.find(
    (e) => e !== saveButton && isSubmitButton(e),
  )

  const filled: FillResult['filled'] = []
  for (const plan of plans) {
    const result = await browserType({
      ref: plan.ref,
      text: plan.value,
      sessionId,
      highlight,
    })
    filled.push({
      label: plan.label,
      ref: plan.ref,
      ok: result.ok,
      observation: result.ok ? result.observation : result.error.message,
    })
    trace.record({
      phase: 'fill_draft',
      action: `Fill ${plan.label}`,
      url: sessionManager.get(sessionId)?.page.url(),
      risk: 'L2',
      status: result.ok ? 'ok' : 'warn',
      screenshotPath: highlight ? await trace.screenshot(sessionManager.get(sessionId)?.page, `fill-${plan.label}`) : undefined,
      observation: result.ok ? result.observation : result.error.message,
    })
  }

  if (plans.length === 0) {
    return { filled, saveButton, submitButton, stoppedAt: 'no_fields' }
  }

  // SAVE gate
  if (saveButton) {
    const decision = await gate.confirm('save_resume', `Save the on-site resume draft?`, {
      detail: 'This persists the draft to your Alibaba account.',
    })
    if (decision === 'approve') {
      const click = await browserClick({ ref: saveButton.ref, sessionId, confirmed: true, highlight })
      trace.record({
        phase: 'fill_draft',
        action: `Save draft (approved)`,
        url: sessionManager.get(sessionId)?.page.url(),
        risk: 'L3',
        status: click.ok ? 'ok' : 'warn',
        observation: click.ok ? click.observation : click.error.message,
      })
    } else {
      trace.record({
        phase: 'fill_draft',
        action: `Save draft skipped (${decision})`,
        url: sessionManager.get(sessionId)?.page.url(),
        risk: 'L3',
        status: 'blocked',
        observation: 'Human chose to handle save manually or declined.',
      })
      return { filled, saveButton, submitButton, stoppedAt: 'save' }
    }
  }

  // SUBMIT gate — always raised, never auto-clicked.
  if (submitButton) {
    const decision = await gate.confirm(
      'final_submit',
      `Submit the application for real?`,
      { detail: 'This is irreversible. The MVP will NOT auto-submit.' },
    )
    trace.record({
      phase: 'fill_draft',
      action: `Final submit gate: ${decision}`,
      url: sessionManager.get(sessionId)?.page.url(),
      risk: 'L3',
      status: decision === 'approve' ? 'warn' : 'blocked',
      observation:
        decision === 'approve'
          ? 'Human approved — but MVP refuses to auto-submit. Do it manually.'
          : 'Submission halted by human gate.',
    })
    return { filled, saveButton, submitButton, stoppedAt: 'submit' }
  }

  return { filled, saveButton, submitButton, stoppedAt: 'complete' }
}

/** A save-draft button is matched by label text (the risk tier is secondary). */
function isSaveButton(el: ElementRef): boolean {
  if (el.tag !== 'button' && el.role !== 'button') return false
  const label = [el.name, el.text, el.locatorHints.aria].filter(Boolean).join(' ')
  return /save|保存|暂存|存为草稿|draft/i.test(label)
}

/** A submit button is matched by label text or type=submit. */
function isSubmitButton(el: ElementRef): boolean {
  if (el.tag !== 'button' && el.role !== 'button') return false
  const label = [el.name, el.text, el.locatorHints.aria].filter(Boolean).join(' ')
  return /submit|投递|提交申请|确认投递|递交|deliver|apply|发送申请|send application/i.test(label)
}
