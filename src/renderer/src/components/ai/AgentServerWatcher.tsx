import { useEffect } from 'react'
import { useApp } from '../../store/app'
import { useVault } from '../../store/vault'
import { toast } from '../../store/toast'
import { bridgeOn } from '../../lib/bridge'

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
}

// Mounted once at the app root, like ApprovalWatcher. The add_server MCP tool
// has already resolved the workspace, checked the access group and taken the
// user's approval by the time this runs — the work left here is the part only
// the renderer can do, because it owns the connection list and the persistence
// that follows from changing it.
export function AgentServerWatcher(): null {
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
            os: req.os ?? 'Linux'
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
    return () => off?.()
  }, [])

  return null
}
