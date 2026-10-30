import type { ApiCollectionV2 } from '../../../../../shared/apiModel'
import { Modal } from '../../common/Modal'
import { countRequests } from '../sidebar/treeMenus'
import { useT } from '../../../lib/i18n'

/** The one tree deletion that asks first: a whole collection. An undo toast follows. */
export function DeleteCollectionDialog({
  collection,
  onConfirm,
  onClose
}: {
  collection: ApiCollectionV2
  onConfirm: () => void
  onClose: () => void
}): React.JSX.Element {
  const t = useT()
  const n = countRequests(collection.items)
  return (
    <Modal
      title={t('http.deleteCollection.title', { name: collection.name })}
      onClose={onClose}
      confirm={{
        label: t('http.deleteCollection.confirm'),
        destructive: true,
        onClick: () => {
          onConfirm()
          onClose()
        }
      }}
    >
      <p>
        {n === 0 ? t('http.deleteCollection.empty') : t('http.deleteCollection.contents', { count: n })}{' '}
        {t('http.deleteCollection.undoHint')}
      </p>
    </Modal>
  )
}
