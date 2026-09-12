// The main-process half of the CI/CD module: the part that is allowed to hold
// a token.
//
// `src/shared/cicd.ts` defines an adapter as a thing that takes a `CicdHttp`
// and asks questions with it. This file is what makes that port real — it
// resolves the API root, merges the credential into the headers, maps the
// connection's route onto an `HttpVia`, and calls `httpRequest`.
//
// The division of labour is the point. An adapter knows the provider's URL
// shapes and JSON; it never sees a secret, never sees a server record and
// never learns that SSH or VPNs exist. Everything in this file is the reason
// it can stay that way, which is also why this file is main-only and why the
// module's `MODULE_FILES` entry will omit it (see §3 of the plan: `inventory`
// omits `hostFacts.ts` for the same reason).

import { createGithubAdapter } from './github'
import { createGitlabAdapter, GITLAB_AUTH_HEADER } from './gitlab'
import { createJenkinsAdapter } from './jenkins'
import { resolveVaultField } from '../credentialResolver'
import { httpRequest } from '../httpClient'
import { getCachedServer, type CachedServer } from '../mcpDataCache'
import { preparedSshTarget } from '../vpn/transport'
import type { HttpRequestSpec, HttpResult, HttpVia } from '../../../shared/httpClient'
import type { CicdAdapter, CicdConnection, CicdHttp } from '../../../shared/cicd'

/**
 * Hops a `followRedirect: true` request will take.
 *
 * GitHub's job-log endpoint answers 302 with a one-minute signed blob URL on
 * another origin. One hop is what that needs; the couple of spare ones cover a
 * reverse proxy in front of a self-hosted install normalising a path. The
 * credential does not travel across the origin change — `httpClient` strips it
 * — which is the whole reason following is safe to offer at all.
 */
const REDIRECT_HOPS = 3

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

/**
 * The connection's token, read at the moment of use and never cached here.
 *
 * `resolveVaultField` is the single read path for a stored secret, and a
 * locked vault throws `VaultLockedError` out of it. That error is deliberately
 * NOT caught: "the vault is locked" and "the CI server is unreachable" send the
 * user to two completely different places, and falling back to a stale copy of
 * a token the user has since rotated is worse than either.
 *
 * The `key` vault kind keeps its secret in `password` (`shared/vault.ts:19`),
 * so that is the slot for all three providers — what differs is the header it
 * ends up in, which is `authHeaders` below.
 */
export function resolveSecret(connection: CicdConnection): string {
  const secret = resolveVaultField({ vaultEntryId: connection.vaultEntryId, slot: 'password' })
  if (secret === null) {
    throw new Error(
      `"${connection.name}" points at a vault entry that no longer holds a credential. Re-attach its API token.`
    )
  }
  return secret
}

/**
 * Where each provider carries its credential.
 *
 * Here and nowhere else. An adapter that built its own auth header would be an
 * adapter that had to be handed the token, and the reason none of the three
 * can leak one is that none of the three is ever given one.
 */
export function authHeaders(connection: CicdConnection, secret: string): Record<string, string> {
  switch (connection.provider) {
    case 'jenkins': {
      // Jenkins authenticates as a user: the token alone is not a credential.
      const username = connection.username?.trim()
      if (!username) {
        throw new Error(
          `"${connection.name}" needs the Jenkins username the API token belongs to — a token on its own does not authenticate.`
        )
      }
      const basic = Buffer.from(`${username}:${secret}`, 'utf8').toString('base64')
      return { Authorization: `Basic ${basic}` }
    }
    case 'gitlab':
      // Not `Authorization: Bearer`: that form is for OAuth tokens, and a PAT
      // sent that way is accepted on some endpoints and refused on others.
      return { [GITLAB_AUTH_HEADER]: secret }
    case 'github':
      return { Authorization: `Bearer ${secret}` }
  }
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

/**
 * The connection's route, as the transport's `via`.
 *
 * Three of the four routes in §5.1's table need no code at all: `direct` covers
 * SaaS and anything behind a tunnel the user opened themselves, and `server`
 * hands `acquire()` the whole saved chain — jump hops, the server's own VPN
 * profile, the first-hop rewrite, the system-mode fallback. `vpn` is the one
 * genuine gap: a GitLab on a VPN subnet with no server in front of it, which a
 * userspace tunnel's local-listeners-only model puts out of reach of a plain
 * `net.connect`.
 */
export function viaForConnection(
  connection: CicdConnection,
  lookupServer: (id: string) => CachedServer | null = getCachedServer
): HttpVia {
  const route = connection.route
  switch (route.kind) {
    case 'direct':
      return { kind: 'direct' }
    case 'vpn':
      return { kind: 'vpn', vpnProfileId: route.vpnProfileId }
    case 'server': {
      const server = lookupServer(route.serverId)
      if (!server) {
        // Named as a route failure, not a CI failure. §5.1(4): "ci.internal not
        // read: the server it routes through is gone" is a different sentence
        // from "Jenkins is unreachable", and only one sends the user anywhere
        // useful.
        throw new Error(
          `"${connection.name}" routes through a saved server that no longer exists. Pick another route for it.`
        )
      }
      return {
        kind: 'server',
        server: {
          host: server.host,
          port: server.port,
          username: server.username,
          auth: server.auth,
          // The chain and the profile both travel with the target; `acquire()`
          // is what understands them, and it already does.
          serverId: server.id,
          serverName: server.name,
          hops: server.route,
          ...(server.vpnProfileId ? { vpnProfileId: server.vpnProfileId } : {})
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// The transport factory
// ---------------------------------------------------------------------------

export interface CicdHttpDeps {
  /** The transport. Injected so a test opens no socket. */
  request?: (spec: HttpRequestSpec, ctx: { prepare: typeof preparedSshTarget }) => Promise<HttpResult>
  /** How a saved server is found. Injected for the same reason. */
  lookupServer?: (id: string) => CachedServer | null
  timeoutMs?: number
}

/**
 * The adapter-facing port, wired to real requests.
 *
 * `secret` is a parameter rather than something this reads, so the caller
 * decides when the vault is touched — a poller resolving once per tick and a
 * verify resolving once are different, and neither wants the decision made
 * here.
 */
/**
 * Refuse a request that would leave the connection's API root.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS, AND WHY IT IS HERE RATHER THAN IN THE ADAPTERS
 * ---------------------------------------------------------------------------
 *
 * `CicdPipeline.ref` and `CicdRun.id` are documented as opaque handles, and an
 * AI agent passes them back verbatim. They were not opaque: they are raw URL
 * path fragments, `new URL()` resolves `..` before the request is sent, and two
 * of the three adapters interpolated them unescaped. A `runId` of
 * `../../scriptText?script=…` reached Jenkins' Groovy console as the service
 * account, and a `pipelineRef` of `../../credentials/…/api/json` returned the
 * credential store to the model as "the build log" — under `ciRead`, a
 * read-only tool with no approval at all.
 *
 * The agent choosing those strings is precisely the party the rest of this
 * module assumes is compromised: it is steered by build output that whoever
 * opened the merge request wrote.
 *
 * One check here beats three in the adapters, because this is the single point
 * every request passes through and the only place that knows the API root. It
 * compares the RESOLVED url against the root, so it does not matter how the
 * escape was spelled — `..`, an encoded `%2e%2e`, a scheme-relative `//host`,
 * or a `?` that pushes the rest of the path into a query string.
 */
function withinRoot(root: string, url: string): boolean {
  let base: URL
  let target: URL
  try {
    base = new URL(root)
    target = new URL(url)
  } catch {
    return false
  }
  if (base.origin !== target.origin) return false
  // The root's path is a prefix BOUNDARY, not a string prefix: `/api/v4` must
  // not admit `/api/v4evil`.
  const prefix = base.pathname.replace(/\/+$/, '')
  return target.pathname === prefix || target.pathname.startsWith(`${prefix}/`)
}

/**
 * Dot-segments and host-changing spellings, in the path an adapter built.
 *
 * `withinRoot` alone is not enough, and finding that out is the whole reason
 * this is two checks. A Jenkins root of `https://ci/jenkins` with a handle of
 * `../../credentials/store/system/domain/_/api/json` normalises to
 * `/jenkins/credentials/...` — still inside the root, and still the credential
 * store rather than a build log. Containment answers "did it leave the API";
 * this answers "did it navigate", and only the second one catches a traversal
 * that stays under the prefix.
 *
 * Only the exact segments `.` and `..` are refused, raw or percent-encoded.
 * A segment that merely BEGINS with a dot is ordinary and must pass:
 * `.github/workflows/ci.yml` is a real GitHub pipeline ref.
 *
 * The query string is examined for neither, because adapters build legitimate
 * ones (`?tree=`, `?start=`) and a handle interpolated into a query cannot
 * change which endpoint is addressed.
 */
function navigates(path: string): boolean {
  const q = path.indexOf('?')
  const justPath = q < 0 ? path : path.slice(0, q)
  // `//host/...` is scheme-relative and `https://host` is absolute; either one
  // replaces the host when resolved against the root.
  if (/^\/\//.test(justPath) || /^\/[a-z][a-z0-9+.-]*:\/\//i.test(justPath)) return true
  let decoded = justPath
  try {
    decoded = decodeURIComponent(justPath)
  } catch {
    // A malformed escape is not something a handle we issued would contain.
    return true
  }
  return decoded.split('/').some((seg) => seg === '.' || seg === '..')
}

export function makeCicdHttp(
  connection: CicdConnection,
  secret: string,
  deps: CicdHttpDeps = {}
): CicdHttp {
  const request = deps.request ?? httpRequest
  const root = apiRootFor(connection)
  const auth = authHeaders(connection, secret)
  const via = viaForConnection(connection, deps.lookupServer)

  return async (req) => {
    const path = req.path.startsWith('/') ? req.path : `/${req.path}`
    const url = `${root}${path}`
    if (navigates(path) || !withinRoot(root, url)) {
      // Named for what it is rather than blamed on the provider. This is only
      // reachable when a handle was tampered with, so it should read as a
      // refusal by OpsMaxx, not as the CI server behaving oddly.
      throw new Error(
        'Refused: that pipeline or run handle would address something outside this CI server\'s API. Handles are passed back exactly as they were given.'
      )
    }
    const result = await request(
      {
        url,
        method: req.method,
        // The adapter's headers first, so it can set Accept and If-None-Match,
        // and the credential last, so it cannot be talked out of one.
        headers: { ...req.headers, ...auth },
        ...(req.body === undefined
          ? {}
          : { body: new TextEncoder().encode(req.body).buffer as ArrayBuffer }),
        via,
        ...(connection.caPem ? { caPem: connection.caPem } : {}),
        ...(connection.insecureTls ? { insecureTls: true } : {}),
        maxRedirects: req.followRedirect ? REDIRECT_HOPS : 0,
        ...(deps.timeoutMs === undefined ? {} : { timeoutMs: deps.timeoutMs })
      },
      { prepare: (target) => preparedSshTarget(target) }
    )

    // A transport failure is not a response, and pretending it is one (status
    // 0, empty body) would have every adapter's `expectOk` report a DNS failure
    // as "the provider answered oddly".
    if (!result.ok) throw new Error(result.error)

    return {
      status: result.status,
      headers: result.headers,
      body: Buffer.from(result.body).toString('utf8')
    }
  }
}

// ---------------------------------------------------------------------------
// Adapters
// ---------------------------------------------------------------------------

/** Throws if called. Used to read a provider's `apiRoot`, which is pure. */
const UNUSED: CicdHttp = () => {
  throw new Error('This adapter exists only to derive an API root.')
}

function adapterFor(connection: CicdConnection, http: CicdHttp): CicdAdapter {
  switch (connection.provider) {
    case 'jenkins':
      return createJenkinsAdapter(http, { connectionId: connection.id })
    case 'gitlab':
      return createGitlabAdapter(http, { connectionId: connection.id })
    case 'github':
      return createGithubAdapter(http, { connectionId: connection.id, baseUrl: connection.baseUrl })
  }
}

/**
 * The API root, from the adapter that owns the rule.
 *
 * Not re-derived here. The three shapes genuinely differ — GitLab appends
 * `/api/v4`, GitHub Enterprise appends `/api/v3` while github.com moves to a
 * different HOST, Jenkins keeps whatever context path its admin chose — and a
 * second copy of that branch is a second place for it to be wrong.
 */
export function apiRootFor(connection: CicdConnection): string {
  return adapterFor(connection, UNUSED).apiRoot(connection.baseUrl)
}

/** A connection's adapter, with the credential merged and the route resolved. */
export function createCicdAdapter(
  connection: CicdConnection,
  secret: string,
  deps: CicdHttpDeps = {}
): CicdAdapter {
  return adapterFor(connection, makeCicdHttp(connection, secret, deps))
}
