import { toolFailure, toolSuccess } from '../errors.js'
import { observationManager } from '../observation/observation-manager.js'
import { sessionManager } from '../session/manager.js'
import { collectFormSnapshotFromPage } from './form-collector.js'
import { collectPageFacts } from './page-facts.js'

export async function browserFormSnapshot(input: {
  sessionId?: string
  maxFields?: number
}) {
  const session = sessionManager.get(input.sessionId)
  if (!session) {
    return toolFailure('SESSION_NOT_FOUND', 'No browser session found. Call browser_open first.', {
      suggestedNextActions: ['browser_open'],
    })
  }

  try {
    const result = await collectFormSnapshotFromPage(session.page, { maxFields: input.maxFields })
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
      `Form snapshot captured ${result.fields?.length ?? 0} viewport fields and ${result.uploadHints.length} upload hints; scope=viewport, complete=false.`,
      data,
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return toolFailure('PAGE_CRASHED', `Failed to capture form snapshot: ${message}`, {
      recoverable: true,
      suggestedNextActions: ['browser_snapshot', 'browser_form_snapshot'],
    })
  }
}
