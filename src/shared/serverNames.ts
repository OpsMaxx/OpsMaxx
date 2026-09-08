// Labels for servers whose names collide.
//
// ---------------------------------------------------------------------------
// WHY
// ---------------------------------------------------------------------------
//
// Nothing stops two servers sharing a name, and people give them one all the
// time — a `demo-box-01` at each of two clients, a `db-01` in staging and in
// production. The app then renders both identically in the sidebar, on the
// overview cards, in the alert list, in the capacity forecast, and — this is
// the one that matters — in the row you tick to install packages and reboot.
//
// Two rows with the same label and different consequences is not a cosmetic
// problem. On the alerts tab the operator cannot tell which host they are
// acknowledging; on the patch table they cannot tell which of two identical
// rows they just selected for a reboot. The app already HAS the distinguishing
// data — its own error messages print `:22` against `:2222` — it just never
// puts it where the choice is made.
//
// ---------------------------------------------------------------------------
// ADD NOISE ONLY WHERE THERE IS AMBIGUITY, AND ONLY AS MUCH AS IS NEEDED
// ---------------------------------------------------------------------------
//
// The obvious fix — always render `name (user@host:port)` — is worse than the
// bug for the overwhelming majority of estates, where every name is already
// unique. It doubles the width of every label to solve a problem that is not
// present, and a label that is always noisy is one people stop reading, which
// is how the distinguishing detail gets missed on the one row where it counted.
//
// So: a unique name is returned untouched, and a colliding one is given the
// SHORTEST suffix that actually separates it from the others it collides with.
// The ladder is tried in order and stops at the first rung that works, so two
// hosts differing only by port get `:2222` rather than the full
// `root@127.0.0.1:2222`.
//
// The last rung is a short id, which always separates because ids are unique.
// It is ugly on purpose: two servers identical in name, user, host AND port are
// genuinely two records of the same machine, and the label should look wrong
// because the situation is.

export interface NameableServer {
  id: string
  name: string
  host: string
  port: number
  username: string
}

/**
 * The suffix ladder, cheapest first.
 *
 * Each entry must be a pure function of the server, and adding a rung is a
 * decision about what a user can tell two machines apart by — not a formatting
 * preference.
 */
const RUNGS: ((s: NameableServer) => string)[] = [
  // Same name, different machine: the host is what a person recognises.
  (s) => s.host,
  // Same name and host: two entries for one box on different ports, which is
  // exactly the shape a container-per-service estate produces.
  (s) => `${s.host}:${s.port}`,
  // Same name, host and port: two accounts on one machine.
  (s) => `${s.username}@${s.host}:${s.port}`,
  // Always separates, and reads as broken because the situation is.
  (s) => `${s.username}@${s.host}:${s.port} · ${s.id.slice(0, 6)}`
]

/** `name (suffix)`, or the bare name when nothing had to be added. */
function label(name: string, suffix: string | null): string {
  return suffix === null ? name : `${name} (${suffix})`
}

/**
 * A display label per server id.
 *
 * Callers render `labels.get(server.id) ?? server.name`, so a server missing
 * from the map — one from another workspace, say — still gets a name rather
 * than an empty string.
 */
export function disambiguateServerNames(servers: readonly NameableServer[]): Map<string, string> {
  const byName = new Map<string, NameableServer[]>()
  for (const s of servers) {
    const key = s.name.trim()
    const group = byName.get(key)
    if (group) group.push(s)
    else byName.set(key, [s])
  }

  const out = new Map<string, string>()
  for (const [name, group] of byName) {
    if (group.length === 1) {
      out.set(group[0].id, group[0].name)
      continue
    }
    // Find the cheapest rung that tells every member of THIS group apart. A
    // rung that separates some of them but not all is not enough: leaving two
    // of five ambiguous is the same defect at a smaller scale.
    const rung = RUNGS.find((f) => new Set(group.map(f)).size === group.length)
    for (const s of group) {
      // `rung` is only undefined if every rung collided, which the id rung
      // makes impossible — but falling back to the last one rather than
      // asserting means a future rung reordering cannot produce a bare
      // duplicate label.
      out.set(s.id, label(name, (rung ?? RUNGS[RUNGS.length - 1])(s)))
    }
  }
  return out
}

/**
 * One server's label in the context of the rest.
 *
 * Convenience for a component holding a single server; prefer the map when
 * rendering a list, since this rebuilds the grouping on every call.
 */
export function serverLabel(server: NameableServer, all: readonly NameableServer[]): string {
  return disambiguateServerNames(all).get(server.id) ?? server.name
}
