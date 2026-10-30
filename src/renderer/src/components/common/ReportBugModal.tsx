import React, { useCallback, useEffect, useState } from 'react'
import { Modal } from './Modal'
import { bridgeHas } from '../../lib/bridge'
import { issueUrl } from '../../lib/reportBug'
import { useApp } from '../../store/app'
import { toast } from '../../store/toast'
import type { DebugBundle } from '../../../../shared/debug'
import { useT } from '../../lib/i18n'
import { Trans } from '../../lib/Trans'

/**
 * The dialog the bug button opens.
 *
 * WHY A DIALOG AT ALL, WHEN THE POINT WAS ONE CLICK
 *
 * The press used to do everything silently: write a file into the downloads
 * folder, copy the text, open GitHub. Three things were wrong with that and the
 * dialog is what fixes all three at once. The file was never agreed to. The
 * toast claimed it had been saved whenever nothing threw — which included every
 * time the user cancelled Electron's save dialog. And nothing anywhere said
 * what the app had just done, so the honest summary of the feature was that it
 * did something, somewhere, and you found out by looking in your downloads.
 *
 * It also has to teach a protocol that did not exist before: a report is far
 * more useful with a recording, a recording only exists if you start it BEFORE
 * the bug happens, and nobody is going to guess that. Three numbered steps, on
 * screen at once, is the smallest thing that says so.
 *
 * WHY STEP 1 HAS A BUTTON AND NOT A SENTENCE POINTING AT SETTINGS
 *
 * It said "turn on Settings → Advanced → Debug mode" first, and that is the
 * exact failure this whole feature was built against. Reporting a bug used to
 * begin with knowing to look in Settings → Advanced, which is a path only
 * somebody who already knows the app can walk — the wrong half of the user base
 * for a bug report — and putting the recording there just moved the same step
 * one screen later. A dialog that asks for something and then sends you
 * somewhere else to do it has not asked for it.
 *
 * So the control is HERE, one press from the rail icon that is on screen in
 * every view. Settings → Advanced still shows the trace's size and offers the
 * Delete button, because that is a thing you go looking for; it is no longer
 * how anyone starts.
 *
 * THE PREVIEW IS A GATE HERE, NOT A COURTESY
 *
 * Settings and the crash card show the diagnostics text before copying it, and
 * could skip it: that payload is versions, counts and booleans, with nothing in
 * it to read and decide about. This report is different in kind. Its trace
 * carries error text, and an error names what it failed to reach — a hostname,
 * a username, a path, whatever a remote server chose to print. `redactOutput`
 * removes secrets at the writer and cannot remove a hostname, because no rule
 * tells a host from a word. So nothing is written, and no browser opens, until
 * the text has been on screen and the user has pressed the button under it.
 *
 * And it is SAVED, never copied. An attachment is inert; pasted text renders as
 * Markdown and is read by automation. CONTRIBUTING.md draws that line for long
 * logs already.
 */
export function ReportBugModal(): React.JSX.Element {
  const t = useT()
  const close = useApp((s) => s.setModal)
  const settings = useApp((s) => s.settings)
  const setSettings = useApp((s) => s.setSettings)
  const recording = settings.debugLogEnabled === true

  const [bundle, setBundle] = useState<DebugBundle | null>(null)
  const [failed, setFailed] = useState(false)
  const [savedPath, setSavedPath] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // Opening the report ENDS the capture, which is the half of the protocol the
  // user should not have to remember: pressing Report is the moment they have
  // finished reproducing. It goes through `setSettings` rather than a channel
  // of its own, so main hears about it on the same `data:save` as any other
  // setting and the toggle in Settings cannot disagree with this.
  const build = useCallback(async (): Promise<void> => {
    if (recording) setSettings({ debugLogEnabled: false })
    const api = window.opsmaxx?.debug
    if (!bridgeHas(api as Record<string, unknown> | undefined, 'build')) {
      setFailed(true)
      return
    }
    const built = await api?.build().catch(() => null)
    if (built == null) setFailed(true)
    else setBundle(built)
  }, [recording, setSettings])

  useEffect(() => {
    void build()
    // Once, on open. `build` closes over `recording`, and rebuilding when that
    // flips would rebuild the report the act of building just switched off.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const save = async (): Promise<void> => {
    if (bundle === null) return
    const api = window.opsmaxx?.debug
    if (!bridgeHas(api as Record<string, unknown> | undefined, 'save')) return
    setBusy(true)
    const res = await api
      ?.save(bundle.text)
      .catch((err: unknown) => ({ ok: false as const, error: String(err) }))
    setBusy(false)
    if (res === undefined) return
    if (res.ok) {
      setSavedPath(res.path)
      // The form opens only now, and only on a real write: a browser tab that
      // took the focus before the file existed is what made the old path's
      // ordering load-bearing in the first place.
      window.open(issueUrl(bundle.version, bundle.os), '_blank', 'noopener,noreferrer')
      return
    }
    if ('cancelled' in res) toast(t('ui.reportBug.cancelled'), 'info')
    else toast(t('ui.reportBug.saveFailed', { error: res.error }), 'error')
  }

  // A step may carry its own control, which is the whole point of step 1: the
  // thing it asks for has to be doable from here.
  const step = (
    n: number,
    title: string,
    body: React.ReactNode,
    action?: React.ReactNode
  ): React.JSX.Element => (
    <div className="setting-row">
      <div className="s-info">
        <div className="s-title">
          {n}. {title}
        </div>
        <div className="s-desc">{body}</div>
      </div>
      {action}
    </div>
  )

  /**
   * Turn the recording on and get out of the way.
   *
   * The dialog CLOSES rather than staying open with a spinner, because what it
   * has just asked for is "go and make the bug happen", and the app is where
   * that happens. The rail keeps the dot for as long as it runs, so the thing
   * that was started is still visible and the control that stops it is the one
   * the user just pressed.
   */
  const startRecording = (): void => {
    setSettings({ debugLogEnabled: true })
    close(null)
    toast(t('ui.reportBug.recordingToast'), 'ok')
  }

  return (
    <Modal
      title={t('ui.reportBug.title')}
      subtitle={t('ui.reportBug.subtitle')}
      onClose={() => close(null)}
      size="lg"
      cancelLabel={t(savedPath === null ? 'common.cancel' : 'common.done')}
      confirm={
        savedPath === null
          ? {
              label: t(busy ? 'common.saving' : 'ui.reportBug.save'),
              onClick: () => void save(),
              disabled: bundle === null || busy
            }
          : undefined
      }
      footerNote={
        savedPath === null
          ? bundle === null
            ? failed
              ? t('ui.reportBug.notCollectedNote')
              : t('ui.reportBug.collecting')
            : t('ui.reportBug.events', { count: bundle.events })
          : t('ui.reportBug.attachNote')
      }
    >
      {step(
        1,
        t(recording ? 'ui.reportBug.recordTitleRecording' : 'ui.reportBug.recordTitle'),
        recording ? (
          t('ui.reportBug.recordBodyRecording')
        ) : (
          <Trans i18nKey="ui.reportBug.recordBody" components={{ em: <em />, strong: <strong /> }} />
        ),
        recording ? undefined : (
          <button className="btn sm" onClick={startRecording}>
            {t('ui.reportBug.startRecording')}
          </button>
        )
      )}

      {step(
        2,
        t('ui.reportBug.readTitle'),
        <Trans i18nKey="ui.reportBug.readBody" components={{ strong: <strong /> }} />
      )}

      <pre className="paste-preview selectable">
        {bundle?.text ??
          t(failed ? 'ui.reportBug.notCollected' : 'ui.reportBug.collecting')}
      </pre>

      {step(
        3,
        t('ui.reportBug.attachTitle'),
        savedPath === null ? (
          <Trans i18nKey="ui.reportBug.attachBody" components={{ strong: <strong /> }} />
        ) : (
          <Trans
            i18nKey="ui.reportBug.savedBody"
            values={{ path: savedPath }}
            components={{ code: <code /> }}
          />
        )
      )}
    </Modal>
  )
}
