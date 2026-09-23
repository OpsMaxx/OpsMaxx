import { FileUp } from 'lucide-react'
import type { Body, HttpRequest, MultipartRow, Row } from '../../../../../shared/apiModel'
import type { VariableScopeChain } from '../../../../../shared/apiVariables'
import { methodAllowsBody } from '../../../../../shared/httpClient'
import { useHttp } from '../../../store/http'
import { CodeEditor } from '../../common/CodeEditor'
import { KeyValueTable } from '../../common/KeyValueTable'
import { VarField } from './AuthEditor'
import { prettyText } from '../response/bodyWindow'
import { rowWarning } from './HeadersEditor'
import { bodyTooLargeToSave, invalidJson, vaultRefInFreeText } from './requestModel'

export const BODY_MODES: { mode: Body['mode']; label: string }[] = [
  { mode: 'none', label: 'None' },
  { mode: 'json', label: 'JSON' },
  { mode: 'text', label: 'Text' },
  { mode: 'xml', label: 'XML' },
  { mode: 'urlencoded', label: 'Form URL-encoded' },
  { mode: 'multipart', label: 'Multipart' },
  { mode: 'binary', label: 'Binary file' }
]

/** Text survives a switch between text modes, rows between form modes. */
export function switchBodyMode(body: Body, mode: Body['mode']): Body {
  const text = 'text' in body ? body.text : ''
  const rows: Row[] = 'rows' in body ? body.rows : []
  switch (mode) {
    case 'json':
    case 'text':
    case 'xml':
      return { mode, text }
    case 'urlencoded':
      return { mode, rows: rows.map(({ id, enabled, key, value, description }) => ({ id, enabled, key, value, description })) }
    case 'multipart':
      return { mode, rows: rows.map((r) => ({ kind: 'text', ...r }) as MultipartRow) }
    case 'binary':
      return { mode }
    default:
      return { mode: 'none' }
  }
}

/** Beautify: JSON only; anything else is left as typed. */
export function beautify(req: HttpRequest): HttpRequest {
  return req.body.mode === 'json' ? { ...req, body: { ...req.body, text: prettyText(req.body.text, 'json') } } : req
}

export interface BodyEditorProps {
  req: HttpRequest
  onChange: (req: HttpRequest) => void
  chain: VariableScopeChain
  onSubmit: () => void
  /** Pick a file for `key` (`body` for a binary body, else a multipart row id). Resolves to its basename, or null. */
  onChooseFile: (key: string) => Promise<string | null>
  /** Whether the bytes for `key` are in memory this session. */
  hasFile: (key: string) => boolean
  stripped?: string[]
  readOnly?: boolean
}

export function BodyEditor({
  req,
  onChange,
  chain,
  onSubmit,
  onChooseFile,
  hasFile,
  stripped = [],
  readOnly
}: BodyEditorProps): React.JSX.Element {
  const showDescription = useHttp((s) => s.prefs.kvDescriptions)
  const setPrefs = useHttp((s) => s.setPrefs)
  const body = req.body
  const setBody = (next: Body): void => {
    if (!readOnly) onChange({ ...req, body: next })
  }
  const valueCell = (row: Row, onValue: (v: string) => void): React.JSX.Element => (
    <VarField readOnly={readOnly} value={row.value} onChange={onValue} chain={chain} ariaLabel={`Value of ${row.key || 'field'}`} placeholder="Value" />
  )

  return (
    <div className="hc-bodyed">
      {!methodAllowsBody(req.method) && body.mode !== 'none' && (
        <p className="hc-note hc-warn" role="note">
          {req.method} requests are sent without a body.
        </p>
      )}
      {body.mode === 'none' && <p className="hc-note hc-pad">This request has no body.</p>}

      {(body.mode === 'json' || body.mode === 'text' || body.mode === 'xml') && (
        <>
          <div className="hc-bodyed-code">
            <CodeEditor
              value={body.text}
              onChange={(text) => setBody({ ...body, text })}
              language={body.mode === 'xml' ? 'xml' : body.mode === 'json' ? 'json' : 'text'}
              readOnly={readOnly}
              variables={chain}
              onSubmit={onSubmit}
              foldable
              ariaLabel="Request body"
            />
          </div>
          {invalidJson(req) && (
            <p className="hc-note hc-danger" role="note">
              Not valid JSON. It will be sent exactly as written.
            </p>
          )}
          {vaultRefInFreeText(req) && (
            <p className="hc-note hc-warn" role="note">
              A vault: reference in a JSON, XML or text body is sent as written, not resolved, because a server can echo
              a body back. Put the secret in a header, the auth, or a form field instead.
            </p>
          )}
          {bodyTooLargeToSave(req) && (
            <p className="hc-note" role="note">
              Over 256 KiB: this body is sent, but not saved with the request.
            </p>
          )}
        </>
      )}

      {body.mode === 'urlencoded' && (
        <KeyValueTable
          rows={body.rows}
          onChange={(rows) => setBody({ mode: 'urlencoded', rows })}
          kind="form"
          showDescription={showDescription}
        onShowDescription={(kvDescriptions) => setPrefs({ kvDescriptions })}
          readOnly={readOnly}
          valueCell={valueCell}
          warnFor={(row) => rowWarning(row, 'body.rows', body.rows.indexOf(row as MultipartRow), stripped)}
        />
      )}

      {body.mode === 'multipart' && (
        <KeyValueTable
          rows={body.rows}
          onChange={(rows) =>
            // The table knows Row, not MultipartRow: keep each row's kind and file name.
            setBody({
              mode: 'multipart',
              rows: rows.map((r) => ({ kind: 'text', ...body.rows.find((p) => p.id === r.id), ...r }) as MultipartRow)
            })
          }
          kind="form"
          showDescription={showDescription}
        onShowDescription={(kvDescriptions) => setPrefs({ kvDescriptions })}
          readOnly={readOnly}
          warnFor={(row) => rowWarning(row, 'body.rows', body.rows.indexOf(row as MultipartRow), stripped)}
          valueCell={(row, onValue) => {
            const mrow = body.rows.find((p) => p.id === row.id) ?? ({ ...row, kind: 'text' } as MultipartRow)
            const setRow = (patch: Partial<MultipartRow>): void =>
              setBody({ mode: 'multipart', rows: body.rows.map((p) => (p.id === row.id ? { ...p, ...patch } : p)) })
            return (
              <span className="hc-mp-cell">
                <select
                  className="hc-select hc-mp-kind"
                  aria-label={`Type of ${row.key || 'field'}`}
                  value={mrow.kind}
                  disabled={readOnly}
                  onChange={(e) => setRow({ kind: e.target.value as 'text' | 'file', value: '', fileName: undefined })}
                >
                  <option value="text">Text</option>
                  <option value="file">File</option>
                </select>
                {mrow.kind === 'text' ? (
                  valueCell(row, onValue)
                ) : (
                  <FilePick
                    name={mrow.fileName}
                    held={hasFile(row.id)}
                    disabled={readOnly}
                    onPick={async () => {
                      const name = await onChooseFile(row.id)
                      if (name) setRow({ fileName: name, value: name })
                    }}
                  />
                )}
              </span>
            )
          }}
        />
      )}

      {body.mode === 'binary' && (
        <div className="hc-pad">
          <FilePick
            name={body.fileName}
            held={hasFile('body')}
            disabled={readOnly}
            onPick={async () => {
              const name = await onChooseFile('body')
              if (name) setBody({ mode: 'binary', fileName: name })
            }}
          />
        </div>
      )}
    </div>
  )
}

/** A file is held in memory for this session only; after a restart only its name is left. */
function FilePick({
  name,
  held,
  disabled,
  onPick
}: {
  name?: string
  held: boolean
  disabled?: boolean
  onPick: () => void
}): React.JSX.Element {
  return (
    <span className="hc-file">
      <button className="btn sm" disabled={disabled} onClick={onPick}>
        <FileUp size={14} /> {name && !held ? 'Choose the file again' : 'Choose file…'}
      </button>
      {name && <span className={held ? 'hc-file-name' : 'hc-file-name hc-missing'}>{name}</span>}
    </span>
  )
}
