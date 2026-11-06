#!/usr/bin/env bash
# For the COORDINATOR (the agent that built this did not touch any phone).
# Pushes android/bin/bb (Android arm64, NDK r27b, built from aztec-packages tag v5.0.0-nightly.20260324 = the laptop
# bb's version), the circuit artifacts, the REAL OnePlus witnesses, the laptop vks and the CRS to /data/local/tmp,
# then on the phone: write_vk (compared with the laptop vk), prove with 1 / 4 / all threads (3 runs each),
# verify the phone proof on the phone, verify the LAPTOP proof on the phone, and pulls the phone proof back to
# verify it with the laptop bb. Nothing is installed; delete with: adb shell rm -rf /data/local/tmp/prawl_zk
#   android/run_on_phone.sh [adb-serial]      -> android/phone_<serial>.log
set -euo pipefail
cd "$(dirname "$0")/.."
S=${1:-$(adb devices | awk 'NR==2{print $1}')}
A="adb -s $S"
D=/data/local/tmp/prawl_zk
BB=android/bin/bb
[ -x "$BB" ] || { echo "missing $BB"; exit 1; }
$A shell "rm -rf $D && mkdir -p $D/crs $D/v0 $D/v1"
$A push "$BB" $D/bb >/dev/null
$A shell chmod 755 $D/bb
$A push ~/.bb-crs/bn254_g1.dat $D/crs/bn254_g1.dat >/dev/null    # 2^19 points (32 MiB); bb would otherwise download it
for c in v0_leaf:v0 v1_ca3:v1; do
  n=${c%%:*}; d=${c##*:}
  $A push circuits/$n/target/$n.json $D/$d/circuit.json >/dev/null
  $A push circuits/$n/target/case_pos_oneplus_tee_rkp.gz $D/$d/witness.gz >/dev/null
  $A push bench/out/$n/vk $D/$d/vk_laptop >/dev/null
  $A shell mkdir -p $D/$d/laptop
  $A push bench/out/$n/p12/proof $D/$d/laptop/proof >/dev/null
  $A push bench/out/$n/p12/public_inputs $D/$d/laptop/public_inputs >/dev/null
done
NP=$($A shell nproc | tr -d '\r')
LOG=android/phone_$S.log
T="toybox time -v"   # prints "Real time (s)" and "Max RSS (KiB)"
{
  echo "device: $($A shell getprop ro.product.model | tr -d '\r') soc: $($A shell getprop ro.soc.model | tr -d '\r') cores: $NP android: $($A shell getprop ro.build.version.release | tr -d '\r')"
  for c in v0_leaf:v0 v1_ca3:v1; do
    n=${c%%:*}; d=${c##*:}
    $A shell "cd $D/$d && ../bb write_vk -b circuit.json -o vkdir -t evm -c ../crs >/dev/null 2>&1; cmp vkdir/vk vk_laptop && echo '$d: phone vk == laptop vk' || echo '$d: VK MISMATCH'"
    for t in 1 4 $NP; do
      for i in 1 2 3; do
        echo "[$d prove threads=$t run=$i] $($A shell "cd $D/$d && rm -rf p && HARDWARE_CONCURRENCY=$t $T ../bb prove -b circuit.json -w witness.gz -k vk_laptop -o p -t evm -c ../crs 2>&1" | grep -iE 'num threads|real|max rss|error' | tr -d '\r' | tr '\n' ' ')"
      done
    done
    echo "[$d verify phone proof on phone] $($A shell "cd $D/$d && $T ../bb verify -p p/proof -k vk_laptop -i p/public_inputs -t evm -c ../crs 2>&1" | grep -iE 'verified|real|max rss|error' | tr -d '\r' | tr '\n' ' ')"
    echo "[$d verify LAPTOP proof on phone] $($A shell "cd $D/$d && ../bb verify -p laptop/proof -k vk_laptop -i laptop/public_inputs -t evm -c ../crs 2>&1" | grep -iE 'verified|error' | tr -d '\r' | tr '\n' ' ')"
    mkdir -p android/out_$S/$d
    $A pull $D/$d/p/proof android/out_$S/$d/proof >/dev/null
    $A pull $D/$d/p/public_inputs android/out_$S/$d/public_inputs >/dev/null
    echo "[$d verify PHONE proof on laptop] $(bb verify -p android/out_$S/$d/proof -k bench/out/$n/vk -i android/out_$S/$d/public_inputs -t evm 2>&1 | grep -iE 'verified|error' | tr '\n' ' ')" 2>/dev/null || true
    echo "[$d proof bytes] $(wc -c < android/out_$S/$d/proof)"
  done
} 2>&1 | tee "$LOG"
