import { toolFailure, toolSuccess } from '../errors.js'
import { buildSnapshot } from '../snapshot/builder.js'
import { sessionManager } from '../session/manager.js'

export async function browserSnapshot(input: {
  sessionId?: string
  maxElements?: number
}) {
  const session = sessionManager.get(input.sessionId)
  if (!session) {
    return toolFailure('SESSION_NOT_FOUND', 'No browser session found. Call browser_open first.', {
      recoverable: true,
      suggestedNextActions: ['browser_open'],
    })
  }

  try {
    const record = await buildSnapshot(session.page, { maxElements: input.maxElements })
    sessionManager.setSnapshot(session.id, record)

    const { snapshot } = record
    const observation = `Snapshot ${snapshot.snapshotId}: ${snapshot.title} (${snapshot.stats.interactiveCount} interactive elements)`
    return toolSuccess(observation, snapshot)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return toolFailure('PAGE_CRASHED', `Failed to capture snapshot: ${message}`, {
      recoverable: true,
      suggestedNextActions: ['browser_open', 'browser_wait'],
    })
  }
}
