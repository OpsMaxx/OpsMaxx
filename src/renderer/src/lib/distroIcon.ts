import {
  CircleDot,
  Egg,
  HardHat,
  Leaf,
  Mountain,
  Router,
  Shell,
  Snowflake,
  Triangle,
  type LucideIcon
} from 'lucide-react'

/**
 * The glyph a server row draws for the distribution the host reported.
 *
 * A FIXED table, looked up by own key only. `distroId` is already allow-listed
 * where it is parsed (shared/hostFacts.ts), but this is the second gate rather
 * than a reliance on the first: the value reaches the renderer over IPC, and the
 * row must never turn a string a host chose into a class name, an image path or
 * a network fetch. Anything not in this table — `other`, a BSD, a distro nobody
 * has drawn yet, `__proto__` — draws nothing, which is also what a server with no
 * facts yet draws. There is no fallback to `Server.os`: that is a free-text
 * field an agent can write, and it defaults to "Linux" whether or not it is.
 *
 * lucide ships no brand marks, so the glyphs are by FAMILY, and the name is on
 * the label for hover and for a screen reader.
 */
const UBUNTU = CircleDot
const DEBIAN = Shell
const RED_HAT = HardHat
const SUSE = Leaf
const ARCH = Triangle

const TABLE: Record<string, readonly [string, LucideIcon]> = {
  ubuntu: ['Ubuntu', UBUNTU],
  pop: ['Pop!_OS', UBUNTU],
  linuxmint: ['Linux Mint', UBUNTU],
  elementary: ['elementary OS', UBUNTU],
  neon: ['KDE neon', UBUNTU],
  zorin: ['Zorin OS', UBUNTU],
  debian: ['Debian', DEBIAN],
  devuan: ['Devuan', DEBIAN],
  raspbian: ['Raspberry Pi OS', DEBIAN],
  kali: ['Kali Linux', DEBIAN],
  deepin: ['deepin', DEBIAN],
  rhel: ['Red Hat Enterprise Linux', RED_HAT],
  centos: ['CentOS', RED_HAT],
  fedora: ['Fedora', RED_HAT],
  rocky: ['Rocky Linux', RED_HAT],
  almalinux: ['AlmaLinux', RED_HAT],
  ol: ['Oracle Linux', RED_HAT],
  scientific: ['Scientific Linux', RED_HAT],
  amzn: ['Amazon Linux', RED_HAT],
  opensuse: ['openSUSE', SUSE],
  'opensuse-leap': ['openSUSE Leap', SUSE],
  'opensuse-tumbleweed': ['openSUSE Tumbleweed', SUSE],
  sles: ['SUSE Linux Enterprise Server', SUSE],
  sled: ['SUSE Linux Enterprise Desktop', SUSE],
  arch: ['Arch Linux', ARCH],
  archarm: ['Arch Linux ARM', ARCH],
  manjaro: ['Manjaro', ARCH],
  endeavouros: ['EndeavourOS', ARCH],
  garuda: ['Garuda Linux', ARCH],
  alpine: ['Alpine Linux', Mountain],
  nixos: ['NixOS', Snowflake],
  gentoo: ['Gentoo', Egg],
  openwrt: ['OpenWrt', Router]
}

export function distroIcon(distroId: unknown): { label: string; Icon: LucideIcon } | null {
  if (typeof distroId !== 'string' || !Object.prototype.hasOwnProperty.call(TABLE, distroId)) return null
  const [label, Icon] = TABLE[distroId]
  return { label, Icon }
}
