import { useCallback, useEffect, useState } from 'react'
import { Network, Plus, Power, ArrowRight, Trash2, Loader2, Pencil } from 'lucide-react'
import { useApp, useWorkspaceServers, useWorkspaceTunnels } from '../../store/app'
import { EmptyState } from '../common/EmptyState'
import { Field, Modal } from '../common/Modal'
import { clsx } from '../../lib/format'
import { toast } from '../../store/toast'
import type { ToastAction } from '../../store/toast'
import { TUNNEL_DEFAULT_LISTEN, listenForKind, parseEndpoint } from '../../../../shared/tunnel'
import type { TunnelStatus } from '../../../../shared/tunnel'
import { sshHopFor } from '../../lib/ssh'
import { withVaultUnlock } from '../../lib/withVaultUnlock'
import { classifyConnectionError, errorText } from '../../lib/connectionError'
import { openSettings, useNav } from '../../store/nav'
import type { Server, Tunnel, TunnelKind } from '../../types'
import { bridgeHas } from '../../lib/bridge'
import { t as tr, useT } from '../../lib/i18n'
import type { MessageKey } from '../../../../shared/i18n'

/** Said the same way about both endpoints. `parseEndpoint` accepts a bare
 *  port, a host:port and an interface:host:port, so naming only one of those
 *  forms would be a lie about what the field takes. */
const PORT_PROBLEM: MessageKey = 'tunnels.form.portProblem'

const kindLabel: Record<TunnelKind, MessageKey> = {
  local: 'tunnels.kind.local',
  remote: 'tunnels.kind.remote',
  socks: 'tunnels.kind.socks'
}

/** Saves a change to an existing tunnel. `replaceAll` is the store's own bulk
 *  setter and swaps the `tunnels` reference, which is what persist.ts watches,
 *  so an edit is written to disk exactly like an add or a delete. */
function saveTunnelEdit(id: string, patch: Partial<Tunnel>): void {
  const state = useApp.getState()
  state.replaceAll({ tunnels: state.tunnels.map((t) => (t.id === id ? { ...t, ...patch } : t)) })
}

/**
 * One sentence for a tunnel failure, and the single control that fixes it.
 *
 * `web-db: listen EADDRINUSE: address already in use 127.0.0.1:5432` says what
 * the socket layer saw. It does not say that the number the user typed into
 * "Listen locally" is the one to change, which is the only thing they can act
 * on — so that is what this says, and the button opens that field.
 */
function tunnelFailure(
  t: Tunnel,
  server: Server | undefined,
  error: string | undefined,
  edit: () => void
): { message: string; action?: ToastAction } {
  const listen = parseEndpoint(t.listen)
  const editServer = server
    ? {
        label: tr('tunnels.failure.editServer', { name: server.name }),
        run: () => useApp.getState().openServerEditor(server.id)
      }
    : undefined
  const changePort = { label: tr('tunnels.failure.changePort'), run: edit }
  const editTunnel = { label: tr('tunnels.editTunnel'), run: edit }
  // The server's name, or a stand-in for it at the start of a sentence.
  const srv = server?.name ?? tr('tunnels.failure.theServer')

  // Binding below 1024 needs rights this app does not have. Nothing about the
  // server or the credential is wrong, so neither of those buttons would help
  // — the only fix is a higher port.
  if (error && /below 1024|EACCES/i.test(error)) {
    return {
      message: tr('tunnels.failure.privilegedPort', { port: listen.port }),
      action: changePort
    }
  }

  switch (classifyConnectionError(error)) {
    case 'port-in-use':
      return {
        message:
          t.kind === 'remote'
            ? tr('tunnels.failure.portInUseOn', {
                port: listen.port,
                server: server?.name ?? tr('tunnels.failure.theServerMid')
              })
            : tr('tunnels.failure.portInUseHere', { port: listen.port }),
        action: changePort
      }
    case 'host-key':
      return {
        message: tr('tunnels.failure.hostKey', { server: srv, name: t.name }),
        action: { label: tr('tunnels.failure.reviewKeys'), run: () => openSettings('security') }
      }
    case 'key-missing':
      return {
        message: tr('tunnels.failure.keyMissing', { server: srv, name: t.name }),
        action: editServer
      }
    case 'passphrase':
      return {
        message: tr('tunnels.failure.passphrase', { server: srv, name: t.name }),
        action: editServer
      }
    case 'auth':
      return {
        message: tr('tunnels.failure.auth', { server: srv, name: t.name }),
        action: editServer
      }
    case 'refused':
      return {
        message:
          t.kind === 'socks'
            ? tr('tunnels.failure.socksUnreachable', {
                name: t.name,
                server: server?.name ?? tr('tunnels.failure.theServerMid')
              })
            : tr('tunnels.failure.refused', { server: srv, target: t.target }),
        action: editTunnel
      }
    case 'unreachable':
      return {
        message: tr('tunnels.failure.unreachable', { server: srv, name: t.name }),
        action: editServer
      }
    default:
      // Nothing recognised: the raw text is the only information there is, and
      // dropping it to keep the sentence short would leave nothing to act on.
      return {
        message: tr('tunnels.failure.other', {
          name: t.name,
          error: error ?? tr('tunnels.failure.closedUnexpectedly')
        }),
        action: editTunnel
      }
  }
}

export function TunnelManager(): React.JSX.Element {
  const tr = useT()
  const tunnels = useWorkspaceTunnels()
  const servers = useWorkspaceServers()
  const deleteTunnel = useApp((s) => s.deleteTunnel)
  const setTunnelStatus = useApp((s) => s.setTunnelStatus)
  const [creating, setCreating] = useState(false)
  // The tunnel the form is correcting, when it was opened from a failure or
  // from the row's own pencil rather than from "Create tunnel".
  const [editing, setEditing] = useState<Tunnel | null>(null)
  const [live, setLive] = useState<Record<string, TunnelStatus>>({})
  const [busy, setBusy] = useState<Record<string, boolean>>({})

  // Subscribe to status for every tunnel in the workspace.
  //
  // Keyed on the ids rather than the tunnel objects. A status write replaces
  // the object it touches, so depending on the list itself would tear down and
  // rebuild every subscription each time a status arrived — and a busy tunnel
  // reports one per connection. The name is resolved when an error actually
  // fires, which keeps renames out of this dependency too.
  const tunnelIds = tunnels.map((t) => t.id).join(',')
  useEffect(() => {
    const ids = tunnelIds ? tunnelIds.split(',') : []
    if (!bridgeHas(window.opsmaxx?.tunnel as Record<string, unknown> | undefined, 'onStatus')) return
    const offs = ids.map((id) =>
      window.opsmaxx?.tunnel.onStatus(id, (s) => {
        setLive((m) => ({ ...m, [id]: s }))
        setTunnelStatus(id, s.state === 'active' ? 'active' : 'inactive')
        if (s.state === 'error' && s.error) {
          const app = useApp.getState()
          const t = app.tunnels.find((x) => x.id === id)
          if (!t) return
          const { message, action } = tunnelFailure(
            t,
            app.servers.find((sv) => sv.id === t.serverId),
            s.error,
            () => setEditing(t)
          )
          toast(message, 'error', action)
        }
      })
    )
    return () => offs.forEach((off) => off?.())
  }, [tunnelIds, setTunnelStatus])

  // Somebody sent the user here to make a tunnel, or to change one they named.
  //
  // Cleared whether or not it could be honoured — a `select` for a tunnel that
  // has since been deleted must not sit in the store waiting to open a form the
  // next time anyone opens Tunnels for an unrelated reason.
  const intent = useNav((s) => s.tunnelIntent)
  const clearTunnelIntent = useNav((s) => s.clearTunnelIntent)
  useEffect(() => {
    if (!intent) return
    if (intent.kind === 'create') setCreating(true)
    else {
      const t = tunnels.find((x) => x.id === intent.tunnelId)
      if (t) setEditing(t)
    }
    clearTunnelIntent()
  }, [intent, tunnels, clearTunnelIntent])

  // Reconcile with what is actually running (e.g. after a view remount).
  useEffect(() => {
    void window.opsmaxx?.tunnel.list().then((list) => {
      if (!list) return
      setLive(Object.fromEntries(list.map((s) => [s.id, s])))
      list.forEach((s) => setTunnelStatus(s.id, s.state === 'active' ? 'active' : 'inactive'))
    })
  }, [setTunnelStatus])

  const toggle = useCallback(
    async (t: Tunnel) => {
      const running = live[t.id]?.state === 'active'
      setBusy((b) => ({ ...b, [t.id]: true }))
      if (running) {
        await window.opsmaxx?.tunnel.stop(t.id)
        toast(tr('tunnels.toast.stopped', { name: t.name }))
      } else {
        const server = servers.find((s) => s.id === t.serverId)
        if (!server) {
          toast(tr('tunnels.toast.noServer', { name: t.name }), 'error', {
            label: tr('tunnels.toast.chooseServer'),
            run: () => setEditing(t)
          })
          setBusy((b) => ({ ...b, [t.id]: false }))
          return
        }
        const listen = parseEndpoint(t.listen)
        const target = t.kind === 'socks' ? { host: '', port: 0 } : parseEndpoint(t.target)
        // A server that authenticates from the vault cannot be dialled while
        // the vault is locked, and the handler rejects rather than returning a
        // result — so the unlock happens here and the start simply carries on.
        let error: string | undefined
        let listenPort: number | undefined
        try {
          const r = await withVaultUnlock(tr('tunnels.starting', { name: t.name }), async () =>
            window.opsmaxx?.tunnel.start(
              {
                id: t.id,
                kind: t.kind,
                listenHost: listen.host,
                listenPort: listen.port,
                targetHost: target.host,
                targetPort: target.port
              },
              sshHopFor(server)
            )
          )
          if (r?.ok) listenPort = r.listenPort
          else error = r?.error ?? tr('tunnels.didNotOpen')
        } catch (err) {
          error = errorText(err)
        }
        if (error === undefined)
          toast(tr('tunnels.toast.listening', { name: t.name, address: `${listen.host}:${listenPort}` }), 'ok')
        else {
          const { message, action } = tunnelFailure(t, server, error, () => setEditing(t))
          toast(message, 'error', action)
        }
      }
      setBusy((b) => ({ ...b, [t.id]: false }))
    },
    [live, servers, tr]
  )

  const header = (
    <div className="content-header">
      <div>
        <h1>{tr('tunnels.manager.title')}</h1>
        <div className="sub">{tr('tunnels.manager.subtitle')}</div>
      </div>
      <div className="spacer" />
      <button className="btn primary" onClick={() => setCreating(true)}>
        <Plus size={15} /> {tr('tunnels.createTunnel')}
      </button>
    </div>
  )

  if (tunnels.length === 0) {
    return (
      <div className="panel-body">
        <EmptyState
          icon={<Network size={26} />}
          title={tr('tunnels.manager.emptyTitle')}
          message={tr('tunnels.manager.emptyMessage')}
          action={
            <button className="btn primary" onClick={() => setCreating(true)}>
              <Plus size={15} /> {tr('tunnels.createTunnel')}
            </button>
          }
        />
        {(creating || editing) && (
          <TunnelForm
            tunnel={editing}
            onClose={() => {
              setCreating(false)
              setEditing(null)
            }}
          />
        )}
      </div>
    )
  }

  return (
    <div className="content">
      {header}

      {tunnels.map((t) => {
        const st = live[t.id]
        const on = st?.state === 'active'
        const server = servers.find((s) => s.id === t.serverId)
        return (
          <div key={t.id} className="list-row">
            <span className={clsx('status-dot', on ? 'online' : st?.state === 'error' ? 'error' : 'offline')} />
            <div>
              <div className="r-title">{t.name}</div>
              <div className="r-sub">
                {tr(kindLabel[t.kind])}
                {' · '}
                {server ? tr('tunnels.row.via', { server: server.name }) : tr('tunnels.row.noServer')}
                {on && st.connections > 0 ? ` · ${tr('tunnels.row.open', { count: st.connections })}` : ''}
              </div>
              {/* Listening is not the same claim as reaching. A tunnel goes
                  `active` when its local listener binds, and the target can
                  refuse every connection after that -- which used to show as a
                  green dot, a connection count of zero, and no explanation
                  anywhere. The dot stays green because the listener really is
                  up; this says what is happening behind it. */}
              {on && st.forwardFailures ? (
                <div className="r-sub warn">
                  {tr('tunnels.row.forwardFailures', { count: st.forwardFailures })}
                  {st.lastForwardError ? ` — ${st.lastForwardError}` : ''}
                </div>
              ) : null}
            </div>
            <span className="spacer" />
            <div className="r-stat mono" style={{ alignItems: 'center' }}>
              <span>{t.listen}</span>
              {t.kind !== 'socks' && (
                <>
                  <ArrowRight size={13} />
                  <span>{t.target}</span>
                </>
              )}
            </div>
            <button
              className={clsx('btn size-28', on ? 'danger outline' : 'primary')}
              disabled={busy[t.id]}
              onClick={() => void toggle(t)}
            >
              {busy[t.id] ? <Loader2 size={13} className="spin" /> : <Power size={13} />}
              {on ? tr('tunnels.row.stop') : tr('tunnels.row.start')}
            </button>
            <button className="icon-btn sm" title={tr('tunnels.editTunnel')} onClick={() => setEditing(t)}>
              <Pencil size={14} />
            </button>
            <button
              className="icon-btn sm"
              title={tr('tunnels.row.delete')}
              onClick={() => {
                void window.opsmaxx?.tunnel.stop(t.id)
                deleteTunnel(t.id)
                toast(tr('tunnels.toast.deleted', { name: t.name }))
              }}
            >
              <Trash2 size={14} />
            </button>
          </div>
        )
      })}

      {(creating || editing) && (
        <TunnelForm
          tunnel={editing}
          onClose={() => {
            setCreating(false)
            setEditing(null)
          }}
        />
      )}
    </div>
  )
}

function TunnelForm({ tunnel, onClose }: { tunnel?: Tunnel | null; onClose: () => void }): React.JSX.Element {
  const tr = useT()
  const servers = useWorkspaceServers()
  const addTunnel = useApp((s) => s.addTunnel)

  const [name, setName] = useState(tunnel?.name ?? '')
  const [kind, setKind] = useState<TunnelKind>(tunnel?.kind ?? 'local')
  const [serverId, setServerId] = useState(tunnel?.serverId ?? servers[0]?.id ?? '')
  const [listen, setListen] = useState(tunnel?.listen ?? TUNNEL_DEFAULT_LISTEN.local)
  const [target, setTarget] = useState(tunnel?.target || 'localhost:80')

  const socks = kind === 'socks'
  const valid = name.trim() && serverId && parseEndpoint(listen).port > 0 && (socks || parseEndpoint(target).port > 0)

  // Under the field, once the user has been in it — the frp dialog's placement,
  // adopted here. This form previously had no observable validation at all:
  // "+ Create" was simply grey, and nothing on screen said which of the four
  // fields was the reason.
  const [touched, setTouched] = useState<Record<string, boolean>>({})
  const problem = (key: string, message: string | null): string | null =>
    touched[key] ? message : null
  const touch = (key: string) => (): void => setTouched((t) => ({ ...t, [key]: true }))

  const save = (): void => {
    if (!valid) return
    const fields = { name: name.trim(), kind, serverId, listen: listen.trim(), target: socks ? '' : target.trim() }
    if (tunnel) {
      // Stop first: the running tunnel still holds the old port, and leaving it
      // there is how "I changed the port and it is still in use" happens.
      void window.opsmaxx?.tunnel.stop(tunnel.id)
      saveTunnelEdit(tunnel.id, fields)
      toast(tr('tunnels.toast.saved', { name: fields.name }), 'ok')
    } else {
      addTunnel(fields)
      toast(tr('tunnels.toast.created', { name: fields.name }), 'ok')
    }
    onClose()
  }

  return (
    <Modal
      title={tunnel ? tr('tunnels.editTunnel') : tr('tunnels.createTunnel')}
      subtitle={tr('tunnels.form.subtitle')}
      onClose={onClose}
      // Was an action row at the bottom of a bordered `.card` nested inside the
      // body — a second container drawn inside a container, with the confirm
      // sitting a third of the way up the dialog. The dialog next to this one
      // in the same product put its confirm bottom-right.
      confirm={{
        label: tunnel ? tr('tunnels.form.saveChanges') : tr('tunnels.createTunnel'),
        disabled: !valid,
        onClick: save
      }}
    >
      <Field
        label={tr('tunnels.form.name')}
        required
        error={problem('name', name.trim() ? null : tr('tunnels.form.nameMissing'))}
      >
        <input
          className="input"
          placeholder="web-db"
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={touch('name')}
        />
      </Field>

      <div className="field">
        <span className="field-label">{tr('tunnels.form.kind')}</span>
        <div className="row" style={{ gap: 6 }}>
          {(['local', 'remote', 'socks'] as TunnelKind[]).map((k) => (
            <button
              key={k}
              className={clsx('btn size-28', kind === k ? 'primary' : 'secondary')}
              onClick={() => {
                setKind(k)
                // Both directions, not just into socks. See listenForKind: a
                // field the user has typed into is left alone, an untouched
                // default is swapped for the new kind's.
                setListen((cur) => listenForKind(cur, k))
              }}
            >
              {tr(kindLabel[k])}
            </button>
          ))}
        </div>
        <span className="field-hint">
          {kind === 'local' && tr('tunnels.form.hintLocal')}
          {kind === 'remote' && tr('tunnels.form.hintRemote')}
          {kind === 'socks' && tr('tunnels.form.hintSocks')}
        </span>
      </div>

      <Field
        label={tr('tunnels.form.server')}
        required
        error={
          servers.length === 0
            ? tr('tunnels.form.noServersError')
            : problem('serverId', serverId ? null : tr('tunnels.form.serverMissing'))
        }
      >
        <select
          className="input"
          value={serverId}
          onChange={(e) => setServerId(e.target.value)}
          onBlur={touch('serverId')}
        >
          {servers.length === 0 && <option value="">{tr('tunnels.form.noServersOption')}</option>}
          {servers.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} ({s.username}@{s.host})
            </option>
          ))}
        </select>
      </Field>

      <Field
        label={kind === 'remote' ? tr('tunnels.form.listenRemote') : tr('tunnels.form.listenLocal')}
        required
        error={problem('listen', parseEndpoint(listen).port > 0 ? null : tr(PORT_PROBLEM))}
      >
        <input
          className="input"
          value={listen}
          onChange={(e) => setListen(e.target.value)}
          onBlur={touch('listen')}
          placeholder={TUNNEL_DEFAULT_LISTEN[kind]}
        />
      </Field>

      {!socks && (
        <Field
          label={kind === 'remote' ? tr('tunnels.form.targetRemote') : tr('tunnels.form.targetLocal')}
          required
          error={problem('target', parseEndpoint(target).port > 0 ? null : tr(PORT_PROBLEM))}
        >
          <input
            className="input"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            onBlur={touch('target')}
            placeholder="localhost:80"
          />
        </Field>
      )}
    </Modal>
  )
}
