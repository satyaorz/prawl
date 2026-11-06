#!/usr/bin/env bash
# Copy the offline-pay code from the local research tree into offline/ so git tracks it.
# Allowlist only: source, tests, build scripts. Never keystores, run logs, phone data
# (attestation chains, relay payments, linkability captures) or generated fixtures.
# Phone adb serials are replaced by required env vars.
set -euo pipefail
cd "$(dirname "$0")/.."
main=$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")
SRC=${PRAWL_OFFLINE_SRC:-"$main/research_notes/Solving offline double spending/raw"}
DST=offline
[ -d "$SRC" ] || { echo "no research tree at $SRC" >&2; exit 1; }

common=(--exclude='__pycache__/' --exclude='.venv/' --exclude='*.keystore' --exclude='*.jks'
  --exclude='*.log' --exclude='*.out' --exclude='out/' --exclude='cache/' --exclude='build*/'
  --exclude='broadcast/' --exclude='fixtures/' --exclude='target/')

# copy <from> <to> <include patterns...>
copy() {
  local from=$1 to=$2; shift 2
  local inc=(--include='*/')
  for p in "$@"; do inc+=(--include="$p"); done
  mkdir -p "$DST/$to"
  rsync -a --delete --prune-empty-dirs "${common[@]}" "${inc[@]}" --exclude='*' "$SRC/$from/" "$DST/$to/"
}

A=seam_a_uncopyable
# Android app (one-time attested keys, wallet v2, Bluetooth transfer) and the phone test scripts.
copy "$A/android_test" android '/src/***' '/assets/***' '/AndroidManifest.xml' '/*.sh'
# On-chain settlement of real phone payment chains (P256VERIFY, attestation, device bonds).
copy "$A/onchain_real" contracts '/src/***' '/test/***' '/script/***' '/tools/*.py' '/tools/*.sh' \
  '/lib/nitro-validator/***' '/lib/solarity/***' '/foundry.toml' '/run_all.sh'
# Protocol v3: spec, deployments, escrow with splitting + Sepolia deposit/redeem tooling (no logs, fixtures, phone vectors).
copy v3/escrow_v3 contracts-v3 '/src/***' '/test/***' '/script/***' '/tools/*.py' '/tools/*.sh' \
  '/lib/nitro-validator/***' '/foundry.toml' '/run_all.sh'
rsync -a "$SRC/v3/SPEC.md" "$DST/SPEC-v3.md"
rsync -a "$SRC/v3/DEPLOYMENTS.md" "$DST/DEPLOYMENTS.md"
rsync -a "$SRC/v3/HANDOFF.md" "$DST/HANDOFF.md"
# Light-client deposit proofs: Python reference, Java verifier (+ JNI shim source and prebuilt blst .so), Solidity layout test.
copy v3/deposit_proofs deposit-proofs '/python/*.py' '/java/src/***' '/java/jni/***' '/java/native/***' '/java/*.sh' \
  '/java/android_demo/src/***' '/java/android_demo/AndroidManifest.xml' '/java/android_demo/*.sh' \
  '/solidity/src/***' '/solidity/test/***' '/solidity/foundry.toml' '/*.sh' '/requirements.txt'
mkdir -p "$DST/tools" && rsync -a "$SRC/v3/handoff.py" "$SRC/v3/handoff_sim.py" "$DST/tools/"
# The Prawl Offline Android app (Kotlin/Compose, :core protocol library). Source, tests, Gradle wrapper and the
# prebuilt blst libraries only. Never keystore/, local.properties, build output or APKs.
copy v3/app app '/build.gradle.kts' '/settings.gradle.kts' '/gradle.properties' '/gradlew' '/gradlew.bat' \
  '/gradle/***' '/app/build.gradle.kts' '/app/src/***' '/app/proguard*' '/core/build.gradle.kts' '/core/src/***' \
  '/RESULTS.md'
mkdir -p "$DST/app/keystore"
cat > "$DST/app/keystore/README.md" <<'KS'
# Debug keystore (not tracked)
The debug APK signing key is local only. Create it once:

    keytool -genkeypair -keystore app/keystore/prawl-debug.keystore -storepass android -keypass android \
      -alias debug -keyalg RSA -keysize 2048 -validity 3650 -dname "CN=Prawl OTK test"

The recipient policy pins the genuine app by (package, signing-certificate SHA-256) in `ALLOWED_APPS`.
A freshly created key has a different digest: print it with
`keytool -list -v -keystore app/keystore/prawl-debug.keystore -storepass android | grep SHA256`
and put it in `ALLOWED_APPS` before testing between two builds.
KS

# ZK proof of Android attestation (Noir/UltraHonk): circuit sources, tools, EVM verifier, Android prover build.
# Never Prover.toml/target/inputs/bench/deps (witnesses derive from the user's phones' attestation chains).
copy zk_attestation zk-attestation '/circuits/*/Nargo.toml' '/circuits/*/src/***' '/tools/*.py' \
  '/android/*.sh' '/android/*.patch' '/evm/src/***' '/evm/test/***' '/evm/foundry.toml' '/evm/*.sh' '/*.sh'
# Earlier prototypes and simulations behind the four routes.
copy "$A/contracts" prototypes/otk-escrow '/src/***' '/test/***' '/foundry.toml'
copy "$A/android" prototypes/otk-android '/*.kt'
copy "$A/privacy_research" prototypes/privacy '/*.py'
rsync -a "$SRC/$A/otk_verifier.py" "$DST/prototypes/otk-verifier.py"
copy seam_b_communication prototypes/lock-certs '/rust_lockcert/src/***' '/rust_lockcert/Cargo.toml' \
  '/rust_lockcert/Cargo.lock' '/sim/*.py' '/contracts/src/***' '/contracts/test/***' '/contracts/script/***' \
  '/contracts/foundry.toml' '/*.sh'
copy seam_c_recipients prototypes/designated-notes '/*.py' '/contracts/src/***' '/contracts/test/***' '/contracts/foundry.toml'
copy seam_d_economics prototypes/counter-cheques '/*.py' '/contracts/src/***' '/contracts/test/***' '/contracts/foundry.toml'

# Phone serials -> required env vars.
grep -rlE 'RZGL80J824K|a6020117' "$DST" | while read -r f; do
  sed -i -E \
    -e 's/\$\{A:-RZGL80J824K\}/${A:?set A to phone A adb serial}/g' \
    -e 's/\$\{B:-a6020117\}/${B:?set B to phone B adb serial}/g' \
    -e 's/A=RZGL80J824K;/A=${A:?set A to phone A adb serial};/g' \
    -e 's/B=a6020117;/B=${B:?set B to phone B adb serial};/g' \
    -e 's/RZGL80J824K/PHONE_A/g' -e 's/a6020117/PHONE_B/g' "$f"
done

# Guard: nothing key-like or device-identifying may be left.
if grep -rlE 'BEGIN [A-Z ]*PRIVATE KEY|RZGL80J824K|a6020117' "$DST"; then
  echo "sync-offline: the files above still hold a private key or a phone serial" >&2; exit 1
fi
if find "$DST" \( -name '*.keystore' -o -name '*.jks' -o -name '*.p12' \) | grep .; then
  echo "sync-offline: key store copied" >&2; exit 1
fi
echo "synced $(find "$DST" -type f | wc -l) files into $DST/"
