package xyz.prawl.otktest;

import android.bluetooth.BluetoothServerSocket;
import android.bluetooth.BluetoothSocket;
import android.os.Bundle;
import android.util.Base64;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.File;
import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.security.PublicKey;
import java.security.SecureRandom;
import java.security.Signature;
import java.security.cert.Certificate;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * Prowl OTK wallet v3 (see raw/v3/SPEC.md): notes with SPLITTING and CHANGE.
 *
 * A note = (value in wei, one-time key). Spending a note with its key signs
 *   PRAWL-OTK-v3|chainId|escrow40|coinId|expiry|depth|parentNoteId|outputsHash
 * creating n outputs whose values sum to the note's value. Paying X from a note of
 * value V creates (X -> payee key) and (V-X -> a fresh one-time change key on the
 * payer's phone). Redemption is a spend to a PRAWL-REDEEM output.
 *
 * All v2 protections are inherited from Wallet2Activity (attestation policy,
 * expiry, hop limit, cap, revocation freshness, per-spend auth, compact certs,
 * safe retry, Bluetooth).
 *
 * Commands (extra "cmd"):
 *   mint      coin(label) eth [expiresIn] [chainId] [escrow] [multiuse] [auth]
 *   request   name                            -> out/req_<name>.json
 *   pay       coin amount(eth) req            -> out/pay3_<coin>_<name>.json (change kept locally)
 *   accept    pay name snapshot
 *   redeem    coin payout                     -> out/redeem3_<coin>_<alias>.json
 *   bt3_receive name snapshot | bt3_pay coin amount addr
 *   show
 */
public class Wallet3Activity extends Wallet2Activity {
    static final BigInteger WEI = BigInteger.TEN.pow(18);
    /** Test hook: spend this note alias even if the wallet's own records say it is spent (a malicious wallet). */
    String forceNote;
    static final BigInteger CAP_WEI = new BigInteger("1000000000000000000");       // 1.0 ETH offline cap
    /** Most outputs one spend may have (audit F2): a redemption below a spend must carry them all. Mirrors the escrow and the Kotlin app. */
    static final int MAX_OUTPUTS = 32;

    static boolean isHex(String s, int n) {
        if (s == null || s.length() != n) return false;
        for (int i = 0; i < n; i++) { char c = s.charAt(i); if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return false; }
        return true;
    }
    /** Decimal without sign, leading zeros or exponent; fits uint256. */
    static boolean isUint256(String s, boolean positive) {
        if (s == null || s.isEmpty() || s.length() > 78) return false;
        for (int i = 0; i < s.length(); i++) if (s.charAt(i) < '0' || s.charAt(i) > '9') return false;
        if (s.length() > 1 && s.charAt(0) == '0') return false;
        BigInteger v = new BigInteger(s);
        return v.compareTo(BigInteger.ONE.shiftLeft(256)) < 0 && (!positive || v.signum() > 0);
    }
    /** DER SEQUENCE{INTEGER r, INTEGER s} in its minimal form (the escrow rebuilds it from r and s; its hex is part of the child note id). */
    static boolean strictDer(byte[] b) {
        if (b.length < 8 || b[0] != 0x30 || (b[1] & 0xff) >= 0x80 || (b[1] & 0xff) != b.length - 2) return false;
        int i = 2;
        for (int k = 0; k < 2; k++) {
            if (i + 2 > b.length || b[i] != 0x02) return false;
            int len = b[i + 1] & 0xff;
            if (len < 1 || len > 33 || i + 2 + len > b.length) return false;
            if ((b[i + 2] & 0x80) != 0) return false;
            if (len > 1 && b[i + 2] == 0 && (b[i + 3] & 0x80) == 0) return false;
            i += 2 + len;
        }
        return i == b.length;
    }
    /**
     * Every string that goes into a spend message must be in the one spelling the escrow can rebuild (audit F1): chainId decimal,
     * escrow 40 lowercase hex, coinId and output keys 64 lowercase hex, values positive decimal, expiry decimal, strict DER signatures.
     * Returns the first problem, or null.
     */
    static String canonProblem(JSONObject h, JSONArray path) {
        try {
            if (!isUint256(h.getString("chainId"), false)) return "chainId is not canonical decimal";
            if (!isHex(h.getString("escrow"), 40)) return "escrow is not 40 lowercase hex digits without 0x";
            if (!isHex(h.getString("coinId"), 64)) return "coinId is not 64 lowercase hex digits without 0x";
            String ex = h.getString("expiry");
            if (!isUint256(ex, true) || ex.length() > 19) return "expiry is not canonical decimal";
            if (!isUint256(h.getString("value"), true)) return "deposit value is not canonical positive decimal";
            for (int d = 0; d < path.length(); d++) {
                int n = path.getJSONObject(d).getJSONArray("outputs").length();
                if (n < 1) return "spend " + d + " has no outputs";
                if (n > MAX_OUTPUTS) return "spend " + d + " has too many outputs (" + n + " > " + MAX_OUTPUTS + ")";
            }
            for (int d = 0; d < path.length(); d++) {
                JSONObject s = path.getJSONObject(d);
                JSONArray outs = s.getJSONArray("outputs");
                for (int i = 0; i < outs.length(); i++) {
                    JSONObject o = outs.getJSONObject(i);
                    if (!isUint256(o.getString("value"), true)) return "spend " + d + " output " + i + ": value is not canonical positive decimal";
                    if (!isHex(o.getString("key"), 64)) return "spend " + d + " output " + i + ": key is not 64 lowercase hex digits without 0x";
                }
                String idx = s.getString("index");
                if (!isUint256(idx, false) || idx.length() > 6 || Integer.parseInt(idx) >= outs.length()) return "spend " + d + ": index is not a canonical index into the outputs";
                if (!strictDer(Base64.decode(s.getString("sig"), Base64.NO_WRAP))) return "spend " + d + ": signature is not strict canonical DER";
            }
            return null;
        } catch (Exception e) {
            return "malformed bundle: " + e.getMessage();
        }
    }

    static final BigInteger STALE_CAP_WEI = new BigInteger("50000000000000000");   // 0.05 ETH

    @Override
    String run(Bundle x) throws Exception {
        String cmd = x.getString("cmd", "show");
        log("v3 cmd=" + cmd + " on " + android.os.Build.MANUFACTURER + " " + android.os.Build.MODEL);
        boolean auth = "true".equals(x.getString("auth"));
        switch (cmd) {
            case "mint": return mint3(x.getString("coin"), x.getString("eth"),
                    Long.parseLong(x.getString("expiresIn", String.valueOf(14 * 86400))),
                    x.getString("chainId", "11155111"), x.getString("escrow", "00000000000000000000000000000000000e5c70"),
                    "true".equals(x.getString("multiuse")), auth, x.getString("depositor", "0000000000000000000000000000000000000000"));
            case "request": {
                JSONObject req = request(x.getString("name"), auth);
                write(new File(outDir, "req_" + x.getString("name") + ".json"), req.toString());
                return "OK";
            }
            case "pay": {
                JSONObject req = new JSONObject(read(new File(in, x.getString("req"))));
                forceNote = x.getString("note");
                JSONObject p = pay3(x.getString("coin"), wei(x.getString("amount")), req);
                if (p == null) return "REFUSED";
                write(new File(outDir, "pay3_" + x.getString("coin") + "_" + req.getString("name") + ".json"), p.toString());
                return "OK";
            }
            case "accept":
                return accept3(new JSONObject(read(new File(in, x.getString("pay")))), x.getString("name"),
                        new JSONObject(read(new File(in, x.getString("snapshot")))));
            case "redeem": return redeem3(x.getString("coin"), x.getString("payout"), x.getString("shield"));
            case "bt3_receive": return bt3Receive(x.getString("name"), x.getString("snapshot"), auth);
            case "bt3_pay": return bt3Pay(x.getString("coin"), wei(x.getString("amount")), x.getString("addr"));
            default: return show3();
        }
    }

    // ================================================================ helpers

    static BigInteger wei(String eth) { return new java.math.BigDecimal(eth).multiply(new java.math.BigDecimal(WEI)).toBigIntegerExact(); }
    static String eth(BigInteger w) { return new java.math.BigDecimal(w).divide(new java.math.BigDecimal(WEI)).stripTrailingZeros().toPlainString(); }
    static String hex(byte[] b) { StringBuilder s = new StringBuilder(); for (byte x : b) s.append(String.format("%02x", x)); return s.toString(); }
    static String sha(String s) throws Exception { return OtkVerify.sha256Hex(s.getBytes(StandardCharsets.UTF_8)); }

    static String outputsHash(JSONArray outs) throws Exception {
        StringBuilder b = new StringBuilder();
        for (int i = 0; i < outs.length(); i++) {
            JSONObject o = outs.getJSONObject(i);
            if (i > 0) b.append(';');
            b.append(o.getString("value")).append(':').append(o.getString("key"));
        }
        return sha(b.toString());
    }

    static byte[] spendMessage(JSONObject h, int depth, String parentNoteId, JSONArray outs) throws Exception {
        return ("PRAWL-OTK-v3|" + h.getString("chainId") + "|" + h.getString("escrow") + "|" + h.getString("coinId") + "|"
                + h.getLong("expiry") + "|" + depth + "|" + parentNoteId + "|" + outputsHash(outs)).getBytes(StandardCharsets.UTF_8);
    }

    static String genesisNoteId(JSONObject h) throws Exception { return sha("genesis|" + h.getString("coinId")); }
    static String childNoteId(String sigB64, int index) throws Exception {
        return sha(hex(Base64.decode(sigB64, Base64.NO_WRAP)) + "|" + index);
    }

    static String redeemKey(JSONObject h, String payout) throws Exception {
        return sha("PRAWL-REDEEM|" + h.getString("chainId") + "|" + h.getString("escrow") + "|" + payout.toLowerCase().replace("0x", ""));
    }

    File noteFile(String alias) { return new File(wallet, "note_" + alias + ".json"); }

    /** Notes held for a coin label, unspent first. */
    List<JSONObject> notes(String coin) throws Exception {
        List<JSONObject> l = new ArrayList<>();
        File[] fs = wallet.listFiles();
        if (fs != null) for (File f : fs) if (f.getName().startsWith("note_")) {
            JSONObject n = new JSONObject(read(f));
            if (n.getJSONObject("header").getString("label").equals(coin)) l.add(n);
        }
        return l;
    }

    // ================================================================ mint

    String mint3(String label, String ethAmt, long expiresIn, String chainId, String escrow, boolean multiuse, boolean auth,
                 String depositor) throws Exception {
        byte[] id = new byte[32]; new SecureRandom().nextBytes(id);
        String alias = "n_" + label + "_g";
        JSONArray c0 = newCoinKey(alias, multiuse, auth);
        PublicKey k0 = OtkVerify.parseChain(chain(c0, null)).get(0).getPublicKey();
        java.security.spec.ECPoint w = ((java.security.interfaces.ECPublicKey) k0).getW();
        JSONObject h = new JSONObject().put("v", 3).put("label", label).put("coinId", hex(id)).put("chainId", chainId)
                .put("escrow", escrow.toLowerCase().replace("0x", "")).put("expiry", System.currentTimeMillis() / 1000 + expiresIn)
                .put("value", wei(ethAmt).toString()).put("k0", c0)
                .put("k0x", w.getAffineX().toString(16)).put("k0y", w.getAffineY().toString(16))
                .put("depositor", depositor.toLowerCase().replace("0x", ""));
        JSONObject note = new JSONObject().put("header", h).put("path", new JSONArray()).put("alias", alias)
                .put("value", h.getString("value")).put("noteId", genesisNoteId(h));
        write(noteFile(alias), note.toString());
        JSONObject certs = new JSONObject();
        for (int i = 0; i < c0.length(); i++) certs.put(c0.getString(i), Base64.encodeToString(getCert(c0.getString(i), null), Base64.NO_WRAP));
        write(new File(outDir, "mint3_" + label + ".json"), new JSONObject(h.toString()).put("certs", certs).toString());
        log("MINTED " + label + " = " + ethAmt + " ETH, coinId " + hex(id).substring(0, 16) + "…, genesis key " + alias);
        return "OK";
    }

    // ================================================================ pay (split + change)

    JSONObject pay3(String coin, BigInteger amount, JSONObject req) throws Exception {
        JSONObject reqCerts = req.getJSONObject("certs");
        JSONArray to = req.getJSONArray("chain");
        for (int i = 0; i < to.length(); i++) if (reqCerts.has(to.getString(i)))
            putCert(Base64.decode(reqCerts.getString(to.getString(i)), Base64.NO_WRAP));
        String toKey = leafKeyHash(to, null);
        // Check the payee's key is a genuine hardware one-time key BEFORE spending: paying a software key
        // would let the payee equivocate and freeze the coin's subtree.
        OtkVerify.Result pr = verifier().verify(chain(to, null));
        log("  payee key check: " + pr.summary());
        if (!pr.ok) { log("REFUSING TO PAY: payee key is not a hardware one-time key"); return null; }
        // retry: a note already signed to this exact key -> resend the same bytes
        if (forceNote == null) for (JSONObject n : notes(coin)) if (n.has("signedTo") && n.getString("signedTo").equals(toKey)) {
            log("RESEND: note " + n.getString("alias") + " was already signed to this recipient key");
            return carry(new JSONObject(n.getString("signedBundle")), req);
        }
        JSONObject note = null;
        if (forceNote != null) {
            note = new JSONObject(read(noteFile(forceNote)));
            log("MALICIOUS WALLET MODE: ignoring own records, re-spending note " + forceNote + (note.has("spent") ? " (already spent)" : ""));
            note.remove("spent"); note.remove("signedTo");
        } else for (JSONObject n : notes(coin))
            if (!n.has("spent") && new BigInteger(n.getString("value")).compareTo(amount) >= 0) { note = n; break; }
        if (note == null) { log("no unspent note of coin " + coin + " can pay " + eth(amount) + " ETH"); return null; }
        if (new BigInteger(note.getString("value")).compareTo(amount) < 0) { log("note too small"); return null; }
        JSONObject h = note.getJSONObject("header");
        BigInteger v = new BigInteger(note.getString("value"));
        BigInteger change = v.subtract(amount);
        JSONArray outs = new JSONArray().put(new JSONObject().put("value", amount.min(v).toString()).put("key", toKey));
        String chgAlias = null; JSONArray chgChain = null;
        if (change.signum() > 0) {
            chgAlias = "n_" + coin + "_c" + System.currentTimeMillis();
            chgChain = newCoinKey(chgAlias, false, false);
            outs.put(new JSONObject().put("value", change.toString()).put("key", leafKeyHash(chgChain, null)));
        }
        int depth = note.getJSONArray("path").length();
        byte[] msg = spendMessage(h, depth, note.getString("noteId"), outs);
        log("PAY " + eth(amount) + " ETH of note " + note.getString("alias") + " (" + eth(v) + " ETH, depth " + depth + ") -> '"
                + req.getString("name") + "'" + (chgAlias != null ? " + change " + eth(change) + " ETH -> own new key " + chgAlias : ""));
        byte[] sig;
        try { sig = sign(note.getString("alias"), msg, false); }
        catch (Throwable t) {
            log("REFUSED BY SECURE HARDWARE: " + String.valueOf(t.getMessage()).split("\n")[0]);
            if (chgAlias != null) { KeyStore ks = KeyStore.getInstance(KS); ks.load(null); ks.deleteEntry(chgAlias); }
            return null;
        }
        String sigB64 = Base64.encodeToString(sig, Base64.NO_WRAP);
        // spend record appended to the path; recipient-facing bundle takes output 0
        JSONObject spendTo = new JSONObject().put("outputs", outs).put("index", 0).put("sig", sigB64).put("next", to);
        JSONArray path = new JSONArray(note.getJSONArray("path").toString()).put(spendTo);
        JSONObject bundle = new JSONObject().put("header", h).put("path", path);
        note.put("spent", true).put("signedTo", toKey).put("signedBundle", bundle.toString());   // persist before sending
        write(noteFile(note.getString("alias")), note.toString());
        if (chgAlias != null) {
            JSONObject spendChg = new JSONObject(spendTo.toString()).put("index", 1).put("next", chgChain);
            JSONArray cpath = new JSONArray(note.getJSONArray("path").toString()).put(spendChg);
            write(noteFile(chgAlias), new JSONObject().put("header", h).put("path", cpath).put("alias", chgAlias)
                    .put("value", change.toString()).put("noteId", childNoteId(sigB64, 1)).toString());
        }
        log("SIGNED spend at depth " + depth + " (" + sig.length + " B sig), " + outs.length() + " outputs");
        return carry(bundle, req);
    }

    /** Attach only certificates the recipient lacks. */
    JSONObject carry(JSONObject bundle, JSONObject req) throws Exception {
        Set<String> skip = rootIds();
        JSONArray known = req.optJSONArray("known");
        if (known != null) for (int i = 0; i < known.length(); i++) skip.add(known.getString(i));
        List<JSONArray> chains = new ArrayList<>();
        chains.add(bundle.getJSONObject("header").getJSONArray("k0"));
        JSONArray p = bundle.getJSONArray("path");
        for (int i = 0; i < p.length(); i++) chains.add(p.getJSONObject(i).getJSONArray("next"));
        JSONObject certs = new JSONObject(); Set<String> seen = new HashSet<>(); int refs = 0;
        for (JSONArray c : chains) for (int i = 0; i < c.length(); i++) {
            String id = c.getString(i); refs++;
            if (seen.add(id) && !skip.contains(id)) certs.put(id, Base64.encodeToString(getCert(id, null), Base64.NO_WRAP));
        }
        JSONObject out = new JSONObject(bundle.toString()).put("certs", certs);
        String js = out.toString();
        log("  bundle " + js.length() + " B JSON, " + deflated(js) + " B deflated; " + p.length() + " spend(s), carries "
                + certs.length() + " of " + refs + " cert refs");
        return out;
    }

    // ================================================================ accept

    String accept3(JSONObject b, String name, JSONObject snap) throws Exception {
        long t0 = System.nanoTime();
        OtkVerify v = verifier();
        JSONObject h = b.getJSONObject("header");
        JSONObject certs = b.optJSONObject("certs");
        JSONArray path = b.getJSONArray("path");
        List<String> fails = new ArrayList<>();
        long now = System.currentTimeMillis() / 1000;
        // [0a] audit F1/F2: refuse anything the escrow cannot rebuild byte for byte, and fan-outs it cannot redeem
        String cp = canonProblem(h, path);
        if (cp != null) { log("  [0] REJECTED: " + cp); return "REJECTED"; }
        log("ACCEPT? coin " + h.getString("coinId").substring(0, 16) + "… (" + eth(new BigInteger(h.getString("value")))
                + " ETH deposit), " + path.length() + " spend(s), as '" + name + "'");
        // [0] coin-level policy
        if (path.length() > MAX_HOPS) fails.add("too many offline hops (" + path.length() + " > " + MAX_HOPS + ")");
        if (h.getLong("expiry") - now < MIN_REMAINING_S) fails.add("coin expired or about to expire");
        // [1] deposit backing (snapshot now; light-client DepositProof when integrated)
        String k0 = leafKeyHash(h.getJSONArray("k0"), certs);
        boolean dep = false;
        JSONArray deps = snap.getJSONArray("deposits");
        for (int i = 0; i < deps.length(); i++) {
            JSONObject d = deps.getJSONObject(i);
            if (d.getString("coinId").equals(h.getString("coinId")) && d.getString("value").equals(h.getString("value"))
                    && d.getLong("expiry") == h.getLong("expiry") && d.getString("k0").equals(k0)) dep = true;
        }
        log("  [1] deposit backing: " + (dep ? "yes (synced snapshot)" : "NO"));
        if (!dep) fails.add("not backed by a known deposit");
        // [2] genesis key attestation
        OtkVerify.Result r = v.verify(chain(h.getJSONArray("k0"), certs));
        log("  [2] genesis key: " + r.summary());
        if (!r.ok) fails.add("genesis key fails policy");
        // [3] spends along the path
        PublicKey signer = r.leafKey;
        BigInteger noteValue = new BigInteger(h.getString("value"));
        String noteId = genesisNoteId(h);
        String lastKey = null;
        for (int d = 0; d < path.length(); d++) {
            JSONObject s = path.getJSONObject(d);
            JSONArray outs = s.getJSONArray("outputs");
            int idx = s.getInt("index");
            BigInteger sum = BigInteger.ZERO; boolean pos = true;
            for (int i = 0; i < outs.length(); i++) {
                BigInteger ov = new BigInteger(outs.getJSONObject(i).getString("value"));
                if (ov.signum() <= 0) pos = false;
                sum = sum.add(ov);
            }
            boolean conserve = pos && sum.equals(noteValue);
            boolean sigOk = false;
            if (signer != null) {
                Signature sg = Signature.getInstance("SHA256withECDSA");
                sg.initVerify(signer);
                sg.update(spendMessage(h, d, noteId, outs));
                try { sigOk = sg.verify(Base64.decode(s.getString("sig"), Base64.NO_WRAP)); } catch (Exception e) { sigOk = false; }
            }
            OtkVerify.Result rn = v.verify(chain(s.getJSONArray("next"), certs));
            boolean linked = rn.leafKeyHash != null && idx >= 0 && idx < outs.length()
                    && outs.getJSONObject(idx).getString("key").equals(rn.leafKeyHash);
            StringBuilder od = new StringBuilder();
            for (int i = 0; i < outs.length(); i++) od.append(i == idx ? "[" : "").append(eth(new BigInteger(outs.getJSONObject(i).getString("value"))))
                    .append(i == idx ? "]" : "").append(i + 1 < outs.length() ? " + " : "");
            log("  [3." + d + "] spend of " + eth(noteValue) + " ETH -> " + od + ": signature " + (sigOk ? "valid" : "INVALID")
                    + ", conservation " + (conserve ? "ok" : "BROKEN") + ", output→key " + (linked ? "ok" : "MISMATCH")
                    + "; next key " + rn.summary());
            if (!sigOk) fails.add("spend " + d + " signature invalid");
            if (!conserve) fails.add("spend " + d + " does not conserve value");
            if (!linked) fails.add("spend " + d + " output not bound to the next key");
            if (!rn.ok) fails.add("spend " + d + " next key fails policy");
            if (idx >= 0 && idx < outs.length()) noteValue = new BigInteger(outs.getJSONObject(idx).getString("value"));
            noteId = childNoteId(s.getString("sig"), idx);
            signer = rn.leafKey; lastKey = rn.leafKeyHash;
        }
        // [4] cap on what I receive, and it must pay my pending receive key
        boolean stale = now - REVOCATION_FETCHED > REVOCATION_MAX_AGE_S;
        BigInteger cap = stale ? STALE_CAP_WEI : CAP_WEI;
        if (noteValue.compareTo(cap) > 0) fails.add("received value above offline cap " + eth(cap));
        KeyStore ks = KeyStore.getInstance(KS); ks.load(null);
        Certificate mine = ks.getCertificate("recv_" + name);
        String myHash = mine == null ? "none" : OtkVerify.sha256Hex(mine.getPublicKey().getEncoded());
        boolean toMe = path.length() > 0 && myHash.equals(lastKey);
        log("  [4] receives " + eth(noteValue) + " ETH (cap " + eth(cap) + ") on my key recv_" + name + ": " + (toMe ? "yes" : "NO"));
        if (!toMe) fails.add("not addressed to me");
        long ms = (System.nanoTime() - t0) / 1_000_000;
        if (!fails.isEmpty()) { log("REJECTED in " + ms + " ms: " + fails); return "REJECTED"; }
        if (certs != null) { JSONArray ids = certs.names(); if (ids != null) for (int i = 0; i < ids.length(); i++)
            putCert(Base64.decode(certs.getString(ids.getString(i)), Base64.NO_WRAP)); }
        new File(wallet, "pending_" + name + ".json").delete();
        JSONObject hh = new JSONObject(h.toString()).put("label", h.optString("label", "coin"));
        write(noteFile("recv_" + name), new JSONObject().put("header", hh).put("path", path).put("alias", "recv_" + name)
                .put("value", noteValue.toString()).put("noteId", noteId).toString());
        log("ACCEPTED in " + ms + " ms: I hold a " + eth(noteValue) + " ETH note of coin " + hh.getString("label")
                + ", spendable once with recv_" + name);
        return "ACCEPTED";
    }

    // ================================================================ redeem

    static byte[] word(java.math.BigInteger v) {
        byte[] b = v.toByteArray(), w = new byte[32];
        int n = Math.min(b.length, 32);
        System.arraycopy(b, b.length - n, w, 32 - n, n);
        return w;
    }
    static java.math.BigInteger hexInt(String h) { return new java.math.BigInteger(h.replace("0x", ""), 16); }

    /** sha256(abi.encode(ShieldRequest)): 9 static words (escrow v3.1 / HANDOFF v1.1 section 6). */
    static String shieldHash(JSONObject r) throws Exception {
        java.io.ByteArrayOutputStream o = new java.io.ByteArrayOutputStream();
        o.write(word(hexInt(r.getString("npk"))));
        o.write(word(BigInteger.valueOf(r.getInt("tokenType"))));
        o.write(word(hexInt(r.getString("tokenAddress"))));
        o.write(word(new BigInteger(r.getString("tokenSubID"))));
        o.write(word(new BigInteger(r.getString("value"))));
        JSONArray eb = r.getJSONArray("encryptedBundle");
        for (int i = 0; i < 3; i++) o.write(word(hexInt(eb.getString(i))));
        o.write(word(hexInt(r.getString("shieldKey"))));
        return OtkVerify.sha256Hex(o.toByteArray());
    }

    String redeem3(String coin, String payout, String shieldFile) throws Exception {
        if (shieldFile != null) return redeemShield(coin, shieldFile);
        JSONObject note = null;
        for (JSONObject n : notes(coin)) if (!n.has("spent")) { note = n; break; }
        if (note == null) { log("no unspent note of " + coin); return "NONE"; }
        JSONObject h = note.getJSONObject("header");
        JSONArray outs = new JSONArray().put(new JSONObject().put("value", note.getString("value")).put("key", redeemKey(h, payout)));
        int depth = note.getJSONArray("path").length();
        byte[] sig;
        try { sig = sign(note.getString("alias"), spendMessage(h, depth, note.getString("noteId"), outs), false); }
        catch (Throwable t) { log("REFUSED BY SECURE HARDWARE: " + String.valueOf(t.getMessage()).split("\n")[0]); return "REFUSED"; }
        JSONObject red = new JSONObject().put("header", h).put("path", note.getJSONArray("path"))
                .put("redeem", new JSONObject().put("outputs", outs).put("index", 0).put("payout", payout)
                        .put("sig", Base64.encodeToString(sig, Base64.NO_WRAP)));
        note.put("spent", true).put("redeemedTo", payout);
        write(noteFile(note.getString("alias")), note.toString());
        write(new File(outDir, "redeem3_" + coin + "_" + note.getString("alias") + ".json"), carry(red, new JSONObject()).toString());
        log("REDEEM SIGNED: " + eth(new BigInteger(note.getString("value"))) + " ETH note " + note.getString("alias") + " -> " + payout);
        return "OK";
    }

    /** Cash out a note into a RAILGUN shield: sign over the exact ShieldRequest the website built. */
    String redeemShield(String coin, String shieldFile) throws Exception {
        JSONObject t = new JSONObject(read(new File(in, shieldFile)));
        JSONObject req = t.has("request") ? t.getJSONObject("request") : t;
        JSONObject note = null;
        for (JSONObject n : notes(coin)) if (!n.has("spent") && n.getString("value").equals(req.getString("value"))) { note = n; break; }
        if (note == null) { log("REFUSED: no unspent note of " + coin + " worth exactly " + req.getString("value") + " wei (shield value must equal the note)"); return "REFUSED"; }
        JSONObject h = note.getJSONObject("header");
        if (req.getInt("tokenType") != 0 || !req.getString("tokenAddress").toLowerCase().equals("0xfff9976782d46cc05630d1f6ebab18b2324d6b14")
                || new BigInteger(req.getString("tokenSubID")).signum() != 0) { log("REFUSED: shield request is not plain ERC20 WETH"); return "REFUSED"; }
        if (t.has("escrow") && !t.getString("escrow").toLowerCase().replace("0x", "").equals(h.getString("escrow"))) { log("REFUSED: shield target is for another escrow"); return "REFUSED"; }
        String sh = shieldHash(req);
        String key = sha("PRAWL-REDEEM-SHIELD|" + h.getString("chainId") + "|" + h.getString("escrow") + "|" + sh);
        JSONArray outs = new JSONArray().put(new JSONObject().put("value", note.getString("value")).put("key", key));
        int depth = note.getJSONArray("path").length();
        byte[] sig;
        try { sig = sign(note.getString("alias"), spendMessage(h, depth, note.getString("noteId"), outs), false); }
        catch (Throwable e) { log("REFUSED BY SECURE HARDWARE: " + String.valueOf(e.getMessage()).split("\n")[0]); return "REFUSED"; }
        JSONObject red = new JSONObject().put("header", h).put("path", note.getJSONArray("path"))
                .put("redeem", new JSONObject().put("outputs", outs).put("index", 0).put("payout", "0x0000000000000000000000000000000000000000")
                        .put("kind", "shield").put("shield", req).put("shieldHash", "0x" + sh)
                        .put("sig", Base64.encodeToString(sig, Base64.NO_WRAP)));
        note.put("spent", true).put("redeemedTo", "RAILGUN shield npk " + req.getString("npk"));
        write(noteFile(note.getString("alias")), note.toString());
        write(new File(outDir, "redeem3_" + coin + "_" + note.getString("alias") + ".json"), carry(red, new JSONObject()).toString());
        log("REDEEM-TO-SHIELD SIGNED: " + eth(new BigInteger(note.getString("value"))) + " ETH note " + note.getString("alias")
                + " -> RAILGUN npk " + req.getString("npk").substring(0, 18) + "… (shieldHash " + sh.substring(0, 16) + "…)");
        return "OK";
    }

    // ================================================================ Bluetooth (v3)

    String bt3Receive(String name, String snapFile, boolean auth) throws Exception {
        JSONObject snap = new JSONObject(read(new File(in, snapFile)));
        JSONObject req = request(name, auth);
        BluetoothServerSocket ss = bt().listenUsingInsecureRfcommWithServiceRecord("PrawlOTK3", BT_UUID);
        log("BT LISTENING as '" + name + "' (offline)");
        BluetoothSocket s;
        try { s = ss.accept(120_000); } finally { ss.close(); }
        long t0 = System.nanoTime();
        try (BluetoothSocket sock = s) {
            DataOutputStream o = new DataOutputStream(sock.getOutputStream());
            DataInputStream i = new DataInputStream(sock.getInputStream());
            send(o, req.toString());
            String pay;
            try { pay = recv(i); } catch (Exception e) { log("link lost before payment arrived; receive key kept for retry"); return "LINK_LOST"; }
            if (pay.equals("{}")) { log("payer sent no payment (payer's secure hardware refused)"); try { send(o, "NOTHING"); } catch (Exception ig) {} return "NO_PAYMENT"; }
            String verdict = accept3(new JSONObject(pay), name, snap);
            try { send(o, verdict); } catch (Exception ig) {}
            log("BT session " + (System.nanoTime() - t0) / 1_000_000 + " ms, payment " + pay.length() + " B");
            return verdict;
        }
    }

    String bt3Pay(String coin, BigInteger amount, String addr) throws Exception {
        long t0 = System.nanoTime();
        BluetoothSocket s = bt().getRemoteDevice(addr).createInsecureRfcommSocketToServiceRecord(BT_UUID);
        s.connect();
        try (BluetoothSocket sock = s) {
            DataOutputStream o = new DataOutputStream(sock.getOutputStream());
            DataInputStream i = new DataInputStream(sock.getInputStream());
            JSONObject req = new JSONObject(recv(i));
            JSONObject p = pay3(coin, amount, req);
            if (p == null) { send(o, "{}"); return "REFUSED"; }
            send(o, p.toString());
            String verdict = recv(i);
            log("BT payee verdict: " + verdict + " (" + (System.nanoTime() - t0) / 1_000_000 + " ms total)");
            return "PAID:" + verdict;
        }
    }

    String show3() throws Exception {
        File[] fs = wallet.listFiles();
        BigInteger total = BigInteger.ZERO;
        if (fs != null) for (File f : fs) if (f.getName().startsWith("note_")) {
            JSONObject n = new JSONObject(read(f));
            BigInteger v = new BigInteger(n.getString("value"));
            boolean spent = n.has("spent");
            if (!spent) total = total.add(v);
            log("NOTE " + n.getJSONObject("header").getString("label") + " " + eth(v) + " ETH key=" + n.getString("alias")
                    + " depth=" + n.getJSONArray("path").length() + (spent ? " (spent" + (n.has("redeemedTo") ? ", redeemed)" : ")") : ""));
        }
        log("SPENDABLE TOTAL " + eth(total) + " ETH");
        return "OK";
    }
}
