# CI/CD module — phase 2

Phase 1 is the `cicd` read module: connect a Jenkins, GitLab or GitHub Actions
account, see pipelines and runs, read logs, stop a run. It ships off by default.

This is what was deliberately held back, why, and what putting each one in
actually costs. Nothing here is unfinished work that got forgotten — each item
was decided against for phase 1 and the reason is written down.

Design detail for all of it lives in `docs/plans/cicd-module.md`; this file is
the ordering and the rationale.

---

## 0. The gate phase 2 does not start without

**Phase 1 must have been run against a real CI server**, and the UI walked by
hand at least once. That is the whole reason the items below were held.

Phase 1 shipped with 8,216 tests green, a clean typecheck, two adversarial
reviews and four separate dead wires found *after* the suite went green — a
contract member with no caller each time. `tests/cicdBridgeWired.test.ts` now
catches that class automatically, but it proves a name is mentioned, not that
the call is correct. Only running it proves that.

If phase 1 comes back with adapter corrections, those land before anything
below.

---

## 1. `cicdTrigger` — the operate half

**Status: fully built, tested, reviewed. Not registered.**

Everything exists: `triggerJenkins`/`triggerGitlab`/`triggerGithub`,
`cancel*`/`rerunGithub`, `wiring.ts` dispatch, three MCP tools behind
`evaluateCiTrigger` and a per-call approval, the run workbench's buttons, and
`CicdTriggerPanel`. It is not in `MODULES`, so it cannot be switched on.

**Why it waited.** It is the half where being wrong starts a production deploy,
and phase 1 is where the unknown-unknowns surface. Read-only finds them first.

**Putting it back** is three edits, each marked in place with a comment naming
the others:

1. `src/shared/modules.ts` — the commented `MODULES` entry becomes an entry
   again; `'cicdTrigger'` returns to `OperateModuleId` and `OPERATE_MODULE_IDS`.
2. `src/renderer/src/components/operations/OperationsView.tsx` — the import,
   the `CONSEQUENCE` line and the guarded card.
3. `tests/monitorSurfaces.test.ts` and `tests/moduleBoundaries.test.ts` — both
   pin the operate list exactly, which is why this cannot be done quietly.

TypeScript enforces most of it: `CONSEQUENCE` is a
`Record<OperateModuleId, string>`, so the union and the card cannot drift apart.

**Ship it when** a real trigger has been run against a real Jenkins and a real
GitHub repo, and the `workflow_dispatch`/queue-item paths behaved as the
adapters assume. Those are the two the documentation got wrong before.

---

## 2. Failure alerts, and wake-from-sleep, together

**These are one item, not two.** Shipping alerts without sleep-suppression is
the bug, and sleep-suppression without alerts is dead code.

**Alerts.** `src/shared/webhook.ts` has `ALERT_KINDS` and `STATE_ALERT_KINDS`;
`service-down` and `pod-crashloop` are the precedent for a subject that is not
a fleet host. The poller already has the transition channel this hangs off —
`CicdPollDeps.change` fires only when a target's read state actually changes,
and `wiring.ts` currently routes it to the panel.

The payload carries **the connection's name, never its URL**
(`webhook.ts:275-283` states the rule). Then `LABEL` and `WEBHOOK_KIND` in
`src/renderer/src/store/alerts.ts`.

**Wake-from-sleep.** A laptop that sleeps eight hours wakes, polls, and fires a
backlog of state transitions at whatever webhook the user configured. Needs a
suppression window on resume — transitions observed in the first N seconds
after a long gap update the panel without notifying.

**Why they waited.** Phase 1 has no alerts at all, which makes the sleep
problem moot rather than merely deferred: a wake just polls and updates rows,
and nothing is sent anywhere.

**Cost:** 1–2 days for alerts, half a day for suppression.

**Ship it when** phase 1 has run long enough to know what a normal failure rate
looks like. An alert that fires constantly is one people turn off.

---

## 3. Shared error taxonomy

CI has more error classes than VPN or tunnels, and phase 1 handles them
individually per adapter rather than through one vocabulary:

`401` · `403`-scope · `403`-rate-limit · `403`-Jenkins-means-everything ·
`404`-real · `404`-hidden-by-permission · `404`-job-still-running · expired ·
untrusted-CA · proxy-stripped-`Authorization` · route-dropped-on-redirect.

`src/main/services/vpn/errors.ts` is the precedent. The value is not tidiness —
it is that the panel can then say *which* of those it hit, instead of relaying
whatever string the provider sent.

Phase 1 does the two that matter most honestly (a Jenkins password mistaken for
a token, and a redirect that lost its route), which is why this could wait.

**Cost:** 1–2 days.

---

## 4. Multi-window

Main broadcasts poll results to every window, which is right: a pipeline that
started failing is a fact about the estate, not about whichever window opened
the panel. What is not addressed is two windows in **different workspaces**
watching the same connection.

**Cost:** half a day, mostly deciding what the correct behaviour is.

---

## 5. Smaller, genuinely optional

- **Per-connection "follow redirects into my private network"**, off by default,
  shown where `insecureTls` is shown. Only if a real GitHub Enterprise report
  arrives: GHES hands job logs to a separate blob host, and if that host is
  reachable only through a bastion, phase 1 cannot fetch it. The error now says
  so by name. Do not ship this pre-emptively — it hands destination selection
  to the remote, which is worse than the flag it resembles.
- **`caPem` on a cross-origin redirect.** Dropped today along with the route.
  It is the weakest link in that decision and the one that breaks people who
  have no bastion at all; revisit it independently of `via` if reports come in.
- **The kill switch enumerating runs from a previous session.** It names runs
  this session started; one started before a restart is unknown to it.
  Reconstructing from the audit log would mean asserting a run is live without
  having checked.

---

## Not in phase 2, and not in any phase

- **Webhooks as a transport.** All three providers support them and all three
  need a publicly reachable endpoint. A desktop app behind NAT cannot receive
  one without a relay. That is a hosted backend, not an optimisation.
- **Creating or editing a CI connection from the AI bridge.** `set_vpn` has no
  authoring counterpart for the same reason: an agent that can author a
  connection can point it at a host it chose and ask the user to paste a token
  into it.
- **Auto-cancelling runs when STOP ALL AI ACCESS is pressed.** The switch stops
  the agent; it does not roll back the estate. Cancelling is itself a
  destructive unapproved action, and a pipeline stopped half-way has done some
  of its work and not the rest.

---

## Suggested order

1. Whatever phase 1 finds against a real server.
2. `cicdTrigger` (§1) — it is built, and it is the feature people asked for.
3. Alerts + wake-from-sleep (§2) — the largest gap a user would notice.
4. Error taxonomy (§3).
5. Multi-window (§4).

§5 is reactive: ship it when somebody reports the thing it fixes.
