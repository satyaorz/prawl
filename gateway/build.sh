#!/usr/bin/env bash
# Build the tor-js gateway binary (upstream v0.4.4, unchanged) into .local/bin.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
SRC=${TORJS_SRC:-$ROOT/.local/src/tor-js}
if [ ! -d "$SRC/.git" ]; then
  git clone --depth 1 --branch v0.4.4 https://github.com/ethereum/tor-js.git "$SRC"
fi
(cd "$SRC" && cargo build --release -p tor-js-gateway)
mkdir -p "$ROOT/.local/bin"
cp "$SRC/target/release/tor-js-gateway" "$ROOT/.local/bin/"
echo "built $ROOT/.local/bin/tor-js-gateway"
