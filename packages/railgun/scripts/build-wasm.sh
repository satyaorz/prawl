#!/usr/bin/env bash
# Build kohaku-railgun-wasm (ethereum/kohaku-rs, branch feat/kohaku-railgun)
# into .local/railgun/{web,nodejs}. Nothing here is committed.
#   needs: rust with wasm32-unknown-unknown; installs wasm-bindgen-cli 0.2.108
#   (the version the crate pins) into .local/tools.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
L=$ROOT/.local
SRC=${KOHAKU_SRC:-$L/src/kohaku-rs}
REF=${KOHAKU_REF:-feat/kohaku-railgun}
[ -d "$SRC/.git" ] || git clone --branch "$REF" https://github.com/ethereum/kohaku-rs "$SRC"
[ -x "$L/tools/bin/wasm-bindgen" ] || cargo install wasm-bindgen-cli --version 0.2.108 --locked --root "$L/tools"
cd "$SRC"
cargo build --release --locked --manifest-path crates/Cargo.toml -p kohaku-railgun-wasm \
  --target wasm32-unknown-unknown --target-dir crates/target
WASM=crates/target/wasm32-unknown-unknown/release/kohaku_railgun_wasm.wasm
for t in nodejs web; do "$L/tools/bin/wasm-bindgen" "$WASM" --target $t --out-dir "$L/railgun/$t"; done
echo '{"type":"commonjs"}' > "$L/railgun/nodejs/package.json"
echo "kohaku-rs $(git rev-parse --short HEAD) -> $L/railgun"
ls -l "$L/railgun/web"
