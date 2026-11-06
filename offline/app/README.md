# Prowl Android app

One app with two tabs: **Wallet** (the Prowl website in a WebView, so the on-chain private wallet is the same on the phone and in a browser) and
**Offline cash** (native screens: coins whose one-time key lives in the phone's secure hardware, paid over Bluetooth with no network).
The website talks to the native side through `window.prawlOffline` (see `../INTERFACE.md` and `../HANDOFF.md`).

```
core/   pure Kotlin library: protocol, verification, bridge rules (JVM tests, no Android)
app/    the Android app (Compose UI, Keystore, BLE, WebView + bridge)
```

## Build from a fresh clone

Needs: **JDK 17+** (Gradle downloads a JDK 17 toolchain if none is installed) and the **Android SDK** with platform 36 and
build-tools 35 (`ANDROID_HOME` set, or `sdk.dir=...` in `local.properties`). No other setup.

```
cd offline/app
./gradlew :core:test                                   # JVM tests
./gradlew :app:assemblePrawlDebug \
  -Pprawl.site=https://<your-wallet-site>              # APK: app/build/outputs/apk/prawl/debug/
./gradlew :app:installPrawlDebug -Pprawl.site=https://<your-wallet-site>   # build and install on the connected phone
```

`-Pprawl.site` is the website the **Wallet** tab shows (HTTPS only; debug builds may also use `http://localhost` through `adb reverse`).
Our deployment is `https://prawl-wallet.centralindia.cloudapp.azure.com`. Without the property the Wallet tab says it is not configured and the
Offline cash tab still works.

Flavors: `prawl` is the product app (`xyz.prawl.offline`). `compat` (`xyz.prawl.otktest`) is the same code under the old test-harness package,
used by the phone regression scripts in `../android/`.

### Signing key

The debug build is signed with `keystore/prawl-debug.keystore`. **The build creates it on first use** (password `android`; it is a debug key, not
a secret, and is git-ignored). The app's trust policy pins "package + signing certificate", and the build computes that certificate's SHA-256
from whatever key is there, so debug builds of one clone trust each other. Two clones have different keys, so to pay between phones running
builds from different clones, copy the same `keystore/prawl-debug.keystore` to both.

A **release** build trusts only `-Pprawl.release.certSha256=<production cert sha256>` (the default matches nothing), and the build refuses to
trust the debug certificate (audit finding F-11). Release builds must be signed with your production key.

### Passkeys inside the app

The Wallet tab uses passkeys, and Android only lets an app use a website's passkeys when that site proves it (Digital Asset Links):
`https://<site>/.well-known/assetlinks.json` must list this app's package and signing certificate. Print your build's fingerprint with

```
keytool -list -v -keystore keystore/prawl-debug.keystore -storepass android | grep SHA256
```

and add it to `apps/wallet/public/.well-known/assetlinks.json` (it may list several). This does not work for `http://localhost`: use an https
site. A passkey belongs to its domain, so changing the site later means new wallets.

## Debugging on a phone

Debug builds enable WebView debugging: forward `webview_devtools_remote_<pid>` and use Chrome DevTools, or `-e site <url>` on the launch intent to
override the site (saved until cleared with an empty value).

More: `RESULTS.md` (measured phone and on-chain results), `../README.md` (how the offline protocol works and a demo script).
