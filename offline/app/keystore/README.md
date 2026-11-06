# Debug keystore (not tracked)
`prawl-debug.keystore` is created by the first Gradle build (alias `debug`, password `android`). It is a debug key, not a secret, and is
git-ignored. To make it by hand:

    keytool -genkeypair -keystore app/keystore/prawl-debug.keystore -storepass android -keypass android \
      -alias debug -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=Prawl OTK test"

The build computes the certificate's SHA-256 from this file and pins the app by (package, certificate), so nothing needs editing. Print it with
`keytool -list -v -keystore keystore/prawl-debug.keystore -storepass android | grep SHA256` (needed for the website's `assetlinks.json`).
Builds from different clones have different keys: to pay between phones running them, copy the same keystore to both clones.
