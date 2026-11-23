#!/usr/bin/env bash
#
# Build frpc (the frp client) from pinned upstream source for the HOST platform,
# for the nightly real-engine test (.github/workflows/vpn-e2e.yml) only.
#
# OpsMaxx does not ship frpc. Every antivirus flags it as a hacktool, which got
# the installers quarantined, so frp is an engine the user installs themselves.
# This binary is test infrastructure: it is written to $FRPC_OUT (default
# .frp-build/bin/), never to resources/bin, so electron-builder cannot pick it
# up. tests/vpnEngines.e2e.test.ts reads it from the same place, or from
# $FRPC_PATH.
set -euo pipefail

FRP_VERSION="${FRP_VERSION:-v0.71.0}"
FRP_REPO="https://github.com/fatedier/frp.git"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="${FRP_WORKDIR:-$ROOT/.frp-build}"
OUT="${FRPC_OUT:-$WORK/bin}"

# Retries for every step below that reaches the network; see the file itself
# for why these are shared rather than duplicated.
. "$ROOT/scripts/lib/net-retry.sh"

command -v go >/dev/null 2>&1 || { echo "go toolchain not found" >&2; exit 1; }
command -v git >/dev/null 2>&1 || { echo "git not found" >&2; exit 1; }

if [ ! -d "$WORK/frp/.git" ]; then
  echo "==> cloning frp $FRP_VERSION"
  mkdir -p "$WORK"
  retry_network "cloning frp" clone_pinned "$WORK/frp" "$FRP_REPO" "$FRP_VERSION"
else
  echo "==> reusing $WORK/frp"
  retry_network "fetching frp $FRP_VERSION" git -C "$WORK/frp" fetch --depth 1 origin "$FRP_VERSION"
  git -C "$WORK/frp" checkout -q FETCH_HEAD
fi

SRC_SHA="$(git -C "$WORK/frp" rev-parse HEAD)"
echo "==> frp source $FRP_VERSION ($SRC_SHA)"

# frpc embeds its admin dashboard with `//go:embed dist`, and an embed pattern
# that matches nothing is a compile error — upstream builds those assets with a
# separate Vue toolchain and only ships them in release tarballs. OpsMaxx
# drives frpc through its HTTP API (/api/*, /healthz), which is registered
# independently of the static asset routes, so the dashboard is dead weight
# here. A placeholder satisfies the embed without pulling a JS build into this
# script, and anyone who opens the dashboard by hand gets an explanation rather
# than a blank page.
if [ ! -f "$WORK/frp/web/frpc/dist/index.html" ]; then
  echo "==> stubbing the frpc dashboard assets"
  mkdir -p "$WORK/frp/web/frpc/dist"
  cat > "$WORK/frp/web/frpc/dist/index.html" <<'HTML'
<!doctype html>
<meta charset="utf-8">
<title>frpc</title>
<p>This frpc was built by OpsMaxx, which uses the frpc HTTP API and does not
build the dashboard assets. The API under /api and /healthz is unaffected.</p>
HTML
fi

prefetch_modules "$WORK/frp" ./cmd/frpc

mkdir -p "$OUT"
exe="$(go env GOEXE)"
echo "==> frpc $(go env GOOS)/$(go env GOARCH) -> $OUT/frpc$exe"
( cd "$WORK/frp" && \
  CGO_ENABLED=0 go build -trimpath \
    -ldflags "-s -w -buildid= -X github.com/fatedier/frp/pkg/util/version.version=${FRP_VERSION#v}" \
    -o "$OUT/frpc$exe" ./cmd/frpc )

echo "done."
