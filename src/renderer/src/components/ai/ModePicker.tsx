import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown } from 'lucide-react'
import { PICKERLESS_MODE, SESSION_MODES, resolveDefaultSessionGroup, sessionModeLabel } from '../../../../shared/mcp'
import type { AccessGroup, SessionMode } from '../../../../shared/mcp'
import { ContextMenu } from '../connections/ContextMenu'
import type { MenuEntry } from '../connections/ContextMenu'
import { Modal } from '../common/Modal'
import { clsx } from '../../lib/format'
import { toast } from '../../store/toast'
import { useT } from '../../lib/i18n'
import { Trans } from '../../lib/Trans'

// The approval dialog paints above every Modal and menu; opened from inside it,
// both have to be mounted in its layer or they appear underneath it.
const LAYER = '.approval-scrim, .agent-approval-scrim'

/**
 * The session's one permission choice: a profile from SESSION_MODES, picked
 * from a small menu the way a Claude Code mode is (digits 1-5 pick directly).
 * Four are predefined; Custom is the only one that uses an access group, and
 * the group select appears beside the button only then. Bypass lifts every
 * refusal, so it is confirmed first and the button stays red while it is on.
 */
export function ModePicker({
  value,
  onChange,
  groups,
  groupId,
  onGroupChange,
  protectedCount = 0,
  disabled,
  size,
  title,
  defaultScope,
  onOpen
}: {
  value: SessionMode
  onChange: (mode: SessionMode) => void | Promise<void>
  /** Offered when the profile is Custom. Omit to show no group select. */
  groups?: AccessGroup[]
  groupId?: string | null
  onGroupChange?: (groupId: string) => void | Promise<void>
  protectedCount?: number
  disabled?: boolean
  size?: 'sm'
  title?: string
  /** This picks the DEFAULT for new sessions, not one session's mode, and the
   *  Bypass confirm says what that reaches. */
  defaultScope?: boolean
  /** Called as the menu opens, so a caller whose `value` may be stale can
   *  re-read it before anything is picked against it. */
  onOpen?: () => void
}): React.JSX.Element {
  const [menu, setMenu] = useState<DOMRect | null>(null)
  const [confirming, setConfirming] = useState(false)
  const t = useT()
  const layer = useRef<Element | undefined>(undefined)
  const groupName = groups?.find((g) => g.id === groupId)?.name ?? null
  const button = useRef<HTMLButtonElement>(null)
  // A press on the button while the menu is open closes it through the
  // outside-click handler before the click lands; without this it reopens.
  const wasOpen = useRef(false)

  // Awaited, so a rejected change is said rather than left as an unhandled
  // rejection behind a button that already shows the old value.
  const change = async (mode: SessionMode): Promise<void> => {
    try {
      await onChange(mode)
    } catch (err) {
      toast(t('ai.modePicker.notChanged', { error: err instanceof Error ? err.message : String(err) }), 'error')
    }
  }

  const pick = (mode: SessionMode): void => {
    if (mode === value) return
    if (mode === 'bypass') setConfirming(true)
    else void change(mode)
  }

  // The Modal would hand focus back to what opened it, and that was a menu
  // item that no longer exists; the picker is where the user was.
  const closeConfirm = (): void => {
    setConfirming(false)
    button.current?.focus()
  }

  const entries: MenuEntry[] = SESSION_MODES.map((m, i) => ({
    section: i === 0 ? t('ai.modePicker.sectionProfile') : m.id === 'custom' ? t('ai.modePicker.sectionAdvanced') : undefined,
    label: m.label,
    detail: m.detail,
    shortcut: m.shortcut,
    radio: 'session-profile',
    checked: m.id === value,
    danger: m.id === 'bypass',
    onClick: () => pick(m.id)
  }))

  const confirm = confirming && (
    <Modal
      title={defaultScope ? t('ai.modePicker.confirmDefaultTitle') : t('ai.modePicker.confirmTitle')}
      onClose={closeConfirm}
      confirm={{
        label: defaultScope ? t('ai.modePicker.confirmDefaultLabel') : t('ai.modePicker.confirmLabel'),
        destructive: true,
        onClick: () => {
          closeConfirm()
          void change('bypass')
        }
      }}
    >
      <div data-testid="bypass-confirm" className="s-desc" style={{ lineHeight: 1.6 }}>
        {defaultScope && (
          <p style={{ margin: '0 0 8px', color: 'var(--danger)' }}>{t('ai.modePicker.defaultWarning')}</p>
        )}
        <p style={{ margin: 0 }}>
          {defaultScope ? t('ai.modePicker.liftsDefault') : t('ai.modePicker.lifts')}
        </p>
        <ul style={{ margin: '4px 0 10px' }}>
          <li>{t('ai.modePicker.liftsGroups')}</li>
          <li>{t('ai.modePicker.liftsFileRules', { path1: '/etc/shadow', path2: '~/.ssh' })}</li>
          <li>{t('ai.modePicker.liftsShells', { command1: 'sudo -i', command2: 'su' })}</li>
          <li>{t('ai.modePicker.liftsFrp')}</li>
          <li>{t('ai.modePicker.liftsPrompts')}</li>
        </ul>
        <p style={{ margin: 0 }}>{t('ai.modePicker.stillInForce')}</p>
        <ul style={{ margin: '4px 0 0' }}>
          <li>{t('ai.modePicker.keepsProtected')}</li>
          <li>{t('ai.modePicker.keepsNoAccess')}</li>
          <li>{t('ai.modePicker.keepsStopAll')}</li>
          <li>{t('ai.modePicker.keepsAudit')}</li>
        </ul>
      </div>
    </Modal>
  )

  return (
    <>
      <button
        ref={button}
        type="button"
        data-testid="mode-picker"
        className={clsx('btn', size === 'sm' && 'sm', 'hc-mode-picker', value === 'bypass' && 'is-bypass')}
        disabled={disabled}
        title={title}
        aria-label={
          title
            ? t('ai.modePicker.ariaLabelWithTitle', { profile: sessionModeLabel(value, groupName), title })
            : t('ai.modePicker.ariaLabel', { profile: sessionModeLabel(value, groupName) })
        }
        aria-haspopup="menu"
        aria-expanded={menu !== null}
        onPointerDown={() => (wasOpen.current = menu !== null)}
        onClick={(e) => {
          const reopen = !wasOpen.current && menu === null
          wasOpen.current = false
          layer.current = e.currentTarget.closest(LAYER) ?? undefined
          if (reopen) onOpen?.()
          setMenu(reopen ? e.currentTarget.getBoundingClientRect() : null)
        }}
      >
        {value === 'custom' && groups ? t('ai.modePicker.custom') : sessionModeLabel(value, groupName)}
        <ChevronDown size={13} aria-hidden="true" />
      </button>
      {value === 'custom' && groups && (
        <select
          className="input"
          style={{ maxWidth: 180 }}
          aria-label={t('ai.modePicker.groupSelect')}
          data-testid="custom-group"
          value={groupId ?? ''}
          disabled={disabled}
          onChange={(e) => void onGroupChange?.(e.target.value)}
        >
          {!groupId && <option value="">{t('ai.modePicker.pickGroup')}</option>}
          {groups.map((g) => (
            <option key={g.id} value={g.id}>
              {g.name}
            </option>
          ))}
        </select>
      )}
      {menu && (
        <ContextMenu
          x={menu.left}
          y={menu.bottom}
          anchor={menu}
          entries={entries}
          container={layer.current}
          ariaLabel={t('ai.modePicker.menuLabel')}
          footer={
            protectedCount > 0
              ? t('ai.modePicker.protectedFooter', { count: protectedCount })
              : undefined
          }
          onClose={() => setMenu(null)}
        />
      )}
      {confirm && (layer.current ? createPortal(confirm, layer.current) : confirm)}
    </>
  )
}

/**
 * The profile a session created without a picker will start in -- OAuth consent
 * and CLI pairing -- said at the moment of consent, so a Bypass default is never
 * applied without the human seeing it. With no default profile configured that
 * is Custom on the default access group, and no access at all without one.
 */
export function StartsInMode(): React.JSX.Element {
  // undefined while reading, null when it could not be read. A null `text` is
  // Custom with no access group, worded at render so it follows the language.
  const [label, setLabel] = useState<{ mode: SessionMode; text: string | null } | null | undefined>(undefined)
  const t = useT()
  useEffect(() => {
    let live = true
    const api = window.opsmaxx
    const read = api?.aiMcp?.getConfig?.()
    if (!read) {
      setLabel(null)
      return
    }
    Promise.all([read, api?.aiPolicy?.listGroups?.() ?? Promise.resolve([])])
      .then(([c, groups]) => {
        if (!live) return
        const mode = c?.defaultSessionMode ?? PICKERLESS_MODE
        const group = resolveDefaultSessionGroup(c, groups ?? [])
        setLabel({
          mode,
          text:
            mode === 'custom'
              ? group.id
                ? sessionModeLabel(mode, group.name)
                : null
              : sessionModeLabel(mode)
        })
      })
      .catch(() => live && setLabel(null))
    return () => {
      live = false
    }
  }, [])
  if (label === undefined) return <div className="s-desc">{t('ai.modePicker.startsInReading')}</div>
  if (label === null) return <div className="s-desc warn">{t('ai.modePicker.startsInUnreadable')}</div>
  return (
    <div className="s-desc" data-testid="starts-in-mode">
      <Trans
        i18nKey="ai.modePicker.startsIn"
        values={{ profile: label.text ?? t('ai.modePicker.customNoGroup') }}
        components={{ chip: <span className={clsx('chip', label.mode === 'bypass' && 'danger')} /> }}
      />
    </div>
  )
}
