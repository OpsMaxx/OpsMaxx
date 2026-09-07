import { useEffect, useState } from 'react'
import { ServerCog } from 'lucide-react'
import { clsx } from '../../lib/format'
import { openMonitor, useNav } from '../../store/nav'
import {
  checkUnitDraft,
  renderUnitFile,
  type UnitDraft,
  type UnitRestart
} from '../../../../shared/userUnits'
import type { Server } from '../../types'

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
      window.shellpilot as
        | {
            services?: {
              write?: (t: unknown, d: UnitDraft) => Promise<{ ok: boolean; output?: string; error?: string }>
            }
          }
        | undefined
    )?.services?.write
    if (typeof w !== 'function') {
      setResult({ ok: false, text: 'This build cannot write units. Restart the app to rebuild it.' })
      return
    }
    // Asked before it happens, and it names the server and the unit, because a
    // file is about to appear on a machine the operator is not looking at.
    if (
      !window.confirm(
        `Install ${draft.name} on ${target.name}?\n\nIt writes ~/.config/systemd/user/${draft.name} and enables it. It does NOT start it, and any existing unit of that name is backed up first.`
      )
    ) {
      return
    }
    setBusy(true)
    try {
      const res = await w({ cfg: target }, draft)
      setResult({ ok: res.ok === true, text: res.output ?? res.error ?? 'No answer.' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="panel-body">
      <div className="panel-head">
        <div>
          <div className="panel-title">
            <ServerCog size={14} /> Install a service on a server
          </div>
          <div className="panel-subtitle">
            Writes a unit to <code>~/.config/systemd/user/</code> on one server and enables it. It
            is not started: the server&rsquo;s own systemd owns it from then on, which is the point
            — it is there when ShellPilot is not.
          </div>
        </div>
        <select
          className="input"
          aria-label="Server"
          value={serverId ?? ''}
          onChange={(e) => {
            setServerId(e.target.value === '' ? null : e.target.value)
            setResult(null)
          }}
        >
          <option value="">Choose a server…</option>
          {servers.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </div>

      <div className="list-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 6 }}>
        <input
          className="input"
          placeholder="worker.service"
          aria-label="Unit name"
          value={draft.name}
          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
        />
        <input
          className="input"
          placeholder="What it is, in one line"
          aria-label="Description"
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
          aria-label="Restart policy"
          value={draft.restart}
          onChange={(e) => setDraft({ ...draft, restart: e.target.value as UnitRestart })}
        >
          <option value="on-failure">Restart on failure</option>
          <option value="always">Always restart</option>
          <option value="no">Never restart</option>
        </select>

        {/* The exact bytes, before they are written. A file is about to appear
            on a machine nobody is looking at, and "trust me" is not a preview. */}
        {check.ok ? (
          <pre className="mono" style={{ fontSize: 11, whiteSpace: 'pre-wrap', margin: 0 }}>
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
                See what this server supervises
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
            ? 'Choose a server.'
            : !check.ok
              ? check.reason
              : `Writes ~/.config/systemd/user/${draft.name} on ${target.name} and enables it`}
        </span>
        <span className="grow" />
        <button
          className="btn danger"
          data-testid="install-go"
          disabled={busy || target === null || !check.ok}
          onClick={() => void install()}
        >
          Install
        </button>
      </div>
    </div>
  )
}
