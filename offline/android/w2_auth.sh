#!/usr/bin/env bash
# Owner-approved spend over Bluetooth: coin key requires fingerprint/PIN per signature.
cd "$(dirname "$0")"
export LOG=run2_auth_$(date +%H%M%S).log WORK=relay2au PY=../.venv/bin/python WAIT=300
rm -rf relay2au; source w2_lib.sh
ADDR_B=$(adb -s $B shell settings get secure bluetooth_address | tr -d '\r')
say "U0. Alice mints c10 (0.1 ETH) with a one-time key that ALSO needs her fingerprint/PIN per use"
w2 $A -e cmd mint -e coin c10 -e value 0.1 -e auth true; pull $A mint_c10.json; snapshot
say "U1. Alice pays Bob over Bluetooth; Samsung shows the approval prompt"
w2_bg $B -e cmd bt_receive -e name bobu -e snapshot snapshot.json
w2_wait $B "BT LISTENING"
echo "  -- payer:" | tee -a $LOG; w2 $A -e cmd bt_pay -e coin c10 -e addr $ADDR_B
w2_wait $B " END "; echo "  -- payee:" | tee -a $LOG; w2_dump $B
echo "log: $LOG"
