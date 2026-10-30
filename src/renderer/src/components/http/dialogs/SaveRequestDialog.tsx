import { useMemo, useState } from 'react'
import { TriangleAlert } from 'lucide-react'
import { newId, type ApiRequest, type Id, type Route } from '../../../../../shared/apiModel'
import { useApi } from '../../../store/api'
import { useApp } from '../../../store/app'
import { useHttp } from '../../../store/http'
import { Field, Modal } from '../../common/Modal'
import { destinationsIn } from './MoveToDialog'
import { collectionRoute, routeLabel } from '../collection/RouteSelect'
import { useT } from '../../../lib/i18n'
import { Trans } from '../../../lib/Trans'
import '../nav.css'

const NEW = '__new'

export type SaveRequestDialogProps =
  /** The workbench's form: save this scratch tab, which then becomes the saved request (attachRef). */
  | { tabId: Id; onClose: () => void }
  /** A request from elsewhere (a history entry), with the route it was sent from. */
  | { request: ApiRequest; route: Route; onSaved: (ref: { collectionId: Id; requestId: Id }) => void; onClose: () => void }

/**
 * Save a request into a collection (§2.9, UX-M3). A saved request sends from
 * its collection's route, so the dialog says which one that is, and a new
 * collection made here inherits the route the request used.
 */
export function SaveRequestDialog(props: SaveRequestDialogProps): React.JSX.Element | null {
  const fromTab = useHttp((s) => ('tabId' in props ? s.requestFor(props.tabId) : null))
  const tabRoute = useHttp((s) => ('tabId' in props ? s.tabs.find((t) => t.id === props.tabId)?.route : undefined))
  const request = 'tabId' in props ? fromTab : props.request
  if (!request) return null
  return (
    <SaveForm
      request={request}
      route={'tabId' in props ? (tabRoute ?? { kind: 'direct' }) : props.route}
      onClose={props.onClose}
      onSaved={(ref) => ('tabId' in props ? useHttp.getState().attachRef(props.tabId, ref) : props.onSaved(ref))}
    />
  )
}

function SaveForm({
  request,
  route,
  onSaved,
  onClose
}: {
  request: ApiRequest
  route: Route
  onSaved: (ref: { collectionId: Id; requestId: Id }) => void
  onClose: () => void
}): React.JSX.Element {
  const ws = useApp((s) => s.activeWorkspaceId)
  const options = useMemo(() => destinationsIn(ws), [ws])
  const [name, setName] = useState(request.name)
  const [dest, setDest] = useState(options.length ? '0' : NEW)
  const [newName, setNewName] = useState('')
  const collections = useApi((s) => s.collections)
  const t = useT()

  const chosen = dest === NEW ? null : options[Number(dest)]
  const target = chosen ? collections.find((c) => c.id === chosen.collectionId) : null
  const used = routeLabel(route)
  const nameError = name.trim() ? null : t('http.save.nameRequired')
  const newError = dest === NEW && !newName.trim() ? t('http.save.newNameRequired') : null

  const save = (): void => {
    const api = useApi.getState()
    const collectionId = chosen ? chosen.collectionId : api.createCollection(newName.trim(), route)
    const requestId = newId('req')
    api.addItem(collectionId, chosen?.parentId ?? null, { ...request, id: requestId, name: name.trim() })
    onSaved({ collectionId, requestId })
    onClose()
  }

  return (
    <Modal
      title={t('http.save.title')}
      onClose={onClose}
      confirm={{ label: t('common.save'), onClick: save, disabled: !!nameError || !!newError }}
    >
      <Field label={t('http.save.name')} error={nameError}>
        <input className="input" value={name} autoFocus onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label={t('http.save.saveTo')}>
        <select className="input" value={dest} onChange={(e) => setDest(e.target.value)}>
          {options.map((d, i) => (
            <option key={`${d.collectionId}/${d.parentId}`} value={String(i)}>
              {d.label}
            </option>
          ))}
          <option value={NEW}>{t('http.save.newCollectionOption')}</option>
        </select>
      </Field>
      {dest === NEW && (
        <Field label={t('http.save.newCollectionName')} error={newError}>
          <input className="input" value={newName} onChange={(e) => setNewName(e.target.value)} />
        </Field>
      )}
      <p className="hc-effective" aria-live="polite">
        {target ? (
          <Trans
            i18nKey={
              routeLabel(collectionRoute(target)) !== used
                ? 'http.save.sendsFromCollectionDiffers'
                : 'http.save.sendsFromCollection'
            }
            values={{ route: routeLabel(collectionRoute(target)), used }}
            components={{ strong: <strong /> }}
          />
        ) : (
          <Trans i18nKey="http.save.sendsFromNew" values={{ route: used }} components={{ strong: <strong /> }} />
        )}
      </p>
      {target?.insecureTls && (
        <p className="hc-warn-line">
          <TriangleAlert size={13} aria-hidden="true" /> {t('http.save.unverified')}
        </p>
      )}
      {target?.caPem && <p className="hc-note-line">{t('http.save.customCa')}</p>}
    </Modal>
  )
}
