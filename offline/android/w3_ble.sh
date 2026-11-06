#!/usr/bin/env bash
# v3 payments over the NEW default transport: BLE + L2CAP, no Bluetooth address (the QR carries a one-time
# session id). Needs the compat/new app on both phones. A = Samsung (payer first), B = OnePlus.
cd "$(dirname "$0")"
export LOG=run3_ble_$(date +%H%M%S).log WORK=relay3ble PY="$(cd ..; pwd)/.venv/bin/python"
TRANSPORT=${TRANSPORT:-}   # set TRANSPORT=rfcomm to test the classic fallback
rm -rf "$WORK"; source w2_lib.sh; source w3_lib.sh
reset_app $A; reset_app $B
ble() {  # ble <payer> <payee> <coin> <amount> <name>
  local tr=""; [ -n "$TRANSPORT" ] && tr="-e transport $TRANSPORT"
  w3_bg $2 -e cmd ble_receive -e name $5 -e snapshot snapshot.json $tr
  local i; for i in $(seq 1 60); do adb -s $2 shell run-as $PKG ls files/out 2>/dev/null | grep -q "qr_$5.txt" && break; sleep 0.5; done
  pull_txt() { adb -s "$1" exec-out run-as "$PKG" cat "files/out/$2" > "$WORK/$2"; }; pull_txt $2 qr_$5.txt
  echo "  receive code: $(head -c 100 "$WORK/qr_$5.txt")... ($(wc -c < "$WORK/qr_$5.txt") chars)" | tee -a "$LOG"
  adb -s $1 exec-in run-as $PKG sh -c "cat > files/in/qr_$5.txt" < "$WORK/qr_$5.txt"
  echo "  -- payer:" | tee -a "$LOG"; w3 $1 -e cmd ble_pay -e coin $3 -e amount $4 -e qr qr_$5.txt
  w2_wait $2 " END "; echo "  -- payee:" | tee -a "$LOG"; w2_dump $2; }
say "G1. Samsung mints a 0.02 coin (snapshot-backed; no on-chain deposit needed to test the transport)"
w3 $A -e cmd mint -e coin ble -e eth 0.02
pull $A mint3_ble.json; snapshot3
say "G2. Alice (Samsung) pays Bob (OnePlus) 0.008 over BLE+L2CAP"
ble $A $B ble 0.008 bleb
say "G3. Bob (OnePlus) pays Dave (Samsung) 0.003 over BLE+L2CAP"
ble $B $A ble 0.003 bled
echo "log: $LOG"
