/**
 * A byte count, in the units the tools on the other end of the connection use.
 *
 * The divisor is 1024 and the labels say so. They used to read KB/MB/GB while
 * the maths was binary, so a 17.8 GiB filesystem was captioned "17.8 GB" —
 * which is a different quantity, and an operator checking it against `df -h`
 * (binary, printed as `18G`) was comparing two things that only looked alike.
 *
 * Binary rather than decimal because that is what every number this app sits
 * next to uses: df, free, htop and /proc all report multiples of 1024. Naming
 * them correctly is the fix; switching to decimal would make the labels honest
 * and the comparison worse.
 */
export function bytes(n: number): string {
  if (n <= 0) return '0 B'
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)))
  return `${(n / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

export function rate(n: number): string {
  return `${bytes(n)}/s`
}

export function duration(fromMs: number | null): string {
  if (!fromMs) return '—'
  const s = Math.floor((Date.now() - fromMs) / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${sec}s`
  return `${sec}s`
}

export function clsx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ')
}
