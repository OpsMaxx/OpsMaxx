import { useCallback, useEffect, useMemo, useState } from 'react'
import { KeyRound, ShieldAlert, Settings2 } from 'lucide-react'
import { bridgeHas } from '../../lib/bridge'
import { clsx } from '../../lib/format'
import { useT } from '../../lib/i18n'
import { Trans } from '../../lib/Trans'
import type { MessageKey } from '../../../../shared/i18n'
import { sshHopsFor } from '../../lib/ssh'
import { useApp } from '../../store/app'
import { openMonitor, openSettings, useNav } from '../../store/nav'
import { CheckNowButton } from '../monitor/CheckNowButton'
import {
  ACCESS_WRITE_DISABLED_REASON,
  ACCESS_WRITE_DISABLED_SUMMARY,
  ACCESS_WRITE_OFF_SUMMARY,
  ACCESS_WRITE_OPT_IN_NOTE,
  ACCESS_WRITE_STALE_BRIDGE,
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

const OUTCOME_LABEL: Record<AccessCommitOutcome, MessageKey> = {
  committed: 'operations.revoke.outcome.committed',
  'reverted-verification-failed': 'operations.revoke.outcome.revertedVerification',
  'reverted-unconfirmed': 'operations.revoke.outcome.revertedUnconfirmed'
}

function outcomeClass(outcome: AccessCommitOutcome): string {
  return outcome === 'committed' ? 'ok' : outcome === 'reverted-verification-failed' ? 'loud' : 'warn'
}

export function KeyRevokePanel({ servers }: { servers: Server[] }): React.JSX.Element {
  const t = useT()
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
  const hasBridge = bridgeHas(
    window.opsmaxx?.fleet as Record<string, unknown> | undefined,
    'accessPlan'
  )
  const canWrite = (ACCESS_WRITE_ENABLED || writeOptIn) && hasBridge

  /**
   * WHICH gate is shut, because they are shut for different reasons and only
   * one of them is the reader's to open.
   *
   * This panel used to say "not enabled in this build" for all three. That is
   * a dead end stated as a fact, and in the common case it was not even true:
   * `ACCESS_WRITE_ENABLED` is a ceiling the opt-in rises above, so an operator
   * who had simply never turned the switch on was told the release had decided
   * it for them — with no switch named and nothing to act on. That is the
   * difference between a screen that is off and a screen that is broken, and
   * it was reported as the second.
   */
  const gate: 'open' | 'opt-in' | 'bridge' | 'build' = canWrite
    ? 'open'
    : !hasBridge
      ? 'bridge'
      : ACCESS_WRITE_ENABLED
        ? 'build'
        : 'opt-in'

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
      title={t('operations.revoke.title')}
      about={<p>{t('operations.revoke.about')}</p>}
      /* Collecting from here, rather than sending the reader to another screen
         to do it. This panel acts on what the hourly key sweep has read, and a
         server it has not reached yet simply does not appear — so an estate
         with one host collected showed one host's keys and no way at all to
         get the other four, which reads as a screen that does not work. */
      actions={<CheckNowButton collects={t('operations.revoke.collects')} onCollected={load} />}
    >

      {/* Said once, before a target is chosen — because the point of saying it
          is that nobody plans around a capability this does not have. Both
          halves matter: that the write half is off, and what it will and will
          not be able to do when it is back. */}
      {gate !== 'open' && (
        <div className="panel-note is-unknown" data-testid="write-gated">
          <ShieldAlert size={12} />{' '}
          <b>
            {gate === 'bridge'
              ? ACCESS_WRITE_STALE_BRIDGE
              : gate === 'build'
                ? ACCESS_WRITE_DISABLED_SUMMARY
                : ACCESS_WRITE_OFF_SUMMARY}
          </b>
          {/* The switch, where the refusal is. Sending somebody to hunt for a
              setting they were not told the name of is what made this read as
              a dead end. */}
          {gate === 'opt-in' && (
            <button className="btn ghost sm revoke-gate-fix" onClick={() => openSettings('security')}>
              <Settings2 size={13} /> {t('operations.revoke.openSetting')}
            </button>
          )}
          {/* Folded, because the reasoning outweighed the data: seven hundred
              characters of justification sat above the keys this screen exists
              to show. What stays visible carries both operative facts — the
              write half is off, and nothing here writes anywhere — so a reader
              who never expands it is not misled.

              The reasoning is picked to match the gate, for the reason the
              summary is. Showing the build's justification to somebody whose
              own switch is off repeats the false claim one fold further down,
              where it is harder to catch. What that reader needs is the thing
              that is genuinely unproven — the dead-man's switch has not been
              watched firing on a real RHEL 9 host with KillUserProcesses=yes —
              because that is what they are accepting by turning it on. */}
          <NoteWhy summary={t('operations.revoke.whySummary')}>
            <p>{gate === 'opt-in' ? ACCESS_WRITE_OPT_IN_NOTE : ACCESS_WRITE_DISABLED_REASON}</p>
            <p>{ACCESS_WRITE_SCOPE}</p>
          </NoteWhy>
        </div>
      )}

      {keys.length === 0 ? (
        <div className="panel-empty">
          <p className="panel-empty-title">{t('operations.revoke.emptyTitle')}</p>
          <p className="panel-empty-body">
            <Trans i18nKey="operations.revoke.emptyBody" components={{ b: <b /> }} />
          </p>
          <div className="panel-empty-actions">
            <button className="btn ghost sm" onClick={() => openMonitor('access')}>
              {t('operations.revoke.openFleetKeys')}
            </button>
            <button className="btn ghost sm" onClick={() => openSettings('modules')}>
              {t('operations.chooseModules')}
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
              <ShieldAlert size={12} />{' '}
              {t('operations.revoke.unchecked', {
                count: unchecked.length,
                servers: unchecked.join(', ')
              })}
              <CheckNowButton collects={t('operations.revoke.collects')} onCollected={load} />
            </div>
          )}

          <div className="inv-scroll">
            <table className="table inv-table">
              <thead>
                <tr>
                  <th>{t('operations.revoke.col.fingerprint')}</th>
                  <th>{t('operations.revoke.col.labelled')}</th>
                  <th className="num">{t('operations.revoke.col.accounts')}</th>
                  <th>{t('operations.revoke.col.where')}</th>
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
                          title={t('operations.revoke.noLabelTitle')}
                        >
                          {t('operations.revoke.noLabel')}
                        </span>
                      ) : (
                        k.labels.join(' · ')
                      )}
                    </td>
                    <td className="num mono">{k.targets.length}</td>
                    <td className="faint">
                      {[...new Set(k.targets.map((x) => x.serverName))].join(', ')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {problem !== null && (
            <div className="s-desc warn" data-testid="access-problem">
              <b>{t('operations.revoke.nothingChanged')}</b> {problem}
            </div>
          )}

          {/* Offered, never taken automatically: revoking a key is a write with
              its own confirmed command, and main re-derives and refuses if the
              text differs. See the note on VaultLockedHosts. */}
          <VaultLockedHosts
            names={vaultLockedHosts}
            reason={t('operations.revoke.vaultReason')}
          />

          {pending !== null && (
            <div className="s-desc" data-testid="revoke-confirm">
              <b>
                {t('operations.revoke.confirmQuestion', {
                  fingerprint: pending.fingerprint,
                  count: pending.preview.hosts.length
                })}
              </b>{' '}
              {t('operations.revoke.confirmBody', { count: pending.preview.rollbackSeconds })}
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
                    {t('operations.revoke.leftOut', {
                      count: pending.preview.blocks.length + pending.preview.refusals.length
                    })}
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
                  <summary className="muted">{t('operations.revoke.whatWillRun')}</summary>
                  {/* Shown, and sent back with the run: main derives it again
                      and refuses to touch a host if the two differ. */}
                  <pre className="mono" style={{ whiteSpace: 'pre-wrap' }}>
                    {pending.preview.command || t('operations.revoke.nothingWillRun')}
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
                    {t(OUTCOME_LABEL[r.outcome])}
                  </span>{' '}
                  {r.detail}
                </div>
              ))}
              {result.notStaged.map((n) => (
                <div key={n.serverId} data-testid={`not-staged-${n.serverId}`} style={{ marginBottom: 6 }}>
                  <span className="chip loud">{t('operations.revoke.notStaged')}</span>{' '}
                  {t('operations.revoke.notStagedDetail', { server: n.serverName, detail: n.detail })}
                </div>
              ))}
              {result.reports.length === 0 && result.notStaged.length === 0 && (
                <span>{t('operations.revoke.nothingRan')}</span>
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
                ? t('operations.revoke.chooseKey')
                : t('operations.revoke.removesFrom', {
                    fingerprint: chosen.fingerprint,
                    count: chosen.targets.length,
                    servers: [...new Set(chosen.targets.map((x) => x.serverName))].join(', ')
                  })}
            </span>
            <span className="grow" />
            {pending !== null ? (
              <>
                <button className="btn ghost" disabled={running} onClick={() => setPending(null)}>
                  {t('common.cancel')}
                </button>
                <button
                  className="btn danger"
                  data-testid="revoke-go"
                  disabled={running || pending.preview.hosts.length === 0}
                  onClick={() => void run()}
                >
                  {t('operations.revoke.stage')}
                </button>
              </>
            ) : (
              <button
                className="btn danger"
                data-testid="revoke-plan"
                disabled={!canWrite || running || chosen === null}
                onClick={() => chosen && void plan(chosen.fingerprint)}
                /* Why it is greyed out, on the control that is greyed out. A
                   disabled button whose reason lives in a paragraph at the top
                   of the screen is one the reader concludes is broken — which
                   is what happened here. */
                title={
                  gate === 'opt-in'
                    ? t('operations.revoke.gateOptIn')
                    : gate === 'bridge'
                      ? t('operations.revoke.gateBridge')
                      : gate === 'build'
                        ? t('operations.revoke.gateBuild')
                        : chosen === null
                          ? t('operations.revoke.chooseKeyTitle')
                          : t('operations.revoke.planTitle')
                }
              >
                {t('operations.revoke.plan')}
              </button>
            )}
          </div>
        </>
      )}
    </PanelShell>
  )
}
