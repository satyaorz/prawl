#!/usr/bin/env bash
# One phone: mint + real Sepolia deposit + offline pay between two identities on the same phone +
# phone-signed redemption -> website handoff payload (left UNSUBMITTED for the website to cash out).
cd "$(dirname "$0")"
export LOG=run3_handoff_$(date +%H%M%S).log WORK=relay3ho PY="$(cd ..; pwd)/.venv/bin/python"
B=$A   # same phone plays Alice and Bob
rm -rf $WORK; source w2_lib.sh; source w3_lib.sh
need_phones() { [ "$(adb -s $A get-state 2>/dev/null)" = device ] || { echo "ABORT: phone $A not connected" | tee -a "$LOG"; exit 3; }; }
RPC=https://ethereum-sepolia-rpc.publicnode.com; ESC=70b3b7edcd18087c999ec80e3c3b0227c7e0d6e5; DEP=03a62b04abe69f382bd7582f492be735b1ddb47b
PAYOUT=${PAYOUT:-0x$DEP}; V3="$(cd ../../v3; pwd)"
adb -s $A install -r build/prawl-otk-test.apk >/dev/null; reset_app $A
say "H1. Samsung mints 0.005 ETH coin, real Sepolia deposit"
w3 $A -e cmd mint -e coin ho -e eth 0.005 -e expiresIn 864000 -e chainId 11155111 -e escrow $ESC -e depositor $DEP
pull $A mint3_ho.json
D="$(pwd)/$WORK"; (cd "$V3/escrow_v3" && timeout 300 tools/sepolia_deposit.sh "$D/mint3_ho.json" --rpc $RPC) 2>&1 | tee -a $LOG
snapshot3 >/dev/null 2>&1 || true
say "H2. Offline on one phone: Alice pays Bob 0.002 (change 0.003)"
w3 $A -e cmd request -e name bob; pull $A req_bob.json; push $A req_bob.json
w3 $A -e cmd pay -e coin ho -e amount 0.002 -e req req_bob.json; pull $A pay3_ho_bob.json; push $A pay3_ho_bob.json
w3 $A -e cmd accept -e pay pay3_ho_bob.json -e name bob -e snapshot snapshot.json
say "H3. Bob's note signs a redemption to $PAYOUT (left for the website)"
w3 $A -e cmd redeem -e coin ho -e payout $PAYOUT
for f in $(adb -s $A shell run-as $PKG ls files/out | tr -d '\r' | grep '^redeem3_'); do pull $A $f; done
say "H4. Handoff payloads + simulation against real Sepolia"
mkdir -p "$V3/handoff_vectors"
"$PY" -I "$V3/handoff.py" load $WORK/mint3_ho.json --out "$V3/handoff_vectors/load_ho_deposited.json" >/dev/null
for f in $WORK/redeem3_*.json; do b=$(basename $f .json)
  "$PY" -I "$V3/handoff.py" redeem $f --out "$V3/handoff_vectors/$b.json" 2>&1 >/dev/null | tee -a $LOG
  "$PY" -I "$V3/handoff_sim.py" "$V3/handoff_vectors/$b.json" 2>&1 | tee -a $LOG; done
ls -la "$V3/handoff_vectors" | tee -a $LOG; echo "log: $LOG"
