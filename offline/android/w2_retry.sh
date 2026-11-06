#!/usr/bin/env bash 
# Interrupted Bluetooth payment: the radio drops after Alice signs. Retry must resend the
# identical payment to Bob, and must not let Alice redirect the coin to someone else.
cd "$(dirname "$0")"
export LOG=run2_retry_$(date +%H%M%S).log WORK=relay2rt PY=../.venv/bin/python
rm -rf relay2rt; source w2_lib.sh
ADDR_B=$(adb -s $B shell settings get secure bluetooth_address | tr -d '\r')
bt() { w2_bg $2 -e cmd bt_receive -e name $5 -e snapshot snapshot.json
  w2_wait $2 "BT LISTENING" || { echo "payee never listened"; w2_dump $2; return; }
  echo "  -- payer:" | tee -a $LOG; w2 $1 -e cmd bt_pay -e coin $4 -e addr $3 "${@:6}"
  w2_wait $2 " END "; echo "  -- payee:" | tee -a $LOG; w2_dump $2; }
say "R0. Alice mints c9 (0.1 ETH), sync"
w2 $A -e cmd mint -e coin c9 -e value 0.1; pull $A mint_c9.json; snapshot
say "R1. Alice pays Bob over Bluetooth but the radio drops right after she signs"
bt $A $B $ADDR_B c9 bobr -e drop true
say "R2. Alice tries to use the lost payment as an excuse to pay Charlie instead"
bt $A $B $ADDR_B c9 charlier
say "R3. Bob reconnects (same pending receive key); Alice's wallet resends the stored payment"
bt $A $B $ADDR_B c9 bobr
echo "log: $LOG"
