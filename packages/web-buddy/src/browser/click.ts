import { toolFailure, toolSuccess } from '../errors.js'
import { resolveRefWithSnapshotRetry } from '../snapshot/ref-resolver.js'
import { sessionManager } from '../session/manager.js'
import { clearHighlight, visualizeBeforeAction } from '../sdk/highlight.js'
import { detectModalInterception } from './modal-guard.js'
import { capturePostconditionSnapshot, diffPostcondition } from './postcondition.js'

function isHeadful(): boolean {
  return process.env.PLAYWRIGHT_HEADLESS === 'false'
}

export async function browserClick(input: {
  ref: string
  sessionId?: string
  timeoutMs?: number
  confirmed?: boolean
  /** When true and the browser is headful, flash an outline + move the mouse first. */
  highlight?: boolean
}) {
  const session = sessionManager.get(input.sessionId)
  if (!session) {
    return toolFailure('SESSION_NOT_FOUND', 'No browser session found. Call browser_open first.', {
      suggestedNextActions: ['browser_open'],
    })
  }

  const resolved = await resolveRefWithSnapshotRetry(session.page, session.latestSnapshot, input.ref, session.id)
  if (!resolved.ok) return resolved.failure

  const { locator, stored } = resolved
  const timeout = input.timeoutMs ?? Number(process.env.PLAYWRIGHT_ACTION_TIMEOUT_MS || 10000)

  if (stored.risk === 'L3' && input.confirmed !== true) {
    return toolFailure('CONFIRMATION_REQUIRED', `Ref ${input.ref} (${stored.name || stored.text || stored.tag}) is high-risk and requires explicit user confirmation before clicking.`, {
      recoverable: true,
      suggestedNextActions: ['Ask the user to confirm this action, then retry browser_click with confirmed=true.'],
    })
  }

  const modal = await detectModalInterception(locator)
  if (modal.present) {
    return toolFailure(
      'ACTIONABLE_DIALOG_PRESENT',
      [
        `A visible dialog is blocking ref ${input.ref}; handle the dialog before clicking background page controls.`,
        modal.text ? `Dialog text: ${modal.text}` : undefined,
        modal.controls.length ? `Dialog controls: ${modal.controls.join(', ')}` : undefined,
      ].filter(Boolean).join(' '),
      {
        recoverable: true,
        data: { dialogText: modal.text, controls: modal.controls, reason: modal.reason },
        suggestedNextActions: ['browser_snapshot', 'browser_click_text on a visible dialog control'],
      },
    )
  }

  if (input.highlight && isHeadful()) {
    const action = stored.risk === 'L3' || stored.risk === 'L4' ? 'click_risky' : 'click_safe'
    await visualizeBeforeAction(session.page, locator, action)
  }

  const navigationActionSeq = sessionManager.beginNavigationAction(session.id)
  try {
    const before = await capturePostconditionSnapshot(session.page, {
      targetLocator: locator,
      captureTargetState: true,
    })
    await locator.click({ timeout })
    await session.page.waitForTimeout(120).catch(() => {})
    const blockedNavigation = sessionManager.consumeBlockedNavigation(session.id, navigationActionSeq)
    if (blockedNavigation) {
      return toolFailure('NAVIGATION_BLOCKED', blockedNavigation.reason, { recoverable: false })
    }
    const after = await capturePostconditionSnapshot(session.page, {
      targetLocator: locator,
      captureTargetState: true,
    })
    const postcondition = diffPostcondition(before, after)
    if (input.highlight && isHeadful()) await clearHighlight(session.page)
    sessionManager.invalidateSnapshot(session.id)

    const riskNote = stored.risk === 'L3'
      ? ' High-risk submit-like element clicked. Confirm with user before proceeding.'
      : stored.risk === 'L4'
        ? ' Sensitive element clicked. Extra confirmation recommended.'
        : ''
    const noOpNote = postcondition.outcome === 'no_op' || postcondition.outcome === 'uncertain'
      ? ` NO_OP_OR_UNCERTAIN: clicked ref ${input.ref} but page state did not materially change (outcome=${postcondition.outcome}). Do not assume success; re-snapshot and choose a different locator or report uncertain.`
      : ''

    return toolSuccess(`Clicked ref ${input.ref} (${stored.name || stored.text || stored.tag}).${riskNote}${noOpNote}`, {
      ref: input.ref,
      risk: stored.risk,
      url: session.page.url(),
      postcondition: {
        outcome: postcondition.outcome,
        changedSignals: postcondition.changedSignals,
        before: {
          targetChecked: postcondition.before.targetChecked,
          targetDisabled: postcondition.before.targetDisabled,
          targetValue: postcondition.before.targetValue,
          url: postcondition.before.url,
        },
        after: {
          targetChecked: postcondition.after.targetChecked,
          targetDisabled: postcondition.after.targetDisabled,
          targetValue: postcondition.after.targetValue,
          url: postcondition.after.url,
        },
      },
    }, postcondition.outcome !== 'no_op' && postcondition.outcome !== 'uncertain')
  } catch (error) {
    const blockedNavigation = sessionManager.consumeBlockedNavigation(session.id, navigationActionSeq)
    if (blockedNavigation) {
      return toolFailure('NAVIGATION_BLOCKED', blockedNavigation.reason, { recoverable: false })
    }
    const message = error instanceof Error ? error.message : String(error)
    if (input.highlight && isHeadful()) await clearHighlight(session.page)
    return toolFailure('ELEMENT_NOT_FOUND', `Failed to click ref ${input.ref}: ${message}`, {
      recoverable: true,
      suggestedNextActions: ['browser_snapshot'],
    })
  }
}
