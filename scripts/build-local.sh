#!/bin/sh

set -eu

cd "$(dirname "$0")/.."

# Detect current platform
ARCH=$(uname -m)
OS=$(uname -s)

case "$OS" in
  Darwin)  BUN_OS="darwin" ;;
  Linux)   BUN_OS="linux" ;;
  MINGW*|MSYS*|CYGWIN*)  BUN_OS="windows" ;;
  *)       echo "Unsupported OS: $OS" >&2; exit 1 ;;
esac

case "$ARCH" in
  arm64|aarch64)  BUN_ARCH="arm64" ;;
  x86_64|x64)     BUN_ARCH="x64" ;;
  *)              echo "Unsupported architecture: $ARCH" >&2; exit 1 ;;
esac

TARGET="bun-${BUN_OS}-${BUN_ARCH}"
OUTFILE="dist/container"
[ "$BUN_OS" = "windows" ] && OUTFILE="dist/container.exe"

echo "Building for ${BUN_OS}-${BUN_ARCH}..."
bun build --compile --target="$TARGET" --outfile="$OUTFILE" src/main.ts
echo "Built: $OUTFILE"
