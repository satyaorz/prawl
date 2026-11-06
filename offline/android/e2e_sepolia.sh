#!/usr/bin/env bash
# Real end to end on Sepolia: phone mint -> real deposit tx -> offline split payments between the
# two phones -> phone-signed redemptions -> real redeem txs to the deployed escrow.
cd "$(dirname "$0")"
export LOG=run3_e2e_sepolia_$(date +%H%M%S).log WORK=relay3e2e PY="$(cd ..; pwd)/.venv/bin/python"
rm -rf relay3e2e; source w2_lib.sh; source w3_lib.sh
RPC=https://ethereum-sepolia-rpc.publicnode.com
ESC=70b3b7edcd18087c999ec80e3c3b0227c7e0d6e5; DEP=03a62b04abe69f382bd7582f492be735b1ddb47b; PAYOUT=0x$DEP
T=../../v3/escrow_v3/tools
for s in $A $B; do adb -s $s install -r build/prawl-otk-test.apk >/dev/null && echo "installed current APK on $s ($(md5sum < build/prawl-otk-test.apk | cut -c1-8))" | tee -a $LOG; done
reset_app $A; reset_app $B
echo "A=$(adb -s $A shell getprop ro.product.model) B=$(adb -s $B shell getprop ro.product.model)" | tee $LOG
say "E1. Alice's Samsung mints a 0.01 ETH coin for the deployed Sepolia escrow"
w3 $A -e cmd mint -e coin e2e -e eth 0.01 -e expiresIn 864000 -e chainId 11155111 -e escrow $ESC -e depositor $DEP
pull $A mint3_e2e.json
say "E2. REAL Sepolia deposit of that coin"
D="$(pwd)/$WORK"; (cd ../../v3/escrow_v3 && timeout 300 tools/sepolia_deposit.sh "$D/mint3_e2e.json" --rpc $RPC) 2>&1 | tee -a $LOG
snapshot3
say "E3. Offline: Alice pays Bob 0.004 (change 0.006)"
w3 $B -e cmd request -e name bob; pull $B req_bob.json; push $A req_bob.json
w3 $A -e cmd pay -e coin e2e -e amount 0.004 -e req req_bob.json; pull $A pay3_e2e_bob.json; push $B pay3_e2e_bob.json
w3 $B -e cmd accept -e pay pay3_e2e_bob.json -e name bob -e snapshot snapshot.json
say "E4. Offline: Bob pays Dave (Samsung) 0.001 (change 0.003)"
w3 $A -e cmd request -e name dave; pull $A req_dave.json; push $B req_dave.json
w3 $B -e cmd pay -e coin e2e -e amount 0.001 -e req req_dave.json; pull $B pay3_e2e_dave.json; push $A pay3_e2e_dave.json
w3 $A -e cmd accept -e pay pay3_e2e_dave.json -e name dave -e snapshot snapshot.json
say "E5. Phones sign redemptions: Dave 0.001, Bob's change 0.003, Alice's change 0.006"
for who in A B; do s=${!who}
  for n in 1 2; do w3 $s -e cmd redeem -e coin e2e -e payout $PAYOUT; done
done
for s in $A $B; do for f in $(adb -s $s shell run-as $PKG ls files/out | tr -d '\r' | grep '^redeem3_'); do pull $s $f; done; done
ls $WORK | tee -a $LOG
say "E6. REAL Sepolia redemptions"
for f in "$(pwd)/$WORK"/redeem3_*.json; do
  echo "--- $(basename $f)" | tee -a $LOG; (cd ../../v3/escrow_v3 && timeout 300 tools/sepolia_redeem.sh "$f" --rpc $RPC) 2>&1 | tee -a $LOG
done
say "E7. On-chain state"
cast call 0x$ESC "coins(bytes32)(uint128,bool,bool)" 0x$("$PY" -c "import json;print(json.load(open('$WORK/mint3_e2e.json'))['coinId'])") --rpc-url $RPC 2>&1 | tee -a $LOG
echo "log: $LOG"
