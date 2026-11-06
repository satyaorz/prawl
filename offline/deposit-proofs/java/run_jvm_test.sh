#!/usr/bin/env bash
# Laptop test of DepositProof.java (same source the app uses) against the Python-produced vectors.
#   1. javac --release 11 (as the app's build.sh) ; 2. d8 --min-api 31 against android.jar (Android-buildability check)
#   3. java DepositProofTest with the host build of libprawlbls.so
set -euo pipefail
cd "$(dirname "$0")"
SDK=${ANDROID_HOME:-$HOME/Android/Sdk}
BT=$SDK/build-tools/35.0.0
JAR=$SDK/platforms/android-35/android.jar
[ -f native/lib/linux-x86_64/libprawlbls.so ] || ./native/build_native.sh
rm -rf build && mkdir -p build/classes build/dex build/android-classes
javac --release 11 -Xlint:all -d build/classes src/xyz/prawl/otktest/DepositProof.java test/xyz/prawl/otktest/DepositProofTest.java
if [ -f "$JAR" ]; then
    javac --release 11 -classpath "$JAR" -d build/android-classes src/xyz/prawl/otktest/DepositProof.java
    "$BT/d8" --min-api 31 --lib "$JAR" --output build/dex $(find build/android-classes -name '*.class')
    echo "d8 OK: build/dex/classes.dex ($(stat -c %s build/dex/classes.dex) bytes)"
fi
JAVA=${JAVA:-java}
"$JAVA" --enable-native-access=ALL-UNNAMED -cp build/classes xyz.prawl.otktest.DepositProofTest ../data "$PWD/native/lib/linux-x86_64/libprawlbls.so"
