import { useMemo } from 'react'
import { Send } from 'lucide-react'
import type { Id } from '../../../../../shared/apiModel'
import { isMac } from '../../../lib/shortcuts'
import { EMPTY_COMPOSER, useWsSessions } from '../../../store/wsSessions'
import { CodeEditor } from '../../common/CodeEditor'
import { literalSecretsIn } from '../gql/graphqlLanguage'
import { prettyJson } from './frames'
import { beautifyWs, submitWs } from './wsActions'
import { useT } from '../../../lib/i18n'

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
  const t = useT()

  return (
    <div className="hc-ws-composer">
      <div className="hc-ws-composer-editor">
        <CodeEditor
          value={composer.text}
          onChange={(text) => setComposer(tabId, { text })}
          language={composer.format === 'json' ? 'json' : 'text'}
          wrap
          onSubmit={() => void submitWs(tabId)}
          placeholder={open ? t('http.ws.typeMessage') : t('http.ws.connectThenType')}
          ariaLabel={t('http.ws.message')}
        />
      </div>
      <div className="hc-ws-composer-foot">
        {secrets.length > 0 && (
          // Only "as typed": the composer and the frames live in memory, and
          // history never stores a WebSocket message (shared/httpHistory).
          <p className="hc-ws-composer-note" role="note">
            {t('http.ws.secretNote', { count: secrets.length, keys: secrets.map((s) => s.key).join(', ') })}
          </p>
        )}
        {open ? (
          <button
            type="button"
            className="btn primary sm"
            disabled={composer.text === ''}
            onClick={() => void submitWs(tabId)}
          >
            <Send size={13} aria-hidden /> {t('http.ws.send')} <kbd className="hc-ws-kbd">{sendKey()}</kbd>
          </button>
        ) : (
          <button type="button" className="btn sm" disabled>
            {t('http.ws.connectToSend')}
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
  const t = useT()
  return (
    <div className="hc-ws-toolbar">
      <select
        className="input"
        aria-label={t('http.ws.messageFormat')}
        value={composer.format}
        onChange={(e) => setComposer(tabId, { format: e.target.value as 'text' | 'json' })}
      >
        <option value="text">{t('http.ws.formatText')}</option>
        <option value="json">{t('http.ws.formatJson')}</option>
      </select>
      <button
        type="button"
        className="btn ghost sm"
        title={t('http.ws.beautifyTitle', { key: isMac() ? '⌥⌘B' : 'Ctrl+Alt+B' })}
        disabled={prettyJson(composer.text) === null}
        onClick={() => beautifyWs(tabId)}
      >
        {t('http.ws.beautify')}
      </button>
      <label className="hc-ws-check">
        <input
          type="checkbox"
          checked={composer.clearOnSend}
          onChange={(e) => setComposer(tabId, { clearOnSend: e.target.checked })}
        />{' '}
        {t('http.ws.clearOnSend')}
      </label>
    </div>
  )
}
