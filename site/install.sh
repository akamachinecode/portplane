#!/bin/sh
# Installs the portplane command line on macOS or Linux:
#   curl -fsSL https://akamachinecode.github.io/portplane/install.sh | sh
# PORTPLANE_VERSION=v0.2.0 picks a release; PORTPLANE_INSTALL_DIR picks the
# folder (default ~/.local/bin). The archive is checked against the
# release's checksums.txt, and against its cosign signature when a working
# cosign is installed (PORTPLANE_SKIP_SIGNATURE=1 skips that check).
set -eu

repo="akamachinecode/portplane"
dir="${PORTPLANE_INSTALL_DIR:-$HOME/.local/bin}"
tag="${PORTPLANE_VERSION:-}"

say() { printf '%s\n' "$*"; }
die() { printf 'portplane install: %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "$1 is required"; }

need curl
need tar
need uname

case "$(uname -s)" in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  *) die "unsupported OS $(uname -s); on Windows use install.ps1" ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) arch=amd64 ;;
  arm64 | aarch64) arch=arm64 ;;
  *) die "unsupported architecture $(uname -m)" ;;
esac
# A shell running through Rosetta on an Apple silicon Mac says x86_64:
# the arm64 build is the one that runs natively.
if [ "$os" = darwin ] && [ "$arch" = amd64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null)" = 1 ]; then
  arch=arm64
fi

if [ -z "$tag" ]; then
  tag=$(curl -fsSL "https://api.github.com/repos/$repo/releases/latest" | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -n 1)
  [ -n "$tag" ] || die "could not find the latest release"
fi
version="${tag#v}"
archive="portplane_${version}_${os}_${arch}.tar.gz"
base="https://github.com/$repo/releases/download/$tag"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT INT TERM

say "Downloading Portplane $tag for $os/$arch"
curl -fsSL -o "$tmp/$archive" "$base/$archive" || die "download failed: $base/$archive"
curl -fsSL -o "$tmp/checksums.txt" "$base/checksums.txt" || die "could not download checksums.txt"

expected=$(awk -v f="$archive" '$2 == f { print $1 }' "$tmp/checksums.txt")
[ -n "$expected" ] || die "$archive is not listed in checksums.txt"
if command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "$tmp/$archive" | cut -d' ' -f1)
else
  actual=$(shasum -a 256 "$tmp/$archive" | cut -d' ' -f1)
fi
[ "$expected" = "$actual" ] || die "checksum mismatch for $archive"
say "Checksum OK"

# A version manager can leave a cosign shim on the PATH that does not run
# (mise or asdf with no version set). That counts as no cosign.
if [ -n "${PORTPLANE_SKIP_SIGNATURE:-}" ]; then
  say "Signature not checked (PORTPLANE_SKIP_SIGNATURE is set)"
elif command -v cosign >/dev/null 2>&1; then
  if cosign version >/dev/null 2>&1; then
    curl -fsSL -o "$tmp/checksums.txt.sigstore.json" "$base/checksums.txt.sigstore.json" || die "could not download the signature"
    if ! cosign verify-blob --bundle "$tmp/checksums.txt.sigstore.json" \
      --certificate-identity-regexp "^https://github.com/$repo/" \
      --certificate-oidc-issuer https://token.actions.githubusercontent.com \
      "$tmp/checksums.txt" >"$tmp/cosign.log" 2>&1; then
      sed 's/^/  /' "$tmp/cosign.log" >&2
      die "cosign could not verify checksums.txt (see above). An old cosign or a network that blocks sigstore.dev can cause this: update cosign to v2.5 or later, or set PORTPLANE_SKIP_SIGNATURE=1 to install with the checksum check only"
    fi
    say "Signature OK"
  else
    say "Signature not checked: cosign is on your PATH but does not run ($(command -v cosign))"
  fi
fi

tar -xzf "$tmp/$archive" -C "$tmp" portplane
mkdir -p "$dir"
mv "$tmp/portplane" "$dir/portplane"
chmod 755 "$dir/portplane"
say "Installed $dir/portplane"

# Linux: the Portplane window is a second binary next to the first. It needs
# WebKitGTK 6.0; without it the UI opens in the browser.
if [ "$os" = linux ] && tar -xzf "$tmp/$archive" -C "$tmp" portplane-window 2>/dev/null; then
  mv "$tmp/portplane-window" "$dir/portplane-window"
  chmod 755 "$dir/portplane-window"
  say "Installed $dir/portplane-window"
  if ! { ldconfig -p 2>/dev/null || /sbin/ldconfig -p 2>/dev/null; } | grep -q 'libwebkitgtk-6\.0\.so\.4'; then
    say "For the Portplane window, install WebKitGTK 6.0 (Fedora: sudo dnf install webkitgtk6.0; Debian, Ubuntu: sudo apt install libwebkitgtk-6.0-4). Until then the UI opens in your browser."
  fi
fi

case ":$PATH:" in
  *":$dir:"*) ;;
  *)
    case "$(basename "${SHELL:-sh}")" in
      zsh) rc="~/.zshrc" ;;
      bash) if [ "$os" = darwin ]; then rc="~/.bash_profile"; else rc="~/.bashrc"; fi ;;
      fish) rc="" ;;
      *) rc="~/.profile" ;;
    esac
    if [ -z "$rc" ]; then
      say "Add $dir to your PATH: fish_add_path $dir"
    else
      say "Add $dir to your PATH: echo 'export PATH=\"$dir:\$PATH\"' >> $rc  (then open a new terminal)"
    fi
    ;;
esac
say ""
say "Next: portplane folders add ~/code && portplane"
