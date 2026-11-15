#!/bin/sh
# Build reproducible, uncompressed release assets. Run from the repository root.
set -eu
version=${1:?usage: scripts/release-cli.sh VERSION [OUTPUT_DIR]}
case "$version" in ''|*[!0-9A-Za-z.-]*) echo 'Invalid version' >&2; exit 2;; esac
output=${2:-dist/cli/$version}
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
case "$output" in /*) ;; *) output=$root/$output;; esac
mkdir -p "$output"
go_command=${GO:-go}
commit=$(git -C "$root" rev-parse HEAD)
flags="-s -w -X github.com/wistaria/qrtoss/cli/internal/client.Version=$version -X github.com/wistaria/qrtoss/cli/internal/client.Commit=$commit"
if [ -n "${QRTOSS_PUBLIC_ORIGIN:-}" ]; then
 case "$QRTOSS_PUBLIC_ORIGIN" in https://*) ;; *) echo 'QRTOSS_PUBLIC_ORIGIN must be HTTPS' >&2; exit 2;; esac
 case "$QRTOSS_PUBLIC_ORIGIN" in *[![:graph:]]*) echo 'Origin must not contain whitespace' >&2; exit 2;; esac
 flags="$flags -X github.com/wistaria/qrtoss/cli/internal/client.DefaultServer=$QRTOSS_PUBLIC_ORIGIN"
fi
for target in darwin/arm64 darwin/amd64 linux/arm64 linux/amd64; do
 target_os=${target%/*}
 target_arch=${target#*/}
 name=qrtoss_${version}_${target_os}_${target_arch}
 (cd "$root/cli" && CGO_ENABLED=0 GOOS=$target_os GOARCH=$target_arch "$go_command" build -trimpath -buildvcs=false -ldflags "$flags" -o "$output/$name" ./cmd/qrtoss)
done
cp "$root/LICENSE.md" "$output/LICENSE.md"
cp "$root/THIRD_PARTY_NOTICES" "$output/THIRD_PARTY_NOTICES"
node "$root/scripts/release-launcher.mjs" "$output" "$version" "${QRTOSS_DOWNLOAD_BASE_URL:-}"
if [ -n "${QRTOSS_SIGNING_KEY:-}" ]; then
 openssl dgst -sha256 -sign "$QRTOSS_SIGNING_KEY" -out "$output/SHA256SUMS.sig" "$output/SHA256SUMS"
fi
printf 'CLI assets built in %s\n' "$output" >&2
