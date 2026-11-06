#!/usr/bin/env bash
# Produce real-phone v1 vectors for the on-chain tests: a phone-signed redemption hop,
# a stale-claim attempt after redemption, and a real equivocation by a multi-use (cheat) key.
cd "$(dirname "$0")"
A=${A:?set A to phone A adb serial}; B=${B:?set B to phone B adb serial}; PKG=xyz.prawl.otktest; W=../phone_vectors_v2_onchain; rm -rf $W; mkdir -p $W
CHAIN=31337; ESCROW=0x00000000000000000000000000000000000E5C70; PAYOUT=0x00000000000000000000000000000000000B0B00
wallet() { local s=$1; shift; adb -s $s shell am force-stop $PKG; adb -s $s logcat -c
  adb -s $s shell am start -W -n $PKG/.WalletActivity "$@" >/dev/null
  local i; for i in $(seq 1 60); do adb -s $s logcat -d -s PRAWL_WALLET:I | grep -q ' END ' && break; sleep 0.5; done
  adb -s $s logcat -d -s PRAWL_WALLET:I | sed -n 's/^.*PRAWL_WALLET: /    /p'; }
pull() { adb -s $1 exec-out run-as $PKG cat files/out/$2 > $W/$2; }
push() { adb -s $1 exec-in run-as $PKG sh -c "cat > files/in/$2" < $W/$2; }
for s in $A $B; do adb -s $s shell "run-as $PKG rm -rf files/in files/out files/wallet; run-as $PKG mkdir -p files/in files/out files/wallet"; done
echo "## R: Alice mints r1 (0.3), pays Bob; Bob's phone signs a redemption to $PAYOUT"
wallet $A -e cmd mint -e coin r1 -e value 0.3; pull $A mint_r1.json
"${PY:-../.venv/bin/python}" - $W <<'PY'
import json,sys,hashlib,base64
from cryptography import x509
from cryptography.hazmat.primitives import serialization
w=sys.argv[1]; deps=[]
for c in ["r1","e1"]:
    try: m=json.load(open(f"{w}/mint_{c}.json"))
    except FileNotFoundError: continue
    leaf=x509.load_der_x509_certificate(base64.b64decode(m["chain"][0]))
    spki=leaf.public_key().public_bytes(serialization.Encoding.DER,serialization.PublicFormat.SubjectPublicKeyInfo)
    deps.append({"coinId":m["coinId"],"value":m["value"],"k0":hashlib.sha256(spki).hexdigest()})
json.dump({"deposits":deps},open(f"{w}/snapshot.json","w"))
PY
push $B snapshot.json
wallet $B -e cmd request -e name bob; pull $B req_bob.json; push $A req_bob.json
wallet $A -e cmd pay -e coin r1 -e req req_bob.json; pull $A pay_r1_bob.json; push $B pay_r1_bob.json
wallet $B -e cmd accept -e pay pay_r1_bob.json -e name bob -e snapshot snapshot.json
wallet $B -e cmd redeem -e coin r1 -e chainId $CHAIN -e escrow $ESCROW -e payout $PAYOUT; pull $B redeem_r1.json
echo "## R2: Bob tries to ALSO pay r1 offline after redeeming (to Dave)"
wallet $A -e cmd request -e name dave; pull $A req_dave.json; push $B req_dave.json
wallet $B -e cmd pay -e coin r1 -e req req_dave.json
echo "## E: real equivocation evidence: multi-use (cheat) key e1 signs hop 0 to Bob AND to Charlie"
wallet $A -e cmd mint -e coin e1 -e value 0.1 -e multiuse true; pull $A mint_e1.json
wallet $B -e cmd request -e name bobE; pull $B req_bobE.json; push $A req_bobE.json
wallet $B -e cmd request -e name charlieE; pull $B req_charlieE.json; push $A req_charlieE.json
wallet $A -e cmd pay -e coin e1 -e req req_bobE.json; pull $A pay_e1_bobE.json
wallet $A -e cmd pay -e coin e1 -e req req_charlieE.json; pull $A pay_e1_charlieE.json
ls -la $W
