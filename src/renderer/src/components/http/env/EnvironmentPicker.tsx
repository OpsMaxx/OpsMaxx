import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import type { Id } from '../../../../../shared/apiModel'
import { useApi } from '../../../store/api'
import { useApp } from '../../../store/app'
import { useHttp } from '../../../store/http'
import { isMac } from '../../../lib/shortcuts'
import { ContextMenu, type MenuEntry } from '../../connections/ContextMenu'
import { VariablesPopover } from './VariablesPopover'
import { openEnvironmentsTab } from './EnvironmentsTab'
import { useT } from '../../../lib/i18n'
import '../nav.css'

/**
 * The environment picker at the right of the tab strip: swatch, name and a
 * PROD badge. `compact` keeps the swatch and the badge only (§2.1). ⌘E sets
 * `useHttp.overlay` to 'env', which opens the menu here. "Variables in this
 * request…" is about `tabId`, or else the active tab (or the ghost).
 */
export function EnvironmentPicker({ tabId: forTab, compact }: { tabId?: Id; compact?: boolean } = {}): React.JSX.Element {
  const ws = useApp((s) => s.activeWorkspaceId)
  const current = useHttp((s) => s.activeTab[ws] ?? s.ghost[ws]?.id ?? undefined)
  const tabId = forTab ?? current
  const overlay = useHttp((s) => s.overlay)
  const button = useRef<HTMLButtonElement>(null)
  const all = useApi((s) => s.workspace.environments)
  const envs = useMemo(() => all.filter((e) => e.workspaceId === ws), [all, ws])
  const activeId = useApi((s) => (Object.hasOwn(s.workspace.activeEnvironment, ws) ? s.workspace.activeEnvironment[ws] : null))
  const active = envs.find((e) => e.id === activeId)
  const pending = useApi((s) => s.envReview)
  const [menu, setMenu] = useState<DOMRect | null>(null)
  const [vars, setVars] = useState<DOMRect | null>(null)
  const t = useT()
  // ⌘E: the overlay stays 'env' while the menu it opened is up, and is
  // cleared when the menu closes, so the next ⌘E opens it again.
  useEffect(() => {
    if (overlay === 'env' && button.current) setMenu(button.current.getBoundingClientRect())
  }, [overlay])
  const closeMenu = (): void => {
    setMenu(null)
    if (useHttp.getState().overlay === 'env') useHttp.getState().setOverlay(null)
  }
  const pick = (id: Id | null): void => useApi.getState().setActiveEnvironment(ws, id)
  const entries: MenuEntry[] = [
    { label: t('http.envPicker.none'), radio: 'env', checked: !active, onClick: () => pick(null) },
    ...envs.map((e) => ({
      label: e.production
        ? t(pending.includes(e.id) ? 'http.envPicker.entryProdReview' : 'http.envPicker.entryProd', { name: e.name })
        : pending.includes(e.id)
          ? t('http.envPicker.entryReview', { name: e.name })
          : e.name,
      radio: 'env',
      checked: e.id === active?.id,
      onClick: () => pick(e.id)
    })),
    { separator: true, label: '' },
    ...(tabId ? [{ label: t('http.envPicker.variablesInRequest'), onClick: () => setVars(menu) }] : []),
    { label: t('http.envPicker.manage'), onClick: () => openEnvironmentsTab() }
  ]
  const label = active ? active.name : t('http.envPicker.none')
  const review = !!active && pending.includes(active.id)
  return (
    <>
      <button
        ref={button}
        type="button"
        data-http-env-picker
        className={`hc-env-picker${compact ? ' is-compact' : ''}`}
        aria-haspopup="menu"
        aria-expanded={menu !== null}
        aria-label={t(
          active?.production
            ? review
              ? 'http.envPicker.ariaProdReview'
              : 'http.envPicker.ariaProd'
            : review
              ? 'http.envPicker.ariaReview'
              : 'http.envPicker.aria',
          { label }
        )}
        title={t('http.envPicker.title', { key: isMac() ? '⌘E' : 'Ctrl+E' })}
        onClick={(e) => setMenu(e.currentTarget.getBoundingClientRect())}
      >
        <span className={`hc-swatch${active ? ` hc-swatch--${active.color}` : ''}`} aria-hidden="true" />
        {!compact && <span className="hc-env-name">{label}</span>}
        {active?.production && <span className="hc-prod">{t('http.envPicker.prod')}</span>}
        {review && (
          <span className="hc-review" title={t('http.envPicker.reviewTitle')}>
            {t('http.envPicker.review')}
          </span>
        )}
        <ChevronDown size={12} aria-hidden="true" />
      </button>
      {menu && <ContextMenu x={menu.left} y={menu.bottom} anchor={menu} entries={entries} onClose={closeMenu} />}
      {tabId && <VariablesPopover tabId={tabId} anchor={vars} onClose={() => setVars(null)} />}
    </>
  )
}
