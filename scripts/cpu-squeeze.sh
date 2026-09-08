#!/usr/bin/env bash
#
# Run a command under deliberate CPU contention, so a test that only fails on a
# loaded 2-core CI runner can be reproduced on a developer machine.
#
# WHY THIS EXISTS
#
# The obvious way to do this is three lines typed straight into a shell:
#
#   for i in $(seq 1 12); do (while :; do :; done) & done
#   LOADPIDS=$(jobs -p)
#   npm test; kill $LOADPIDS
#
# That is what was actually run during a v0.26.0 debugging session, and the
# last line never executed — the parent shell went away first. The twelve
# busy-loops reparented to init and ran for TWENTY HOURS on a 12-core machine,
# holding the load average between 75 and 130. Everything measured on that
# machine in the meantime was measured wrong: the session that inherited the
# box spent an hour chasing a "flaky" test that was only ever losing a
# collection-phase timeout to 7x CPU oversubscription. There was no test bug.
#
# So the load here is bounded THREE ways, because the failure mode is not the
# command failing — it is this script's own death:
#
#   1. A trap on EXIT/INT/TERM/HUP. Covers the ordinary cases, including
#      Ctrl-C. Does NOT cover SIGKILL, which is what actually happened.
#   2. A watchdog that outlives us. It is orphaned to init along with the
#      workers and still kills them, so SIGKILL to this script costs at most
#      the remaining timeout rather than twenty hours.
#   3. A hard ceiling on --timeout itself, so a fat-fingered value cannot ask
#      for a leak measured in days.
#
# Layer 2 is the one that matters. A trap alone would not have prevented the
# incident above.
#
# USAGE
#
#   scripts/cpu-squeeze.sh -- npx vitest run tests/access.test.ts
#   scripts/cpu-squeeze.sh -n 12 -t 300 -- npm test
#   scripts/cpu-squeeze.sh -t 60            # load only, then expire
#
# The command's exit status is this script's exit status, so it drops into a
# pipeline unchanged.

set -uo pipefail

readonly MAX_TIMEOUT=1800 # 30 min. Nothing legitimate needs contention longer.

workers=""
timeout=600
load_pids=()
watchdog_pid=""

usage() {
  sed -n '/^# USAGE/,/^$/p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-2}"
}

# The number of workers that saturates this box. One per core is what produces
# CI-like contention; the original incident used 12 on a 12-core machine.
ncpu() {
  getconf _NPROCESSORS_ONLN 2>/dev/null ||
    sysctl -n hw.ncpu 2>/dev/null ||
    nproc 2>/dev/null ||
    echo 4
}

# Kill the load, and tolerate every PID already being gone — this runs from the
# EXIT trap, so it must be safe to call twice.
#
# SIGTERM first, but do not trust it: during the incident above, SIGTERM did
# not interrupt the tight `while :; do :; done` loops at all and only SIGKILL
# ended them. A process that ignores the polite signal is exactly the process
# that must not survive this function.
kill_load() {
  local pid
  [[ ${#load_pids[@]} -eq 0 ]] && return 0
  for pid in "${load_pids[@]}"; do
    kill -TERM "$pid" 2>/dev/null
  done
  # Give TERM a moment, then insist.
  local waited=0
  while ((waited < 20)); do
    local alive=0
    for pid in "${load_pids[@]}"; do
      kill -0 "$pid" 2>/dev/null && alive=1
    done
    ((alive == 0)) && break
    sleep 0.1
    ((waited++))
  done
  for pid in "${load_pids[@]}"; do
    kill -KILL "$pid" 2>/dev/null
  done
  load_pids=()
}

cleanup() {
  local status=$?
  trap - EXIT INT TERM HUP
  [[ -n $watchdog_pid ]] && kill -KILL "$watchdog_pid" 2>/dev/null
  kill_load
  exit "$status"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -n | --workers)
      workers="${2:-}"
      shift 2
      ;;
    -t | --timeout)
      timeout="${2:-}"
      shift 2
      ;;
    -h | --help) usage 0 ;;
    --)
      shift
      break
      ;;
    *)
      echo "cpu-squeeze: unknown argument: $1" >&2
      usage
      ;;
  esac
done

[[ -z $workers ]] && workers="$(ncpu)"

if ! [[ $workers =~ ^[0-9]+$ ]] || ((workers < 1)); then
  echo "cpu-squeeze: --workers must be a positive integer, got: $workers" >&2
  exit 2
fi
if ! [[ $timeout =~ ^[0-9]+$ ]] || ((timeout < 1)); then
  echo "cpu-squeeze: --timeout must be a positive integer, got: $timeout" >&2
  exit 2
fi
if ((timeout > MAX_TIMEOUT)); then
  echo "cpu-squeeze: --timeout is capped at ${MAX_TIMEOUT}s, got: $timeout" >&2
  exit 2
fi

trap cleanup EXIT INT TERM HUP

for ((i = 0; i < workers; i++)); do
  while :; do :; done &
  load_pids+=("$!")
  # Detach from the job table so the shell does not print a death notice for
  # each worker over the wrapped command's output. Killing by PID is
  # unaffected.
  disown "$!" 2>/dev/null
done

# The watchdog is deliberately a separate process holding its own copy of the
# PIDs. If this script is SIGKILLed, the trap never runs, but the watchdog is
# orphaned to init exactly as the workers are — and it still fires.
(
  sleep "$timeout"
  for pid in "${load_pids[@]}"; do
    kill -KILL "$pid" 2>/dev/null
  done
) &
watchdog_pid=$!
disown "$watchdog_pid" 2>/dev/null

echo "cpu-squeeze: ${workers} workers, expiring after ${timeout}s" >&2

if [[ $# -eq 0 ]]; then
  # No command: hold the load until the timeout, so `-t 60` alone is a way to
  # load the machine while something else is driven by hand.
  sleep "$timeout"
  exit 0
fi

"$@"
