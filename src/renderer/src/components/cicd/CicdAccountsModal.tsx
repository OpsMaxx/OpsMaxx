import { useState } from 'react'
import { Pencil, Plus, Trash2 } from 'lucide-react'
import { Modal } from '../common/Modal'
import { EmptyState } from '../common/EmptyState'
import { duration } from '../../lib/format'
import { useApp } from '../../store/app'
import { PROVIDER_LABEL, hostOf, useCicdConnectionList } from './state'
import type { CicdConnection, CicdPanelState } from '../../../../shared/cicd'

/**
 * Every connected account in one list, with the two verbs the panel never had.
 *
 * Until now the only list of CI accounts anywhere was the freshness block at the
 * top of the panel, which answers "is this fresh" and nothing else. There was no
 * way to edit an account and no way to remove one: `deleteCicdConnection` has
 * existed in the store since the module was written, released the vault entry
 * correctly, and was called by exactly one test and no component. Removing an
 * account meant deleting the whole workspace.
 *
 * Right-clicking a tab reaches the same two verbs for ONE account. This screen
 * is the other half of that: it answers "what am I even connected to", which a
 * gesture cannot, and it does not require knowing the gesture exists.
 *
 * NO TOKEN PASSES THROUGH HERE. Removal hands an id to the store, which releases
 * the vault entry through `releaseCicdSecrets`; editing opens the connect modal,
 * which is the one place a token briefly exists.
 */
export function CicdAccountsModal({
  states,
  confirmRemove,
  onAdd,
  onEdit,
  onClose
}: {
  /** Last-read times, so a row can say whether the account is answering.
   *  Counts up on its own: the panel re-renders this on its own clock. */
  states: Map<string, CicdPanelState>
  /**
   * Open straight on this account's confirm.
   *
   * Set by the tab's own "Remove…", which has already named the account the
   * reader means. Landing them on the full list instead would make them find
   * it a second time, in a list where the one they right-clicked looks like
   * every other row.
   */
  confirmRemove?: CicdConnection
  onAdd: () => void
  onEdit: (connection: CicdConnection) => void
  onClose: () => void
}): React.JSX.Element {
  const connections = useCicdConnectionList()
  const remove = useApp((s) => s.deleteCicdConnection)
  const [pendingDelete, setPendingDelete] = useState<CicdConnection | null>(confirmRemove ?? null)

  // The confirm REPLACES this dialog rather than stacking on it. Two scrims deep
  // the thing being deleted is behind the box deleting it, and the name in the
  // title is then the only place it is legible.
  if (pendingDelete) {
    return (
      <Modal
        title={`Remove ${pendingDelete.name}?`}
        // Backing out of a confirm the tab opened directly closes the whole
        // thing: the reader never asked for the list, so dropping them into it
        // would answer a question they did not put.
        onClose={() => (confirmRemove ? onClose() : setPendingDelete(null))}
        cancelLabel="Keep it"
        confirm={{
          label: 'Remove',
          destructive: true,
          onClick: () => {
            const doomed = pendingDelete
            setPendingDelete(null)
            remove(doomed.id)
            if (confirmRemove) onClose()
          }
        }}
      >
        {/* Naming what else goes, on the precedent of the server delete: a row
            disappearing from a list reads as reversible, and the credential it
            takes with it is not. */}
        <p className="s-desc">
          OpsMaxx stops polling {hostOf(pendingDelete.baseUrl)} and deletes the stored token from
          the vault. Nothing on {PROVIDER_LABEL[pendingDelete.provider]} itself changes — no
          pipeline, no run and no build is touched, and the token stays valid until you revoke it
          there.
        </p>
        <p className="s-desc">
          The token cannot be recovered from OpsMaxx afterwards. Connecting the account again means
          pasting it again.
        </p>
      </Modal>
    )
  }

  return (
    <Modal
      title="CI/CD accounts"
      subtitle="Every account this workspace polls. Connect as many as you like, including several of the same provider — each is polled and addressed on its own."
      size="lg"
      onClose={onClose}
      cancelLabel="Done"
      footer={
        <button className="btn secondary size-28" onClick={onAdd}>
          <Plus size={14} /> Connect an account
        </button>
      }
    >
      {connections.length === 0 ? (
        <EmptyState
          compact
          title="No CI account is connected"
          message="Nothing is polled until one exists."
        />
      ) : (
        <div className="cicd-account-list">
          {connections.map((c) => {
            const s = states.get(c.id)
            return (
              <div key={c.id} className="cicd-account-row">
                <div className="grow ellipsis">
                  <b className="ellipsis">{c.name}</b>
                  <div className="ui-note ellipsis">
                    {PROVIDER_LABEL[c.provider]} · {hostOf(c.baseUrl)}
                    {c.insecureTls === true && (
                      /* Never implicit. The connect modal says so when it is set
                         and this list has to as well, or the only place the
                         weaker setting is visible is the form that set it. */
                      <span className="state-alarm"> · certificate checking off</span>
                    )}
                  </div>
                </div>
                <span className="ui-note cicd-account-read">
                  {s?.readAt === undefined ? 'never read' : `read ${duration(s.readAt)} ago`}
                </span>
                <button
                  type="button"
                  className="btn secondary size-24"
                  title={`Change ${c.name}'s URL, route or token.`}
                  onClick={() => onEdit(c)}
                >
                  <Pencil size={13} /> Edit
                </button>
                <button
                  type="button"
                  className="btn secondary size-24"
                  title={`Stop polling ${c.name} and delete its stored token.`}
                  onClick={() => setPendingDelete(c)}
                >
                  <Trash2 size={13} /> Remove
                </button>
              </div>
            )
          })}
        </div>
      )}
    </Modal>
  )
}
