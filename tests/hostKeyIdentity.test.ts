import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const src = (p: string): string => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8')
const SSH = src('../src/main/services/ssh.ts')
const KNOWN = src('../src/main/services/knownhosts.ts')

/**
 * A host key belongs to the server, not to the port it was reached on.
 *
 * A hop routed through a VPN or tunnel is rewritten to dial
 * `127.0.0.1:<freshly allocated port>`, and the known-hosts entry was keyed on
 * whatever was dialled. That port is different on every connection, so the
 * entry could never match twice: a server behind Tailscale asked to be trusted
 * again on every single connect, showing "The authenticity of
 * 127.0.0.1:62778 cannot be established".
 *
 * The second half is worse than the nagging. Each yes wrote a trusted entry for
 * `127.0.0.1:<port>` -- an identity with no owner, which a later and entirely
 * unrelated service on that port would inherit.
 */

/** Every place a hop is rewritten onto the loopback forward. */
function loopbackRewrites(text: string): string[] {
  const out: string[] = []
  // Generous, because these blocks carry long explanatory comments: a window
  // too small silently stops finding the rewrites and the assertions below
  // become vacuous rather than failing.
  const re = /host: '127\.0\.0\.1',([\s\S]{0,2000}?)\n\s*\}/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) out.push(m[0])
  return out
}

describe('a hop rewritten onto a local forward', () => {
  const rewrites = loopbackRewrites(SSH)

  it('there are rewrites to check', () => {
    // If this drops to zero the regex has rotted and the rest is vacuous.
    expect(rewrites.length).toBeGreaterThanOrEqual(2)
  })

  it('carries the server it is actually reaching', () => {
    for (const r of rewrites) {
      expect(r, `a loopback rewrite with no hostKeyId:\n${r}`).toMatch(/hostKeyId:/)
    }
  })

  it('prefers an identity already carried over re-deriving one', () => {
    // A hop that has been through one forward already must not have its
    // identity replaced by the previous forward's loopback address.
    for (const r of rewrites) {
      expect(r).toMatch(/hostKeyId: first\.hostKeyId \?\?/)
    }
  })
})

describe('the verifier', () => {
  it('files the key under that identity when there is one', () => {
    expect(SSH).toMatch(/verifyHostKey\(hop\.host, hop\.port \|\| 22, key, allowPrompt, hop\.hostKeyId\)/)
    expect(KNOWN).toMatch(/const id = identity \?\? `\$\{host\}:\$\{port \|\| 22\}`/)
  })

  it('still checks the fingerprint, which is the part that is not about naming', () => {
    // The identity decides WHERE the answer is filed. Whether the key matches
    // is a separate question and this change must not have touched it.
    expect(KNOWN).toMatch(/if \(known\.fingerprint === fp\) return Promise\.resolve\(true\)/)
    expect(KNOWN).toMatch(/Host key changed/)
  })
})
