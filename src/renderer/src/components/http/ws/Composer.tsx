import { useMemo } from 'react'
import { Send } from 'lucide-react'
import type { Id } from '../../../../../shared/apiModel'
import { isMac } from '../../../lib/shortcuts'
import { EMPTY_COMPOSER, useWsSessions } from '../../../store/wsSessions'
import { CodeEditor } from '../../common/CodeEditor'
import { literalSecretsIn } from '../gql/graphqlLanguage'
import { prettyJson } from './frames'
import { beautifyWs, submitWs } from './wsActions'

const sendKey = (): string => (isMac() ? '⌘↵' : 'Ctrl+Enter')

/**
 * The message box. The text stays after a send unless "Clear on send" is on,
 * because the usual next message is a small edit of the last one.
 */
export function Composer({ tabId }: { tabId: Id }): React.JSX.Element {
  const composer = useWsSessions((s) => s.composers[tabId] ?? EMPTY_COMPOSER)
  const open = useWsSessions((s) => s.sessions[tabId]?.state === 'open')
  const setComposer = useWsSessions((s) => s.setComposer)
  const secrets = useMemo(() => literalSecretsIn(composer.text), [composer.text])

  return (
    <div className="hc-ws-composer">
      <div className="hc-ws-composer-editor">
        <CodeEditor
          value={composer.text}
          onChange={(text) => setComposer(tabId, { text })}
          language={composer.format === 'json' ? 'json' : 'text'}
          wrap
          onSubmit={() => void submitWs(tabId)}
          placeholder={open ? 'Type a message' : 'Connect, then type a message'}
          ariaLabel="Message"
        />
      </div>
      <div className="hc-ws-composer-foot">
        {secrets.length > 0 && (
          // Only "as typed": the composer and the frames live in memory, and
          // history never stores a WebSocket message (shared/httpHistory).
          <p className="hc-ws-composer-note" role="note">
            {secrets.map((s) => s.key).join(', ')} {secrets.length === 1 ? 'looks' : 'look'} like a credential. It is sent
            to the server as typed.
          </p>
        )}
        {open ? (
          <button
            type="button"
            className="btn primary sm"
            disabled={composer.text === ''}
            onClick={() => void submitWs(tabId)}
          >
            <Send size={13} aria-hidden /> Send <kbd className="hc-ws-kbd">{sendKey()}</kbd>
          </button>
        ) : (
          <button type="button" className="btn sm" disabled>
            Connect to send
          </button>
        )}
      </div>
    </div>
  )
}

/** Text ▾ · Beautify · ☐ Clear on send, in the request toolbar row. */
export function ComposerToolbar({ tabId }: { tabId: Id }): React.JSX.Element {
  const composer = useWsSessions((s) => s.composers[tabId] ?? EMPTY_COMPOSER)
  const setComposer = useWsSessions((s) => s.setComposer)
  return (
    <div className="hc-ws-toolbar">
      <select
        className="input"
        aria-label="Message format"
        value={composer.format}
        onChange={(e) => setComposer(tabId, { format: e.target.value as 'text' | 'json' })}
      >
        <option value="text">Text</option>
        <option value="json">JSON</option>
      </select>
      <button
        type="button"
        className="btn ghost sm"
        title={`Beautify (${isMac() ? '⌥⌘B' : 'Ctrl+Alt+B'})`}
        disabled={prettyJson(composer.text) === null}
        onClick={() => beautifyWs(tabId)}
      >
        Beautify
      </button>
      <label className="hc-ws-check">
        <input
          type="checkbox"
          checked={composer.clearOnSend}
          onChange={(e) => setComposer(tabId, { clearOnSend: e.target.checked })}
        />{' '}
        Clear on send
      </label>
    </div>
  )
}
