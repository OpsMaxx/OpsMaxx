import { useRef } from 'react'
import { Check } from 'lucide-react'
import { TERMINAL_SCHEMES, type TerminalScheme } from '../../../../shared/terminalTheme'
import { themeFromCss } from '../../hooks/useTerminalSession'
import { clsx } from '../../lib/format'

/** The six a preview shows: enough to tell two palettes apart at a glance. */
const SAMPLE = ['red', 'green', 'yellow', 'blue', 'magenta', 'cyan'] as const

/**
 * The terminal colour scheme, as swatches rather than a list of names.
 *
 * A name says nothing about what a scheme looks like until it has been applied
 * and a terminal looked at, which made choosing one a round trip per candidate.
 * Each card is drawn from the colours the terminal itself will use: a scheme's
 * own, or `themeFromCss` for the app palette, so the preview cannot disagree
 * with the result.
 *
 * A radio group, keyboard-first: one tab stop, arrow keys move AND select (as
 * native radios do), Home/End jump. The chosen card carries a check and a
 * heavier edge, so it is findable without telling colours apart — which matters
 * more here than anywhere, since every card is a block of colour.
 */
export function SchemePicker({
  value,
  custom,
  onChange,
  labelledBy
}: {
  value: string
  custom: TerminalScheme[]
  onChange: (id: string) => void
  /** The id of the visible title the group is named by. */
  labelledBy: string
}): React.JSX.Element {
  // `''` is the app's own palette. Imported schemes follow the built-ins, as
  // they did under their own heading in the select this replaced.
  const options: { id: string; name: string; scheme?: TerminalScheme }[] = [
    { id: '', name: 'App palette' },
    ...TERMINAL_SCHEMES.map((s) => ({ id: s.id, name: s.name, scheme: s })),
    ...custom.map((s) => ({ id: s.id, name: `${s.name} (imported)`, scheme: s }))
  ]
  const refs = useRef<(HTMLDivElement | null)[]>([])
  const appAnsi = themeFromCss('')
  // A stored id that no longer resolves (an imported scheme since removed)
  // still leaves one card reachable by Tab, and Space or Enter on it writes
  // that card's id, so what is shown checked becomes what is stored.
  const current = Math.max(
    0,
    options.findIndex((o) => o.id === value)
  )

  const move = (to: number): void => {
    const i = (to + options.length) % options.length
    onChange(options[i].id)
    refs.current[i]?.focus()
  }

  return (
    <div
      className="scheme-picker"
      role="radiogroup"
      aria-labelledby={labelledBy}
      onKeyDown={(e) => {
        const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key]
        if (step !== undefined) move(current + step)
        else if (e.key === ' ' || e.key === 'Enter') onChange(options[current].id)
        else if (e.key === 'Home') move(0)
        else if (e.key === 'End') move(options.length - 1)
        else return
        e.preventDefault()
      }}
    >
      {options.map((o, i) => {
        // A scheme replaces all sixteen ANSI colours, so its own are exactly
        // what the terminal will use; only the app palette needs resolving.
        const ansi = o.scheme?.ansi ?? appAnsi
        const selected = i === current
        return (
          <div
            key={o.id}
            ref={(el) => {
              refs.current[i] = el
            }}
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            className={clsx('scheme-card', selected && 'selected')}
            onClick={() => onChange(o.id)}
          >
            {/* Surface from the scheme when it has one, and from the app's own
                variables when it does not — so an ANSI-only scheme previews on
                the ground it will actually sit on, in either theme. */}
            <div
              className="scheme-preview"
              aria-hidden="true"
              style={{
                background: o.scheme?.background ?? 'var(--bg-terminal)',
                color: o.scheme?.foreground ?? 'var(--text)'
              }}
            >
              <span className="mono">$ ls</span>
              <span className="scheme-chips">
                {SAMPLE.map((k) => (
                  <span key={k} style={{ background: ansi[k] }} />
                ))}
              </span>
            </div>
            <div className="scheme-name">
              {selected && <Check size={12} aria-hidden="true" />}
              <span>{o.name}</span>
            </div>
          </div>
        )
      })}
    </div>
  )
}
