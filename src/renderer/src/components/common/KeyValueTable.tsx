import { useEffect, useRef, useState, type ReactNode } from 'react'
import { MoreHorizontal, TriangleAlert } from 'lucide-react'
import { newId, type Row } from '../../../../shared/apiModel'
import { ContextMenu, type MenuEntry } from '../connections/ContextMenu'
import { flattenPaste } from './CodeEditor'
import { Popover } from './Popover'
import { VaultPicker } from '../http/fields/VaultPicker'
import { toast } from '../../store/toast'
import { isMac } from '../../lib/shortcuts'
import './primitives.css'

export interface KeyValueTableProps {
  rows: Row[]
  onChange: (rows: Row[]) => void
  kind: 'params' | 'headers' | 'form' | 'vars'
  showDescription: boolean
  valueCell?: (row: Row, onValue: (value: string) => void) => ReactNode
  readOnly?: boolean
  warnFor?: (row: Row) => string | null
  extraRowMenu?: (row: Row) => MenuEntry[]
  onBulkEditToggle?: (bulk: boolean) => void
  /** "Show description" in the table menu. Without it the item is not offered. */
  onShowDescription?: (show: boolean) => void
}

const KEY_LABEL: Record<KeyValueTableProps['kind'], string> = {
  params: 'Key',
  headers: 'Header',
  form: 'Key',
  vars: 'Variable'
}

/** `key: value` per line; a `#` prefix marks a disabled row. */
export function rowsToBulk(rows: Row[]): string {
  return rows.map((r) => `${r.enabled ? '' : '#'}${r.key}: ${r.value}`).join('\n')
}

/**
 * The inverse of rowsToBulk. Row ids and descriptions are kept by position,
 * so a round trip with no edits gives back the same rows.
 */
export function bulkToRows(text: string, previous: Row[] = []): Row[] {
  const lines = text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .filter((l) => l.trim() !== '')
  return lines.map((line, i) => {
    let l = line.trimStart()
    const enabled = !l.startsWith('#')
    if (!enabled) l = l.slice(1).trimStart()
    const at = l.indexOf(':')
    const key = (at < 0 ? l : l.slice(0, at)).trim()
    const rest = at < 0 ? '' : l.slice(at + 1)
    const value = rest.startsWith(' ') ? rest.slice(1) : rest
    const prev = previous[i]
    return {
      id: prev?.id ?? newId('row'),
      enabled,
      key,
      value,
      ...(prev?.description !== undefined ? { description: prev.description } : {})
    }
  })
}

function copy(text: string): void {
  window.opsmaxx?.clipboard?.write(text)
}

type Menu = { x: number; y: number; entries: MenuEntry[] }

/**
 * Enable · Key · Value (· Description) rows, with a trailing blank row that
 * grows the table as you type, a bulk `key: value` editor, and the row menu
 * (right-click, Shift+F10, or the row's ⋯).
 */
export function KeyValueTable(props: KeyValueTableProps): React.JSX.Element {
  const { rows, onChange, kind, showDescription, readOnly } = props
  const [bulk, setBulk] = useState<string | null>(null)
  const [menu, setMenu] = useState<Menu | null>(null)
  const [vaultFor, setVaultFor] = useState<{ id: string; at: DOMRect } | null>(null)
  // The id the trailing row will take, so the input keeps its DOM node (and
  // focus) when the first keystroke turns it into a real row.
  const [pendingId, setPendingId] = useState(() => newId('row'))
  const body = useRef<HTMLTableSectionElement>(null)
  /** The row (and cell) to focus after the next render. */
  const focusNext = useRef<string | null>(null)
  const focusCell = useRef('key')
  const mod = isMac() ? '⌘' : 'Ctrl+'
  const alt = isMac() ? '⌥' : 'Alt+'

  useEffect(() => {
    const id = focusNext.current
    if (!id) return
    focusNext.current = null
    const cell = focusCell.current
    focusCell.current = 'key'
    const row = body.current?.querySelector(`[data-row="${id}"]`)
    ;(row?.querySelector<HTMLElement>(`[data-cell="${cell}"]`) ?? row?.querySelector<HTMLElement>('[data-cell="key"]'))?.focus()
  })

  const patch = (id: string, p: Partial<Row>): void => onChange(rows.map((r) => (r.id === id ? { ...r, ...p } : r)))
  const remove = (id: string): void => {
    const i = rows.findIndex((r) => r.id === id)
    focusNext.current = rows[i + 1]?.id ?? rows[i - 1]?.id ?? pendingId
    onChange(rows.filter((r) => r.id !== id))
  }
  const create = (p: Partial<Row>): void => {
    onChange([...rows, { id: pendingId, enabled: true, key: '', value: '', ...p }])
    setPendingId(newId('row'))
  }
  const insertRows = (at: string, extra: Row[]): void => {
    const i = rows.findIndex((r) => r.id === at)
    const replaceEmpty = i >= 0 && rows[i].key === '' && rows[i].value === ''
    if (i < 0) {
      onChange([...rows, ...extra])
      setPendingId(newId('row'))
    } else onChange([...rows.slice(0, i + (replaceEmpty ? 0 : 1)), ...extra, ...rows.slice(i + 1)])
  }

  const move = (id: string, by: -1 | 1): void => {
    const i = rows.findIndex((r) => r.id === id)
    const j = i + by
    if (i < 0 || j < 0 || j >= rows.length) return
    const next = [...rows]
    ;[next[i], next[j]] = [next[j], next[i]]
    focusNext.current = id
    focusCell.current = (document.activeElement as HTMLElement | null)?.dataset.cell ?? 'key'
    onChange(next)
  }
  const insertBelow = (id: string): void => {
    const blank: Row = { id: newId('row'), enabled: true, key: '', value: '' }
    const i = rows.findIndex((r) => r.id === id)
    focusNext.current = blank.id
    onChange([...rows.slice(0, i + 1), blank, ...rows.slice(i + 1)])
  }

  const setBulkMode = (on: boolean): void => {
    if (on) setBulk(rowsToBulk(rows))
    else if (bulk !== null) {
      onChange(bulkToRows(bulk, rows))
      setBulk(null)
    }
    props.onBulkEditToggle?.(on)
  }

  const rowMenu = (row: Row): MenuEntry[] => {
    const copies: MenuEntry[] = [
      { label: 'Copy key', onClick: () => copy(row.key) },
      { label: 'Copy value', onClick: () => copy(row.value) },
      { label: 'Copy as "key: value"', onClick: () => copy(`${row.key}: ${row.value}`) }
    ]
    const at = rows.findIndex((r) => r.id === row.id)
    if (readOnly) return copies
    return [
      { label: row.enabled ? 'Disable row' : 'Enable row', shortcut: 'Space', onClick: () => patch(row.id, { enabled: !row.enabled }) },
      {
        label: 'Duplicate row',
        onClick: () => insertRows(row.id, [{ ...row, id: newId('row') }])
      },
      { label: 'Insert row below', onClick: () => insertBelow(row.id) },
      { label: 'Move up', shortcut: alt + '↑', disabled: at === 0, onClick: () => move(row.id, -1) },
      { label: 'Move down', shortcut: alt + '↓', disabled: at === rows.length - 1, onClick: () => move(row.id, 1) },
      ...copies,
      {
        label: 'Read value from vault…',
        onClick: () => {
          const el = body.current?.querySelector(`[data-row="${row.id}"]`)
          setVaultFor({ id: row.id, at: el?.getBoundingClientRect() ?? new DOMRect() })
        }
      },
      ...(props.extraRowMenu?.(row) ?? []),
      { separator: true, label: '' },
      { label: 'Delete row', shortcut: `${mod}⌫`, danger: true, onClick: () => remove(row.id) }
    ]
  }

  const tableMenu = (): MenuEntry[] => [
    { label: 'Bulk edit', checked: bulk !== null, disabled: readOnly && bulk === null, onClick: () => setBulkMode(bulk === null) },
    ...(props.onShowDescription
      ? [{ label: 'Show description', checked: showDescription, onClick: () => props.onShowDescription!(!showDescription) }]
      : []),
    ...(readOnly
      ? []
      : [
          { separator: true, label: '' },
          {
            label: 'Delete all',
            danger: true,
            disabled: rows.length === 0,
            onClick: () => {
              const before = rows
              onChange([])
              toast(`Deleted ${before.length} ${before.length === 1 ? 'row' : 'rows'}`, 'info', {
                label: 'Undo',
                run: () => onChange(before)
              }, { key: `kv-delete-all-${pendingId}` })
            }
          }
        ])
  ]

  const openAt = (el: Element, entries: MenuEntry[]): void => {
    const r = el.getBoundingClientRect()
    setMenu({ x: r.left, y: r.bottom, entries })
  }

  const onPasteInto = (row: Row | null, cell: 'key' | 'value' | 'description') => (e: React.ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData.getData('text/plain')
    if (!/[\r\n]/.test(text)) return
    e.preventDefault()
    const lines = text.split(/\r\n?|\n/).filter((l) => l.trim())
    if (cell === 'key' && lines.length > 1 && lines.every((l) => l.includes(':'))) {
      insertRows(row?.id ?? pendingId, bulkToRows(text).map((r, i) => (i === 0 && !row ? { ...r, id: pendingId } : r)))
      return
    }
    const input = e.currentTarget
    const flat = flattenPaste(text)
    const next = input.value.slice(0, input.selectionStart ?? input.value.length) + flat + input.value.slice(input.selectionEnd ?? input.value.length)
    if (row) patch(row.id, { [cell]: next })
    else create({ [cell]: next })
  }

  const keyLabel = KEY_LABEL[kind]
  const renderRow = (row: Row | null, index: number): ReactNode => {
    const id = row?.id ?? pendingId
    const warn = row ? (props.warnFor?.(row) ?? null) : null
    const set = (cell: 'key' | 'value' | 'description') => (e: React.ChangeEvent<HTMLInputElement>) =>
      row ? patch(row.id, { [cell]: e.target.value }) : create({ [cell]: e.target.value })
    const name = row?.key || `row ${index + 1}`
    return (
      <tr
        key={id}
        data-row={id}
        className={row && !row.enabled ? 'hc-kv-row is-disabled' : row ? 'hc-kv-row' : 'hc-kv-row is-new'}
        onContextMenu={(e) => {
          if (!row) return
          e.preventDefault()
          setMenu({ x: e.clientX, y: e.clientY, entries: rowMenu(row) })
        }}
        onKeyDown={(e) => {
          // A key an editor inside the row already handled (CodeMirror's own
          // Mod-Backspace or Alt-Arrow) is the editor's, not the row's.
          if (!row || e.defaultPrevented) return
          if ((e.key === 'F10' && e.shiftKey) || e.key === 'ContextMenu') {
            e.preventDefault()
            openAt(e.currentTarget, rowMenu(row))
          } else if (e.key === 'Backspace' && (e.metaKey || e.ctrlKey) && !readOnly) {
            e.preventDefault()
            remove(row.id)
          } else if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && !readOnly) {
            e.preventDefault()
            move(row.id, e.key === 'ArrowUp' ? -1 : 1)
          }
        }}
      >
        <td className="hc-kv-check">
          {row && (
            <input
              type="checkbox"
              aria-label={`Enable ${name}`}
              checked={row.enabled}
              disabled={readOnly}
              onChange={() => patch(row.id, { enabled: !row.enabled })}
            />
          )}
        </td>
        <td>
          <input
            className="hc-kv-input hc-mono"
            data-cell="key"
            aria-label={row ? `${keyLabel}, ${name}` : `New ${keyLabel.toLowerCase()}`}
            placeholder={row ? '' : keyLabel}
            value={row?.key ?? ''}
            readOnly={readOnly}
            onChange={set('key')}
            onPaste={onPasteInto(row, 'key')}
          />
        </td>
        <td>
          <div className="hc-kv-value">
            {props.valueCell ? (
              // The trailing row gets the caller's cell too, so the first
              // keystroke does not swap the element under the caret.
              row ? (
                props.valueCell(row, (value) => patch(row.id, { value }))
              ) : (
                props.valueCell({ id: pendingId, enabled: true, key: '', value: '' }, (value) => create({ value }))
              )
            ) : (
              <input
                className="hc-kv-input hc-mono"
                data-cell="value"
                aria-label={row ? `Value, ${name}` : 'New value'}
                placeholder={row ? '' : 'Value'}
                value={row?.value ?? ''}
                readOnly={readOnly}
                onChange={set('value')}
                onPaste={onPasteInto(row, 'value')}
              />
            )}
            {warn && (
              <span className="hc-kv-warn" role="img" aria-label={warn} title={warn}>
                <TriangleAlert size={13} aria-hidden="true" />
              </span>
            )}
          </div>
        </td>
        {showDescription && (
          <td>
            <input
              className="hc-kv-input"
              data-cell="description"
              aria-label={row ? `Description, ${name}` : 'New description'}
              placeholder={row ? '' : 'Description'}
              value={row?.description ?? ''}
              readOnly={readOnly}
              onChange={set('description')}
              onPaste={onPasteInto(row, 'description')}
            />
          </td>
        )}
        <td className="hc-kv-more">
          {row && (
            <button
              type="button"
              tabIndex={-1}
              className="hc-icon-btn"
              aria-label={`Actions for ${name}`}
              title="Row actions"
              onClick={(e) => openAt(e.currentTarget, rowMenu(row))}
            >
              <MoreHorizontal size={13} aria-hidden="true" />
            </button>
          )}
        </td>
      </tr>
    )
  }

  return (
    <div className="hc-kv" data-kind={kind}>
      {bulk !== null && (
        <div className="hc-kv-head">
          <span className="ui-label">One &quot;key: value&quot; per line · # disables a row</span>
          <button type="button" className="btn ghost sm" onClick={() => setBulkMode(false)}>
            Key-value edit
          </button>
          <button
            type="button"
            className="hc-icon-btn"
            aria-label="Table options"
            title="Table options"
            aria-haspopup="menu"
            onClick={(e) => openAt(e.currentTarget, tableMenu())}
          >
            <MoreHorizontal size={13} aria-hidden="true" />
          </button>
        </div>
      )}
      {bulk !== null ? (
        <textarea
          className="hc-kv-bulk hc-mono"
          aria-label="Bulk edit"
          spellCheck={false}
          value={bulk}
          readOnly={readOnly}
          onChange={(e) => setBulk(e.target.value)}
          onBlur={() => !readOnly && onChange(bulkToRows(bulk, rows))}
        />
      ) : (
        <table className="hc-kv-table">
          <thead>
            <tr>
              <th className="hc-kv-check">
                <span className="hc-sr-only">Enabled</span>
              </th>
              <th className="ui-label">{keyLabel}</th>
              <th className="ui-label">Value</th>
              {showDescription && <th className="ui-label">Description</th>}
              <th className="hc-kv-more">
                <button
                  type="button"
                  className="hc-icon-btn"
                  aria-label="Table options"
                  title="Table options"
                  aria-haspopup="menu"
                  onClick={(e) => openAt(e.currentTarget, tableMenu())}
                >
                  <MoreHorizontal size={13} aria-hidden="true" />
                </button>
              </th>
            </tr>
          </thead>
          <tbody ref={body}>
            {/* One array, so the trailing row keeps its node when it becomes a real row. */}
            {[...rows.map((r, i) => renderRow(r, i)), ...(readOnly ? [] : [renderRow(null, rows.length)])]}
          </tbody>
        </table>
      )}
      {menu && <ContextMenu x={menu.x} y={menu.y} entries={menu.entries} onClose={() => setMenu(null)} />}
      <Popover
        anchor={vaultFor?.at ?? null}
        open={vaultFor !== null}
        onClose={() => setVaultFor(null)}
        ariaLabel="Read value from vault"
      >
        <VaultPicker
          onPick={(ref) => {
            if (vaultFor) patch(vaultFor.id, { value: ref })
            setVaultFor(null)
          }}
        />
      </Popover>
    </div>
  )
}
