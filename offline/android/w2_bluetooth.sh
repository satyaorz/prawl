#!/usr/bin/env bash
# v2 over real Bluetooth RFCOMM between the phones. The laptop only starts the apps
# and syncs the deposit snapshot beforehand; request, payment and verdict go phone-to-phone.
cd "$(dirname "$0")"
export LOG=run2_bluetooth_$(date +%H%M%S).log WORK=relay2bt PY=../.venv/bin/python
rm -rf relay2bt; source w2_lib.sh
ADDR_A=$(adb -s $A shell settings get secure bluetooth_address | tr -d '\r')
ADDR_B=$(adb -s $B shell settings get secure bluetooth_address | tr -d '\r')
echo "A=$(adb -s $A shell getprop ro.product.model) $ADDR_A  B=$(adb -s $B shell getprop ro.product.model) $ADDR_B" | tee $LOG
bt() {  # bt <payer> <payee> <payee_addr> <coin> <name>
  w2_bg $2 -e cmd bt_receive -e name $5 -e snapshot snapshot.json
  w2_wait $2 "BT LISTENING" || { echo "payee never listened"; w2_dump $2; return; }
  echo "  -- payer $1:" | tee -a $LOG; w2 $1 -e cmd bt_pay -e coin $4 -e addr $3
  w2_wait $2 " END " ; echo "  -- payee $2:" | tee -a $LOG; w2_dump $2
}
say "B0. sync while online: Alice mints c7 (0.2 ETH); deposit snapshot to both phones"
w2 $A -e cmd mint -e coin c7 -e value 0.2; pull $A mint_c7.json; snapshot
say "B1. Alice (Samsung) pays c7 to Bob (OnePlus) over Bluetooth"
bt $A $B $ADDR_B c7 bobbt
say "B2. DOUBLE SPEND over Bluetooth: Alice pays c7 again, to Charlie (OnePlus)"
bt $A $B $ADDR_B c7 charliebt
say "B3. Bob (OnePlus) pays c7 onward to Dave (Samsung) over Bluetooth"
bt $B $A $ADDR_A c7 davebt
say "B4. DOUBLE SPEND at hop 2 over Bluetooth: Bob pays c7 again, to Eve (Samsung)"
bt $B $A $ADDR_A c7 evebt
echo "log: $LOG"
