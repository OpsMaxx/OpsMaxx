import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, CornerDownLeft } from 'lucide-react'
import { useApp } from '../../store/app'
import { useOnboarding } from '../../store/onboarding'
import { useUpdater } from '../../store/updater'
import { clsx } from '../../lib/format'
import { approvalShowing } from '../../hooks/useClickOutside'
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
 * ONE DECISION PER SCREEN. It used to be one screen holding all of them, and the
 * header of setupQuestions.ts records why that was reversed. What matters here is
 * what the reversal was not allowed to cost: somebody who commits without reading
 * must still get a fuller app and nothing that writes to a server. Enter ADVANCES
 * rather than commits, so pressing it through every screen commits exactly the
 * defaults a single press used to, and those defaults are unchanged.
 *
 * Escape still accepts and leaves, and now also accepts the defaults for the
 * questions it never reached. Those are read-only by construction — see
 * `preselected` in setupQuestions.ts — which is what makes it safe to offer.
 *
 * The answers are never re-asked; Settings › Modules is the permanent home for
 * all the module switches and the last screen says so on its way out.
 */

/**
 * The index of the review screen, derived rather than written down.
 *
 * Screen 0 is the persona, screens 1..N are `SETUP_QUESTIONS` in order, and the
 * one after them reviews. Deriving it is what stops a fifth question from
 * producing a wizard that silently skips it.
 */
const LAST = SETUP_QUESTIONS.length + 1

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
  // Which preference groups are expanded on the review screen. They start shut:
  // they all have working defaults, and the rule in setupQuestions.ts means the
  // right outcome for most installs is to open none of them.
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({})
  const [step, setStep] = useState(0)
  // Focus lands here on every step change, so a screen reader reads the new
  // question rather than staying on a button that has just unmounted.
  const headingRef = useRef<HTMLHeadingElement>(null)

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

  const goNext = (): void => {
    if (step === LAST) commit()
    else setStep((s) => Math.min(s + 1, LAST))
  }
  const goBack = (): void => setStep((s) => Math.max(s - 1, 0))

  /**
   * Answer a question and move on.
   *
   * One click per screen rather than two. The footer's Next stays the "keep what
   * is shown, change nothing" path, which is what a preselected answer needs.
   */
  const answer = (id: string, value: boolean): void => {
    setAnswers((a) => ({ ...a, [id]: value }))
    goNext()
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
   *
   * Deliberately does NOT advance, where answering a question does. Picking one
   * fills in four questions the user has not seen yet; skipping off the screen the
   * instant it happens would hide the only thing that just took place.
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
      // The approval layer is above this card. Enter on an approval's button
      // would otherwise also advance a step here, and Escape commit the card.
      if (approvalShowing()) return
      // Escape commits what has been answered so far, plus the defaults for
      // anything not yet reached, rather than cancelling: there is nothing to
      // cancel back to, and leaving a new install with most of the modules off is
      // the outcome this card exists to prevent. Safe because the unreached
      // defaults only ever read -- see `preselected`.
      if (e.key === 'Escape') {
        e.preventDefault()
        commit()
        return
      }
      if (e.key !== 'Enter') return
      // A held Enter would otherwise fly through all six screens in a few frames
      // and commit before anything had been on screen long enough to read.
      if (e.repeat) return
      // A focused button fires its own click on Enter. Without this the keystroke
      // would both answer the question and advance again -- two screens per press.
      // Safe to stand down, because every step change puts focus on the heading.
      if ((e.target as HTMLElement | null)?.closest?.('button, select, summary, a')) return
      e.preventDefault()
      goNext()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  useEffect(() => {
    if (!open) return
    headingRef.current?.focus()
  }, [open, step])

  if (!open) return null

  const question = SETUP_QUESTIONS[step - 1]
  const onReview = step === LAST

  return (
    <div className="setup-scrim" role="dialog" aria-modal="true" aria-labelledby="setup-title">
      <div className="setup-card">
        <header className="setup-head">
          <span className="setup-brand">Set up OpsMaxx</span>
          <span className="setup-steps">
            <span className="setup-dots" aria-hidden="true">
              {Array.from({ length: LAST + 1 }, (_, n) => (
                <span key={n} className={clsx('setup-dot', n === step && 'on')} />
              ))}
            </span>
            {/* The dots are decoration; this is the part that is announced. */}
            <span className="setup-step-count" aria-live="polite">
              Step {step + 1} of {LAST + 1}
            </span>
          </span>
        </header>

        <div className="setup-step">
          {step === 0 && (
            <PersonaStep
              headingRef={headingRef}
              persona={persona}
              onChoose={choosePersona}
            />
          )}

          {question && (
            <QuestionStep
              key={question.id}
              headingRef={headingRef}
              question={question.question}
              detail={question.detail}
              cost={question.cost}
              value={answers[question.id] === true}
              onAnswer={(v) => answer(question.id, v)}
            />
          )}

          {onReview && (
            <ReviewStep
              headingRef={headingRef}
              answers={answers}
              prefs={prefs}
              openGroups={openGroups}
              onGoToQuestion={(n) => setStep(n + 1)}
              onToggleGroup={(id, isOpen) => setOpenGroups((o) => ({ ...o, [id]: isOpen }))}
              onPick={(key, v) => setPrefs((cur) => ({ ...cur, [key]: v }))}
            />
          )}
        </div>

        <footer className="setup-foot">
          {/* Rendered rather than disabled on the first screen: a permanently
              dead control reads as something broken. */}
          {step > 0 && (
            <button type="button" className="btn sm" onClick={goBack}>
              <ArrowLeft size={13} />
              Back
            </button>
          )}
          {onReview && <ReviewHint answers={answers} prefs={prefs} />}
          <button type="button" className="btn primary" onClick={goNext}>
            {onReview ? (
              <>
                Start
                <CornerDownLeft size={14} />
              </>
            ) : (
              <>
                {/* Skip, not Next, while nothing has been picked -- the persona is
                    optional and the button should say so rather than implying an
                    answer is owed. */}
                {step === 0 && persona === null ? 'Skip' : 'Next'}
                <ArrowRight size={14} />
              </>
            )}
          </button>
        </footer>
      </div>
    </div>
  )
}

/**
 * Screen 0. One decision that fills in all the others, and nothing is
 * preselected: picking one is a deliberate act, because the DevOps preset can
 * enable modules that write to servers. See DEFAULT_PERSONA_ID.
 */
function PersonaStep({
  headingRef,
  persona,
  onChoose
}: {
  headingRef: React.RefObject<HTMLHeadingElement | null>
  persona: string | null
  onChoose: (id: string) => void
}): React.JSX.Element {
  return (
    <>
      <h1 id="setup-title" className="setup-step-title" ref={headingRef} tabIndex={-1}>
        What do you do?
      </h1>
      <p className="setup-q-detail">
        Optional — it answers the next four questions for you, and every one stays editable.
        Nothing you choose here is permanent.
      </p>
      <div className="setup-persona-row">
        {PERSONAS.map((p) => (
          <button
            key={p.id}
            type="button"
            className={clsx('setup-persona', persona === p.id && 'on')}
            aria-pressed={persona === p.id}
            onClick={() => onChoose(p.id)}
          >
            <span className="setup-persona-title">{p.label}</span>
            <span className="setup-persona-detail">{p.detail}</span>
          </button>
        ))}
      </div>
    </>
  )
}

/**
 * One module question, alone on a screen.
 *
 * The cost line is rendered plainly, beside the question rather than behind a
 * disclosure. A screen holding one question has more room for it than the list
 * ever did, and it is the line that says which of these write to a server.
 */
function QuestionStep({
  headingRef,
  question,
  detail,
  cost,
  value,
  onAnswer
}: {
  headingRef: React.RefObject<HTMLHeadingElement | null>
  question: string
  detail: string
  cost: string
  value: boolean
  onAnswer: (v: boolean) => void
}): React.JSX.Element {
  return (
    <>
      <h1 id="setup-title" className="setup-step-title" ref={headingRef} tabIndex={-1}>
        {question}
      </h1>
      <p className="setup-q-detail">{detail}</p>
      <p className="setup-q-cost">{cost}</p>
      <div className="setup-yesno" role="radiogroup" aria-label={question}>
        <button
          type="button"
          role="radio"
          aria-checked={value}
          className={clsx('setup-yn', value && 'on')}
          onClick={() => onAnswer(true)}
        >
          Yes
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={!value}
          className={clsx('setup-yn', !value && 'on')}
          onClick={() => onAnswer(false)}
        >
          No
        </button>
      </div>
    </>
  )
}

/** The last screen: what was answered, and the preferences still collapsed. */
function ReviewStep({
  headingRef,
  answers,
  prefs,
  openGroups,
  onGoToQuestion,
  onToggleGroup,
  onPick
}: {
  headingRef: React.RefObject<HTMLHeadingElement | null>
  answers: Record<string, boolean>
  prefs: PrefAnswers
  openGroups: Record<string, boolean>
  onGoToQuestion: (index: number) => void
  onToggleGroup: (id: string, open: boolean) => void
  onPick: (key: keyof PrefAnswers, value: string | number | boolean) => void
}): React.JSX.Element {
  return (
    <>
      <h1 id="setup-title" className="setup-step-title" ref={headingRef} tabIndex={-1}>
        Ready when you are
      </h1>
      <p className="setup-q-detail">Click any answer to go back and change it.</p>
      <ul className="setup-review-list">
        {SETUP_QUESTIONS.map((q, n) => {
          const on = answers[q.id] === true
          return (
            <li key={q.id}>
              <button type="button" className="setup-review-row" onClick={() => onGoToQuestion(n)}>
                <span className="setup-review-q">{q.question}</span>
                <span className={clsx('setup-review-a', on && 'on')}>{on ? 'Yes' : 'No'}</span>
              </button>
            </li>
          )
        })}
      </ul>

      {/* Preferences, collapsed. Native <details> rather than hand-rolled
          disclosure state: it is keyboard-operable, screen-reader-announced and
          findable by the browser's own in-page search for free. They stay a
          disclosure rather than becoming ten more screens -- they all have
          working defaults, and this is the one part of the card most people
          should walk past. */}
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
            onToggle={(e) => onToggleGroup(g.id, (e.target as HTMLDetailsElement).open)}
          >
            <summary className="setup-group-head">
              <span className="setup-group-title">{g.label}</span>
              {/* The current value in the closed header, so the group can be read
                  without opening it. */}
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
                  onPick={(v) => onPick(c.key, v)}
                />
              ))}
          </details>
        ))}
      </section>
    </>
  )
}

/** The counts, and the sentence about what this card deliberately cannot reach. */
function ReviewHint({
  answers,
  prefs
}: {
  answers: Record<string, boolean>
  prefs: PrefAnswers
}): React.JSX.Element {
  const onCount = SETUP_QUESTIONS.filter((q) => answers[q.id] === true).reduce(
    (n, q) => n + q.modules.length,
    0
  )
  // One patch, read three ways. Computed with the same function the commit uses,
  // so the count here cannot disagree with what gets saved.
  const patch = setupPatch(prefs)
  const prefCount =
    Object.keys(patch.settings).length + Object.keys(patch.update).length + (patch.theme ? 1 : 0)

  return (
    <span className="setup-hint">
      {onCount} module{onCount === 1 ? '' : 's'} on
      {prefCount > 0 && `, ${prefCount} preference${prefCount === 1 ? '' : 's'} changed`}. Anything
      not listed here &mdash; revoking keys, unattended rules, reading other accounts&rsquo; access
      &mdash; stays off and lives in Settings.
    </span>
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
