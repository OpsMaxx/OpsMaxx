import { describe, it, expect } from 'vitest'
import {
  CERT_EXPIRY_DAYS,
  CERT_NAMES,
  CERT_SEARCH_MAX_DEPTH,
  CERT_SEARCH_MAX_FILES,
  CERT_SEARCH_ROOTS,
  CERT_SKIPPED,
  certSearchBound,
  certificateNotAfter,
  certificatesIncomplete,
  isCertificateExpiringSoon,
  parsePosture,
  postureAlertReadings,
  postureSource,
  soonestCertificateExpiry
} from '../src/shared/posture'
import { decodeBase64 } from '../src/shared/access'
import type { CertificateInventory, HostPosture } from '../src/shared/posture'
import {
  CERT_EXPIRED,
  CERT_FAR,
  CERT_GENERALIZED,
  CERT_SOON
} from './postureCertificateFixtures'

// Certificate expiry — the second of the two kinds item 19b deferred.
//
// PROVENANCE, as tests/posture.test.ts demands of itself. Unlike the tool
// output in that file, EVERY CERTIFICATE BELOW IS REAL: each was minted by
// `openssl req -x509 -not_before ... -not_after ...` with the absolute
// validity its name claims, and the expected dates are written here as
// literals rather than derived from the parser under test. So these do prove
// that the hand-written DER walk agrees with OpenSSL about where `notAfter` is
// and what it says — which is the whole risk of not shelling out to
// `openssl x509 -enddate`.
//
// The clock is pinned. Days remaining is a function of two absolute instants
// and nothing else, so every number below is arithmetic a reader can check:
// 2027-01-15T00:00:00Z is `NOW`, and a certificate expiring 2027-02-01T12:00Z
// has seventeen and a half days left, which floors to 17.

/** 2027-01-15T00:00:00Z. */
const NOW = 1_799_971_200_000

const der = (b64: string): Uint8Array => {
  const d = decodeBase64(b64)
  if (d === null) throw new Error('fixture is not base64 — the fixture is wrong, not the parser')
  return d
}

const iso = (b64: string): string => {
  const r = certificateNotAfter(der(b64))
  if (!r.ok) throw new Error(`fixture did not parse: ${r.problem}`)
  return new Date(r.notAfter).toISOString()
}

// ---------------------------------------------------------------------------
// Dating a certificate without openssl
// ---------------------------------------------------------------------------

describe('the DER walk agrees with OpenSSL about notAfter', () => {
  it('dates a UTCTime certificate to the second', () => {
    expect(iso(CERT_SOON)).toBe('2027-02-01T12:00:00.000Z')
  })

  it('dates a GeneralizedTime certificate, which is how RFC 5280 writes 2050 and later', () => {
    // The reason both forms are handled rather than only the common one: a
    // certificate valid past 2049 MUST use GeneralizedTime, and a parser that
    // knew only UTCTime would call the longest-lived certificates in an estate
    // unparseable.
    expect(iso(CERT_GENERALIZED)).toBe('2050-01-01T00:00:00.000Z')
  })

  it('dates one that has already expired, which is not a parse failure', () => {
    expect(iso(CERT_EXPIRED)).toBe('2026-12-20T00:00:00.000Z')
  })

  it('dates a long-lived one', () => {
    expect(iso(CERT_FAR)).toBe('2028-06-01T00:00:00.000Z')
  })

  it('calls a certificate that arrived cut short TRUNCATED, never valid', () => {
    // The collector caps how much base64 it transmits, so this is a real state
    // and not a theoretical one. Half a certificate is not a certificate that
    // is fine.
    const full = der(CERT_SOON)
    const cut = full.subarray(0, 40)
    const r = certificateNotAfter(cut)
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('unreachable')
    expect(r.problem).toBe('truncated')
  })

  it('calls bytes that are not a certificate UNPARSEABLE, never valid', () => {
    // A file a host controls, decoding cleanly to something that is not an
    // X.509 certificate. It must not produce a date.
    const r = certificateNotAfter(new Uint8Array([0x30, 0x03, 0x02, 0x01, 0x05]))
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('unreachable')
    expect(r.problem).toBe('unparseable')
  })

  it('refuses an empty buffer rather than dating it', () => {
    expect(certificateNotAfter(new Uint8Array([])).ok).toBe(false)
  })

  it('refuses BER indefinite length, which DER does not have', () => {
    // 0x80 as the length byte is BER's "read until the end marker". Accepting
    // it means accepting a length this walk cannot bound.
    expect(certificateNotAfter(new Uint8Array([0x30, 0x80, 0x30, 0x80, 0x00, 0x00])).ok).toBe(false)
  })

  it('refuses a time that is not RFC 5280 UTC, rather than guessing at it', () => {
    // A `notAfter` with no Z, or a month of 13, is a certificate this build
    // will not date. Built by taking a real certificate and rewriting the two
    // bytes of its notAfter month in place, so everything around it is real.
    const bytes = der(CERT_SOON)
    const at = bytes.findIndex(
      (_b, i) =>
        bytes[i] === 0x17 &&
        bytes[i + 1] === 0x0d &&
        String.fromCharCode(bytes[i + 2], bytes[i + 3]) === '27' &&
        String.fromCharCode(bytes[i + 4], bytes[i + 5]) === '02'
    )
    expect(at, 'the notAfter UTCTime was not found — this test checked nothing').toBeGreaterThan(0)
    const broken = Uint8Array.from(bytes)
    broken[at + 4] = '1'.charCodeAt(0)
    broken[at + 5] = '3'.charCodeAt(0)
    const r = certificateNotAfter(broken)
    expect(r.ok).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// What the panel and the alert bus are told
// ---------------------------------------------------------------------------

/** A collection carrying the given `C` records, as the collector writes them. */
const collect = (records: [string, string][], status = 'certificates ok - read'): HostPosture =>
  parsePosture(
    [
      ...records.map(([body, path]) => `C ${body} ${path}`),
      'V cert-searched 1',
      'V cert-refused 0',
      '===OPSMAXX-POSTURE===',
      status
    ].join('\n'),
    NOW
  )

describe('a certificate that could not be read is never a certificate that is valid', () => {
  it('reads a real certificate and counts the days left', () => {
    const p = collect([[CERT_SOON, '/etc/letsencrypt/live/soon.example.com/fullchain.pem']])
    expect(p.certificates?.certificates).toEqual([
      {
        path: '/etc/letsencrypt/live/soon.example.com/fullchain.pem',
        notAfter: 1_801_483_200_000,
        daysRemaining: 17,
        problem: null
      }
    ])
    expect(postureAlertReadings(p).certDays).toBe(17)
  })

  it('reads an already-expired certificate as a NEGATIVE number of days', () => {
    // Which is what makes "expired 26 days ago" a different sentence from
    // "expires in 26 days" everywhere downstream, rather than the same small
    // number twice.
    const p = collect([[CERT_EXPIRED, '/etc/nginx/ssl/old.crt']])
    expect(p.certificates?.certificates[0].daysRemaining).toBe(-26)
    expect(postureAlertReadings(p).certDays).toBe(-26)
  })

  it('takes the SOONEST expiry across the server, not the first or the last', () => {
    const p = collect([
      [CERT_FAR, '/etc/nginx/a.pem'],
      [CERT_SOON, '/etc/nginx/b.pem'],
      [CERT_GENERALIZED, '/etc/nginx/c.pem']
    ])
    expect(p.certificates?.certificates.map((c) => c.daysRemaining)).toEqual([503, 17, 8387])
    expect(soonestCertificateExpiry(p.certificates)).toBe(17)
  })

  it('does not let an unparseable certificate stand in for a valid one', () => {
    // The host controls this file. `AAAA` is clean base64 and is not a
    // certificate; it must contribute a PROBLEM and no date, and it must not
    // become the answer just because it sorted first.
    const p = collect([
      ['AAAA', '/etc/nginx/broken.pem'],
      [CERT_FAR, '/etc/nginx/good.pem']
    ])
    expect(p.certificates?.certificates[0]).toMatchObject({
      path: '/etc/nginx/broken.pem',
      notAfter: null,
      daysRemaining: null,
      problem: 'unparseable'
    })
    expect(soonestCertificateExpiry(p.certificates)).toBe(503)
    expect(certificatesIncomplete(p.certificates)).toBe(true)
  })

  it('tells a file it could not open from a file that holds no certificate', () => {
    // Two sentinels rather than one, because the fixes differ: `-` is a
    // permission problem and `.` is a key, a CSR or a README somebody named
    // .pem. Neither is a certificate with no expiry.
    const p = collect([
      ['-', '/etc/letsencrypt/live/x/cert.pem'],
      ['.', '/etc/nginx/notes.pem']
    ])
    expect(p.certificates?.certificates.map((c) => c.problem)).toEqual([
      'unreadable',
      'not-a-certificate'
    ])
    expect(soonestCertificateExpiry(p.certificates)).toBeNull()
  })

  it('a directory that could not be entered is NOT a server with no certificates', () => {
    // The line this whole half of the item exists for. /etc/letsencrypt is
    // 0700 root on Debian, so this is the common case.
    const p = parsePosture(
      [
        'V cert-searched 1',
        'V cert-refused 2',
        '===OPSMAXX-POSTURE===',
        'certificates denied - every certificate directory present on this server refused to be entered'
      ].join('\n'),
      NOW
    )
    expect(postureSource(p, 'certificates').status).toBe('denied')
    expect(p.certificates?.certificates).toEqual([])
    expect(p.certificates?.unreadableRoots).toBe(2)
    // Not zero, not a large number, not "fine".
    expect(postureAlertReadings(p).certDays).toBeNull()
    expect(certificatesIncomplete(p.certificates)).toBe(true)
  })

  it('a clean search that found nothing has NO expiry reading, not a good one', () => {
    // "No certificates" is not "infinitely far from expiry". A path that
    // turned it into a number would report every host in the estate healthy.
    const p = collect([])
    expect(postureSource(p, 'certificates').status).toBe('ok')
    expect(p.certificates?.certificates).toEqual([])
    expect(postureAlertReadings(p).certDays).toBeNull()
    expect(certificatesIncomplete(p.certificates)).toBe(false)
  })

  it('says nothing at all when the certificate block never ran', () => {
    const p = parsePosture(['===OPSMAXX-POSTURE===', 'firewall ok - read'].join('\n'), NOW)
    expect(p.certificates).toBeNull()
    expect(postureAlertReadings(p).certDays).toBeNull()
    expect(certificatesIncomplete(null)).toBe(true)
  })

  it('downgrades a source the collector called ok whose search did not survive', () => {
    const p = parsePosture(
      ['===OPSMAXX-POSTURE===', 'certificates ok - read'].join('\n'),
      NOW
    )
    expect(postureSource(p, 'certificates').status).toBe('unknown')
  })

  it('says out loud when the file cap made the list a prefix', () => {
    const many: [string, string][] = Array.from({ length: CERT_SEARCH_MAX_FILES + 4 }, (_, i) => [
      CERT_FAR,
      `/etc/nginx/c${i}.pem`
    ])
    const p = collect(many)
    // Capped on the way in as well as on the host.
    expect(p.certificates?.certificates.length).toBe(CERT_SEARCH_MAX_FILES)
    expect(p.certificates?.truncated).toBe(true)
    expect(certificatesIncomplete(p.certificates)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// The bounds, which are the scope decision
// ---------------------------------------------------------------------------

describe('the search is bounded, and says what its bounds are', () => {
  it('names the roots, the depth, the file cap and that it does not cross filesystems', () => {
    expect(certSearchBound()).toEqual({
      roots: [
        '/etc/letsencrypt/live',
        '/etc/pki/tls/certs',
        '/etc/nginx',
        '/etc/apache2',
        '/etc/httpd',
        // Item 39. kubeadm issues control-plane certificates for ONE YEAR and
        // renews them on upgrade, so a cluster nobody upgrades stops dead a
        // year later with no warning anywhere. They are certificates on a
        // server, so the `cert-expiry` kind that already exists fires for them.
        //
        // AFTER the web roots on purpose: `find` walks its arguments in order
        // and the file cap is a `head`, so on a server that is somehow both,
        // the certificates somebody renews by hand survive the truncation.
        '/etc/kubernetes/pki',
        '/var/lib/kubelet/pki',
        '/var/lib/rancher/k3s/server/tls',
        '/var/lib/rancher/rke2/server/tls'
      ],
      maxDepth: 3,
      // 32, not 16: a kubeadm control plane holds about thirteen certificates
      // in /etc/kubernetes/pki alone once etcd/ is counted, and at 16 such a
      // node would have reported a truncated list of its own and nothing else.
      maxFiles: 32,
      names: ['*.pem', '*.crt', '*.cer'],
      skipped: [
        'ca-bundle.crt',
        'ca-bundle.trust.crt',
        'ca-certificates.crt',
        'chain.pem',
        'privkey.pem',
        'dhparam.pem'
      ],
      crossesFilesystems: false
    })
  })

  it('does not watch the distribution trust store', () => {
    // /etc/ssl/certs IS the trust store on Debian and Ubuntu: roughly 150 root
    // CAs the operator does not control and cannot renew. Watching it would
    // bury the one certificate that is theirs under 150 alerts about
    // certificates that are not.
    expect(CERT_SEARCH_ROOTS).not.toContain('/etc/ssl/certs')
    expect(CERT_SEARCH_ROOTS).not.toContain('/etc/ssl')
    // And the bundles that leak into the roots that ARE watched are skipped by
    // name, for the same reason.
    expect(CERT_SKIPPED).toContain('ca-certificates.crt')
    expect(CERT_SKIPPED).toContain('ca-bundle.crt')
  })

  it('never opens a private key', () => {
    expect(CERT_SKIPPED).toContain('privkey.pem')
  })

  it('is deep enough for the certbot layout and no deeper', () => {
    // /etc/letsencrypt/live/<domain>/fullchain.pem is two levels below the
    // root; three leaves room for the ssl/<site>/ layout people give nginx.
    expect(CERT_SEARCH_MAX_DEPTH).toBe(3)
  })
})

describe('the line is thirty days, and both sides of the app use the same one', () => {
  it('is at or below, so a certificate ON the line is inside it', () => {
    expect(CERT_EXPIRY_DAYS).toBe(30)
    expect(isCertificateExpiringSoon(31)).toBe(false)
    expect(isCertificateExpiringSoon(30)).toBe(true)
    expect(isCertificateExpiringSoon(0)).toBe(true)
    expect(isCertificateExpiringSoon(-5)).toBe(true)
  })
})

describe('the incompleteness flag', () => {
  const inv = (over: Partial<CertificateInventory>): CertificateInventory => ({
    certificates: [],
    truncated: false,
    unreadableRoots: 0,
    bound: certSearchBound(),
    ...over
  })

  it('is true for a refused root even when everything else read', () => {
    expect(certificatesIncomplete(inv({ unreadableRoots: 1 }))).toBe(true)
  })

  it('is true for a truncated list', () => {
    expect(certificatesIncomplete(inv({ truncated: true }))).toBe(true)
  })

  it('is false only when the whole search read', () => {
    expect(certificatesIncomplete(inv({}))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Item 39: Kubernetes control-plane certificates
// ---------------------------------------------------------------------------
//
// kubeadm issues these for ONE YEAR and renews them on upgrade, so a cluster
// nobody upgrades stops dead a year later -- every component at once, with
// `x509: certificate has expired` in every log -- and nothing warns first.
//
// No new alert kind: they are certificates on a server, so the `cert-expiry`
// kind that already exists fires for them. That is the whole reason they are
// roots here rather than a Kubernetes-specific probe.

describe('the Kubernetes roots reach a real control-plane layout', () => {
  // Built on disk and searched with the probe's own depth and name list, rather
  // than asserted against the command string. A root that is spelled right and
  // a depth that stops one directory short would both pass a text assertion.
  it('finds every certificate kubeadm writes, including the ones under etcd/', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join, relative } = await import('node:path')
    const { execFileSync } = await import('node:child_process')

    const root = mkdtempSync(join(tmpdir(), 'sp-k8s-pki-'))
    try {
      const pki = join(root, 'etc/kubernetes/pki')
      mkdirSync(join(pki, 'etcd'), { recursive: true })
      const top = [
        'ca', 'apiserver', 'apiserver-kubelet-client', 'front-proxy-ca',
        'front-proxy-client', 'apiserver-etcd-client'
      ]
      const etcd = ['ca', 'server', 'peer', 'healthcheck-client']
      for (const n of top) writeFileSync(join(pki, `${n}.crt`), 'x')
      for (const n of etcd) writeFileSync(join(pki, 'etcd', `${n}.crt`), 'x')

      const names = CERT_NAMES.flatMap((n, i) => (i === 0 ? ['-name', n] : ['-o', '-name', n]))
      const found = execFileSync(
        'find',
        [pki, '-xdev', '-maxdepth', String(CERT_SEARCH_MAX_DEPTH), '-type', 'f', '(', ...names, ')', '-print'],
        { encoding: 'utf8' }
      )
        .split('\n')
        .filter(Boolean)
        .map((f) => relative(pki, f))
        .sort()

      expect(found).toHaveLength(top.length + etcd.length)
      // The depth is what this is really about: etcd's certificates are one
      // directory down and expire on the same clock as the rest.
      expect(found).toContain('etcd/server.crt')
      expect(found).toContain('apiserver.crt')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  // Ten in pki plus etcd, plus the kubelet's two, is twelve on a control plane
  // before a single web certificate is counted. At the old cap of 16 such a
  // node reported a truncated list of its own certificates and little else.
  it('leaves room for a control plane and a web server on the same host', () => {
    expect(CERT_SEARCH_MAX_FILES).toBeGreaterThanOrEqual(24)
  })

  it('searches the web roots first, so they survive a truncation', () => {
    const roots = [...CERT_SEARCH_ROOTS]
    // `find` walks its arguments in order and the cap is a `head`.
    expect(roots.indexOf('/etc/nginx')).toBeLessThan(roots.indexOf('/etc/kubernetes/pki'))
  })

  it('covers k3s and rke2, which keep the same certificates somewhere else', () => {
    expect(CERT_SEARCH_ROOTS).toContain('/var/lib/rancher/k3s/server/tls')
    expect(CERT_SEARCH_ROOTS).toContain('/var/lib/rancher/rke2/server/tls')
  })
})
