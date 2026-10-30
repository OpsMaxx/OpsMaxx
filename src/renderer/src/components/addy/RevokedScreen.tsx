import { useState } from 'react'
import { ShieldOff, AlertTriangle, Loader2 } from 'lucide-react'
import type { AddyRevocation } from '../../../../preload'
import { useT } from '../../lib/i18n'

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
  onClear,
  onRetry
}: {
  state: AddyRevocation
  onClear: () => Promise<void>
  /** Run the deletion again. Only reachable from `failed`, where the previous
   *  attempt left files behind and the app is otherwise unusable. */
  onRetry: () => Promise<void>
}): React.JSX.Element {
  const [clearing, setClearing] = useState(false)
  const [retrying, setRetrying] = useState(false)
  const t = useT()

  const when = state.at ? new Date(state.at).toLocaleString() : t('addy.revoked.unknownTime')
  const failed = state.stage === 'failed'
  const running = state.stage === 'wiping'

  return (
    <div className="revoked-screen">
      <div className="revoked-card">
        <ShieldOff size={40} className="revoked-icon" aria-hidden />
        <h1>{t('addy.revoked.title')}</h1>
        <p>{t('addy.revoked.body', { when })}</p>

        {running && (
          <p className="revoked-progress">
            <Loader2 size={16} className="spin" aria-hidden /> {t('addy.revoked.deleting')}
          </p>
        )}

        {failed && (
          <div className="revoked-problem" role="alert">
            <AlertTriangle size={16} aria-hidden />
            <div>
              <strong>{t('addy.revoked.failed')}</strong>
              {/* Shown rather than swallowed: the person at this machine is the
                  only one who can act on it, and "something went wrong" would
                  leave them unable to. */}
              <p>{state.error ?? t('addy.revoked.noReason')}</p>
              <p>{t('addy.revoked.failedHelp')}</p>
              {/* THE DEAD END THIS FIXES. `failed` offered no action at all:
                  the only button on the screen renders on `wiped`, so a retry
                  that kept failing left the app bricked with nothing to press
                  and no way to try again short of quitting and relaunching. */}
              <button
                className="btn"
                disabled={retrying}
                onClick={() => {
                  setRetrying(true)
                  void onRetry().finally(() => setRetrying(false))
                }}
              >
                {retrying ? (
                  <>
                    <Loader2 size={14} className="spin" aria-hidden /> {t('addy.revoked.retrying')}
                  </>
                ) : (
                  t('addy.revoked.retry')
                )}
              </button>
            </div>
          </div>
        )}

        <p className="revoked-note">{t('addy.revoked.note')}</p>

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
            {clearing ? t('addy.revoked.settingUp') : t('addy.revoked.clear')}
          </button>
        )}
      </div>
    </div>
  )
}
