#!/usr/bin/env bash
# v3 splitting + change across two phones. A = Alice (+Dave), B = Bob.
cd "$(dirname "$0")"
export LOG=run3_split_$(date +%H%M%S).log WORK=relay3 PY=../.venv/bin/python
rm -rf relay3; source w2_lib.sh; source w3_lib.sh
RUN=$(date +%H%M%S)   # receive keys persist in the keystore: unique names per run (the app refuses to replace a key)
reset_app $A; reset_app $B
echo "A=$(adb -s $A shell getprop ro.product.model) B=$(adb -s $B shell getprop ro.product.model)" | tee $LOG
say "S1. Alice deposits a 1.0 ETH coin (label s)"
w3 $A -e cmd mint -e coin s -e eth 1.0; pull $A mint3_s.json; snapshot3
say "S2. Alice pays Bob 0.2 ETH (keeps 0.8 change on a fresh one-time key)"
w3 $B -e cmd request -e name bob1$RUN; pull $B req_bob1$RUN.json; push $A req_bob1$RUN.json
w3 $A -e cmd pay -e coin s -e amount 0.2 -e req req_bob1$RUN.json; pull $A pay3_s_bob1$RUN.json; push $B pay3_s_bob1$RUN.json
w3 $B -e cmd accept -e pay pay3_s_bob1$RUN.json -e name bob1$RUN -e snapshot snapshot.json
say "S3. Bob pays Dave (Alice's phone) 0.1 ETH from his 0.2 note (keeps 0.1 change)"
w3 $A -e cmd request -e name dave1$RUN; pull $A req_dave1$RUN.json; push $B req_dave1$RUN.json
w3 $B -e cmd pay -e coin s -e amount 0.1 -e req req_dave1$RUN.json; pull $B pay3_s_dave1$RUN.json; push $A pay3_s_dave1$RUN.json
w3 $A -e cmd accept -e pay pay3_s_dave1$RUN.json -e name dave1$RUN -e snapshot snapshot.json
say "S4. Alice pays Bob 0.5 ETH from her 0.8 change note (keeps 0.3)"
w3 $B -e cmd request -e name bob2$RUN; pull $B req_bob2$RUN.json; push $A req_bob2$RUN.json
w3 $A -e cmd pay -e coin s -e amount 0.5 -e req req_bob2$RUN.json; pull $A pay3_s_bob2$RUN.json; push $B pay3_s_bob2$RUN.json
w3 $B -e cmd accept -e pay pay3_s_bob2$RUN.json -e name bob2$RUN -e snapshot snapshot.json
say "S5. MALICIOUS WALLET: Alice's app ignores its records and re-spends the 1.0 genesis note to Bob (0.9)"
w3 $B -e cmd request -e name bob3$RUN; pull $B req_bob3$RUN.json; push $A req_bob3$RUN.json
w3 $A -e cmd pay -e coin s -e amount 0.9 -e req req_bob3$RUN.json -e note n_s_g
say "S6. TAMPER: Bob edits Alice's spend to give himself 0.9 instead of 0.2"
"$PY" -c "
import json; p=json.load(open('$WORK/pay3_s_bob1$RUN.json'))
o=p['path'][0]['outputs']; o[0]['value']=str(9*10**17); o[1]['value']=str(1*10**17)
json.dump(p,open('$WORK/pay3_s_tamper.json','w'))"
push $B pay3_s_tamper.json
w3 $B -e cmd request -e name bob4$RUN >/dev/null
w3 $B -e cmd accept -e pay pay3_s_tamper.json -e name bob1$RUN -e snapshot snapshot.json
say "S7. Bob redeems his 0.1 change note to a payout address (phone-signed)"
w3 $B -e cmd redeem -e coin s -e payout 0x00000000000000000000000000000000000B0B00; pull $B "$(adb -s $B shell run-as $PKG ls files/out | tr -d '\r' | grep redeem3 | head -1)"
say "S8. Balances"
echo "  Samsung (Alice + Dave):" | tee -a $LOG; w3 $A -e cmd show
echo "  OnePlus (Bob):" | tee -a $LOG; w3 $B -e cmd show
ls -la $WORK | tee -a $LOG
echo "log: $LOG"
