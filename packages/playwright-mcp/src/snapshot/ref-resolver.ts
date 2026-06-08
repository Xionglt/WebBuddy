import type { Locator, Page } from 'playwright'
import type { SnapshotRecord, StoredRef } from '../types.js'
import { toolFailure } from '../errors.js'

export async function resolveRef(
  page: Page,
  snapshotRecord: SnapshotRecord | null,
  ref: string,
): Promise<{ ok: true; locator: Locator; stored: StoredRef } | { ok: false; failure: ReturnType<typeof toolFailure> }> {
  if (!snapshotRecord) {
    return {
      ok: false,
      failure: toolFailure('REF_STALE', `No active snapshot. Call browser_snapshot before using ref "${ref}".`, {
        suggestedNextActions: ['browser_snapshot'],
      }),
    }
  }

  const stored = snapshotRecord.refMap.get(ref)
  if (!stored) {
    return {
      ok: false,
      failure: toolFailure('ELEMENT_NOT_FOUND', `Unknown ref "${ref}".`, {
        recoverable: true,
        suggestedNextActions: ['browser_snapshot'],
      }),
    }
  }

  const attempts: Array<() => Locator | null> = [
    () => (stored.css ? page.locator(stored.css).first() : null),
    () => (stored.aria ? page.getByLabel(stored.aria).first() : null),
    () =>
      stored.name
        ? page.getByRole((stored.role as 'button' | 'link' | 'textbox' | 'combobox' | 'searchbox') || 'button', {
            name: stored.name,
          }).first()
        : null,
    () => (stored.text ? page.getByText(stored.text, { exact: false }).first() : null),
    () => (stored.xpath ? page.locator(`xpath=${stored.xpath}`).first() : null),
  ]

  for (const attempt of attempts) {
    const locator = attempt()
    if (!locator) continue
    const count = await locator.count().catch(() => 0)
    if (count > 0) {
      return { ok: true, locator, stored }
    }
  }

  return {
    ok: false,
    failure: toolFailure('REF_STALE', `Ref "${ref}" is stale or no longer visible.`, {
      recoverable: true,
      suggestedNextActions: ['browser_snapshot'],
    }),
  }
}
