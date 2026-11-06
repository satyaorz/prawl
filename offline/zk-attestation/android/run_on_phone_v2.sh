#!/usr/bin/env bash
# For the COORDINATOR (the agent that wrote this did NOT run it and did not touch any phone).
# Same method as run_on_phone.sh, for circuit v2_factory (Samsung-style factory StrongBox chains) with the REAL
# Samsung StrongBox witness. v1_ca3 is proved again on the same phone run so the two circuits are compared in one
# session. Needs: android/bin/bb (arm64 PIE, built from the laptop bb's version), `nargo compile` done for v2,
# bench/out/v2_factory/{vk,p12/proof,p12/public_inputs} from `python3 bench/bench.py --only v2_factory`.
# Uses only /data/local/tmp/prawl_zk2; nothing is installed. Clean up: adb shell rm -rf /data/local/tmp/prawl_zk2
#   android/run_on_phone_v2.sh [adb-serial]      -> android/phone_v2_<serial>.log, android/out_v2_<serial>/
set -euo pipefail
cd "$(dirname "$0")/.."
S=${1:-$(adb devices | awk 'NR==2{print $1}')}
A="adb -s $S"
D=/data/local/tmp/prawl_zk2
BB=android/bin/bb
[ -x "$BB" ] || { echo "missing $BB"; exit 1; }
for f in circuits/v2_factory/target/v2_factory.json circuits/v2_factory/target/case_pos_samsung_strongbox_otk_sb.gz \
         bench/out/v2_factory/vk bench/out/v2_factory/p12/proof bench/out/v2_factory/p12/public_inputs; do
  [ -f "$f" ] || { echo "missing $f (run: python3 tools/run_tests.py v2 ; python3 bench/bench.py --only v2_factory)"; exit 1; }
done
$A shell "rm -rf $D && mkdir -p $D/crs $D/v2 $D/v1"
$A push "$BB" $D/bb >/dev/null
$A shell chmod 755 $D/bb
$A push ~/.bb-crs/bn254_g1.dat $D/crs/bn254_g1.dat >/dev/null    # 2^19 points (32 MiB); v2 needs only 2^18
# v2: the real Samsung StrongBox witness
$A push circuits/v2_factory/target/v2_factory.json $D/v2/circuit.json >/dev/null
$A push circuits/v2_factory/target/case_pos_samsung_strongbox_otk_sb.gz $D/v2/witness.gz >/dev/null
$A push bench/out/v2_factory/vk $D/v2/vk_laptop >/dev/null
$A shell mkdir -p $D/v2/laptop
$A push bench/out/v2_factory/p12/proof $D/v2/laptop/proof >/dev/null
$A push bench/out/v2_factory/p12/public_inputs $D/v2/laptop/public_inputs >/dev/null
# v1 (same session reference, OnePlus RKP witness as in run_on_phone.sh)
$A push circuits/v1_ca3/target/v1_ca3.json $D/v1/circuit.json >/dev/null
$A push circuits/v1_ca3/target/case_pos_oneplus_tee_rkp.gz $D/v1/witness.gz >/dev/null
$A push bench/out/v1_ca3/vk $D/v1/vk_laptop >/dev/null
NP=$($A shell nproc | tr -d '\r')
LOG=android/phone_v2_$S.log
T="toybox time -v"   # prints "Real time (s)" and "Max RSS (KiB)"
{
  echo "device: $($A shell getprop ro.product.model | tr -d '\r') soc: $($A shell getprop ro.soc.model | tr -d '\r') cores: $NP android: $($A shell getprop ro.build.version.release | tr -d '\r')"
  for d in v2 v1; do
    $A shell "cd $D/$d && ../bb write_vk -b circuit.json -o vkdir -t evm -c ../crs >/dev/null 2>&1; cmp vkdir/vk vk_laptop && echo '$d: phone vk == laptop vk' || echo '$d: VK MISMATCH'"
    for t in 1 4 $NP; do
      for i in 1 2 3; do
        echo "[$d prove threads=$t run=$i] $($A shell "cd $D/$d && rm -rf p && HARDWARE_CONCURRENCY=$t $T ../bb prove -b circuit.json -w witness.gz -k vk_laptop -o p -t evm -c ../crs 2>&1" | grep -iE 'num threads|real|max rss|error' | tr -d '\r' | tr '\n' ' ')"
      done
    done
    echo "[$d verify phone proof on phone] $($A shell "cd $D/$d && $T ../bb verify -p p/proof -k vk_laptop -i p/public_inputs -t evm -c ../crs 2>&1" | grep -iE 'verified|real|max rss|error' | tr -d '\r' | tr '\n' ' ')"
    mkdir -p android/out_v2_$S/$d
    $A pull $D/$d/p/proof android/out_v2_$S/$d/proof >/dev/null
    $A pull $D/$d/p/public_inputs android/out_v2_$S/$d/public_inputs >/dev/null
    n=$([ $d = v2 ] && echo v2_factory || echo v1_ca3)
    echo "[$d verify PHONE proof on laptop] $(bb verify -p android/out_v2_$S/$d/proof -k bench/out/$n/vk -i android/out_v2_$S/$d/public_inputs -t evm 2>&1 | grep -iE 'verified|error' | tr '\n' ' ')" 2>/dev/null || true
    echo "[$d proof bytes] $(wc -c < android/out_v2_$S/$d/proof)"
  done
  echo "[v2 verify LAPTOP proof on phone] $($A shell "cd $D/v2 && ../bb verify -p laptop/proof -k vk_laptop -i laptop/public_inputs -t evm -c ../crs 2>&1" | grep -iE 'verified|error' | tr -d '\r' | tr '\n' ' ')"
} 2>&1 | tee "$LOG"
