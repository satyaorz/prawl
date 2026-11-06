#!/usr/bin/env bash
# Build the Prawl OTK test APK without Gradle: javac -> d8 -> aapt2 -> zipalign -> apksigner.
set -euo pipefail
cd "$(dirname "$0")"
SDK=${ANDROID_HOME:-$HOME/Android/Sdk}
BT=$SDK/build-tools/35.0.0
JAR=$SDK/platforms/android-35/android.jar
rm -rf build && mkdir -p build/classes build/dex
javac --release 11 -classpath "$JAR" -d build/classes $(find src -name '*.java')
"$BT/d8" --min-api 31 --lib "$JAR" --output build/dex $(find build/classes -name '*.class')
"$BT/aapt2" link -o build/unsigned.apk -I "$JAR" --manifest AndroidManifest.xml -A assets
(cd build/dex && zip -q ../unsigned.apk classes.dex)
"$BT/zipalign" -f 4 build/unsigned.apk build/aligned.apk
[ -f build_debug.keystore ] || keytool -genkeypair -keystore build_debug.keystore -storepass android \
  -keypass android -alias debug -keyalg RSA -keysize 2048 -validity 3650 -dname "CN=Prawl OTK test" >/dev/null 2>&1
"$BT/apksigner" sign --ks build_debug.keystore --ks-pass pass:android --key-pass pass:android \
  --out build/prawl-otk-test.apk build/aligned.apk
echo "built build/prawl-otk-test.apk"
