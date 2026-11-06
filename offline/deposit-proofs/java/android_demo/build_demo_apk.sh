#!/usr/bin/env bash
# Packaging check: a standalone APK (javac -> d8 -> aapt2 -> zip -> zipalign -> apksigner, no Gradle, same
# toolchain as seam_a_uncopyable/android_test/build.sh) containing DepositProof + DepositProofActivity,
# lib/<abi>/libprawlbls.so and the shared test vectors as assets. Builds only; does not install.
set -euo pipefail
cd "$(dirname "$0")"
SDK=${ANDROID_HOME:-$HOME/Android/Sdk}
BT=$SDK/build-tools/35.0.0
JAR=$SDK/platforms/android-35/android.jar
NATIVE=../native/lib
[ -f $NATIVE/arm64-v8a/libprawlbls.so ] || ../native/build_native.sh
rm -rf build && mkdir -p build/classes build/dex build/assets/deposit_proofs/vectors build/apkroot/lib
cp ../../data/vectors/*.json build/assets/deposit_proofs/vectors/
javac --release 11 -classpath "$JAR" -d build/classes ../src/xyz/prawl/otktest/DepositProof.java src/xyz/prawl/otktest/DepositProofActivity.java
"$BT/d8" --min-api 31 --lib "$JAR" --output build/dex $(find build/classes -name '*.class')
"$BT/aapt2" link -o build/unsigned.apk -I "$JAR" --manifest AndroidManifest.xml -A build/assets
for abi in arm64-v8a x86_64; do mkdir -p build/apkroot/lib/$abi && cp $NATIVE/$abi/libprawlbls.so build/apkroot/lib/$abi/; done
(cd build/dex && zip -q ../unsigned.apk classes.dex)
(cd build/apkroot && zip -q -0 -r ../unsigned.apk lib)          # stored (uncompressed) .so
"$BT/zipalign" -f -P 16 4 build/unsigned.apk build/aligned.apk   # 16 KiB page-align .so (Android 15+ devices)
[ -f build_demo.keystore ] || keytool -genkeypair -keystore build_demo.keystore -storepass android -keypass android \
  -alias debug -keyalg RSA -keysize 2048 -validity 3650 -dname "CN=Prowl deposit proof demo" >/dev/null 2>&1
"$BT/apksigner" sign --ks build_demo.keystore --ks-pass pass:android --key-pass pass:android --out build/deposit-proof-demo.apk build/aligned.apk
"$BT/zipalign" -c -P 16 -v 4 build/deposit-proof-demo.apk | grep -E 'lib/|Verification' || true
"$BT/apksigner" verify build/deposit-proof-demo.apk && echo "signed OK"
unzip -l build/deposit-proof-demo.apk | grep -E 'classes.dex|libprawlbls|manifest.json'
echo "built build/deposit-proof-demo.apk ($(stat -c %s build/deposit-proof-demo.apk) bytes)"
