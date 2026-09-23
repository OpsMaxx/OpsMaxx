import type { HttpRequest } from '../../../../../shared/apiModel'
import type { VariableScopeChain } from '../../../../../shared/apiVariables'
import { useHttp } from '../../../store/http'
import { KeyValueTable } from '../../common/KeyValueTable'
import { VarField } from './AuthEditor'
import { rowWarning } from './HeadersEditor'
import { syncFromParams } from './requestModel'

export interface ParamsEditorProps {
  req: HttpRequest
  onChange: (req: HttpRequest) => void
  chain: VariableScopeChain
  stripped?: string[]
  readOnly?: boolean
}

/** Query parameters, kept in step with the URL both ways, and the URL's `:id` / `{id}` segments. */
export function ParamsEditor({ req, onChange, chain, stripped = [], readOnly }: ParamsEditorProps): React.JSX.Element {
  const showDescription = useHttp((s) => s.prefs.kvDescriptions)
  const setPrefs = useHttp((s) => s.setPrefs)
  return (
    <div className="hc-params">
      <KeyValueTable
        rows={req.params}
        onChange={(rows) => onChange(syncFromParams(req, rows))}
        kind="params"
        showDescription={showDescription}
        onShowDescription={(kvDescriptions) => setPrefs({ kvDescriptions })}
        readOnly={readOnly}
        valueCell={(row, onValue) => (
          <VarField readOnly={readOnly} value={row.value} onChange={onValue} chain={chain} ariaLabel={`Value of ${row.key || 'parameter'}`} placeholder="Value" />
        )}
        warnFor={(row) => rowWarning(row, 'params', req.params.indexOf(row), stripped)}
      />
      {req.pathParams.length > 0 && (
        <>
          <h4 className="hc-section ui-label">Path parameters</h4>
          <table className="hc-path-table" aria-label="Path parameters">
            <tbody>
              {req.pathParams.map((p) => (
                <tr key={p.id}>
                  <th scope="row">{p.key}</th>
                  <td>
                    <VarField
                      readOnly={readOnly}
                      value={p.value}
                      onChange={(value) =>
                        onChange({ ...req, pathParams: req.pathParams.map((x) => (x.id === p.id ? { ...x, value } : x)) })
                      }
                      chain={chain}
                      ariaLabel={`Value of path parameter ${p.key}`}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  )
}
