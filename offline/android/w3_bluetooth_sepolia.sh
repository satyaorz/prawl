#!/usr/bin/env bash
# v3 over real Bluetooth between two phones, on a coin really deposited on Sepolia, with real redeems at the end.
#   A = Samsung (Alice, later Dave), B = OnePlus (Bob)
cd "$(dirname "$0")"
export LOG=run3_bt_sepolia_$(date +%H%M%S).log WORK=relay3bt PY="$(cd ..; pwd)/.venv/bin/python"
rm -rf "$WORK"; source w2_lib.sh; source w3_lib.sh
RPC=https://ethereum-sepolia-rpc.publicnode.com; ESC=70b3b7edcd18087c999ec80e3c3b0227c7e0d6e5; DEP=03a62b04abe69f382bd7582f492be735b1ddb47b
V3="$(cd ../../v3; pwd)"; D="$(pwd)/$WORK"
ADDR_A=$(adb -s $A shell settings get secure bluetooth_address | tr -d '\r'); ADDR_B=$(adb -s $B shell settings get secure bluetooth_address | tr -d '\r')
for s in $A $B; do adb -s $s install -r build/prawl-otk-test.apk >/dev/null; done
reset_app $A; reset_app $B
bt3() {  # bt3 <payer> <payee> <payee_addr> <coin> <amount> <name>
  w3_bg $2 -e cmd bt3_receive -e name $6 -e snapshot snapshot.json
  w2_wait $2 "BT LISTENING" || { echo "payee never listened" | tee -a "$LOG"; w2_dump $2; return 1; }
  echo "  -- payer:" | tee -a "$LOG"; w3 $1 -e cmd bt3_pay -e coin $4 -e amount $5 -e addr $3
  w2_wait $2 " END "; echo "  -- payee:" | tee -a "$LOG"; w2_dump $2; }
say "T0. Samsung mints 0.006 ETH coin; REAL Sepolia deposit; deposit snapshot synced to both phones"
w3 $A -e cmd mint -e coin bt -e eth 0.006 -e expiresIn 864000 -e chainId 11155111 -e escrow $ESC -e depositor $DEP
pull $A mint3_bt.json
(cd "$V3/escrow_v3" && PY="$PY" timeout 300 tools/sepolia_deposit.sh "$D/mint3_bt.json" --rpc $RPC) 2>&1 | grep -E "^tx |MATCH|MISMATCH|REFUSED" | tee -a "$LOG"
snapshot3
say "T1. Bluetooth: Alice (Samsung) pays Bob (OnePlus) 0.0025 (change 0.0035)"
bt3 $A $B $ADDR_B bt 0.0025 bob
say "T2. Bluetooth: Bob pays Dave (Samsung) 0.001 (change 0.0015)"
bt3 $B $A $ADDR_A bt 0.001 dave
say "T3. Bluetooth DOUBLE SPEND: malicious Alice re-spends her spent genesis note to Bob (malicious wallet mode via file relay)"
w3 $B -e cmd request -e name bobx; pull $B req_bobx.json; push $A req_bobx.json
w3 $A -e cmd pay -e coin bt -e amount 0.004 -e req req_bobx.json -e note n_bt_g
say "T4. Phones sign redemptions of every unspent note to the deployer, submitted on Sepolia"
for s in $A $B; do for k in 1 2 3; do w3 $s -e cmd redeem -e coin bt -e payout 0x$DEP | grep -E "REDEEM|no unspent|REFUSED" | tee -a "$LOG"; done; done
for s in $A $B; do for f in $(adb -s $s shell run-as $PKG ls files/out | tr -d '\r' | grep '^redeem3_'); do pull $s $f; done; done
for f in "$D"/redeem3_*.json; do echo "--- $(basename "$f")" | tee -a "$LOG"
  (cd "$V3/escrow_v3" && PY="$PY" timeout 300 tools/sepolia_redeem.sh "$f" --rpc $RPC) 2>&1 | grep -E "^tx |PAID|REFUSED|coin state after" | tee -a "$LOG"; done
echo "log: $LOG"
