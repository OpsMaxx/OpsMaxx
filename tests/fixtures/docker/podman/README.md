# Podman (roadmap item 41's stated proof gap)

## Provenance

Recorded from **podman 5.8.4**, running in a privileged container on the test host,
through the commands `shared/docker.ts` already builds. The containers were removed
afterwards.

| File | Command |
|---|---|
| `system-df.txt` | `buildDockerDiskCommand()` |
| `system-df-v.txt` | `buildDockerDiskDetailCommand()` |
| `removals.txt` | `podman rmi` / `podman rm` / `podman volume rm`, with their exit codes |

State was four containers (running, exited, created, paused), two images and one
volume attached to a running container.

## What held

`shared/docker.ts` was written anticipating podman — it avoids `--format` because
the two engines disagree about field names, and resolves the `podman` binary as a
fallback. That anticipation held for almost everything: both `system df` and
`system df -v` parse on every column, including `Local Volumes`, the one type name
containing a space. Podman emits **no `Build Cache` row**; the parser reads a list
rather than a fixed set, so its absence is simply three rows.

## What did not, and the bug it found

**Docker's `system df -v` STATUS column writes `Up 2 hours`; podman's writes the
bare state — `running`, `exited`, `created`.** `exited` and `created` matched the
existing branches by luck, because the word is the same either way. **`running`
matched nothing, so every running container on a podman host read as `unknown`.**

**What that was not:** an unsafe action. The reclaim preview withheld those
containers anyway, with the reason *"its state could not be read"* — it refuses
what it cannot read. So this was a wrong label, not a container offered for
deletion, and the design's defensive default is what made the difference. The test
pins that separately, so the safety does not depend on the parse being right.

Two independent guards keep a running container out of the offered list, which was
established by mutation rather than assumed: removing the running-branch `continue`
alone changes nothing, because `running` is not in `RECLAIMABLE_CONTAINER_STATES`
either. Removing **both** offers a running container.

## `podman volume rm` differs and cannot be reached

An in-use volume fails with **exit 2** and *"volume is being used by the following
container(s)"*, where docker exits 1 with *"volume is in use"*. Nothing consumes
that difference: rule 1 of the reclaim selection never offers a volume with
`LINKS > 0`, and podman reports `LINKS` in the same column docker does. The fixture
records it so the next person does not have to rediscover it.

## `podman compose` is not an implementation — and its provider leaks

`compose-provider.txt`, measured on podman 5.8.4 with podman-compose 1.6.0.

`podman compose` looks up an **external provider** and runs that. Two outcomes,
which mean different things:

* **No provider** — `Error: looking up compose provider failed`, **exit 125**. That
  is compose being absent, and it is classified as `compose-unavailable`.
* **A provider** — every command, successful ones included, is prefixed with
  `>>>> Executing external compose provider "/usr/bin/podman-compose" <<<<`,
  wrapped in ANSI escapes that `--no-ansi` does **not** remove.

**THE FINDING IS A CREDENTIAL ONE.** `shared/compose.ts` exists because `docker
compose config` resolves `${SECRET}` out of `.env` and prints it, and the entire
module is built on `--no-interpolate --no-env-resolution` making that impossible.
**podman-compose rejects both flags** — exit 2, a usage error — and plain `podman
compose config` printed the project's `.env` password in plaintext. The fixture
records it (`SECRET: hunter2`, a dummy written for the measurement).

So a podman host with a compose provider is **refused**, like docker-compose v1 and
for a stronger reason: reading these projects would mean choosing between an
unverified command line and a credential dump. The refusal fires on the **banner**,
not on a failure — podman prints it on successful commands too, and a `config` that
leaked a password would otherwise be read as a project this build can show.

## Rootless podman

`system-df-rootless.txt`, measured as the `podman` user: `Host.Security.Rootless` is
true and storage moves to `$HOME/.local/share/containers/storage`, but **the
`system df` table is unchanged**, which is the only thing this build reads. The
earlier caveat about rootless is closed.

## What could not be captured

* **A paused container as a distinct state.** `podman system df -v` reports a paused
  container as `running`; only `podman ps` distinguishes it. So the df path cannot
  see `paused`, and nothing here claims it can.
* **A podman host whose provider is docker-compose v2.** `podman compose` would then
  be v2 and the safe flags would work — but no such host was available, so it is not
  claimed. Such a host is refused today along with the podman-compose case, which is
  the safe direction to be wrong in.
