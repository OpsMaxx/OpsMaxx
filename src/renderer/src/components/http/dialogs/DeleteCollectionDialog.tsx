import type { ApiCollectionV2 } from '../../../../../shared/apiModel'
import { Modal } from '../../common/Modal'
import { countRequests } from '../sidebar/treeMenus'

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
  const n = countRequests(collection.items)
  return (
    <Modal
      title={`Delete ${collection.name}?`}
      onClose={onClose}
      confirm={{
        label: 'Delete collection',
        destructive: true,
        onClick: () => {
          onConfirm()
          onClose()
        }
      }}
    >
      <p>
        {n === 0
          ? 'The collection is empty.'
          : `Its ${n} ${n === 1 ? 'request' : 'requests'}, folders, variables and connection settings are deleted with it.`}{' '}
        You can undo this from the notice that follows.
      </p>
    </Modal>
  )
}
