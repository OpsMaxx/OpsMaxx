import { useEffect, useState } from 'react'
import { Check, CornerDownLeft } from 'lucide-react'
import { useApp } from '../../store/app'
import { useOnboarding } from '../../store/onboarding'
import { clsx } from '../../lib/format'
import { SETUP_QUESTIONS, applySetupAnswers, defaultSetupAnswers } from './setupQuestions'

/**
 * The first thing a new install shows.
 *
 * Deliberately a modal, where the tour that follows it deliberately is not:
 * the tour describes a running app and must not cover it, while this asks a
 * question and needs an answer. It is also the only modal in the first-run
 * path — the vault is not forced, and importing `~/.ssh/config` is offered by
 * the empty state rather than demanded here.
 *
 * Three groups on one screen, not three steps. Everything is visible at once,
 * Enter accepts, Escape takes the defaults and leaves. The answers are never
 * re-asked; Settings › Modules is the permanent home for all twenty switches
 * and this card says so on its way out.
 */
export function SetupCard(): React.JSX.Element | null {
  const open = useOnboarding((s) => s.setupOpen)
  const finishSetup = useOnboarding((s) => s.finishSetup)
  const settings = useApp((s) => s.settings)
  const setSettings = useApp((s) => s.setSettings)
  const [answers, setAnswers] = useState(defaultSetupAnswers)

  const commit = (): void => {
    setSettings({ modules: applySetupAnswers(settings.modules, answers) })
    finishSetup()
  }

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      // Enter commits what is on screen, which for an untouched card is the
      // preselected set. Escape does the same rather than cancelling: there is
      // nothing to cancel back to, and leaving a new install with fifteen
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

  return (
    <div className="setup-scrim" role="dialog" aria-modal="true" aria-labelledby="setup-title">
      <div className="setup-card">
        <header className="setup-head">
          <h1 id="setup-title">Which parts of OpsMaxx do you want?</h1>
          <p>
            Three questions, asked once. Everything here is also in Settings › Modules, so nothing
            you choose now is permanent.
          </p>
        </header>

        <div className="setup-questions">
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
        </div>

        <footer className="setup-foot">
          <span className="setup-hint">
            Anything not listed here — revoking keys, unattended rules, reading other accounts&rsquo;
            access — stays off and lives in Settings.
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
