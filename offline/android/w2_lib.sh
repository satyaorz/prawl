# Helpers for the v2 two-phone tests. Source this file.
A=${A:?set A to phone A adb serial}      # Samsung S25 Ultra (StrongBox)
B=${B:?set B to phone B adb serial}         # OnePlus CPH2487 (TEE)
PKG=xyz.prawl.otktest
EVIL=xyz.evil.otk
WORK=${WORK:-relay2}
LOG=${LOG:-run2.log}
mkdir -p "$WORK"

say() { need_phones; echo -e "\n### $*" | tee -a "$LOG"; }
# w2 <serial> [pkg] -- <extras...>
w2() {
  local s=$1 pkg=$PKG; shift
  if [ "${1:-}" = "--pkg" ]; then pkg=$2; shift 2; fi
  adb -s "$s" shell input keyevent KEYCODE_WAKEUP
  adb -s "$s" shell am force-stop "$pkg"
  adb -s "$s" logcat -c
  adb -s "$s" shell am start -W -n "$pkg/xyz.prawl.otktest.Wallet2Activity" "$@" >/dev/null
  local i; for i in $(seq 1 ${WAIT:-120}); do adb -s "$s" logcat -d -s PRAWL_W2:I | grep -q ' END ' && break; sleep 0.5; done
  adb -s "$s" logcat -d -s PRAWL_W2:I | sed -n 's/^.*PRAWL_W2: /    /p' | tee -a "$LOG"
}
# background variant (for the Bluetooth listener): starts and returns immediately
w2_bg() { local s=$1; shift; adb -s "$s" shell input keyevent KEYCODE_WAKEUP; adb -s "$s" shell am force-stop $PKG; adb -s "$s" logcat -c
  adb -s "$s" shell am start -n "$PKG/xyz.prawl.otktest.Wallet2Activity" "$@" >/dev/null; }
w2_wait() { local s=$1 pat=$2 i; for i in $(seq 1 ${WAIT:-240}); do adb -s "$s" logcat -d -s PRAWL_W2:I | grep -q "$pat" && return 0; sleep 0.5; done; return 1; }
w2_dump() { adb -s "$1" logcat -d -s PRAWL_W2:I | sed -n 's/^.*PRAWL_W2: /    /p' | tee -a "$LOG"; }
pull() { local pkg=${3:-$PKG}; adb -s "$1" exec-out run-as "$pkg" cat "files/out/$2" > "$WORK/$2"; head -c1 "$WORK/$2" | grep -q "{" || { echo "ABORT: could not pull $2 from $1" | tee -a "$LOG"; exit 4; }; }
push() { local pkg=${3:-$PKG}; adb -s "$1" exec-in run-as "$pkg" sh -c "cat > files/in/$2" < "$WORK/$2"; }
reset_app() { adb -s "$1" shell "run-as ${2:-$PKG} rm -rf files/in files/out files/wallet files/certs; run-as ${2:-$PKG} mkdir -p files/in files/out files/wallet files/certs"; }
snapshot() {  # build snapshot from every mint_*.json in $WORK, push to both phones
  "${PY:-python3}" - "$WORK" <<'EOF'
import json, sys, glob, hashlib, base64
from cryptography import x509
from cryptography.hazmat.primitives import serialization
deps = []
for f in sorted(glob.glob(f"{sys.argv[1]}/mint_*.json")):
    m = json.load(open(f))
    leaf = x509.load_der_x509_certificate(base64.b64decode(m["certs"][m["mint"][0]]))
    spki = leaf.public_key().public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)
    deps.append({"coinId": m["coinId"], "value": m["value"], "expiry": m["expiry"], "k0": hashlib.sha256(spki).hexdigest()})
json.dump({"deposits": deps}, open(f"{sys.argv[1]}/snapshot.json", "w"))
print("    snapshot deposits:", [(d["coinId"], d["value"]) for d in deps])
EOF
  push $A snapshot.json; push $B snapshot.json
  adb -s $A shell pm list packages | grep -q $EVIL && push $A snapshot.json $EVIL || true
}

# Abort the test run if a phone is missing or unauthorized (avoids meaningless results).
need_phones() { local s; for s in $A $B; do
  [ "$(adb -s $s get-state 2>/dev/null)" = device ] || { echo "ABORT: phone $s is not connected/authorized" | tee -a "$LOG"; exit 3; }; done; }
