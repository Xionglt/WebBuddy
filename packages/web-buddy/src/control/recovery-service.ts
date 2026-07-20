import type { RunRecord, ScopedStoreQuery } from './store-contracts.js'
import { ApprovalService, RunService } from './run-service.js'

export interface RecoveryDecision {
  runId: string
  fromState: RunRecord['state']
  toState: RunRecord['state']
  recoverable: boolean
  reason: string
}

export interface RecoveryServiceOptions {
  canRestoreSession?: (record: RunRecord) => boolean | Promise<boolean>
}

/**
 * Startup recovery classifies abandoned attempts but never launches them.
 * Explicit resume is a separate command and creates a new revision/attempt.
 */
export class RecoveryService {
  constructor(
    readonly runs: RunService,
    readonly approvals: ApprovalService,
    readonly options: RecoveryServiceOptions = {},
  ) {}

  async recoverStartupRuns(scope?: ScopedStoreQuery): Promise<RecoveryDecision[]> {
    const page = await this.runs.list({
      ...(scope?.ownerScope ? { ownerScope: scope.ownerScope } : {}),
      states: ['running', 'pausing', 'resuming', 'cancelling'],
      limit: 1000,
    })
    const decisions: RecoveryDecision[] = []
    for (const record of page.items) {
      if (record.state === 'cancelling') {
        const reason = 'Process restarted while cancellation was settling; no write action was replayed.'
        const failed = await this.runs.transition(record.runId, {
          to: 'failed',
          reason,
          idempotencyKey: `startup-cancel-failed:${record.recordRevision}`,
          eventType: 'recovery_classified',
          data: { recoverable: false, replayedAction: false },
        }, scope)
        await this.approvals.cancelPendingForRun(
          record.runId,
          'Run was interrupted while cancellation was settling.',
          `startup-cancel-approvals:${record.runRevision}:${record.attempt}`,
          scope,
        )
        decisions.push({ runId: record.runId, fromState: record.state, toState: failed.state, recoverable: false, reason })
        continue
      }

      const restartSafe = record.inputSnapshot.goal.metadata?.restartSafe === true
      let sessionExists = false
      let restoreFailure: string | undefined
      if (record.sessionRef) {
        try {
          sessionExists = await this.options.canRestoreSession?.(record) ?? true
        } catch (error) {
          restoreFailure = error instanceof Error ? error.message : String(error)
        }
      }
      const recoverable = restartSafe && sessionExists
      const reason = recoverable
        ? 'Process restarted; explicit resume may restore the durable session, re-observe the page and start a fenced new attempt.'
        : restoreFailure
          ? `Process restarted but the durable session failed validation (${restoreFailure}); write actions will not be replayed.`
          : 'Process restarted without both a restorable durable session and a read-only restart contract; write actions will not be replayed.'
      const classified = await this.runs.classifyInterrupted(
        record.runId,
        recoverable,
        reason,
        `startup-recovery:${record.recordRevision}`,
        scope,
      )
      await this.approvals.cancelPendingForRun(
        record.runId,
        'Approval invalidated by process restart and run interruption.',
        `startup-approval-fence:${record.runRevision}:${record.attempt}`,
        scope,
      )
      decisions.push({
        runId: record.runId,
        fromState: record.state,
        toState: classified.state,
        recoverable,
        reason,
      })
    }
    return decisions
  }
}
