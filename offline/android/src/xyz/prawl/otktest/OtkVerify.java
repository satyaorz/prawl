package xyz.prawl.otktest;

import java.math.BigInteger;
import java.security.MessageDigest;
import java.security.PublicKey;
import java.security.cert.CertificateFactory;
import java.security.cert.X509Certificate;
import java.io.ByteArrayInputStream;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Offline, on-phone check that an Android Key Attestation chain proves a Prawl
 * one-time coin key. Java port of otk_verifier.py's policy:
 *   - chain signatures verify up to a pinned Google attestation root
 *   - no certificate serial is on the cached revocation list
 *   - leaf carries the KeyDescription extension (OID 1.3.6.1.4.1.11129.2.1.17)
 *   - attestation and KeyMint security level are TEE or StrongBox, and equal
 *   - usageCountLimit == 1 in the HARDWARE-enforced list and absent from software list
 *   - origin GENERATED, purpose SIGN, EC P-256
 *   - rootOfTrust: bootloader locked, verified boot state Verified
 *   - provisioning: RKP chain, or a factory chain from StrongBox (policy choice, see RESULTS.md)
 */
public final class OtkVerify {
    static final String OID_KEY_DESC = "1.3.6.1.4.1.11129.2.1.17";
    static final String OID_PROV_INFO = "1.3.6.1.4.1.11129.2.1.30";

    public static final class Result {
        public boolean ok;
        public final List<String> fails = new ArrayList<>();
        public String level = "?";
        public boolean rkp;
        public PublicKey leafKey;
        public String leafKeyHash;
        public int patch;                                   // osPatchLevel YYYYMM (hardware list)
        public final List<String> pkgs = new ArrayList<>(); // attestationApplicationId package names
        public final List<String> appDigests = new ArrayList<>(); // signing-cert SHA-256 digests (hex)
        public boolean authPerUse;                          // userAuthType set, no timeout: auth per signature
        public String summary() {
            return (ok ? "OK" : "FAIL") + " level=" + level + " rkp=" + rkp + " patch=" + patch + " app=" + pkgs
                    + " authPerUse=" + authPerUse + (fails.isEmpty() ? "" : " fails=" + fails);
        }
    }

    final List<byte[]> rootSpkis = new ArrayList<>();
    final Set<String> revoked = new HashSet<>();
    /** Hardening policy (null/0 = not enforced). */
    public String expectedPkg;          // key must be created by this app ...
    public String expectedAppDigest;    // ... signed with this certificate (SHA-256 hex, lowercase)
    public int minPatch;                // minimum osPatchLevel, YYYYMM

    public OtkVerify(List<byte[]> rootCertsDer, Set<String> revokedHexSerials) throws Exception {
        CertificateFactory cf = CertificateFactory.getInstance("X.509");
        for (byte[] d : rootCertsDer)
            rootSpkis.add(((X509Certificate) cf.generateCertificate(new ByteArrayInputStream(d))).getPublicKey().getEncoded());
        revoked.addAll(revokedHexSerials);
    }

    public static List<X509Certificate> parseChain(List<byte[]> der) throws Exception {
        CertificateFactory cf = CertificateFactory.getInstance("X.509");
        List<X509Certificate> out = new ArrayList<>();
        for (byte[] d : der) out.add((X509Certificate) cf.generateCertificate(new ByteArrayInputStream(d)));
        return out;
    }

    public static String sha256Hex(byte[] b) throws Exception {
        byte[] h = MessageDigest.getInstance("SHA-256").digest(b);
        StringBuilder s = new StringBuilder();
        for (byte x : h) s.append(String.format("%02x", x));
        return s.toString();
    }

    public Result verify(List<byte[]> chainDer) {
        Result r = new Result();
        try {
            List<X509Certificate> chain = parseChain(chainDer);
            if (chain.isEmpty()) { r.fails.add("empty chain"); return r; }
            // 1. signatures up the chain
            for (int i = 0; i + 1 < chain.size(); i++) {
                try { chain.get(i).verify(chain.get(i + 1).getPublicKey()); }
                catch (Exception e) { r.fails.add("cert " + i + " not signed by cert " + (i + 1)); }
            }
            X509Certificate root = chain.get(chain.size() - 1);
            boolean pinned = false;
            for (byte[] s : rootSpkis) if (java.util.Arrays.equals(s, root.getPublicKey().getEncoded())) pinned = true;
            if (!pinned) r.fails.add("root is not a pinned Google attestation root");
            // 2. revocation + RKP detection + validity (RKP certs must be in validity)
            for (X509Certificate c : chain) {
                if (revoked.contains(c.getSerialNumber().toString(16))) r.fails.add("revoked serial " + c.getSerialNumber().toString(16));
                if (c.getExtensionValue(OID_PROV_INFO) != null) r.rkp = true;
            }
            if (r.rkp) for (int i = 0; i + 1 < chain.size(); i++) {
                try { chain.get(i).checkValidity(); } catch (Exception e) { r.fails.add("RKP cert " + i + " outside validity"); }
            }
            // 3. key description must be on the leaf
            X509Certificate leaf = chain.get(0);
            for (int i = 1; i < chain.size(); i++)
                if (chain.get(i).getExtensionValue(OID_KEY_DESC) != null) r.fails.add("attestation extension not on leaf");
            byte[] ext = leaf.getExtensionValue(OID_KEY_DESC);
            if (ext == null) { r.fails.add("no attestation extension"); return r; }
            Der outer = Der.parse(ext, 0);                  // OCTET STRING wrapper
            List<Der> kd = Der.parse(outer.val, 0).children();  // KeyDescription SEQUENCE
            int attLevel = kd.get(1).intVal().intValue();
            int kmLevel = kd.get(3).intVal().intValue();
            Map<Integer, Der> sw = authList(kd.get(6));
            Map<Integer, Der> hw = authList(kd.get(7));
            r.level = attLevel == 2 ? "StrongBox" : attLevel == 1 ? "TEE" : "Software";
            req(r, attLevel == 1 || attLevel == 2, "attestation from TEE/StrongBox");
            req(r, attLevel == kmLevel, "keymint level == attestation level");
            req(r, hw.containsKey(405) && hw.get(405).inner().intVal().intValue() == 1,
                    "usageCountLimit==1 hardware-enforced");
            req(r, !sw.containsKey(405), "usageCountLimit not software-only");
            req(r, hw.containsKey(702) && hw.get(702).inner().intVal().intValue() == 0, "origin GENERATED");
            boolean sign = false;
            if (hw.containsKey(1)) for (Der p : hw.get(1).inner().children()) if (p.intVal().intValue() == 2) sign = true;
            req(r, sign, "purpose SIGN");
            req(r, hw.containsKey(2) && hw.get(2).inner().intVal().intValue() == 3
                    && hw.containsKey(10) && hw.get(10).inner().intVal().intValue() == 1, "EC P-256");
            boolean locked = false, verified = false;
            if (hw.containsKey(704)) {
                List<Der> rot = hw.get(704).inner().children();
                locked = rot.get(1).val.length == 1 && rot.get(1).val[0] != 0;
                verified = rot.get(2).intVal().intValue() == 0;
            }
            req(r, locked, "bootloader locked");
            req(r, verified, "verified boot");
            req(r, r.rkp || attLevel == 2, "RKP chain, or factory StrongBox chain");
            // --- hardening v2 ---
            if (hw.containsKey(706)) r.patch = hw.get(706).inner().intVal().intValue();
            if (minPatch > 0) req(r, r.patch >= minPatch, "security patch >= " + minPatch);
            if (sw.containsKey(709)) {
                List<Der> aid = Der.parse(sw.get(709).inner().val, 0).children(); // AttestationApplicationId
                for (Der pi : aid.get(0).children()) r.pkgs.add(new String(pi.children().get(0).val, "UTF-8"));
                for (Der d : aid.get(1).children()) {
                    StringBuilder h = new StringBuilder(); for (byte x : d.val) h.append(String.format("%02x", x));
                    r.appDigests.add(h.toString());
                }
            }
            if (expectedPkg != null) req(r, r.pkgs.contains(expectedPkg), "key created by app " + expectedPkg);
            if (expectedAppDigest != null) req(r, r.appDigests.contains(expectedAppDigest), "app signing cert matches");
            r.authPerUse = hw.containsKey(504) && !hw.containsKey(505) && !hw.containsKey(503);
            r.leafKey = leaf.getPublicKey();
            r.leafKeyHash = sha256Hex(leaf.getPublicKey().getEncoded());
            r.ok = r.fails.isEmpty();
        } catch (Exception e) {
            r.fails.add("parse error: " + e);
        }
        return r;
    }

    static void req(Result r, boolean cond, String what) { if (!cond) r.fails.add(what); }

    static Map<Integer, Der> authList(Der seq) throws Exception {
        Map<Integer, Der> m = new HashMap<>();
        for (Der d : seq.children()) m.put(d.tag, d);
        return m;
    }

    /** Minimal DER TLV reader (high-tag-number form, long lengths). */
    static final class Der {
        int tag; boolean constructed; byte[] val; int end;
        static Der parse(byte[] b, int i) {
            Der d = new Der();
            int b0 = b[i++] & 0xff;
            d.constructed = (b0 & 0x20) != 0;
            int tag = b0 & 0x1f;
            if (tag == 0x1f) {
                tag = 0;
                while (true) { int x = b[i++] & 0xff; tag = (tag << 7) | (x & 0x7f); if ((x & 0x80) == 0) break; }
            }
            d.tag = tag;
            int len = b[i++] & 0xff;
            if ((len & 0x80) != 0) {
                int n = len & 0x7f; len = 0;
                for (int k = 0; k < n; k++) len = (len << 8) | (b[i++] & 0xff);
            }
            d.val = java.util.Arrays.copyOfRange(b, i, i + len);
            d.end = i + len;
            return d;
        }
        List<Der> children() {
            List<Der> out = new ArrayList<>();
            int i = 0;
            while (i < val.length) { Der c = parse(val, i); out.add(c); i = c.end; }
            return out;
        }
        Der inner() { return parse(val, 0); }      // unwrap EXPLICIT [tag]
        BigInteger intVal() { return new BigInteger(val); }
    }
}
