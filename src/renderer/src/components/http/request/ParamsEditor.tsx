import type { HttpRequest } from '../../../../../shared/apiModel'
import type { VariableScopeChain } from '../../../../../shared/apiVariables'
import { useHttp } from '../../../store/http'
import { KeyValueTable } from '../../common/KeyValueTable'
import { VarField } from './AuthEditor'
import { rowWarning } from './HeadersEditor'
import { syncFromParams } from './requestModel'
import { useT } from '../../../lib/i18n'

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
  const t = useT()
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
          <VarField readOnly={readOnly} value={row.value} onChange={onValue} chain={chain}             ariaLabel={t('http.params.valueOf', { name: row.key || t('http.params.parameter') })}
            placeholder={t('http.params.value')}
          />
        )}
        warnFor={(row) => rowWarning(row, 'params', req.params.indexOf(row), stripped)}
      />
      {req.pathParams.length > 0 && (
        <>
          <h4 className="hc-section ui-label">{t('http.params.pathParameters')}</h4>
          <table className="hc-path-table" aria-label={t('http.params.pathParameters')}>
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
                      ariaLabel={t('http.params.pathValueOf', { name: p.key })}
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
