#!/usr/bin/env bash
# v2 hardening tests over the adb file relay. Phone A = Samsung (Alice/Dave), B = OnePlus (Bob).
cd "$(dirname "$0")"
export LOG=run2_hardening_$(date +%H%M%S).log WORK=relay2
rm -rf relay2; source w2_lib.sh
export PY=../.venv/bin/python
reset_app $A; reset_app $B; reset_app $A $EVIL
echo "A=$(adb -s $A shell getprop ro.product.model) B=$(adb -s $B shell getprop ro.product.model)" | tee $LOG

say "H1. Honest payment Alice -> Bob (cold caches: Bob has never seen Alice's certificates)"
w2 $A -e cmd mint -e coin c1 -e value 0.2
pull $A mint_c1.json; snapshot
w2 $B -e cmd request -e name bob; pull $B req_bob.json; push $A req_bob.json
w2 $A -e cmd pay -e coin c1 -e req req_bob.json; pull $A pay_c1_bob.json; push $B pay_c1_bob.json
w2 $B -e cmd accept -e pay pay_c1_bob.json -e name bob -e snapshot snapshot.json

say "H2. Multi-hop with warm caches: Bob -> Dave -> Bob2 -> (Dave2 = 4th hop, over the limit of 3)"
w2 $A -e cmd request -e name dave; pull $A req_dave.json; push $B req_dave.json
w2 $B -e cmd pay -e coin c1 -e req req_dave.json; pull $B pay_c1_dave.json; push $A pay_c1_dave.json
w2 $A -e cmd accept -e pay pay_c1_dave.json -e name dave -e snapshot snapshot.json
w2 $B -e cmd request -e name bob2; pull $B req_bob2.json; push $A req_bob2.json
w2 $A -e cmd pay -e coin c1 -e req req_bob2.json; pull $A pay_c1_bob2.json; push $B pay_c1_bob2.json
w2 $B -e cmd accept -e pay pay_c1_bob2.json -e name bob2 -e snapshot snapshot.json
w2 $A -e cmd request -e name dave2; pull $A req_dave2.json; push $B req_dave2.json
w2 $B -e cmd pay -e coin c1 -e req req_dave2.json; pull $B pay_c1_dave2.json; push $A pay_c1_dave2.json
w2 $A -e cmd accept -e pay pay_c1_dave2.json -e name dave2 -e snapshot snapshot.json

say "H3. EXPIRED: coin c3 minted with 60 s lifetime (recipient needs >= 1 h left)"
w2 $A -e cmd mint -e coin c3 -e value 0.1 -e expiresIn 60; pull $A mint_c3.json; snapshot
w2 $B -e cmd request -e name bob3; pull $B req_bob3.json; push $A req_bob3.json
w2 $A -e cmd pay -e coin c3 -e req req_bob3.json; pull $A pay_c3_bob3.json; push $B pay_c3_bob3.json
w2 $B -e cmd accept -e pay pay_c3_bob3.json -e name bob3 -e snapshot snapshot.json

say "H4. OVER CAP: coin c4 worth 5.0 ETH (offline cap 1.0)"
w2 $A -e cmd mint -e coin c4 -e value 5.0; pull $A mint_c4.json; snapshot
w2 $B -e cmd request -e name bob4; pull $B req_bob4.json; push $A req_bob4.json
w2 $A -e cmd pay -e coin c4 -e req req_bob4.json; pull $A pay_c4_bob4.json; push $B pay_c4_bob4.json
w2 $B -e cmd accept -e pay pay_c4_bob4.json -e name bob4 -e snapshot snapshot.json

say "H5. FAKE APP: a repackaged wallet (other package + signing key) mints c5 with a genuine one-time key"
w2 $A --pkg $EVIL -e cmd mint -e coin c5 -e value 0.1; pull $A mint_c5.json $EVIL; snapshot
w2 $B -e cmd request -e name bob5; pull $B req_bob5.json; push $A req_bob5.json $EVIL
w2 $A --pkg $EVIL -e cmd pay -e coin c5 -e req req_bob5.json; pull $A pay_c5_bob5.json $EVIL; push $B pay_c5_bob5.json
w2 $B -e cmd accept -e pay pay_c5_bob5.json -e name bob5 -e snapshot snapshot.json

say "H6. SILENT SPEND: coin c6 requires the owner's fingerprint/PIN; malware-style signing without the prompt"
w2 $A -e cmd mint -e coin c6 -e value 0.1 -e auth true; pull $A mint_c6.json; snapshot
w2 $B -e cmd request -e name bob6; pull $B req_bob6.json; push $A req_bob6.json
w2 $A -e cmd pay -e coin c6 -e req req_bob6.json -e silent true

echo "log: $LOG"
