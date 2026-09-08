// Interfaces, their addresses, and the resolvers this host actually uses.
//
// Asked for rather than sampled. An address changes when somebody changes it,
// not every two seconds, and the metrics poll is the one thing on the
// interactive connection that must stay cheap.
//
// Everything a host says about itself here is FREE TEXT until it is proved
// otherwise: an interface can be called anything the kernel allows, and an
// address is only an address if it parses as one. Both are shape-checked
// below rather than trusted, for the same reason hostFacts allow-lists its
// distro ids — a name is drawn in a panel, and a panel is not a safe place to
// render something a remote host chose.

/** One address on one interface. */
export interface InterfaceAddress {
  family: 'ipv4' | 'ipv6'
  /** Without the prefix length; `prefix` carries that. */
  address: string
  prefix: number | null
}

export interface NetworkInterface {
  name: string
  addresses: InterfaceAddress[]
}

export interface NetworkInfo {
  interfaces: NetworkInterface[]
  /**
   * The resolvers in use, best source first.
   *
   * `resolvectl` is asked before /etc/resolv.conf because on a
   * systemd-resolved host that file says 127.0.0.53 — technically true and
   * useless, since it names the stub rather than anything upstream.
   */
  dns: string[]
  /** Which source answered, so the panel can say when it is the stub. */
  dnsSource: 'resolvectl' | 'resolv.conf' | null
}

const IFACES = '__SP_IFACES__'
const DNS = '__SP_DNS__'

/**
 * One compound read, guarded at every step.
 *
 * `ip` is the modern tool and absent on some minimal images, so `ifconfig` is
 * the fallback; a host with neither answers with an empty section, which parses
 * to no interfaces rather than to an error.
 */
export function buildNetworkCommand(): string {
  return [
    `echo ${IFACES}`,
    'ip -o addr show 2>/dev/null || ifconfig -a 2>/dev/null || true',
    `echo ${DNS}`,
    // resolvectl first; its output is `Link 2 (ens192): 1.1.1.1 8.8.8.8` or a
    // bare list, and either way the addresses are what get picked out below.
    '(resolvectl dns 2>/dev/null || cat /etc/resolv.conf 2>/dev/null) || true'
  ].join('\n')
}

function section(text: string, name: string): string {
  const parts = text.split(name)
  if (parts.length < 2) return ''
  const rest = parts[1]
  const end = rest.search(/__SP_[A-Z]+__/)
  return end === -1 ? rest : rest.slice(0, end)
}

/** Dotted quad, each octet 0-255. Deliberately strict: this is drawn in a UI. */
const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/
/** Hex groups and colons only — enough to refuse anything that is not an address. */
const IPV6 = /^[0-9a-fA-F:]+$/

function classify(addr: string): 'ipv4' | 'ipv6' | null {
  if (IPV4.test(addr)) return 'ipv4'
  // Two colons minimum rules out a bare word, and `::` alone is not an address
  // worth showing.
  if (addr.includes(':') && addr !== '::' && IPV6.test(addr)) return 'ipv6'
  return null
}

/** Kernel interface names: letters, digits and a few separators, nothing else. */
const IFACE_NAME = /^[A-Za-z0-9_.:-]{1,32}$/

/**
 * Loopback and IPv6 link-local are dropped.
 *
 * Not because they are untrue, but because they are the same on every host in
 * the estate and say nothing about this one. A list where `lo 127.0.0.1` is the
 * first row is a list people stop reading.
 */
function isNoise(name: string, addr: InterfaceAddress): boolean {
  if (name === 'lo') return true
  if (addr.family === 'ipv6' && /^fe80:/i.test(addr.address)) return true
  return false
}

export function parseNetwork(output: string): NetworkInfo {
  const interfaces = new Map<string, InterfaceAddress[]>()

  for (const raw of section(output, IFACES).split('\n')) {
    const line = raw.trim()
    if (line === '') continue

    // `ip -o addr show`: "2: ens192    inet 10.10.1.20/24 brd ... scope global"
    const ipForm = /^\d+:\s+(\S+)\s+(inet|inet6)\s+(\S+)/.exec(line)
    if (ipForm) {
      const [, name, family, cidr] = ipForm
      const [address, prefixText] = cidr.split('/')
      const kind = classify(address)
      if (!IFACE_NAME.test(name) || kind === null) continue
      if (kind !== (family === 'inet' ? 'ipv4' : 'ipv6')) continue
      const prefix = prefixText === undefined ? null : Number(prefixText)
      const entry = { family: kind, address, prefix: Number.isFinite(prefix) ? prefix : null }
      if (isNoise(name, entry)) continue
      interfaces.set(name, [...(interfaces.get(name) ?? []), entry])
    }
  }

  const dnsText = section(output, DNS)
  const dnsSource: NetworkInfo['dnsSource'] = dnsText.trim() === ''
    ? null
    : /nameserver\s/.test(dnsText)
      ? 'resolv.conf'
      : 'resolvectl'

  const dns: string[] = []
  for (const raw of dnsText.split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue
    // resolv.conf names its resolvers; resolvectl prints them bare after a
    // link label. Taking every address-shaped token covers both without
    // needing to know which one answered.
    for (const token of line.replace(/^nameserver\s+/, '').split(/[\s,]+/)) {
      const bare = token.replace(/%.*$/, '') // strip a zone id
      if (classify(bare) !== null && !dns.includes(bare)) dns.push(bare)
    }
  }

  return {
    interfaces: [...interfaces.entries()]
      .map(([name, addresses]) => ({ name, addresses }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    dns,
    dnsSource
  }
}

/**
 * True when the only resolver named is systemd-resolved's own stub.
 *
 * Worth saying out loud in the UI: "your DNS server is 127.0.0.53" is a
 * sentence that sends people looking for a problem that is not there.
 */
export function isStubResolver(info: NetworkInfo): boolean {
  return info.dns.length > 0 && info.dns.every((d) => d.startsWith('127.0.0.5'))
}
