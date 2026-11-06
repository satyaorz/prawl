#!/usr/bin/env bash
# BLE+L2CAP reliability: N alternating payments, each with a freshly minted coin.
cd "$(dirname "$0")"
export LOG=run3_bleloop_$(date +%H%M%S).log WORK=relay3bl PY="$(cd ..; pwd)/.venv/bin/python"
RUN=$(date +%H%M%S); N=${N:-10}; TRANSPORT=${TRANSPORT:-}; rm -rf "$WORK"; source w2_lib.sh; source w3_lib.sh
need_phones() { for s in $A $B; do [ "$(adb -s $s get-state 2>/dev/null)" = device ] || { echo "ABORT: $s gone" | tee -a $LOG; exit 3; }; done; }
reset_app $A; reset_app $B; mkdir -p "$WORK"
ok=0; lost=0; fail=0
for n in $(seq 1 $N); do
  if [ $((n % 2)) -eq 1 ]; then P=$A; Q=$B; else P=$B; Q=$A; fi
  w3 $P -e cmd mint -e coin L${RUN}_$n -e eth 0.01 >/dev/null; pull $P mint3_L${RUN}_$n.json; snapshot3 >/dev/null 2>&1
  tr=""; [ -n "$TRANSPORT" ] && tr="-e transport $TRANSPORT"
  w3_bg $Q -e cmd ble_receive -e name r${RUN}_$n -e snapshot snapshot.json $tr
  for i in $(seq 1 60); do adb -s $Q shell run-as $PKG ls files/out 2>/dev/null | grep -q "qr_r${RUN}_$n.txt" && break; sleep 0.5; done
  adb -s $Q exec-out run-as $PKG cat files/out/qr_r${RUN}_$n.txt > $WORK/qr_r${RUN}_$n.txt
  adb -s $P exec-in run-as $PKG sh -c "cat > files/in/qr_r${RUN}_$n.txt" < $WORK/qr_r${RUN}_$n.txt
  t0=$(date +%s%N); out=$(w3 $P -e cmd ble_pay -e coin L${RUN}_$n -e amount 0.004 -e qr qr_r${RUN}_$n.txt 2>&1); t1=$(date +%s%N)
  w2_wait $Q " END " >/dev/null
  payer=$(echo "$out" | sed -n 's/.*END //p' | tail -1); payee=$(adb -s $Q logcat -d -s PRAWL_W2:I | sed -n 's/^.*PRAWL_W2: END //p' | tail -1)
  total=$(echo "$out" | grep -o "BT total [0-9]* ms" | tail -1)
  case "$payee" in ACCEPTED) ok=$((ok+1)); [ "$payer" = "PAID:ACCEPTED" ] || lost=$((lost+1));; *) fail=$((fail+1));; esac
  echo "$n $(adb -s $P shell getprop ro.product.model|tr -d '\r')->$(adb -s $Q shell getprop ro.product.model|tr -d '\r') payee=$payee payer=$payer $total wall=$(( (t1-t0)/1000000 ))ms" | tee -a $LOG
done
echo "SUMMARY n=$N payee_accepted=$ok verdict_not_received_by_payer=$lost payment_failed=$fail" | tee -a $LOG
