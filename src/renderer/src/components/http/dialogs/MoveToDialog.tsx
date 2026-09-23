import { useMemo, useState } from 'react'
import type { Id, Item } from '../../../../../shared/apiModel'
import { useApi } from '../../../store/api'
import { useHttp } from '../../../store/http'
import { useApp } from '../../../store/app'
import { Modal } from '../../common/Modal'
import '../nav.css'

export interface Destination {
  collectionId: Id
  parentId: Id | null
  label: string
}

/** Every collection and folder in the workspace, as "collection / folder / sub". */
export function destinationsIn(wsId: Id, exclude?: Id): Destination[] {
  const out: Destination[] = []
  const walk = (colId: Id, items: Item[], path: string): void => {
    for (const i of items) {
      if (i.kind !== 'folder' || i.id === exclude) continue
      const label = `${path} / ${i.name}`
      out.push({ collectionId: colId, parentId: i.id, label })
      walk(colId, i.items, label)
    }
  }
  for (const c of useApi.getState().collectionsIn(wsId)) {
    out.push({ collectionId: c.id, parentId: null, label: c.name })
    walk(c.id, c.items, c.name)
  }
  return out
}

/** Move a request or folder to another collection or folder, at the end. */
export function MoveToDialog({
  colId,
  itemId,
  onClose
}: {
  colId: Id
  itemId: Id
  onClose: () => void
}): React.JSX.Element {
  const ws = useApp((s) => s.activeWorkspaceId)
  // A folder cannot go into itself or its own subtree, so its subtree is left out.
  const options = useMemo(() => destinationsIn(ws, itemId), [ws, itemId])
  const [choice, setChoice] = useState(0)
  const name = useApi((s) => {
    const find = (items: Item[]): Item | undefined => {
      for (const i of items) {
        if (i.id === itemId) return i
        if (i.kind === 'folder') {
          const f = find(i.items)
          if (f) return f
        }
      }
      return undefined
    }
    return find(s.collections.find((c) => c.id === colId)?.items ?? [])?.name ?? 'item'
  })
  const move = (): void => {
    const d = options[choice]
    if (!d) return
    const dest = useApi.getState().collections.find((c) => c.id === d.collectionId)
    const siblings = d.parentId === null ? dest?.items : findFolder(dest?.items ?? [], d.parentId)?.items
    const moved = requestIdsIn(useApi.getState().collections.find((c) => c.id === colId)?.items ?? [], itemId)
    useApi.getState().moveItem(colId, itemId, d.collectionId, d.parentId, siblings?.length ?? 0)
    if (d.collectionId !== colId) repointTabs(colId, d.collectionId, moved)
    onClose()
  }
  return (
    <Modal title={`Move ${name} to…`} onClose={onClose} confirm={{ label: 'Move', onClick: move, disabled: !options.length }}>
      <div role="radiogroup" aria-label="Destination" className="hc-dest-list">
        {options.map((d, i) => (
          <label key={`${d.collectionId}/${d.parentId}`} className="hc-dest">
            <input type="radio" name="hc-move-dest" checked={choice === i} onChange={() => setChoice(i)} /> {d.label}
          </label>
        ))}
      </div>
    </Modal>
  )
}

/** The request ids in the subtree rooted at `itemId` (itself, when it is a request). */
export function requestIdsIn(items: Item[], itemId: Id): Set<Id> {
  const out = new Set<Id>()
  const collect = (list: Item[]): void => {
    for (const i of list) {
      if (i.kind === 'folder') collect(i.items)
      else out.add(i.id)
    }
  }
  const find = (list: Item[]): void => {
    for (const i of list) {
      if (i.id === itemId) return i.kind === 'folder' ? collect(i.items) : void out.add(i.id)
      if (i.kind === 'folder') find(i.items)
    }
  }
  find(items)
  return out
}

/**
 * Open tabs on moved requests follow them to the new collection, so a save
 * lands where the request now is (M5).
 */
export function repointTabs(fromCol: Id, toCol: Id, requestIds: ReadonlySet<Id>): void {
  if (requestIds.size === 0) return
  // ponytail: store/http has no action for this; one setState until S adds one.
  useHttp.setState((s) => ({
    tabs: s.tabs.map((t) =>
      t.ref?.collectionId === fromCol && t.ref.requestId && requestIds.has(t.ref.requestId)
        ? { ...t, ref: { ...t.ref, collectionId: toCol } }
        : t
    )
  }))
}

function findFolder(items: Item[], id: Id): Extract<Item, { kind: 'folder' }> | undefined {
  for (const i of items) {
    if (i.kind !== 'folder') continue
    if (i.id === id) return i
    const f = findFolder(i.items, id)
    if (f) return f
  }
  return undefined
}
