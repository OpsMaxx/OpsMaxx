import { useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, MoreHorizontal, Pin, X } from 'lucide-react'
import {
  getNamedType,
  isEnumType,
  isInputObjectType,
  isInterfaceType,
  isObjectType,
  isUnionType,
  type GraphQLArgument,
  type GraphQLField,
  type GraphQLInputField,
  type GraphQLNamedType,
  type GraphQLSchema
} from 'graphql'
import { clsx } from '../../../lib/format'
import type { SchemaEntry } from '../../../store/gqlSchemas'
import { ContextMenu, type MenuEntry } from '../../connections/ContextMenu'

// The schema, browsable. Every name and description here came from the server,
// so all of it is React text (SEC-M9).

type Member = GraphQLField<unknown, unknown> | GraphQLInputField

const args = (m: Member): string =>
  'args' in m && m.args.length > 0 ? `(${m.args.map((a: GraphQLArgument) => `${a.name}: ${String(a.type)}`).join(', ')})` : ''

function membersOf(type: GraphQLNamedType): Member[] {
  if (isObjectType(type) || isInterfaceType(type) || isInputObjectType(type)) return Object.values(type.getFields())
  return []
}

function roots(schema: GraphQLSchema): { label: string; type: GraphQLNamedType }[] {
  return [
    { label: 'Query', type: schema.getQueryType() },
    { label: 'Mutation', type: schema.getMutationType() },
    { label: 'Subscription', type: schema.getSubscriptionType() }
  ].flatMap((r) => (r.type ? [{ label: r.label, type: r.type }] : []))
}

/** Where the explorer goes: beside a 320px editor when the request half has room, else over the response (UX-M9). */
export const explorerMode = (requestWidth: number): 'dock' | 'overlay' => (requestWidth >= 604 ? 'dock' : 'overlay')

export function SchemaExplorer({
  entry,
  mode,
  pinned,
  onPin,
  onClose,
  onLoad,
  target
}: {
  entry: SchemaEntry | undefined
  mode: 'dock' | 'overlay'
  pinned: boolean
  onPin: (pinned: boolean) => void
  onClose: () => void
  onLoad: () => void
  /** "https://… via web-01", for the not-loaded state. */
  target: string
}): React.JSX.Element {
  const schema =
    entry?.status === 'ready' ? entry.schema : entry?.status === 'loading' ? entry.previous?.schema : undefined

  return (
    <aside
      className={clsx('hc-gql-explorer', `is-${mode}`)}
      aria-label="Schema explorer"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation()
          onClose()
        }
      }}
    >
      <div className="hc-gql-explorer-head">
        <span className="hc-gql-explorer-title">Schema explorer</span>
        <span className="hc-gql-spacer" />
        <button
          type="button"
          className={clsx('btn ghost sm', pinned && 'is-on')}
          aria-pressed={pinned}
          aria-label={pinned ? 'Unpin explorer' : 'Pin explorer open across tabs'}
          title={pinned ? 'Unpin explorer' : 'Pin explorer open across tabs'}
          onClick={() => onPin(!pinned)}
        >
          <Pin size={13} />
        </button>
        <button type="button" className="btn ghost sm" aria-label="Close explorer (Esc)" title="Close explorer (Esc)" onClick={onClose}>
          <X size={13} />
        </button>
      </div>
      {entry?.status === 'loading' && <p className="hc-gql-note">Loading schema…</p>}
      {entry?.status === 'ready' && entry.error && (
        <p className="hc-gql-note is-error">Reload failed: {entry.error}. Showing the schema from before.</p>
      )}
      {entry?.status === 'ready' && entry.note && <p className="hc-gql-note">{entry.note}</p>}
      {entry?.status === 'error' && (
        <div className="hc-gql-note is-error">
          <p>{entry.message}</p>
          <button type="button" className="btn sm" onClick={onLoad}>
            Retry
          </button>
        </div>
      )}
      {!entry && (
        <div className="hc-gql-empty">
          <p>Schema not loaded.</p>
          <button type="button" className="btn primary sm" onClick={onLoad}>
            Load schema
          </button>
          <p className="hc-gql-note">Introspection is sent to {target}.</p>
        </div>
      )}
      {schema && <SchemaTree schema={schema} />}
    </aside>
  )
}

function SchemaTree({ schema }: { schema: GraphQLSchema }): React.JSX.Element {
  const [filter, setFilter] = useState('')
  const [focus, setFocus] = useState<string | null>(null)
  const [open, setOpen] = useState<Record<string, boolean>>({ Query: true })
  const [menu, setMenu] = useState<{ x: number; y: number; entries: MenuEntry[] } | null>(null)
  const q = filter.trim().toLowerCase()
  const focused = focus ? schema.getType(focus) : undefined

  const matchingTypes = useMemo(
    () =>
      q === ''
        ? []
        : Object.values(schema.getTypeMap())
            .filter((t) => !t.name.startsWith('__') && t.name.toLowerCase().includes(q))
            .slice(0, 50),
    [schema, q]
  )

  const goTo = (name: string): void => {
    if (schema.getType(name)) {
      setFocus(name)
      setFilter('')
    }
  }

  const fieldMenu = (m: Member): MenuEntry[] => [
    { label: 'Copy field name', onClick: () => window.opsmaxx.clipboard.write(m.name) },
    { label: 'Copy type', onClick: () => window.opsmaxx.clipboard.write(String(m.type)) },
    { label: 'Go to type', onClick: () => goTo(getNamedType(m.type).name) }
  ]

  const row = (m: Member): React.JSX.Element => {
    const named = getNamedType(m.type).name
    return (
      <li
        key={m.name}
        role="treeitem"
        className="hc-gql-field"
        onContextMenu={(e) => {
          e.preventDefault()
          setMenu({ x: e.clientX, y: e.clientY, entries: fieldMenu(m) })
        }}
        onKeyDown={(e) => {
          if ((e.key === 'F10' && e.shiftKey) || e.key === 'ContextMenu') {
            e.preventDefault()
            const r = e.currentTarget.getBoundingClientRect()
            setMenu({ x: r.left + 16, y: r.bottom, entries: fieldMenu(m) })
          }
        }}
        tabIndex={0}
        title={m.description ?? undefined}
      >
        <span className="hc-gql-name mono">
          {m.name}
          {args(m)}
        </span>
        <span className="mono">: </span>
        <button type="button" className="hc-gql-type mono" onClick={() => goTo(named)} aria-label={`Go to type ${named}`}>
          {String(m.type)}
        </button>
        <button
          type="button"
          className="btn ghost sm hc-gql-more"
          tabIndex={-1}
          aria-label={`Actions for ${m.name}`}
          onClick={(e) => setMenu({ x: e.clientX, y: e.clientY, entries: fieldMenu(m) })}
        >
          <MoreHorizontal size={13} />
        </button>
      </li>
    )
  }

  const matches = (m: Member): boolean => q === '' || m.name.toLowerCase().includes(q)

  return (
    <div className="hc-gql-tree-wrap">
      <input
        className="input mono hc-gql-filter"
        type="search"
        placeholder="Filter"
        aria-label="Filter schema"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />
      {focused ? (
        <div className="hc-gql-focus">
          <button type="button" className="btn ghost sm" onClick={() => setFocus(null)}>
            ‹ Roots
          </button>
          <p className="hc-gql-type-head mono">
            {focused.name} <span className="hc-gql-kind">{kindOf(focused)}</span>
          </p>
          {focused.description && <p className="hc-gql-desc">{focused.description}</p>}
          <ul role="tree" aria-label={focused.name} className="hc-gql-tree">
            {membersOf(focused).filter(matches).map(row)}
            {isEnumType(focused) &&
              focused
                .getValues()
                .filter((v) => q === '' || v.name.toLowerCase().includes(q))
                .map((v) => (
                  <li key={v.name} role="treeitem" className="hc-gql-field mono" title={v.description ?? undefined}>
                    {v.name}
                  </li>
                ))}
          </ul>
        </div>
      ) : (
        <ul role="tree" aria-label="Schema" className="hc-gql-tree">
          {roots(schema).map(({ label, type }) => {
            const expanded = q !== '' || !!open[label]
            const members = membersOf(type).filter(matches)
            return (
              <li key={label} role="treeitem" aria-expanded={expanded}>
                <button
                  type="button"
                  className="hc-gql-root"
                  onClick={() => setOpen((o) => ({ ...o, [label]: !o[label] }))}
                >
                  {expanded ? <ChevronDown size={13} aria-hidden /> : <ChevronRight size={13} aria-hidden />} {label}
                </button>
                {expanded && <ul role="group">{members.map(row)}</ul>}
              </li>
            )
          })}
          {matchingTypes.length > 0 && (
            <li role="treeitem" aria-expanded>
              <span className="hc-gql-root">Types</span>
              <ul role="group">
                {matchingTypes.map((t) => (
                  <li key={t.name} role="treeitem" className="hc-gql-field">
                    <button type="button" className="hc-gql-type mono" onClick={() => goTo(t.name)}>
                      {t.name}
                    </button>{' '}
                    <span className="hc-gql-kind">{kindOf(t)}</span>
                  </li>
                ))}
              </ul>
            </li>
          )}
        </ul>
      )}
      {menu && <ContextMenu x={menu.x} y={menu.y} entries={menu.entries} onClose={() => setMenu(null)} />}
    </div>
  )
}

function kindOf(t: GraphQLNamedType): string {
  if (isObjectType(t)) return 'type'
  if (isInterfaceType(t)) return 'interface'
  if (isInputObjectType(t)) return 'input'
  if (isEnumType(t)) return 'enum'
  return isUnionType(t) ? 'union' : 'scalar'
}
