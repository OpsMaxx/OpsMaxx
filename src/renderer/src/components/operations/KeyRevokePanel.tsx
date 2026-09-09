import { useCallback, useEffect, useMemo, useState } from 'react'
import { KeyRound, ShieldAlert } from 'lucide-react'
import { bridgeHas } from '../../lib/bridge'
import { clsx } from '../../lib/format'
import { sshHopsFor } from '../../lib/ssh'
import { useApp } from '../../store/app'
import { openMonitor, openSettings, useNav } from '../../store/nav'
import {
  ACCESS_WRITE_DISABLED_REASON,
  ACCESS_WRITE_DISABLED_SUMMARY,
  ACCESS_WRITE_ENABLED,
  ACCESS_WRITE_SCOPE,
  type AccessChangePreview,
  type AccessCommitOutcome,
  type AccessRunResult,
  type HostAccess
} from '../../../../shared/access'
import type { Server } from '../../types'
import { NoteWhy, PanelShell } from '../monitor/PanelShell'
import { VaultLockedHosts } from '../common/PanelError'
import { isVaultLocked } from '../../lib/withVaultUnlock'

// Revoking an SSH key across the estate — the write half of what used to be one
// Monitoring tab.
//
// AccessPanel is a large read: every authorized_keys file on the fleet,
// fingerprinted, with the hosts nobody could check counted separately. One
// mutating action was bolted onto it, in a table cell, on a destination whose
// stated contract is that nothing in it writes to a server. That contract is
// worth more than the convenience of revoking from the row you are reading, so
// the button became a pointer (`openKeyRevoke`) and the action moved here.
//
// What moved is WHERE it lives. Every check came with it, unchanged: the build
// ceiling and the operator's own switch, the plan main derives and re-derives,
// the command text sent back so main can refuse if the two differ, the accounts
// left out by name and reason, the timestamped backup, the server-armed
// rollback, and the second independent session that has to authenticate before
// anything becomes permanent.
//
// It reads the SAME collection AccessPanel reads, by the same pull —
// `fleet.access()` returns what the background sweep already holds and never
// triggers a probe. There is exactly one thing deciding how often every home
// directory on every host gets stat'ed, and it is the sampler; a second panel
// asking must not become a second reason to walk the estate.

/** What one server's collection looks like from here, including the two states
 *  that are not a collection: never run, and failed. */
interface Entry {
  access?: HostAccess
  error?: string
}

/** One fingerprint and every account that trusts it — the only aggregation this
 *  panel needs. AccessPanel's KeyRow says considerably more (restricted, via a
 *  certificate, a certificate authority) because it is answering "what is on my
 *  estate"; this is answering "what would come off it", and a second copy of
 *  the fuller reading would be a second thing to keep true. */
interface RevocableKey {
  fingerprint: string
  labels: string[]
  targets: { serverId: string; serverName: string; user: string }[]
}

const OUTCOME_LABEL: Record<AccessCommitOutcome, string> = {
  committed: 'Committed',
  'reverted-verification-failed': 'Reverted — the server would not let a new session in',
  'reverted-unconfirmed': 'Reverted — nothing confirmed it in time'
}

function outcomeClass(outcome: AccessCommitOutcome): string {
  return outcome === 'committed' ? 'ok' : outcome === 'reverted-verification-failed' ? 'loud' : 'warn'
}

export function KeyRevokePanel({ servers }: { servers: Server[] }): React.JSX.Element {
  const [entries, setEntries] = useState<Record<string, Entry>>({})
  const [selected, setSelected] = useState<string | null>(null)
  // Three states rather than one boolean, which is the shape this flow had on
  // the read surface and the shape it keeps: nothing asked, a plan main has
  // derived that the operator has not agreed to, and what happened.
  const [pending, setPending] = useState<{ fingerprint: string; preview: AccessChangePreview } | null>(
    null
  )
  const [result, setResult] = useState<AccessRunResult | null>(null)
  const [running, setRunning] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  const jump = useNav((s) => s.operationsJump)
  const [honoured, setHonoured] = useState(0)

  const load = useCallback(async (): Promise<void> => {
    if (!bridgeHas(window.opsmaxx?.fleet as Record<string, unknown> | undefined, 'access')) return
    const next: Record<string, Entry> = {}
    await Promise.all(
      servers.map(async (s) => {
        const r = await window.opsmaxx?.fleet?.access(s.id)
        if (r) next[s.id] = { access: r.access, error: r.error }
      })
    )
    setEntries(next)
  }, [servers])

  useEffect(() => {
    void load()
  }, [load])

  // A jump fills the form in; it never plans and never runs. `nonce` rather
  // than a value comparison, for LogTailJumpRequest's reason: asking twice for
  // the same key is a thing people do, and the second ask must not be swallowed
  // because it looks like the first.
  useEffect(() => {
    if (!jump || jump.kind !== 'revoke-key' || jump.nonce === honoured) return
    setHonoured(jump.nonce)
    setSelected(jump.fingerprint)
    setPending(null)
    setResult(null)
    setProblem(null)
  }, [jump, honoured])

  const writeOptIn = useApp((st) => st.settings.accessWriteEnabled)
  // Three gates, failing for three different reasons: the BUILD ceiling is a
  // decision about this release, the SETTING is the operator's, the bridge is a
  // fact about this install. Main enforces the first two again in both
  // handlers, so this is the honest UI and not the boundary.
  const canWrite =
    (ACCESS_WRITE_ENABLED || writeOptIn) &&
    bridgeHas(window.opsmaxx?.fleet as Record<string, unknown> | undefined, 'accessPlan')

  /** Every host that did not produce a reading. Not a footnote: a key missing
   *  from this list may still be on those hosts, so "revoked from the fleet" is
   *  a claim this panel is not allowed to make. */
  const unchecked = useMemo(
    () => servers.filter((s) => !entries[s.id]?.access).map((s) => s.name),
    [servers, entries]
  )

  const keys = useMemo<RevocableKey[]>(() => {
    const by = new Map<string, RevocableKey>()
    for (const s of servers) {
      const access = entries[s.id]?.access
      if (!access) continue
      for (const a of access.accounts) {
        for (const k of a.keys ?? []) {
          // A line that could not be fingerprinted is not a key this can
          // revoke: main matches by fingerprint, and there is nothing here to
          // match with. It is counted as unreadable in the Monitoring panel
          // rather than dropped — this one only has to not offer it.
          if (k.fingerprint === null) continue
          const row = by.get(k.fingerprint) ?? {
            fingerprint: k.fingerprint,
            labels: [],
            targets: []
          }
          // Free text out of a file on a host that may already be compromised.
          // It arrives stripped of control characters and bidi overrides and
          // capped (shared/access.ts), and it is rendered as text in a cell —
          // never as a title, a link or markup.
          if (k.comment && !row.labels.includes(k.comment)) row.labels.push(k.comment)
          row.targets.push({ serverId: s.id, serverName: s.name, user: a.user })
          by.set(k.fingerprint, row)
        }
      }
    }
    // Most widespread first: a key on eleven accounts is the one worth looking
    // at, and the fingerprint tie-break keeps the order stable across re-reads.
    return [...by.values()].sort(
      (a, b) => b.targets.length - a.targets.length || a.fingerprint.localeCompare(b.fingerprint)
    )
  }, [servers, entries])

  const chosen = keys.find((k) => k.fingerprint === selected) ?? null

  /** The accounts this key is on, as targets main can look up for itself. The
   *  renderer names the key and the servers; it does not decide anything. */
  const targetsFor = useCallback(
    (fingerprint: string): { serverId: string; serverName: string; user: string; cfg: unknown }[] => {
      const out: { serverId: string; serverName: string; user: string; cfg: unknown }[] = []
      for (const s of servers) {
        const access = entries[s.id]?.access
        if (!access) continue
        for (const a of access.accounts) {
          if ((a.keys ?? []).some((k) => k.fingerprint === fingerprint)) {
            out.push({
              serverId: s.id,
              serverName: s.name,
              user: a.user,
              // The same shape broadcast and patch send, and for the same
              // reason: no secret is carried here. Main resolves them per host
              // at the moment it connects, so a vault unlocked or a credential
              // edited since this panel rendered is honoured rather than baked
              // in. Handing over the `Server` row from the store instead
              // typechecks — `cfg` is `unknown` on the wire — and main would
              // open nothing, on the one operation where "nothing happened" is
              // reported as a host that refused the change.
              cfg: {
                sessionId: `access-${s.id}`,
                cols: 80,
                rows: 24,
                serverId: s.id,
                host: s.host,
                port: s.port,
                username: s.username,
                auth: s.auth === 'password' || s.auth === 'agent' ? s.auth : 'key',
                hops: sshHopsFor(s),
                // Carried where broadcast does not, because the confirmation
                // opens a SECOND connection: one that came up over the tunnel
                // and one that did not would be two different hosts as far as
                // this rule is concerned.
                vpnProfileId: s.vpnProfileId ?? undefined
              }
            })
          }
        }
      }
      return out
    },
    [servers, entries]
  )

  const plan = async (fingerprint: string): Promise<void> => {
    setProblem(null)
    setResult(null)
    setRunning(true)
    try {
      const preview = await window.opsmaxx?.fleet?.accessPlan({
        kind: 'revoke',
        fingerprint,
        targets: targetsFor(fingerprint)
      })
      if (preview) setPending({ fingerprint, preview })
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e))
    } finally {
      setRunning(false)
    }
  }

  // `notStaged` is the bucket for "the write did not land and nothing was
  // changed", which is exactly where a locked vault puts a host.
  const vaultLockedHosts = (result?.notStaged ?? [])
    .filter((f) => isVaultLocked(f.detail))
    .map((f) => f.serverName)

  const run = async (): Promise<void> => {
    if (!pending) return
    setRunning(true)
    setProblem(null)
    try {
      const r = await window.opsmaxx?.fleet?.accessRun({
        kind: 'revoke',
        fingerprint: pending.fingerprint,
        token: pending.preview.token,
        // The command text as it was SHOWN. Main re-derives and refuses if the
        // two differ, so what was agreed to is what runs or nothing runs.
        confirmedCommand: pending.preview.command,
        targets: targetsFor(pending.fingerprint)
      })
      setPending(null)
      if (r) setResult(r)
      // The estate has changed, whichever way each host went.
      await load()
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e))
    } finally {
      setRunning(false)
    }
  }

  return (
    <PanelShell
      icon={<KeyRound size={14} />}
      title="Revoke a key"
      about={
        <p>
          Removes one key from every account across the estate that trusts it. The inventory below
          is the reading the Monitoring sweep already took; nothing here re-reads a server until a
          change has been made to it.
        </p>
      }
    >

      {/* Said once, before a target is chosen — because the point of saying it
          is that nobody plans around a capability this does not have. Both
          halves matter: that the write half is off, and what it will and will
          not be able to do when it is back. */}
      {!canWrite && (
        <div className="panel-note is-unknown" data-testid="write-gated">
          {/* Folded behind NoteWhy — the same primitive PatchPanel already
              uses — because the reasoning outweighed the data: seven hundred
              characters of justification sat above the keys this screen
              exists to show. What stays visible carries both operative facts,
              that the write half is off and that nothing here writes
              anywhere, so a reader who never expands it is not misled. */}
          <ShieldAlert size={12} /> <b>{ACCESS_WRITE_DISABLED_SUMMARY}</b>
          <NoteWhy summary="Why it is off, and what it will be able to do">
            <p>{ACCESS_WRITE_DISABLED_REASON}</p>
            <p>{ACCESS_WRITE_SCOPE}</p>
          </NoteWhy>
        </div>
      )}

      {keys.length === 0 ? (
        <div className="panel-empty">
          <p className="panel-empty-title">No keys have been collected to revoke.</p>
          <p className="panel-empty-body">
            The authorized_keys sweep belongs to <b>Fleet keys and access</b> on Monitoring — this
            panel only acts on what that has already read, so with it switched off there is nothing
            here to act on. Nothing is revoked by reading, and nothing is read by opening this.
          </p>
          <div className="panel-empty-actions">
            <button className="btn ghost sm" onClick={() => openMonitor('access')}>
              Open Fleet keys and access
            </button>
            <button className="btn ghost sm" onClick={() => openSettings('modules')}>
              Choose modules
            </button>
          </div>
        </div>
      ) : (
        <>
          {/* The sentence that must exist before anyone concludes anything. A
              key revoked from every host that ANSWERED is not a key off the
              estate, and this panel is the one place where believing otherwise
              has a consequence. */}
          {unchecked.length > 0 && (
            <div className="panel-note is-unknown" data-testid="revoke-unchecked">
              <ShieldAlert size={12} /> {unchecked.length} server
              {unchecked.length === 1 ? ' was' : 's were'} not read, so this key may also be on{' '}
              {unchecked.length === 1 ? 'it' : 'them'}: {unchecked.join(', ')}. Revoking here removes
              it from the accounts listed below and from nowhere else.
            </div>
          )}

          <div className="inv-scroll">
            <table className="table inv-table">
              <thead>
                <tr>
                  <th>Fingerprint</th>
                  <th>Labelled</th>
                  <th className="num">Accounts</th>
                  <th>Where</th>
                </tr>
              </thead>
              <tbody>
                {keys.map((k) => (
                  <tr
                    key={k.fingerprint}
                    data-fingerprint={k.fingerprint}
                    className={clsx(selected === k.fingerprint && 'is-selected')}
                  >
                    <td className="mono">
                      <button
                        className="inv-host"
                        data-testid={`pick-${k.fingerprint}`}
                        disabled={running}
                        onClick={() => {
                          setSelected(k.fingerprint)
                          setPending(null)
                          setResult(null)
                          setProblem(null)
                        }}
                      >
                        {k.fingerprint}
                      </button>
                    </td>
                    <td>
                      {k.labels.length === 0 ? (
                        <span
                          className="inv-na"
                          title="No comment on any line carrying this key. A key with no label is not an unused key — it is a key nobody wrote down the owner of."
                        >
                          no label
                        </span>
                      ) : (
                        k.labels.join(' · ')
                      )}
                    </td>
                    <td className="num mono">{k.targets.length}</td>
                    <td className="faint">
                      {[...new Set(k.targets.map((t) => t.serverName))].join(', ')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {problem !== null && (
            <div className="s-desc warn" data-testid="access-problem">
              <b>Nothing was changed.</b> {problem}
            </div>
          )}

          {/* Offered, never taken automatically: revoking a key is a write with
              its own confirmed command, and main re-derives and refuses if the
              text differs. See the note on VaultLockedHosts. */}
          <VaultLockedHosts
            names={vaultLockedHosts}
            reason="Revoking a key on these servers needs their stored credentials."
          />

          {pending !== null && (
            <div className="s-desc" data-testid="revoke-confirm">
              <b>
                Revoke {pending.fingerprint} from {pending.preview.hosts.length} account
                {pending.preview.hosts.length === 1 ? '' : 's'}?
              </b>{' '}
              This is staged, not applied. Each server takes a timestamped backup, replaces the file,
              and arms its OWN rollback before OpsMaxx lets go — so if this app dies in the next
              instant, the server puts the previous file back by itself after{' '}
              {pending.preview.rollbackSeconds} seconds. Nothing becomes permanent until a second
              connection has authenticated against the changed file.
              {pending.preview.hosts.length > 0 && (
                <div className="mono" style={{ marginTop: 6 }}>
                  {pending.preview.hosts.map((h) => (
                    <div key={`${h.serverId}:${h.user}`}>
                      {h.serverName} · {h.user}
                    </div>
                  ))}
                </div>
              )}
              {(pending.preview.blocks.length > 0 || pending.preview.refusals.length > 0) && (
                <div style={{ marginTop: 8 }} data-testid="revoke-blocked">
                  <b>
                    {pending.preview.blocks.length + pending.preview.refusals.length} left out, and
                    not by choice:
                  </b>
                  <ul style={{ margin: '4px 0 0 16px' }}>
                    {pending.preview.blocks.map((b, i) => (
                      <li key={`b${i}`}>
                        <b>
                          {b.serverName} · {b.user}
                        </b>{' '}
                        — {b.reason}
                      </li>
                    ))}
                    {pending.preview.refusals.map((r, i) => (
                      <li key={`r${i}`}>
                        <b>
                          {r.serverName} · {r.user}
                        </b>{' '}
                        — {r.reason}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <div style={{ marginTop: 6 }}>
                <details>
                  <summary className="muted">
                    What will run on each server
                  </summary>
                  {/* Shown, and sent back with the run: main derives it again
                      and refuses to touch a host if the two differ. */}
                  <pre className="mono" style={{ whiteSpace: 'pre-wrap' }}>
                    {pending.preview.command || 'nothing — every server was left out'}
                  </pre>
                </details>
              </div>
            </div>
          )}

          {result !== null && (
            <div className="s-desc" data-testid="revoke-result">
              {result.reports.map((r) => (
                <div
                  key={`${r.serverId}:${r.token}`}
                  data-testid={`outcome-${r.serverId}`}
                  data-outcome={r.outcome}
                  style={{ marginBottom: 6 }}
                >
                  <span className={clsx('chip', outcomeClass(r.outcome))}>
                    {OUTCOME_LABEL[r.outcome]}
                  </span>{' '}
                  {r.detail}
                </div>
              ))}
              {result.notStaged.map((n) => (
                <div key={n.serverId} data-testid={`not-staged-${n.serverId}`} style={{ marginBottom: 6 }}>
                  <span className="chip loud">Not staged</span> Nothing was changed on {n.serverName}:{' '}
                  {n.detail}
                </div>
              ))}
              {result.reports.length === 0 && result.notStaged.length === 0 && (
                <span>Nothing ran: every server was left out.</span>
              )}
            </div>
          )}

          {/* The execute slot, at the FOOT of the card rather than the top-right
              corner every read-only panel puts "Check now" in — the reason is
              written out at .op-actionbar and in BroadcastPanel. Here it does
              double duty: the sentence on the left is the estate-wide count,
              which is the fact a person needs before pressing and the fact a
              table of fingerprints does not put in front of them. */}
          <div className="op-actionbar">
            <span className="op-actionbar-what" data-testid="revoke-targets">
              {chosen === null
                ? 'Choose a key above.'
                : `Removes ${chosen.fingerprint} from ${chosen.targets.length} account${
                    chosen.targets.length === 1 ? '' : 's'
                  } on ${[...new Set(chosen.targets.map((t) => t.serverName))].join(', ')}`}
            </span>
            <span className="grow" />
            {pending !== null ? (
              <>
                <button className="btn ghost" disabled={running} onClick={() => setPending(null)}>
                  Cancel
                </button>
                <button
                  className="btn danger"
                  data-testid="revoke-go"
                  disabled={running || pending.preview.hosts.length === 0}
                  onClick={() => void run()}
                >
                  Stage the revocation
                </button>
              </>
            ) : (
              <button
                className="btn danger"
                data-testid="revoke-plan"
                disabled={!canWrite || running || chosen === null}
                onClick={() => chosen && void plan(chosen.fingerprint)}
                title="Shows exactly what would run on which servers. Nothing is written until you confirm it, and nothing becomes permanent until a second, independent session has proved the server still lets OpsMaxx in."
              >
                Plan the revocation
              </button>
            )}
          </div>
        </>
      )}
    </PanelShell>
  )
}
