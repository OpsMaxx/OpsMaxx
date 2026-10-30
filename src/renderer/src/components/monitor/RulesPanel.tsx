import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Plus, Trash2, Zap } from 'lucide-react'
import { clsx } from '../../lib/format'
import { ruleWarnings } from '../../lib/ruleReach'
import { useApp } from '../../store/app'
import { hostThreshold } from '../../store/alerts'
import {
  RULE_ALERT_KINDS,
  RULE_LIMIT_DEFAULT,
  RULE_LIMIT_MAX_FIRINGS,
  RULE_UNATTENDED_PHRASE,
  ruleCreationConfirmation,
  ruleJobPlan,
  type RuleAction,
  type RuleAlertKind,
  type RuleDraftWire,
  type RuleTriggerEvent,
  type RuleView,
  type RulesBridge
} from '../../../../shared/rules'
import { jobApprovalFor } from '../../../../shared/jobs'
import type { JobSpec, JobTargetRef } from '../../../../shared/jobs'
import type { Server } from '../../types'
import { PanelShell } from './PanelShell'
import { t as tr, useT } from '../../lib/i18n'
import { Trans } from '../../lib/Trans'
import type { MessageKey } from '../../../../shared/i18n'

// Rules — roadmap item 27.
//
// "When this alert fires, run that job, then call that webhook." The whole of
// what a rule is lives in src/shared/rules.ts, including the argument for why a
// job rule is pinned to the spec and the host list it was written with. This
// panel's job is to make that pinning VISIBLE, because a standing authorisation
// nobody can read back is not consent, it is a setting.
//
// So three things are on screen for every rule, always, and none of them is
// behind a disclosure triangle:
//
//  1. WHAT IT RUNS AND WHERE — the step text and the host names, not a job id.
//  2. HOW OFTEN IT MAY ACT — the rate limit as a sentence, and how many
//     matching events it has already declined to act on.
//  3. WHETHER IT STILL CAN — the verdict, re-derived by main on every read. A
//     rule whose approval has drifted reads as refusing HERE, in daylight,
//     rather than being discovered from a webhook at 3am.
//
// And the creation form always demands a typed word for a job rule, which
// `planJob` would not: an ordinary command on two hosts needs one click as a
// job and needs somebody to have noticed as a standing authorisation. See
// `ruleCreationConfirmation`.

function bridge(): Partial<RulesBridge> | undefined {
  return (window.opsmaxx as unknown as { rules?: Partial<RulesBridge> } | undefined)?.rules
}

const KIND_LABEL: Record<RuleAlertKind, MessageKey> = {
  'vpn-down': 'monitor.rules.kind.vpnDown',
  'service-down': 'monitor.rules.kind.serviceDown',
  'pod-crashloop': 'monitor.rules.kind.podCrashloop',
  'vpn-degraded': 'monitor.rules.kind.vpnDegraded',
  cpu: 'monitor.rules.kind.cpu',
  disk: 'monitor.rules.kind.disk',
  inode: 'monitor.rules.kind.inode',
  load: 'monitor.rules.kind.load',
  'host-unreachable': 'monitor.rules.kind.hostUnreachable',
  'job-failed': 'monitor.rules.kind.jobFailed',
  'tunnel-down': 'monitor.rules.kind.tunnelDown',
  'backup-failed': 'monitor.rules.kind.backupFailed',
  'db-alarm': 'monitor.rules.kind.dbAlarm',
  'db-watch': 'monitor.rules.kind.dbWatch',
  'oom-kill': 'monitor.rules.kind.oomKill',
  'cert-expiry': 'monitor.rules.kind.certExpiry',
  'vpn-cert-expiry': 'monitor.rules.kind.vpnCertExpiry',
  'error-rate': 'monitor.rules.kind.errorRate'
}

const EVENT_LABEL: Record<RuleTriggerEvent, MessageKey> = {
  raised: 'monitor.rules.when.raised',
  resolved: 'monitor.rules.when.resolved'
}

const WINDOWS: { ms: number; labelKey: MessageKey }[] = [
  { ms: 60_000, labelKey: 'monitor.rules.window.minute' },
  { ms: 600_000, labelKey: 'monitor.rules.window.tenMinutes' },
  { ms: 3_600_000, labelKey: 'monitor.rules.window.hour' },
  { ms: 6 * 3_600_000, labelKey: 'monitor.rules.window.sixHours' },
  { ms: 86_400_000, labelKey: 'monitor.rules.window.day' }
]

function windowLabel(ms: number): string {
  const known = WINDOWS.find((w) => w.ms === ms)
  return known
    ? tr(known.labelKey)
    : tr('monitor.rules.window.minutes', { count: Math.round(ms / 60_000) })
}

/** The rate limit as a sentence. A pair of numbers in a table is not something
 *  anyone reads as "this may restart your database once an hour". */
function limitText(maxFirings: number, windowMs: number): string {
  const window = windowLabel(windowMs)
  return maxFirings === 1
    ? tr('monitor.rules.limit.once', { window })
    : tr('monitor.rules.limit.times', { count: maxFirings, window })
}

function when(rule: RuleView): string {
  const known = KIND_LABEL[rule.trigger.kind as RuleAlertKind]
  const kind = known ? tr(known) : rule.trigger.kind
  const event = EVENT_LABEL[rule.trigger.event as RuleTriggerEvent]
  let text = event ? tr(event, { kind }) : `${kind} ${rule.trigger.event}`
  if (rule.filter.serverId !== undefined) text += tr('monitor.rules.when.onOneServer')
  if (rule.filter.minValue !== undefined)
    text += tr('monitor.rules.when.atOrAbove', { value: rule.filter.minValue })
  return text
}

const FAINT = { faint: <span className="faint" /> }

function RuleCard({
  rule,
  servers,
  onToggle,
  onRemove
}: {
  rule: RuleView
  servers: Server[]
  onToggle: (enabled: boolean) => void
  onRemove: () => void
}): React.JSX.Element {
  const t = useT()
  const hostName = (id: string): string => servers.find((s) => s.id === id)?.name ?? id
  const job = rule.action.type === 'job' ? rule.action : null

  return (
    <div className={clsx('card', 'col')} style={{ gap: 8, padding: 12 }}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
        <b>{rule.name || t('monitor.rules.card.untitled')}</b>
        <div className="row" style={{ gap: 8 }}>
          <label className="row" style={{ gap: 4 }}>
            <input
              type="checkbox"
              checked={rule.enabled}
              aria-label={t('monitor.rules.card.enableLabel', { name: rule.name })}
              onChange={(e) => onToggle(e.target.checked)}
            />
            {rule.enabled ? t('common.enabled') : t('common.disabled')}
          </label>
          <button className="btn ghost" aria-label={t('monitor.rules.card.deleteLabel', { name: rule.name })} onClick={onRemove}>
            <Trash2 size={14} />
          </button>
        </div>
      </div>

      <div>
        <Trans i18nKey="monitor.rules.card.when" values={{ when: when(rule) }} components={FAINT} />
      </div>

      {job === null ? (
        <div>
          <Trans i18nKey="monitor.rules.card.thenWebhook" components={FAINT} />
        </div>
      ) : (
        <div className="col" style={{ gap: 4 }}>
          <div>
            <Trans
              i18nKey="monitor.rules.card.thenRun"
              values={{
                title: job.spec.title,
                hosts: job.targets.map((x) => hostName(x.serverId)).join(', ')
              }}
              components={FAINT}
            />
          </div>
          {/* The step text itself, never a job id. What a rule runs is the
              thing a person has to be able to check a year later. */}
          {job.spec.steps.map((s, i) => (
            <code key={i} style={{ wordBreak: 'break-all' }}>
              {s.command}
            </code>
          ))}
        </div>
      )}

      <div className="faint">
        {limitText(rule.limit.maxFirings, rule.limit.windowMs)}
        {rule.status.lastFiredAt !== undefined
          ? t('monitor.rules.card.lastActed', {
              when: new Date(rule.status.lastFiredAt).toLocaleString()
            })
          : t('monitor.rules.card.notActed')}
        {rule.status.suppressed > 0
          ? t('monitor.rules.card.suppressed', { count: rule.status.suppressed })
          : ''}
      </div>

      {/* A rule that cannot run says so here rather than at 3am. */}
      {!rule.verdict.ok && (
        <div
          className="row state-alarm"
          style={{ gap: 6, alignItems: 'flex-start' }}
        >
          <AlertTriangle size={14} />
          <span>{t('monitor.rules.card.willNotRun', { reason: rule.verdict.reason ?? '' })}</span>
        </div>
      )}
      {rule.verdict.ok && rule.status.refusal !== undefined && (
        <div
          className="row state-watch"
          style={{ gap: 6, alignItems: 'flex-start' }}
        >
          <AlertTriangle size={14} />
          <span>{t('monitor.rules.card.lastRefused', { reason: rule.status.refusal })}</span>
        </div>
      )}
    </div>
  )
}

export function RulesPanel({
  servers,
  moduleOff = false
}: {
  servers: Server[]
  /** True when this panel is only on screen because a rule is still armed. */
  moduleOff?: boolean
}): React.JSX.Element {
  const t = useT()
  // `null` until the read comes back, NOT `[]`.
  //
  // An empty array means "there are no rules", and this screen says that out
  // loud -- "No rules. Nothing runs on its own." That is a confident claim
  // about whether anything is going to fire, and before the read returned it
  // was being made about rules that had not been looked at yet. On a screen
  // whose entire subject is what runs without you, asserting that nothing does
  // is the one thing it must not get wrong.
  const [rules, setRules] = useState<RuleView[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [noBridge, setNoBridge] = useState(false)
  const [open, setOpen] = useState(false)

  const [name, setName] = useState('')
  const [kind, setKind] = useState<RuleAlertKind>('disk')
  const [event, setEvent] = useState<RuleTriggerEvent>('raised')
  const [hostFilter, setHostFilter] = useState('')
  const [minValue, setMinValue] = useState('')
  const [maxFirings, setMaxFirings] = useState(RULE_LIMIT_DEFAULT.maxFirings)
  const [windowMs, setWindowMs] = useState(RULE_LIMIT_DEFAULT.windowMs)
  const [actionType, setActionType] = useState<'notify' | 'job'>('notify')
  // Resolved for the SERVER the rule names, not the workspace default, so the
  // number in the sentence is the one this rule will actually be compared
  // against. `hostFilter` empty means "any server", where the global is the
  // only honest thing to quote.
  const resourceAlertThreshold = useApp((s) => s.settings.resourceAlertThreshold)
  const resourceAlertThresholds = useApp((s) => s.settings.resourceAlertThresholds)
  const webhookAlertsEnabled = useApp((s) => s.settings.webhookAlertsEnabled)
  const warnings = ruleWarnings({
    kind,
    minValue,
    event,
    action: actionType,
    resourceThreshold:
      hostFilter === ''
        ? resourceAlertThreshold
        : hostThreshold(resourceAlertThreshold, resourceAlertThresholds, hostFilter),
    webhookEnabled: webhookAlertsEnabled
  })
  const warningFor = (field: 'minValue' | 'action'): string | null =>
    warnings.find((w) => w.field === field)?.text ?? null
  const [title, setTitle] = useState('')
  const [commands, setCommands] = useState('')
  const [targetIds, setTargetIds] = useState<string[]>([])
  const [phrase, setPhrase] = useState('')
  // The word the JOB's own plan demands, typed separately from the rule's.
  // Two ceremonies, two boxes — see `planPhrase` below for why they cannot be
  // one.
  const [jobPhrase, setJobPhrase] = useState('')

  const refresh = useCallback(async (): Promise<void> => {
    const list = bridge()?.list
    if (typeof list !== 'function') {
      // A definite answer, and not the same one as "still reading". The
      // capability is missing from this build's preload, so nothing will ever
      // arrive -- leaving the panel on "Reading the rules…" would be a spinner
      // that never resolves, which is the failure the tri-state was added to
      // avoid, just pointed the other way.
      setNoBridge(true)
      return
    }
    setNoBridge(false)
    try {
      setRules(await list())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const targets = useMemo<JobTargetRef[]>(
    () =>
      targetIds
        .map((id) => servers.find((s) => s.id === id))
        .filter((s): s is Server => s !== undefined)
        .map((s) => ({ serverId: s.id, serverName: s.name })),
    [targetIds, servers]
  )

  const spec = useMemo<JobSpec>(
    () => ({
      kind: 'command',
      title: title.trim() || 'Rule job',
      steps: commands
        .split('\n')
        .map((c) => c.trim())
        .filter((c) => c !== '')
        .map((command) => ({ command }))
    }),
    [title, commands]
  )

  // Risk, confirmation and blast radius, computed from the pinned pair as the
  // form is typed. THE POINT of this panel: the blast radius of a rule has to
  // be knowable when it is written, so it is on screen while it is being
  // written rather than derivable afterwards.
  const plan = useMemo(
    () => (actionType === 'job' ? ruleJobPlan({ spec, targets }) : null),
    [actionType, spec, targets]
  )

  const confirmation = ruleCreationConfirmation(actionType)
  const needsPhrase = confirmation.kind === 'type-to-confirm'
  const phraseOk = !needsPhrase || phrase.trim() === RULE_UNATTENDED_PHRASE

  /**
   * The word THIS JOB would demand as a one-off, or null when it demands none.
   *
   * TWO CEREMONIES, AND THEY ARE NOT INTERCHANGEABLE.
   *
   * `approval.phrase` means one thing everywhere else in the app: the word the
   * human typed to satisfy THIS PLAN's confirmation. Every other caller mints it
   * as `plan.confirmation.kind === 'type-to-confirm' ? typed : null` — broadcast,
   * jobs, patch, compose, docker. This panel used to put the rule's own word
   * there instead, and `verifyApproval` compares that field against the phrase a
   * fresh `planJob` demands: so the moment a rule was destructive, or reached
   * past TYPE_ABOVE_HOSTS servers, its record contradicted itself and the rule
   * refused every firing, forever, with "this needed the word RUN typed" — said
   * to somebody who typed exactly what this dialog asked for.
   *
   * So the job's word is collected as itself and stored as itself, and the rule's
   * word stays what it always was: the gate on writing a standing authorisation,
   * recorded on the RULE rather than in the approval. Folding either into the
   * other is what broke it.
   *
   * The result is strictly stronger than the one-shot door rather than equal to
   * it: a destructive rule asks for everything the same job would ask for, and
   * then asks whether you meant it to keep happening.
   */
  const planPhrase =
    plan !== null && plan.confirmation.kind === 'type-to-confirm' ? plan.confirmation.phrase : null
  const jobPhraseOk = planPhrase === null || jobPhrase.trim() === planPhrase
  const jobIncomplete = actionType === 'job' && (spec.steps.length === 0 || targets.length === 0)
  const canCreate = name.trim() !== '' && !jobIncomplete && phraseOk && jobPhraseOk

  const reset = (): void => {
    setOpen(false)
    setName('')
    setHostFilter('')
    setMinValue('')
    setTitle('')
    setCommands('')
    setTargetIds([])
    setPhrase('')
    setJobPhrase('')
    setActionType('notify')
  }

  const create = async (): Promise<void> => {
    if (!canCreate) return
    const fn = bridge()?.create
    if (typeof fn !== 'function') {
      setError(t('monitor.rules.error.noCreate'))
      return
    }
    const confirmedAt = Date.now()
    const action: RuleAction =
      actionType === 'job'
        ? {
            type: 'job',
            spec,
            targets,
            // Minted HERE, at the moment the dialog is satisfied, over exactly
            // the spec and target list the rule will keep. Main re-derives
            // planJob over the same pair on every firing and refuses if the two
            // disagree — the same door a job goes through, taken for the same
            // reason.
            // The idiom every other approval producer uses: the phrase recorded
            // is the one THIS PLAN asked for, or null when it asked for none.
            // The rule's own `UNATTENDED` word is not an approval phrase and
            // does not go in here — it is asserted below and recorded on the
            // rule by main.
            approval: jobApprovalFor(spec, targets, {
              phrase: planPhrase === null ? null : jobPhrase.trim(),
              confirmedAt
            })
          }
        : { type: 'notify' }

    const draft: RuleDraftWire = {
      name: name.trim(),
      trigger: { kind, event },
      filter: {
        ...(hostFilter !== '' ? { serverId: hostFilter } : {}),
        ...(minValue.trim() !== '' && Number.isFinite(Number(minValue))
          ? { minValue: Number(minValue) }
          : {})
      },
      limit: { maxFirings, windowMs },
      action,
      // The escalated gate, asserted across the boundary rather than left as a
      // fact about this component's state. `RuleEngine.create` refuses a job
      // rule without it — see the note on `RuleDraftWire.unattended`.
      ...(actionType === 'job' ? { unattended: true } : {})
    }
    try {
      const created = await fn(draft)
      if (!created) {
        setError(t('monitor.rules.error.refused'))
        return
      }
      setError(null)
      reset()
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const toggle = async (id: string, enabled: boolean): Promise<void> => {
    const fn = bridge()?.setEnabled
    if (typeof fn !== 'function') return
    await fn(id, enabled)
    await refresh()
  }

  const remove = async (id: string): Promise<void> => {
    const fn = bridge()?.remove
    if (typeof fn !== 'function') return
    await fn(id)
    await refresh()
  }

  return (
    // Header outside the card, content in it — the same shape Inventory and
    // Security posture now wear. This panel used to put the header outside and
    // have no card at all, which is the other half of the same inconsistency.
    // "New rule" keeps the solid accent: it is the one action here that changes
    // anything, which is exactly what the accent is reserved for.
    <PanelShell
      icon={<Zap size={14} />}
      title={t('modules.rules.label')}
      about={<p>{t('monitor.rules.about')}</p>}
      actions={
        <button className="btn primary sm" onClick={() => setOpen((v) => !v)}>
          <Plus size={14} /> {t('monitor.rules.newRule')}
        </button>
      }
    >
      {/* Why this tab is here when the module switch says it should not be.
          The engine sweeps in main and does not read the module state, so
          hiding this panel would have hidden the only list of what is armed and
          the only control that disarms it, while the rules kept running. Shown
          only in that combination — switched off, and something still armed —
          so an ordinary install never sees it. */}
      {moduleOff && (
        <div className="row state-warn" style={{ gap: 6 }}>
          <AlertTriangle size={14} />
          <span>{t('monitor.rules.moduleOff')}</span>
        </div>
      )}

      {error !== null && (
        <div className="row state-alarm" style={{ gap: 6 }}>
          <AlertTriangle size={14} />
          {error}
        </div>
      )}

      {open && (
        <div className="card col" style={{ gap: 10, padding: 12 }}>
          <label className="col" style={{ gap: 4 }}>
            {t('monitor.rules.form.name')}
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('monitor.rules.form.namePlaceholder')}
            />
          </label>

          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <label className="col" style={{ gap: 4 }}>
              {t('monitor.rules.form.when')}
              <select value={kind} onChange={(e) => setKind(e.target.value as RuleAlertKind)}>
                {RULE_ALERT_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {t(KIND_LABEL[k])}
                  </option>
                ))}
              </select>
            </label>
            <label className="col" style={{ gap: 4 }}>
              {t('monitor.rules.form.is')}
              <select value={event} onChange={(e) => setEvent(e.target.value as RuleTriggerEvent)}>
                <option value="raised">{t('monitor.rules.form.eventRaised')}</option>
                <option value="resolved">{t('monitor.rules.form.eventResolved')}</option>
              </select>
            </label>
            <label className="col" style={{ gap: 4 }}>
              {t('monitor.rules.form.on')}
              <select value={hostFilter} onChange={(e) => setHostFilter(e.target.value)}>
                <option value="">{t('monitor.rules.form.anyServer')}</option>
                {servers.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="col" style={{ gap: 4 }}>
              {t('monitor.rules.form.atOrAbove')}
              <input
                value={minValue}
                onChange={(e) => setMinValue(e.target.value)}
                placeholder={t('monitor.rules.form.anyReading')}
                inputMode="decimal"
                style={{ width: 100 }}
              />
            </label>
          </div>

          {/* Under the box it is about, not beside the save button. The number
              is a FILTER on an alert the engine has already raised, and a
              tester read it as the threshold itself and filed the silence as a
              bug — see lib/ruleReach.ts. `is-watch` rather than `is-alarm`:
              the rule is valid and will be saved. */}
          {warningFor('minValue') && (
            <div className="panel-note is-watch">{warningFor('minValue')}</div>
          )}

          <div className="row" style={{ gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <label className="col" style={{ gap: 4 }}>
              {t('monitor.rules.form.atMost')}
              <input
                type="number"
                min={1}
                max={RULE_LIMIT_MAX_FIRINGS}
                value={maxFirings}
                aria-label={t('monitor.rules.form.firingsLabel')}
                onChange={(e) => setMaxFirings(Math.max(1, Number(e.target.value) || 1))}
                style={{ width: 70 }}
              />
            </label>
            <label className="col" style={{ gap: 4 }}>
              {t('monitor.rules.form.timesIn')}
              <select value={windowMs} onChange={(e) => setWindowMs(Number(e.target.value))}>
                {WINDOWS.map((w) => (
                  <option key={w.ms} value={w.ms}>
                    {t(w.labelKey)}
                  </option>
                ))}
              </select>
            </label>
            <span className="faint" style={{ paddingBottom: 6 }}>
              {t('monitor.rules.form.ceilingNote')}
            </span>
          </div>

          <div className="row" style={{ gap: 12 }}>
            <label className="row" style={{ gap: 4 }}>
              <input
                type="radio"
                name="rule-action"
                checked={actionType === 'notify'}
                onChange={() => setActionType('notify')}
              />
              {t('monitor.rules.form.actionWebhook')}
            </label>
            <label className="row" style={{ gap: 4 }}>
              <input
                type="radio"
                name="rule-action"
                checked={actionType === 'job'}
                onChange={() => setActionType('job')}
              />
              {t('monitor.rules.form.actionJob')}
            </label>
          </div>

          {warningFor('action') && (
            <div className="panel-note is-watch">{warningFor('action')}</div>
          )}

          {actionType === 'job' && (
            <div className="col" style={{ gap: 8 }}>
              <label className="col" style={{ gap: 4 }}>
                {t('monitor.rules.form.jobTitle')}
                <input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder={t('monitor.rules.form.jobTitlePlaceholder')}
                />
              </label>
              <label className="col" style={{ gap: 4 }}>
                {t('monitor.rules.form.commands')}
                <textarea
                  rows={3}
                  value={commands}
                  onChange={(e) => setCommands(e.target.value)}
                  placeholder="journalctl --vacuum-size=200M"
                />
              </label>
              <div className="col" style={{ gap: 4 }}>
                {t('monitor.rules.form.servers')}
                <div className="col" style={{ gap: 2, maxHeight: 160, overflowY: 'auto' }}>
                  {servers.map((s) => (
                    <label key={s.id} className="row" style={{ gap: 6 }}>
                      <input
                        type="checkbox"
                        checked={targetIds.includes(s.id)}
                        onChange={(e) =>
                          setTargetIds((ids) =>
                            e.target.checked ? [...ids, s.id] : ids.filter((i) => i !== s.id)
                          )
                        }
                      />
                      {s.name}
                    </label>
                  ))}
                </div>
              </div>

              {plan !== null && (
                <div className="col" style={{ gap: 2 }}>
                  <div>
                    <Trans
                      i18nKey="monitor.rules.form.blastRadius"
                      values={{ count: plan.blastRadius, risk: plan.risk }}
                      components={FAINT}
                    />
                  </div>
                  {plan.reasons.map((r) => (
                    <div key={r} className="faint">
                      {r}
                    </div>
                  ))}
                </div>
              )}

              {/* The job's own door, shown only when this job would demand it as
                  a one-off. Two boxes rather than one because they are two
                  different agreements: this one is "yes, run that command on
                  those servers", the one below is "yes, keep doing it without
                  me". Collapsing them is what broke the record — see
                  `planPhrase`. */}
              {planPhrase !== null && (
                <label className="col" style={{ gap: 4 }}>
                  <Trans
                    i18nKey="monitor.rules.form.jobPhrase"
                    values={{ phrase: planPhrase }}
                    components={{ b: <b /> }}
                  />
                  <input
                    value={jobPhrase}
                    aria-label={t('monitor.rules.form.jobPhraseLabel', { phrase: planPhrase })}
                    onChange={(e) => setJobPhrase(e.target.value)}
                  />
                </label>
              )}

              <label className="col" style={{ gap: 4 }}>
                {/* Always typed, for a job rule. `planJob` would ask for a click
                    here; a standing authorisation is a different thing being
                    agreed to, and the word says which one. */}
                <Trans
                  i18nKey="monitor.rules.form.unattended"
                  values={{ phrase: RULE_UNATTENDED_PHRASE }}
                  components={{ b: <b /> }}
                />
                <input
                  value={phrase}
                  aria-label={t('monitor.rules.form.unattendedLabel', {
                    phrase: RULE_UNATTENDED_PHRASE
                  })}
                  onChange={(e) => setPhrase(e.target.value)}
                />
              </label>
            </div>
          )}

          <div className="row" style={{ gap: 8 }}>
            <button className="btn primary" disabled={!canCreate} onClick={() => void create()}>
              <Zap size={14} /> {t('monitor.rules.form.create')}
            </button>
            <button className="btn ghost" onClick={reset}>
              {t('common.cancel')}
            </button>
          </div>
        </div>
      )}

      {noBridge ? (
        <div className="panel-note is-alarm">
          {t('monitor.rules.noBridge')}
        </div>
      ) : rules === null ? (
        <div className="panel-empty">
          <p className="panel-empty-title">{t('monitor.rules.reading')}</p>
        </div>
      ) : rules.length === 0 ? (
        // Was one grey sentence with no next step. The sentence is kept —
        // "nothing runs on its own" is the reassurance a rules screen owes the
        // reader — and now it says what to do about it.
        <div className="panel-empty">
          <p className="panel-empty-title">{t('monitor.rules.empty.title')}</p>
          <p className="panel-empty-body">
            <Trans i18nKey="monitor.rules.empty.body" components={{ b: <b /> }} />
          </p>
        </div>
      ) : (
        rules.map((r) => (
          <RuleCard
            key={r.id}
            rule={r}
            servers={servers}
            onToggle={(enabled) => void toggle(r.id, enabled)}
            onRemove={() => void remove(r.id)}
          />
        ))
      )}
    </PanelShell>
  )
}
