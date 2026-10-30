import { useMemo, useState, type Ref } from 'react'
import type { EditorView } from '@codemirror/view'
import type { HttpResponseOk } from '../../../../../shared/httpClient'
import { CodeEditor } from '../../common/CodeEditor'
import { bytes, clsx } from '../../../lib/format'
import {
  PREVIEW_IMAGE_MAX_BYTES,
  PRETTY_MAX_BYTES,
  HARD_WRAP_CHARS,
  bodyKind,
  bodyWindow,
  headerValue,
  imageDataUrl,
  languageFor,
  prettyText,
  previewDoc,
  type BodyKind
} from './bodyWindow'
import { useT } from '../../../lib/i18n'

type View = 'pretty' | 'raw' | 'preview'
type LanguageChoice = 'auto' | 'json' | 'xml' | 'html' | 'yaml' | 'text'

const LANGUAGES: LanguageChoice[] = ['auto', 'json', 'xml', 'html', 'yaml', 'text']

export interface BodyViewerProps {
  response: HttpResponseOk
  wrap: boolean
  editorRef: Ref<EditorView>
  onSave: () => void
  onCopyAll: () => void
}

export function BodyViewer({ response, wrap, editorRef, onSave, onCopyAll }: BodyViewerProps): React.JSX.Element {
  const t = useT()
  const u8 = useMemo(() => new Uint8Array(response.body), [response])
  const contentType = headerValue(response.headers, 'content-type')
  const detected = useMemo(() => bodyKind(contentType, u8), [contentType, u8])
  const win = useMemo(
    () => bodyWindow(u8, { max: PRETTY_MAX_BYTES, hardWrap: HARD_WRAP_CHARS, contentType }),
    [u8, contentType]
  )
  const [view, setView] = useState<View>(detected === 'image' ? 'preview' : 'pretty')
  const [choice, setChoice] = useState<LanguageChoice>('auto')
  const kind: BodyKind = choice === 'auto' ? detected : choice
  const pretty = useMemo(() => (win.windowed ? win.text : prettyText(win.text, kind)), [win, kind])
  const previewable = detected === 'html' || detected === 'image' || detected === 'svg'

  const content = (): React.JSX.Element => {
    if (view === 'preview') return <Preview kind={detected} u8={u8} text={win.text} contentType={contentType} />
    if (detected === 'binary' || detected === 'image') {
      return (
        <div className="hc-body-note">
          <p>
            {t(detected === 'image' ? 'http.body.imageBody' : 'http.body.binaryBody', {
              bytes: u8.length,
              type: contentType ?? t('http.body.noContentType')
            })}
          </p>
          <button className="btn sm" onClick={onSave}>
            {t('http.body.saveToFile')}
          </button>
        </div>
      )
    }
    return (
      <CodeEditor
        value={view === 'pretty' ? pretty : win.text}
        language={view === 'pretty' ? languageFor(kind) : 'text'}
        readOnly
        wrap={wrap}
        foldable={view === 'pretty'}
        ariaLabel={t('http.body.responseBody')}
        editorRef={editorRef}
      />
    )
  }

  return (
    <div className="hc-body">
      <div className="hc-body-bar">
        <div className="hc-seg" role="group" aria-label={t('http.body.view')}>
          {(['pretty', 'raw', 'preview'] as const).map((v) => (
            <button
              key={v}
              className={clsx('hc-seg-btn', view === v && 'hc-on')}
              aria-pressed={view === v}
              disabled={v === 'preview' && !previewable}
              onClick={() => setView(v)}
            >
              {v === 'pretty' ? t('http.body.pretty') : v === 'raw' ? t('http.body.raw') : t('http.body.preview')}
            </button>
          ))}
        </div>
        {view === 'pretty' && (
          <select
            className="hc-body-lang"
            aria-label={t('http.body.highlightAs')}
            value={choice}
            onChange={(e) => setChoice(e.target.value as LanguageChoice)}
          >
            {LANGUAGES.map((l) => (
              <option key={l} value={l}>
                {l === 'auto' ? t('http.body.auto', { kind: detected }) : l.toUpperCase()}
              </option>
            ))}
          </select>
        )}
      </div>
      {response.truncated && (
        <div className="hc-strip" role="note">
          <span>{t('http.body.truncated')}</span>
          <button className="btn sm" onClick={onSave}>
            {t('http.body.saveToFile')}
          </button>
        </div>
      )}
      {win.windowed && view !== 'preview' && (
        <div className="hc-strip" role="note">
          <span>{t('http.body.windowed', { shown: bytes(win.shownBytes), total: bytes(win.totalBytes) })}</span>
          <button className="btn sm" onClick={onSave}>
            {t('http.body.saveToFile')}
          </button>
          <button className="btn sm" onClick={onCopyAll}>
            {t('http.body.copyAll')}
          </button>
        </div>
      )}
      <div className="hc-body-content">{content()}</div>
    </div>
  )
}

function Preview({
  kind,
  u8,
  text,
  contentType
}: {
  kind: BodyKind
  u8: Uint8Array
  text: string
  contentType: string | undefined
}): React.JSX.Element {
  const t = useT()
  if (kind === 'html') {
    return (
      <div className="hc-body-preview">
        <p className="hc-preview-note">{t('http.body.previewOffline')}</p>
        {/* sandbox="" allows nothing: no scripts, no forms, no navigation of this window. */}
        <iframe className="hc-preview-frame" sandbox="" srcDoc={previewDoc(text)} title={t('http.body.htmlPreview')} />
      </div>
    )
  }
  if ((kind === 'image' || kind === 'svg') && contentType) {
    if (u8.length > PREVIEW_IMAGE_MAX_BYTES) {
      return <p className="hc-body-note">{t('http.body.tooLargeToPreview', { size: bytes(u8.length) })}</p>
    }
    return (
      <div className="hc-body-preview">
        <img className="hc-preview-img" src={imageDataUrl(u8, contentType)} alt={t('http.body.imageAlt')} />
      </div>
    )
  }
  return <p className="hc-body-note">{t('http.body.noPreview')}</p>
}
