#!/usr/bin/env bash
# Build libprawlbls.so (blst v0.3.17 + prawlbls_jni.c) for:
#   host   : linux-x86_64 (JVM test harness on the laptop)
#   android: arm64-v8a and x86_64 (NDK clang, API 31 = the app's --min-api)
# Output: java/native/lib/<abi>/libprawlbls.so
set -euo pipefail
cd "$(dirname "$0")"
HERE=$PWD
BLST_TGZ=third_party/blst-0.3.17.tar.gz
BLST_SHA256=c3fef37b566b67419703b2bbb648e15176276af9a880c22aa8f5f2e8cecc2e4d  # tag v0.3.17 = commit 54e6e556
echo "$BLST_SHA256  $BLST_TGZ" | sha256sum -c -
rm -rf build && mkdir -p build lib

NDK=${ANDROID_NDK:-${ANDROID_HOME:-$HOME/Android/Sdk}/ndk/27.1.12297006}
TC=$NDK/toolchains/llvm/prebuilt/linux-x86_64/bin
declare -A AR_FOR=([arm64-v8a]=$NDK/toolchains/llvm/prebuilt/linux-x86_64/bin/llvm-ar [x86_64]=$NDK/toolchains/llvm/prebuilt/linux-x86_64/bin/llvm-ar)
JDK_INC=${JDK_INC:-$(dirname "$(dirname "$(readlink -f "$(command -v javac)")")")/include}

build_one() {  # abi cc extra_cflags jni_includes
    local abi=$1 cc=$2 jni_inc=$3
    local b=build/$abi
    mkdir -p "$b" lib/"$abi"
    tar xzf "$BLST_TGZ" -C "$b"
    # blst's own build script; CC selects the target, asm is used on x86_64 and aarch64.
    (cd "$b" && CC="$cc" AR="${AR_FOR[$abi]:-}" sh blst-0.3.17/build.sh -D__BLST_PORTABLE__ >/dev/null)
    "$cc" -O2 -fPIC -shared -Wall -Wextra -Werror $jni_inc -I"$b/blst-0.3.17/bindings" \
        prawlbls_jni.c "$b/libblst.a" -o lib/"$abi"/libprawlbls.so -Wl,-z,max-page-size=16384 -Wl,--gc-sections -s
    echo "built lib/$abi/libprawlbls.so ($(stat -c %s lib/"$abi"/libprawlbls.so) bytes)"
}

build_one linux-x86_64 "${HOST_CC:-gcc}" "-I$JDK_INC -I$JDK_INC/linux"
if [ -x "$TC/aarch64-linux-android31-clang" ]; then
    build_one arm64-v8a "$TC/aarch64-linux-android31-clang" ""
    build_one x86_64    "$TC/x86_64-linux-android31-clang" ""
else
    echo "NDK not found at $NDK; skipped Android builds" >&2
fi
sha256sum lib/*/libprawlbls.so
