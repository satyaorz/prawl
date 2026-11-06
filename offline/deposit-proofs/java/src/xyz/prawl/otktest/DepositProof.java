package xyz.prawl.otktest;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

/**
 * Prawl v3 deposit proof: offline check that storage slot {@code key} of contract {@code address}
 * holds a given 32-byte value at a finalized Sepolia block, under the Ethereum light-client
 * (sync-committee) trust model. Java port of deposit_proofs/python/verifier.py; same checks, same order:
 *
 * <ol>
 *   <li>Committee stepping: each LightClientUpdate in {@code proof.updates} is signed by a committee we
 *       already know (&ge; 342 of 512), its finalized header is proven by {@code finality_branch}, and its
 *       {@code next_sync_committee} is proven against the attested state root; we learn period+1.</li>
 *   <li>Finality update: sync aggregate (&ge; 342) by the committee of period(signature_slot); BLS
 *       FastAggregateVerify over the signing root of the attested header with domain
 *       DOMAIN_SYNC_COMMITTEE + fork version of epoch(signature_slot - 1) + Sepolia genesis_validators_root;
 *       {@code finality_branch} (gindex 735) proves the finalized header; {@code execution_branch}
 *       (gindex 2856) proves {@code execution_block_hash} (= the Gloas bid's parent_block_hash) against
 *       the finalized body_root.</li>
 *   <li>Execution: keccak256(header RLP) == execution_block_hash; read stateRoot, number, timestamp.</li>
 *   <li>Account proof (path keccak(address)) against stateRoot gives storageRoot.</li>
 *   <li>Storage proof (path keccak(key)) against storageRoot gives the value (0 if proven absent).</li>
 * </ol>
 *
 * Only BLS is native (blst v0.3.17 through libprawlbls.so, see java/native/). Everything else uses
 * java.security.MessageDigest (SHA-256) and the Keccak-256 below. No Android APIs are used, so the
 * same class runs on a laptop JVM.
 */
public final class DepositProof {

    // ------------------------------------------------------------------ Sepolia constants
    // Read from a live Sepolia beacon node on 2026-11-06 (/eth/v1/config/spec, /fork_schedule, /genesis)
    // and from consensus-specs gloas/light-client/sync-protocol.md. Never taken from the proof.
    public static final String NETWORK = "sepolia";
    public static final long GENESIS_TIME = 1655733600L;
    static final byte[] GENESIS_VALIDATORS_ROOT = unhex("d8ea171f3c94aea21ebc42a1ed61052acf3f9209c00e4efbaaddac09ed9b8078");
    static final int SECONDS_PER_SLOT = 12;
    static final int SLOTS_PER_EPOCH = 32;
    static final int EPOCHS_PER_SYNC_COMMITTEE_PERIOD = 256;
    public static final long SLOTS_PER_PERIOD = (long) SLOTS_PER_EPOCH * EPOCHS_PER_SYNC_COMMITTEE_PERIOD;
    static final int SYNC_COMMITTEE_SIZE = 512;
    static final byte[] DOMAIN_SYNC_COMMITTEE = unhex("07000000");
    static final long[] FORK_EPOCHS = {0L, 50L, 100L, 56832L, 132608L, 222464L, 272640L, 353024L};
    static final String[] FORK_VERSIONS = {"90000069", "90000070", "90000071", "90000072", "90000073", "90000074",
            "90000075", "90000076"};
    static final long GLOAS_FORK_EPOCH = 353024L;
    /** Next fork (HEZE) is FAR_FUTURE today. Set it when scheduled; data at/after it is refused. */
    static final long NEXT_UNKNOWN_FORK_EPOCH = Long.MAX_VALUE;
    static final long FINALIZED_ROOT_GINDEX_GLOAS = 735L;
    static final long CURRENT_SYNC_COMMITTEE_GINDEX_GLOAS = 2945L;
    static final long NEXT_SYNC_COMMITTEE_GINDEX_GLOAS = 2946L;
    static final long EXECUTION_BLOCK_HASH_GINDEX_GLOAS = 2856L;
    /** 2/3 supermajority of 512 (spec's sum*3 &gt;= 512*2). MIN_SYNC_COMMITTEE_PARTICIPANTS=1 is too weak. */
    public static final int MIN_PARTICIPANTS = 342;
    public static final String PROOF_VERSION = "prawl-deposit-proof-v1";
    public static final String CACHE_VERSION = "prawl-lc-cache-v1";

    private DepositProof() {}

    /** Thrown for every failed check; the message names the check. */
    public static final class ProofException extends Exception {
        private static final long serialVersionUID = 1L;

        ProofException(String m) { super(m); }
    }

    static void require(boolean c, String msg) throws ProofException {
        if (!c) throw new ProofException(msg);
    }

    static long epochAtSlot(long slot) { return slot / SLOTS_PER_EPOCH; }

    public static long periodAtSlot(long slot) { return slot / SLOTS_PER_PERIOD; }

    public static long slotStartTime(long slot) { return GENESIS_TIME + slot * SECONDS_PER_SLOT; }

    static byte[] forkVersionAtEpoch(long epoch) throws ProofException {
        require(epoch < NEXT_UNKNOWN_FORK_EPOCH, "epoch " + epoch + " is after a fork this verifier does not know");
        String v = null;
        for (int i = 0; i < FORK_EPOCHS.length; i++) if (epoch >= FORK_EPOCHS[i]) v = FORK_VERSIONS[i];
        return unhex(v);
    }

    // ------------------------------------------------------------------ native BLS (blst)
    private static volatile boolean nativeLoaded;

    /** On Android: System.loadLibrary("prawlbls") from the APK's lib/&lt;abi&gt;/. On a JVM: pass the .so path. */
    public static synchronized void loadNative(String absolutePathOrNull) {
        if (nativeLoaded) return;
        if (absolutePathOrNull == null) System.loadLibrary("prawlbls");
        else System.load(absolutePathOrNull);
        nativeLoaded = true;
    }

    /** 1 valid, 0 invalid, &lt;0 malformed input (see prawlbls_jni.c). */
    static native int blsFastAggregateVerify(byte[] pubkeysConcat, byte[] message, byte[] signature96);

    // ------------------------------------------------------------------ hashing
    static byte[] sha256(byte[] a, byte[] b) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            md.update(a);
            if (b != null) md.update(b);
            return md.digest();
        } catch (Exception e) { throw new IllegalStateException(e); }
    }

    private static final long[] KECCAK_RC = {
            0x0000000000000001L, 0x0000000000008082L, 0x800000000000808AL, 0x8000000080008000L,
            0x000000000000808BL, 0x0000000080000001L, 0x8000000080008081L, 0x8000000000008009L,
            0x000000000000008AL, 0x0000000000000088L, 0x0000000080008009L, 0x000000008000000AL,
            0x000000008000808BL, 0x800000000000008BL, 0x8000000000008089L, 0x8000000000008003L,
            0x8000000000008002L, 0x8000000000000080L, 0x000000000000800AL, 0x800000008000000AL,
            0x8000000080008081L, 0x8000000000008080L, 0x0000000080000001L, 0x8000000080008008L};
    private static final int[] KECCAK_ROTC = {1, 3, 6, 10, 15, 21, 28, 36, 45, 55, 2, 14, 27, 41, 56, 8, 25, 43, 62, 18, 39, 61, 20, 44};
    private static final int[] KECCAK_PILN = {10, 7, 11, 17, 18, 3, 5, 16, 8, 21, 24, 4, 15, 23, 19, 13, 12, 2, 20, 14, 22, 9, 6, 1};

    private static void keccakF(long[] st) {
        long[] bc = new long[5];
        for (int r = 0; r < 24; r++) {
            for (int i = 0; i < 5; i++) bc[i] = st[i] ^ st[i + 5] ^ st[i + 10] ^ st[i + 15] ^ st[i + 20];   // theta
            for (int i = 0; i < 5; i++) {
                long t = bc[(i + 4) % 5] ^ Long.rotateLeft(bc[(i + 1) % 5], 1);
                for (int j = 0; j < 25; j += 5) st[j + i] ^= t;
            }
            long t = st[1];                                                                              // rho + pi
            for (int i = 0; i < 24; i++) {
                int j = KECCAK_PILN[i];
                long tmp = st[j];
                st[j] = Long.rotateLeft(t, KECCAK_ROTC[i]);
                t = tmp;
            }
            for (int j = 0; j < 25; j += 5) {                                                            // chi
                for (int i = 0; i < 5; i++) bc[i] = st[j + i];
                for (int i = 0; i < 5; i++) st[j + i] ^= (~bc[(i + 1) % 5]) & bc[(i + 2) % 5];
            }
            st[0] ^= KECCAK_RC[r];                                                                       // iota
        }
    }

    /** Ethereum Keccak-256 (original Keccak padding 0x01, not SHA3-256's 0x06). */
    public static byte[] keccak256(byte[] in) {
        final int rate = 136;
        long[] st = new long[25];
        int off = 0;
        byte[] block = new byte[rate];
        while (true) {
            int n = Math.min(rate, in.length - off);
            boolean last = n < rate;
            Arrays.fill(block, (byte) 0);
            System.arraycopy(in, off, block, 0, n);
            if (last) {
                block[n] ^= 0x01;
                block[rate - 1] ^= (byte) 0x80;
            }
            for (int i = 0; i < rate / 8; i++) {
                long lane = 0;
                for (int b = 0; b < 8; b++) lane |= (block[8 * i + b] & 0xFFL) << (8 * b);
                st[i] ^= lane;
            }
            keccakF(st);
            off += n;
            if (last) break;
        }
        byte[] out = new byte[32];
        for (int i = 0; i < 32; i++) out[i] = (byte) (st[i / 8] >>> (8 * (i % 8)));
        return out;
    }

    // ------------------------------------------------------------------ SSZ
    static final byte[] ZERO32 = new byte[32];

    static byte[] uint64Leaf(long v) {
        byte[] o = new byte[32];
        for (int i = 0; i < 8; i++) o[i] = (byte) (v >>> (8 * i));
        return o;
    }

    static byte[] merkleize(List<byte[]> chunks) {
        int width = 1;
        while (width < chunks.size()) width *= 2;
        byte[][] layer = new byte[width][];
        for (int i = 0; i < width; i++) layer[i] = i < chunks.size() ? chunks.get(i) : ZERO32;
        while (width > 1) {
            for (int i = 0; i < width / 2; i++) layer[i] = sha256(layer[2 * i], layer[2 * i + 1]);
            width /= 2;
        }
        return layer[0];
    }

    static final class BeaconHeader {
        long slot, proposerIndex;
        byte[] parentRoot, stateRoot, bodyRoot;

        static BeaconHeader of(Map<String, Object> j) throws ProofException {
            BeaconHeader h = new BeaconHeader();
            h.slot = u64(j, "slot");
            h.proposerIndex = u64(j, "proposer_index");
            h.parentRoot = b32(j, "parent_root");
            h.stateRoot = b32(j, "state_root");
            h.bodyRoot = b32(j, "body_root");
            return h;
        }

        byte[] root() {
            List<byte[]> c = new ArrayList<>();
            c.add(uint64Leaf(slot));
            c.add(uint64Leaf(proposerIndex));
            c.add(parentRoot);
            c.add(stateRoot);
            c.add(bodyRoot);
            return merkleize(c);
        }
    }

    static byte[] pubkeyRoot(byte[] all, int off) {
        byte[] a = Arrays.copyOfRange(all, off, off + 32);
        byte[] b = new byte[32];
        System.arraycopy(all, off + 32, b, 0, 16);
        return sha256(a, b);
    }

    /** hash_tree_root(SyncCommittee): pubkeys is 512*48 bytes. */
    static byte[] syncCommitteeRoot(byte[] pubkeys, byte[] aggregate) {
        List<byte[]> leaves = new ArrayList<>(SYNC_COMMITTEE_SIZE);
        for (int i = 0; i < SYNC_COMMITTEE_SIZE; i++) leaves.add(pubkeyRoot(pubkeys, 48 * i));
        return sha256(merkleize(leaves), pubkeyRoot(aggregate, 0));
    }

    static int floorLog2(long x) { return 63 - Long.numberOfLeadingZeros(x); }

    /** consensus-specs is_valid_normalized_merkle_branch. */
    static boolean isValidNormalizedBranch(byte[] leaf, List<byte[]> branch, long gindex, byte[] root) {
        int depth = floorLog2(gindex);
        long index = gindex & ((1L << depth) - 1);
        int extra = branch.size() - depth;
        if (extra < 0) return false;
        for (int i = 0; i < extra; i++) if (!Arrays.equals(branch.get(i), ZERO32)) return false;
        byte[] v = leaf;
        for (int i = 0; i < depth; i++) {
            byte[] node = branch.get(extra + i);
            v = ((index >>> i) & 1) == 1 ? sha256(node, v) : sha256(v, node);
        }
        return Arrays.equals(v, root);
    }

    static byte[] signingRoot(BeaconHeader attested, long signatureSlot) throws ProofException {
        byte[] version = forkVersionAtEpoch(epochAtSlot(Math.max(signatureSlot, 1) - 1));
        byte[] v32 = new byte[32];
        System.arraycopy(version, 0, v32, 0, 4);
        byte[] forkDataRoot = sha256(v32, GENESIS_VALIDATORS_ROOT);
        byte[] domain = new byte[32];
        System.arraycopy(DOMAIN_SYNC_COMMITTEE, 0, domain, 0, 4);
        System.arraycopy(forkDataRoot, 0, domain, 4, 28);
        return sha256(attested.root(), domain);
    }

    // ------------------------------------------------------------------ RLP (canonical only)
    /** Decodes one item spanning all of data: byte[] for strings, List&lt;Object&gt; for lists. */
    static Object rlpDecode(byte[] data) throws ProofException {
        int[] end = new int[1];
        Object o = rlpItem(data, 0, end);
        require(end[0] == data.length, "trailing bytes after RLP item");
        return o;
    }

    private static int rlpLongLen(byte[] d, int pos, int nlen) throws ProofException {
        require(nlen <= 4 && pos + nlen <= d.length, "RLP length overrun");
        require(d[pos] != 0, "RLP length has leading zero");
        long n = 0;
        for (int i = 0; i < nlen; i++) n = (n << 8) | (d[pos + i] & 0xFF);
        require(n > 55 && n < Integer.MAX_VALUE, "RLP long form used for short length");
        return (int) n;
    }

    private static Object rlpItem(byte[] d, int pos, int[] endOut) throws ProofException {
        require(pos < d.length, "RLP truncated");
        int b0 = d[pos] & 0xFF;
        if (b0 < 0x80) { endOut[0] = pos + 1; return new byte[]{d[pos]}; }
        if (b0 < 0xB8) {
            int n = b0 - 0x80, s = pos + 1;
            require(s + n <= d.length, "RLP string overrun");
            require(!(n == 1 && (d[s] & 0xFF) < 0x80), "RLP single byte not canonical");
            endOut[0] = s + n;
            return Arrays.copyOfRange(d, s, s + n);
        }
        if (b0 < 0xC0) {
            int nlen = b0 - 0xB7, n = rlpLongLen(d, pos + 1, nlen), s = pos + 1 + nlen;
            require((long) s + n <= d.length, "RLP string overrun");
            endOut[0] = s + n;
            return Arrays.copyOfRange(d, s, s + n);
        }
        int s, e;
        if (b0 < 0xF8) { s = pos + 1; e = s + (b0 - 0xC0); }
        else { int nlen = b0 - 0xF7, n = rlpLongLen(d, pos + 1, nlen); s = pos + 1 + nlen; e = s + n; }
        require(e <= d.length && e >= s, "RLP list overrun");
        List<Object> out = new ArrayList<>();
        int p = s;
        int[] end = new int[1];
        while (p < e) { out.add(rlpItem(d, p, end)); p = end[0]; }
        require(p == e, "RLP list length mismatch");
        endOut[0] = e;
        return out;
    }

    static long rlpUint(Object o) throws ProofException {
        require(o instanceof byte[], "RLP integer must be a string");
        byte[] b = (byte[]) o;
        require(b.length <= 8 && (b.length == 0 || b[0] != 0), "RLP integer non-canonical or > 64 bits");
        long v = 0;
        for (byte x : b) v = (v << 8) | (x & 0xFF);
        return v;
    }

    // ------------------------------------------------------------------ Merkle-Patricia trie
    static final byte[] EMPTY_TRIE_ROOT = unhex("56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421");

    private static int[] nibbles(byte[] b) {
        int[] n = new int[b.length * 2];
        for (int i = 0; i < b.length; i++) { n[2 * i] = (b[i] >> 4) & 15; n[2 * i + 1] = b[i] & 15; }
        return n;
    }

    /**
     * Verifies an eth_getProof proof of trie key {@code key32} (already keccak'd) against {@code root}.
     * Returns the leaf value, or null when the proof shows absence. Every node must be used, in order.
     */
    static byte[] mptGet(byte[] root, byte[] key32, List<byte[]> proof) throws ProofException {
        require(root.length == 32, "trie root must be 32 bytes");
        int[] path = nibbles(key32);
        if (Arrays.equals(root, EMPTY_TRIE_ROOT)) {
            for (byte[] n : proof) require(n.length == 1 && (n[0] & 0xFF) == 0x80, "non-empty proof for empty trie");
            return null;
        }
        int i = 0, idx = 0;
        Object ref = root;
        while (true) {
            List<?> node;
            if (ref instanceof List) {
                node = (List<?>) ref;
            } else {
                byte[] h = (byte[]) ref;
                require(h.length == 32, "child reference is neither a hash nor an inline node");
                require(idx < proof.size(), "proof too short");
                byte[] raw = proof.get(idx++);
                require(Arrays.equals(keccak256(raw), h), "proof node " + (idx - 1) + " hash mismatch");
                Object dec = rlpDecode(raw);
                require(dec instanceof List, "trie node is not an RLP list");
                node = (List<?>) dec;
            }
            if (node.size() == 17) {
                require(i < path.length, "key exhausted at branch");
                Object child = node.get(path[i++]);
                if (child instanceof byte[] && ((byte[]) child).length == 0) {
                    require(idx == proof.size(), "extra proof nodes after absence point");
                    return null;
                }
                ref = child;
            } else if (node.size() == 2) {
                require(node.get(0) instanceof byte[], "bad node path");
                byte[] hp = (byte[]) node.get(0);
                require(hp.length >= 1, "empty hex-prefix path");
                int flag = (hp[0] >> 4) & 15;
                require(flag <= 3, "bad hex-prefix flag");
                int[] all = nibbles(hp);
                int[] np;
                if ((flag & 1) == 1) np = Arrays.copyOfRange(all, 1, all.length);
                else { require((hp[0] & 15) == 0, "hex-prefix padding nibble not zero"); np = Arrays.copyOfRange(all, 2, all.length); }
                boolean leaf = flag >= 2;
                int rem = path.length - i;
                boolean prefixMatch = np.length <= rem && Arrays.equals(Arrays.copyOfRange(path, i, i + np.length), np);
                if (leaf) {
                    require(idx == proof.size(), "extra proof nodes after leaf");
                    if (prefixMatch && np.length == rem) {
                        Object v = node.get(1);
                        require(v instanceof byte[] && ((byte[]) v).length > 0, "empty leaf value");
                        return (byte[]) v;
                    }
                    return null;
                }
                if (!prefixMatch) {
                    require(idx == proof.size(), "extra proof nodes after absence point");
                    return null;
                }
                require(np.length > 0, "empty extension");
                i += np.length;
                ref = node.get(1);
            } else {
                throw new ProofException("trie node has " + node.size() + " items");
            }
        }
    }

    // ------------------------------------------------------------------ committees / cache
    public static final class Committee {
        public final long period;
        final byte[] pubkeys;          // 512 * 48
        final byte[] aggregatePubkey;  // 48

        Committee(long period, byte[] pubkeys, byte[] agg) { this.period = period; this.pubkeys = pubkeys; this.aggregatePubkey = agg; }

        static Committee of(long period, Map<String, Object> j) throws ProofException {
            List<Object> pk = arr(j, "pubkeys");
            require(pk.size() == SYNC_COMMITTEE_SIZE, "sync committee must have 512 pubkeys");
            byte[] all = new byte[48 * SYNC_COMMITTEE_SIZE];
            for (int i = 0; i < pk.size(); i++) {
                byte[] p = hexArg(pk.get(i));
                require(p.length == 48, "pubkey must be 48 bytes");
                System.arraycopy(p, 0, all, 48 * i, 48);
            }
            byte[] agg = hexArg(j.get("aggregate_pubkey"));
            require(agg.length == 48, "aggregate pubkey must be 48 bytes");
            return new Committee(period, all, agg);
        }

        Map<String, Object> toJson() {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("period", period);
            List<Object> pk = new ArrayList<>();
            for (int i = 0; i < SYNC_COMMITTEE_SIZE; i++) pk.add("0x" + hex(Arrays.copyOfRange(pubkeys, 48 * i, 48 * i + 48)));
            m.put("pubkeys", pk);
            m.put("aggregate_pubkey", "0x" + hex(aggregatePubkey));
            return m;
        }
    }

    /**
     * The recipient's sync-committee cache: the committees it trusts, by period. Created online from a
     * LightClientBootstrap at a trusted finalized checkpoint, extended with LightClientUpdates.
     * Same JSON format as python/builder.py ("prawl-lc-cache-v1").
     */
    public static final class Cache {
        final TreeMap<Long, Committee> committees = new TreeMap<>();
        Map<String, Object> anchor = new LinkedHashMap<>();
        int minParticipants = MIN_PARTICIPANTS;

        public static Cache fromJson(String json) throws ProofException {
            Map<String, Object> j = obj(Json.parse(json));
            require(CACHE_VERSION.equals(j.get("version")), "unknown cache version");
            require(NETWORK.equals(j.get("network")), "cache is for another network");
            require(Arrays.equals(b32(j, "genesis_validators_root"), GENESIS_VALIDATORS_ROOT), "cache genesis_validators_root mismatch");
            Cache c = new Cache();
            if (j.get("anchor") instanceof Map) c.anchor = obj(j.get("anchor"));
            for (Object o : arr(j, "committees")) {
                Map<String, Object> cj = obj(o);
                long p = u64(cj, "period");
                c.committees.put(p, Committee.of(p, cj));
            }
            require(!c.committees.isEmpty(), "cache has no committees");
            return c;
        }

        /**
         * Online sync step: {@code bootstrapResponse} is the body of
         * GET /eth/v1/beacon/light_client/bootstrap/{root}; {@code trustedRoot} is the finalized checkpoint
         * root the phone trusts (e.g. agreed by two independent beacon APIs, or its previous cache).
         */
        public static Cache fromBootstrap(String bootstrapResponse, byte[] trustedRoot) throws ProofException {
            Map<String, Object> resp = obj(Json.parse(bootstrapResponse));
            Map<String, Object> b = resp.containsKey("data") ? obj(resp.get("data")) : resp;
            Map<String, Object> hdr = obj(b.get("header"));
            BeaconHeader h = BeaconHeader.of(obj(hdr.get("beacon")));
            require(Arrays.equals(h.root(), trustedRoot), "bootstrap header root != trusted checkpoint root");
            verifyLcHeader(hdr, "bootstrap");
            long period = periodAtSlot(h.slot);
            Committee c = Committee.of(period, obj(b.get("current_sync_committee")));
            require(isValidNormalizedBranch(syncCommitteeRoot(c.pubkeys, c.aggregatePubkey), b32list(b, "current_sync_committee_branch"),
                    CURRENT_SYNC_COMMITTEE_GINDEX_GLOAS, h.stateRoot), "current_sync_committee_branch invalid (gindex 2945)");
            Cache cache = new Cache();
            cache.committees.put(period, c);
            cache.anchor.put("root", "0x" + hex(trustedRoot));
            cache.anchor.put("slot", Long.toString(h.slot));
            return cache;
        }

        /** Verify one LightClientUpdate and learn the next committee. Returns the learned period. */
        public long applyUpdate(Map<String, Object> u) throws ProofException {
            return DepositProof.applyUpdate(this, u, null);
        }

        /** Body of GET /eth/v1/beacon/light_client/updates (array of {version, data}) or a bare array of updates. */
        public int applyUpdates(String updatesJson) throws ProofException {
            int n = 0;
            for (Object o : (List<?>) Json.parse(updatesJson)) {
                Map<String, Object> m = obj(o);
                applyUpdate(m.containsKey("data") ? obj(m.get("data")) : m);
                n++;
            }
            return n;
        }

        public Cache copy() {
            Cache c = new Cache();
            c.committees.putAll(committees);
            c.anchor = new LinkedHashMap<>(anchor);
            c.minParticipants = minParticipants;
            return c;
        }

        public long maxPeriod() { return committees.lastKey(); }

        /** Last slot whose sync aggregate this cache can verify without updates. */
        public long lastVerifiableSlot() { return (maxPeriod() + 1) * SLOTS_PER_PERIOD - 1; }

        public long validUntilUnix() { return slotStartTime(lastVerifiableSlot() + 1); }

        public String toJson() {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("version", CACHE_VERSION);
            m.put("network", NETWORK);
            m.put("genesis_validators_root", "0x" + hex(GENESIS_VALIDATORS_ROOT));
            m.put("anchor", anchor);
            List<Object> cs = new ArrayList<>();
            for (Committee c : committees.values()) cs.add(c.toJson());
            m.put("committees", cs);
            return Json.write(m);
        }
    }

    // ------------------------------------------------------------------ light-client checks
    static void checkGloasSlot(long slot, String what) throws ProofException {
        require(epochAtSlot(slot) >= GLOAS_FORK_EPOCH, what + " slot " + slot + " is pre-Gloas; unsupported");
        require(epochAtSlot(slot) < NEXT_UNKNOWN_FORK_EPOCH, what + " slot " + slot + " is past a fork this verifier does not know");
    }

    /** Gloas is_valid_light_client_header; returns execution_block_hash. */
    static byte[] verifyLcHeader(Map<String, Object> lcHeader, String what) throws ProofException {
        BeaconHeader b = BeaconHeader.of(obj(lcHeader.get("beacon")));
        checkGloasSlot(b.slot, what);
        byte[] ebh = b32(lcHeader, "execution_block_hash");
        require(isValidNormalizedBranch(ebh, b32list(lcHeader, "execution_branch"), EXECUTION_BLOCK_HASH_GINDEX_GLOAS, b.bodyRoot),
                what + " execution_branch does not prove execution_block_hash against body_root (gindex 2856)");
        return ebh;
    }

    static int verifySyncAggregate(Cache cache, BeaconHeader attested, Map<String, Object> agg, long signatureSlot, Timings t)
            throws ProofException {
        long period = periodAtSlot(signatureSlot);
        Committee c = cache.committees.get(period);
        require(c != null, "no sync committee known for period " + period + " (known: " + cache.committees.keySet()
                + "); proof must carry LightClientUpdates");
        byte[] bits = hexArg(agg.get("sync_committee_bits"));
        require(bits.length * 8 == SYNC_COMMITTEE_SIZE, "bitvector length");
        int n = 0;
        for (int i = 0; i < SYNC_COMMITTEE_SIZE; i++) if (((bits[i / 8] >> (i % 8)) & 1) == 1) n++;
        require(n >= cache.minParticipants, "sync aggregate has " + n + " participants, need >= " + cache.minParticipants);
        byte[] sig = hexArg(agg.get("sync_committee_signature"));
        require(sig.length == 96, "signature must be 96 bytes");
        byte[] msg = signingRoot(attested, signatureSlot);
        byte[] pks = new byte[48 * n];
        int k = 0;
        for (int i = 0; i < SYNC_COMMITTEE_SIZE; i++)
            if (((bits[i / 8] >> (i % 8)) & 1) == 1) System.arraycopy(c.pubkeys, 48 * i, pks, 48 * k++, 48);
        require(nativeLoaded, "BLS native library not loaded (DepositProof.loadNative)");
        long t0 = System.nanoTime();
        int rc = blsFastAggregateVerify(pks, msg, sig);
        if (t != null) t.blsNanos += System.nanoTime() - t0;
        require(rc == 1, "BLS FastAggregateVerify failed (period " + period + ", " + n + " participants, rc=" + rc + ")");
        return n;
    }

    /** Shared finality checks of LightClientUpdate / LightClientFinalityUpdate. Returns {ebh, participants}. */
    static Object[] verifyFinality(Cache cache, Map<String, Object> u, Timings t) throws ProofException {
        Map<String, Object> attH = obj(u.get("attested_header"));
        Map<String, Object> finH = obj(u.get("finalized_header"));
        BeaconHeader att = BeaconHeader.of(obj(attH.get("beacon")));
        BeaconHeader fin = BeaconHeader.of(obj(finH.get("beacon")));
        long sigSlot = u64(u, "signature_slot");
        require(sigSlot > att.slot && att.slot >= fin.slot, "slot order must be signature > attested >= finalized");
        verifyLcHeader(attH, "attested");
        byte[] ebh = verifyLcHeader(finH, "finalized");
        require(fin.slot != 0, "genesis finalized header not accepted");
        require(isValidNormalizedBranch(fin.root(), b32list(u, "finality_branch"), FINALIZED_ROOT_GINDEX_GLOAS, att.stateRoot),
                "finality_branch does not prove finalized header in attested state (gindex 735)");
        int n = verifySyncAggregate(cache, att, obj(u.get("sync_aggregate")), sigSlot, t);
        return new Object[]{ebh, n, fin};
    }

    static long applyUpdate(Cache cache, Map<String, Object> u, Timings t) throws ProofException {
        long attSlot = u64(obj(obj(u.get("attested_header")).get("beacon")), "slot");
        long finSlot = u64(obj(obj(u.get("finalized_header")).get("beacon")), "slot");
        long a = periodAtSlot(attSlot);
        require(periodAtSlot(finSlot) == a && periodAtSlot(u64(u, "signature_slot")) == a,
                "update must have attested, finalized and signature slots in one period");
        verifyFinality(cache, u, t);
        Committee next = Committee.of(a + 1, obj(u.get("next_sync_committee")));
        byte[] attState = b32(obj(obj(u.get("attested_header")).get("beacon")), "state_root");
        require(isValidNormalizedBranch(syncCommitteeRoot(next.pubkeys, next.aggregatePubkey), b32list(u, "next_sync_committee_branch"),
                NEXT_SYNC_COMMITTEE_GINDEX_GLOAS, attState), "next_sync_committee_branch invalid (gindex 2946)");
        Committee known = cache.committees.get(a + 1);
        if (known != null) require(Arrays.equals(known.pubkeys, next.pubkeys), "update contradicts known committee for period " + (a + 1));
        cache.committees.put(a + 1, next);
        return a + 1;
    }

    // ------------------------------------------------------------------ result
    static final class Timings { long blsNanos; }

    public static final class Result {
        public boolean ok;
        public String error;
        public long finalizedSlot, signatureSlot, signaturePeriod, blockNumber, blockTimestamp;
        public int participants;
        public final List<Long> learnedPeriods = new ArrayList<>();
        public byte[] executionBlockHash, stateRoot, storageRoot, value;
        /** The input cache plus committees learned from the proof's updates; persist it if ok. */
        public Cache updatedCache;
        public long totalNanos, blsNanos;

        public String summary() {
            return ok ? ("OK block=" + blockNumber + " slot=" + finalizedSlot + " period=" + signaturePeriod + " participants="
                    + participants + " learned=" + learnedPeriods + " value=0x" + hex(value) + String.format(" %.1fms (bls %.1fms)",
                    totalNanos / 1e6, blsNanos / 1e6)) : ("FAIL " + error);
        }
    }

    /** keccak256(abi.encode(coinId, uint256(0))): storage key of deposits[coinId] in escrow v3 (mapping at slot 0). */
    public static byte[] escrowStorageKey(byte[] coinId32) {
        return mappingSlot(coinId32, 0);
    }

    public static byte[] mappingSlot(byte[] key32, long slot) {
        if (key32.length != 32) throw new IllegalArgumentException("mapping key must be 32 bytes");
        byte[] b = new byte[64];
        System.arraycopy(key32, 0, b, 0, 32);
        for (int i = 0; i < 8; i++) b[63 - i] = (byte) (slot >>> (8 * i));
        return keccak256(b);
    }

    /**
     * Verify a DepositProof. Never throws for bad input: failures come back as {@code ok=false}.
     *
     * @param cache         recipient's trusted committee cache (not modified; see Result.updatedCache)
     * @param proofJson     the DepositProof JSON carried with the coin (untrusted)
     * @param address       the escrow contract address the recipient expects (20 bytes)
     * @param storageKey    the storage slot the recipient computed itself, e.g. escrowStorageKey(coinId)
     * @param expectedValue 32 bytes the slot must hold, or null to just return it
     * @param nowUnix       phone clock (seconds) to refuse signature slots in the future, or -1 to skip
     */
    public static Result verify(Cache cache, String proofJson, byte[] address, byte[] storageKey, byte[] expectedValue, long nowUnix) {
        Result r = new Result();
        long t0 = System.nanoTime();
        Timings t = new Timings();
        try {
            require(address != null && address.length == 20, "address must be 20 bytes");
            require(storageKey != null && storageKey.length == 32, "storage key must be 32 bytes");
            Map<String, Object> p = obj(Json.parse(proofJson));
            require(PROOF_VERSION.equals(p.get("version")), "unknown proof version");
            require(NETWORK.equals(p.get("network")), "proof is for another network");
            Cache c = cache.copy();
            if (p.get("updates") != null)
                for (Object u : arr(p, "updates")) r.learnedPeriods.add(applyUpdate(c, obj(u), t));

            Map<String, Object> fu = obj(p.get("finality_update"));
            r.signatureSlot = u64(fu, "signature_slot");
            if (nowUnix >= 0) require(slotStartTime(r.signatureSlot) <= nowUnix + 2L * SECONDS_PER_SLOT, "signature_slot is in the future");
            Object[] fin = verifyFinality(c, fu, t);
            r.executionBlockHash = (byte[]) fin[0];
            r.participants = (Integer) fin[1];
            r.finalizedSlot = ((BeaconHeader) fin[2]).slot;
            r.signaturePeriod = periodAtSlot(r.signatureSlot);

            verifyExecutionPart(p, r, address, storageKey, expectedValue);
            r.updatedCache = c;
            r.ok = true;
        } catch (ProofException e) {
            r.ok = false;
            r.error = e.getMessage();
        } catch (RuntimeException e) {          // malformed JSON / wrong types: still just a rejection
            r.ok = false;
            r.error = "malformed proof: " + e;
        }
        r.blsNanos = t.blsNanos;
        r.totalNanos = System.nanoTime() - t0;
        return r;
    }

    /** Steps 3-5: header RLP against r.executionBlockHash, then account and storage proofs. Fills r. */
    static void verifyExecutionPart(Map<String, Object> p, Result r, byte[] address, byte[] storageKey, byte[] expectedValue)
            throws ProofException {
        Map<String, Object> ex = obj(p.get("execution"));
        byte[] rlp = hexArg(ex.get("header_rlp"));
        require(Arrays.equals(keccak256(rlp), r.executionBlockHash), "keccak256(execution header RLP) != execution_block_hash");
        Object hdr = rlpDecode(rlp);
        require(hdr instanceof List && ((List<?>) hdr).size() >= 15, "execution header is not an RLP list of >= 15 fields");
        List<?> f = (List<?>) hdr;
        require(f.get(3) instanceof byte[] && ((byte[]) f.get(3)).length == 32, "bad stateRoot");
        r.stateRoot = (byte[]) f.get(3);
        r.blockNumber = rlpUint(f.get(8));
        r.blockTimestamp = rlpUint(f.get(11));

        Map<String, Object> acct = obj(p.get("account"));
        require(Arrays.equals(hexArg(acct.get("address")), address), "proof is for a different address");
        byte[] leaf = mptGet(r.stateRoot, keccak256(address), hexList(arr(acct, "proof")));
        require(leaf != null, "account proof shows the contract does not exist");
        Object a = rlpDecode(leaf);
        require(a instanceof List && ((List<?>) a).size() == 4, "account must be [nonce, balance, storageRoot, codeHash]");
        Object sr = ((List<?>) a).get(2);
        require(sr instanceof byte[] && ((byte[]) sr).length == 32, "bad account storageRoot");
        r.storageRoot = (byte[]) sr;

        Map<String, Object> st = obj(p.get("storage"));
        require(Arrays.equals(hexArg(st.get("key")), storageKey), "proof is for a different storage key");
        byte[] sleaf = mptGet(r.storageRoot, keccak256(storageKey), hexList(arr(st, "proof")));
        byte[] value = new byte[32];
        if (sleaf != null) {
            Object v = rlpDecode(sleaf);
            require(v instanceof byte[], "storage leaf must be an RLP string");
            byte[] vb = (byte[]) v;
            require(vb.length > 0 && vb.length <= 32 && vb[0] != 0, "storage leaf must be a canonical non-zero integer");
            System.arraycopy(vb, 0, value, 32 - vb.length, vb.length);
        }
        r.value = value;
        if (expectedValue != null)
            require(Arrays.equals(value, expectedValue), "storage value 0x" + hex(value) + " != expected 0x" + hex(expectedValue));
    }

    /**
     * Execution half only: the caller already trusts {@code blockHash} by other means (used by the anvil
     * end-to-end test of the escrow layout; the beacon part is skipped, so this is NOT a deposit proof).
     */
    public static Result verifyExecutionOnly(String proofJson, byte[] blockHash, byte[] address, byte[] storageKey, byte[] expectedValue) {
        Result r = new Result();
        long t0 = System.nanoTime();
        try {
            require(address != null && address.length == 20 && storageKey != null && storageKey.length == 32, "bad address/key");
            require(blockHash != null && blockHash.length == 32, "block hash must be 32 bytes");
            r.executionBlockHash = blockHash;
            verifyExecutionPart(obj(Json.parse(proofJson)), r, address, storageKey, expectedValue);
            r.ok = true;
        } catch (ProofException e) {
            r.error = e.getMessage();
        } catch (RuntimeException e) {
            r.error = "malformed proof: " + e;
        }
        r.totalNanos = System.nanoTime() - t0;
        return r;
    }

    // ------------------------------------------------------------------ JSON / hex helpers
    static final String HEX = "0123456789abcdef";

    public static String hex(byte[] b) {
        char[] c = new char[b.length * 2];
        for (int i = 0; i < b.length; i++) { c[2 * i] = HEX.charAt((b[i] >> 4) & 15); c[2 * i + 1] = HEX.charAt(b[i] & 15); }
        return new String(c);
    }

    public static byte[] unhex(String s) {
        if (s.startsWith("0x") || s.startsWith("0X")) s = s.substring(2);
        if (s.length() % 2 != 0) throw new IllegalArgumentException("odd-length hex");
        byte[] o = new byte[s.length() / 2];
        for (int i = 0; i < o.length; i++) {
            int hi = Character.digit(s.charAt(2 * i), 16), lo = Character.digit(s.charAt(2 * i + 1), 16);
            if (hi < 0 || lo < 0) throw new IllegalArgumentException("bad hex");
            o[i] = (byte) ((hi << 4) | lo);
        }
        return o;
    }

    static byte[] hexArg(Object o) throws ProofException {
        require(o instanceof String && ((String) o).startsWith("0x"), "expected 0x-hex string");
        try { return unhex((String) o); } catch (IllegalArgumentException e) { throw new ProofException("bad hex: " + e.getMessage()); }
    }

    static byte[] b32(Map<String, Object> m, String k) throws ProofException {
        byte[] b = hexArg(m.get(k));
        require(b.length == 32, k + " must be 32 bytes");
        return b;
    }

    static List<byte[]> b32list(Map<String, Object> m, String k) throws ProofException {
        List<byte[]> out = new ArrayList<>();
        for (Object o : arr(m, k)) {
            byte[] b = hexArg(o);
            require(b.length == 32, k + " entries must be 32 bytes");
            out.add(b);
        }
        return out;
    }

    static List<byte[]> hexList(List<Object> l) throws ProofException {
        List<byte[]> out = new ArrayList<>();
        for (Object o : l) out.add(hexArg(o));
        return out;
    }

    @SuppressWarnings("unchecked")
    static Map<String, Object> obj(Object o) throws ProofException {
        require(o instanceof Map, "expected JSON object");
        return (Map<String, Object>) o;
    }

    @SuppressWarnings("unchecked")
    static List<Object> arr(Map<String, Object> m, String k) throws ProofException {
        Object o = m.get(k);
        require(o instanceof List, "expected JSON array at " + k);
        return (List<Object>) o;
    }

    /** Beacon API encodes uint64 as decimal strings; our cache uses JSON numbers. Accept both, non-negative. */
    static long u64(Map<String, Object> m, String k) throws ProofException {
        Object o = m.get(k);
        if (o instanceof Long) {
            require((Long) o >= 0, k + " negative");
            return (Long) o;
        }
        // Strict: ASCII decimal digits only (parseLong alone would accept "+3" and non-ASCII digits).
        require(o instanceof String && !((String) o).isEmpty() && ((String) o).length() <= 19, "bad integer at " + k);
        for (char ch : ((String) o).toCharArray()) require(ch >= '0' && ch <= '9', "bad integer at " + k);
        return Long.parseLong((String) o);   // <= 19 digits; values above Long.MAX_VALUE throw (caught as malformed)
    }

    /** Minimal strict JSON reader/writer (objects, arrays, strings, integers, true/false/null). */
    static final class Json {
        private final String s;
        private int p;

        private Json(String s) { this.s = s; }

        static Object parse(String s) throws ProofException {
            Json j = new Json(s);
            try {
                j.ws();
                Object o = j.value(0);
                j.ws();
                require(j.p == s.length(), "trailing JSON");
                return o;
            } catch (RuntimeException e) {
                throw new ProofException("bad JSON at " + j.p + ": " + e);
            }
        }

        private void ws() { while (p < s.length() && " \t\r\n".indexOf(s.charAt(p)) >= 0) p++; }

        private Object value(int depth) throws ProofException {
            require(depth < 64 && p < s.length(), "bad JSON");
            char c = s.charAt(p);
            if (c == '{') {
                p++;
                Map<String, Object> m = new LinkedHashMap<>();
                ws();
                if (s.charAt(p) == '}') { p++; return m; }
                while (true) {
                    ws();
                    require(p < s.length() && s.charAt(p) == '"', "JSON key");
                    String k = str();
                    ws();
                    require(p < s.length() && s.charAt(p++) == ':', "JSON colon");
                    ws();
                    require(!m.containsKey(k), "duplicate JSON key " + k);
                    m.put(k, value(depth + 1));
                    ws();
                    require(p < s.length(), "bad JSON");
                    char d = s.charAt(p++);
                    if (d == '}') return m;
                    require(d == ',', "JSON comma");
                }
            }
            if (c == '[') {
                p++;
                List<Object> l = new ArrayList<>();
                ws();
                if (s.charAt(p) == ']') { p++; return l; }
                while (true) {
                    ws();
                    l.add(value(depth + 1));
                    ws();
                    require(p < s.length(), "bad JSON");
                    char d = s.charAt(p++);
                    if (d == ']') return l;
                    require(d == ',', "JSON comma");
                }
            }
            if (c == '"') return str();
            if (s.startsWith("true", p)) { p += 4; return Boolean.TRUE; }
            if (s.startsWith("false", p)) { p += 5; return Boolean.FALSE; }
            if (s.startsWith("null", p)) { p += 4; return null; }
            int st = p;
            if (s.charAt(p) == '-') p++;
            while (p < s.length() && s.charAt(p) >= '0' && s.charAt(p) <= '9') p++;
            require(p > st, "bad JSON value");
            if (p < s.length() && ".eE".indexOf(s.charAt(p)) >= 0) {        // non-integers: keep as string, unused
                while (p < s.length() && "0123456789.eE+-".indexOf(s.charAt(p)) >= 0) p++;
                return s.substring(st, p);
            }
            try { return Long.parseLong(s.substring(st, p)); } catch (NumberFormatException e) { return s.substring(st, p); }
        }

        private String str() throws ProofException {
            p++;
            StringBuilder b = new StringBuilder();
            while (true) {
                require(p < s.length(), "unterminated JSON string");
                char c = s.charAt(p++);
                if (c == '"') return b.toString();
                if (c == '\\') {
                    require(p < s.length(), "bad escape");
                    char e = s.charAt(p++);
                    switch (e) {
                        case 'n': b.append('\n'); break;
                        case 't': b.append('\t'); break;
                        case 'r': b.append('\r'); break;
                        case 'b': b.append('\b'); break;
                        case 'f': b.append('\f'); break;
                        case 'u':
                            require(p + 4 <= s.length(), "bad \\u escape");
                            b.append((char) Integer.parseInt(s.substring(p, p + 4), 16));
                            p += 4;
                            break;
                        default: b.append(e);
                    }
                } else b.append(c);
            }
        }

        static String write(Object o) {
            StringBuilder b = new StringBuilder();
            write(o, b);
            return b.toString();
        }

        @SuppressWarnings("unchecked")
        private static void write(Object o, StringBuilder b) {
            if (o == null) b.append("null");
            else if (o instanceof String) {
                b.append('"');
                for (char c : ((String) o).toCharArray()) {
                    if (c == '"' || c == '\\') b.append('\\').append(c);
                    else if (c < 0x20) b.append(String.format("\\u%04x", (int) c));
                    else b.append(c);
                }
                b.append('"');
            } else if (o instanceof Map) {
                b.append('{');
                boolean first = true;
                for (Map.Entry<String, Object> e : ((Map<String, Object>) o).entrySet()) {
                    if (!first) b.append(',');
                    first = false;
                    write(e.getKey(), b);
                    b.append(':');
                    write(e.getValue(), b);
                }
                b.append('}');
            } else if (o instanceof List) {
                b.append('[');
                boolean first = true;
                for (Object x : (List<Object>) o) {
                    if (!first) b.append(',');
                    first = false;
                    write(x, b);
                }
                b.append(']');
            } else b.append(o.toString());
        }
    }

    /** UTF-8 helper for callers. */
    public static byte[] utf8(String s) { return s.getBytes(StandardCharsets.UTF_8); }
}
