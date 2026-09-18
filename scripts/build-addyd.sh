#!/usr/bin/env bash
#
# Cross-compile the addy sidecar into resources/bin/<platform-arch>/.
#
# WHAT BREAKS IF CI SKIPS THIS: a missing directory is silent at package time.
# It only surfaces at runtime, as every addy operation reporting that its binary
# is missing -- which is the same failure mode the VPN engines already learned
# once, and the reason verify-bin-manifest.mjs is a hard gate in the release
# workflow rather than a warning.
#
# TWO ROLES, ONE BINARY. addyd runs as --crypto or --rtc and the parent spawns
# both. The split is not a packaging detail: the crypto half holds the account
# key and never links a WebRTC stack, because a stack that parses untrusted SDP,
# STUN, DTLS and SRTP off the open internet should not be LOADED in a process
# holding keys. One binary means one manifest row per platform instead of two,
# and the roles are a flag.
#
# CGO_ENABLED=0 is load-bearing, as it is for netd: it is what makes this a loop
# in a shell script rather than six C toolchains.
#
# -trimpath and an empty -buildid are what make the recorded SHA-256 mean
# anything -- without them the hash changes with the checkout path and the build
# machine, and a checksum nobody can reproduce is decoration.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/sidecar/addyd"
OUT_ROOT="$ROOT/resources/bin"

# The sidecar version tracks the app version, so a bug report naming one names
# the other.
VERSION="${OPSMAXX_ADDYD_VERSION:-$(node -p "require('$ROOT/package.json').version" 2>/dev/null || echo '0.0.0-dev')}"
BUILD_SHA="${OPSMAXX_ADDYD_SHA:-$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)}"

# The same six pairs build-sidecar.sh uses. The right-hand names are what
# process.platform/process.arch produce AND what electron-builder's
# ${platform}-${arch} expands to, so the lookup path is identical in a dev
# checkout and in a packaged app.
TARGETS=(
  "darwin  amd64  darwin-x64"
  "darwin  arm64  darwin-arm64"
  "linux   amd64  linux-x64"
  "linux   arm64  linux-arm64"
  "windows amd64  win32-x64"
  "windows arm64  win32-arm64"
)

single="${1:-}"

command -v go >/dev/null || { echo "build-addyd.sh: go is not on PATH" >&2; exit 1; }
command -v node >/dev/null || { echo "build-addyd.sh: node is not on PATH" >&2; exit 1; }

echo "addyd $VERSION ($BUILD_SHA)"

# Vet and test BEFORE building. A red test should fail the run rather than
# produce an artifact nobody checked -- and one of these tests is the Go/TS
# error-code parity check, which is exactly the kind of drift that is invisible
# until a user sees an error the renderer has no case for.
( cd "$SRC" && go vet ./... && go test ./... )

built=0
for entry in "${TARGETS[@]}"; do
  read -r goos goarch nodedir <<<"$entry"
  if [ -n "$single" ] && [ "$single" != "$nodedir" ]; then
    continue
  fi

  exe=""
  [ "$goos" = "windows" ] && exe=".exe"
  dest="$OUT_ROOT/$nodedir"
  mkdir -p "$dest"

  echo "  building $nodedir"
  ( cd "$SRC" && \
    CGO_ENABLED=0 GOOS="$goos" GOARCH="$goarch" \
    go build -trimpath \
      -ldflags "-s -w -buildid= -X main.Version=$VERSION -X main.BuildSha=$BUILD_SHA" \
      -o "$dest/opsmaxx-addyd$exe" . )
  built=$((built + 1))
done

if [ -n "$single" ] && [ "$built" -eq 0 ]; then
  echo "build-addyd.sh: no target matches '$single'" >&2
  printf '  %s\n' "${TARGETS[@]}" >&2
  exit 2
fi
if [ -z "$single" ] && [ "$built" -ne "${#TARGETS[@]}" ]; then
  echo "build-addyd.sh: built $built of ${#TARGETS[@]} targets" >&2
  exit 1
fi

# Enumerate what actually linked rather than what somebody remembered.
mkdir -p "$ROOT/resources/licenses/opsmaxx-addyd"
{
  echo "opsmaxx-addyd $VERSION ($BUILD_SHA)"
  echo
  echo "Go modules linked into this binary:"
  ( cd "$SRC" && go list -m all 2>/dev/null | sed 's/^/  /' )
} > "$ROOT/resources/licenses/opsmaxx-addyd/VERSION"

# Prove the binary for THIS machine runs. A cross-compiled artifact that cannot
# execute is caught here rather than by the first person to launch the app.
host="$OUT_ROOT/$(node -p 'process.platform + "-" + process.arch')/opsmaxx-addyd"
[ "$(node -p 'process.platform')" = "win32" ] && host="$host.exe"
if [ -x "$host" ]; then
  echo -n "  smoke: "
  "$host" --version | node -e '
    let s = ""
    process.stdin.on("data", (d) => (s += d))
    process.stdin.on("end", () => {
      const v = JSON.parse(s)
      if (!v.version || !v.goVersion) throw new Error("addyd --version is missing fields")
      console.log(`${v.version} (${v.buildSha}) ${v.goVersion}`)
    })'
fi

OPSMAXX_ADDYD_VERSION="$VERSION" node "$ROOT/scripts/update-bin-manifest.mjs" opsmaxx-addyd
