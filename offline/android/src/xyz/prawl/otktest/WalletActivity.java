package xyz.prawl.otktest;

import android.app.Activity;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import android.util.Log;
import android.widget.ScrollView;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.security.KeyPairGenerator;
import java.security.KeyStore;
import java.security.PrivateKey;
import java.security.PublicKey;
import java.security.SecureRandom;
import java.security.Signature;
import java.security.cert.Certificate;
import java.security.spec.ECGenParameterSpec;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * Prowl one-time-key (OTK) coin wallet: two-phone test harness.
 *
 * A coin is a chain of hops. Each holder owns the coin through a fresh attested
 * key created with setMaxUsageCount(1); paying = that key's single signature over
 * (coinId, value, hop index, previous-hop hash, recipient key hash). The secure
 * hardware refuses a second signature, so a holder cannot fork the coin.
 *
 * The recipient verifies, fully offline on its own phone:
 *   - the coin's genesis key appears in the deposit snapshot synced from the chain
 *   - every key in the history has a valid Google attestation proving hardware-
 *     enforced single use (OtkVerify)
 *   - every hop signature, and that the last hop pays the recipient's own key.
 *
 * Commands (intent extra "cmd"); files are read from files/in/ and written to files/out/:
 *   mint      coin, value [, multiuse=true for the cheat test]  -> out/mint_<coin>.json
 *   request   name                                             -> out/req_<name>.json
 *   pay       coin, req (file in in/)                          -> out/pay_<coin>_<name>.json
 *   accept    pay (file in in/), name, snapshot (file in in/)  -> stores the coin if valid
 *   show                                                       -> lists holdings
 * Every result is logged under tag PRAWL_WALLET and ends with "END <status>".
 */
public class WalletActivity extends Activity {
    static final String TAG = "PRAWL_WALLET";
    static final String KS = "AndroidKeyStore";
    final StringBuilder out = new StringBuilder();
    TextView tv;
    File in, outDir, wallet;

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        tv = new TextView(this);
        tv.setTextIsSelectable(true);
        tv.setPadding(24, 24, 24, 24);
        tv.setTextSize(13);
        ScrollView sv = new ScrollView(this);
        sv.addView(tv);
        setContentView(sv);
        in = new File(getFilesDir(), "in"); in.mkdirs();
        outDir = new File(getFilesDir(), "out"); outDir.mkdirs();
        wallet = new File(getFilesDir(), "wallet"); wallet.mkdirs();
        final Bundle x = getIntent().getExtras() == null ? new Bundle() : getIntent().getExtras();
        new Thread(() -> {
            String status;
            try { status = run(x); } catch (Throwable t) { log("ERROR " + t); status = "ERROR"; }
            log("END " + status);
        }).start();
    }

    void log(String s) {
        Log.i(TAG, s);
        out.append(s).append('\n');
        runOnUiThread(() -> tv.setText(out.toString()));
    }

    String run(Bundle x) throws Exception {
        String cmd = x.getString("cmd", "show");
        log("cmd=" + cmd + " on " + android.os.Build.MANUFACTURER + " " + android.os.Build.MODEL);
        switch (cmd) {
            case "mint": return mint(x.getString("coin"), x.getString("value"), "true".equals(x.getString("multiuse")));
            case "request": return request(x.getString("name"));
            case "pay": return pay(x.getString("coin"), x.getString("req"));
            case "accept": return accept(x.getString("pay"), x.getString("name"), x.getString("snapshot"));
            case "redeem": return redeem(x.getString("coin"), x.getString("chainId"), x.getString("escrow"), x.getString("payout"));
            default: return show();
        }
    }

    // ------------------------------------------------------------ key handling

    /** New attested P-256 signing key, single-use; StrongBox if present, else TEE. */
    JSONArray newCoinKey(String alias, boolean multiuse) throws Exception {
        KeyStore ks = KeyStore.getInstance(KS); ks.load(null);
        if (ks.containsAlias(alias)) ks.deleteEntry(alias);
        boolean sb = getPackageManager().hasSystemFeature(PackageManager.FEATURE_STRONGBOX_KEYSTORE);
        byte[] ch = new byte[32]; new SecureRandom().nextBytes(ch);
        KeyGenParameterSpec.Builder s = new KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN)
                .setAlgorithmParameterSpec(new ECGenParameterSpec("secp256r1"))
                .setDigests(KeyProperties.DIGEST_SHA256)
                .setAttestationChallenge(ch);
        if (!multiuse) s.setMaxUsageCount(1);
        if (sb) s.setIsStrongBoxBacked(true);
        KeyPairGenerator g = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, KS);
        g.initialize(s.build());
        g.generateKeyPair();
        JSONArray chain = new JSONArray();
        for (Certificate c : ks.getCertificateChain(alias)) chain.put(Base64.encodeToString(c.getEncoded(), Base64.NO_WRAP));
        log("new key " + alias + (sb ? " [StrongBox]" : " [TEE]") + (multiuse ? " MULTI-USE (cheat)" : " single-use"));
        return chain;
    }

    static List<byte[]> der(JSONArray chain) throws Exception {
        List<byte[]> l = new ArrayList<>();
        for (int i = 0; i < chain.length(); i++) l.add(Base64.decode(chain.getString(i), Base64.NO_WRAP));
        return l;
    }

    static String leafHash(JSONArray chain) throws Exception {
        return OtkVerify.sha256Hex(OtkVerify.parseChain(der(chain)).get(0).getPublicKey().getEncoded());
    }

    static byte[] hopMessage(String coin, String value, int hop, String prevHash, String toKeyHash) {
        return ("PRAWL-OTK-v1|" + coin + "|" + value + "|" + hop + "|" + prevHash + "|" + toKeyHash)
                .getBytes(java.nio.charset.StandardCharsets.UTF_8);
    }

    static String mintHash(JSONObject mint) throws Exception {
        return OtkVerify.sha256Hex((mint.getString("coinId") + "|" + mint.getString("value") + "|"
                + leafHash(mint.getJSONArray("chain"))).getBytes("UTF-8"));
    }

    // ------------------------------------------------------------ commands

    String mint(String coin, String value, boolean multiuse) throws Exception {
        String alias = "coin_" + coin + "_0";
        JSONObject mint = new JSONObject().put("coinId", coin).put("value", value)
                .put("chain", newCoinKey(alias, multiuse));
        write(new File(outDir, "mint_" + coin + ".json"), mint.toString(2));
        JSONObject hold = new JSONObject().put("coinId", coin).put("value", value).put("alias", alias)
                .put("payment", new JSONObject().put("coinId", coin).put("value", value)
                        .put("mint", mint).put("hops", new JSONArray()));
        write(new File(wallet, "hold_" + coin + ".json"), hold.toString(2));
        log("MINTED coin " + coin + " value " + value + " ETH; genesis key hash " + leafHash(mint.getJSONArray("chain")).substring(0, 16)
                + ". (In production this key is committed by the on-chain deposit.)");
        return "OK";
    }

    String request(String name) throws Exception {
        String alias = "recv_" + name;
        JSONObject req = new JSONObject().put("name", name).put("chain", newCoinKey(alias, false));
        write(new File(outDir, "req_" + name + ".json"), req.toString(2));
        log("RECEIVE REQUEST for '" + name + "', key hash " + leafHash(req.getJSONArray("chain")).substring(0, 16));
        return "OK";
    }

    String pay(String coin, String reqFile) throws Exception {
        JSONObject hold = new JSONObject(read(new File(wallet, "hold_" + coin + ".json")));
        JSONObject req = new JSONObject(read(new File(in, reqFile)));
        JSONObject payment = hold.getJSONObject("payment");
        JSONArray hops = payment.getJSONArray("hops");
        int hop = hops.length();
        String prev = hop == 0 ? mintHash(payment.getJSONObject("mint"))
                : OtkVerify.sha256Hex(Base64.decode(hops.getJSONObject(hop - 1).getString("sig"), Base64.NO_WRAP));
        String toHash = leafHash(req.getJSONArray("chain"));
        byte[] msg = hopMessage(coin, hold.getString("value"), hop, prev, toHash);
        log("PAY coin " + coin + " (" + hold.getString("value") + " ETH) hop " + hop + " -> '" + req.getString("name")
                + "' using key " + hold.getString("alias"));
        byte[] sig;
        try {
            KeyStore ks = KeyStore.getInstance(KS); ks.load(null);
            PrivateKey k = (PrivateKey) ks.getKey(hold.getString("alias"), null);
            if (k == null) throw new Exception("coin key no longer exists (already used once)");
            Signature s = Signature.getInstance("SHA256withECDSA");
            s.initSign(k);
            s.update(msg);
            sig = s.sign();
        } catch (Throwable t) {
            log("REFUSED BY SECURE HARDWARE: " + t.getMessage().split("\n")[0]);
            return "REFUSED";
        }
        JSONObject outPay = new JSONObject(payment.toString());
        outPay.getJSONArray("hops").put(new JSONObject().put("to", req.getJSONArray("chain"))
                .put("sig", Base64.encodeToString(sig, Base64.NO_WRAP)));
        String name = "pay_" + coin + "_" + req.getString("name") + ".json";
        // Persist the signed payment before handing it over, so a retry resends the same bytes.
        write(new File(outDir, name), outPay.toString(2));
        hold.put("spentTo", req.getString("name"));
        write(new File(wallet, "hold_" + coin + ".json"), hold.toString(2));
        log("SIGNED hop " + hop + " (" + sig.length + " B sig). Payment file " + name + " is "
                + outPay.toString().length() + " B.");
        return "OK";
    }

    String accept(String payFile, String name, String snapFile) throws Exception {
        long t0 = System.nanoTime();
        JSONObject p = new JSONObject(read(new File(in, payFile)));
        JSONObject snap = new JSONObject(read(new File(in, snapFile)));
        OtkVerify v = verifier();
        String coin = p.getString("coinId"), value = p.getString("value");
        JSONObject mint = p.getJSONObject("mint");
        log("ACCEPT? coin " + coin + " value " + value + " ETH, " + p.getJSONArray("hops").length() + " hop(s), as '" + name + "'");
        List<String> fails = new ArrayList<>();
        // 1. deposit exists in the last synced snapshot of the escrow contract
        String k0 = leafHash(mint.getJSONArray("chain"));
        boolean dep = false;
        JSONArray deps = snap.getJSONArray("deposits");
        for (int i = 0; i < deps.length(); i++) {
            JSONObject d = deps.getJSONObject(i);
            if (d.getString("coinId").equals(coin) && d.getString("value").equals(value) && d.getString("k0").equals(k0)) dep = true;
        }
        if (!mint.getString("coinId").equals(coin) || !mint.getString("value").equals(value)) fails.add("mint record mismatch");
        log("  [1] deposit in synced snapshot: " + (dep ? "yes" : "NO"));
        if (!dep) fails.add("coin not backed by a known deposit");
        // 2. genesis key attestation
        OtkVerify.Result r0 = v.verify(der(mint.getJSONArray("chain")));
        log("  [2] genesis key attestation: " + r0.summary());
        if (!r0.ok) fails.add("genesis key not a hardware one-time key");
        // 3. every hop
        PublicKey signer = r0.leafKey;
        String prev = mintHash(mint);
        JSONArray hops = p.getJSONArray("hops");
        String lastTo = null;
        for (int i = 0; i < hops.length(); i++) {
            JSONObject h = hops.getJSONObject(i);
            JSONArray to = h.getJSONArray("to");
            OtkVerify.Result rt = v.verify(der(to));
            byte[] sig = Base64.decode(h.getString("sig"), Base64.NO_WRAP);
            boolean sigOk = false;
            if (signer != null) {
                Signature s = Signature.getInstance("SHA256withECDSA");
                s.initVerify(signer);
                s.update(hopMessage(coin, value, i, prev, leafHash(to)));
                try { sigOk = s.verify(sig); } catch (Exception e) { sigOk = false; }
            }
            log("  [3." + i + "] hop " + i + " signature " + (sigOk ? "valid" : "INVALID") + "; next key attestation: " + rt.summary());
            if (!sigOk) fails.add("hop " + i + " signature invalid");
            if (!rt.ok) fails.add("hop " + i + " recipient key not a hardware one-time key");
            signer = rt.leafKey;
            prev = OtkVerify.sha256Hex(sig);
            lastTo = rt.leafKeyHash;
        }
        // 4. last hop pays MY pending receive key
        KeyStore ks = KeyStore.getInstance(KS); ks.load(null);
        String myAlias = "recv_" + name;
        Certificate mine = ks.getCertificate(myAlias);
        String myHash = mine == null ? "none" : OtkVerify.sha256Hex(mine.getPublicKey().getEncoded());
        boolean toMe = hops.length() > 0 && myHash.equals(lastTo);
        log("  [4] last hop pays my key '" + myAlias + "': " + (toMe ? "yes" : "NO"));
        if (!toMe) fails.add("payment is not addressed to my key");
        long ms = (System.nanoTime() - t0) / 1_000_000;
        if (!fails.isEmpty()) {
            log("REJECTED in " + ms + " ms: " + fails);
            return "REJECTED";
        }
        JSONObject hold = new JSONObject().put("coinId", coin).put("value", value).put("alias", myAlias).put("payment", p);
        write(new File(wallet, "hold_" + coin + ".json"), hold.toString(2));
        log("ACCEPTED in " + ms + " ms: I now hold coin " + coin + " (" + value + " ETH), spendable once with key " + myAlias);
        return "ACCEPTED";
    }

    /** Final hop: the holder's one-time key signs the payout address instead of a next owner. */
    String redeem(String coin, String chainId, String escrow, String payout) throws Exception {
        JSONObject hold = new JSONObject(read(new File(wallet, "hold_" + coin + ".json")));
        JSONObject payment = hold.getJSONObject("payment");
        JSONArray hops = payment.getJSONArray("hops");
        int hop = hops.length();
        String prev = hop == 0 ? mintHash(payment.getJSONObject("mint"))
                : OtkVerify.sha256Hex(Base64.decode(hops.getJSONObject(hop - 1).getString("sig"), Base64.NO_WRAP));
        String e40 = escrow.toLowerCase().replace("0x", ""), p40 = payout.toLowerCase().replace("0x", "");
        String toHash = OtkVerify.sha256Hex(("PRAWL-REDEEM|" + chainId + "|" + e40 + "|" + p40).getBytes("UTF-8"));
        byte[] msg = hopMessage(coin, payment.getString("value"), hop, prev, toHash);
        byte[] sig;
        try {
            KeyStore ks = KeyStore.getInstance(KS); ks.load(null);
            PrivateKey k = (PrivateKey) ks.getKey(hold.getString("alias"), null);
            if (k == null) throw new Exception("coin key no longer exists (already used once)");
            Signature s = Signature.getInstance("SHA256withECDSA"); s.initSign(k); s.update(msg); sig = s.sign();
        } catch (Throwable t) { log("REFUSED BY SECURE HARDWARE: " + t.getMessage()); return "REFUSED"; }
        JSONObject r = new JSONObject(payment.toString()).put("redeem", new JSONObject().put("chainId", chainId)
                .put("escrow", escrow).put("payout", payout).put("hop", hop).put("sig", Base64.encodeToString(sig, Base64.NO_WRAP)));
        write(new File(outDir, "redeem_" + coin + ".json"), r.toString(2));
        hold.put("spentTo", "REDEEM " + payout);
        write(new File(wallet, "hold_" + coin + ".json"), hold.toString(2));
        log("REDEEM SIGNED: coin " + coin + " hop " + hop + " pays out to " + payout + " on chain " + chainId + " via escrow " + escrow);
        return "OK";
    }

    String show() throws Exception {
        File[] fs = wallet.listFiles();
        if (fs != null) for (File f : fs) {
            JSONObject h = new JSONObject(read(f));
            log("HOLD " + h.getString("coinId") + " " + h.getString("value") + " ETH key=" + h.getString("alias")
                    + (h.has("spentTo") ? " (spent to " + h.getString("spentTo") + ")" : ""));
        }
        return "OK";
    }

    // ------------------------------------------------------------ io

    OtkVerify verifier() throws Exception {
        List<byte[]> roots = new ArrayList<>();
        String pem = new String(asset("roots.pem"), "UTF-8");
        for (String part : pem.split("-----END CERTIFICATE-----")) {
            String b = part.replace("-----BEGIN CERTIFICATE-----", "").replaceAll("\\s", "");
            if (!b.isEmpty()) roots.add(Base64.decode(b, Base64.DEFAULT));
        }
        Set<String> rev = new HashSet<>();
        for (String line : new String(asset("revoked.txt"), "UTF-8").split("\n")) if (!line.trim().isEmpty()) rev.add(line.trim());
        return new OtkVerify(roots, rev);
    }

    byte[] asset(String n) throws Exception { try (InputStream i = getAssets().open(n)) { return readAll(i); } }
    static String read(File f) throws Exception { try (InputStream i = new FileInputStream(f)) { return new String(readAll(i), "UTF-8"); } }
    static void write(File f, String s) throws Exception { try (FileOutputStream o = new FileOutputStream(f)) { o.write(s.getBytes("UTF-8")); } }
    static byte[] readAll(InputStream i) throws Exception {
        ByteArrayOutputStream b = new ByteArrayOutputStream(); byte[] buf = new byte[8192]; int n;
        while ((n = i.read(buf)) > 0) b.write(buf, 0, n);
        return b.toByteArray();
    }
}
