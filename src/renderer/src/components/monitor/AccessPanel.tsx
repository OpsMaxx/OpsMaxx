import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  accessCoverageCsv,
  accessExportCoverage,
  accessExportCsv,
  accessExportJson,
  buildAccessExport
} from '../../../../shared/accessExport'
import { KeyRound, ShieldAlert } from 'lucide-react'
import { CheckNowButton } from './CheckNowButton'
import { openKeyRevoke } from '../../store/nav'
import { useApp } from '../../store/app'
import { bridgeHas } from '../../lib/bridge'
import { collectNow } from '../../lib/collectNow'
import { clsx, duration } from '../../lib/format'
import {
  serviceAccountsWithKeys,
  staleAccounts,
  summariseStaleAccounts
} from '../../../../shared/staleAccounts'
import { sudoAcrossFiles } from '../../../../shared/sudoers'
import {
  ACCESS_STATUS_HELP,
  ACCESS_WRITE_ENABLED,
  KEY_PROBLEM_HELP,
  accessSource,
  summariseAccess,
  type AccessAccount,
  type AccessStatus,
  type HostAccess
} from '../../../../shared/access'
import type { Server } from '../../types'
import { NoteWhy, PanelShell } from './PanelShell'
import { SweepEmpty } from './SweepEmpty'
import { useT, t as currentT } from '../../lib/i18n'
import { Trans } from '../../lib/Trans'

// Fleet keys and access — roadmap item 23, renderer half.
//
// The question this exists to answer is "which of my hosts still trusts the
// laptop I sold", and the whole design follows from the fact that the answer
// has THREE parts, not two: the hosts that trust it, the hosts that do not, and
// the hosts nobody could check. The third list is the one every other tool
// leaves out, and leaving it out is what turns a security review into a
// reassuring fiction.
//
// So there is no cell in this panel that renders an unread host as a zero, an
// empty list or a dash, and the by-key view carries its "could not check" count
// in the same row as its "found on" count rather than in a footnote.
//
// It reads through the preload bridge directly rather than through the fleet
// store, and pulls rather than subscribes: `fleet.access()` is a read of what
// the background sweep already holds and never triggers a probe. There is
// exactly one thing deciding how often every home directory on every host gets
// stat'ed, and it is the sampler.

/** What one server's collection looks like from here, including the two states
 *  that are not a collection: never run, and failed. */
interface Entry {
  access?: HostAccess
  at?: number
  error?: string
  errorAt?: number
}

/**
 * One fingerprint, and everywhere it is — plus everywhere that could not be
 * checked, which is the same size of fact.
 */
interface KeyRow {
  fingerprint: string
  /** The comments the estate attaches to this key, which is how a person
   *  recognises it. More than one means different hosts label it differently. */
  labels: string[]
  type: string
  bits: number | null
  /** serverName → the accounts on that host that trust it. */
  on: { server: string; users: string[] }[]
  /** True when every appearance of this key carries a restricting option. A key
   *  that is `command=`-restricted on four hosts and unrestricted on a fifth is
   *  a different situation from one restricted everywhere. */
  restrictedEverywhere: boolean
  /** ANY appearance carries `cert-authority`. The opposite of restricted and
   *  reported on any appearance rather than all of them: one host delegating to
   *  a CA is the finding, whatever the other ten do. */
  authority: boolean
  /** ANY appearance is a certificate rather than a bare key. The fingerprint is
   *  the key inside it either way — which is why the same key shows one row
   *  here whether a host trusts it plainly or through a certificate. */
  viaCertificate: boolean
}

function statusChip(status: AccessStatus): React.JSX.Element | null {
  if (status === 'ok') return null
  return (
    <span
      className={clsx('inv-na', (status === 'denied' || status === 'unknown') && 'loud')}
      title={ACCESS_STATUS_HELP[status]}
    >
      {currentT(
        status === 'denied'
          ? 'monitor.access.status.denied'
          : status === 'absent'
            ? 'monitor.access.status.absent'
            : status === 'no-tool'
              ? 'monitor.access.status.noTool'
              : status === 'unsupported'
                ? 'monitor.access.status.unsupported'
                : status === 'partial'
                  ? 'monitor.access.status.partial'
                  : 'monitor.access.status.unknown'
      )}
    </span>
  )
}

/** One account's key count, or the reason there is not one. Never a zero for an
 *  account whose file was not read — that substitution is the whole failure
 *  this feature exists to avoid. */
function KeyCount({ account }: { account: AccessAccount }): React.JSX.Element {
  const t = useT()
  if (account.keys === null)
    return statusChip(account.keysStatus) ?? <span>{t('monitor.access.status.unknown')}</span>
  const usable = account.keys.filter((k) => k.problem === null).length
  const unreadable = account.keys.length - usable
  return (
    <span>
      <span className="mono">{usable}</span>
      {/* A zero that was CHECKED, and the chip says which kind of zero it is.
          The collector proves the home directory and .ssh can be traversed
          before it concludes the file is not there, so this is a finding and
          not a shrug — but "no key file at all" and "a key file with nothing
          in it" are different facts about an account and only one of them is a
          file somebody has been editing. */}
      {account.keysStatus === 'absent' && (
        <span className="chip" title={ACCESS_STATUS_HELP.absent}>
          {t('monitor.access.keyCount.noKeyFile')}
        </span>
      )}
      {unreadable > 0 && (
        <span
          className="chip warn"
          title={t('monitor.access.keyCount.unreadableTitle', { count: unreadable })}
        >
          {t('monitor.access.keyCount.unreadable', { count: unreadable })}
        </span>
      )}
      {account.keysUsedSudo && (
        <span className="chip" title={t('monitor.access.keyCount.rootTitle')}>
          root
        </span>
      )}
    </span>
  )
}

export function AccessPanel({
  servers,
  onOpen
}: {
  servers: Server[]
  onOpen?: (serverId: string) => void
}): React.JSX.Element {
  const t = useT()
  const [entries, setEntries] = useState<Record<string, Entry>>({})
  const [busy, setBusy] = useState(false)
  const [view, setView] = useState<'keys' | 'hosts'>('keys')
  /**
   * The review, as a file.
   *
   * EVERY server goes in, not just the ones that answered. A host missing from
   * an access review reads as a host nobody can reach, and `buildAccessExport`
   * gives an unread one a row saying otherwise.
   *
   * The coverage section is written into the SAME file rather than offered
   * separately: it is the part that says whether the rows are the whole story,
   * and a caveat in a second download is a caveat nobody has when they read the
   * first.
   */
  const exportReview = (format: 'csv' | 'json'): void => {
    const inputs = servers.map((s) => ({
      serverId: s.id,
      serverName: s.name,
      access: entries[s.id]?.access ?? null,
      error: entries[s.id]?.error ?? null
    }))
    const rows = buildAccessExport(inputs)
    const coverage = accessExportCoverage(inputs)
    const at = Date.now()
    const body =
      format === 'json'
        ? accessExportJson(rows, coverage, { generatedAt: at, since: null })
        : `${accessExportCsv(rows)}\n\n# coverage\n${accessCoverageCsv(coverage)}`
    const blob = new Blob([body], { type: format === 'json' ? 'application/json' : 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `access-review-${new Date(at).toISOString().slice(0, 10)}.${format}`
    a.click()
    URL.revokeObjectURL(url)
  }

  const load = useCallback(async (): Promise<void> => {
    if (!bridgeHas(window.opsmaxx?.fleet as Record<string, unknown> | undefined, 'access')) return
    const next: Record<string, Entry> = {}
    await Promise.all(
      servers.map(async (s) => {
        const r = await window.opsmaxx?.fleet?.access(s.id)
        if (r) next[s.id] = { access: r.access, at: r.at, error: r.error, errorAt: r.errorAt }
      })
    )
    setEntries(next)
  }, [servers])

  useEffect(() => {
    void load()
  }, [load])

  const refresh = async (): Promise<void> => {
    setBusy(true)
    try {
      // Collect, not just sweep: the key and access probe keeps its own hourly
      // clock, so a plain sweep re-read metrics and skipped this entirely.
      await collectNow()
      await load()
    } finally {
      setBusy(false)
    }
  }

  // Every host, sorted into the three buckets that matter. `incomplete` is not
  // a subset of `failed`: a host can answer perfectly and still have two home
  // directories this account cannot traverse, and that host's counts are a
  // lower bound exactly as a failed host's are.
  // 90 days by default. Short enough that a forgotten contractor's key shows
  // up inside a quarter, long enough that somebody who was on parental leave
  // does not.
  const [idleDays, setIdleDays] = useState(90)

  const hosts = useMemo(
    () =>
      servers.map((s) => {
        const e = entries[s.id]
        const summary = e?.access ? summariseAccess(e.access) : null
        return { server: s, entry: e, summary }
      }),
    [servers, entries]
  )

  // FOUR states, not three, and the fourth is the one the sampler goes out of
  // its way to make available. `fleetSampler.rememberAccess` keeps the last
  // good collection ALONGSIDE a live error — its own comment says why: "'read
  // an hour ago and the probe is failing now' is two facts and both matter —
  // most of all here." This used to keep only the first, so a host with a
  // three-week-old inventory and hourly failures ever since sat in `collected`,
  // contributed 0 to `unchecked`, and carried `certain: true` out of a
  // collection that was certain three weeks ago.
  //
  // `collected` still holds it, because the old inventory is the best
  // information anybody has about that host and hiding it helps nobody. What
  // changes is that it is never counted as an answered host.
  const collected = hosts.filter((h) => h.entry?.access)
  const stale = collected.filter((h) => h.entry?.error)
  const current = collected.filter((h) => !h.entry?.error)
  const failed = hosts.filter((h) => !h.entry?.access && h.entry?.error)
  const never = hosts.filter((h) => !h.entry?.access && !h.entry?.error)
  // Only over hosts that answered THIS time. A stale host is already counted
  // under `unchecked`, and counting it twice would put two numbers in the
  // banner for one machine.
  const incomplete = current.filter((h) => h.summary && !h.summary.certain)

  // Item 45. Which accounts still hold a working key that nobody has used.
  //
  // Over `collected` rather than `current`: a host whose last collection is
  // three weeks old still tells you something true about who had a key then,
  // and the banner above already says which hosts are stale. Dropping them here
  // would make this list quietly shrink as the estate got harder to read.
  const idleFindings = useMemo(
    () =>
      staleAccounts(
        collected.map((h) => ({
          serverId: h.server.id,
          serverName: h.server.name,
          accounts: h.entry!.access!.accounts
        })),
        idleDays
      ),
    [collected, idleDays]
  )
  const idleSummary = summariseStaleAccounts(idleFindings)

  // Item 46. A different question from the one above -- not "has anyone used
  // this key" but "should this account have one at all" -- so it is its own
  // list rather than a column on that one.
  const serviceKeys = useMemo(
    () =>
      serviceAccountsWithKeys(
        collected.map((h) => ({
          serverId: h.server.id,
          serverName: h.server.name,
          accounts: h.entry!.access!.accounts
        }))
      ),
    [collected]
  )

  /**
   * The by-key view. One row per distinct fingerprint across everything that
   * WAS read — and the header above it says how many hosts were not, because a
   * key absent from this table has not been shown to be absent from the estate.
   */
  const keyRows = useMemo((): KeyRow[] => {
    const by = new Map<string, KeyRow>()
    for (const h of collected) {
      for (const a of h.entry!.access!.accounts) {
        for (const k of a.keys ?? []) {
          if (k.fingerprint === null) continue
          const row = by.get(k.fingerprint) ?? {
            fingerprint: k.fingerprint,
            labels: [],
            type: k.type ?? 'unknown',
            bits: k.bits,
            on: [],
            restrictedEverywhere: true,
            authority: false,
            viaCertificate: false
          }
          if (k.comment && !row.labels.includes(k.comment)) row.labels.push(k.comment)
          if (!k.restricted) row.restrictedEverywhere = false
          if (k.broadened) row.authority = true
          if (k.certificate) row.viaCertificate = true
          const existing = row.on.find((o) => o.server === h.server.name)
          if (existing) {
            if (!existing.users.includes(a.user)) existing.users.push(a.user)
          } else row.on.push({ server: h.server.name, users: [a.user] })
          by.set(k.fingerprint, row)
        }
      }
    }
    // Most widespread first: a key on eleven hosts is the one worth looking at.
    return [...by.values()].sort(
      (a, b) => b.on.length - a.on.length || a.fingerprint.localeCompare(b.fingerprint)
    )
  }, [collected])

  const unchecked = failed.length + never.length + stale.length
  // Whether there is anywhere to POINT at, which is all this decides now that
  // the plan-and-apply flow lives in Operations › Revoke a key.
  //
  // Three things, and they fail for different reasons. The BUILD ceiling is a
  // decision about this release; the SETTING is the operator's, off unless they
  // turned it on; the bridge is a fact about this install. Main enforces the
  // first two again in both handlers, so this is the honest UI and not the
  // boundary — and the panel it points at re-states every one of them rather
  // than trusting that this one got it right.
  //
  // The pointer is hidden rather than shown-and-disabled when the write half is
  // off, and the notice below is what keeps that honest: it says the control
  // was WITHDRAWN, so nobody concludes the feature has not arrived.
  const writeOptIn = useApp((st) => st.settings.accessWriteEnabled)
  const canWrite =
    (ACCESS_WRITE_ENABLED || writeOptIn) &&
    bridgeHas(window.opsmaxx?.fleet as Record<string, unknown> | undefined, 'accessPlan')

  return (
    <PanelShell
      icon={<KeyRound size={14} />}
      title={t('monitor.access.title')}
      about={<p>{t('monitor.access.about')}</p>}
      actions={
        <>
          {collected.length > 0 && (
            <button className="btn ghost sm" onClick={() => setView(view === 'keys' ? 'hosts' : 'keys')}>
              {view === 'keys' ? t('monitor.access.view.byServer') : t('monitor.access.view.byKey')}
            </button>
          )}
          {/* Item 46's access review. Downloaded rather than shown: the thing
              somebody wants is a file to hand over, and rendering four thousand
              rows in a panel is not that. */}
          <button
            className="btn ghost sm"
            disabled={servers.length === 0}
            title={t('monitor.access.export.csvTitle')}
            onClick={() => exportReview('csv')}
          >
            {t('monitor.access.export.csv')}
          </button>
          <button
            className="btn ghost sm"
            disabled={servers.length === 0}
            title={t('monitor.access.export.jsonTitle')}
            onClick={() => exportReview('json')}
          >
            {t('monitor.access.export.json')}
          </button>
          {/* Ghost while there are keys on screen, solid while there are not —
              the same rule Inventory and Security posture follow. At most one
              accent control per view, and only where pressing it is the task.

              CheckNowButton rather than a button calling refresh(): refresh()
              re-reads the CACHE, which is why this control appeared to do
              nothing. Keys sit behind an hourly schedule, so a sweep that did
              not clear it skipped the very data this panel shows. */}
          <CheckNowButton
            primary={collected.length === 0}
            disabled={servers.length === 0}
            collects={t('monitor.access.checkNowCollects')}
            serverIds={servers.map((sv) => sv.id)}
            onCollected={refresh}
          />
        </>
      }
    >
      {collected.length > 0 && (
        <div className="list-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 4 }}>
          <div className="cron-row">
            <span className="r-title">{t('monitor.access.idle.title')}</span>
            <span className="grow" />
            <label className="r-sub faint">
              {t('monitor.access.idle.label')}{' '}
              <select
                className="input sm"
                aria-label={t('monitor.access.idle.thresholdAria')}
                value={idleDays}
                onChange={(e) => setIdleDays(Number(e.target.value))}
              >
                <option value={30}>{t('monitor.access.idle.days', { count: 30 })}</option>
                <option value={90}>{t('monitor.access.idle.days', { count: 90 })}</option>
                <option value={180}>{t('monitor.access.idle.days', { count: 180 })}</option>
                <option value={365}>{t('monitor.access.idle.year')}</option>
              </select>
            </label>
          </div>
          {/* The unknowns are IN the headline, not filtered out of it. A count
              that shrinks as the estate gets harder to read is the wrong
              direction for a number somebody uses to decide they are done. */}
          <div className="r-sub">{idleSummary.headline}</div>
          {idleFindings.filter((f) => f.verdict !== 'active').length > 0 && (
            <table className="mini-table">
              <tbody>
                {idleFindings
                  .filter((f) => f.verdict !== 'active')
                  .map((f) => (
                    <tr key={`${f.serverId}:${f.user}`}>
                      <td className="mono">{f.user}</td>
                      <td className="faint">{f.serverName}</td>
                      <td className={clsx(f.verdict === 'unknown' ? 'state-unknown' : 'warn')}>
                        {f.verdict === 'never-used'
                          ? t('monitor.access.idle.neverUsed')
                          : f.verdict === 'stale'
                            ? t('monitor.access.idle.daysIdle', { count: f.daysSinceLogin ?? '' })
                            : t('monitor.access.idle.couldNotTell')}
                      </td>
                      <td className="faint">{f.because}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          )}
          {/* Revoking is item 36's, behind its own gate and its own rollback.
              A button here would act through a path that has neither. */}
          <div className="r-sub faint">{t('monitor.access.idle.readOnly')}</div>
        </div>
      )}

      {/* Item 36b. THREE states, and the type exists to keep them apart:
          `undefined` is nobody consented, `null` is the read failed, and an
          array is an answer. Rendering all three the same would be the whole
          point of the feature lost. */}
      {collected.some((h) => h.entry!.access!.sudoers !== undefined) && (
        <div className="list-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 4 }}>
          <div className="r-title">{t('monitor.access.sudo.title')}</div>
          <div className="r-sub faint">
            <Trans i18nKey="monitor.access.sudo.desc" components={{ code: <code /> }} />
          </div>
          <table className="mini-table">
            <tbody>
              {collected
                .filter((h) => h.entry!.access!.sudoers !== undefined)
                .flatMap((h) => {
                  const files = h.entry!.access!.sudoers
                  if (files === null) {
                    return [
                      <tr key={`${h.server.id}:failed`}>
                        <td className="mono">{h.server.name}</td>
                        <td className="state-unknown">{t('monitor.access.sudo.unreadable')}</td>
                        <td className="faint">{t('monitor.access.sudo.unreadableDetail')}</td>
                      </tr>
                    ]
                  }
                  return h.entry!.access!.accounts.map((a) => {
                    const r = sudoAcrossFiles(a.user, a.adminGroups ?? [], files ?? [])
                    if (r.findings.length === 0 && r.unreadable.length === 0) return null
                    return (
                      <tr key={`${h.server.id}:${a.user}`}>
                        <td className="mono">{a.user}</td>
                        <td className="faint">{h.server.name}</td>
                        <td className={clsx(r.findings.some((f) => f.grantsAll && f.noPassword === 'all') && 'warn')}>
                          {r.sentence}
                        </td>
                      </tr>
                    )
                  }).filter(Boolean)
                })}
            </tbody>
          </table>
        </div>
      )}

      {serviceKeys.length > 0 && (
        <div className="list-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 4 }}>
          <div className="r-title">{t('monitor.access.service.title')}</div>
          <div className="r-sub faint">{t('monitor.access.service.desc')}</div>
          <table className="mini-table">
            <tbody>
              {serviceKeys.map((f) => (
                <tr key={`${f.serverId}:${f.user}`}>
                  <td className="mono">{f.user}</td>
                  <td className="faint">{f.serverName}</td>
                  <td className={clsx(f.loginDisabled === false ? 'warn' : 'faint')}>
                    {f.loginDisabled === false
                      ? t('monitor.access.service.canLogIn')
                      : f.loginDisabled === true
                        ? t('monitor.access.service.shellRefuses')
                        : t('monitor.access.service.shellUnknown')}
                  </td>
                  <td className="faint">{f.because}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Said once, at the top, before a target is chosen — because the point
          of saying it is that nobody plans around a capability this does not
          have. Both halves matter: that the write half is off, and what it will
          and will not be able to do when it is back. */}
      {!canWrite && (
        <div className="panel-note is-unknown" data-testid="write-gated">
          {/* Folded behind NoteWhy — the same primitive PatchPanel already
              uses — because the reasoning outweighed the data: seven hundred
              characters of justification sat above the keys this screen
              exists to show. What stays visible carries both operative facts,
              that the write half is off and that nothing here writes
              anywhere, so a reader who never expands it is not misled. */}
          <ShieldAlert size={12} /> <b>{t('shared.access.write.disabledSummary')}</b>
          <NoteWhy summary={t('monitor.access.writeGated.why')}>
            <p>{t('shared.access.write.disabledReason')}</p>
            <p>{t('shared.access.write.scope')}</p>
          </NoteWhy>
        </div>
      )}

      {collected.length === 0 ? (
        <SweepEmpty
          subject={t('monitor.access.empty.subject')}
          busy={busy}
          onCheckNow={() => void refresh()}
          note={
            <>
              {/* Stays on the page rather than moving behind the ⓘ. PanelShell's
                  header draws that line: `about` is what a panel is for, and a
                  standing promise about what the probe does to a host is not a
                  description you read once. Shortened from three sentences to
                  one — the wall of text was the complaint, not this clause. */}
              {t('monitor.access.empty.note')}
              {failed.length > 0 && (
                <>
                  {' '}
                  <Trans
                    i18nKey="monitor.access.empty.refused"
                    values={{ count: failed.length }}
                    components={{ b: <b /> }}
                  />
                </>
              )}
            </>
          }
        />
      ) : (
        <>
          {/* The headline, and the reason the second half of the sentence is
              never optional. "37 keys across 12 hosts" on an estate where 3
              hosts could not be read is a count over 9 hosts wearing the label
              of a count over 12. */}
          <div className="panel-stats">
            <span>
              {collected.length === 1
                ? t('monitor.access.stats.keysOnOneServer', { count: keyRows.length })
                : t('monitor.access.stats.keysOnServers', {
                    count: keyRows.length,
                    servers: collected.length
                  })}
            </span>
            {unchecked > 0 && (
              <span className="state-unknown" data-testid="unchecked-hosts">
                {t('monitor.access.stats.unchecked', { count: unchecked })}
              </span>
            )}
            {incomplete.length > 0 && (
              <span className="state-unknown" data-testid="incomplete-hosts">
                {t('monitor.access.stats.incomplete', { count: incomplete.length })}
              </span>
            )}
          </div>

          {/* The sentence that must exist before anyone concludes anything.
              Rendered whenever any host is unchecked or incomplete, and it says
              explicitly what may NOT be concluded — not merely that some data
              is missing. */}
          {(unchecked > 0 || incomplete.length > 0) && (
            <div className="panel-note is-unknown" data-testid="not-an-answer">
              <ShieldAlert size={12} /> {t('monitor.access.notAnswer.lead')}{' '}
              {(() => {
                const unread =
                  stale.length > 0
                    ? t('monitor.access.notAnswer.unreadStale', { count: unchecked, stale: stale.length })
                    : t('monitor.access.notAnswer.unread', { count: unchecked })
                const partial = t('monitor.access.notAnswer.partial', { count: incomplete.length })
                return unchecked > 0 && incomplete.length > 0
                  ? t('monitor.access.notAnswer.tailBoth', { unread, partial })
                  : t('monitor.access.notAnswer.tailOne', { clause: unchecked > 0 ? unread : partial })
              })()}
            </div>
          )}

          {view === 'keys' ? (
            <div className="inv-scroll">
              <table className="table inv-table">
                <thead>
                  <tr>
                    <th>{t('monitor.access.keys.colFingerprint')}</th>
                    <th>{t('monitor.access.keys.colLabelled')}</th>
                    <th>{t('monitor.access.keys.colType')}</th>
                    <th className="num">{t('monitor.access.keys.colHosts')}</th>
                    <th>{t('monitor.access.keys.colWhere')}</th>
                    {canWrite && <th />}
                  </tr>
                </thead>
                <tbody>
                  {keyRows.map((k) => (
                    <tr key={k.fingerprint} data-fingerprint={k.fingerprint}>
                      <td className="mono">
                        {k.fingerprint}
                      </td>
                      <td>
                        {k.labels.length === 0 ? (
                          <span
                            className="inv-na"
                            title={t('monitor.access.keys.noLabelTitle')}
                          >
                            {t('monitor.access.keys.noLabel')}
                          </span>
                        ) : (
                          // The most attacker-controlled string in this whole
                          // feature: it is free text in a file on a host that
                          // may already be compromised. It arrives stripped of
                          // control characters and bidi overrides and capped
                          // (see shared/access.ts), and it is rendered as text
                          // in a cell — never as a title, a link or markup.
                          k.labels.join(' · ')
                        )}
                      </td>
                      <td className="mono">
                        {k.type}
                        {k.bits !== null && ` ${k.bits}`}
                        {k.restrictedEverywhere && (
                          <span
                            className="chip"
                            title={t('monitor.access.keys.restrictedTitle')}
                          >
                            {t('monitor.access.keys.restricted')}
                          </span>
                        )}
                        {k.viaCertificate && (
                          <span
                            className="chip"
                            title={t('monitor.access.keys.certificateTitle')}
                          >
                            {t('monitor.access.keys.certificate')}
                          </span>
                        )}
                        {/* The loudest thing on this table, and it is not a
                            restriction. A cert-authority line means the host
                            accepts everything this signer will ever sign,
                            including keys that do not exist yet. */}
                        {k.authority && (
                          <span
                            className="chip warn"
                            data-testid={`ca-${k.fingerprint}`}
                            title={t('monitor.access.keys.authorityTitle')}
                          >
                            {t('monitor.access.keys.authority')}
                          </span>
                        )}
                      </td>
                      <td className="num mono">{k.on.length}</td>
                      <td>
                        {k.on.map((o) => (
                          <span key={o.server} style={{ marginRight: 8 }}>
                            {onOpen ? (
                              <button
                                className="inv-host"
                                onClick={() => {
                                  const s = servers.find((x) => x.name === o.server)
                                  if (s) onOpen(s.id)
                                }}
                              >
                                {o.server}
                              </button>
                            ) : (
                              <span>{o.server}</span>
                            )}
                            <span className="faint mono">
                              {' '}
                              {o.users.join(', ')}
                            </span>
                          </span>
                        ))}
                      </td>
                      {/* A POINTER, not the plan-and-apply flow that used to
                          live in this cell. It carries the fingerprint the
                          operator is looking at, and lands before the plan,
                          the confirmation and the staged write — so arriving
                          with an intention skips no question, exactly as
                          `openServiceJob` decided for the job composer. */}
                      {canWrite && (
                        <td>
                          <button
                            className="btn ghost sm"
                            data-testid={`revoke-${k.fingerprint}`}
                            onClick={() => openKeyRevoke(k.fingerprint)}
                            title={t('monitor.access.keys.revokeTitle')}
                          >
                            {t('monitor.access.keys.revoke')}
                          </button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="inv-scroll">
              <table className="table inv-table">
                <thead>
                  <tr>
                    <th>{t('monitor.access.hosts.colHost')}</th>
                    <th>{t('monitor.access.hosts.colAccount')}</th>
                    <th className="num">{t('monitor.access.hosts.colKeys')}</th>
                    <th>{t('monitor.access.hosts.colPassword')}</th>
                    <th>{t('monitor.access.hosts.colAdminGroups')}</th>
                    <th>{t('monitor.access.hosts.colLastLogin')}</th>
                  </tr>
                </thead>
                <tbody>
                  {collected.flatMap((h) =>
                    h.entry!.access!.accounts.map((a) => (
                      <tr key={`${h.server.id}:${a.user}`} data-host={h.server.name} data-user={a.user}>
                        <td>{h.server.name}</td>
                        <td className="mono">
                          {a.user}
                          {a.hasLegacyKeyFile === true && (
                            <span
                              className="chip warn"
                              title={t('monitor.access.hosts.keys2Title')}
                            >
                              authorized_keys2
                            </span>
                          )}
                          {/* Not the same chip and not no chip. "Could not
                              look" is the state a key sshd reads and this does
                              not would hide in. */}
                          {a.hasLegacyKeyFile === null && (
                            <span
                              className="inv-na loud"
                              data-testid={`keys2-unknown-${a.user}`}
                              title={t('monitor.access.hosts.keys2UncheckedTitle')}
                            >
                              {t('monitor.access.hosts.keys2Unchecked')}
                            </span>
                          )}
                        </td>
                        <td className="num">
                          <KeyCount account={a} />
                        </td>
                        <td>
                          {a.passwordLocked === null ? (
                            statusChip(a.accountStatus)
                          ) : a.passwordLocked ? (
                            // The trap this column exists to defuse. `passwd -l`
                            // defeats password authentication and has NO effect
                            // on public-key authentication, so "locked" next to
                            // a live key is not a safe combination — it is the
                            // exact combination an access review is looking for.
                            <span
                              className={clsx('chip', (a.keys?.length ?? 0) > 0 && 'warn')}
                              title={
                                (a.keys?.length ?? 0) > 0
                                  ? t('monitor.access.hosts.lockedWithKeysTitle')
                                  : t('monitor.access.hosts.lockedTitle')
                              }
                            >
                              {t('monitor.access.hosts.locked')}
                            </span>
                          ) : (
                            <span className="faint">{t('monitor.access.hosts.usable')}</span>
                          )}
                          {a.expired === true && (
                            <span className="chip warn" title={a.expiresText ?? undefined}>
                              {t('monitor.access.hosts.expired')}
                            </span>
                          )}
                        </td>
                        <td>
                          {a.adminGroups === null ? (
                            statusChip('unknown')
                          ) : a.adminGroups.length === 0 ? (
                            <span className="faint">{t('monitor.access.hosts.noAdminGroups')}</span>
                          ) : (
                            <span
                              className="mono"
                              title={t('monitor.access.hosts.adminGroupsTitle')}
                            >
                              {a.adminGroups.join(', ')}
                            </span>
                          )}
                        </td>
                        <td className="faint">
                          {a.neverLoggedIn ? (
                            t('monitor.access.hosts.neverLoggedIn')
                          ) : a.lastLoginAt !== null ? (
                            new Date(a.lastLoginAt).toLocaleString()
                          ) : a.lastLoginText !== null ? (
                            // Kept as the host's own phrase when it could not be
                            // turned into an instant. "We cannot make a date out
                            // of this" is not "we do not know when they logged
                            // in", and showing the phrase is the better of the
                            // two answers.
                            <span title={t('monitor.access.hosts.lastLoginTextTitle')}>
                              {a.lastLoginText}
                            </span>
                          ) : (
                            statusChip(accessSource(h.entry!.access!, 'last-login').status)
                          )}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          )}

          {/* Why each partly-read host is partly read, in its own words. Kept
              below the tables rather than in a tooltip: it is the list of
              machines somebody has to go and check by hand. */}
          {incomplete.map((h) => (
            <div key={h.server.id} className="panel-note is-unknown" data-testid={`incomplete-${h.server.name}`}>
              <Trans
                i18nKey="monitor.access.incompleteNote"
                values={{ server: h.server.name, reasons: h.summary!.uncertainty.join('; ') }}
                components={{ b: <b /> }}
              />
            </div>
          ))}
        </>
      )}

      {/* Two facts on one line, because both matter and neither replaces the
          other: what was read, and how long ago it stopped being confirmable.
          The age is the age of the READING — that is the number that decides
          whether to act on what is on the screen. */}
      {stale.map((h) => (
        <div key={h.server.id} className="panel-note is-unknown" data-testid={`stale-${h.server.name}`}>
          <ShieldAlert size={12} />{' '}
          <Trans
            i18nKey="monitor.access.staleNote"
            values={{
              server: h.server.name,
              age: duration(h.entry!.at ?? null),
              error: h.entry!.error ?? ''
            }}
            components={{ b: <b /> }}
          />
        </div>
      ))}

      {failed.map((h) => (
        <div key={h.server.id} className="panel-note is-alarm" data-testid={`failed-${h.server.name}`}>
          {t('monitor.access.failedNote', { server: h.server.name, error: h.entry!.error ?? '' })}
        </div>
      ))}
      {collected.length > 0 && never.length > 0 && (
        <div className="panel-note is-unknown" data-testid="never-collected">
          {t('monitor.access.neverNote', {
            count: never.length,
            names: never.map((h) => h.server.name).join(', ')
          })}
        </div>
      )}

      {/* The vocabulary, stated once. Every problem word above links back to
          here rather than to a shrug. */}
      {collected.some((h) =>
        h.entry!.access!.accounts.some((a) => a.keys?.some((k) => k.problem !== null))
      ) && (
        <div className="panel-note" data-testid="problem-help">
          {t('monitor.access.problemHelp')}{' '}
          {KEY_PROBLEM_HELP['unknown-type']}
        </div>
      )}
    </PanelShell>
  )
}
