import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const src = (p: string): string => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8')
const SESSION = src('../src/main/services/vpn/netdSession.ts')
const NGROK = src('../src/main/services/vpn/drivers/ngrok.ts')

/**
 * A dead engine has to reach the card.
 *
 * `onExit` rejected the requests that happened to be in flight and told nobody
 * else, which is fine for whoever was mid-call and useless to everyone else: a
 * profile whose start had already returned kept its Live entry and went on
 * reporting Connected for a process that no longer existed. For ngrok that is a
 * green card over a public address answering ERR_NGROK_3200, with nothing
 * anywhere saying the engine had gone.
 *
 * The event has to be synthesised here, necessarily. A process that has exited
 * cannot send anything, so this is exactly the case the sidecar's own events
 * cannot cover.
 */

describe('when the sidecar process exits', () => {
  it('announces it to subscribers, not only to pending calls', () => {
    expect(SESSION).toMatch(/for \(const h of eventHandlers\) h\('sidecar\.exit'/)
  })

  it('still settles the in-flight requests, which was the original job', () => {
    expect(SESSION).toMatch(/settleAll\(new VpnError\('engine-stopped', why\)\)/)
  })
})

describe('the ngrok driver', () => {
  it('treats a dead engine and a dead endpoint as the same kind of news', () => {
    expect(NGROK).toMatch(/event !== 'ngrok\.endpoint\.down' && event !== 'sidecar\.exit'/)
  })

  it('drops the profile rather than merely emitting', () => {
    // Emitting alone updates the status bus and leaves the manager holding the
    // Live entry, its session and its resolved secrets -- so
    // `hasLiveVpnDependents` would go on saying this profile was up.
    const handler = NGROK.slice(NGROK.indexOf('session.onEvent('))
    expect(handler.slice(0, handler.indexOf('\n      })'))).toMatch(/ctx\.dropped\(/)
  })

  it('ignores news about a session it has already replaced', () => {
    // A restart opens a new session; the old one's exit must not tear down the
    // tunnel that replaced it.
    expect(NGROK).toMatch(/if \(live\.get\(profile\.id\)\?\.session !== session\) return/)
  })
})
