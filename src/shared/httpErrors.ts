/** Transport failures, classified into what the response pane says and offers. */

import type { TransportErrorClass } from './apiModel'
import { maskUrl } from './apiUrl'
import { VAULT_ENTRY_GONE_MESSAGE, VAULT_LOCKED_MESSAGE } from './apiSecrets'
import { MAX_SOCKETS } from './httpSocket'
import { CONNECTION_REVIEW_MESSAGE } from './apiRequestBuild'

/**
 * The send layer's refusal while an environment's or the globals' synced
 * changes await review. store/api re-exports it as ENV_REVIEW_MESSAGE, so the
 * refusal and the fix that answers it cannot drift apart.
 */
export const ENV_REVIEW_TEXT = "Review this environment's changes"

/** What a fix button does; the response pane maps each to a handler. */
export type FixAction =
  | 'route-menu'
  | 'raise-timeout'
  | 'retry-http'
  | 'add-ca'
  | 'save-then-ca'
  | 'unlock'
  | 'choose-vault'
  | 'add-variable'
  | 'send-anyway'
  | 'disconnect-idle'
  | 'restart'
  | 'review-env'
  | 'review-collection'

export interface ClassifiedError {
  class: TransportErrorClass
  /** The sentence the pane leads with. */
  message: string
  fix?: { label: string; action: FixAction }
  /** What main or the build actually said, URLs masked. Absent when it adds nothing. */
  detail?: string
}

const TLS_CODES = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'HOSTNAME_MISMATCH'
])

/** Node's code first, the text second. */
function classOf(message: string, code = ''): TransportErrorClass {
  const c = code.toUpperCase()
  if (c === 'ENOTFOUND' || c === 'EAI_AGAIN') return 'dns'
  if (c === 'ECONNREFUSED') return 'refused'
  if (c === 'ETIMEDOUT' || /\btimed out\b/i.test(message)) return 'timeout'
  // A plain-HTTP port answering a TLS hello: the TLS library reads the start
  // of an HTTP response as a record with a nonsense version. OpenSSL says
  // "wrong version number"; Electron's BoringSSL says WRONG_VERSION_NUMBER.
  if (c === 'EPROTO' || c === 'ERR_SSL_WRONG_VERSION_NUMBER' || /wrong[ _]version[ _]number/i.test(message)) {
    return 'tls-not-tls'
  }
  if (c.startsWith('CERT_') || c.startsWith('ERR_TLS_') || TLS_CODES.has(c)) return 'tls'
  if (c === 'ECONNRESET') return 'reset'
  if (c === 'ABORTED' || c === 'ABORT_ERR') return 'aborted'
  if (message === VAULT_LOCKED_MESSAGE) return 'vault-locked'
  if (message === VAULT_ENTRY_GONE_MESSAGE) return 'vault-entry-gone'
  if (/\b\d+ open sockets\b/.test(message)) return 'socket-cap'
  return 'other'
}

/**
 * Every URL in a message, masked. Main's errors embed the resolved URL, which
 * can carry a vault-resolved query secret or userinfo (SEC-L8).
 */
export function maskUrlsIn(text: string): string {
  return text.replace(/\b(?:https?|wss?):\/\/[^\s"'<>]+/gi, (url) => {
    try {
      return maskUrl(url)
    } catch {
      return '•••'
    }
  })
}

export interface PresentCtx {
  /** The request's timeout, for "Timed out after N s". */
  timeoutMs?: number
  /** A scratch tab has no collection to hold a CA, so it is offered a save first. */
  scratch?: boolean
}

function seconds(ms: number): string {
  const s = ms / 1000
  return `${Number.isInteger(s) ? s : s.toFixed(1)} s`
}

/** The sentence and fix for a class; the raw message is kept, masked, as `detail`. */
export function presentError(cls: TransportErrorClass, raw: string, ctx: PresentCtx = {}): ClassifiedError {
  const detail = maskUrlsIn(raw)
  const out = (message: string, fix?: ClassifiedError['fix'], keepDetail = true): ClassifiedError => ({
    class: cls,
    message,
    ...(fix ? { fix } : {}),
    ...(keepDetail && detail && detail !== message ? { detail } : {})
  })
  switch (cls) {
    case 'dns':
      return out('Host not found', { label: 'Send from…', action: 'route-menu' })
    case 'refused':
      return out('Connection refused', { label: 'Send from…', action: 'route-menu' })
    case 'timeout': {
      const ms = ctx.timeoutMs ?? Number(/after (\d+)\s*ms/i.exec(raw)?.[1] ?? NaN)
      return out(Number.isFinite(ms) ? `Timed out after ${seconds(ms)}` : 'Timed out', {
        label: 'Raise the timeout',
        action: 'raise-timeout'
      })
    }
    case 'tls-not-tls':
      return out('This port does not speak TLS', { label: 'Retry with http://', action: 'retry-http' })
    case 'tls':
      // Never "turn verification off" from an error: the fix is to trust the CA.
      return out(
        'Certificate not trusted',
        ctx.scratch
          ? { label: 'Save to a collection to add a CA…', action: 'save-then-ca' }
          : { label: 'Add a CA for this collection', action: 'add-ca' }
      )
    case 'reset':
      return out('Connection reset')
    case 'aborted':
      return out('Cancelled', undefined, false)
    case 'route-missing':
      return out('That server was removed — requests will not be sent', {
        label: 'Choose where to send from',
        action: 'route-menu'
      })
    case 'vault-locked':
      return out(VAULT_LOCKED_MESSAGE, { label: 'Unlock vault', action: 'unlock' }, false)
    case 'vault-entry-gone':
      return out(VAULT_ENTRY_GONE_MESSAGE, { label: 'Choose another vault entry', action: 'choose-vault' }, false)
    case 'unresolved-variable':
      return out(detail || 'A variable is not defined', { label: 'Add value…', action: 'add-variable' }, false)
    case 'socket-cap':
      return out(`${MAX_SOCKETS} WebSockets are open, the most OpsMaxx allows`, {
        label: 'Disconnect idle sockets…',
        action: 'disconnect-idle'
      })
    case 'bridge-stale':
      return out('This part of OpsMaxx needs a restart', { label: 'Restart OpsMaxx…', action: 'restart' })
    case 'prod-declined':
      return out('', undefined, false)
    case 'other':
      // Synced changes held for review: the fix opens where they are accepted.
      if (raw === ENV_REVIEW_TEXT) return out(raw, { label: 'Review changes', action: 'review-env' }, false)
      if (raw === CONNECTION_REVIEW_MESSAGE) {
        return out(raw, { label: 'Review changes', action: 'review-collection' }, false)
      }
      return out(detail || 'The request failed', undefined, false)
  }
}

export function classifyTransportError(message: string, code?: string): ClassifiedError {
  return presentError(classOf(message, code), message)
}
