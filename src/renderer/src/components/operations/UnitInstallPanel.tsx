import { useEffect, useState } from 'react'
import { ServerCog } from 'lucide-react'
import { clsx } from '../../lib/format'
import { useT } from '../../lib/i18n'
import { Trans } from '../../lib/Trans'
import { openMonitor, useNav } from '../../store/nav'
import {
  checkUnitDraft,
  renderUnitFile,
  type UnitDraft,
  type UnitRestart
} from '../../../../shared/userUnits'
import type { Server } from '../../types'
import { PanelShell } from '../monitor/PanelShell'
import { withVaultUnlock } from '../../lib/withVaultUnlock'

// Installing a `systemd --user` unit — the write half of what used to be one
// Monitoring tab.
//
// ServicesPanel reads what each server's own systemd supervises for this
// account, and led with the sentence that matters: a `--user` service stops
// when the account's last session ends unless that account is lingering, so a
// list of `running` units can be a list of things about to stop. That whole
// view is a read and stays where it is. The one control that wrote a file onto
// a machine — New service — is here, on the rail whose standing banner says
// everything in it changes servers.
//
// A SUB-TAB OF JOBS rather than a module of its own. Jobs already owns this
// vocabulary: `serviceStep.ts` is one of its files and it starts, stops,
// restarts, enables and disables units, and `openServiceJob` already routes a
// unit action from the failed-unit list into that composer. Installing the unit
// is the missing first verb of the same sentence, not a new subject. Giving it
// a top-level tab would say it is a different kind of thing from starting one,
// which is not true of anything except the order they happen in.
//
// One server at a time, as before: "install this on all of them" is not a thing
// to make easy.

export function UnitInstallPanel({ servers }: { servers: Server[] }): React.JSX.Element {
  const t = useT()
  const [serverId, setServerId] = useState<string | null>(null)
  const [draft, setDraft] = useState<UnitDraft>({
    name: '',
    description: '',
    execStart: '',
    restart: 'on-failure'
  })
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null)
  const [busy, setBusy] = useState(false)

  const jump = useNav((s) => s.operationsJump)
  const [honoured, setHonoured] = useState(0)

  // A jump names the server and nothing else. There is no draft to carry: the
  // pointer was pressed on a list of what a host already supervises, which says
  // nothing about the unit somebody is about to write.
  useEffect(() => {
    if (!jump || jump.kind !== 'unit-install' || jump.nonce === honoured) return
    setHonoured(jump.nonce)
    setServerId(jump.serverId)
    setResult(null)
  }, [jump, honoured])

  const target = servers.find((s) => s.id === serverId) ?? null
  const check = checkUnitDraft(draft)

  const install = async (): Promise<void> => {
    if (!target) return
    const w = (
      window.opsmaxx as
        | {
            services?: {
              write?: (target: unknown, d: UnitDraft) => Promise<{ ok: boolean; output?: string; error?: string }>
            }
          }
        | undefined
    )?.services?.write
    if (typeof w !== 'function') {
      setResult({ ok: false, text: t('operations.unit.noWrite') })
      return
    }
    // Asked before it happens, and it names the server and the unit, because a
    // file is about to appear on a machine the operator is not looking at.
    if (
      !window.confirm(
        t('operations.unit.confirm', { unit: draft.name, server: target.name })
      )
    ) {
      return
    }
    setBusy(true)
    try {
      // Retried after an unlock, unlike the multi-host writers. This is ONE
      // server, the confirmation above named it and the unit by name, and a
      // locked vault fails in resolveChainSecrets before sshExec is entered —
      // so nothing was written and the second attempt is the first one
      // finishing, not a second install.
      const res = await withVaultUnlock(
        t('operations.unit.vaultReason', { unit: draft.name, server: target.name }),
        () => w({ cfg: target }, draft)
      )
      setResult({ ok: res.ok === true, text: res.output ?? res.error ?? t('operations.unit.noAnswer') })
    } finally {
      setBusy(false)
    }
  }

  return (
    // Was `.panel-title` over `.panel-subtitle` on a bare `.panel-body`: an
    // undefined class for the heading and a bold one for the description, so
    // the sentence outranked the title it explained. Same template as every
    // other tab now.
    <PanelShell
      icon={<ServerCog size={14} />}
      title={t('operations.unit.title')}
      about={
        <p>
          <Trans i18nKey="operations.unit.about" components={{ code: <code /> }} />
        </p>
      }
      actions={
        <select
          className="input"
          aria-label={t('operations.common.server')}
          value={serverId ?? ''}
          onChange={(e) => {
            setServerId(e.target.value === '' ? null : e.target.value)
            setResult(null)
          }}
        >
          <option value="">{t('operations.common.chooseServer')}</option>
          {servers.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      }
    >
      <div className="list-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 6 }}>
        <input
          className="input"
          placeholder="worker.service"
          aria-label={t('operations.unit.nameLabel')}
          value={draft.name}
          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
        />
        <input
          className="input"
          placeholder={t('operations.unit.descriptionPlaceholder')}
          aria-label={t('operations.unit.descriptionLabel')}
          value={draft.description}
          onChange={(e) => setDraft({ ...draft, description: e.target.value })}
        />
        <input
          className="input mono"
          placeholder="/usr/local/bin/worker --queue main"
          aria-label="ExecStart"
          value={draft.execStart}
          onChange={(e) => setDraft({ ...draft, execStart: e.target.value })}
        />
        <select
          className="input"
          aria-label={t('operations.unit.restartLabel')}
          value={draft.restart}
          onChange={(e) => setDraft({ ...draft, restart: e.target.value as UnitRestart })}
        >
          <option value="on-failure">{t('operations.unit.restart.onFailure')}</option>
          <option value="always">{t('operations.unit.restart.always')}</option>
          <option value="no">{t('operations.unit.restart.no')}</option>
        </select>

        {/* The exact bytes, before they are written. A file is about to appear
            on a machine nobody is looking at, and "trust me" is not a preview. */}
        {check.ok ? (
          <pre className="mono" style={{ whiteSpace: 'pre-wrap', margin: 0 }}>
            {renderUnitFile(draft)}
          </pre>
        ) : (
          <div className="s-note state-unknown">{check.reason}</div>
        )}
      </div>

      {result && (
        <div className={clsx('panel-note', result.ok ? '' : 'is-alarm')}>
          <span className="mono">{result.text}</span>
          {result.ok && (
            <>
              {' '}
              <button className="btn ghost sm" onClick={() => openMonitor('services')}>
                {t('operations.unit.seeSupervised')}
              </button>
            </>
          )}
        </div>
      )}

      {/* The execute slot at the FOOT of the card — see .op-actionbar. The
          sentence names the file and the host, in that order, because the
          question a person is answering is "what appears where". */}
      <div className="op-actionbar">
        <span className="op-actionbar-what" data-testid="install-target">
          {target === null
            ? t('operations.unit.chooseServer')
            : !check.ok
              ? check.reason
              : t('operations.unit.writesTarget', { unit: draft.name, server: target.name })}
        </span>
        <span className="grow" />
        <button
          className="btn danger"
          data-testid="install-go"
          disabled={busy || target === null || !check.ok}
          onClick={() => void install()}
        >
          {t('operations.unit.install')}
        </button>
      </div>
    </PanelShell>
  )
}
