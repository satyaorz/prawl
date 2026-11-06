package xyz.prawl.otktest;

import android.app.Activity;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothServerSocket;
import android.bluetooth.BluetoothSocket;
import android.content.pm.PackageManager;
import android.hardware.biometrics.BiometricManager;
import android.hardware.biometrics.BiometricPrompt;
import android.os.Bundle;
import android.os.CancellationSignal;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import android.util.Log;
import android.widget.ScrollView;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.security.KeyPairGenerator;
import java.security.KeyStore;
import java.security.MessageDigest;
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
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import java.util.zip.Deflater;

/**
 * Prowl OTK wallet v2: hardened coin protocol + Bluetooth transport.
 *
 * Changes from v1 (WalletActivity):
 *  - Coin carries an expiry; hop message v2 commits to it. Recipient enforces
 *    remaining lifetime, a hop limit and a value cap.
 *  - Recipient checks the key was created by the genuine Prowl app (package and
 *    signing-cert digest from attestationApplicationId) on a recent patch level.
 *  - Revocation-list freshness: if the cached list is older than 48 h, only
 *    small coins are accepted.
 *  - Optional per-spend user authentication (fingerprint / PIN) bound to the key
 *    in hardware; a silent signing attempt fails.
 *  - Compact payments: certificates deduplicated by hash, pinned roots never sent,
 *    and certificates the recipient already has (listed in its request) skipped.
 *  - Bluetooth RFCOMM transport: request -> payment -> verdict over one link.
 *
 * Commands (extra "cmd"); files in files/in, files/out, files/wallet, files/certs:
 *   mint     coin value [expiresIn seconds, default 14 d] [multiuse] [auth]
 *   request  name [auth]
 *   pay      coin req [silent=true: sign without prompting, to show it fails]
 *   accept   pay name snapshot
 *   bt_receive name snapshot            (listens, sends request, verifies payment)
 *   bt_pay   coin addr                  (connects, signs, sends payment)
 *   show
 */
public class Wallet2Activity extends Activity {
    static final String TAG = "PRAWL_W2";
    static final String KS = "AndroidKeyStore";
    static final UUID BT_UUID = UUID.fromString("5f1c0b6e-6a35-4bd0-9c39-7072617776c2");

    // ---- recipient policy (hardening v2) ----
    static final String PKG = "xyz.prawl.otktest";
    static final String APP_DIGEST = "e6e0daae1031f70e5a267a383878ac564a935106f75600310feda6bf1ea92eaf";
    static final int MIN_PATCH = 202601;
    static final int MAX_HOPS = 3;
    static final BigDecimal CAP = new BigDecimal("1.0");
    static final BigDecimal STALE_CAP = new BigDecimal("0.05");
    static final long MIN_REMAINING_S = 3600;
    static final long REVOCATION_FETCHED = 1793878668L;   // 2026-11-05T11:37:48Z (status.hdr Date)
    static final long REVOCATION_MAX_AGE_S = 48 * 3600;

    final StringBuilder out = new StringBuilder();
    TextView tv;
    File in, outDir, wallet, certDir;

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
        in = mk("in"); outDir = mk("out"); wallet = mk("wallet"); certDir = mk("certs");
        final Bundle x = getIntent().getExtras() == null ? new Bundle() : getIntent().getExtras();
        if ("perm".equals(x.getString("cmd"))) {
            log("requesting Bluetooth permission: tap Allow");
            requestPermissions(new String[]{android.Manifest.permission.BLUETOOTH_CONNECT,
                    android.Manifest.permission.BLUETOOTH_SCAN}, 7);
            return;
        }
        new Thread(() -> {
            String status;
            try { status = run(x); } catch (Throwable t) { log("ERROR " + t); Log.e(TAG, "err", t); status = "ERROR"; }
            log("END " + status);
        }).start();
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] perms, int[] res) {
        StringBuilder b = new StringBuilder();
        for (int i = 0; i < perms.length; i++) b.append(perms[i].replace("android.permission.", "")).append('=')
                .append(res[i] == PackageManager.PERMISSION_GRANTED ? "granted " : "DENIED ");
        log("permission result: " + b);
        log("END " + (b.indexOf("DENIED") < 0 ? "OK" : "DENIED"));
    }

    File mk(String n) { File f = new File(getFilesDir(), n); f.mkdirs(); return f; }

    void log(String s) {
        Log.i(TAG, s);
        out.append(s).append('\n');
        runOnUiThread(() -> tv.setText(out.toString()));
    }

    String run(Bundle x) throws Exception {
        String cmd = x.getString("cmd", "show");
        log("cmd=" + cmd + " on " + android.os.Build.MANUFACTURER + " " + android.os.Build.MODEL);
        boolean auth = "true".equals(x.getString("auth"));
        switch (cmd) {
            case "mint": return mint(x.getString("coin"), x.getString("value"),
                    Long.parseLong(x.getString("expiresIn", String.valueOf(14 * 86400))),
                    "true".equals(x.getString("multiuse")), auth);
            case "request": {
                JSONObject req = request(x.getString("name"), auth);
                write(new File(outDir, "req_" + x.getString("name") + ".json"), req.toString());
                return "OK";
            }
            case "pay": {
                JSONObject req = new JSONObject(read(new File(in, x.getString("req"))));
                JSONObject p = pay(x.getString("coin"), req, "true".equals(x.getString("silent")));
                if (p == null) return "REFUSED";
                write(new File(outDir, "pay_" + x.getString("coin") + "_" + req.getString("name") + ".json"), p.toString());
                return "OK";
            }
            case "accept":
                return accept(new JSONObject(read(new File(in, x.getString("pay")))), x.getString("name"),
                        new JSONObject(read(new File(in, x.getString("snapshot")))));
            case "bt_receive": return btReceive(x.getString("name"), x.getString("snapshot"), auth);
            case "bt_pay": return btPay(x.getString("coin"), x.getString("addr"), "true".equals(x.getString("drop")));
            default: return show();
        }
    }

    // ================================================================ keys

    JSONArray newCoinKey(String alias, boolean multiuse, boolean auth) throws Exception {
        KeyStore ks = KeyStore.getInstance(KS); ks.load(null);
        if (ks.containsAlias(alias)) ks.deleteEntry(alias);
        boolean sb = getPackageManager().hasSystemFeature(PackageManager.FEATURE_STRONGBOX_KEYSTORE);
        byte[] ch = new byte[32]; new SecureRandom().nextBytes(ch);
        KeyGenParameterSpec.Builder s = new KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN)
                .setAlgorithmParameterSpec(new ECGenParameterSpec("secp256r1"))
                .setDigests(KeyProperties.DIGEST_SHA256)
                .setAttestationChallenge(ch);
        if (!multiuse) s.setMaxUsageCount(1);
        if (auth) s.setUserAuthenticationRequired(true)
                .setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG | KeyProperties.AUTH_DEVICE_CREDENTIAL);
        if (sb) s.setIsStrongBoxBacked(true);
        long t0 = System.nanoTime();
        KeyPairGenerator g = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, KS);
        g.initialize(s.build());
        g.generateKeyPair();
        long ms = (System.nanoTime() - t0) / 1_000_000;
        JSONArray hashes = new JSONArray();
        for (Certificate c : ks.getCertificateChain(alias)) hashes.put(putCert(c.getEncoded()));
        log("new key " + alias + (sb ? " [StrongBox]" : " [TEE]") + (multiuse ? " MULTI-USE (cheat)" : " single-use")
                + (auth ? " +auth-per-spend" : "") + " in " + ms + " ms");
        return hashes;
    }

    // ================================================================ cert store

    static String h(byte[] der) throws Exception {
        byte[] d = MessageDigest.getInstance("SHA-256").digest(der);
        StringBuilder s = new StringBuilder();
        for (int i = 0; i < 16; i++) s.append(String.format("%02x", d[i]));   // 128-bit id
        return s.toString();
    }

    String putCert(byte[] der) throws Exception {
        String id = h(der);
        File f = new File(certDir, id);
        if (!f.exists()) try (FileOutputStream o = new FileOutputStream(f)) { o.write(der); }
        return id;
    }

    byte[] getCert(String id, JSONObject carried) throws Exception {
        if (carried != null && carried.has(id)) {
            byte[] d = Base64.decode(carried.getString(id), Base64.NO_WRAP);
            if (!h(d).equals(id)) throw new Exception("cert hash mismatch " + id);
            return d;
        }
        File f = new File(certDir, id);
        if (f.exists()) try (InputStream i = new FileInputStream(f)) { return readAll(i); }
        for (byte[] r : roots()) if (h(r).equals(id)) return r;
        throw new Exception("missing cert " + id);
    }

    List<byte[]> chain(JSONArray ids, JSONObject carried) throws Exception {
        List<byte[]> l = new ArrayList<>();
        for (int i = 0; i < ids.length(); i++) l.add(getCert(ids.getString(i), carried));
        return l;
    }

    Set<String> rootIds() throws Exception {
        Set<String> s = new HashSet<>();
        for (byte[] r : roots()) s.add(h(r));
        return s;
    }

    String leafKeyHash(JSONArray ids, JSONObject carried) throws Exception {
        return OtkVerify.sha256Hex(OtkVerify.parseChain(chain(ids, carried)).get(0).getPublicKey().getEncoded());
    }

    // ================================================================ protocol

    static byte[] hopMessage(String coin, String value, long expiry, int hop, String prev, String toKey) {
        return ("PRAWL-OTK-v2|" + coin + "|" + value + "|" + expiry + "|" + hop + "|" + prev + "|" + toKey)
                .getBytes(StandardCharsets.UTF_8);
    }

    String mintHash(String coin, String value, long expiry, String k0) throws Exception {
        return OtkVerify.sha256Hex((coin + "|" + value + "|" + expiry + "|" + k0).getBytes(StandardCharsets.UTF_8));
    }

    String mint(String coin, String value, long expiresIn, boolean multiuse, boolean auth) throws Exception {
        String alias = "coin_" + coin + "_0";
        JSONArray c0 = newCoinKey(alias, multiuse, auth);
        long expiry = System.currentTimeMillis() / 1000 + expiresIn;
        JSONObject p = new JSONObject().put("v", 2).put("coinId", coin).put("value", value).put("expiry", expiry)
                .put("mint", c0).put("hops", new JSONArray());
        // mint record for the "chain" (laptop builds the snapshot from it)
        JSONObject certs = new JSONObject();
        for (int i = 0; i < c0.length(); i++) certs.put(c0.getString(i), Base64.encodeToString(getCert(c0.getString(i), null), Base64.NO_WRAP));
        write(new File(outDir, "mint_" + coin + ".json"), new JSONObject(p.toString()).put("certs", certs).toString());
        write(new File(wallet, "hold_" + coin + ".json"), new JSONObject().put("alias", alias).put("payment", p).toString());
        log("MINTED " + coin + " " + value + " ETH, expires in " + expiresIn + " s, k0 " + leafKeyHash(c0, null).substring(0, 16));
        return "OK";
    }

    JSONObject request(String name, boolean auth) throws Exception {
        File pend = new File(wallet, "pending_" + name + ".json");
        JSONArray c;
        if (pend.exists()) {
            c = new JSONObject(read(pend)).getJSONArray("chain");
            log("reusing pending receive key recv_" + name + " (retry of an interrupted payment)");
        } else {
            c = newCoinKey("recv_" + name, false, auth);
            write(pend, new JSONObject().put("chain", c).toString());
        }
        JSONObject certs = new JSONObject();
        Set<String> roots = rootIds();
        for (int i = 0; i < c.length(); i++)
            if (!roots.contains(c.getString(i)))
                certs.put(c.getString(i), Base64.encodeToString(getCert(c.getString(i), null), Base64.NO_WRAP));
        // advertise only reusable certs (intermediates); one-time leaf certs are never sent twice
        JSONArray known = new JSONArray();
        File[] fs = certDir.listFiles();
        if (fs != null) for (File f : fs) {
            try (InputStream i = new FileInputStream(f)) {
                java.security.cert.X509Certificate xc = OtkVerify.parseChain(java.util.Collections.singletonList(readAll(i))).get(0);
                if (xc.getBasicConstraints() >= 0 || xc.getExtensionValue(OtkVerify.OID_KEY_DESC) == null) known.put(f.getName());
            }
        }
        JSONObject req = new JSONObject().put("name", name).put("chain", c).put("certs", certs).put("known", known);
        log("REQUEST '" + name + "': key " + leafKeyHash(c, null).substring(0, 16) + ", tells payer it already has "
                + known.length() + " certs; " + req.toString().length() + " B");
        return req;
    }

    /** Signs the next hop. Returns null if the secure hardware refuses. */
    JSONObject pay(String coin, JSONObject req, boolean silent) throws Exception {
        JSONObject hold = new JSONObject(read(new File(wallet, "hold_" + coin + ".json")));
        JSONObject p = hold.getJSONObject("payment");
        JSONObject reqCerts = req.getJSONObject("certs");
        JSONArray to = req.getJSONArray("chain");
        for (int i = 0; i < to.length(); i++) if (reqCerts.has(to.getString(i)))
            putCert(Base64.decode(reqCerts.getString(to.getString(i)), Base64.NO_WRAP));
        if (hold.has("signed")) {
            JSONObject sp = hold.getJSONObject("signed");
            JSONArray sh = sp.getJSONArray("hops");
            String sentTo = leafKeyHash(sh.getJSONObject(sh.length() - 1).getJSONArray("to"), null);
            if (sentTo.equals(leafKeyHash(to, null))) {
                log("RESEND: coin " + coin + " was already signed to this exact recipient key; resending the stored payment");
                return withCerts(new JSONObject(sp.toString()), req);
            }
            log("coin " + coin + " was already signed to a different recipient; only that payment can be resent");
        }
        JSONArray hops = p.getJSONArray("hops");
        int hop = hops.length();
        String prev = hop == 0 ? mintHash(coin, p.getString("value"), p.getLong("expiry"), leafKeyHash(p.getJSONArray("mint"), null))
                : OtkVerify.sha256Hex(Base64.decode(hops.getJSONObject(hop - 1).getString("sig"), Base64.NO_WRAP));
        byte[] msg = hopMessage(coin, p.getString("value"), p.getLong("expiry"), hop, prev, leafKeyHash(to, null));
        log("PAY " + coin + " (" + p.getString("value") + " ETH) hop " + hop + " -> '" + req.getString("name") + "' with key " + hold.getString("alias"));
        byte[] sig;
        try {
            sig = sign(hold.getString("alias"), msg, silent);
        } catch (Throwable t) {
            String m = String.valueOf(t.getMessage()).split("\n")[0];
            log("REFUSED BY SECURE HARDWARE: " + t.getClass().getSimpleName() + ": " + m);
            return null;
        }
        JSONObject np = new JSONObject(p.toString());
        np.getJSONArray("hops").put(new JSONObject().put("to", to).put("sig", Base64.encodeToString(sig, Base64.NO_WRAP)));
        hold.put("spentTo", req.getString("name")).put("signed", np);  // persist before sending (retry = same bytes)
        write(new File(wallet, "hold_" + coin + ".json"), hold.toString());
        log("SIGNED hop " + hop + " (" + sig.length + " B sig)");
        return withCerts(np, req);
    }

    JSONObject withCerts(JSONObject np, JSONObject req) throws Exception {
        // carry only certs the recipient lacks (not pinned roots, not in its 'known' list)
        Set<String> skip = rootIds();
        JSONArray known = req.optJSONArray("known");
        if (known != null) for (int i = 0; i < known.length(); i++) skip.add(known.getString(i));
        JSONObject certs = new JSONObject();
        List<JSONArray> chains = new ArrayList<>();
        chains.add(np.getJSONArray("mint"));
        JSONArray nh = np.getJSONArray("hops");
        for (int i = 0; i < nh.length(); i++) chains.add(nh.getJSONObject(i).getJSONArray("to"));
        int all = 0;
        Set<String> seen = new HashSet<>();
        for (JSONArray c : chains) for (int i = 0; i < c.length(); i++) {
            String id = c.getString(i); all++;
            if (seen.add(id) && !skip.contains(id)) certs.put(id, Base64.encodeToString(getCert(id, null), Base64.NO_WRAP));
        }
        np.put("certs", certs);
        String js = np.toString();
        log("  payment " + js.length() + " B JSON, " + deflated(js) + " B deflated; carries "
                + certs.length() + " of " + all + " cert references (" + seen.size() + " distinct)");
        return np;
    }

    byte[] sign(String alias, byte[] msg, boolean silent) throws Exception {
        KeyStore ks = KeyStore.getInstance(KS); ks.load(null);
        PrivateKey k = (PrivateKey) ks.getKey(alias, null);
        if (k == null) throw new Exception("coin key no longer exists (already used once)");
        Signature s = Signature.getInstance("SHA256withECDSA");
        boolean needsAuth;
        try {
            android.security.keystore.KeyInfo ki = java.security.KeyFactory.getInstance(k.getAlgorithm(), KS)
                    .getKeySpec(k, android.security.keystore.KeyInfo.class);
            needsAuth = ki.isUserAuthenticationRequired();
        } catch (Exception e) { needsAuth = false; }
        s.initSign(k);
        if (!needsAuth || silent) {
            if (needsAuth) log("  attempting to sign WITHOUT asking the user (as malware would)...");
            s.update(msg);
            return s.sign();
        }
        log("  key requires the owner: showing fingerprint/PIN prompt on the phone...");
        CountDownLatch done = new CountDownLatch(1);
        AtomicReference<Object> res = new AtomicReference<>();
        runOnUiThread(() -> {
            BiometricPrompt bp = new BiometricPrompt.Builder(this)
                    .setTitle("Prowl: approve payment")
                    .setSubtitle("Sign this coin over once")
                    .setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG
                            | BiometricManager.Authenticators.DEVICE_CREDENTIAL)
                    .build();
            bp.authenticate(new BiometricPrompt.CryptoObject(s), new CancellationSignal(), getMainExecutor(),
                    new BiometricPrompt.AuthenticationCallback() {
                        @Override public void onAuthenticationSucceeded(BiometricPrompt.AuthenticationResult r) {
                            try { Signature as = r.getCryptoObject().getSignature(); as.update(msg); res.set(as.sign()); }
                            catch (Throwable t) { res.set(t); }
                            done.countDown();
                        }
                        @Override public void onAuthenticationError(int code, CharSequence m) {
                            res.set(new Exception("auth error " + code + ": " + m)); done.countDown();
                        }
                    });
        });
        if (!done.await(90, TimeUnit.SECONDS)) throw new Exception("no user approval within 90 s");
        Object o = res.get();
        if (o instanceof Throwable) throw new Exception(((Throwable) o).toString());
        log("  owner approved");
        return (byte[]) o;
    }

    String accept(JSONObject p, String name, JSONObject snap) throws Exception {
        long t0 = System.nanoTime();
        OtkVerify v = verifier();
        String coin = p.getString("coinId"), value = p.getString("value");
        long expiry = p.getLong("expiry");
        JSONObject certs = p.optJSONObject("certs");
        JSONArray hops = p.getJSONArray("hops");
        log("ACCEPT? " + coin + " " + value + " ETH, " + hops.length() + " hop(s), as '" + name + "'");
        List<String> fails = new ArrayList<>();
        long now = System.currentTimeMillis() / 1000;
        // [0] coin-level policy
        BigDecimal val = new BigDecimal(value);
        boolean stale = now - REVOCATION_FETCHED > REVOCATION_MAX_AGE_S;
        BigDecimal cap = stale ? STALE_CAP : CAP;
        log("  [0] value " + value + " <= cap " + cap + (stale ? " (revocation list STALE)" : " (revocation list fresh, "
                + (now - REVOCATION_FETCHED) / 3600 + " h old)") + ": " + (val.compareTo(cap) <= 0 ? "yes" : "NO")
                + "; hops " + hops.length() + " <= " + MAX_HOPS + ": " + (hops.length() <= MAX_HOPS ? "yes" : "NO")
                + "; " + (expiry - now) + " s left (need " + MIN_REMAINING_S + "): " + (expiry - now >= MIN_REMAINING_S ? "yes" : "NO"));
        if (val.compareTo(cap) > 0) fails.add("value above offline cap " + cap);
        if (hops.length() > MAX_HOPS) fails.add("too many offline hops");
        if (expiry - now < MIN_REMAINING_S) fails.add("coin expired or about to expire");
        // [1] deposit in last synced snapshot (k0, value, expiry)
        String k0 = leafKeyHash(p.getJSONArray("mint"), certs);
        boolean dep = false;
        JSONArray deps = snap.getJSONArray("deposits");
        for (int i = 0; i < deps.length(); i++) {
            JSONObject d = deps.getJSONObject(i);
            if (d.getString("coinId").equals(coin) && d.getString("value").equals(value)
                    && d.getLong("expiry") == expiry && d.getString("k0").equals(k0)) dep = true;
        }
        log("  [1] deposit in synced snapshot: " + (dep ? "yes" : "NO"));
        if (!dep) fails.add("not backed by a known deposit");
        // [2] genesis key
        OtkVerify.Result r0 = v.verify(chain(p.getJSONArray("mint"), certs));
        log("  [2] genesis key: " + r0.summary());
        if (!r0.ok) fails.add("genesis key fails policy");
        // [3] hops
        PublicKey signer = r0.leafKey;
        String prev = mintHash(coin, value, expiry, k0);
        String lastTo = null;
        for (int i = 0; i < hops.length(); i++) {
            JSONObject hp = hops.getJSONObject(i);
            OtkVerify.Result rt = v.verify(chain(hp.getJSONArray("to"), certs));
            byte[] sig = Base64.decode(hp.getString("sig"), Base64.NO_WRAP);
            boolean ok = false;
            if (signer != null) {
                Signature s = Signature.getInstance("SHA256withECDSA");
                s.initVerify(signer);
                s.update(hopMessage(coin, value, expiry, i, prev, rt.leafKeyHash == null ? "?" : rt.leafKeyHash));
                try { ok = s.verify(sig); } catch (Exception e) { ok = false; }
            }
            log("  [3." + i + "] signature " + (ok ? "valid" : "INVALID") + "; next key: " + rt.summary());
            if (!ok) fails.add("hop " + i + " signature invalid");
            if (!rt.ok) fails.add("hop " + i + " key fails policy");
            signer = rt.leafKey; prev = OtkVerify.sha256Hex(sig); lastTo = rt.leafKeyHash;
        }
        // [4] addressed to me
        KeyStore ks = KeyStore.getInstance(KS); ks.load(null);
        Certificate mine = ks.getCertificate("recv_" + name);
        String myHash = mine == null ? "none" : OtkVerify.sha256Hex(mine.getPublicKey().getEncoded());
        boolean toMe = hops.length() > 0 && myHash.equals(lastTo);
        log("  [4] pays my key recv_" + name + ": " + (toMe ? "yes" : "NO"));
        if (!toMe) fails.add("not addressed to me");
        long ms = (System.nanoTime() - t0) / 1_000_000;
        if (!fails.isEmpty()) { log("REJECTED in " + ms + " ms: " + fails); return "REJECTED"; }
        // cache carried certs, store coin
        if (certs != null) { JSONArray ids = certs.names(); if (ids != null) for (int i = 0; i < ids.length(); i++)
            putCert(Base64.decode(certs.getString(ids.getString(i)), Base64.NO_WRAP)); }
        JSONObject stored = new JSONObject(p.toString()); stored.remove("certs");
        write(new File(wallet, "hold_" + coin + ".json"), new JSONObject().put("alias", "recv_" + name).put("payment", stored).toString());
        new File(wallet, "pending_" + name + ".json").delete();
        log("ACCEPTED in " + ms + " ms: holding " + coin + " (" + value + " ETH), spendable once with recv_" + name);
        return "ACCEPTED";
    }

    OtkVerify verifier() throws Exception {
        Set<String> rev = new HashSet<>();
        for (String line : new String(asset("revoked.txt"), StandardCharsets.UTF_8).split("\n")) if (!line.trim().isEmpty()) rev.add(line.trim());
        OtkVerify v = new OtkVerify(roots(), rev);
        v.expectedPkg = PKG; v.expectedAppDigest = APP_DIGEST; v.minPatch = MIN_PATCH;
        return v;
    }

    // ================================================================ Bluetooth

    BluetoothAdapter bt() { return ((BluetoothManager) getSystemService(BLUETOOTH_SERVICE)).getAdapter(); }

    static void send(DataOutputStream o, String s) throws Exception {
        byte[] b = s.getBytes(StandardCharsets.UTF_8); o.writeInt(b.length); o.write(b); o.flush();
    }
    static String recv(DataInputStream i) throws Exception {
        int n = i.readInt(); if (n < 0 || n > 4_000_000) throw new Exception("bad frame " + n);
        byte[] b = new byte[n]; i.readFully(b); return new String(b, StandardCharsets.UTF_8);
    }

    String btReceive(String name, String snapFile, boolean auth) throws Exception {
        JSONObject snap = new JSONObject(read(new File(in, snapFile)));
        JSONObject req = request(name, auth);
        BluetoothServerSocket ss = bt().listenUsingInsecureRfcommWithServiceRecord("PrawlOTK", BT_UUID);
        log("BT LISTENING as '" + name + "' (offline: no internet used)");
        BluetoothSocket s;
        try { s = ss.accept(120_000); } finally { ss.close(); }
        long t0 = System.nanoTime();
        log("BT connected from " + s.getRemoteDevice().getAddress());
        try (BluetoothSocket sock = s) {
            DataOutputStream o = new DataOutputStream(sock.getOutputStream());
            DataInputStream i = new DataInputStream(sock.getInputStream());
            send(o, req.toString());
            String pay;
            try { pay = recv(i); } catch (Exception e) { log("link lost before payment arrived (" + e.getClass().getSimpleName() + "); keeping receive key for retry"); return "LINK_LOST"; }
            long tPay = System.nanoTime();
            log("BT received payment: " + pay.length() + " B");
            if (pay.equals("{}")) { log("payer sent no payment (payer's secure hardware refused to sign)"); try { send(o, "NOTHING"); } catch (Exception ignored) {} return "NO_PAYMENT"; }
            String verdict = accept(new JSONObject(pay), name, snap);
            send(o, verdict);
            log("BT session " + (System.nanoTime() - t0) / 1_000_000 + " ms (payment arrived at "
                    + (tPay - t0) / 1_000_000 + " ms)");
            return verdict;
        }
    }

    String btPay(String coin, String addr, boolean drop) throws Exception {
        BluetoothAdapter a = bt();
        long t0 = System.nanoTime();
        BluetoothSocket s = a.getRemoteDevice(addr).createInsecureRfcommSocketToServiceRecord(BT_UUID);
        s.connect();
        log("BT connected to " + addr + " in " + (System.nanoTime() - t0) / 1_000_000 + " ms");
        try (BluetoothSocket sock = s) {
            DataOutputStream o = new DataOutputStream(sock.getOutputStream());
            DataInputStream i = new DataInputStream(sock.getInputStream());
            JSONObject req = new JSONObject(recv(i));
            log("BT got request from '" + req.getString("name") + "'");
            JSONObject p = pay(coin, req, false);
            if (p == null) { send(o, "{}"); return "REFUSED"; }
            if (drop) { log("SIMULATED RADIO DROP: hanging up after signing, before the payment is delivered"); return "DROPPED"; }
            send(o, p.toString());
            String verdict = recv(i);
            log("BT payee verdict: " + verdict + " (" + (System.nanoTime() - t0) / 1_000_000 + " ms total)");
            return "PAID:" + verdict;
        }
    }

    // ================================================================ misc

    String show() throws Exception {
        File[] fs = wallet.listFiles();
        if (fs != null) for (File f : fs) {
            JSONObject h = new JSONObject(read(f));
            JSONObject p = h.getJSONObject("payment");
            log("HOLD " + p.getString("coinId") + " " + p.getString("value") + " ETH key=" + h.getString("alias")
                    + " hops=" + p.getJSONArray("hops").length() + (h.has("spentTo") ? " (spent to " + h.getString("spentTo") + ")" : ""));
        }
        return "OK";
    }

    static int deflated(String s) {
        Deflater d = new Deflater(Deflater.BEST_COMPRESSION);
        d.setInput(s.getBytes(StandardCharsets.UTF_8)); d.finish();
        byte[] buf = new byte[1 << 20]; int n = d.deflate(buf); d.end(); return n;
    }

    List<byte[]> rootsCache;
    List<byte[]> roots() throws Exception {
        if (rootsCache != null) return rootsCache;
        List<byte[]> r = new ArrayList<>();
        for (String part : new String(asset("roots.pem"), StandardCharsets.UTF_8).split("-----END CERTIFICATE-----")) {
            String b = part.replace("-----BEGIN CERTIFICATE-----", "").replaceAll("\\s", "");
            if (!b.isEmpty()) r.add(Base64.decode(b, Base64.DEFAULT));
        }
        return rootsCache = r;
    }

    byte[] asset(String n) throws Exception { try (InputStream i = getAssets().open(n)) { return readAll(i); } }
    static String read(File f) throws Exception { try (InputStream i = new FileInputStream(f)) { return new String(readAll(i), StandardCharsets.UTF_8); } }
    static void write(File f, String s) throws Exception { try (FileOutputStream o = new FileOutputStream(f)) { o.write(s.getBytes(StandardCharsets.UTF_8)); } }
    static byte[] readAll(InputStream i) throws Exception {
        ByteArrayOutputStream b = new ByteArrayOutputStream(); byte[] buf = new byte[8192]; int n;
        while ((n = i.read(buf)) > 0) b.write(buf, 0, n);
        return b.toByteArray();
    }
}
