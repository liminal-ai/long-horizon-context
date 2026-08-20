#!/bin/sh

set -eu

REPOSITORY="${CC_LHC_REPOSITORY:-liminal-ai/long-horizon-context}"
VERSION="${CC_LHC_VERSION:-0.2.0}"
PREFIX="${CC_LHC_PREFIX:-${HOME}/.local}"
STORE="${CC_LHC_INSTALL_ROOT:-${XDG_DATA_HOME:-${HOME}/.local/share}/cc-lhc}"
ASSET_DIR="${CC_LHC_ASSET_DIR:-}"
UNINSTALL=0

usage() {
  cat <<'EOF'
Install a registry-free cc-lhc runtime bundle from GitHub.

Usage: install.sh [OPTIONS]

  --version VERSION    Install a specific release (default: 0.2.0)
  --prefix DIR         Command prefix (default: ~/.local)
  --install-root DIR   Versioned package storage
  --asset-dir DIR      Install from a validated local candidate directory
  --uninstall          Remove the managed launcher and package store
  -h, --help           Show this help

The installer requires Node 24.3 or later and an authenticated Claude Code
CLI. It does not invoke npm or a native compiler. User state under ~/.cc-lhc
is preserved during installation, upgrade, and uninstall.
EOF
}

fail() { printf '%s\n' "cc-lhc installer: $*" >&2; exit 1; }

while [ "$#" -gt 0 ]; do
  case "$1" in
    --version) [ "$#" -ge 2 ] || fail "--version requires a value"; VERSION=$2; shift 2 ;;
    --prefix) [ "$#" -ge 2 ] || fail "--prefix requires a value"; PREFIX=$2; shift 2 ;;
    --install-root) [ "$#" -ge 2 ] || fail "--install-root requires a value"; STORE=$2; shift 2 ;;
    --asset-dir) [ "$#" -ge 2 ] || fail "--asset-dir requires a value"; ASSET_DIR=$2; shift 2 ;;
    --uninstall) UNINSTALL=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) fail "unknown option: $1" ;;
  esac
done

case "$VERSION" in *[!0-9A-Za-z.+-]*|'') fail "invalid version: $VERSION" ;; esac
case "$STORE" in ''|/|"$HOME") fail "refusing unsafe install root: $STORE" ;; esac

BIN_DIR="$PREFIX/bin"
LAUNCHER="$BIN_DIR/cc-lhc"
MARKER="$STORE/.cc-lhc-installer-managed"

if [ "$UNINSTALL" -eq 1 ]; then
  if [ -L "$LAUNCHER" ]; then
    target=$(readlink "$LAUNCHER")
    case "$target" in "$STORE"/*) rm -f -- "$LAUNCHER" ;; *) fail "$LAUNCHER is not managed by this installer" ;; esac
  elif [ -e "$LAUNCHER" ]; then
    fail "$LAUNCHER is not a managed symlink"
  fi
  if [ -d "$STORE" ] && [ ! -f "$MARKER" ]; then
    fail "$STORE is not marked as installer-managed"
  fi
  if [ -d "$STORE" ]; then rm -rf -- "$STORE"; fi
  printf '%s\n' "Removed the managed cc-lhc installation. User state was preserved."
  exit 0
fi

command -v node >/dev/null 2>&1 || fail "Node 24.3 or later is required."
node -e '
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 24 || (major === 24 && minor < 3)) process.exit(1);
' || fail "Node 24.3 or later is required; found $(node --version)."

case "$(uname -s):$(uname -m)" in
  Linux:x86_64|Linux:amd64) TARGET=linux-x64 ;;
  Linux:aarch64|Linux:arm64) TARGET=linux-arm64 ;;
  Darwin:x86_64|Darwin:amd64) TARGET=darwin-x64 ;;
  Darwin:arm64|Darwin:aarch64) TARGET=darwin-arm64 ;;
  *) fail "unsupported platform $(uname -s):$(uname -m)" ;;
esac

if [ -d "$STORE" ] && [ ! -f "$MARKER" ]; then
  fail "$STORE exists but is not marked as installer-managed"
fi
if [ -e "$LAUNCHER" ] || [ -L "$LAUNCHER" ]; then
  if [ ! -L "$LAUNCHER" ]; then fail "$LAUNCHER already exists and is not managed by this installer"; fi
  old_target=$(readlink "$LAUNCHER")
  case "$old_target" in "$STORE"/*) ;; *) fail "$LAUNCHER is not managed by this installer" ;; esac
fi

command -v tar >/dev/null 2>&1 || fail "tar is required."
if command -v sha256sum >/dev/null 2>&1; then
  sha256_file() { sha256sum "$1" | awk '{print $1}'; }
elif command -v shasum >/dev/null 2>&1; then
  sha256_file() { shasum -a 256 "$1" | awk '{print $1}'; }
else
  fail "sha256sum or shasum is required."
fi

BUNDLE_NAME="cc-lhc-v${VERSION}-${TARGET}"
ASSET="${BUNDLE_NAME}.tar.gz"
BASE="https://github.com/${REPOSITORY}/releases/download/cc-lhc-v${VERSION}"
INSTALL_TMP=$(mktemp -d "${TMPDIR:-/tmp}/cc-lhc-install.XXXXXX")
cleanup() {
  case "$INSTALL_TMP" in "${TMPDIR:-/tmp}"/cc-lhc-install.*) rm -rf -- "$INSTALL_TMP" ;; esac
}
trap cleanup EXIT HUP INT TERM

if [ -n "$ASSET_DIR" ]; then
  [ -f "$ASSET_DIR/$ASSET" ] || fail "candidate directory is missing $ASSET"
  [ -f "$ASSET_DIR/SHA256SUMS" ] || fail "candidate directory is missing SHA256SUMS"
  cp -- "$ASSET_DIR/$ASSET" "$INSTALL_TMP/$ASSET"
  cp -- "$ASSET_DIR/SHA256SUMS" "$INSTALL_TMP/SHA256SUMS"
else
  command -v curl >/dev/null 2>&1 || fail "curl is required."
  curl --fail --silent --show-error --location "$BASE/$ASSET" --output "$INSTALL_TMP/$ASSET"
  curl --fail --silent --show-error --location "$BASE/SHA256SUMS" --output "$INSTALL_TMP/SHA256SUMS"
fi

expected=$(awk -v name="$ASSET" '$2 == name { print $1 }' "$INSTALL_TMP/SHA256SUMS")
[ -n "$expected" ] || fail "SHA256SUMS does not list $ASSET"
actual=$(sha256_file "$INSTALL_TMP/$ASSET")
[ "$actual" = "$expected" ] || fail "checksum mismatch for $ASSET"

tar -xzf "$INSTALL_TMP/$ASSET" -C "$INSTALL_TMP"
BUNDLE="$INSTALL_TMP/$BUNDLE_NAME"
[ -f "$BUNDLE/release-manifest.json" ] || fail "archive is missing release-manifest.json"
[ -f "$BUNDLE/package/dist/bin.js" ] || fail "archive is missing the cc-lhc entrypoint"

node -e '
  const fs = require("node:fs");
  const [path, version, target] = process.argv.slice(1);
  const manifest = JSON.parse(fs.readFileSync(path, "utf8"));
  if (manifest.schemaVersion !== 1 || manifest.product !== "cc-lhc" ||
      manifest.version !== version || manifest.target !== target ||
      manifest.entrypoint !== "package/dist/bin.js") process.exit(1);
' "$BUNDLE/release-manifest.json" "$VERSION" "$TARGET" || fail "release manifest identity mismatch"

CC_LHC_NATIVE_REQUIRE_ADDON=1 node "$BUNDLE/package/dist/bin.js" --lhc-help >/dev/null || \
  fail "downloaded runtime verification failed"

mkdir -p "$STORE/versions" "$BIN_DIR"
printf '%s\n' "managed by cc-lhc install.sh" > "$MARKER"
DEST="$STORE/versions/${VERSION}-${TARGET}"
STAGE="$STORE/versions/.${VERSION}-${TARGET}.tmp.$$"
rm -rf -- "$STAGE"
mkdir -p "$STAGE"
cp -R "$BUNDLE/." "$STAGE/"
chmod 0755 "$STAGE/package/dist/bin.js"
rm -rf -- "$DEST"
mv "$STAGE" "$DEST"
ln -sfn "$DEST" "$STORE/current"
ln -sfn "$STORE/current/package/dist/bin.js" "$LAUNCHER"

CC_LHC_NATIVE_REQUIRE_ADDON=1 "$LAUNCHER" --lhc-help >/dev/null || fail "installed launcher verification failed"

printf '%s\n' "Installed cc-lhc ${VERSION} for ${TARGET}."
printf '%s\n' "Command: $LAUNCHER"
if ! command -v cc-lhc >/dev/null 2>&1; then
  printf '%s\n' "Add $BIN_DIR to PATH before starting cc-lhc."
fi
