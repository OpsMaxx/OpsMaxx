import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Certificate was offered as an equal fourth authentication method and revealed
// no fields at all when picked. That was the visible half.
//
// The real defect was in the transport: `asAuth` mapped every value that was
// not password or agent to 'key', so choosing Certificate did not do nothing —
// it silently connected as PRIVATE KEY authentication using whatever key path
// happened to be set, and failed with a message about a key the user never
// chose. Folding an unimplemented value into a working one turns "I do not
// support this" into "here is something else", which is the same mistake as a
// parser whose fallback returns its input.

const ROOT = join(__dirname, '..')
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8')

describe('an authentication method the build cannot honour is not offered', () => {
  const modal = read('src/renderer/src/components/connections/AddServerModal.tsx')

  it('marks certificate unavailable with a reason', () => {
    expect(modal).toMatch(/id: 'certificate'[\s\S]{0,400}unavailable:/)
  })

  // Disabled rather than deleted: the concept exists and ShellPilot reads
  // certificate state elsewhere. An option that vanishes teaches the user the
  // product cannot do something when the truth is that this build cannot.
  it('keeps the option visible so the absence is explained, not hidden', () => {
    expect(modal).toContain("id: 'certificate'")
    expect(modal).toMatch(/disabled=\{a\.unavailable !== undefined/)
  })

  // A profile already saved with it opens on this screen, and a tooltip is not
  // a way to tell somebody their connection cannot work.
  it('states the reason when the value is selected, not only on hover', () => {
    expect(modal).toMatch(/AUTH\.find\(\(a\) => a\.id === auth\)\?\.unavailable/)
  })
})

describe('the form knows what is still missing', () => {
  const modal = read('src/renderer/src/components/connections/AddServerModal.tsx')

  // The gate was `name.trim() && host.trim()`, so a profile could be saved with
  // an auth method it had no credential for — and the user met that much later
  // as an undifferentiated "Connection failed" on a different screen.
  it('no longer gates the primary on name and host alone', () => {
    expect(modal).not.toMatch(/const valid = name\.trim\(\) && host\.trim\(\)/)
    expect(modal).toContain('missingField(')
  })

  it('says what is missing rather than only going grey', () => {
    expect(modal).toMatch(/\{missing && <span className="field-hint danger">\{missing\.why\}<\/span>\}/)
  })
})

describe('the transport does not reinterpret a method it was given', () => {
  const transport = read('src/renderer/src/lib/transport.ts')

  it('passes key, password and agent through unchanged', () => {
    expect(transport).toMatch(/a === 'password' \|\| a === 'agent' \|\| a === 'key'/)
  })

  // The fallback survives for a value from a NEWER build we genuinely cannot
  // interpret — there is no safer guess and refusing to connect would be worse.
  // What changed is that it is no longer where a recognised-but-unimplemented
  // value quietly ends up.
  it('explains the remaining fallback rather than leaving it bare', () => {
    const i = transport.indexOf('const asAuth')
    expect(i).toBeGreaterThan(-1)
    const doc = transport.slice(Math.max(0, i - 1400), i)
    expect(doc).toMatch(/certificate/i)
    expect(doc).toMatch(/not implemented|do not implement/i)
  })
})

describe('the jump-host row is labelled', () => {
  const hops = read('src/renderer/src/components/connections/RouteHops.tsx')

  // Four unlabelled boxes under a dropdown. A placeholder is not a label: it
  // disappears the moment the field has a value, so the row a user comes back
  // to is four anonymous strings, and there is nothing for a screen reader to
  // announce either.
  it('gives every hop field a real label', () => {
    for (const label of ['Label', 'Server / IP', 'Port', 'Username']) {
      expect(hops, label).toContain(`<span className="field-label">${label}</span>`)
    }
  })

  it('no longer relies on a placeholder to name a field', () => {
    expect(hops).not.toContain('placeholder="host"')
    expect(hops).not.toContain('placeholder="user"')
    expect(hops).not.toContain('placeholder="port"')
  })
})

describe('a profile can be checked before it is saved', () => {
  const modal = read('src/renderer/src/components/connections/AddServerModal.tsx')
  const ssh = read('src/main/services/ssh.ts')

  // The form has four to six chances to be wrong and had no feedback loop: the
  // only way to find out was to save it, open a session, and read a failure on
  // a different screen. Saving PERSISTS the profile before it is known to work,
  // so a first run ends with a connection list holding entries that have never
  // connected.
  it('offers Test connection beside the primary, where the fields are editable', () => {
    expect(modal).toMatch(/Test connection/)
    expect(modal).toMatch(/onClick=\{\(\) => void testConnection\(\)\}/)
  })

  // Through the same classifier the terminal's failure card uses, so a wrong
  // username reads as a wrong username rather than as the handshake timeout it
  // arrives as.
  it('classifies the failure rather than pasting the driver string', () => {
    expect(modal).toContain('adviseOnError(r?.error)')
  })

  // A button that quietly does nothing is worse than no button — the rule the
  // rest of the app applies to an unwired bridge.
  it('says so when the bridge has no test channel', () => {
    expect(modal).toMatch(/This build cannot test a connection/)
  })

  // `acquire` pools for reuse, which is right for a session and wrong here: a
  // pooled test connection would mean pressing Test twice created two, and a
  // test of a profile the user then edits would leave one keyed to settings
  // that no longer exist.
  it('dials through openChain, never through the pool', () => {
    const i = ssh.indexOf('export async function sshTest')
    expect(i).toBeGreaterThan(-1)
    const body = ssh.slice(i, i + 1600)
    expect(body).toContain('openChain(cfg)')
    expect(body).not.toContain('acquire(')
  })

  // A chain that failed on hop three still opened hops one and two, and leaking
  // those is how a form with a typo in it holds connections open on a bastion.
  it('closes every client it opened, in a finally', () => {
    const i = ssh.indexOf('export async function sshTest')
    const body = ssh.slice(i, i + 1600)
    expect(body).toContain('} finally {')
    expect(body).toMatch(/for \(const c of chain\?\.clients \?\? \[\]\) c\.end\(\)/)
  })

  // Answering a first-contact trust dialog would record a trust decision as a
  // side effect of pressing a button labelled Test.
  it('does not raise the host-key trust prompt', () => {
    const i = ssh.indexOf('export async function sshTest')
    const doc = ssh.slice(Math.max(0, i - 1500), i)
    expect(doc).toMatch(/allowPrompt/)
    expect(ssh.slice(i, i + 1600)).not.toMatch(/allowPrompt/)
  })
})
