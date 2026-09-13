import { useEffect } from 'react'
import { useApp } from '../../store/app'
import { useVault } from '../../store/vault'
import { toast } from '../../store/toast'
import { bridgeOn } from '../../lib/bridge'
import { rdpSecretId } from '../../../../shared/rdp'
import type { Hop, TunnelKind } from '../../types'

/**
 * A jump hop as main resolved it.
 *
 * `serverId` is already a saved server's id — main turned the friendly name
 * into one, because an agent is never told a hostname and so cannot type a raw
 * bastion address even if it wanted to. The hop authenticates with THAT
 * server's stored credential, so nothing here carries a secret.
 */
interface RequestHop {
  serverId: string
  label: string
  host: string
  port: number
  username: string
  auth: 'password' | 'key' | 'agent'
}

interface CreateRequest {
  workspaceId: string
  name: string
  host: string
  port: number
  username: string
  auth: 'password' | 'key' | 'agent'
  password?: string
  keyPath?: string
  passphrase?: string
  os?: string
  route?: RequestHop[]
}

interface ServerPatch {
  name?: string
  host?: string
  port?: number
  username?: string
  auth?: 'password' | 'key' | 'agent'
  password?: string
  keyPath?: string
  passphrase?: string
  os?: string
  route?: RequestHop[]
}

type ConfigRequest =
  | { kind: 'server.update'; serverId: string; patch: ServerPatch }
  | { kind: 'server.remove'; serverId: string }
  | {
      kind: 'tunnel.add'
      workspaceId: string
      name: string
      tunnelKind: TunnelKind
      serverId: string | null
      listen: string
      target: string
    }
  | { kind: 'tunnel.remove'; tunnelId: string }

/**
 * Main's hops, given the ids the store expects.
 *
 * `Hop.id` is the store's own key for a row in the route editor and means
 * nothing outside this window, so it is minted here rather than sent across —
 * main has no business inventing renderer identifiers.
 */
function toHops(route: RequestHop[] | undefined): Hop[] | undefined {
  if (!route) return undefined
  return route.map((h, i) => ({
    id: `hop-agent-${Date.now()}-${i}`,
    label: h.label,
    host: h.host,
    port: h.port,
    username: h.username,
    auth: h.auth,
    serverId: h.serverId
  }))
}

// Mounted once at the app root, like ApprovalWatcher. The add_server MCP tool
// has already resolved the workspace, checked the access group and taken the
// user's approval by the time this runs — the work left here is the part only
// the renderer can do, because it owns the connection list and the persistence
// that follows from changing it.
export function AgentConfigWatcher(): null {
  useEffect(() => {
    const api = window.opsmaxx?.aiMcp
    const off = bridgeOn('aiMcp.onCreateServerRequest', api?.onCreateServerRequest, ({ id, request }) => {
      void (async () => {
        const req = request as unknown as CreateRequest
        try {
          const serverId = useApp.getState().addServer({
            workspaceId: req.workspaceId,
            name: req.name,
            host: req.host,
            port: req.port,
            username: req.username,
            auth: req.auth,
            os: req.os ?? 'Linux',
            // The jump chain. `addServer` builds its record field by field, so
            // a field that is not named here is dropped in silence — which is
            // exactly how a bastion-only server would come back configured to
            // dial direct and time out, with nothing saying why.
            route: toHops(req.route) ?? []
          })

          // Same shape AddServerModal writes: credentials go to OS secure
          // storage keyed by server id, never into the connection list itself.
          let secret: { password?: string; keyPath?: string; passphrase?: string; vaultEntryId?: string } | null =
            req.auth === 'password'
              ? { password: req.password }
              : req.auth === 'key'
                ? { keyPath: req.keyPath, passphrase: req.passphrase || undefined }
                : null

          /**
           * Into the vault when it is already open, and NEVER a prompt.
           *
           * The same preference the two Add dialogs apply, for the same reason:
           * a credential in the vault is one record, reusable and rotated in
           * one place, and it travels inside an encrypted backup where a
           * keychain copy cannot. But this path has no person in it — raising a
           * master-password dialog because an agent did something unattended is
           * the original bug wearing a new hat. So it takes the vault when the
           * vault is there for the taking and the keychain otherwise, and the
           * toast below says which, because "where did my credential go" should
           * not need a support thread.
           */
          let intoVault = false
          if (req.auth === 'password' && req.password && useVault.getState().stage === 'open') {
            const entryId = await useVault.getState().createEntry('login', {
              name: `${req.name} (${req.username})`,
              username: req.username,
              password: req.password,
              tags: ['server', 'agent']
            })
            if (entryId) {
              secret = { vaultEntryId: entryId }
              intoVault = true
            }
          }
          if (secret && (secret.password || secret.keyPath || secret.vaultEntryId)) {
            const ok = await window.opsmaxx?.secrets.set(serverId, JSON.stringify(secret))
            if (ok === false) {
              // The server row is useless without the credential the agent
              // supplied, and half-adding it would leave the user to guess what
              // went wrong, so undo rather than report success.
              useApp.getState().deleteServer(serverId)
              // The agent is told; so is the person, who would otherwise see an
              // agent claim it added a server that is not there. Nothing in the
              // app can grant it access to the OS keychain, so this one has no
              // button — the sentence is the whole of what can be done.
              toast(
                `${req.name} was not added — this computer's secure storage refused the credential, and OpsMaxx will not keep one anywhere else.`,
                'error'
              )
              api?.replyCreateServer?.(id, {
                ok: false,
                error: 'OS secure storage is unavailable, so the credential could not be saved.'
              })
              return
            }
          }

          // Says which store the credential landed in. The two are not
          // interchangeable — a vault entry is reusable and travels in a
          // backup, a keychain copy is neither — so leaving it unsaid is
          // leaving the reader to find out later and wonder.
          toast(
            `An AI agent added the server ${req.name}.` +
              (intoVault ? ' Its credential was saved in the vault.' : ''),
            'ok',
            {
              label: 'Show it',
              run: () => useApp.getState().setActivity('connections')
            }
          )
          api?.replyCreateServer?.(id, { ok: true, serverId })
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err)
          toast(`An AI agent tried to add ${req.name} and it did not work: ${reason}`, 'error')
          api?.replyCreateServer?.(id, { ok: false, error: reason })
        }
      })()
    })

    // Everything that is not an add. One store call each, so unlike the add
    // path above there is no half-written state to unwind — but a removal has
    // to take the credential with it, because deleteServer does not.
    const offWrite = bridgeOn('aiMcp.onConfigWriteRequest', api?.onConfigWriteRequest, ({ id, request }) => {
      void (async () => {
        const req = request as unknown as ConfigRequest
        try {
          switch (req.kind) {
            case 'server.update': {
              const before = useApp.getState().servers.find((s) => s.id === req.serverId)
              if (!before) throw new Error('That server no longer exists.')
              const { password, keyPath, passphrase, route, ...rest } = req.patch
              const hops = toHops(route)
              useApp.getState().updateServer(req.serverId, { ...rest, ...(hops ? { route: hops } : {}) })

              // A credential is only rewritten when the agent sent one. An
              // update that changes a port must not silently erase the key the
              // connection has been using.
              if (password || keyPath || passphrase) {
                const secret =
                  (req.patch.auth ?? before.auth) === 'password'
                    ? { password }
                    : { keyPath, passphrase: passphrase || undefined }
                const ok = await window.opsmaxx?.secrets.set(req.serverId, JSON.stringify(secret))
                if (ok === false) {
                  // Unlike the add path there is nothing to roll back to --
                  // the old credential is already gone from our hands. Say so
                  // rather than reporting a success that left the connection
                  // unable to authenticate.
                  toast(
                    `${before.name} was changed, but this computer's secure storage refused the new credential.`,
                    'error'
                  )
                  api?.replyConfigWrite?.(id, {
                    ok: false,
                    error: 'OS secure storage is unavailable, so the credential could not be saved.'
                  })
                  return
                }
              }
              toast(`An AI agent changed the server ${rest.name ?? before.name}.`, 'ok', {
                label: 'Show it',
                run: () => useApp.getState().setActivity('connections')
              })
              api?.replyConfigWrite?.(id, { ok: true, id: req.serverId })
              return
            }
            case 'server.remove': {
              const gone = useApp.getState().servers.find((s) => s.id === req.serverId)
              if (!gone) throw new Error('That server no longer exists.')
              useApp.getState().deleteServer(req.serverId)
              // `deleteServer` forgets alerts, metrics and tabs but not the
              // credential -- ConnectionTree does that separately, and a
              // removal that left one behind would be the worst possible
              // half-completion for a tool whose whole purpose is cleanup.
              void window.opsmaxx?.secrets.delete(req.serverId)
              void window.opsmaxx?.secrets.delete(rdpSecretId(req.serverId))
              toast(`An AI agent removed the server ${gone.name}.`, 'ok')
              api?.replyConfigWrite?.(id, { ok: true, id: req.serverId })
              return
            }
            case 'tunnel.add': {
              const tunnelId = useApp.getState().addTunnel({
                name: req.name,
                kind: req.tunnelKind,
                serverId: req.serverId,
                listen: req.listen,
                target: req.target
              })
              // Says that it is defined and NOT running. The two are separate
              // approvals on the bridge and conflating them here would make the
              // toast promise something that has not happened.
              toast(`An AI agent defined the tunnel ${req.name}. It is not running.`, 'ok', {
                label: 'Show it',
                run: () => useApp.getState().setActivity('tunnels')
              })
              api?.replyConfigWrite?.(id, { ok: true, id: tunnelId })
              return
            }
            case 'tunnel.remove': {
              const gone = useApp.getState().tunnels.find((t) => t.id === req.tunnelId)
              if (!gone) throw new Error('That tunnel no longer exists.')
              // Stop before forgetting: a running forward whose record is gone
              // is a listener nothing in the UI can close.
              await window.opsmaxx?.tunnel?.stop(req.tunnelId)
              useApp.getState().deleteTunnel(req.tunnelId)
              toast(`An AI agent removed the tunnel ${gone.name}.`, 'ok')
              api?.replyConfigWrite?.(id, { ok: true, id: req.tunnelId })
              return
            }
          }
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err)
          toast(`An AI agent tried to change the OpsMaxx configuration and it did not work: ${reason}`, 'error')
          api?.replyConfigWrite?.(id, { ok: false, error: reason })
        }
      })()
    })

    return () => {
      off?.()
      offWrite?.()
    }
  }, [])

  return null
}
