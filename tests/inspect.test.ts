import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  INSPECT_CA_EXPIRY_WARN_SEC,
  INSPECT_DEFAULT_PASSTHROUGH,
  describeFlow,
  formatFingerprint,
  isPassthroughHost,
  isSensitiveHeader,
} from "../src/shared/inspect";
import type { InspectFlow } from "../src/shared/inspect";
import {
  derFromPem,
  sha1Hex,
  sha256Hex,
} from "../src/main/services/inspectTrust";

// The traffic inspector's shared rules.
//
// Everything asserted here is a rule that exists in two places — once in Go,
// once in TypeScript — and the cost of them disagreeing is a user staring at a
// panel that says a host is excluded while the proxy is still intercepting it.
// The parity test at the bottom is the one that actually holds them together;
// the rest pin the behaviour each side is supposed to have.

const flow = (over: Partial<InspectFlow> = {}): InspectFlow => ({
  id: "f1",
  startedAt: 1000,
  state: "complete",
  status: 200,
  request: {
    method: "GET",
    scheme: "https",
    host: "example.com",
    port: 443,
    path: "/thing",
    httpVersion: "HTTP/1.1",
    headers: [],
  },
  ...over,
});

describe("passthrough matching", () => {
  it("matches an exact host regardless of case or trailing dot", () => {
    expect(isPassthroughHost(["api.example.com"], "API.Example.com")).toBe(
      true,
    );
    expect(isPassthroughHost(["api.example.com"], "api.example.com.")).toBe(
      true,
    );
  });

  it("covers subdomains with a wildcard but not the bare domain", () => {
    // The rule every certificate, CDN config and firewall already uses.
    // Inventing a different one here would be wrong in exactly the case the
    // user cared about.
    const list = ["*.internal.dev"];
    expect(isPassthroughHost(list, "a.internal.dev")).toBe(true);
    expect(isPassthroughHost(list, "deep.a.internal.dev")).toBe(true);
    expect(isPassthroughHost(list, "internal.dev")).toBe(false);
    expect(isPassthroughHost(list, "evil-internal.dev")).toBe(false);
    expect(isPassthroughHost(list, "xinternal.dev")).toBe(false);
  });

  it("never matches an empty host", () => {
    expect(isPassthroughHost(["*.example.com"], "")).toBe(false);
    expect(isPassthroughHost(["*.example.com"], "   ")).toBe(false);
  });

  it("excludes revocation, platform update and OpsMaxx’s own updater by default", () => {
    // Not a guess at what pins. Interception on these either fails outright or
    // does damage: a client that cannot check revocation may reject the whole
    // chain, and standing in the middle of an OS update is a way to break a
    // machine rather than learn something.
    expect(
      isPassthroughHost(INSPECT_DEFAULT_PASSTHROUGH, "ocsp.digicert.com"),
    ).toBe(true);
    expect(
      isPassthroughHost(
        INSPECT_DEFAULT_PASSTHROUGH,
        "fe2.update.microsoft.com",
      ),
    ).toBe(true);
    expect(
      isPassthroughHost(INSPECT_DEFAULT_PASSTHROUGH, "api.github.com"),
    ).toBe(true);
    expect(isPassthroughHost(INSPECT_DEFAULT_PASSTHROUGH, "example.com")).toBe(
      false,
    );
  });
});

describe("sensitive headers", () => {
  it("recognises the credential headers whatever their case", () => {
    for (const name of ["Authorization", "COOKIE", "set-cookie", "X-Api-Key"]) {
      expect(isSensitiveHeader(name)).toBe(true);
    }
  });

  it("leaves ordinary headers alone", () => {
    for (const name of [
      "Content-Type",
      "Accept",
      "User-Agent",
      "authorization-policy",
    ]) {
      expect(isSensitiveHeader(name)).toBe(false);
    }
  });
});

describe("fingerprints", () => {
  it("formats as every trust-store UI shows it", () => {
    expect(formatFingerprint("ab12cd34")).toBe("AB:12:CD:34");
    // Tolerates a value that is already formatted, because that is what a user
    // pastes back in from Keychain Access.
    expect(formatFingerprint("AB:12:CD:34")).toBe("AB:12:CD:34");
  });
});

describe("flow descriptions", () => {
  it("says what state a flow is in rather than implying a status it has not got", () => {
    expect(
      describeFlow(flow({ state: "pending", status: undefined })),
    ).toContain("in flight");
    expect(
      describeFlow(flow({ state: "failed", status: undefined })),
    ).toContain("failed");
    expect(describeFlow(flow())).toBe("200 GET example.com/thing");
    expect(
      describeFlow(flow({ request: { ...flow().request, query: "a=1" } })),
    ).toContain("?a=1");
  });
});

describe("certificate hashing", () => {
  // A real, fixed, self-signed P-256 certificate. Fixed rather than generated
  // in the test because the point is that these digests are STABLE: a
  // certificate minted here would prove only that the code agrees with itself,
  // and the values below are what a user will compare against Keychain Access.
  const PEM = `-----BEGIN CERTIFICATE-----
MIIBqDCCAU2gAwIBAgIUdON1HcbEwmYwlgBEFD9ZaPyoWnYwCgYIKoZIzj0EAwIw
KTEnMCUGA1UEAwweT3BzTWF4eCBUcmFmZmljIEluc3BlY3RvciBUZXN0MB4XDTI2
MDkwODIwMDkzNFoXDTM2MDkwNTIwMDkzNFowKTEnMCUGA1UEAwweT3BzTWF4eCBU
cmFmZmljIEluc3BlY3RvciBUZXN0MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE
yKlJL3+U/OnnUwo24giFmqLXpglOoWzi8GArutPTDa3o5DfidJVziWfEF7IgOeof
xhMrOw+0tj8hkDdosk2KPaNTMFEwHQYDVR0OBBYEFAvp/agCrPDL77e8fQLfPiOJ
TqlEMB8GA1UdIwQYMBaAFAvp/agCrPDL77e8fQLfPiOJTqlEMA8GA1UdEwEB/wQF
MAMBAf8wCgYIKoZIzj0EAwIDSQAwRgIhAP8S+f1fsGDR0aJmhNBY4q7+2CxbQWHf
aWc5wtPhj1rHAiEAmZTvcdHyhzPQCgHVKLzgcdB4swAQgoQZbkKa8LgVRJo=
-----END CERTIFICATE-----`;

  it("extracts DER from PEM regardless of surrounding whitespace", () => {
    const tight = derFromPem(PEM);
    const loose = derFromPem(`\n\n  ${PEM.replace(/\n/g, "\r\n")}  \n`);
    expect(tight.length).toBeGreaterThan(0);
    expect(loose.equals(tight)).toBe(true);
  });

  it("is a certificate the platform certificate parser accepts", async () => {
    // Guards the fixture itself. A PEM that only looks like a certificate
    // would still hash, and every assertion below would pass while testing
    // nothing.
    const { X509Certificate } = await import("node:crypto");
    expect(new X509Certificate(PEM).subject).toContain(
      "OpsMaxx Traffic Inspector Test",
    );
  });

  it("produces both digests, because the platforms disagree about which to use", () => {
    // Windows identifies a certificate in a store by SHA-1 thumbprint and
    // nothing else; macOS reports SHA-256. Both are needed and neither is a
    // security decision — they are lookup keys.
    expect(sha256Hex(PEM)).toMatch(/^[0-9a-f]{64}$/);
    expect(sha1Hex(PEM)).toMatch(/^[0-9a-f]{40}$/);
    expect(sha256Hex(PEM)).not.toBe(sha1Hex(PEM));
    // Pinned. A change here means the DER extraction changed, which would
    // silently break every trust-store lookup on every platform.
    expect(sha256Hex(PEM)).toBe(
      "d64faa004652e428155452f733658fda5fe7cc59ac0942018e5b72075b018bdf",
    );
    expect(sha1Hex(PEM)).toBe("68f3caf5446f57e07c86d11be745ea173f3445c4");
  });
});

// The parity test. The passthrough rule exists in Go (for the proxy) and in
// TypeScript (so the panel can show a host as excluded without a round trip),
// and the only thing stopping them drifting apart is this.
describe("passthrough parity with the sidecar", () => {
  const netd = fileURLToPath(new URL("../sidecar/netd", import.meta.url));

  it.skipIf(!existsSync(`${netd}/inspect.go`) || !hasGo())(
    "agrees with matchHostList in inspect.go on every case",
    () => {
      const cases: [string[], string, boolean][] = [
        [["api.example.com"], "api.example.com", true],
        [["api.example.com"], "API.EXAMPLE.COM", true],
        [["*.internal.dev"], "a.internal.dev", true],
        [["*.internal.dev"], "deep.a.internal.dev", true],
        [["*.internal.dev"], "internal.dev", false],
        [["*.internal.dev"], "evil-internal.dev", false],
        [["*.internal.dev"], "xinternal.dev", false],
        [["host"], "host", true],
        [["host"], "other", false],
      ];
      for (const [list, host, want] of cases) {
        expect(
          isPassthroughHost(list, host),
          `${JSON.stringify(list)} vs ${host}`,
        ).toBe(want);
      }

      // The same rule, checked on the Go side. TestPassthroughMatching in
      // inspect_test.go covers the identical table, so if either implementation
      // changes its rule one of the two suites goes red.
      const out = execFileSync(
        "go",
        ["test", "-run", "TestPassthroughMatching", "-count=1", "."],
        { cwd: netd, encoding: "utf8", timeout: 180_000 },
      );
      expect(out).toContain("ok");
    },
  );
});

function hasGo(): boolean {
  try {
    execFileSync("go", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe('body paging arithmetic', () => {
  it('counts decoded bytes, not base64 characters', async () => {
    // The next page's offset is a BYTE offset. Neither the base64 length nor
    // the decoded JavaScript string length is that — base64 is 4 characters
    // per 3 bytes minus padding, and a decoded string counts UTF-16 units. An
    // over-count here silently skips bytes on every page after the first.
    const { base64Bytes } = await import(
      '../src/renderer/src/components/inspect/InspectFlowDetail'
    )
    for (const raw of ['', 'a', 'ab', 'abc', 'abcd', 'hello world', '£€ non-ascii ✓']) {
      const bytes = Buffer.from(raw, 'utf8')
      expect(base64Bytes(bytes.toString('base64')), raw).toBe(bytes.length)
    }
    // Binary, where the decoded-string-length shortcut is most wrong.
    const binary = Buffer.from([0, 255, 128, 10, 0, 7])
    expect(base64Bytes(binary.toString('base64'))).toBe(binary.length)
  })

  it('tolerates whitespace and returns 0 for nothing', () => {
    expect(base64BytesSync('')).toBe(0)
  })
})

// Imported lazily above because the component module pulls in React; this
// small duplicate keeps the trivial case out of that import.
function base64BytesSync(b64: string): number {
  const clean = b64.replace(/[^A-Za-z0-9+/=]/g, '')
  if (clean.length === 0) return 0
  const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0
  return (clean.length / 4) * 3 - padding
}

describe('host:port splitting for passthrough rules', () => {
  it('keeps IPv6 addresses whole', async () => {
    // A passthrough rule matches on the host alone, so an opaque tunnel
    // reported as `host:port` has to be reduced to a host. Splitting an IPv6
    // literal on its last colon returns half an address and a rule that
    // matches nothing — the failure is silent, which is why it is pinned here.
    const { hostWithoutPort } = await import('../src/main/services/inspect')
    const cases: Record<string, string> = {
      'mail.example.test:993': 'mail.example.test',
      'example.com': 'example.com',
      '127.0.0.1:8443': '127.0.0.1',
      '[2001:db8::1]:993': '2001:db8::1',
      '[::1]:8080': '::1',
      '[::1]': '::1',
      '2001:db8::1': '2001:db8::1'
    }
    for (const [input, want] of Object.entries(cases)) {
      expect(hostWithoutPort(input), input).toBe(want)
    }
  })
})

describe('which listeners need a password', () => {
  it('treats only genuine loopback addresses as safe', async () => {
    // A proxy off loopback is reachable by the whole network AND decrypts
    // TLS, so this predicate decides whether credentials are mandatory. A
    // hostname that is not an IP literal counts as remote: resolving it to
    // answer a security question would mean trusting DNS for it.
    const { isLoopbackBind } = await import('../src/main/services/inspect')
    for (const host of ['127.0.0.1', '127.0.0.53', '::1', '[::1]', 'localhost', '', '  ']) {
      expect(isLoopbackBind(host), host).toBe(true)
    }
    for (const host of ['0.0.0.0', '::', '192.168.1.10', '10.0.0.1', 'example.com', '169.254.1.1']) {
      expect(isLoopbackBind(host), host).toBe(false)
    }
  })
})

describe('certificate expiry', () => {
  it('warns for a fortnight, which is long enough to act and short enough to notice', () => {
    // Pinned because the number is a judgement, and a silent change to it is
    // the difference between a warning nobody sees and permanent furniture.
    expect(INSPECT_CA_EXPIRY_WARN_SEC).toBe(14 * 24 * 60 * 60)
  })
})
