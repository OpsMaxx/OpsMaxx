import { useState } from 'react'
import { ShieldOff, AlertTriangle, Loader2 } from 'lucide-react'
import type { AddyRevocation } from '../../../../preload'

/**
 * What this device shows after the account it belonged to revoked it.
 *
 * A block, not a banner. It is rendered INSTEAD of the app rather than over it,
 * because everything it would sit on top of -- the sidebar, the status bar, the
 * command palette -- lists server names, workspace names and vault entries, and
 * the point of a revocation is that whoever is holding this machine is no
 * longer entitled to any of it. A modal that merely covers the app leaves all
 * of it one keyboard shortcut away.
 *
 * The wording is written for the person actually reading it, who is usually not
 * the person who pressed revoke: they are holding a laptop that has just
 * emptied itself, and the only useful things to tell them are what happened,
 * that it was deliberate, and what they can still do.
 */
export function RevokedScreen({
  state,
  onClear
}: {
  state: AddyRevocation
  onClear: () => Promise<void>
}): React.JSX.Element {
  const [clearing, setClearing] = useState(false)

  const when = state.at ? new Date(state.at).toLocaleString() : 'an unknown time'
  const failed = state.stage === 'failed'
  const running = state.stage === 'wiping'

  return (
    <div className="revoked-screen">
      <div className="revoked-card">
        <ShieldOff size={40} className="revoked-icon" aria-hidden />
        <h1>This device was removed from its account</h1>
        <p>
          On {when}, the account owner removed this device. OpsMaxx deleted the data it was holding
          for that account from this computer: servers, credentials, the vault, the host-key pins and
          the local history.
        </p>

        {running && (
          <p className="revoked-progress">
            <Loader2 size={16} className="spin" aria-hidden /> Still deleting. Leave the app open
            until this finishes.
          </p>
        )}

        {failed && (
          <div className="revoked-problem" role="alert">
            <AlertTriangle size={16} aria-hidden />
            <div>
              <strong>Some of it could not be deleted.</strong>
              {/* Shown rather than swallowed: the person at this machine is the
                  only one who can act on it, and "something went wrong" would
                  leave them unable to. */}
              <p>{state.error ?? 'No reason was recorded.'}</p>
              <p>Closing anything still using those files and reopening OpsMaxx will try again.</p>
            </div>
          </div>
        )}

        <p className="revoked-note">
          Nothing here can be recovered from this computer. If this was a mistake, the account owner
          can add this device again — it will pair as a new device and sync everything back.
        </p>

        {/* Only once the deletion has actually finished. Offering it during
            `wiping` or after `failed` would let someone dismiss the screen while
            data is still on disk. */}
        {state.stage === 'wiped' && (
          <button
            className="btn"
            disabled={clearing}
            onClick={() => {
              setClearing(true)
              void onClear()
            }}
          >
            {clearing ? 'Setting up…' : 'Use this computer for something else'}
          </button>
        )}
      </div>
    </div>
  )
}
