import { useRef, type ReactNode } from 'react'
import './primitives.css'

export interface TabItem {
  id: string
  label: string
  count?: number
  dot?: 'set' | 'problem'
}

export interface TabsProps {
  tabs: TabItem[]
  active: string
  onChange: (id: string) => void
  trailing?: ReactNode
  ariaLabel: string
  /**
   * Gives each tab the id `${idPrefix}-tab-${id}` and points its
   * aria-controls at `${idPrefix}-panel`, so the caller's
   * `role="tabpanel"` can carry the matching id and aria-labelledby.
   */
  idPrefix?: string
}

const DOT_TEXT = { set: 'set', problem: 'has a problem' } as const

/**
 * A tablist. Arrow keys move and select (automatic activation), Home and End
 * go to the ends, and only the selected tab is in the Tab order. A count is
 * shown only when it is above zero.
 */
export function Tabs({ tabs, active, onChange, trailing, ariaLabel, idPrefix }: TabsProps): React.JSX.Element {
  const list = useRef<HTMLDivElement>(null)
  const go = (index: number): void => {
    const t = tabs[(index + tabs.length) % tabs.length]
    if (!t) return
    onChange(t.id)
    const el = [...(list.current?.children ?? [])].find(
      (c): c is HTMLButtonElement => (c as HTMLElement).dataset.tabId === t.id
    )
    el?.focus()
    el?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
  }
  const at = tabs.findIndex((t) => t.id === active)
  return (
    <div className="hc-tabs">
      <div
        ref={list}
        className="hc-tabs-list"
        role="tablist"
        aria-label={ariaLabel}
        onKeyDown={(e) => {
          const next =
            e.key === 'ArrowRight' ? at + 1 : e.key === 'ArrowLeft' ? at - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? -1 : null
          if (next === null) return
          e.preventDefault()
          go(next)
        }}
      >
        {tabs.map((t) => {
          const selected = t.id === active
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              data-tab-id={t.id}
              id={idPrefix ? `${idPrefix}-tab-${t.id}` : undefined}
              aria-controls={idPrefix ? `${idPrefix}-panel` : undefined}
              aria-selected={selected}
              tabIndex={selected ? 0 : -1}
              className={selected ? 'hc-tab is-active' : 'hc-tab'}
              onClick={() => onChange(t.id)}
            >
              {t.label}
              {!!t.count && t.count > 0 && <span className="hc-tab-count">{t.count}</span>}
              {t.dot && (
                <span className={`hc-tab-dot hc-tab-dot--${t.dot}`} title={DOT_TEXT[t.dot]}>
                  <span className="hc-sr-only">{`, ${DOT_TEXT[t.dot]}`}</span>
                </span>
              )}
            </button>
          )
        })}
      </div>
      {trailing && <div className="hc-tabs-trailing">{trailing}</div>}
    </div>
  )
}
