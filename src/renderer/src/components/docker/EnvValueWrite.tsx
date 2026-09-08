import { useState } from 'react'
import { AlertTriangle, Check, KeyRound, Loader2 } from 'lucide-react'

import { ENV_WRITE_DISCLOSURE } from '../../../../shared/envWrite'
import type { ComposeEnvWriteResult } from '../../../../shared/compose'
import type { VaultEntryDescriptor, VaultIndexResult } from '../../../../shared/vaultIndex'
import { bridgeHas } from '../../lib/bridge'
import { UnlockVaultButton } from '../common/UnlockVaultButton'

// Setting one `.env` variable from the vault.
//
// WHAT THIS COMPONENT NEVER TOUCHES IS THE POINT. It sends a vault entry id and
// which slot on it to use; main resolves the value, writes it, and answers with
// a line number. There is no state here that holds a value, no input that
// accepts one, and no field on the result that could carry one back --
// `writeEnvValue` on the preload has no `value` parameter at all, which is
// enforced by `ComposePreloadBridge` rather than by this file remembering.
//
// IT READS THE VAULT BY NAME AND CANNOT READ IT ANY OTHER WAY. `store/vault`
// and `opsmaxx.vault` are both forbidden to a module, and correctly so:
// `vault.list()` returns every entry with its password in it, so importing the
// store here would have put the whole plaintext vault inside the docker
// module's renderer half. `tests/moduleBoundaries.test.ts` caught exactly that
// on the first version of this file. What it uses instead is
// `opsmaxx.vaultIndex`, whose descriptors have no field that could hold a
// value.
//
// AND IT CANNOT TELL YOU WHETHER THE VALUE IS ALREADY THE SAME. Knowing that
// would mean reading the existing one to compare, which is the read the whole
// compose module is arranged to avoid. `ENV_WRITE_DISCLOSURE` says so on
// screen, because an operator who expects a no-op and gets a write should have
// been told, and because a limitation nobody states reads as a bug.

const SLOTS: { slot: 'password' | 'privateKey' | 'username' | 'field'; label: string }[] = [
  { slot: 'password', label: 'The entry’s password / API key' },
  { slot: 'privateKey', label: 'The entry’s key material' },
  { slot: 'username', label: 'The entry’s username' },
  { slot: 'field', label: 'A named custom field' }
]

export interface EnvValueWriteProps {
  cfg: unknown
  serverId: string
  path: string
  name: string
  sudo?: boolean
  /** Re-read the env summary. The panel owns that read; this only asks. */
  onWritten: () => void
}

export function EnvValueWrite({
  cfg,
  serverId,
  path,
  name,
  sudo,
  onWritten
}: EnvValueWriteProps): React.JSX.Element | null {
  const [entries, setEntries] = useState<VaultEntryDescriptor[] | null>(null)
  const [locked, setLocked] = useState(false)
  const [open, setOpen] = useState(false)
  const [entryId, setEntryId] = useState('')
  const [slot, setSlot] = useState<'password' | 'privateKey' | 'username' | 'field'>('password')
  const [fieldKey, setFieldKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<ComposeEnvWriteResult | null>(null)

  const bridge = window.opsmaxx?.compose as Record<string, unknown> | undefined
  // An older preload has no such method, and a button that cannot do anything
  // is worse than no button.
  if (!bridgeHas(bridge, 'writeEnvValue')) return null

  // Read when the form is opened rather than on mount: a panel listing thirty
  // variables would otherwise ask thirty times for the same list.
  const openForm = async (): Promise<void> => {
    setOpen(true)
    const r = (await (
      window.opsmaxx?.vaultIndex as unknown as { list: () => Promise<VaultIndexResult> }
    ).list()) as VaultIndexResult
    if (r.ok) {
      setEntries(r.entries)
      setLocked(false)
    } else {
      setEntries(null)
      setLocked(true)
    }
  }

  if (!open) {
    return (
      <button
        className="btn-ghost"
        style={{ fontSize: 11 }}
        onClick={() => void openForm()}
        aria-label={`Set ${name} from the vault`}
      >
        <KeyRound size={11} /> Set from vault
      </button>
    )
  }

  // The vault is where the value comes from. Offering the form while it is
  // locked would collect a choice and then refuse it.
  if (locked || entries === null) {
    return (
      <div className="faint" style={{ fontSize: 11, display: 'flex', alignItems: 'center', gap: 6 }}>
        <span>
          Set <span className="mono">{name}</span> from the vault.
        </span>
        <UnlockVaultButton
          className="btn sm"
          reason={`Unlocking lets you set ${name} from a vault entry.`}
        />
      </div>
    )
  }

  const chosen = entries.find((e) => e.id === entryId)
  const ready = entryId !== '' && (slot !== 'field' || fieldKey !== '')

  const run = async (): Promise<void> => {
    setBusy(true)
    setResult(null)
    try {
      const r = (await (
        window.opsmaxx?.compose as unknown as {
          writeEnvValue: (
            c: unknown,
            req: { path: string; name: string; serverId: string },
            ref: { vaultEntryId: string; slot: string; fieldKey?: string },
            opts?: { sudo?: boolean }
          ) => Promise<ComposeEnvWriteResult>
        }
      ).writeEnvValue(
        cfg,
        { path, name, serverId },
        { vaultEntryId: entryId, slot, ...(slot === 'field' ? { fieldKey } : {}) },
        { sudo }
      )) as ComposeEnvWriteResult
      setResult(r)
      if (r.ok) onWritten()
    } catch {
      setResult({ ok: false, reason: 'The write could not be run.' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="col" style={{ gap: 6, marginTop: 4 }}>
      <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
        <span className="mono" style={{ fontSize: 11 }}>
          {name}
        </span>
        <select
          className="input"
          style={{ fontSize: 11 }}
          aria-label="Vault entry"
          value={entryId}
          onChange={(e) => setEntryId(e.target.value)}
          disabled={busy}
        >
          <option value="">Choose a vault entry…</option>
          {entries.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name}
            </option>
          ))}
        </select>
        <select
          className="input"
          style={{ fontSize: 11 }}
          aria-label="Which field"
          value={slot}
          onChange={(e) => setSlot(e.target.value as typeof slot)}
          disabled={busy}
        >
          {SLOTS.map((s) => (
            <option key={s.slot} value={s.slot}>
              {s.label}
            </option>
          ))}
        </select>
        {slot === 'field' && (
          <select
            className="input"
            style={{ fontSize: 11 }}
            aria-label="Field name"
            value={fieldKey}
            onChange={(e) => setFieldKey(e.target.value)}
            disabled={busy}
          >
            <option value="">Choose a field…</option>
            {/* The KEYS of the entry's custom fields. A key is a label the
                operator typed; the value beside it never reaches here. */}
            {(chosen?.fieldKeys ?? []).map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        )}
        <button className="btn" style={{ fontSize: 11 }} onClick={() => void run()} disabled={busy || !ready}>
          {busy ? <Loader2 size={11} className="spin" /> : null}
          {busy ? 'Writing' : 'Write'}
        </button>
        <button className="btn-ghost" style={{ fontSize: 11 }} onClick={() => setOpen(false)} disabled={busy}>
          Cancel
        </button>
      </div>

      <span className="faint" style={{ fontSize: 11 }}>
        {ENV_WRITE_DISCLOSURE}
      </span>

      {result !== null && result.ok && (
        <div className="row" style={{ gap: 6, fontSize: 11, color: 'var(--ok)' }}>
          <Check size={11} />
          {/* Which line, never what is on it. */}
          <span>
            {result.action === 'append'
              ? `${result.name} was added to ${path}.`
              : `${result.name} was replaced on line ${result.line} of ${path}.`}{' '}
            The previous file is at <span className="mono">{result.backup}</span>. Nothing is
            running the new value yet — the stack has to be brought up again.
          </span>
        </div>
      )}
      {result !== null && !result.ok && (
        <div className="row" style={{ gap: 6, fontSize: 11, color: 'var(--danger)' }}>
          <AlertTriangle size={11} />
          <span>{result.reason}</span>
        </div>
      )}
    </div>
  )
}
