import { useEffect } from 'react'
import type { CloudTarget } from '../../../../shared/cloud'
import { useApp } from '../../store/app'
import { useVault } from '../../store/vault'
import { toast } from '../../store/toast'
import { bridgeOn } from '../../lib/bridge'
import { agentServerFields } from '../../lib/agentServerPatch'
import { rdpSecretId } from '../../../../shared/rdp'
import type { DbKind } from '../../../../shared/db'
import { saveDatabaseEdit } from '../../store/dbEditor'
import type { Hop, TunnelKind } from '../../types'
import { t } from '../../lib/i18n'

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
  auth: 'password' | 'key' | 'certificate' | 'agent'
}

interface CreateRequest {
  workspaceId: string
  name: string
  host: string
  port: number
  username: string
  auth: 'password' | 'key' | 'certificate' | 'agent'
  password?: string
  keyPath?: string
  passphrase?: string
  certificatePath?: string
  os?: string
  route?: RequestHop[]
  cloud?: CloudTarget
  folderId?: string | null
}

interface ServerPatch {
  name?: string
  host?: string
  port?: number
  username?: string
  auth?: 'password' | 'key' | 'certificate' | 'agent'
  password?: string
  keyPath?: string
  passphrase?: string
  certificatePath?: string
  os?: string
  route?: RequestHop[]
  cloud?: CloudTarget
  folderId?: string | null
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
  | { kind: 'database.add'; workspaceId: string; fields: DatabaseFields; secret?: DatabaseSecret }
  | { kind: 'database.update'; databaseId: string; patch: Partial<DatabaseFields>; secret?: DatabaseSecret }
  | { kind: 'database.remove'; databaseId: string }
  | { kind: 'workspace.add'; name: string }
  | { kind: 'workspace.rename'; workspaceId: string; name: string }
  | { kind: 'folder.add'; workspaceId: string; name: string; parentId: string | null }
  | { kind: 'folder.rename'; folderId: string; name: string }

interface DatabaseFields {
  name: string
  kind: DbKind
  host: string
  port: number
  username: string
  database: string
  ssl: boolean
  uri: boolean
  sshServerId: string | null
}

type DatabaseSecret = { password: string } | { uri: string }

/**
 * What to store under a database's id for a credential an agent sent.
 *
 * The same preference Add Database applies: into the vault, as a `login` for a
 * password and a `key` for a connection string, because a vault entry travels
 * in an encrypted backup and a keychain copy does not. And the same rule the
 * agent's server add follows: only when the vault is already open. Nobody is at
 * the keyboard for this, so it never raises a master-password prompt.
 */
async function databaseSecretFor(
  name: string,
  username: string,
  secret: DatabaseSecret
): Promise<{ stored: Record<string, string>; intoVault: boolean }> {
  if (useVault.getState().stage === 'open') {
    const isUri = 'uri' in secret
    const entryId = isUri
      ? await useVault.getState().createEntry('key', {
          name,
          password: secret.uri,
          tags: ['database', 'connection-string', 'agent']
        })
      : await useVault.getState().createEntry('login', {
          name: username ? `${name} (${username})` : name,
          username,
          password: secret.password,
          tags: ['database', 'agent']
        })
    if (entryId) {
      return { stored: isUri ? { vaultUriEntryId: entryId } : { vaultEntryId: entryId }, intoVault: true }
    }
  }
  return { stored: { ...secret }, intoVault: false }
}

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

/**
 * Throws unless `folderId` is a server folder in `workspaceId`; null is the
 * root and always fine.
 *
 * Main resolved the folder already, but inside the workspace it believed the
 * server was in, from a cache a save behind. A folder in another workspace
 * would leave the server listed in one workspace and drawn under a folder of
 * another, and the workspace is what decides which session can reach it.
 */
function checkServerFolder(workspaceId: string, folderId: string | null): void {
  if (folderId === null) return
  const folder = useApp.getState().folders.find((f) => f.id === folderId)
  if (!folder) throw new Error('That folder no longer exists.')
  if ((folder.kind ?? 'server') !== 'server') throw new Error('That folder is not a server folder.')
  if (folder.workspaceId !== workspaceId) throw new Error('That folder is in a different workspace.')
}

function nameOf(raw: unknown): string {
  const name = typeof raw === 'string' ? raw.trim() : ''
  if (!name) throw new Error('A name is required.')
  return name
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
          // Before the row exists, so a refusal leaves nothing to take back.
          checkServerFolder(req.workspaceId, req.folderId ?? null)
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
            route: toHops(req.route) ?? [],
            folderId: req.folderId ?? null,
            // Same trap, same fix: without this a cloud server would be saved
            // with an empty host and no way to reach anything.
            ...(req.cloud ? { cloud: req.cloud } : {})
          })

          // Same shape AddServerModal writes: credentials go to OS secure
          // storage keyed by server id, never into the connection list itself.
          // A cloud server has no credential to store: the provider mints a
          // short-lived one per connection and OpsMaxx keeps none of it.
          // Certificate auth is the key plus the certificate beside it, in the
          // same blob AddServerModal writes; no certificatePath means OpenSSH's
          // `-cert.pub` convention, applied when the connection is dialled.
          let secret: {
            password?: string
            keyPath?: string
            passphrase?: string
            certificatePath?: string
            vaultEntryId?: string
          } | null = req.cloud
            ? null
            : req.auth === 'password'
              ? { password: req.password }
              : req.auth === 'key' || req.auth === 'certificate'
                ? {
                    keyPath: req.keyPath,
                    passphrase: req.passphrase || undefined,
                    ...(req.auth === 'certificate' && req.certificatePath
                      ? { certificatePath: req.certificatePath }
                      : {})
                  }
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
              toast(t('ai.agentConfig.serverNotAdded', { name: req.name }), 'error')
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
            intoVault
              ? t('ai.agentConfig.serverAddedVault', { name: req.name })
              : t('ai.agentConfig.serverAdded', { name: req.name }),
            'ok',
            {
              label: t('ai.agentConfig.showIt'),
              run: () => useApp.getState().setActivity('connections')
            }
          )
          api?.replyCreateServer?.(id, { ok: true, serverId })
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err)
          toast(t('ai.agentConfig.addFailed', { name: req.name, reason }), 'error')
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
              const { password, keyPath, passphrase, certificatePath, route } = req.patch
              const rest = agentServerFields(req.patch)
              const hops = toHops(route)
              // Checked against the server's own workspace, which no patch can
              // change, and before anything is written so a refusal is whole.
              if (req.patch.folderId !== undefined) checkServerFolder(before.workspaceId, req.patch.folderId)
              useApp.getState().updateServer(req.serverId, { ...rest, ...(hops ? { route: hops } : {}) })
              if (req.patch.folderId !== undefined) useApp.getState().moveServerToFolder(req.serverId, req.patch.folderId)

              // A credential is only rewritten when the agent sent one. An
              // update that changes a port must not silently erase the key the
              // connection has been using.
              if (password || keyPath || passphrase) {
                const secret =
                  (req.patch.auth ?? before.auth) === 'password'
                    ? { password }
                    : { keyPath, passphrase: passphrase || undefined, ...(certificatePath ? { certificatePath } : {}) }
                const ok = await window.opsmaxx?.secrets.set(req.serverId, JSON.stringify(secret))
                if (ok === false) {
                  // Unlike the add path there is nothing to roll back to --
                  // the old credential is already gone from our hands. Say so
                  // rather than reporting a success that left the connection
                  // unable to authenticate.
                  toast(t('ai.agentConfig.changedNoCredential', { name: before.name }), 'error')
                  api?.replyConfigWrite?.(id, {
                    ok: false,
                    error: 'OS secure storage is unavailable, so the credential could not be saved.'
                  })
                  return
                }
              }
              toast(t('ai.agentConfig.serverChanged', { name: rest.name ?? before.name }), 'ok', {
                label: t('ai.agentConfig.showIt'),
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
              toast(t('ai.agentConfig.serverRemoved', { name: gone.name }), 'ok')
              api?.replyConfigWrite?.(id, { ok: true, id: req.serverId })
              return
            }
            case 'tunnel.add': {
              const tunnelId = useApp.getState().addTunnel({
                name: req.name,
                kind: req.tunnelKind,
                serverId: req.serverId,
                listen: req.listen,
                target: req.target,
                // The carrier's workspace, which main resolved. Without it the
                // tunnel landed in whichever workspace was on screen.
                workspaceId: req.workspaceId
              })
              // Says that it is defined and NOT running. The two are separate
              // approvals on the bridge and conflating them here would make the
              // toast promise something that has not happened.
              toast(t('ai.agentConfig.tunnelDefined', { name: req.name }), 'ok', {
                label: t('ai.agentConfig.showIt'),
                run: () => useApp.getState().setActivity('tunnels')
              })
              api?.replyConfigWrite?.(id, { ok: true, id: tunnelId })
              return
            }
            case 'tunnel.remove': {
              const gone = useApp.getState().tunnels.find((x) => x.id === req.tunnelId)
              if (!gone) throw new Error('That tunnel no longer exists.')
              // Stop before forgetting: a running forward whose record is gone
              // is a listener nothing in the UI can close.
              await window.opsmaxx?.tunnel?.stop(req.tunnelId)
              useApp.getState().deleteTunnel(req.tunnelId)
              toast(t('ai.agentConfig.tunnelRemoved', { name: gone.name }), 'ok')
              api?.replyConfigWrite?.(id, { ok: true, id: req.tunnelId })
              return
            }
            case 'database.add': {
              const databaseId = useApp.getState().addDatabase({
                ...req.fields,
                folderId: null,
                vpnProfileId: null,
                workspaceId: req.workspaceId
              })
              let intoVault = false
              if (req.secret) {
                const put = await databaseSecretFor(req.fields.name, req.fields.username, req.secret)
                intoVault = put.intoVault
                const ok = await window.opsmaxx?.secrets.set(databaseId, JSON.stringify(put.stored))
                if (ok === false) {
                  // Same call as the server add: a connection saved without the
                  // credential the agent supplied cannot authenticate, so it is
                  // taken back out rather than reported as added.
                  useApp.getState().deleteDatabase(databaseId)
                  toast(t('ai.agentConfig.databaseNotAdded', { name: req.fields.name }), 'error')
                  api?.replyConfigWrite?.(id, {
                    ok: false,
                    error: 'OS secure storage is unavailable, so the credential could not be saved.'
                  })
                  return
                }
              }
              toast(
                intoVault
                  ? t('ai.agentConfig.databaseAddedVault', { name: req.fields.name })
                  : t('ai.agentConfig.databaseAdded', { name: req.fields.name }),
                'ok',
                { label: t('ai.agentConfig.showIt'), run: () => useApp.getState().setActivity('databases') }
              )
              api?.replyConfigWrite?.(id, { ok: true, id: databaseId })
              return
            }
            case 'database.update': {
              const before = useApp.getState().databases.find((d) => d.id === req.databaseId)
              if (!before) throw new Error('That database no longer exists.')
              // Through the dialog's own save path, which bumps the revision and
              // closes the cached client -- so the next query reaches what the
              // record now names rather than what it used to.
              saveDatabaseEdit(req.databaseId, req.patch)
              if (req.secret) {
                const name = req.patch.name ?? before.name
                const put = await databaseSecretFor(name, req.patch.username ?? before.username, req.secret)
                const ok = await window.opsmaxx?.secrets.set(req.databaseId, JSON.stringify(put.stored))
                if (ok === false) {
                  toast(t('ai.agentConfig.changedNoCredential', { name }), 'error')
                  api?.replyConfigWrite?.(id, {
                    ok: false,
                    error: 'OS secure storage is unavailable, so the credential could not be saved.'
                  })
                  return
                }
              }
              toast(t('ai.agentConfig.databaseChanged', { name: req.patch.name ?? before.name }), 'ok', {
                label: t('ai.agentConfig.showIt'),
                run: () => useApp.getState().setActivity('databases')
              })
              api?.replyConfigWrite?.(id, { ok: true, id: req.databaseId })
              return
            }
            case 'database.remove': {
              const gone = useApp.getState().databases.find((d) => d.id === req.databaseId)
              if (!gone) throw new Error('That database no longer exists.')
              // Close before forgetting, as a tunnel is stopped first: a pooled
              // client whose record is gone is a connection nothing can close.
              await window.opsmaxx?.db?.close?.(req.databaseId)
              useApp.getState().deleteDatabase(req.databaseId)
              void window.opsmaxx?.secrets.delete(req.databaseId)
              toast(t('ai.agentConfig.databaseRemoved', { name: gone.name }), 'ok')
              api?.replyConfigWrite?.(id, { ok: true, id: req.databaseId })
              return
            }
            // A new workspace is in no session, this one's included, until the
            // person grants it under AI & MCP -> Sessions. Never locked, hidden
            // or password-protected: those are the person's to set.
            case 'workspace.add': {
              const name = nameOf(req.name)
              const workspaceId = useApp.getState().addWorkspace(name)
              toast(t('ai.agentConfig.workspaceAdded', { name }), 'ok')
              api?.replyConfigWrite?.(id, { ok: true, id: workspaceId })
              return
            }
            case 'workspace.rename': {
              const name = nameOf(req.name)
              const before = useApp.getState().workspaces.find((w) => w.id === req.workspaceId)
              if (!before) throw new Error('That workspace no longer exists.')
              useApp.getState().renameWorkspace(req.workspaceId, name)
              toast(t('ai.agentConfig.workspaceRenamed', { from: before.name, name }), 'ok')
              api?.replyConfigWrite?.(id, { ok: true, id: req.workspaceId })
              return
            }
            case 'folder.add': {
              const name = nameOf(req.name)
              if (!useApp.getState().workspaces.some((w) => w.id === req.workspaceId))
                throw new Error('That workspace no longer exists.')
              checkServerFolder(req.workspaceId, req.parentId ?? null)
              const folderId = useApp.getState().addFolder(name, req.parentId ?? null, 'server', req.workspaceId)
              toast(t('ai.agentConfig.folderAdded', { name }), 'ok', {
                label: t('ai.agentConfig.showIt'),
                run: () => useApp.getState().setActivity('connections')
              })
              api?.replyConfigWrite?.(id, { ok: true, id: folderId })
              return
            }
            case 'folder.rename': {
              const name = nameOf(req.name)
              const before = useApp.getState().folders.find((f) => f.id === req.folderId)
              if (!before) throw new Error('That folder no longer exists.')
              // Database folders are a separate tree the folder tools do not
              // speak for.
              if ((before.kind ?? 'server') !== 'server') throw new Error('That folder is not a server folder.')
              useApp.getState().renameFolder(req.folderId, name)
              toast(t('ai.agentConfig.folderRenamed', { from: before.name, name }), 'ok')
              api?.replyConfigWrite?.(id, { ok: true, id: req.folderId })
              return
            }
          }
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err)
          toast(t('ai.agentConfig.writeFailed', { reason }), 'error')
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
