#!/usr/bin/env bash
# Two-phone Prowl one-time-key coin test.
#   Phone A (default Samsung S25 Ultra) = Alice, and later Dave
#   Phone B (default OnePlus)           = Bob and Charlie
# The laptop only (a) carries files between phones, like Bluetooth/QR would, and
# (b) plays the chain: it builds the deposit snapshot from mint records.
# All checks run on the phones.
set -uo pipefail
cd "$(dirname "$0")"
A=${A:?set A to phone A adb serial}
B=${B:?set B to phone B adb serial}
PKG=xyz.prawl.otktest
LOG=run_$(date +%Y%m%d_%H%M%S).log
WORK=relay; rm -rf $WORK; mkdir -p $WORK

say() { echo -e "\n### $*" | tee -a $LOG; }
wallet() {  # wallet <serial> <extras...>; prints the phone's log for that command
  local s=$1; shift
  adb -s $s shell am force-stop $PKG
  adb -s $s logcat -c
  adb -s $s shell am start -W -n $PKG/.WalletActivity "$@" >/dev/null
  for i in $(seq 1 60); do adb -s $s logcat -d -s PRAWL_WALLET:I | grep -q ' END ' && break; sleep 0.5; done
  adb -s $s logcat -d -s PRAWL_WALLET:I | sed -n 's/^.*PRAWL_WALLET: /    /p' | tee -a $LOG
}
pull() { adb -s $1 exec-out run-as $PKG cat files/out/$2 > $WORK/$2; }          # phone -> laptop
push() { adb -s $1 exec-in run-as $PKG sh -c "cat > files/in/$2" < $WORK/$2; }  # laptop -> phone

for s in $A $B; do
  adb -s $s install -r build/prawl-otk-test.apk >/dev/null
  adb -s $s shell "run-as $PKG rm -rf files/in files/out files/wallet; run-as $PKG mkdir -p files/in files/out files/wallet"
  adb -s $s shell "run-as $PKG ls files" | tr '\n' ' '; echo
done
echo "A=$(adb -s $A shell getprop ro.product.model) B=$(adb -s $B shell getprop ro.product.model)" | tee $LOG

say "1. Alice (phone A) deposits: mint coin c1 = 0.2 ETH"
wallet $A -e cmd mint -e coin c1 -e value 0.2
pull $A mint_c1.json
say "   chain sync: snapshot of escrow deposits pushed to both phones (built by laptop from mint record)"
python3 - "$WORK" <<'EOF'
import json, sys, hashlib, base64
from cryptography import x509
from cryptography.hazmat.primitives import serialization
w = sys.argv[1]; deps = []
for f in ["mint_c1.json", "mint_c2.json"]:
    try: m = json.load(open(f"{w}/{f}"))
    except FileNotFoundError: continue
    leaf = x509.load_der_x509_certificate(base64.b64decode(m["chain"][0]))
    spki = leaf.public_key().public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)
    deps.append({"coinId": m["coinId"], "value": m["value"], "k0": hashlib.sha256(spki).hexdigest()})
json.dump({"deposits": deps}, open(f"{w}/snapshot.json", "w"), indent=1)
print("    snapshot:", deps)
EOF
push $A snapshot.json; push $B snapshot.json

say "2. Bob (phone B) makes a receive request; it travels to Alice"
wallet $B -e cmd request -e name bob
pull $B req_bob.json; push $A req_bob.json

say "3. Alice pays coin c1 to Bob (offline)"
wallet $A -e cmd pay -e coin c1 -e req req_bob.json
pull $A pay_c1_bob.json; push $B pay_c1_bob.json

say "4. Bob verifies on his phone and accepts"
wallet $B -e cmd accept -e pay pay_c1_bob.json -e name bob -e snapshot snapshot.json

say "5. DOUBLE SPEND: Alice tries to pay the same coin c1 to Charlie"
wallet $B -e cmd request -e name charlie
pull $B req_charlie.json; push $A req_charlie.json
wallet $A -e cmd pay -e coin c1 -e req req_charlie.json

say "6. REPLAY: Alice forwards Bob's payment to Charlie instead"
cp $WORK/pay_c1_bob.json $WORK/pay_c1_replay.json; push $B pay_c1_replay.json
wallet $B -e cmd accept -e pay pay_c1_replay.json -e name charlie -e snapshot snapshot.json

say "7. TAMPER: Alice edits Bob's payment to claim 2.0 ETH"
python3 -c "import json;p=json.load(open('$WORK/pay_c1_bob.json'));p['value']='2.0';p['mint']['value']='2.0';json.dump(p,open('$WORK/pay_c1_tamper.json','w'))"
push $B pay_c1_tamper.json
wallet $B -e cmd accept -e pay pay_c1_tamper.json -e name bob -e snapshot snapshot.json

say "8. MULTI-HOP: Bob (phone B) pays c1 on to Dave (phone A); Dave checks the whole history"
wallet $A -e cmd request -e name dave
pull $A req_dave.json; push $B req_dave.json
wallet $B -e cmd pay -e coin c1 -e req req_dave.json
pull $B pay_c1_dave.json; push $A pay_c1_dave.json
wallet $A -e cmd accept -e pay pay_c1_dave.json -e name dave -e snapshot snapshot.json

say "9. DOUBLE SPEND at hop 2: Bob tries to pay c1 again, to Charlie"
push $B req_charlie.json
wallet $B -e cmd pay -e coin c1 -e req req_charlie.json

say "10. CHEAT KEY: Alice mints c2 with an ordinary multi-use key (deposit even on-chain), pays Bob"
wallet $A -e cmd mint -e coin c2 -e value 0.1 -e multiuse true
pull $A mint_c2.json
python3 - "$WORK" <<'EOF'
import json, sys, hashlib, base64
from cryptography import x509
from cryptography.hazmat.primitives import serialization
w = sys.argv[1]; deps = []
for f in ["mint_c1.json", "mint_c2.json"]:
    m = json.load(open(f"{w}/{f}"))
    leaf = x509.load_der_x509_certificate(base64.b64decode(m["chain"][0]))
    spki = leaf.public_key().public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)
    deps.append({"coinId": m["coinId"], "value": m["value"], "k0": hashlib.sha256(spki).hexdigest()})
json.dump({"deposits": deps}, open(f"{w}/snapshot.json", "w"), indent=1)
EOF
push $A snapshot.json; push $B snapshot.json
wallet $B -e cmd request -e name bob3
pull $B req_bob3.json; push $A req_bob3.json
wallet $A -e cmd pay -e coin c2 -e req req_bob3.json
pull $A pay_c2_bob3.json; push $B pay_c2_bob3.json
wallet $B -e cmd accept -e pay pay_c2_bob3.json -e name bob3 -e snapshot snapshot.json
wallet $A -e cmd pay -e coin c2 -e req req_charlie.json
say "    (cheat key signs a second time, and Bob's phone would reject that coin too)"

say "Final holdings"
echo "  phone A:" | tee -a $LOG; wallet $A -e cmd show
echo "  phone B:" | tee -a $LOG; wallet $B -e cmd show
ls -la $WORK | tee -a $LOG
echo "log: $LOG"
