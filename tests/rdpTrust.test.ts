import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { app, dialog } from 'electron'

// The certificate check is the whole answer to `rejectUnauthorized: false`, so
// what matters here is the policy rather than the plumbing: a new host asks, a
// known host is silent, and a changed one is refused without asking whether to
// continue — because "do you want to proceed" on a changed certificate is how a
// machine-in-the-middle gets waved through.

const { verifyRdpCertificate, certFingerprint, trustedRdpCertList, forgetRdpCert } = await import(
  '../src/main/services/rdpTrust'
)

const STORE = join(app.getPath('userData'), 'opsmaxx-rdp-certs.json')

const CERT_A = Buffer.from('certificate-alpha')
const CERT_B = Buffer.from('certificate-bravo')

// One spy for the whole file. Re-spying on the same method wraps the previous
// spy rather than replacing it, so call counts accumulate across both and every
// "asked once" assertion reads high.
function spyOnDialog(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(dialog, 'showMessageBox')
}
let ask: ReturnType<typeof spyOnDialog>

/** Answers the next dialog with `buttonIndex`, from a clean call count. */
function answerWith(buttonIndex: number): typeof ask {
  ask.mockClear()
  ask.mockResolvedValue({ response: buttonIndex } as Awaited<
    ReturnType<typeof dialog.showMessageBox>
  >)
  return ask
}

beforeEach(() => {
  rmSync(STORE, { force: true })
  vi.restoreAllMocks()
  ask = spyOnDialog()
})

afterEach(() => {
  rmSync(STORE, { force: true })
})

describe('first contact with a host', () => {
  it('asks, and remembers the fingerprint when accepted', async () => {
    const ask = answerWith(0) // 'Connect'
    await expect(verifyRdpCertificate('win-01', 3389, CERT_A)).resolves.toBe(true)
    expect(ask).toHaveBeenCalledTimes(1)

    const saved = JSON.parse(readFileSync(STORE, 'utf8'))
    expect(saved['win-01:3389'].fingerprint).toBe(certFingerprint(CERT_A))
  })

  it('remembers nothing when declined', async () => {
    answerWith(1) // 'Cancel'
    await expect(verifyRdpCertificate('win-01', 3389, CERT_A)).resolves.toBe(false)
    expect(trustedRdpCertList()).toHaveLength(0)
  })

  it('treats anything but the Connect button as a refusal', async () => {
    // Escape and the window's close button both report a response that is not
    // 0, which has to mean no rather than "not yes, so probably yes".
    answerWith(99)
    await expect(verifyRdpCertificate('win-01', 3389, CERT_A)).resolves.toBe(false)
  })

  it('asks once for two connections racing to the same host', async () => {
    // Two tabs opened together would otherwise stack identical modals, and
    // answering one would leave the other waiting on a settled question.
    const ask = answerWith(0)
    const [a, b] = await Promise.all([
      verifyRdpCertificate('win-01', 3389, CERT_A),
      verifyRdpCertificate('win-01', 3389, CERT_A)
    ])
    expect([a, b]).toEqual([true, true])
    expect(ask).toHaveBeenCalledTimes(1)
  })
})

describe('a host that is already trusted', () => {
  it('does not ask again', async () => {
    answerWith(0)
    await verifyRdpCertificate('win-01', 3389, CERT_A)

    const ask = answerWith(0)
    await expect(verifyRdpCertificate('win-01', 3389, CERT_A)).resolves.toBe(true)
    expect(ask).not.toHaveBeenCalled()
  })

  it('is pinned per host and port, not per host', async () => {
    // A different port is a different service; trusting 3389 says nothing
    // about what answers on 13389.
    answerWith(0)
    await verifyRdpCertificate('win-01', 3389, CERT_A)

    const ask = answerWith(0)
    await verifyRdpCertificate('win-01', 13389, CERT_A)
    expect(ask).toHaveBeenCalledTimes(1)
  })
})

describe('a certificate that has changed', () => {
  it('refuses, and does not offer to continue', async () => {
    answerWith(0)
    await verifyRdpCertificate('win-01', 3389, CERT_A)

    const warn = answerWith(0)
    await expect(verifyRdpCertificate('win-01', 3389, CERT_B)).resolves.toBe(false)

    // It still tells the user — but the dialog is an acknowledgement, not a
    // choice. Answering its only button must not grant trust.
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toMatchObject({ type: 'error', buttons: ['OK'] })
  })

  it('keeps the original pin rather than adopting the new certificate', async () => {
    answerWith(0)
    await verifyRdpCertificate('win-01', 3389, CERT_A)
    answerWith(0)
    await verifyRdpCertificate('win-01', 3389, CERT_B)

    expect(trustedRdpCertList()[0].fingerprint).toBe(certFingerprint(CERT_A))
  })

  it('asks again as a first contact once the pin is forgotten', async () => {
    // The documented recovery for a genuinely rebuilt machine.
    answerWith(0)
    await verifyRdpCertificate('win-01', 3389, CERT_A)
    forgetRdpCert('win-01:3389')

    const ask = answerWith(0)
    await expect(verifyRdpCertificate('win-01', 3389, CERT_B)).resolves.toBe(true)
    expect(ask.mock.calls[0][0]).toMatchObject({ type: 'warning' })
  })
})

describe('the fingerprint', () => {
  it('is a SHA-256 in the same shape as the SSH host key fingerprints', async () => {
    expect(certFingerprint(CERT_A)).toMatch(/^SHA256:[A-Za-z0-9+/]+$/)
    expect(certFingerprint(CERT_A)).not.toBe(certFingerprint(CERT_B))
  })
})
