# Debug keystore (not tracked)
The debug APK signing key is local only. Create it once:

    keytool -genkeypair -keystore app/keystore/prawl-debug.keystore -storepass android -keypass android \
      -alias debug -keyalg RSA -keysize 2048 -validity 3650 -dname "CN=Prawl OTK test"

The recipient policy pins the genuine app by (package, signing-certificate SHA-256) in `ALLOWED_APPS`.
A freshly created key has a different digest: print it with
`keytool -list -v -keystore app/keystore/prawl-debug.keystore -storepass android | grep SHA256`
and put it in `ALLOWED_APPS` before testing between two builds.
