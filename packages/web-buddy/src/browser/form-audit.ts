import { toolFailure, toolSuccess } from '../errors.js'
import { observationManager } from '../observation/observation-manager.js'
import { sessionManager } from '../session/manager.js'
import { auditFormSnapshotFromPage } from './form-collector.js'
import { collectPageFacts } from './page-facts.js'

export async function browserFormAudit(input: {
  sessionId?: string
  maxFields?: number
  waitMs?: number
}) {
  const session = sessionManager.get(input.sessionId)
  if (!session) {
    return toolFailure('SESSION_NOT_FOUND', 'No browser session found. Call browser_open first.', {
      suggestedNextActions: ['browser_open'],
    })
  }

  try {
    const result = await auditFormSnapshotFromPage(session.page, {
      maxFields: input.maxFields,
      waitMs: input.waitMs,
    })
    const [title, facts] = await Promise.all([
      session.page.title(),
      collectPageFacts(session.page).catch(() => undefined),
    ])
    const data = {
      url: session.page.url(),
      title,
      ...(facts ? { facts } : {}),
      ...result,
    }

    try {
      observationManager.refreshFormState({ sessionId: session.id, formSnapshot: data })
    } catch {
      // Observation artifacts are best-effort diagnostics.
    }

    return toolSuccess(
      `Form audit scanned ${result.formCoverage.segments} segments and found ${result.fields?.length ?? 0} unique fields.`,
      data,
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return toolFailure('PAGE_CRASHED', `Failed to audit form: ${message}`, {
      recoverable: true,
      suggestedNextActions: ['browser_form_snapshot', 'browser_form_audit'],
    })
  }
}
