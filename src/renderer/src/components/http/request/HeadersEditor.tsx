import { isSensitiveName, type Row } from '../../../../../shared/apiModel'
import type { VariableScopeChain } from '../../../../../shared/apiVariables'
import { isOverridden, type AutoHeader } from '../../../../../shared/autoHeaders'
import { useHttp } from '../../../store/http'
import { clsx } from '../../../lib/format'
import { KeyValueTable } from '../../common/KeyValueTable'
import { VarField, isLiteralSecret } from './AuthEditor'
import './request.css'

export interface HeadersEditorProps {
  rows: Row[]
  onChange: (rows: Row[]) => void
  auto?: AutoHeader[]
  readOnly?: boolean
  chain: VariableScopeChain
  /** Paths stripped at the last save, relative to the request (`headers.<index>.value`). */
  stripped?: string[]
  /** "Move to vault…" on a row holding a literal credential; absent hides it. */
  onMoveToVault?: (rowId: string, value: string) => void
}

/** Header rows whose literal value is stripped at save rather than kept with a warning (§3.5). */
const STRIPPED_HEADERS = new Set(['authorization', 'proxy-authorization', 'cookie'])

/**
 * The ⚠ on a key-value row. Params, headers and form rows all ask this, so a
 * credential gets the same sentence wherever it was typed.
 */
export function rowWarning(row: Row, section: string, index: number, stripped: string[] = []): string | null {
  if (stripped.includes(`${section}.${index}.value`) && row.value === '') {
    return 'Not kept from last session. Paste the value again, or read it from the vault.'
  }
  if (!row.enabled || !isSensitiveName(row.key) || !isLiteralSecret(row.value)) return null
  return section === 'headers' && STRIPPED_HEADERS.has(row.key.trim().toLowerCase())
    ? 'Not saved — kept for this session only. Move it to the vault to keep it.'
    : 'Looks like a credential. Saved and synced as plain text. Move it to the vault…'
}

export function HeadersEditor({
  rows,
  onChange,
  auto = [],
  readOnly,
  chain,
  stripped = [],
  onMoveToVault
}: HeadersEditorProps): React.JSX.Element {
  const showAuto = useHttp((s) => s.prefs.showAutoHeaders)
  const showDescription = useHttp((s) => s.prefs.kvDescriptions)
  const setPrefs = useHttp((s) => s.setPrefs)

  return (
    <div className="hc-headers">
      {auto.length > 0 && (
        <div className="hc-auto">
          <button
            className="btn quiet sm"
            aria-expanded={showAuto}
            onClick={() => setPrefs({ showAutoHeaders: !showAuto })}
          >
            {showAuto ? 'Hide auto-generated headers' : `${auto.length} hidden`}
          </button>
          {showAuto && (
            <table className="hc-auto-table" aria-label="Headers OpsMaxx adds">
              <tbody>
                {auto.map((h) => {
                  const replaced = isOverridden(h, rows)
                  return (
                    <tr key={h.name} className={clsx(replaced && 'hc-replaced')} title={h.reason}>
                      <th scope="row">{h.name}</th>
                      <td>{h.value}</td>
                      <td className="hc-auto-why">{replaced ? 'Replaced by your header' : h.reason}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>
      )}
      <KeyValueTable
        rows={rows}
        onChange={onChange}
        kind="headers"
        showDescription={showDescription}
        onShowDescription={(kvDescriptions) => setPrefs({ kvDescriptions })}
        readOnly={readOnly}
        valueCell={(row, onValue) => (
          <VarField readOnly={readOnly} value={row.value} onChange={onValue} chain={chain} ariaLabel={`Value of ${row.key || 'header'}`} placeholder="Value" />
        )}
        warnFor={(row) => rowWarning(row, 'headers', rows.indexOf(row), stripped)}
        extraRowMenu={(row) =>
          onMoveToVault && isSensitiveName(row.key) && isLiteralSecret(row.value)
            ? [{ label: 'Move to vault…', onClick: () => onMoveToVault(row.id, row.value) }]
            : []
        }
      />
    </div>
  )
}
