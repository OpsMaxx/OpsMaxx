import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const read = (p: string): string => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8')
const GO = read('../sidecar/netd/ngrok.go')
const DRIVER = read('../src/main/services/vpn/drivers/ngrok.ts')

/**
 * The sidecar's wire shape, checked against the sidecar.
 *
 * The driver read `ngrok.up`'s reply as the app's own `NgrokEndpoint`, whose
 * URL field is `publicUrl`. The sidecar's field is `url`. So every endpoint
 * arrived with `publicUrl: undefined`: the status carried a list of endpoints
 * with no addresses in it, the log line read "published web at undefined", and
 * the card rendered an empty span. A tunnel that was up, and would not say
 * where -- which is the only thing an ngrok tunnel is for, since the hostname
 * is assigned fresh on every run and exists nowhere else.
 *
 * It survived a test that ran the real `start()` against a stubbed sidecar,
 * because the stub returned the DOMAIN shape -- the one shape the sidecar never
 * sends. A stub can only be as right as the contract it was written from, so
 * this reads the contract from the Go source instead of from memory.
 */

/** The json tags on a Go struct, in order. */
function jsonTags(src: string, struct: string): string[] {
  const start = src.indexOf(`type ${struct} struct {`)
  if (start < 0) throw new Error(`${struct} is not in ngrok.go any more`)
  const body = src.slice(start, src.indexOf('\n}', start))
  return [...body.matchAll(/json:"([^",]+)/g)].map((m) => m[1])
}

describe('what the sidecar sends for a published endpoint', () => {
  const tags = jsonTags(GO, 'NgrokEndpointResult')

  it('is decoded through a type that matches the Go struct field for field', () => {
    // The wire interface in the driver, not the domain type.
    const wire = /interface NgrokEndpointWire \{([\s\S]*?)\n\}/.exec(DRIVER)?.[1]
    expect(wire, 'NgrokEndpointWire has gone').toBeTruthy()
    for (const tag of tags) {
      expect(wire, `the sidecar sends "${tag}" and the wire type has no such field`).toMatch(
        new RegExp(`\\b${tag}\\??:`)
      )
    }
  })

  it('carries the URL under the name the sidecar actually uses', () => {
    // The specific mismatch that shipped. If someone renames the Go tag, this
    // fails here rather than in a user's tunnel.
    expect(tags).toContain('url')
    expect(DRIVER).toMatch(/publicUrl: e\.url/)
  })

  it('never reads the reply as the domain type again', () => {
    // `NgrokEndpoint` is what the UI renders. Sending it into `session.send` as
    // the expected reply is exactly the bug: it typechecks, and it is wrong.
    expect(DRIVER).not.toMatch(/session\.send<\{\s*endpoints:\s*NgrokEndpoint\[\]\s*\}>/)
  })
})
