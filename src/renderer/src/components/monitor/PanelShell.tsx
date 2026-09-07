import { useEffect, useId, useRef, useState } from 'react'
import { Info } from 'lucide-react'

// The page template every monitoring and operations tab wears.
//
// ---------------------------------------------------------------------------
// WHY THIS IS ONE COMPONENT AND NOT A CSS CLASS
// ---------------------------------------------------------------------------
//
// The panels already shared a class — `.panel-head` — and still disagreed about
// the page. Four of them put the icon, title, description and actions INSIDE
// the bordered card; three put the same four outside it; Fleet-wide search had
// none of them. A class cannot enforce what is inside the card, because the
// card is a sibling. A component can, so this owns both halves and a panel
// hands it content.
//
// The measured cost of the disagreement is a re-fixation on every tab switch,
// at fifteen tabs. That is the whole justification; nothing here is taste.
//
// ---------------------------------------------------------------------------
// THE ⓘ, AND THE LINE IT DOES NOT CROSS
// ---------------------------------------------------------------------------
//
// `about` is what the panel is for and where its numbers come from. It is good
// copy and it is read once, and it was costing two lines of every window on
// every visit — on Inventory the first row of data sat at 397px of a 900px
// window, 44% of the screen spent before the data.
//
// It is NOT a place to put a caveat. A limit of the reading — "3 servers could
// not answer", "a check that could not run is not a check that passed" — stays
// on the page unconditionally, because a caveat you have to click to find is a
// caveat that did not happen, and this product's governing rule is that a value
// nobody measured must never render as though it were measured. Panels fold the
// EXPLANATION of such a finding under `<NoteWhy>` and leave the finding itself
// standing.
//
// `about` is therefore typed as ReactNode and documented, not policed. There is
// no mechanical test that can tell a description from a caveat; what there is,
// is this paragraph and the reviewer who reads it.

export function PanelShell({
  icon,
  title,
  about,
  aboutLabel,
  actions,
  children,
  className,
  testId
}: {
  icon: React.ReactNode
  title: string
  /** What the panel is for. Behind the ⓘ. Never a caveat — see the header. */
  about?: React.ReactNode
  /** Overrides the ⓘ button's accessible name. Defaults to `About <title>`. */
  aboutLabel?: string
  actions?: React.ReactNode
  children: React.ReactNode
  /** Extra classes for the CARD, not the page — `alerts`, `inv-wide`, etc. */
  className?: string
  testId?: string
}): React.JSX.Element {
  return (
    <section className="panel-page" data-panel={title} data-testid={testId}>
      <div className="panel-head no-purpose">
        <span className="panel-head-icon">{icon}</span>
        <h2 className="ui-section-title">
          {title}
          {about !== undefined && <PanelAbout title={title} label={aboutLabel}>{about}</PanelAbout>}
        </h2>
        {actions !== undefined && <div className="panel-head-actions">{actions}</div>}
      </div>
      <div className={className ? `bc-panel ${className}` : 'bc-panel'}>{children}</div>
    </section>
  )
}

/**
 * The ⓘ beside a panel heading.
 *
 * Exported on its own for the panels whose heading is not built by PanelShell
 * yet, so they do not each grow their own popover.
 */
export function PanelAbout({
  title,
  label,
  children
}: {
  title: string
  label?: string
  children: React.ReactNode
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const host = useRef<HTMLSpanElement>(null)
  const id = useId()

  // Escape and outside-click, both. A popover that closes only by clicking the
  // same 20px target again is one a person leaves open, and it then covers the
  // first rows of the table — which is the problem this whole change exists to
  // fix, reintroduced by the fix.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    const onDown = (e: MouseEvent): void => {
      if (!host.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onDown)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onDown)
    }
  }, [open])

  return (
    <span className="panel-head-info" ref={host}>
      <button
        type="button"
        className="panel-info-btn"
        aria-expanded={open}
        aria-controls={id}
        // Named, not just an icon. A screen reader reading "button" beside
        // fifteen identical headings tells nobody which panel it belongs to.
        aria-label={label ?? `About ${title}`}
        onClick={() => setOpen((v) => !v)}
      >
        <Info size={14} />
      </button>
      {open && (
        <div className="panel-info-pop" id={id} role="group" aria-label={label ?? `About ${title}`}>
          {children}
        </div>
      )}
    </span>
  )
}

/**
 * The explanation folded under a finding that stays visible.
 *
 * `summary` is the shortest form of the caveat and is ALWAYS on screen — it is
 * the `<summary>` element, so it renders open or closed. `children` is the
 * paragraph explaining the mechanism, which is what folds.
 *
 * Native `<details>` on purpose: keyboard-reachable, announced as a disclosure,
 * and find-in-page opens it. A caveat the browser's own search cannot reach is
 * back to being a caveat that did not happen.
 */
export function NoteWhy({
  summary,
  children
}: {
  summary: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <details className="note-why">
      <summary>{summary}</summary>
      <div className="note-why-body">{children}</div>
    </details>
  )
}
