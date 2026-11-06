package xyz.prawl.otktest;

import android.app.Activity;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyInfo;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import android.util.Log;
import android.widget.ScrollView;
import android.widget.TextView;

import java.io.File;
import java.io.FileOutputStream;
import java.security.KeyFactory;
import java.security.KeyPairGenerator;
import java.security.KeyStore;
import java.security.PrivateKey;
import java.security.SecureRandom;
import java.security.Signature;
import java.security.cert.Certificate;
import java.security.spec.ECGenParameterSpec;

/**
 * Prawl one-time-key (OTK) hardware test.
 *
 * Question under test: does this phone's secure hardware enforce
 * KeyGenParameterSpec.setMaxUsageCount(1), so a coin key can sign exactly once?
 *
 * Every result is logged to logcat (tag PRAWL_OTK) and to files/results.txt;
 * attestation chains are written as PEM (leaf first) to files/*.pem for the
 * offline verifier (otk_verifier.py).
 *
 * Launch modes (intent extra "mode"):
 *   all (default)  run tests T0-T6
 *   reboot_check   after a reboot, check the persisted used key is still dead (T7)
 */
public class MainActivity extends Activity {
    static final String TAG = "PRAWL_OTK";
    static final String KS = "AndroidKeyStore";
    final StringBuilder out = new StringBuilder();
    TextView tv;

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        tv = new TextView(this);
        tv.setTextIsSelectable(true);
        tv.setPadding(24, 24, 24, 24);
        ScrollView sv = new ScrollView(this);
        sv.addView(tv);
        setContentView(sv);
        String mode = getIntent().getStringExtra("mode");
        final String m = mode == null ? "all" : mode;
        new Thread(() -> {
            try {
                if (m.equals("reboot_check")) rebootCheck(); else runAll();
            } catch (Throwable t) {
                log("FATAL " + t);
            }
            log("DONE");
            save("results_" + m + ".txt", out.toString());
        }).start();
    }

    void log(String s) {
        Log.i(TAG, s);
        out.append(s).append('\n');
        runOnUiThread(() -> tv.setText(out.toString()));
    }

    void save(String name, String content) {
        try (FileOutputStream f = new FileOutputStream(new File(getFilesDir(), name))) {
            f.write(content.getBytes("UTF-8"));
        } catch (Exception e) {
            Log.e(TAG, "save " + name + " failed: " + e);
        }
    }

    // ------------------------------------------------------------------ tests

    void runAll() throws Exception {
        PackageManager pm = getPackageManager();
        log("T0 device: " + Build.MANUFACTURER + " " + Build.MODEL + " (" + Build.DEVICE + "), Android "
                + Build.VERSION.RELEASE + " SDK " + Build.VERSION.SDK_INT + ", patch " + Build.VERSION.SECURITY_PATCH);
        log("T0 feature single_use_key=" + pm.hasSystemFeature("android.hardware.keystore.single_use_key")
                + " strongbox=" + pm.hasSystemFeature(PackageManager.FEATURE_STRONGBOX_KEYSTORE)
                + " keystore_limited_use_key=" + pm.hasSystemFeature("android.hardware.keystore.limited_use_key")
                + " app_attest_key=" + pm.hasSystemFeature("android.hardware.keystore.app_attest_key"));

        KeyStore ks = KeyStore.getInstance(KS);
        ks.load(null);
        for (String a : new String[]{"otk_tee", "otk_sb", "otk_race", "otk_count2", "otk_persist"})
            if (ks.containsAlias(a)) ks.deleteEntry(a);

        // T1/T2: TEE-backed single-use key: attest, sign once, sign again
        singleUse(ks, "otk_tee", false);
        // T3: StrongBox-backed single-use key (if the phone has StrongBox)
        if (pm.hasSystemFeature(PackageManager.FEATURE_STRONGBOX_KEYSTORE)) singleUse(ks, "otk_sb", true);
        else log("T3 skipped: no StrongBox");

        // T4: race via public API: begin two operations before finishing either
        race(ks, "otk_race");

        // T5: control: usage count 2 (spec says >1 may be software-enforced)
        KeyStore.PrivateKeyEntry e2 = gen("otk_count2", 2, false);
        if (e2 != null) {
            dumpChain("otk_count2", ks);
            keyInfo("T5", e2.getPrivateKey());
            for (int i = 1; i <= 3; i++) log("T5 count2 sign#" + i + ": " + trySign(ks, "otk_count2", "msg" + i));
        }

        // T6: persisted used key for the reboot check
        if (gen("otk_persist", 1, false) != null) {
            log("T6 persist sign#1: " + trySign(ks, "otk_persist", "coin->bob"));
            log("T6 persist alias still present after use: " + ks.containsAlias("otk_persist"));
            log("T6 now reboot the phone and launch with mode=reboot_check");
        }
    }

    void singleUse(KeyStore ks, String alias, boolean strongBox) throws Exception {
        String t = strongBox ? "T3" : "T1";
        KeyStore.PrivateKeyEntry e = gen(alias, 1, strongBox);
        if (e == null) return;
        dumpChain(alias, ks);
        keyInfo(t, e.getPrivateKey());
        log(t + " " + alias + " sign#1 (coin->Bob): " + trySign(ks, alias, "coin#1 -> Bob"));
        log(t + " " + alias + " alias present after 1 use: " + ks.containsAlias(alias));
        log(t + " " + alias + " sign#2 (same coin->Charlie, DOUBLE SPEND): " + trySign(ks, alias, "coin#1 -> Charlie"));
        log(t + " " + alias + " sign#3 (retry Bob): " + trySign(ks, alias, "coin#1 -> Bob"));
    }

    void race(KeyStore ks, String alias) throws Exception {
        if (gen(alias, 1, false) == null) return;
        PrivateKey k = (PrivateKey) ks.getKey(alias, null);
        String rA, rB;
        Signature a = Signature.getInstance("SHA256withECDSA");
        Signature b = Signature.getInstance("SHA256withECDSA");
        try { a.initSign(k); rA = "init ok"; } catch (Exception ex) { rA = "init FAIL " + ex; }
        try { b.initSign(k); rB = "init ok"; } catch (Exception ex) { rB = "init FAIL " + ex; }
        log("T4 race begin: A " + rA + " | B " + rB);
        log("T4 race finish A (coin->Bob): " + finish(a, "coin#1 -> Bob"));
        log("T4 race finish B (coin->Charlie): " + finish(b, "coin#1 -> Charlie"));
    }

    String finish(Signature s, String msg) {
        try {
            s.update(msg.getBytes("UTF-8"));
            byte[] sig = s.sign();
            return "SIGNED (" + sig.length + " B)";
        } catch (Throwable t) {
            return "REFUSED " + t.getClass().getSimpleName() + ": " + t.getMessage();
        }
    }

    KeyStore.PrivateKeyEntry gen(String alias, int maxUses, boolean strongBox) {
        try {
            byte[] challenge = new byte[32];
            new SecureRandom().nextBytes(challenge);
            KeyGenParameterSpec.Builder sb = new KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN)
                    .setAlgorithmParameterSpec(new ECGenParameterSpec("secp256r1"))
                    .setDigests(KeyProperties.DIGEST_SHA256)
                    .setMaxUsageCount(maxUses)
                    .setAttestationChallenge(challenge);
            if (strongBox) sb.setIsStrongBoxBacked(true);
            KeyPairGenerator g = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, KS);
            g.initialize(sb.build());
            g.generateKeyPair();
            KeyStore ks = KeyStore.getInstance(KS);
            ks.load(null);
            log("GEN " + alias + " maxUses=" + maxUses + " strongBox=" + strongBox + " OK");
            return (KeyStore.PrivateKeyEntry) ks.getEntry(alias, null);
        } catch (Throwable t) {
            log("GEN " + alias + " maxUses=" + maxUses + " strongBox=" + strongBox + " FAILED: " + t);
            return null;
        }
    }

    String trySign(KeyStore ks, String alias, String msg) {
        try {
            KeyStore k2 = KeyStore.getInstance(KS);
            k2.load(null);
            PrivateKey k = (PrivateKey) k2.getKey(alias, null);
            if (k == null) return "REFUSED: key no longer exists";
            Signature s = Signature.getInstance("SHA256withECDSA");
            s.initSign(k);
            return finish(s, msg);
        } catch (Throwable t) {
            return "REFUSED " + t.getClass().getSimpleName() + ": " + t.getMessage();
        }
    }

    void keyInfo(String t, PrivateKey k) {
        try {
            KeyFactory f = KeyFactory.getInstance(k.getAlgorithm(), KS);
            KeyInfo i = f.getKeySpec(k, KeyInfo.class);
            log(t + " KeyInfo securityLevel=" + i.getSecurityLevel()
                    + " (0=software 1=TEE 2=StrongBox) remainingUsageCount=" + i.getRemainingUsageCount());
        } catch (Throwable e) {
            log(t + " KeyInfo failed: " + e);
        }
    }

    void dumpChain(String alias, KeyStore ks) {
        try {
            Certificate[] chain = ks.getCertificateChain(alias);
            StringBuilder pem = new StringBuilder();
            for (Certificate c : chain) {
                pem.append("-----BEGIN CERTIFICATE-----\n")
                   .append(Base64.encodeToString(c.getEncoded(), Base64.DEFAULT))
                   .append("-----END CERTIFICATE-----\n");
            }
            save(alias + ".pem", pem.toString());
            log("CHAIN " + alias + ": " + chain.length + " certs saved to files/" + alias + ".pem");
        } catch (Throwable t) {
            log("CHAIN " + alias + " failed: " + t);
        }
    }

    void rebootCheck() throws Exception {
        KeyStore ks = KeyStore.getInstance(KS);
        ks.load(null);
        log("T7 reboot check: otk_persist present=" + ks.containsAlias("otk_persist"));
        log("T7 otk_persist sign after reboot: " + trySign(ks, "otk_persist", "coin->Charlie"));
    }
}
