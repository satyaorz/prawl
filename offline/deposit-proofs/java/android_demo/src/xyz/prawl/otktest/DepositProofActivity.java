package xyz.prawl.otktest;

import android.app.Activity;
import android.os.Bundle;
import android.util.Log;
import android.widget.ScrollView;
import android.widget.TextView;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;

/**
 * On-phone check + benchmark of DepositProof (not installed by the deposit_proofs work; for the coordinator).
 * Reads assets/deposit_proofs/vectors/manifest.json (+ the files it names), runs every vector, then times the
 * real proofs. Output: screen and `adb logcat -s PrawlDepositProof`.
 */
public class DepositProofActivity extends Activity {
    static final String TAG = "PrawlDepositProof";
    TextView out;

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        out = new TextView(this);
        out.setTextIsSelectable(true);
        out.setTextSize(11);
        ScrollView sv = new ScrollView(this);
        sv.addView(out);
        setContentView(sv);
        new Thread(this::run).start();
    }

    void log(String s) {
        Log.i(TAG, s);
        runOnUiThread(() -> out.append(s + "\n"));
    }

    String asset(String name) throws Exception {
        try (InputStream in = getAssets().open("deposit_proofs/vectors/" + name)) {
            ByteArrayOutputStream bo = new ByteArrayOutputStream();
            byte[] buf = new byte[65536];
            int n;
            while ((n = in.read(buf)) > 0) bo.write(buf, 0, n);
            return new String(bo.toByteArray(), StandardCharsets.UTF_8);
        }
    }

    @SuppressWarnings("unchecked")
    void run() {
        try {
            DepositProof.loadNative(null);
            List<Object> manifest = (List<Object>) DepositProof.Json.parse(asset("manifest.json"));
            int ok = 0;
            for (Object o : manifest) {
                Map<String, Object> v = (Map<String, Object>) o;
                DepositProof.Cache cache = DepositProof.Cache.fromJson(asset((String) v.get("cache")));
                if (v.get("min_participants") != null) cache.minParticipants = ((Long) v.get("min_participants")).intValue();
                byte[] exp = v.get("expected_value") == null ? null : DepositProof.unhex((String) v.get("expected_value"));
                long now = v.get("now") == null ? -1 : (Long) v.get("now");
                DepositProof.Result r = DepositProof.verify(cache, asset((String) v.get("proof")),
                        DepositProof.unhex((String) v.get("address")), DepositProof.unhex((String) v.get("key")), exp, now);
                boolean pass = (r.ok ? "accept" : "reject").equals(v.get("expect"));
                if (pass) ok++;
                log((pass ? "PASS " : "FAIL ") + v.get("name") + String.format(" %.1fms ", r.totalNanos / 1e6) + (r.ok ? "" : r.error));
            }
            log("vectors " + ok + "/" + manifest.size());
            bench("inclusion (1 BLS)", "cache_now.json", "proof_weth_balance.json");
            bench("stepped (3 BLS)", "cache_1403_stale.json", "proof_weth_balance_stepped.json");
        } catch (Throwable t) {
            log("ERROR " + t);
        }
    }

    @SuppressWarnings("unchecked")
    void bench(String label, String cacheName, String proofName) throws Exception {
        String proof = asset(proofName);
        DepositProof.Cache cache = DepositProof.Cache.fromJson(asset(cacheName));
        Map<String, Object> p = (Map<String, Object>) DepositProof.Json.parse(proof);
        byte[] addr = DepositProof.unhex((String) ((Map<String, Object>) p.get("account")).get("address"));
        byte[] key = DepositProof.unhex((String) ((Map<String, Object>) p.get("storage")).get("key"));
        List<Double> tot = new ArrayList<>(), bls = new ArrayList<>();
        double first = -1;
        for (int i = 0; i < 25; i++) {
            DepositProof.Result r = DepositProof.verify(cache, proof, addr, key, null, -1);
            if (!r.ok) { log("BENCH FAIL " + r.error); return; }
            if (first < 0) first = r.totalNanos / 1e6;
            if (i >= 5) { tot.add(r.totalNanos / 1e6); bls.add(r.blsNanos / 1e6); }
        }
        Collections.sort(tot);
        Collections.sort(bls);
        log(String.format("TIMING %s first=%.1fms median=%.1fms (bls %.1fms) min=%.1f max=%.1f n=20", label, first, tot.get(10),
                bls.get(10), tot.get(0), tot.get(19)));
    }
}
