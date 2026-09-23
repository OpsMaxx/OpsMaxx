import { useApp } from '../../store/app'

// Keyboard focus between the workbench's regions (§2.7.3, UX-M15).
//
// Regions are marked with `data-hc-region`: `tree` (B's sidebar tree), `url`,
// `request-tabs` and `response` (ProtocolLayout, and the empty workbench's URL
// row). Inside the URL row the editor is `[data-hc-url]` (C's UrlBar).

export const REGIONS = ['tree', 'url', 'request-tabs', 'response'] as const
export type Region = (typeof REGIONS)[number]

const FOCUSABLE = 'button:not(:disabled), input:not(:disabled), [tabindex="0"], .cm-content'

const region = (name: Region): HTMLElement | null => document.querySelector<HTMLElement>(`[data-hc-region="${name}"]`)

function focusIn(name: Region): boolean {
  const root = region(name)
  if (!root) return false
  const target =
    (name === 'url' && root.querySelector<HTMLElement>('[data-hc-url], .cm-content')) ||
    root.querySelector<HTMLElement>('[aria-selected="true"][tabindex="0"], [role="treeitem"][tabindex="0"]') ||
    root.querySelector<HTMLElement>(FOCUSABLE)
  if (!target) return false
  target.focus()
  // A collapsed or hidden region cannot take focus; F6 then moves on past it.
  return document.activeElement === target
}

/** New tab, scratch, cURL import: focus lands on the URL, once the tab has rendered. */
export function focusUrl(): void {
  // Checked when the frame comes, not when asked: the user may have left the view in between.
  requestAnimationFrame(() => {
    if (useApp.getState().activity === 'http') focusIn('url')
  })
}

/**
 * F6 / Shift+F6. The first press from outside every region lands on the URL;
 * after that it cycles tree → URL → request tabs → response, skipping regions
 * that are not on screen (a collapsed sidebar, a collapsed half).
 */
export function cycleRegion(step: 1 | -1): boolean {
  const current = REGIONS.findIndex((r) => region(r)?.contains(document.activeElement))
  if (current === -1) return focusIn('url')
  for (let i = 1; i <= REGIONS.length; i++) {
    const next = REGIONS[(current + step * i + REGIONS.length * 2) % REGIONS.length]
    if (focusIn(next)) return true
  }
  return false
}
