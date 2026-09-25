import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown } from 'lucide-react'
import { SESSION_MODES, sessionModeLabel } from '../../../../shared/mcp'
import type { SessionMode } from '../../../../shared/mcp'
import { ContextMenu } from '../connections/ContextMenu'
import type { MenuEntry } from '../connections/ContextMenu'
import { Modal } from '../common/Modal'
import { clsx } from '../../lib/format'
import { toast } from '../../store/toast'

// The approval dialog paints above every Modal and menu; opened from inside it,
// both have to be mounted in its layer or they appear underneath it.
const LAYER = '.approval-scrim, .agent-approval-scrim'

/**
 * How much the human wants to be in the loop: one of SESSION_MODES, picked
 * from a small menu (digits 1-4 pick directly). Bypass lifts every refusal, so
 * it is confirmed first and the button stays red while it is on.
 */
export function ModePicker({
  value,
  onChange,
  protectedCount = 0,
  disabled,
  size,
  title,
  defaultScope
}: {
  value: SessionMode
  onChange: (mode: SessionMode) => void | Promise<void>
  protectedCount?: number
  disabled?: boolean
  size?: 'sm'
  title?: string
  /** This picks the DEFAULT for new sessions, not one session's mode, and the
   *  Bypass confirm says what that reaches. */
  defaultScope?: boolean
}): React.JSX.Element {
  const [menu, setMenu] = useState<DOMRect | null>(null)
  const [confirming, setConfirming] = useState(false)
  const layer = useRef<Element | undefined>(undefined)
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
      toast(`The mode was not changed: ${err instanceof Error ? err.message : String(err)}`, 'error')
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
    section: i === 0 ? 'Mode' : undefined,
    label: m.label,
    detail: m.detail,
    shortcut: m.shortcut,
    radio: 'session-mode',
    checked: m.id === value,
    danger: m.id === 'bypass',
    onClick: () => pick(m.id)
  }))

  const confirm = confirming && (
    <Modal
      title={defaultScope ? 'Make Bypass the default for new sessions?' : 'Bypass all permissions?'}
      onClose={closeConfirm}
      confirm={{
        label: defaultScope ? 'Make Bypass the default' : 'Enable Bypass',
        destructive: true,
        onClick: () => {
          closeConfirm()
          void change('bypass')
        }
      }}
    >
      <div data-testid="bypass-confirm" className="s-desc" style={{ lineHeight: 1.6 }}>
        {defaultScope && (
          <p style={{ margin: '0 0 8px', color: 'var(--danger)' }}>
            Every new agent session will start in Bypass — including CLI-paired and OAuth sessions, which
            connect without showing anyone a mode picker. Sessions that already exist keep their mode.
          </p>
        )}
        <p style={{ margin: 0 }}>
          {defaultScope ? 'A session in Bypass' : 'The agent'} runs everything it asks for, with no prompt and no
          refusal. This lifts:
        </p>
        <ul style={{ margin: '4px 0 10px' }}>
          <li>the access group’s Deny</li>
          <li>access-group restrictions on workspaces and servers</li>
          <li>path rules, such as those guarding /etc/shadow and ~/.ssh</li>
          <li>escalation shells such as sudo -i and su</li>
          <li>frp reverse proxies</li>
          <li>every approval prompt</li>
        </ul>
        <p style={{ margin: 0 }}>Still in force:</p>
        <ul style={{ margin: '4px 0 0' }}>
          <li>Protected workspaces and servers, where the agent is held at Ask first</li>
          <li>No AI Access, and the workspaces the session is scoped to</li>
          <li>Stop All AI Access</li>
          <li>the audit log, which marks every call that ran only because of Bypass</li>
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
        aria-label={`Mode: ${sessionModeLabel(value)}${title ? `. ${title}` : ''}`}
        aria-haspopup="menu"
        aria-expanded={menu !== null}
        onPointerDown={() => (wasOpen.current = menu !== null)}
        onClick={(e) => {
          const reopen = !wasOpen.current && menu === null
          wasOpen.current = false
          layer.current = e.currentTarget.closest(LAYER) ?? undefined
          setMenu(reopen ? e.currentTarget.getBoundingClientRect() : null)
        }}
      >
        {sessionModeLabel(value)}
        <ChevronDown size={13} aria-hidden="true" />
      </button>
      {menu && (
        <ContextMenu
          x={menu.left}
          y={menu.bottom}
          anchor={menu}
          entries={entries}
          container={layer.current}
          ariaLabel="Session mode"
          footer={
            protectedCount > 0
              ? `Auto and Bypass are capped at Ask first on ${protectedCount} protected target${protectedCount === 1 ? '' : 's'}.`
              : undefined
          }
          onClose={() => setMenu(null)}
        />
      )}
      {confirm && (layer.current ? createPortal(confirm, layer.current) : confirm)}
    </>
  )
}
