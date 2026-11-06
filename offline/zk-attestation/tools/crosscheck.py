#!/usr/bin/env python3
"""Cross-check: the circuit's reference walker (chains.walk_leaf) vs the existing otk_verifier.py leaf policy,
on every distinct real leaf. Leaf-local rules only (chain/root/RKP rules are outside the v0 leaf circuit)."""
import hashlib, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import chains
sys.path.insert(0, chains.SEAM_A)
import otk_verifier as ov
from cryptography import x509
from cryptography.hazmat.primitives import serialization

chains.preload_v3()
seen = set(); agree = disagree = 0
for f in chains.all_sources():
    for lab, ch in chains.load_chains(f):
        leaf = ch[0]
        h = hashlib.sha256(leaf.public_bytes(serialization.Encoding.DER)).hexdigest()[:12]
        if h in seen: continue
        seen.add(h)
        ext = leaf.extensions.get_extension_for_oid(x509.ObjectIdentifier(ov.OID_KEY_DESC))
        kd = ov.parse_key_description(ext.value.value)
        hw, sw = kd["hardwareEnforced"], kd["softwareEnforced"]
        rot = hw.get("rootOfTrust", {})
        aid = sw.get("attestationApplicationId", "")
        ref_ok = (kd["attestationSecurityLevel"] in ("TrustedEnvironment", "StrongBox")
                  and kd["keyMintSecurityLevel"] == kd["attestationSecurityLevel"]
                  and hw.get("usageCountLimit") == 1 and "usageCountLimit" not in sw
                  and hw.get("origin") == 0 and 2 in hw.get("purpose", [])
                  and hw.get("algorithm") == 3 and hw.get("ecCurve") == 1
                  and rot.get("deviceLocked") is True and rot.get("verifiedBootState") == "Verified"
                  and chains.EXPECTED_PKG.hex() in aid)
        tbs = leaf.tbs_certificate_bytes
        try:
            chains.walk_leaf(tbs, len(tbs)); w_ok, why = True, ""
        except chains.WalkError as e:
            w_ok, why = False, str(e)
        same = (w_ok == ref_ok)
        agree += same; disagree += (not same)
        print(f"{h} {lab:45s} otk_verifier_leaf_policy={ref_ok!s:5} circuit_walker={w_ok!s:5} {'' if same else 'DISAGREE'} {why}")
print(f"agree={agree} disagree={disagree}")
