// Output scrubbing: command/file output returned to an AI agent (and
// anything written to the audit log) is passed through this before it
// leaves the security boundary. Two layers:
//  1. Known secret values actually held for the servers involved in this
//     operation (resolved passwords/passphrases/DB credentials) are blanked
//     out verbatim, so a command that happens to print one back can't leak it.
//  2. Common secret-shaped patterns (KEY=value assignments, private key
//     blocks, bearer/API tokens) are redacted even when the value itself
//     isn't one OpsMaxx already knows about.
const PLACEHOLDER = '[REDACTED]'

const PATTERN_RULES: { regex: RegExp; replace: (m: string[]) => string }[] = [
  // FOO_PASSWORD=bar / FOO_TOKEN=bar / FOO_SECRET=bar style env assignments.
  //
  // The name class takes `-` as well as `_` because the HTTP header spelling is
  // the hyphenated one: `X-Api-Key:` is the same secret as `API_KEY=` and was
  // walking straight through. (`X-Auth-Token:` always matched, via the bare
  // `TOKEN` alternative — the gap was only the `API_KEY` family, whose
  // alternatives all spelled the separator `_`.)
  {
    regex: /\b([A-Za-z0-9_-]*(?:PASSWORD|PASSWD|SECRET|TOKEN|API[_-]?KEY|PRIVATE[_-]?KEY)[A-Za-z0-9_-]*)\s*[:=]\s*("[^"\n]*"|'[^'\n]*'|\S+)/gi,
    replace: (m) => `${m[1]}=${PLACEHOLDER}`
  },
  // PEM private key blocks — terminated, or cut off.
  //
  // Three things the old `BEGIN [^-]*PRIVATE KEY-----…END` form got wrong, each
  // of which left a key body in the log as prose:
  //
  //  * `[^-]*` cannot cross a hyphen, so `RSA-PSS PRIVATE KEY` matched nothing.
  //    The label is now `[A-Z0-9]+(?:[ -][A-Z0-9]+)*`, which deliberately still
  //    cannot contain a `-----` run — so it can never swallow an intervening
  //    `-----END CERTIFICATE-----` and redact the log between two blocks.
  //  * PGP armour ends `PRIVATE KEY BLOCK-----`, never with `KEY` adjacent to
  //    the dashes, hence the optional ` BLOCK`.
  //  * Requiring the END marker meant any cut between the two markers — a cap, a
  //    drained pipe, a killed process — turned the whole body back into plain
  //    text. So the END is one branch and end-of-text is the other: an
  //    unterminated block is redacted to the end, because there is no way to
  //    know where the key stopped. A log that prints a BEGIN line and nothing
  //    else loses its tail, which is the right side to err on for a private key.
  //
  // The unterminated branch must NOT write an END marker of its own, and that
  // is load-bearing rather than cosmetic: output from a redacted-as-it-grows
  // buffer gets redacted again when the next chunk lands, and a synthetic END
  // would close the block in front of the rest of the key body still arriving.
  {
    regex:
      /-----BEGIN (?:[A-Z0-9]+(?:[ -][A-Z0-9]+)* )?PRIVATE KEY( BLOCK)?-----[\s\S]*?(?:-----END (?:[A-Z0-9]+(?:[ -][A-Z0-9]+)* )?PRIVATE KEY( BLOCK)?-----|$)/g,
    replace: (m) =>
      m[0].includes('-----END ')
        ? `-----BEGIN PRIVATE KEY-----\n${PLACEHOLDER}\n-----END PRIVATE KEY-----`
        : `-----BEGIN PRIVATE KEY-----\n${PLACEHOLDER}`
  },
  // Bearer/API tokens in headers or CLI flags.
  {
    regex: /\b(Bearer|Authorization:\s*Bearer)\s+[A-Za-z0-9._-]{10,}/gi,
    replace: (m) => `${m[1]} ${PLACEHOLDER}`
  },
  // AWS access key ids.
  { regex: /\bAKIA[0-9A-Z]{16}\b/g, replace: () => PLACEHOLDER },
  // The matching AWS *secret* access key, which the rule above never covered:
  // 40 base64 characters with no prefix to anchor on.
  //
  // Shape alone, so the six lookarounds below are the whole of what keeps it off
  // ordinary output. They do two separate jobs, and it is worth knowing which is
  // which before editing either:
  //
  //  * ISOLATION — the leading negative LOOKBEHIND, plus the negative lookahead
  //    nested inside the length check. Nothing base64 on either side, so the rule
  //    cannot bite a 40-char window inside a longer blob or inside a 44-char
  //    WireGuard key.
  //  * MIXING — the three character-class lookaheads, one each for lower, upper
  //    and digit. That is what excludes the 40-character strings a real log is
  //    full of: git object ids and sha1 digests are single-case hex.
  //
  // So: one lookbehind and five lookaheads (four of them positive, the nested
  // one negative). Count them in the literal rather than trusting this sentence —
  // dropping the wrong one silently widens the rule onto every commit hash in
  // the output, and the tests would still pass.
  {
    regex:
      /(?<![A-Za-z0-9+/=])(?=[A-Za-z0-9+/]{40}(?![A-Za-z0-9+/=]))(?=[A-Za-z0-9+/]*[a-z])(?=[A-Za-z0-9+/]*[A-Z])(?=[A-Za-z0-9+/]*[0-9])[A-Za-z0-9+/]{40}/g,
    replace: () => PLACEHOLDER
  },
  // Vendor-prefixed tokens. The prefix is the whole tell: these are issued
  // strings that carry their own namespace, so there is no key name to match on
  // and no false-positive risk worth the name — nothing else in a log begins
  // `xoxb-` or `glpat-`.
  {
    regex: /\b(?:xox[baprs]-|glpat-|ghp_|gho_|ghu_|ghs_|ghr_|sk-)[A-Za-z0-9_-]{10,}/g,
    replace: () => PLACEHOLDER
  },
  // mysql's glued password flag. `-p` takes its value attached — `-pS3cret`,
  // not `-p S3cret` — so there is no key name for the assignment rule to see,
  // and the whole argv of the client is in `ps`.
  //
  // Anchored on the client name rather than on `-p` alone: a bare `\s-p\S+`
  // eats `find . -print` and `tar -pxf`, and a rule that destroys diagnostics
  // is worse than the gap it closes.
  {
    regex: /\b((?:mysql|mysqldump|mysqladmin|mariadb|mariadb-dump)\b[^\n]*?\s)-p\S+/gi,
    replace: (m) => `${m[1]}-p${PLACEHOLDER}`
  },
  // Postgres/MySQL/Mongo style connection URIs with an embedded password.
  {
    regex: /\b([a-z][a-z0-9+.-]*:\/\/[^:/\s]+:)([^@/\s]+)(@)/gi,
    replace: (m) => `${m[1]}${PLACEHOLDER}${m[3]}`
  },
  // --- VPN engine output -------------------------------------------------
  //
  // A WireGuard key is 32 bytes, so base64 of one is 44 chars with a fixed
  // final alphabet. Private, public and preshared keys are indistinguishable
  // by shape, so the public key is redacted too. That is the right trade: a
  // redacted public key costs a support ticket, a leaked private key costs the
  // tunnel. The UI must therefore show a public key from the profile model,
  // never scraped back out of a log.
  //
  // The trailing \B is what keeps this off ordinary base64: a longer blob's
  // only '=' is its own terminator, and the char before the 44-char window is
  // then a word char, so neither boundary holds.
  // WireGuard keys: 44 base64 characters, the 43rd constrained.
  //
  // Two things here are easy to get wrong and both leak a private key.
  //
  // The trailing `048`: the 43rd character encodes only the low nibble of the
  // last byte shifted left by two, so it is one of `AEIMQUYcgkosw048`. The
  // first thirteen are letters and the last three digits, so the digits get
  // dropped — which lets 19% of real keys through.
  //
  // The boundaries: `\b` does not work here. A base64 key can begin with `+`
  // or `/`, which are not word characters, so after a space there is no word
  // boundary and the match fails — silently, for 2 keys in 64. Anchoring on
  // "not preceded/followed by another base64 character" is what actually
  // expresses the intent, and it still declines to bite a 44-character window
  // inside a longer blob.
  {
    regex: /(?<![A-Za-z0-9+/=])[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=(?![A-Za-z0-9+/=])/g,
    replace: () => PLACEHOLDER
  },
  // The same keys in the hex form wireguard-go's UAPI speaks on its socket.
  {
    regex: /\b((?:private|preshared)_key)=[0-9a-f]{64}\b/gi,
    replace: (m) => `${m[1]}=${PLACEHOLDER}`
  },
  // OpenVPN static-challenge response: base64(password) and base64(otp) in one
  // token. It carries the password itself, not just the one-time code.
  { regex: /SCRV1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+/g, replace: () => PLACEHOLDER },
  // frp / generic TOML+INI secret assignment. Line-anchored and greedy to the
  // end of the line because a TOML value may be quoted, bare, or a Go template
  // expression, and the whole of it is the secret.
  {
    regex: /^(\s*(?:auth\.)?(?:token|secretKey|password)\s*=\s*).+$/gim,
    replace: (m) => `${m[1]}${PLACEHOLDER}`
  },
  // OpenVPN quoting back the config line it could not parse:
  //
  //   Options error: Unrecognized option or missing parameter(s) in [STDIN]:7: …
  //
  // and the `…` is that line of the config, verbatim. A bare value with no key
  // name in front of it has no shape for any rule here to recognise — which is
  // exactly what an inline credential on its own line looks like — and the
  // config reaches openvpn on stdin (`ElevationRequest.stdin`) precisely so it
  // never has to touch disk, credentials and all.
  //
  // So the echo goes and the diagnosis stays: which line of the config openvpn
  // choked on is the useful half, and it is before the colon.
  {
    regex: /(\[STDIN\]:\d+:\s*)\S.*/g,
    replace: (m) => `${m[1]}${PLACEHOLDER}`
  },
  // OpenVPN management-channel command echo. `--management-query-passwords`
  // makes us write `password "Auth" "<secret>"` on the socket, and the daemon
  // echoes what it received back at us when logging is verbose.
  {
    regex: /\b(password\s+"[^"\n]*"\s+)"[^"\n]*"/gi,
    replace: (m) => `${m[1]}"${PLACEHOLDER}"`
  }
]

export function redactKnownSecrets(text: string, knownSecrets: string[]): string {
  let out = text
  for (const secret of knownSecrets) {
    if (!secret || secret.length < 3) continue
    out = out.split(secret).join(PLACEHOLDER)
  }
  return out
}

export function redactPatterns(text: string): string {
  let out = text
  for (const rule of PATTERN_RULES) {
    out = out.replace(rule.regex, (...args: unknown[]) => {
      // args is [fullMatch, group1, group2, ..., offset, string] — groups
      // line up at the same indices the rule callbacks index by (m[1], m[2]).
      const groups = args.slice(0, -2).map((a) => (typeof a === 'string' ? a : ''))
      return rule.replace(groups)
    })
  }
  return out
}

export function redactOutput(text: string, knownSecrets: string[] = []): string {
  return redactPatterns(redactKnownSecrets(text, knownSecrets))
}
