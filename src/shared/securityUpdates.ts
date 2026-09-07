// Item 46: the security-update LIST, where `hostFacts` already has the count.
//
// ONE HOST GAVE THREE DIFFERENT ANSWERS to "how many security updates", and
// that is the whole reason this module exists rather than a `.join(', ')` over
// something the patch panel already had. Measured on almalinux:9.3:
//
//   dnf updateinfo summary        -> 133   security NOTICES (advisories)
//   dnf updateinfo list security  -> 203   rows, one per advisory-and-package
//   dnf --security check-update   ->  55   PACKAGES that will actually change
//
// 55 is the number an operator needs -- it is what `dnf upgrade --security`
// will touch. 133 is the one that sounds biggest. 203 is an artefact of the
// pairing: one advisory names several packages, so `ALSA-2025:23343` appears
// twice, once for `binutils` and once for `binutils-gold`.
//
// `hostFacts` already counts the right one. This module reports the packages,
// each carrying the advisories that cover it, and refuses to report an advisory
// count as a package count anywhere.

export const SEC_MARKERS = {
  manager: '===OPSMAXX-SECPM===',
  check: '===OPSMAXX-SECCHECK===',
  list: '===OPSMAXX-SECLIST===',
  summary: '===OPSMAXX-SECSUM==='
} as const

/**
 * One round trip, and the package manager is detected ON THE HOST.
 *
 * Never a second command built from the first one's output -- the rule
 * `services/hostFacts.ts` states, for the reason it states: round-tripping a
 * value the host chose and interpolating it into a command is the shape of the
 * injection this app has already had once.
 *
 * No `apt-get update` and no `dnf makecache` anywhere near this. `-s` is a
 * simulation with `Debug::NoLocking`, and `-C` is dnf's cache-only mode, so
 * nothing here needs root, touches a lock, or reaches the network. A stale
 * cache produces a stale list, which is a different problem and one the patch
 * panel already reports the age of.
 *
 * EVERY BLOCK KEEPS STDERR, and that is not tidiness. Measured on a host with
 * no dnf cache:
 *
 *   $ dnf -C -q --security check-update
 *   Error: Cache-only enabled but no cache for 'appstream'   <- stderr
 *   $ echo $?
 *   0
 *
 * Exit 0 is dnf's code for "nothing is pending". So a host that could not be
 * examined at all reports exactly what a fully patched host reports, and the
 * only thing separating them is a line on stderr. Throwing it away would print
 * "no security updates" for a server nobody looked at.
 */
export function buildSecurityListCommand(): string {
  return [
    'SP_APT=$(command -v apt-get 2>/dev/null || true)',
    'SP_DNF=$(command -v dnf 2>/dev/null || true)',
    'SP_YUM=$(command -v yum 2>/dev/null || true)',
    `echo "${SEC_MARKERS.manager}"`,
    'if [ -n "$SP_DNF" ] || [ -n "$SP_YUM" ]; then echo dnf; elif [ -n "$SP_APT" ]; then echo apt; else echo none; fi',
    'SP_PMB="$SP_DNF"; [ -z "$SP_PMB" ] && SP_PMB="$SP_YUM"',
    `echo "${SEC_MARKERS.check}"`,
    'if [ -n "$SP_PMB" ]; then "$SP_PMB" -C -q --security check-update 2>&1 || true',
    'elif [ -n "$SP_APT" ]; then "$SP_APT" -s -o Debug::NoLocking=true upgrade 2>&1 | grep -E "^(Inst |E: )" || true; fi',
    `echo "${SEC_MARKERS.list}"`,
    '[ -n "$SP_PMB" ] && { "$SP_PMB" -C -q updateinfo list security 2>&1 || true; }',
    `echo "${SEC_MARKERS.summary}"`,
    '[ -n "$SP_PMB" ] && { "$SP_PMB" -C -q updateinfo summary 2>&1 || true; }',
    'true'
  ].join('; ')
}

export type SecuritySource = 'apt' | 'dnf' | 'unknown'

export interface SecurityUpdate {
  /** Package name without the architecture suffix. */
  name: string
  /** The version that will be installed. */
  candidate: string
  /** Installed now, when the manager said. Empty when it did not. */
  current: string
  /** `ALSA-2026:42736`, `USN-1234-1`. Empty when the manager names none. */
  advisories: string[]
  /** `Important`, `Moderate`, `Low`, or empty. The distribution's word, kept as
   *  given: their scales differ and translating them would invent a ranking. */
  severity: string
}

/**
 * dnf's `updateinfo list security`: `<advisory> <Severity>/Sec. <nevra>`.
 *
 * The NEVRA is `name-version-release.arch`, and splitting it is the fiddly
 * part: a package name may contain hyphens (`binutils-gold`,
 * `coreutils-single`), so the version is found from the RIGHT -- the last two
 * hyphen-separated fields before the architecture.
 */
export function parseDnfSecurityList(text: string): SecurityUpdate[] {
  const by = new Map<string, SecurityUpdate>()
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '') continue
    const f = line.split(/\s+/)
    if (f.length < 3) continue
    const [advisory, sev, nevra] = f
    if (!/\/Sec\.?$/i.test(sev)) continue
    const parsed = splitNevra(nevra)
    if (parsed === null) continue
    const seen = by.get(parsed.name)
    if (seen === undefined) {
      by.set(parsed.name, {
        name: parsed.name,
        candidate: parsed.version,
        current: '',
        advisories: [advisory],
        severity: sev.replace(/\/Sec\.?$/i, '')
      })
      continue
    }
    if (!seen.advisories.includes(advisory)) seen.advisories.push(advisory)
    // The worst severity across the advisories covering this package. A package
    // listed under a Moderate and an Important notice is an Important one.
    if (severityRank(sev) < severityRank(`${seen.severity}/Sec.`)) {
      seen.severity = sev.replace(/\/Sec\.?$/i, '')
    }
  }
  return [...by.values()].sort((a, b) => a.name.localeCompare(b.name))
}

const SEVERITY_ORDER = ['critical', 'important', 'moderate', 'low']

function severityRank(sev: string): number {
  const word = sev.replace(/\/Sec\.?$/i, '').toLowerCase()
  const at = SEVERITY_ORDER.indexOf(word)
  // An unknown word sorts last rather than first: a severity nobody here
  // recognises must not outrank one that is known to be Critical.
  return at < 0 ? SEVERITY_ORDER.length : at
}

/** `acl-2.4.0-1.el9_8.aarch64` -> name `acl`, version `2.4.0-1.el9_8`. */
function splitNevra(nevra: string): { name: string; version: string } | null {
  const dot = nevra.lastIndexOf('.')
  if (dot <= 0) return null
  const withoutArch = nevra.slice(0, dot)
  const release = withoutArch.lastIndexOf('-')
  if (release <= 0) return null
  const version = withoutArch.lastIndexOf('-', release - 1)
  if (version <= 0) return null
  return { name: withoutArch.slice(0, version), version: withoutArch.slice(version + 1) }
}

/**
 * dnf's `--security check-update`: `name.arch  version  repo`.
 *
 * THE AUTHORITATIVE LIST. It is what `dnf upgrade --security` will change, and
 * it is shorter than the advisory listing for the reason in the header.
 */
export function parseDnfSecurityCheck(text: string): SecurityUpdate[] {
  const out: SecurityUpdate[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '') continue
    // dnf prints an "Obsoleting Packages" section and blank-line-separated
    // headers; a row has exactly three whitespace-separated fields and a
    // dotted name.
    const f = line.split(/\s+/)
    if (f.length !== 3) continue
    const dot = f[0].lastIndexOf('.')
    if (dot <= 0) continue
    out.push({
      name: f[0].slice(0, dot),
      candidate: f[1],
      current: '',
      advisories: [],
      severity: ''
    })
  }
  return out
}

/**
 * apt's simulated upgrade: `Inst <pkg> [<current>] (<candidate> <Origin> [arch])`.
 *
 * The ORIGIN is what marks a security update -- `Debian-Security:12/oldstable-security`
 * in the measured line -- and the archive suffix `-security` is the marker
 * `hostFacts` already counts by.
 */
export function parseAptSecurityList(text: string): SecurityUpdate[] {
  const out: SecurityUpdate[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line.startsWith('Inst ')) continue
    const m = /^Inst\s+(\S+)\s+(?:\[([^\]]*)\]\s+)?\((\S+)\s+([^)]*)\)/.exec(line)
    if (m === null) continue
    const [, name, current, candidate, rest] = m
    if (!/-security\b/.test(rest)) continue
    out.push({
      name,
      candidate,
      current: current ?? '',
      advisories: [],
      // apt names no severity at all. Empty rather than invented: Debian does
      // not publish one on this line and guessing would put a word on screen
      // that no distribution said.
      severity: ''
    })
  }
  return out
}

export interface SecurityListing {
  source: SecuritySource
  updates: SecurityUpdate[]
  /** Advisory count, when the manager reports one. NOT the package count. */
  advisories: number | null
  /** The sentence that goes with the list. */
  note: string
}

/** `133 Security notice(s)` out of `updateinfo summary`. */
export function parseDnfAdvisoryCount(text: string): number | null {
  const m = /^\s*(\d+)\s+Security notice\(s\)/m.exec(text)
  return m === null ? null : Number(m[1])
}

/**
 * The listing, from whichever manager answered.
 *
 * `check-update` is the spine and the advisory list only decorates it: the
 * advisories add severity and notice ids to packages that are on the
 * authoritative list, and a package that appears ONLY in the advisory listing
 * is not added. A notice can cover a package this host does not have installed.
 */
export function joinDnfSecurity(
  check: SecurityUpdate[],
  list: SecurityUpdate[],
  advisories: number | null
): SecurityListing {
  const bySeverity = new Map(list.map((u) => [u.name, u]))
  const updates = check.map((u) => {
    const extra = bySeverity.get(u.name)
    return extra === undefined
      ? u
      : { ...u, advisories: extra.advisories, severity: extra.severity }
  })
  return {
    source: 'dnf',
    updates,
    advisories,
    note:
      advisories === null || advisories === updates.length
        ? `${updates.length} package(s) will change.`
        : `${updates.length} package(s) will change, covered by ${advisories} advisor${advisories === 1 ? 'y' : 'ies'} — one advisory can name several packages, and several can name one, so the two numbers are not the same measurement.`
  }
}

export function aptSecurityListing(updates: SecurityUpdate[]): SecurityListing {
  return {
    source: 'apt',
    updates,
    // apt publishes no advisory count on this path. Null, not zero.
    advisories: null,
    note:
      updates.length === 0
        ? 'No security updates in the package lists as they stand. apt gives no way to tell that from a server whose lists were never downloaded — both print nothing — so check the cache age beside this before treating it as an all-clear.'
        : `${updates.length} package(s) will change, from the package lists as they stand.`
  }
}

/** Worst first, then by name. Packages with no severity sort last -- apt names
 *  none, so on a Debian host this is simply alphabetical. */
export function sortBySeverity(updates: SecurityUpdate[]): SecurityUpdate[] {
  return [...updates].sort(
    (a, b) => severityRank(a.severity) - severityRank(b.severity) || a.name.localeCompare(b.name)
  )
}

function block(output: string, marker: string): string {
  const at = output.indexOf(marker)
  if (at < 0) return ''
  const from = at + marker.length
  let end = output.length
  for (const m of Object.values(SEC_MARKERS)) {
    const i = output.indexOf(m, from)
    if (i >= 0 && i < end) end = i
  }
  return output.slice(from, end).trim()
}

export type SecurityListProbe =
  | { ok: true; listing: SecurityListing }
  | { ok: false; detail: string }

/**
 * The cache-only refusal, on either manager.
 *
 * dnf says `Cache-only enabled but no cache for '<repo>'` and EXITS 0, which is
 * its code for "nothing pending", so the line is the only thing separating a
 * host nobody could examine from a fully patched one.
 *
 * APT HAS NO SUCH LINE. Measured on a Debian image with no package lists: the
 * simulated upgrade prints NOTHING and succeeds, which is exactly what a
 * patched host prints. There is no way to tell them apart from this read, so
 * the apt listing carries a note saying the answer is only as good as the
 * cache, and the patch panel's existing cache-age reading is what makes that
 * checkable. Claiming a detection here that does not exist would be worse than
 * the note.
 */
const NO_CACHE_RE = /Cache-only enabled but no cache|Failed to download metadata|E: (?:Unable to|Could not)/i

/**
 * The whole read, from whichever manager the host has.
 *
 * A host with NEITHER manager is `ok: false` with a reason, not an empty list:
 * "no security updates" and "nothing here knows how to ask" are different
 * answers, and only one of them is good news.
 */
export function parseSecurityListOutput(output: string): SecurityListProbe {
  const manager = block(output, SEC_MARKERS.manager)
  if (manager === '') {
    return { ok: false, detail: 'the host did not say which package manager it has' }
  }
  if (manager === 'none') {
    return {
      ok: false,
      detail: 'no apt, dnf or yum on this server, so its security updates could not be listed'
    }
  }
  const checkText = block(output, SEC_MARKERS.check)
  const cacheProblem = NO_CACHE_RE.exec(checkText)
  if (cacheProblem !== null) {
    return {
      ok: false,
      detail: `${checkText.split('\n').find((l) => NO_CACHE_RE.test(l))?.trim() ?? cacheProblem[0]} — the package manager answered from a cache it does not have, and its exit code for that is the same one it uses for "nothing pending".`
    }
  }
  if (manager === 'apt') {
    return { ok: true, listing: aptSecurityListing(parseAptSecurityList(checkText)) }
  }
  return {
    ok: true,
    listing: joinDnfSecurity(
      parseDnfSecurityCheck(checkText),
      parseDnfSecurityList(block(output, SEC_MARKERS.list)),
      parseDnfAdvisoryCount(block(output, SEC_MARKERS.summary))
    )
  }
}
