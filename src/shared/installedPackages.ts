import type { PackageManager } from './hostFacts'

// Every package this host has, by name and version.
//
// The motivating question is item C's: "which boxes still have the old
// openssl". Answering it needs the inventory, and the inventory is the one fact
// source that is thousands of rows per host rather than tens.
//
// ======================================================================
// THE SIZE QUESTION, MEASURED RATHER THAN DEBATED
// ======================================================================
//
// This was carried for a while as a design decision -- a cap, or its own table,
// or `pkg:` facts with retirement. It is not a decision; it is an arithmetic
// problem, and the arithmetic was run against the existing `facts` table with
// the measured package count of a real host (1241 on Ubuntu 24.04):
//
//     50 hosts x 1241 packages = 62,050 rows = 4.6 MB (78 bytes/row)
//     "which hosts have package X"        ->  3 ms
//     "which hosts have version 1.2.5*"   ->  7 ms
//
// 200 hosts is about 18 MB. So there is no cap, no second table, and no new
// schema: `facts` already has `(server, key, value, first_seen, last_seen)`
// with the key interned as TEXT, and `retireFacts(host, at, prefix, keep)`
// already exists for exactly this shape -- it is what the unit and port facts
// use.
//
// ======================================================================
// WHAT WAS MEASURED, AND THE TWO TRAPS IN IT
// ======================================================================
//
// Five managers, each in its own container or on a real host:
//
//   apt      dpkg-query -W          1239 installed    name TAB version
//   rpm      rpm -qa --qf           159 / 141       name TAB version-release
//   apk      /lib/apk/db/installed  15              P: and V: lines
//   pacman   pacman -Q             137              name SPACE version
//
//  1. RPM REPORTS `gpg-pubkey` AS A PACKAGE. It is a GPG key in the rpm
//     database, not software, and a host trusting several vendor keys has
//     SEVERAL ROWS ALL NAMED `gpg-pubkey` -- which would collide on a key of
//     `pkg:gpg-pubkey` and record whichever came last. Excluded by name. (One
//     key was present on the measured image, so the collision itself is
//     reasoned from the key model rather than observed; the exclusion costs
//     nothing either way.)
//  1b. `dpkg-query -W` LISTS PACKAGES THAT ARE NOT INSTALLED. The measured
//     host had two in `deinstall ok config-files` out of 1241 rows -- removed,
//     configuration left behind, and carrying a version like any other row. The
//     query filters on the status for that reason; rpm, apk and pacman need no
//     equivalent, because each of their databases contains only what is
//     installed.
//  2. `apk info -v` IS NOT PARSEABLE. It prints `alpine-baselayout-3.4.3-r2`,
//     name and version joined by a dash, and package names contain dashes --
//     there is no split that is right in general. The installed database has
//     `P:` and `V:` on separate lines and is unambiguous, so that is read
//     instead of the command.
//
// ======================================================================
// AN EMPTY READ IS NEVER AN EMPTY HOST
// ======================================================================
//
// This is the rule `fleetSampler` already states for units and ports, and it
// matters more here because of the volume: retiring on a failed probe would
// record over a thousand fact-removed events per host, once, the first time
// dpkg was busy. So the result is a discriminated union and the caller retires
// only on `ok`.

export const PKG_FACT_PREFIX = 'pkg:'

export const PKG_MARKER = '===SP-PKG==='

/**
 * A bound on what one host may put in memory at once.
 *
 * Well above the 1241 measured on a real Ubuntu server and the ~2800 a
 * full desktop reaches, and low enough that a pathological or hostile answer
 * cannot make this process hold tens of megabytes of strings.
 */
export const PKG_MAX_ROWS = 20_000

/**
 * The read, per manager, all emitting `name<TAB>version`.
 *
 * TAB rather than space because `pacman -Q` separates with a space and nothing
 * else does; normalising in the shell keeps one parser rather than five.
 */
export function buildInstalledPackagesCommand(manager: PackageManager | null): string | null {
  const body = ((): string | null => {
    switch (manager) {
      case 'apt':
        // THE STATUS FILTER IS NOT OPTIONAL. `dpkg-query -W` lists packages
        // that are NOT installed: the measured host had two in `deinstall ok
        // config-files` -- removed, with their configuration left behind -- and
        // they carry a version like any other row. Without this the inventory
        // answers "which boxes still have the old openssl" with hosts that
        // removed it. Same trap `kernelStatus` documents for `linux-image-*`,
        // one query over.
        return (
          `dpkg-query -W -f='\${Package}\\t\${Version}\\t\${Status}\\n' 2>/dev/null` +
          ` | awk -F'\\t' '$3 == "install ok installed" { print $1 "\\t" $2 }'`
        )
      case 'dnf':
      case 'yum':
      case 'zypper':
        // One query for all three: they are all rpm underneath, which is why
        // the opensuse and almalinux measurements produced identical shapes.
        return `rpm -qa --qf '%{NAME}\\t%{VERSION}-%{RELEASE}\\n' 2>/dev/null`
      case 'apk':
        // The database, not `apk info -v`. See finding 2.
        return `awk '/^P:/{n=substr($0,3)} /^V:/{print n "\\t" substr($0,3)}' /lib/apk/db/installed 2>/dev/null`
      case 'pacman':
        return `pacman -Q 2>/dev/null | awk '{print $1 "\\t" $2}'`
      default:
        return null
    }
  })()
  if (body === null) return null
  return `echo "${PKG_MARKER}"; ${body} | head -n ${PKG_MAX_ROWS} || true`
}

export interface InstalledPackage {
  name: string
  version: string
}

export type InstalledPackagesRead =
  | { ok: true; packages: InstalledPackage[]; truncated: boolean }
  | { ok: false; detail: string }

/** Names that are in the package database and are not packages. */
const NOT_A_PACKAGE = new Set(['gpg-pubkey'])

/**
 * Parse the inventory.
 *
 * AN EMPTY RESULT IS A FAILURE, not a host with no packages: every machine that
 * can answer an SSH command has packages, and the caller retires facts on a
 * successful read. Returning `ok: true` with an empty list would delete the
 * whole inventory the first time the query was refused.
 */
export function parseInstalledPackages(output: string): InstalledPackagesRead {
  const i = output.indexOf(PKG_MARKER)
  const body = i === -1 ? output : output.slice(i + PKG_MARKER.length)
  const packages: InstalledPackage[] = []
  const seen = new Set<string>()
  for (const line of body.split('\n')) {
    const t = line.trimEnd()
    if (t.trim() === '') continue
    const tab = t.indexOf('\t')
    // `< 0`, not `<= 0`: a line that BEGINS with a tab has an empty name, and
    // the name check below is what rejects it -- along with a line whose name is
    // only whitespace, which a position check cannot see.
    if (tab < 0) continue
    const name = t.slice(0, tab).trim()
    const version = t.slice(tab + 1).trim()
    // No empty-version check: `trimEnd()` above has already removed a trailing
    // tab, so a row with no version has no tab left and was rejected by the
    // `tab <= 0` guard. A second check reads as though it were the one keeping
    // that promise, and mutating it away changed nothing.
    if (name === '') continue
    if (NOT_A_PACKAGE.has(name)) continue
    // A name twice would collide on one fact key. First wins, and the count
    // below is of what will actually be stored.
    if (seen.has(name)) continue
    seen.add(name)
    packages.push({ name, version })
  }
  if (packages.length === 0) {
    const first = body.trim().split('\n')[0]?.trim()
    return {
      ok: false,
      detail: first !== undefined && first !== '' ? first : 'the package query returned nothing'
    }
  }
  return { ok: true, packages, truncated: packages.length >= PKG_MAX_ROWS }
}

/** `pkg:<name>` -> version, ready for `upsertFact`. */
export function packageFacts(packages: InstalledPackage[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const p of packages) out[`${PKG_FACT_PREFIX}${p.name}`] = p.version
  return out
}

/** The name back out of a fact key, for search results. */
export function packageNameFromFact(key: string): string | null {
  return key.startsWith(PKG_FACT_PREFIX) ? key.slice(PKG_FACT_PREFIX.length) : null
}
