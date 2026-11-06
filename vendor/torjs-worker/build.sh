#!/usr/bin/env bash
# Build Prawl's tor-js worker: upstream tor-js v0.4.4 plus keepalive.patch.
#
# The patch adds a per-(isolation key, origin) keep-alive connection pool to the
# worker's fetch (idle cap 8, 4 minute maximum connection age), a 5 s
# response-head deadline for replayable requests on a reused connection (resent
# once on a fresh connection under the same key), never pools writes, and
# forwards the Tor error kind in error names. Isolation is unchanged: a pooled
# connection is only ever reused under the key that opened it.
#
# Needs: rust (wasm32-unknown-unknown), wasm-bindgen-cli 0.2.128, wasm-opt
# (binaryen), node. The output is not byte-reproducible against upstream
# releases; its keccak is printed and must match WORKER_BUILDS in
# packages/anon-rpc/src/worker-choice.ts to be loaded.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
HERE=$ROOT/vendor/torjs-worker
SRC=${TORJS_FORK_SRC:-$ROOT/.local/src/tor-js-fork}
WASM_BINDGEN=${WASM_BINDGEN:-wasm-bindgen}
OUT=$ROOT/.local/worker

if [ ! -d "$SRC/.git" ]; then
  git clone --depth 1 --branch v0.4.4 https://github.com/ethereum/tor-js.git "$SRC"
  (cd "$SRC" && git apply "$HERE/keepalive.patch")
fi
cd "$SRC"
[ -d node_modules ] || npm ci

RUST_SYSROOT="$(rustc --print sysroot)"
RUSTC_COMMIT="$(rustc -vV | sed -ne 's/^commit-hash: //p')"
export RUSTFLAGS="--remap-path-prefix=${CARGO_HOME:-$HOME/.cargo}=/cargo-home --remap-path-prefix=$RUST_SYSROOT/lib/rustlib/src/rust=/rustc/$RUSTC_COMMIT"
export TOR_JS_WORKSPACE_ROOT="$PWD"
export RUSTC_WRAPPER="$PWD/scripts/reproducible-rustc.sh"

cargo build -p tor-js --lib --release --target wasm32-unknown-unknown --locked
rm -rf crates/tor-js-wasm/pkg
"$WASM_BINDGEN" target/wasm32-unknown-unknown/release/tor_js.wasm --target web --typescript --out-dir crates/tor-js-wasm/pkg
wasm-opt crates/tor-js-wasm/pkg/tor_js_bg.wasm -o crates/tor-js-wasm/pkg/tor_js_bg.wasm \
  -Oz --enable-bulk-memory --enable-nontrapping-float-to-int

node --input-type=module -e "
const m = await import('$SRC/build.mjs');
await m.buildAnonRpcWorker({ outfile: '$SRC/dist/anon-rpc-worker.js' });
"
mkdir -p "$OUT"
HASH=$(node "$ROOT/scripts/keccak-file.mjs" "$SRC/dist/anon-rpc-worker.js")
cp "$SRC/dist/anon-rpc-worker.js" "$OUT/anon-rpc-worker-$HASH.js"
echo "worker: $OUT/anon-rpc-worker-$HASH.js"
