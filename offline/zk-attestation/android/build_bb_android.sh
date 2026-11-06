#!/usr/bin/env bash
# Rebuild android/bin/bb (Android arm64) from aztec-packages tag v5.0.0-nightly.20260324 with NDK r27b.
# CMake shell steps break on paths with spaces, so the build goes through a space-free symlink.
set -euo pipefail
Z="$(cd "$(dirname "$0")/.." && pwd)"
NDK=${NDK:-$HOME/Android/Sdk/ndk/27.1.12297006}
[ -d "$Z/deps/aztec" ] || { git clone -q --depth 1 --branch v5.0.0-nightly.20260324 --filter=blob:none --sparse \
    https://github.com/AztecProtocol/aztec-packages.git "$Z/deps/aztec"; git -C "$Z/deps/aztec" sparse-checkout set barretenberg/cpp;
    git -C "$Z/deps/aztec" apply "$Z/android/bb_android_ipc.patch"; }
L=$(mktemp -d)/bbcpp; ln -s "$Z/deps/aztec/barretenberg/cpp" "$L"
cmake -S "$L" -B "$L/build-android-ndk" -G Ninja -DCMAKE_TOOLCHAIN_FILE=$NDK/build/cmake/android.toolchain.cmake \
  -DANDROID_ABI=arm64-v8a -DANDROID_PLATFORM=android-33 -DCMAKE_BUILD_TYPE=Release -DBB_LITE=ON -DAVM=OFF \
  -DMULTITHREADING=ON -DHAVE_STD_REGEX=ON -DENABLE_PIC=ON -DARM=ON
ninja -C "$L/build-android-ndk" -j10 bb
mkdir -p "$Z/android/bin"
"$NDK/toolchains/llvm/prebuilt/linux-x86_64/bin/llvm-strip" -o "$Z/android/bin/bb" "$L/build-android-ndk/bin/bb"
sha256sum "$Z/android/bin/bb"
