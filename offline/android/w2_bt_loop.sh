#!/usr/bin/env bash
# Bluetooth reliability: N payments, alternating direction, each with a freshly minted coin.
cd "$(dirname "$0")"
export LOG=run2_btloop_$(date +%H%M%S).log WORK=relay2lp PY=../.venv/bin/python WAIT=120
N=${N:-10}; rm -rf relay2lp; source w2_lib.sh
ADDR_A=$(adb -s $A shell settings get secure bluetooth_address | tr -d '\r')
ADDR_B=$(adb -s $B shell settings get secure bluetooth_address | tr -d '\r')
for n in $(seq 1 $N); do
  if [ $((n % 2)) -eq 1 ]; then P=$A; Q=$B; QA=$ADDR_B; else P=$B; Q=$A; QA=$ADDR_A; fi
  w2 $P -e cmd mint -e coin L$n -e value 0.01 >/dev/null; pull $P mint_L$n.json; snapshot >/dev/null
  w2_bg $Q -e cmd bt_receive -e name r$n -e snapshot snapshot.json
  w2_wait $Q "BT LISTENING" || { echo "$n LISTEN_FAIL" | tee -a $LOG; continue; }
  t0=$(date +%s%N); w2 $P -e cmd bt_pay -e coin L$n -e addr $QA > $WORK/payer_$n.txt 2>&1; t1=$(date +%s%N)
  w2_wait $Q " END "; v=$(adb -s $Q logcat -d -s PRAWL_W2:I | sed -n 's/^.*PRAWL_W2: END //p' | tail -1)
  conn=$(grep -o 'connected to .* in [0-9]* ms' $WORK/payer_$n.txt | grep -o '[0-9]* ms$')
  req=$(adb -s $Q logcat -d -s PRAWL_W2:I | grep -o "REQUEST .*; [0-9]* B" | grep -o '[0-9]* B$')
  pend=$(sed -n 's/^.*END //p' $WORK/payer_$n.txt | tail -1)
  echo "$n $(adb -s $P shell getprop ro.product.model)->$(adb -s $Q shell getprop ro.product.model) payer=$pend payee=$v connect=$conn request=$req wall=$(( (t1-t0)/1000000 ))ms" | tee -a $LOG
done
echo "log: $LOG"
