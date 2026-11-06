# v3 helpers (source after w2_lib.sh)
w3() { local s=$1; shift; adb -s "$s" shell input keyevent KEYCODE_WAKEUP; adb -s "$s" shell am force-stop $PKG; adb -s "$s" logcat -c
  adb -s "$s" shell am start -W -n "$PKG/xyz.prawl.otktest.Wallet3Activity" "$@" >/dev/null
  local i; for i in $(seq 1 ${WAIT:-120}); do adb -s "$s" logcat -d -s PRAWL_W2:I | grep -q ' END ' && break; sleep 0.5; done
  adb -s "$s" logcat -d -s PRAWL_W2:I | sed -n 's/^.*PRAWL_W2: /    /p' | tee -a "$LOG"; }
w3_bg() { local s=$1; shift; adb -s "$s" shell input keyevent KEYCODE_WAKEUP; adb -s "$s" shell am force-stop $PKG; adb -s "$s" logcat -c
  adb -s "$s" shell am start -n "$PKG/xyz.prawl.otktest.Wallet3Activity" "$@" >/dev/null; }
snapshot3() {
  "${PY:-python3}" - "$WORK" <<'PY'
import json, sys, glob, hashlib, base64
from cryptography import x509
from cryptography.hazmat.primitives import serialization
deps = []
for f in sorted(glob.glob(f"{sys.argv[1]}/mint3_*.json")):
    m = json.load(open(f))
    leaf = x509.load_der_x509_certificate(base64.b64decode(m["certs"][m["k0"][0]]))
    spki = leaf.public_key().public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)
    deps.append({"coinId": m["coinId"], "value": m["value"], "expiry": m["expiry"], "k0": hashlib.sha256(spki).hexdigest()})
json.dump({"deposits": deps}, open(f"{sys.argv[1]}/snapshot.json", "w"))
print("    snapshot deposits:", [(d["coinId"][:12], d["value"]) for d in deps])
PY
  push $A snapshot.json; push $B snapshot.json; }
