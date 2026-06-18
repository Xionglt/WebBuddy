import type { Locator, Page } from 'playwright'

/**
 * Visual affordances so a human watching the headful browser can follow what
 * the agent is doing: scroll the target into view, move the mouse toward it,
 * and flash a colored outline. Colors read as intent:
 *
 *   red    — destructive / submit (matches L3/L4 risk)
 *   green  — safe navigation click
 *   blue   — form field about to be filled
 */
const COLOR_BY_ACTION: Record<string, string> = {
  click_safe: '#22c55e',
  click_risky: '#ef4444',
  type: '#3b82f6',
}

function hexToRgba(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16)
  const r = (n >> 16) & 255
  const g = (n >> 8) & 255
  const b = n & 255
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

interface OutlinePayload {
  box: { x: number; y: number; width: number; height: number }
  color: string
  fill: string
  glow0: string
  glow1: string
  action: 'click' | 'type'
}

async function drawOutline(page: Page, payload: OutlinePayload): Promise<void> {
  // Draw a transient overlay absolutely positioned over the element so we don't
  // mutate the page's own styles or trigger re-layout side effects.
  await page.evaluate((p: OutlinePayload) => {
    const el = document.createElement('div')
    el.id = '__mfa_highlight__'
    el.style.cssText =
      `position:absolute;left:${p.box.x}px;top:${p.box.y}px;width:${p.box.width}px;` +
      `height:${p.box.height}px;outline:3px solid ${p.color};outline-offset:2px;` +
      `background:${p.fill};border-radius:4px;z-index:2147483647;pointer-events:none;` +
      `box-shadow:0 0 0 4px ${p.glow0};`
    const label = document.createElement('div')
    label.textContent = `MFA · ${p.action === 'type' ? 'FILLING' : 'CLICKING'}`
    label.style.cssText =
      `position:absolute;top:-20px;left:0;background:${p.color};color:#fff;` +
      `font:600 11px/1.4 ui-monospace,monospace;padding:2px 6px;border-radius:3px;white-space:nowrap;`
    el.appendChild(label)
    document.documentElement.appendChild(el)
    const start = Date.now()
    const iv = window.setInterval(() => {
      const t = (Date.now() - start) / 400
      const w = 4 + Math.sin(t) * 3
      el.style.boxShadow = `0 0 0 ${w}px ${(Math.sin(t) > 0 ? p.glow0 : p.glow1)}`
    }, 60)
    ;(el as unknown as { __iv?: number }).__iv = iv
  }, payload)
}

async function clearOutline(page: Page): Promise<void> {
  await page.evaluate(() => {
    const el = document.getElementById('__mfa_highlight__')
    if (el) {
      const iv = (el as unknown as { __iv?: number }).__iv
      if (iv) window.clearInterval(iv)
      el.remove()
    }
  })
}

async function moveVisibleCursor(page: Page, x: number, y: number, color: string): Promise<void> {
  await page.evaluate(
    ({ x: cx, y: cy, color: c }) => {
      let cursor = document.getElementById('__mfa_cursor__') as HTMLDivElement | null
      if (!cursor) {
        cursor = document.createElement('div')
        cursor.id = '__mfa_cursor__'
        cursor.style.cssText =
          'position:fixed;left:0;top:0;width:16px;height:16px;border-radius:999px;' +
          'z-index:2147483647;pointer-events:none;transform:translate(-50%,-50%);' +
          'box-shadow:0 0 0 4px rgba(255,255,255,.85),0 8px 24px rgba(0,0,0,.24);' +
          'transition:left 35ms linear,top 35ms linear,background 120ms ease;'
        document.documentElement.appendChild(cursor)
      }
      cursor.style.left = `${cx}px`
      cursor.style.top = `${cy}px`
      cursor.style.background = c
      cursor.style.border = `2px solid ${c}`
    },
    { x, y, color },
  )
}

/**
 * Move the mouse toward `locator` and flash the action-colored outline. Best
 * effort — never throws; callers gate this on `config.browser.visualHighlight`.
 */
export async function visualizeBeforeAction(
  page: Page,
  locator: Locator,
  action: 'click_safe' | 'click_risky' | 'type',
): Promise<void> {
  try {
    await locator.scrollIntoViewIfNeeded({ timeout: 2500 })
    const box = await locator.boundingBox()
    if (!box) return

    const color = COLOR_BY_ACTION[action]
    await drawOutline(page, {
      box,
      color,
      fill: hexToRgba(color, 0.13),
      glow0: hexToRgba(color, 0.3),
      glow1: hexToRgba(color, 0.12),
      action: action === 'type' ? 'type' : 'click',
    })

    // Move the mouse in several steps toward the element centre so the motion
    // is visible (Playwright's default move is near-instant).
    const targetX = box.x + box.width / 2
    const targetY = box.y + box.height / 2
    const start = await page.evaluate(() => ({
      x: (window as unknown as { __mfaMouseX?: number }).__mfaMouseX ?? window.innerWidth / 2,
      y: (window as unknown as { __mfaMouseY?: number }).__mfaMouseY ?? window.innerHeight / 3,
    }))
    const steps = 10
    for (let i = 1; i <= steps; i += 1) {
      const x = start.x + (targetX - start.x) * (i / steps)
      const y = start.y + (targetY - start.y) * (i / steps)
      await moveVisibleCursor(page, x, y, color)
      await page.mouse.move(x, y, { steps: 1 })
      await page.waitForTimeout(25)
    }
    await moveVisibleCursor(page, targetX, targetY, color)
    await page.mouse.move(targetX, targetY, { steps: 1 })
    await page.evaluate(
      ({ x, y }) => {
        ;(window as unknown as { __mfaMouseX?: number }).__mfaMouseX = x
        ;(window as unknown as { __mfaMouseY?: number }).__mfaMouseY = y
      },
      { x: targetX, y: targetY },
    )
  } catch {
    // Highlighting is best-effort; never let it break the action.
  }
}

/** Remove the highlight overlay after the action completes. */
export async function clearHighlight(page: Page): Promise<void> {
  try {
    await clearOutline(page)
  } catch {
    // ignore
  }
}
