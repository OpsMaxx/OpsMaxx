import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { RefreshCw, ShieldAlert, ShieldQuestion } from 'lucide-react'
import { bridgeHas } from '../../lib/bridge'
import { collectNow } from '../../lib/collectNow'
import { SweepProgress } from './SweepProgress'
import { clsx, duration } from '../../lib/format'
import {
  CERT_EXPIRY_DAYS,
  FIREWALL_RULES_HOST_REPORTED_NOTE,
  OOM_WINDOW_HOURS,
  POSTURE_SOURCE_IDS,
  POSTURE_STATUS_HELP,
  SSHD_DIRECTIVES,
  isCertificateExpiringSoon,
  oomWindowIsStated,
  postureSource,
  securityUpdateReading,
  soonestCertificateExpiry,
  summarisePosture,
  type HostPosture,
  type PostureStatus,
  type SshdReading
} from '../../../../shared/posture'
import { FACT_STATUS_HELP, type HostFacts } from '../../../../shared/hostFacts'
import type { Server } from '../../types'
import { NoteWhy, PanelShell } from './PanelShell'
import { SweepEmpty } from './SweepEmpty'
import { t as tr, useT } from '../../lib/i18n'
import { Trans } from '../../lib/Trans'
import type { MessageKey } from '../../../../shared/i18n'

// Security posture — roadmap item 24, renderer half.
//
// The question is "which of my hosts is exposed", and the whole design follows
// from the fact that the answer has THREE parts and not two: the hosts that are
// fine, the hosts that are not, and the hosts nobody could check. The third
// list is the one every other tool leaves out, and leaving it out is what turns
// a security review into a reassuring fiction.
//
// So there is NO CELL in this panel that renders an unread host as a zero, a
// dash, a blank or a tick. Every gap prints the reason in words, with the
// status's own sentence on hover. The one rule that governs every line below:
//
//   A CHECK THAT COULD NOT RUN IS NOT A CHECK THAT PASSED.
//
// src/shared/posture.ts goes to real trouble to keep `denied`, `absent`,
// `no-tool`, `unsupported`, `partial` and "never collected" apart on the way
// in. All of it is thrown away by one `?? '—'` in a renderer, which is exactly
// what tests/posturePanel.test.tsx exists to notice.
//
// It reads through the preload bridge directly rather than through the fleet
// store, and pulls rather than subscribes, for the reason AccessPanel gives:
// `fleet.posture()` is a read of what the background sweep already holds and
// never triggers a probe. There is exactly one thing deciding how often every
// host gets asked for its firewall ruleset, and it is the sampler.
//
// There are no buttons here that change anything, and that is deliberate
// rather than unfinished — src/shared/posture.ts states the refusal in full.
// `ufw enable`, `setenforce` and an sshd_config edit can each lock the operator
// out of the host they would use to undo them, with none of the staged write,
// independent re-authentication and automatic revert that earn the key-change
// button in AccessPanel its place.

/** What one server's collection looks like from here, including the two states
 *  that are not a collection: never run, and failed. */
interface Entry {
  posture?: HostPosture
  at?: number
  error?: string
  errorAt?: number
}

/** One cell: either a value, or the reason there is not one. Never both, and
 *  never neither. */
interface Cell {
  text: string
  /** Null means this is a real value. Anything else is a gap, and `text` is
   *  the words for it. */
  gap: PostureStatus | null
  help: string
  /** Louder than the rest: something was read and it is bad. */
  bad?: boolean
}

// THREE TIERS, AND A READER HAS TO BE ABLE TO TELL THEM APART AT A GLANCE.
//
// Every gap used to wear the same italic phrase, and "not collected" — a host
// nobody has swept yet — was drawn in the same amber as "not permitted". So a
// screen where nothing had happened yet looked exactly like a screen where
// seven checks had been refused, and both looked like the operator had
// forgotten to configure something. The tiers now are:
//
//   we asked and got an answer    upright body text (`none found` is one of
//                                 these; it is an ANSWER, not a shrug)
//   we asked and could not read   italic, amber — denied and unknown
//   the host has nothing to ask   italic, faint — absent, no-tool, unsupported
//
// The fourth state — nobody has asked yet — is no longer a cell at all. It is
// a whole-row sentence, because it is one fact about the host and not seven
// findings about its checks. See `NotReadRow`.
//
// None of this softens the rule at the top of the file: not one of the three
// tiers renders as a pass.

/** `denied` and `unknown` are the two an operator can usually do something
 *  about, so they are the ones drawn loudly. `absent`, `no-tool` and
 *  `unsupported` are facts about the host rather than gaps in the reading. */
const loudGap = (gap: Cell['gap']): boolean => gap === 'denied' || gap === 'unknown'

// Each of these says what HAPPENED, not just that something is missing. "asked,
// refused" cannot be misread as "nobody looked", and "this server cannot
// answer" cannot be misread as "you have not set this up".
const gapWords: Record<PostureStatus, MessageKey> = {
  ok: 'monitor.posture.gap.ok',
  partial: 'monitor.posture.gap.partial',
  absent: 'monitor.posture.gap.absent',
  denied: 'monitor.posture.gap.denied',
  'no-tool': 'monitor.posture.gap.noTool',
  unsupported: 'monitor.posture.gap.unsupported',
  unknown: 'monitor.posture.gap.unknown'
}

function gapCell(status: PostureStatus, detail?: string): Cell {
  return {
    text: tr(gapWords[status]),
    gap: status,
    help: detail ? `${POSTURE_STATUS_HELP[status]} — ${detail}` : POSTURE_STATUS_HELP[status]
  }
}

function firewallCell(posture: HostPosture): Cell {
  const s = postureSource(posture, 'firewall')
  const fw = posture.firewall
  if (fw === null || s.status === 'denied' || s.status === 'unknown') return gapCell(s.status, s.detail)

  const tool = fw.tool ?? tr('monitor.posture.fw.kernelFilter')
  // The number of rules is the finding, and it only means anything when it was
  // actually read. `rules: null` next to `active: true` is a partial reading —
  // ufw.conf says the thing is switched on and says nothing about what it lets
  // through — and it must not render as a firewall with no rules.
  const rules = fw.rules ?? fw.backend.rules
  if (fw.active === false && (fw.backend.rules ?? 0) === 0 && fw.backend.status === 'ok') {
    return {
      text: tr('monitor.posture.fw.inactive', { tool }),
      gap: null,
      bad: true,
      help: tr('monitor.posture.fw.inactiveHelp', { tool })
    }
  }
  if (rules === null) {
    return {
      text:
        fw.active === true
          ? tr('monitor.posture.fw.onNotRead', { tool })
          : tr('monitor.posture.fw.nothingRead', { tool }),
      gap: s.status === 'ok' ? 'partial' : s.status,
      help: `${POSTURE_STATUS_HELP[s.status === 'ok' ? 'partial' : s.status]}${s.detail ? ` — ${s.detail}` : ''}`
    }
  }
  const words =
    tr('monitor.posture.fw.rules', { tool, count: rules }) +
    (fw.policyIn ? tr('monitor.posture.fw.policyIn', { policy: fw.policyIn }) : '')
  const backend =
    fw.backend.tool && fw.backend.tool !== fw.tool
      ? fw.backend.rules === null
        ? tr('monitor.posture.fw.backendUnread', { backend: fw.backend.tool })
        : tr('monitor.posture.fw.backendRules', { backend: fw.backend.tool, count: fw.backend.rules })
      : ''
  return {
    text: words,
    gap: null,
    bad: rules === 0,
    help:
      rules === 0
        ? tr('monitor.posture.fw.noRulesHelp', { tool })
        : tr('monitor.posture.fw.readFrom', { tool }) + backend
  }
}

function macCell(posture: HostPosture): Cell {
  const s = postureSource(posture, 'mandatory-access')
  const mac = posture.mandatoryAccess
  if (s.status === 'absent') {
    return {
      text: tr('monitor.posture.mac.none'),
      gap: null,
      help: tr('monitor.posture.mac.noneHelp')
    }
  }
  if (mac === null || s.status === 'denied' || s.status === 'unknown') return gapCell(s.status, s.detail)

  if (mac.system === 'selinux') {
    if (mac.mode === null) return gapCell(s.status === 'ok' ? 'unknown' : s.status, s.detail)
    const drift =
      mac.bootMode !== null && mac.bootMode !== mac.mode
        ? tr('monitor.posture.mac.reverts', { mode: mac.bootMode })
        : ''
    return {
      text: tr('monitor.posture.mac.selinux', { mode: mac.mode }) + drift,
      gap: null,
      bad: mac.mode !== 'enforcing',
      help:
        drift === ''
          ? tr('monitor.posture.mac.selinuxHelp', { mode: mac.mode })
          : tr('monitor.posture.mac.selinuxDriftHelp', {
              mode: mac.mode,
              bootMode: mac.bootMode ?? ''
            })
    }
  }
  // AppArmor has no global mode. "Enforcing" here means enabled with nothing in
  // complain mode, and a profile list that was refused is UNKNOWN rather than
  // enforcing — complain-mode profiles are exactly what the refused list would
  // have shown.
  if (mac.enabled !== true) {
    return mac.enabled === false
      ? {
          text: tr('monitor.posture.mac.apparmorDisabled'),
          gap: null,
          bad: true,
          help: tr('monitor.posture.mac.apparmorDisabledHelp')
        }
      : gapCell(s.status === 'ok' ? 'unknown' : s.status, s.detail)
  }
  if (mac.profiles === null) {
    return {
      text: tr('monitor.posture.mac.apparmorNotRead'),
      gap: 'partial',
      help: tr('monitor.posture.mac.apparmorNotReadHelp', { help: POSTURE_STATUS_HELP.partial })
    }
  }
  return {
    text:
      tr('monitor.posture.mac.profiles', { count: mac.profiles }) +
      (mac.complain ? tr('monitor.posture.mac.complaining', { count: mac.complain }) : ''),
    gap: null,
    bad: (mac.complain ?? 0) > 0,
    help: tr('monitor.posture.mac.profilesHelp', {
      profiles: mac.profiles,
      complain: mac.complain ?? 0
    })
  }
}

function sshdCell(posture: HostPosture): Cell {
  const s = postureSource(posture, 'sshd-hardening')
  const sshd = posture.sshd
  if (sshd === null) return gapCell(s.status, s.detail)
  const weak = sshd.readings.filter((r) => r.verdict === 'weak')
  const unread = sshd.readings.filter((r) => r.verdict === 'unknown')
  if (weak.length > 0) {
    return {
      text: tr('monitor.posture.sshd.weak', {
        count: weak.length,
        directives: weak.map((r) => r.directive).join(', ')
      }),
      gap: null,
      bad: true,
      help: weak.map((r) => `${r.directive}: ${r.detail}`).join(' ')
    }
  }
  // NO WEAK DIRECTIVES IS NOT "HARDENED" WHEN MOST OF THEM WERE NOT READ. This
  // is the single most important branch in the file: a host whose sshd_config
  // could not be read has zero weak directives and zero good ones, and the
  // naive summary of that is a clean bill of health.
  if (unread.length === sshd.readings.length) return gapCell(s.status === 'ok' ? 'unknown' : s.status, s.detail)
  return {
    text:
      unread.length > 0
        ? tr('monitor.posture.sshd.nothingWeakUnread', { count: unread.length })
        : tr('monitor.posture.sshd.nothingWeak'),
    gap: unread.length > 0 ? 'partial' : null,
    help:
      unread.length > 0
        ? tr(sshd.effective ? 'monitor.posture.sshd.partialHelp' : 'monitor.posture.sshd.partialHelpFiles', {
            read: sshd.readings.length - unread.length,
            total: sshd.readings.length,
            unread: unread.length
          })
        : tr('monitor.posture.sshd.cleanHelp')
  }
}

function failedCell(posture: HostPosture): Cell {
  const s = postureSource(posture, 'failed-logins')
  const fl = posture.failedLogins
  if (fl === null || fl.count === null) return gapCell(s.status, s.detail)
  return {
    text:
      fl.users === null
        ? String(fl.count)
        : tr('monitor.posture.failed.withNames', { attempts: fl.count, count: fl.users }),
    gap: null,
    bad: fl.count > 100,
    help: tr(fl.users === null ? 'monitor.posture.failed.help' : 'monitor.posture.failed.helpNamed', {
      count: fl.count,
      users: fl.users ?? 0,
      source: fl.tool === 'lastb' ? 'lastb' : tr('monitor.posture.failed.journal'),
      window: fl.window ? ` (${fl.window})` : ''
    })
  }
}


function oomCell(posture: HostPosture): Cell {
  const s = postureSource(posture, 'oom-kills')
  const k = posture.oomKills
  if (k === null || k.count === null) return gapCell(s.status, s.detail)
  if (k.count > 0) {
    const procs =
      k.processes === null ? '' : tr('monitor.posture.oom.names', { count: k.processes })
    return {
      text: tr('monitor.posture.oom.killed', { count: k.count }) + procs,
      gap: null,
      bad: true,
      help: tr(k.processes === null ? 'monitor.posture.oom.help' : 'monitor.posture.oom.helpNamed', {
        count: k.count,
        names:
          k.processes === null ? '' : tr('monitor.posture.oom.distinctNames', { count: k.processes }),
        source: k.window ?? tr('monitor.posture.oom.kernelLog')
      })
    }
  }
  // ZERO, AND THE WINDOW DECIDES WHETHER THAT IS A FINDING. Only the journal
  // is asked for a period of time; a ring buffer holds as much as it holds, so
  // a zero out of it is not a statement about a day and must not be drawn like
  // one. This is the single branch item 19b deferred this kind over.
  if (oomWindowIsStated(k.source)) {
    return {
      text: tr('monitor.posture.oom.noneIn', { hours: OOM_WINDOW_HOURS }),
      gap: null,
      help: tr('monitor.posture.oom.noneInHelp', { hours: OOM_WINDOW_HOURS })
    }
  }
  return {
    text: tr('monitor.posture.oom.unbounded'),
    gap: 'partial',
    help: tr('monitor.posture.oom.unboundedHelp', {
      help: POSTURE_STATUS_HELP.partial,
      source: k.window ?? tr('monitor.posture.oom.noWindowSource')
    })
  }
}

function certCell(posture: HostPosture): Cell {
  const s = postureSource(posture, 'certificates')
  const inv = posture.certificates
  if (inv === null) return gapCell(s.status, s.detail)
  const days = soonestCertificateExpiry(inv)
  const unread = inv.certificates.filter((c) => c.problem !== null).length
  const bound = tr('monitor.posture.cert.bound', {
    roots: inv.bound.roots.join(', '),
    depth: inv.bound.maxDepth,
    files: inv.bound.maxFiles
  })

  if (days === null) {
    // NOTHING WAS DATED, and the three reasons are not the same finding.
    if (inv.unreadableRoots > 0) {
      return {
        text: tr('monitor.posture.cert.dirsRefused', { count: inv.unreadableRoots }),
        gap: s.status === 'ok' ? 'denied' : s.status,
        help: tr('monitor.posture.cert.dirsRefusedHelp', { bound })
      }
    }
    if (unread > 0) {
      return {
        text: tr('monitor.posture.cert.unread', { count: unread }),
        gap: 'partial',
        help: tr('monitor.posture.cert.unreadHelp', { count: unread, bound })
      }
    }
    return {
      text:
        s.status === 'absent'
          ? tr('monitor.posture.cert.noDirs')
          : tr('monitor.posture.cert.noneFound'),
      gap: null,
      help:
        s.status === 'absent'
          ? tr('monitor.posture.cert.noDirsHelp', { bound })
          : tr('monitor.posture.cert.noneFoundHelp', { bound })
    }
  }

  // Something WAS dated, and something else may still be missing. The suffix is
  // not decoration: "45 days" beside a silently skipped /etc/letsencrypt is
  // worse than no number at all.
  const missing = inv.unreadableRoots + unread + (inv.truncated ? 1 : 0)
  const suffix = missing > 0 ? tr('monitor.posture.cert.notReadSuffix', { count: missing }) : ''
  return {
    text:
      (days < 0
        ? tr('monitor.posture.cert.expired', { days: -days })
        : tr('monitor.posture.cert.left', { days })) + suffix,
    gap: null,
    bad: isCertificateExpiringSoon(days),
    help:
      (days < 0
        ? tr('monitor.posture.cert.expiredHelp', { days: -days })
        : isCertificateExpiringSoon(days)
          ? tr('monitor.posture.cert.leftSoonHelp', { days, line: CERT_EXPIRY_DAYS })
          : tr('monitor.posture.cert.leftHelp', { days })) +
      (missing > 0 ? tr('monitor.posture.cert.missingHelp', { count: missing }) : '') +
      ` ${bound}`
  }
}

/** The security update count, TAKEN FROM ITEM C. Not recomputed here and not
 *  recomputed anywhere: the distribution's own answer is better than anything
 *  this app would derive, and `unsupported` has to survive all the way to the
 *  screen or an Arch host reads as clean during a CVE week. */
function updatesCell(facts: HostFacts | null): Cell {
  const r = securityUpdateReading(facts)
  if (r.count === null) {
    return {
      text: tr(gapWords[r.status === 'stale-metadata' ? 'ok' : r.status]),
      gap: r.status === 'stale-metadata' ? null : (r.status as PostureStatus),
      help: `${FACT_STATUS_HELP[r.status]}${r.detail ? ` — ${r.detail}` : ''}`
    }
  }
  return {
    text: String(r.count),
    gap: null,
    bad: r.count > 0,
    help:
      r.count === 0
        ? tr('monitor.posture.updates.noneHelp')
        : tr('monitor.posture.updates.countHelp', { count: r.count })
  }
}

function CellView({ cell, host, col }: { cell: Cell; host: string; col: string }): React.JSX.Element {
  return (
    <td data-host={host} data-col={col}>
      {cell.gap === null ? (
        <span className={clsx(cell.bad && 'warn')} title={cell.help}>
          {cell.text}
        </span>
      ) : (
        // Never a dash, never a zero, never a tick. The words are the feature.
        <span className={clsx('inv-na', loudGap(cell.gap) && 'loud')} title={cell.help}>
          {cell.text}
        </span>
      )}
    </td>
  )
}

function DirectiveRow({ r }: { r: SshdReading }): React.JSX.Element {
  const t = useT()
  return (
    <div className="row" style={{ gap: 8, alignItems: 'baseline' }} data-directive={r.directive}>
      <span className="mono" style={{ minWidth: 190 }}>
        {r.directive}
      </span>
      {r.value === null ? (
        <span className={clsx('inv-na', r.verdict === 'unknown' && 'loud')} title={r.detail}>
          {r.ambiguous ? t('monitor.posture.directive.setTwice') : t('monitor.posture.directive.notRead')}
        </span>
      ) : (
        <span className={clsx('mono', r.verdict === 'weak' && 'warn')} title={r.detail}>
          {r.value}
        </span>
      )}
      <span className="faint">
        {r.detail}
      </span>
    </div>
  )
}

/**
 * The rules themselves — roadmap item 31.
 *
 * The firewall cell above says "ufw · 12 rules · in deny", which does not
 * answer the question an operator opened this panel with. This does.
 *
 * FOUR STATES, and three of them are not a list. An empty list would render as
 * "nothing is exposed on this host", which is the strongest possible
 * all-clear, and it is the wrong answer for two of the four:
 *
 *   1. nobody granted the capability, so nothing was asked for;
 *   2. it was granted and the read was refused;
 *   3. it was granted, the read succeeded and the firewall lists nothing;
 *   4. here they are.
 *
 * Only the third is a finding about the host. The others say what happened.
 *
 * Every line in state 4 is TEXT THE HOST WROTE — the same provenance
 * `hostReportedBlock` marks for a model in mcpServer.ts, marked here for a
 * person. And no line carries a verdict: this panel says what is there, not
 * whether it is wise. See src/shared/posture.ts on why.
 */
function FirewallRules({ posture }: { posture: HostPosture }): React.JSX.Element {
  const t = useT()
  const fw = posture.firewall
  const s = postureSource(posture, 'firewall')
  if (fw === null) {
    return (
      <div className="inv-na loud" title={POSTURE_STATUS_HELP[s.status]}>
        {s.detail
          ? t('monitor.posture.rules.nothingReadDetail', { detail: s.detail })
          : t('monitor.posture.rules.nothingRead')}
      </div>
    )
  }
  if (!fw.rulesRequested) {
    return (
      <div className="inv-na">
        <Trans i18nKey="monitor.posture.rules.notRequested" components={{ b: <b /> }} />
      </div>
    )
  }
  if (fw.ruleLines.length === 0) {
    // Granted, and every read that would have produced a line was refused. The
    // one thing this must never look like is a short list.
    return (
      <div className="inv-na loud">
        {s.detail
          ? t('monitor.posture.rules.refusedDetail', { detail: s.detail })
          : t('monitor.posture.rules.refused')}
      </div>
    )
  }
  return (
    <>
      <b>{FIREWALL_RULES_HOST_REPORTED_NOTE}</b>
      {fw.ruleLines.map((listing) => (
        <div key={listing.from} data-rule-listing={listing.from} style={{ marginTop: 6 }}>
          <div className="faint">
            {listing.from === 'front'
              ? t('monitor.posture.rules.front')
              : t('monitor.posture.rules.kernel')}{' '}
            · <span className="mono">{listing.command}</span>
            {listing.truncated && (
              // STATED, never silent. A prefix drawn as if it were the whole
              // list is the same failure as a refused read drawn as an empty
              // one, one step quieter.
              <span className="state-unknown">
                {t('monitor.posture.rules.truncated', {
                  shown: listing.lines.length,
                  matched: listing.matched ?? '',
                  max: listing.bound.maxLines
                })}
              </span>
            )}
          </div>
          {listing.lines.length === 0 ? (
            <div>{t('monitor.posture.rules.empty')}</div>
          ) : (
            listing.lines.map((line, i) => (
              // A firewall rule line is copied into a terminal verbatim. 11px
              // mono was the smallest text in the panel and the most literal.
              <div key={`${listing.from}:${i}`} className="mono">
                {line}
              </div>
            ))
          )}
        </div>
      ))}
    </>
  )
}

const COLUMNS: { id: string; labelKey: MessageKey; helpKey: MessageKey }[] = [
  { id: 'firewall', labelKey: 'monitor.posture.col.firewall', helpKey: 'monitor.posture.col.firewallHelp' },
  { id: 'mac', labelKey: 'monitor.posture.col.mac', helpKey: 'monitor.posture.col.macHelp' },
  { id: 'sshd', labelKey: 'monitor.posture.col.sshd', helpKey: 'monitor.posture.col.sshdHelp' },
  { id: 'failed', labelKey: 'monitor.posture.col.failed', helpKey: 'monitor.posture.col.failedHelp' },
  { id: 'updates', labelKey: 'monitor.posture.col.updates', helpKey: 'monitor.posture.col.updatesHelp' },
  { id: 'oom', labelKey: 'monitor.posture.col.oom', helpKey: 'monitor.posture.col.oomHelp' },
  { id: 'certs', labelKey: 'monitor.posture.col.certs', helpKey: 'monitor.posture.col.certsHelp' }
]

/**
 * A host with no reading at all, said ONCE.
 *
 * Seven cells of "not collected" is seven statements where there is only one
 * fact, and an operator reading a row of them counts seven problems — the
 * screenshot that started this had one offline server drawn as seven separate
 * failures. So the whole row collapses into the reason, and the reason is one
 * of exactly three, where there used to be one sentence for all three:
 *
 *   offline   nobody could reach the server. Not a security finding at all.
 *   failed    the probe reached it and fell over. The reason is above the table.
 *   pending   nothing has asked yet. The ONLY one where Settings is relevant,
 *             and the only one that must not be drawn as a problem.
 *
 * `offline` is decided by the server's own connection status rather than by the
 * absence of a reading, which is what makes it separable from `pending` at all.
 * A host that IS reachable and simply has not been swept says so, and nothing
 * in that sentence suggests the operator forgot to configure something.
 *
 * What does NOT change: none of the three is a pass. Each says the checks did
 * not run, in the words of the tier above.
 */
type NotRead = 'offline' | 'failed' | 'pending'

const NOT_READ: Record<NotRead, { tone: string; lead: MessageKey; words: MessageKey }> = {
  offline: {
    tone: 'is-unknown',
    lead: 'monitor.posture.notRead.offlineLead',
    words: 'monitor.posture.notRead.offlineWords'
  },
  failed: {
    tone: 'is-alarm',
    lead: 'monitor.posture.notRead.failedLead',
    words: 'monitor.posture.notRead.failedWords'
  },
  pending: {
    tone: 'is-unknown',
    lead: 'monitor.posture.notRead.pendingLead',
    words: 'monitor.posture.notRead.pendingWords'
  }
}

function NotReadRow({
  state,
  host,
  securityUpdates
}: {
  state: NotRead
  host: string
  /** Item C's count, which comes from the Inventory probe and therefore
   *  survives a posture reading that never happened. A real answer must not be
   *  swallowed by the collapse — it is the one number this row can still
   *  honestly show. */
  securityUpdates: number | null
}): React.JSX.Element {
  const t = useT()
  const n = NOT_READ[state]
  return (
    <td colSpan={COLUMNS.length} data-host={host} data-col="not-read" data-row-state={state}>
      <div className={`panel-note ${n.tone}`}>
        <b>{t(n.lead)}</b> {t(n.words)}
        {securityUpdates !== null && (
          <>
            {' '}
            {t('monitor.posture.notRead.inventory', { count: securityUpdates })}
          </>
        )}
      </div>
    </td>
  )
}

/**
 * This machine, alongside the estate.
 *
 * A sentinel id, never a row in `servers` — that list is persisted and mirrored
 * into the MCP data cache. See shared/execTarget.ts.
 *
 * Its reading is taken on demand rather than by the fleet sweep, and that is
 * not an implementation shortcut: the sweep persists posture facts into the
 * durable history store keyed by host, and this machine's firewall state does
 * not belong in the same record as the estate's. `fleet:posture-local` returns
 * a reading and keeps nothing.
 */
const LOCAL_ID = 'local'

export function PosturePanel({
  servers,
  onOpen
}: {
  servers: Server[]
  onOpen?: (serverId: string) => void
}): React.JSX.Element {
  const t = useT()
  const [entries, setEntries] = useState<Record<string, Entry>>({})
  const [facts, setFacts] = useState<Record<string, HostFacts | null>>({})
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState<string | null>(null)
  // A second expander rather than a mode on the first: an operator comparing
  // the sshd baseline with what the firewall lets in wants both open at once,
  // and one of them closing the other is a worse screen than two buttons.
  const [openRules, setOpenRules] = useState<string | null>(null)

  const load = useCallback(async (): Promise<void> => {
    const fleet = window.opsmaxx?.fleet as Record<string, unknown> | undefined
    if (!bridgeHas(fleet, 'posture')) return
    const nextEntries: Record<string, Entry> = {}
    const nextFacts: Record<string, HostFacts | null> = {}

    // Taken now, not read from the sweep — the sweep does not visit this
    // machine. A probe answers `{ ok }`, so it is adapted into the same Entry
    // the cached servers use and every cell below stays one code path.
    const readLocal = async (): Promise<void> => {
      if (!bridgeHas(fleet, 'postureLocal')) return
      const at = Date.now()
      try {
        const r = await window.opsmaxx?.fleet?.postureLocal?.()
        if (!r) return
        nextEntries[LOCAL_ID] = r.ok
          ? { posture: r.posture, at }
          : { error: `${r.reason}: ${r.detail}`, errorAt: at }
      } catch (e) {
        nextEntries[LOCAL_ID] = { error: e instanceof Error ? e.message : String(e), errorAt: at }
      }
    }

    await Promise.all([
      readLocal(),
      ...servers.map(async (s) => {
        const r = await window.opsmaxx?.fleet?.posture(s.id)
        if (r) nextEntries[s.id] = { posture: r.posture, at: r.at, error: r.error, errorAt: r.errorAt }
        // Item C's collection, read alongside. The security update count is
        // ITS answer, and this panel shows it rather than deriving one.
        if (bridgeHas(fleet, 'facts')) {
          const f = await window.opsmaxx?.fleet?.facts(s.id)
          nextFacts[s.id] = f?.facts ?? null
        }
      })
    ])
    setEntries(nextEntries)
    setFacts(nextFacts)
  }, [servers])

  useEffect(() => {
    void load()
  }, [load])

  const refresh = async (): Promise<void> => {
    setBusy(true)
    try {
      // Collect, not just sweep: this probe keeps its own hourly clock, and a
      // plain sweep does not clear it — so pressing this re-read metrics and
      // skipped posture entirely. See lib/collectNow.
      await collectNow()
      await load()
    } finally {
      setBusy(false)
    }
  }

  /** The estate, then this machine — last, so the fleet reads first. */
  const hosts = useMemo(
    () => [
      // `online` comes from the connection status the rest of the app already
      // keeps, not from whether a reading arrived — that is the whole
      // difference between "we could not reach it" and "we have not asked".
      ...servers.map((s) => ({ id: s.id, name: s.name, online: s.status === 'online' })),
      // Only when the channel is actually wired. A build without it would
      // otherwise show a row that can never be filled, which reads as a host
      // that has never been collected rather than as a missing feature.
      ...(bridgeHas(window.opsmaxx?.fleet as Record<string, unknown> | undefined, 'postureLocal')
        ? [{ id: LOCAL_ID, name: t('monitor.posture.localName'), online: true }]
        : [])
    ],
    [servers, t]
  )

  const rows = useMemo(
    () =>
      hosts.map((s) => {
        const e = entries[s.id]
        const posture = e?.posture ?? null
        const base = {
          serverId: s.id,
          serverName: s.name,
          online: s.online,
          at: e?.at
        }
        if (posture) {
          return {
            ...base,
            posture,
            // An error only explains an ABSENCE. With a posture in hand the
            // last good collection is what the row shows, with its own age on
            // it, and the failure is reported above the table rather than by
            // blanking a host we still know things about.
            error: null as string | null,
            notRead: null,
            securityUpdates: null,
            cells: {
              firewall: firewallCell(posture),
              mac: macCell(posture),
              sshd: sshdCell(posture),
              failed: failedCell(posture),
              updates: updatesCell(facts[s.id] ?? null),
              oom: oomCell(posture),
              certs: certCell(posture)
            }
          }
        }
        return {
          ...base,
          posture: null,
          error: e?.error ?? null,
          // The order matters: a probe that failed says so even on a server the
          // fleet already believes is offline, because "it fell over" is more
          // specific than "it was not there".
          notRead: (e?.error ? 'failed' : s.online ? 'pending' : 'offline') as NotRead,
          securityUpdates: securityUpdateReading(facts[s.id] ?? null).count,
          cells: null
        }
      }),
    // `t` because every cell is worded inside this memo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [hosts, entries, facts, t]
  )

  const summary = useMemo(() => summarisePosture(rows.map((r) => ({ posture: r.posture }))), [rows])
  const failed = rows.filter((r): r is typeof r & { error: string } => typeof r.error === 'string')
  const notRead = rows.filter((r) => r.cells === null).length

  const checkNow = (primary: boolean): React.JSX.Element => (
    <div className="check-now">
      <button
        className={primary ? 'btn primary sm' : 'btn ghost sm'}
        disabled={busy}
        onClick={() => void refresh()}
        title={t('monitor.posture.checkNowTitle')}
      >
        <RefreshCw size={13} className={clsx(busy && 'spin')} />
        {busy ? t('monitor.posture.checking') : t('monitor.posture.checkNow')}
      </button>
      <SweepProgress active={busy} label={t('monitor.posture.collecting')} />
    </div>
  )

  return (
    <PanelShell
      icon={<ShieldAlert size={14} />}
      title={t('modules.posture.label')}
      about={<p>{t('monitor.posture.about')}</p>}
      actions={checkNow(summary.collected === 0)}
    >
      {summary.collected === 0 ? (
        <SweepEmpty
          subject={t('monitor.posture.empty.subject')}
          busy={busy}
          onCheckNow={() => void refresh()}
          note={t('monitor.posture.empty.note')}
        />
      ) : (
        <>
          <div className="panel-stats">
            <span>
              {/* "hosts", not "servers": this machine is one of the rows now, and it
              is not a server. summarisePosture has always called them hosts. */}
              {t('monitor.posture.stats.hosts', {
                count: summary.hosts,
                collected: summary.collected
              })}
            </span>
            {/* Every count here has its gap beside it. A security roll-up drawn
                over only the hosts that answered is the exact shape of
                reassuring fiction this panel exists to avoid. */}
            <span>
              {t('monitor.posture.stats.filtering', { count: summary.firewallActive })}
              {summary.firewallInactive > 0 && (
                <span className="state-watch">
                  {t('monitor.posture.stats.notFiltering', { count: summary.firewallInactive })}
                </span>
              )}
              {summary.firewallUnknown > 0 && (
                <span className="state-unknown">
                  {t('monitor.posture.stats.fwUnknown', { count: summary.firewallUnknown })}
                </span>
              )}
            </span>
            <span>
              {t('monitor.posture.stats.enforcing', { count: summary.macEnforcing })}
              {summary.macAbsent > 0 && (
                <span>{t('monitor.posture.stats.macAbsent', { count: summary.macAbsent })}</span>
              )}
              {summary.macUnknown > 0 && (
                <span className="state-unknown">
                  {t('monitor.posture.stats.macUnknown', { count: summary.macUnknown })}
                </span>
              )}
            </span>
            <span>
              {summary.sshdWeak > 0 && (
                <span className="state-watch">
                  {t('monitor.posture.stats.sshdWeak', { count: summary.sshdWeak })}
                </span>
              )}
              {summary.sshdWeak === 0 && <span>{t('monitor.posture.stats.sshdNoneWeak')}</span>}
              {summary.sshdUnknown > 0 && (
                <span className="state-unknown">
                  {t('monitor.posture.stats.sshdUnknown', { count: summary.sshdUnknown })}
                </span>
              )}
            </span>
            {/* Both of these carry their gap, for the reason every count above
                does: a roll-up drawn over the hosts that answered is the
                reassuring fiction this panel exists to avoid. `oomUnknown`
                counts every host answered by a ring buffer as well as every
                host that refused, because neither can support a "none". */}
            <span>
              {summary.oomKilling > 0 ? (
                <span className="state-watch">
                  {t('monitor.posture.stats.oomKilling', { count: summary.oomKilling })}
                </span>
              ) : (
                <span>{t('monitor.posture.stats.oomNone')}</span>
              )}
              {summary.oomUnknown > 0 && (
                <span className="state-unknown">
                  {t('monitor.posture.stats.oomUnknown', { count: summary.oomUnknown })}
                </span>
              )}
            </span>
            <span>
              {summary.certExpired > 0 && (
                <span className="state-watch">
                  {t('monitor.posture.stats.certExpired', { count: summary.certExpired })}
                </span>
              )}
              {summary.certExpired === 0 && summary.certExpiringSoon === 0 && (
                <span>{t('monitor.posture.stats.certNone', { days: CERT_EXPIRY_DAYS })}</span>
              )}
              {summary.certExpiringSoon > 0 && (
                <span className="state-watch">
                  {summary.certExpired > 0 ? ' · ' : ''}
                  {t('monitor.posture.stats.certSoon', {
                    count: summary.certExpiringSoon,
                    days: CERT_EXPIRY_DAYS
                  })}
                </span>
              )}
              {summary.certUnknown > 0 && (
                <span className="state-unknown">
                  {t('monitor.posture.stats.certUnknown', { count: summary.certUnknown })}
                </span>
              )}
            </span>
          </div>

          {(summary.firewallUnknown > 0 || summary.sshdUnknown > 0) && (
            <div className="panel-note is-unknown">
              {/* The first sentence is the reason this panel exists and does
                  not fold under anything. What folds is the remedy — true,
                  useful, and read once per estate rather than per visit. */}
              <ShieldQuestion size={12} />{' '}
              {t('monitor.posture.unknownNote', {
                count: summary.firewallUnknown + summary.sshdUnknown
              })}
              {/* Not all of those checks are the same kind of gap, and this is
                  the sentence that keeps them apart: a server nobody could read
                  contributes every one of its checks to that number, and the
                  remedy below is not its remedy. */}
              {notRead > 0 && (
                <>
                  {' '}
                  {t('monitor.posture.notReadHosts', { count: notRead })}
                </>
              )}
              <NoteWhy summary={t('monitor.posture.howToClose')}>
                {t('monitor.posture.howToCloseBody')}
              </NoteWhy>
            </div>
          )}

          {failed.map((f) => (
            <div key={f.serverId} className="panel-note is-alarm">
              {t('monitor.posture.probeFailed', { name: f.serverName, error: f.error })}
            </div>
          ))}

          <div className="inv-scroll">
            <table className="table inv-table">
              <thead>
                <tr>
                  <th>{t('monitor.posture.col.host')}</th>
                  {COLUMNS.map((c) => (
                    <th key={c.id} title={t(c.helpKey)}>
                      {t(c.labelKey)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  // The Fragment carries the key: a bare `<>` inside a map
                  // gives React nothing to reconcile the two rows against, and
                  // the expanded sshd detail below is the second row.
                  <Fragment key={r.serverId}>
                    <tr
                      // No title at all when there is nothing to date. "Never
                      // collected." on hover is the same flattening this change
                      // exists to undo, and the row now says which of the three
                      // reasons it is, in full, without hovering.
                      title={
                        r.at === undefined
                          ? undefined
                          : t('monitor.posture.row.readAgo', { ago: duration(r.at) })
                      }
                    >
                      <td data-host={r.serverName} data-col="host">
                        {/* This machine has no server tab to open, so its name
                            is plain text rather than a control that goes
                            nowhere. */}
                        {onOpen && r.serverId !== LOCAL_ID ? (
                          <button className="inv-host" onClick={() => onOpen(r.serverId)} title={t('monitor.posture.row.openTitle', { name: r.serverName })}>
                            {r.serverName}
                          </button>
                        ) : (
                          <span>{r.serverName}</span>
                        )}
                        {/* A reading from a server that has since gone offline
                            is still a reading, and it is also older than the
                            row's age tooltip suggests it is current. The row
                            with no reading at all says this in its own words
                            instead — see NotReadRow. */}
                        {r.cells !== null && !r.online && (
                          <span
                            className="inv-na"
                            title={t('monitor.posture.row.offlineTitle')}
                          >
                            {' '}
                            {t('monitor.posture.row.offline')}
                          </span>
                        )}
                        {r.posture?.sshd && (
                          <button
                            className="btn ghost sm"
                            style={{ marginLeft: 6 }}
                            onClick={() => setOpen((o) => (o === r.serverId ? null : r.serverId))}
                            title={t('monitor.posture.row.sshdTitle')}
                          >
                            {open === r.serverId
                              ? t('monitor.posture.row.hideSshd')
                              : t('monitor.posture.row.sshd')}
                          </button>
                        )}
                        {r.posture && (
                          <button
                            className="btn ghost sm"
                            style={{ marginLeft: 6 }}
                            onClick={() =>
                              setOpenRules((o) => (o === r.serverId ? null : r.serverId))
                            }
                            title={t('monitor.posture.row.rulesTitle')}
                          >
                            {openRules === r.serverId
                              ? t('monitor.posture.row.hideRules')
                              : t('monitor.posture.row.rules')}
                          </button>
                        )}
                      </td>
                      {r.cells === null ? (
                        <NotReadRow
                          state={r.notRead}
                          host={r.serverName}
                          securityUpdates={r.securityUpdates}
                        />
                      ) : (
                        COLUMNS.map((c) => (
                          <CellView
                            key={c.id}
                            cell={r.cells[c.id as keyof typeof r.cells]}
                            host={r.serverName}
                            col={c.id}
                          />
                        ))
                      )}
                    </tr>
                    {openRules === r.serverId && r.posture && (
                      <tr>
                        <td colSpan={COLUMNS.length + 1}>
                          <div className="panel-note" data-rules-detail={r.serverName}>
                            <FirewallRules posture={r.posture} />
                          </div>
                        </td>
                      </tr>
                    )}
                    {open === r.serverId && r.posture?.sshd && (
                      <tr>
                        <td colSpan={COLUMNS.length + 1}>
                          <div className="panel-note" data-sshd-detail={r.serverName}>
                            {r.posture.sshd.effective ? (
                              <b>{t('monitor.posture.sshdDetail.effective')}</b>
                            ) : (
                              <b>{t('monitor.posture.sshdDetail.files')}</b>
                            )}
                            {r.posture.sshd.matchBlocks !== null && r.posture.sshd.matchBlocks > 0 && (
                              <div className="state-watch" style={{ marginTop: 4 }}>
                                <Trans
                                  i18nKey="monitor.posture.sshdDetail.matchBlocks"
                                  values={{ count: r.posture.sshd.matchBlocks }}
                                  components={{ mono: <span className="mono" /> }}
                                />
                              </div>
                            )}
                            <div style={{ marginTop: 6 }}>
                              {SSHD_DIRECTIVES.map((d) => {
                                const reading = r.posture?.sshd?.readings.find((x) => x.directive === d)
                                return reading ? <DirectiveRow key={d} r={reading} /> : null
                              })}
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>

          {/* The per-source detail, for the person whose next question is
              "why couldn't it read that". A status word with nothing behind it
              sends people to the wrong machine. */}
          {rows
            .filter((r) => r.posture !== null)
            .flatMap((r) =>
              POSTURE_SOURCE_IDS
                .map((id) => ({ row: r, s: postureSource(r.posture as HostPosture, id) }))
                .filter(({ s }) => s.status === 'denied' && s.detail)
                .map(({ row, s }) => (
                  <div key={`${row.serverId}-${s.id}`} className="faint" style={{ marginTop: 4 }}>
                    {row.serverName} · {s.label}: {s.detail}
                  </div>
                ))
            )}
        </>
      )}
    </PanelShell>
  )
}
