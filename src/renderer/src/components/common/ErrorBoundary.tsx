import { Component, type ErrorInfo, type ReactNode } from 'react'
import { AlertTriangle, Copy, RotateCcw } from 'lucide-react'
import { bridgeHas } from '../../lib/bridge'

interface Props {
  children: ReactNode
}
interface State {
  error: Error | null
  stack: string | null
  /** The diagnostics text, once main has built it. Held in state because it is
   *  SHOWN, not just copied — see `copyDiagnostics`. */
  diagnostics: string | null
}

// Without this, a single render error unmounts the whole tree and leaves an
// empty window with no message and no way back — the user sees a white or
// black screen and loses their sessions with no idea why.
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, stack: null, diagnostics: null }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Goes to the terminal in dev and to the crash log in production.
    console.error('[renderer] unhandled error:', error, info.componentStack)
    const componentStack = info.componentStack ?? null
    this.setState({ stack: componentStack })

    // Built here rather than on the click, so the text is on screen BEFORE the
    // button is pressed. The crash block is the one part of it that carries
    // words nobody here wrote, and this is the only screen that copies it.
    const api = window.opsmaxx?.diagnostics
    if (!bridgeHas(api as Record<string, unknown> | undefined, 'text')) return
    void api
      ?.text({ message: error.message, stack: error.stack ?? null, componentStack })
      .then((text) => this.setState({ diagnostics: text }))
      .catch(() => {
        // No preview and no diagnostics text, so Copy diagnostics stays
        // disabled. There is deliberately no fallback: the only text this
        // screen could substitute is the raw `report()`, and copying that from
        // under a caption promising trimmed paths and stripped secrets is worse
        // than copying nothing. Copy details is still there for the raw text,
        // and says what it is.
      })
  }

  private report = (): string =>
    [
      this.state.error?.message ?? 'Unknown error',
      '',
      this.state.error?.stack ?? '',
      '',
      'Component stack:',
      this.state.stack ?? ''
    ].join('\n')

  /**
   * Copies the text the preview above is already showing — the same crash, plus
   * what main knows about this installation: versions, inventory counts, which
   * features are switched on, with paths in the stack cut back to filenames and
   * secret-shaped strings blanked.
   *
   * Both this and the request in `componentDidCatch` are guarded by `bridgeHas`:
   * under `electron-vite dev` the running process keeps the preload bundle it
   * booted with, so a newly added method is undefined for the rest of that
   * session. Calling it here would throw INSIDE the crash screen, which is the
   * one place in the app with nothing left to catch it — so an old preload loses
   * the button rather than the window.
   *
   * The null check is the same one the `disabled` attribute makes, kept here so
   * that nothing can copy an unpreviewed payload even if the two drift apart.
   */
  private copyDiagnostics = (): void => {
    const { diagnostics } = this.state
    if (diagnostics === null) return
    window.opsmaxx?.clipboard.write(diagnostics)
  }

  render(): ReactNode {
    const { error, diagnostics } = this.state
    if (!error) return this.props.children

    return (
      <div className="crash">
        <div className="crash-card">
          <div className="crash-icon">
            <AlertTriangle size={24} />
          </div>
          <h2>Something broke in the interface</h2>
          <p className="faint">
            Your servers, credentials and vault are stored on disk and are unaffected. Reloading
            rebuilds the window — any open SSH sessions will be reconnected.
          </p>

          <pre className="crash-detail selectable">{error.message}</pre>

          {/* What Copy diagnostics puts on the clipboard, before it goes there.
              Settings makes the same argument for its own preview and it is the
              stronger control of the two: this is the only payload in the app
              containing text nobody here authored, so it is the one that must
              not be copied unseen. */}
          {diagnostics !== null && (
            <pre className="paste-preview selectable">{diagnostics}</pre>
          )}

          <div className="row" style={{ gap: 8, justifyContent: 'center' }}>
            <button
              className="btn"
              onClick={() => window.opsmaxx?.clipboard.write(this.report())}
            >
              <Copy size={14} /> Copy details
            </button>
            {bridgeHas(window.opsmaxx?.diagnostics as Record<string, unknown> | undefined, 'text') && (
              <button
                className="btn"
                disabled={diagnostics === null}
                onClick={this.copyDiagnostics}
              >
                <Copy size={14} /> Copy diagnostics
              </button>
            )}
            <button className="btn primary" onClick={() => window.location.reload()}>
              <RotateCcw size={14} /> Reload
            </button>
          </div>

          {/* Two buttons, two different promises, so both are spelled out and
              each names its own button — a caption that said "paths are
              trimmed" while sitting under Copy details would be a lie about
              Copy details. Copy diagnostics does most of the redacting for the
              reader — the versions, counts and on/off states are clean by
              construction, and the trace has its paths trimmed and secrets
              blanked — but an error message can still interpolate a host, and
              no rule can spot one, so that text is shown rather than promised.
              Copy details promises nothing and has to say so: it is the raw
              throw, which is the point of having it. */}
          <p className="faint" style={{ fontSize: 11, marginTop: 12 }}>
            <strong>Copy details</strong> copies this error exactly as it was thrown, full paths
            and all — redact hostnames and usernames yourself before posting it.{' '}
            <strong>Copy diagnostics</strong> is the one to send: it adds your versions and
            settings, trims paths and strips secrets, and only becomes available once that text is
            on screen above. It copies that text and nothing else, so glance over it for hostnames
            first.
          </p>
        </div>
      </div>
    )
  }
}
