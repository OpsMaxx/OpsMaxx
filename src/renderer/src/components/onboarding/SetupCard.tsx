import { useEffect, useState } from 'react'
import { Check, CornerDownLeft } from 'lucide-react'
import { useApp } from '../../store/app'
import { useOnboarding } from '../../store/onboarding'
import { useUpdater } from '../../store/updater'
import { clsx } from '../../lib/format'
import {
  DEFAULT_PERSONA_ID,
  PERSONAS,
  PREF_GROUPS,
  SETUP_QUESTIONS,
  applySetupAnswers,
  defaultSetupAnswers,
  personaAnswers,
  prefAvailable,
  prefSummary,
  prefValue,
  setupPatch,
  type PrefAnswers,
  type PrefControl
} from './setupQuestions'

/**
 * The first thing a new install shows.
 *
 * Deliberately a modal, where the tour that follows it deliberately is not:
 * the tour describes a running app and must not cover it, while this asks a
 * question and needs an answer. It is also the only modal in the first-run
 * path — the vault is not forced, and importing `~/.ssh/config` is offered by
 * the empty state rather than demanded here.
 *
 * ONE SCREEN, NOT A WIZARD, and it still is one after growing a persona row and
 * four groups of preferences. The module questions are open; the preference
 * groups are collapsed with their current values in their own headers. So the
 * card is still answerable with a single keystroke without reading it, and every
 * additional decision is one disclosure away rather than one screen away — see
 * the header of setupQuestions.ts for why that distinction is the whole point.
 *
 * Enter accepts, Escape accepts. The answers are never re-asked; Settings ›
 * Modules is the permanent home for all the module switches and this card says so
 * on its way out.
 */
export function SetupCard(): React.JSX.Element | null {
  const open = useOnboarding((s) => s.setupOpen)
  const finishSetup = useOnboarding((s) => s.finishSetup)
  const settings = useApp((s) => s.settings)
  const setSettings = useApp((s) => s.setSettings)
  const setTheme = useApp((s) => s.setTheme)
  const setUpdatePrefs = useUpdater((s) => s.setPrefs)
  const [answers, setAnswers] = useState(defaultSetupAnswers)
  const [persona, setPersona] = useState<string | null>(DEFAULT_PERSONA_ID)
  const [prefs, setPrefs] = useState<PrefAnswers>({})
  // Which groups are expanded. Modules is open because it is what the card is
  // for; the preference groups start shut so the screen stays one glance.
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({})

  const commit = (): void => {
    const patch = setupPatch(prefs)
    // Modules and the settings patch go together in one `setSettings`, because
    // they land in the same persisted blob and two calls would be two saves.
    setSettings({ modules: applySetupAnswers(settings.modules, answers), ...patch.settings })
    // Theme is top-level store state with its own setter; App.tsx applies it in
    // an effect, so this is all that is needed to put it on screen.
    if (patch.theme) setTheme(patch.theme)
    // Update preferences are owned by MAIN in its own file -- the launch check
    // runs before a window exists -- so they cross the bridge rather than going
    // into the blob. Skipped entirely when untouched: see setupPatch.
    if (Object.keys(patch.update).length > 0) setUpdatePrefs(patch.update)
    finishSetup()
  }

  /**
   * Apply a persona.
   *
   * It fills the form rather than committing anything: every control stays
   * editable afterwards, and changing one by hand does not clear the chip -- the
   * persona was a starting point, and saying "you are no longer a DevOps engineer
   * because you unticked one box" would be the card arguing with the user.
   *
   * Preferences are MERGED over what is already there rather than replacing it, so
   * a persona cannot silently undo something the user opened a group to set.
   */
  const choosePersona = (id: string): void => {
    const p = PERSONAS.find((x) => x.id === id)
    if (!p) return
    setPersona(id)
    setAnswers(personaAnswers(p))
    setPrefs((cur) => ({ ...p.prefs, ...cur }))
  }

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      // Enter commits what is on screen, which for an untouched card is the
      // preselected set. Escape does the same rather than cancelling: there is
      // nothing to cancel back to, and leaving a new install with most of the
      // modules off is the outcome this card exists to prevent.
      if (e.key === 'Enter' || e.key === 'Escape') {
        e.preventDefault()
        commit()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  if (!open) return null

  const onCount = SETUP_QUESTIONS.filter((q) => answers[q.id] === true).reduce(
    (n, q) => n + q.modules.length,
    0
  )
  // One patch, read three ways. Computed once: it is the same function the
  // commit uses, so the count in the footer cannot disagree with what gets saved.
  const patch = setupPatch(prefs)
  const prefCount =
    Object.keys(patch.settings).length +
    Object.keys(patch.update).length +
    (patch.theme ? 1 : 0)

  return (
    <div className="setup-scrim" role="dialog" aria-modal="true" aria-labelledby="setup-title">
      <div className="setup-card">
        <header className="setup-head">
          <h1 id="setup-title">Let&rsquo;s set up OpsMaxx</h1>
          <p>
            Answered once, and everything here is also in Settings — so nothing you choose now is
            permanent.
          </p>
        </header>

        {/* The persona row. One decision that fills in all the others, and
            nothing is preselected: picking one is a deliberate act, because the
            DevOps preset can enable modules that write to servers. See
            DEFAULT_PERSONA_ID. */}
        <section className="setup-personas" aria-labelledby="setup-persona-label">
          <h2 id="setup-persona-label" className="setup-section-label">
            What do you do?
            <span className="setup-section-hint">Sets everything below. Optional.</span>
          </h2>
          <div className="setup-persona-row">
            {PERSONAS.map((p) => (
              <button
                key={p.id}
                type="button"
                className={clsx('setup-persona', persona === p.id && 'on')}
                aria-pressed={persona === p.id}
                onClick={() => choosePersona(p.id)}
              >
                <span className="setup-persona-title">{p.label}</span>
                <span className="setup-persona-detail">{p.detail}</span>
              </button>
            ))}
          </div>
        </section>

        <section className="setup-questions" aria-labelledby="setup-modules-label">
          <h2 id="setup-modules-label" className="setup-section-label">
            Which parts do you want?
          </h2>
          {SETUP_QUESTIONS.map((q) => {
            const on = answers[q.id] === true
            return (
              <button
                key={q.id}
                type="button"
                className={clsx('setup-q', on && 'on')}
                aria-pressed={on}
                onClick={() => setAnswers((a) => ({ ...a, [q.id]: !on }))}
              >
                <span className={clsx('setup-tick', on && 'on')} aria-hidden="true">
                  {on && <Check size={13} strokeWidth={3} />}
                </span>
                <span className="setup-q-body">
                  <span className="setup-q-title">{q.question}</span>
                  <span className="setup-q-detail">{q.detail}</span>
                  <span className="setup-q-cost">{q.cost}</span>
                </span>
              </button>
            )
          })}
        </section>

        {/* Preferences, collapsed. Native <details> rather than hand-rolled
            disclosure state: it is keyboard-operable, screen-reader-announced and
            findable by the browser's own in-page search for free. */}
        <section className="setup-prefs" aria-labelledby="setup-prefs-label">
          <h2 id="setup-prefs-label" className="setup-section-label">
            How should it behave?
            <span className="setup-section-hint">Sensible defaults; open one to change it.</span>
          </h2>
          {PREF_GROUPS.map((g) => (
            <details
              key={g.id}
              className="setup-group"
              open={openGroups[g.id] === true}
              onToggle={(e) =>
                setOpenGroups((o) => ({ ...o, [g.id]: (e.target as HTMLDetailsElement).open }))
              }
            >
              <summary className="setup-group-head">
                <span className="setup-group-title">{g.label}</span>
                {/* The current value in the closed header, so the card can be read
                    without opening anything. */}
                <span className="setup-group-value">{prefSummary(g, prefs)}</span>
              </summary>
              <p className="setup-group-detail">{g.detail}</p>
              {g.controls
                .filter((c) => prefAvailable(c, prefs))
                .map((c) => (
                  <PrefRow
                    key={String(c.key)}
                    control={c}
                    prefs={prefs}
                    onPick={(v) => setPrefs((cur) => ({ ...cur, [c.key]: v }))}
                  />
                ))}
            </details>
          ))}
        </section>

        <footer className="setup-foot">
          <span className="setup-hint">
            {onCount} module{onCount === 1 ? '' : 's'} on
            {prefCount > 0 && `, ${prefCount} preference${prefCount === 1 ? '' : 's'} changed`}.
            Anything not listed here &mdash; revoking keys, unattended rules, reading other
            accounts&rsquo; access &mdash; stays off and lives in Settings.
          </span>
          <button type="button" className="btn primary" onClick={commit}>
            Start
            <CornerDownLeft size={14} />
          </button>
        </footer>
      </div>
    </div>
  )
}

/**
 * One preference.
 *
 * Radio buttons up to three options, a dropdown beyond. The split is Hick's law
 * applied honestly rather than a house style: three visible choices are read at a
 * glance and compared, where six are a list to work through — and a select that
 * hides the options also hides the one line that says what each costs.
 */
function PrefRow({
  control,
  prefs,
  onPick
}: {
  control: PrefControl
  prefs: PrefAnswers
  onPick: (v: string | number | boolean) => void
}): React.JSX.Element {
  const current = prefValue(control, prefs)
  const asRadios = control.options.length <= 3

  return (
    <div className="setup-pref">
      <div className="setup-pref-info">
        <span className="setup-pref-title">{control.label}</span>
        <span className="setup-pref-detail">{control.detail}</span>
      </div>
      {asRadios ? (
        <div className="setup-pref-opts" role="radiogroup" aria-label={control.label}>
          {control.options.map((o) => (
            <button
              key={String(o.value)}
              type="button"
              role="radio"
              aria-checked={current === o.value}
              className={clsx('setup-opt', current === o.value && 'on')}
              onClick={() => onPick(o.value)}
              title={o.detail}
            >
              {o.label}
            </button>
          ))}
        </div>
      ) : (
        <select
          className="setup-pref-select"
          aria-label={control.label}
          value={String(current)}
          onChange={(e) => {
            // The option carries the real value; the DOM only ever has strings,
            // and `fleetSamplingIntervalMs` is a number the store does arithmetic
            // on. Matching on the stringified value is what keeps 120000 a number
            // rather than becoming "120000" in the settings file.
            const picked = control.options.find((o) => String(o.value) === e.target.value)
            if (picked) onPick(picked.value)
          }}
        >
          {control.options.map((o) => (
            <option key={String(o.value)} value={String(o.value)}>
              {o.label}
            </option>
          ))}
        </select>
      )}
    </div>
  )
}
