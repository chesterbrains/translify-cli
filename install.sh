#!/bin/sh
# Install the translify CLI binary. Usage:
#   curl -fsSL https://github.com/chesterbrains/translify-cli/releases/latest/download/install.sh | sh
# Env: TRANSLIFY_INSTALL_DIR (default ~/.local/bin), TRANSLIFY_VERSION (default latest, e.g. v0.1.0).
set -eu

main() {
  REPO="chesterbrains/translify-cli"
  DIR="${TRANSLIFY_INSTALL_DIR:-$HOME/.local/bin}"
  VERSION="${TRANSLIFY_VERSION:-latest}"

  os=$(uname -s | tr '[:upper:]' '[:lower:]')
  arch=$(uname -m)
  case "$arch" in
    x86_64|amd64) arch=x64 ;;
    arm64|aarch64) arch=arm64 ;;
    *) echo "Unsupported architecture: $arch (supported: x64, arm64)" >&2; exit 1 ;;
  esac
  case "$os" in
    linux|darwin) ;;
    *) echo "Unsupported OS: $os (on Windows, download translify-windows-x64.exe from https://github.com/$REPO/releases)" >&2; exit 1 ;;
  esac

  asset="translify-$os-$arch"
  if [ "$VERSION" = "latest" ]; then
    base="https://github.com/$REPO/releases/latest/download"
  else
    base="https://github.com/$REPO/releases/download/$VERSION"
  fi

  if command -v sha256sum >/dev/null 2>&1; then
    hash_file() { sha256sum "$1" | cut -d' ' -f1; }
  elif command -v shasum >/dev/null 2>&1; then
    hash_file() { shasum -a 256 "$1" | cut -d' ' -f1; }
  else
    echo "Neither sha256sum nor shasum found; cannot verify the download, so nothing was installed." >&2
    exit 1
  fi

  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT

  curl --proto '=https' --tlsv1.2 -fsSL "$base/$asset" -o "$tmp/$asset"
  curl --proto '=https' --tlsv1.2 -fsSL "$base/SHA256SUMS" -o "$tmp/SHA256SUMS"

  expected=$(grep " $asset\$" "$tmp/SHA256SUMS" | cut -d' ' -f1 || true)
  actual=$(hash_file "$tmp/$asset")
  if [ -z "$expected" ] || [ "$expected" != "$actual" ]; then
    echo "Checksum verification failed for $asset; nothing was installed." >&2
    exit 1
  fi

  mkdir -p "$DIR"
  install -m 0755 "$tmp/$asset" "$DIR/translify"
  echo "Installed translify to $DIR/translify"
  case ":$PATH:" in
    *":$DIR:"*) ;;
    *) echo "Add $DIR to your PATH, e.g.: export PATH=\"$DIR:\$PATH\"" ;;
  esac
}

main "$@"
