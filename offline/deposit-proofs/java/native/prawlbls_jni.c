/*
 * prawlbls_jni.c - the only native code of the Prawl deposit-proof verifier.
 *
 * Exposes one function to Java:
 *   xyz.prawl.otktest.DepositProof.blsFastAggregateVerify(byte[] pubkeys, byte[] msg, byte[] sig)
 * = Ethereum consensus `bls.FastAggregateVerify` (IETF BLS draft-irtf-cfrg-bls-signature-05,
 *   ciphersuite BLS_SIG_BLS12381G2_XMD:SHA-256_SSWU_RO_POP_, min-pubkey-size: pubkeys in G1, sig in G2)
 * built on blst v0.3.17 (supranational, Apache-2.0).
 *
 * pubkeys: n*48 bytes, n >= 1, concatenated compressed G1 points.
 * Return:  1 = valid; 0 = signature does not verify;
 *         -1 = bad argument lengths; -2 = a pubkey does not decode / is infinity / not in G1;
 *         -3 = signature does not decode / not in G2; -4 = out of memory / JNI failure.
 * Every pubkey is group-checked here (about 1/3 of the total cost) even though the light-client
 * spec assumes committee keys were validated when stored: the phone's cache is then not a
 * single point of failure for curve validity.
 */
#include <jni.h>
#include <stdlib.h>
#include <string.h>
#include "blst.h"

static const char DST[] = "BLS_SIG_BLS12381G2_XMD:SHA-256_SSWU_RO_POP_";

JNIEXPORT jint JNICALL
Java_xyz_prawl_otktest_DepositProof_blsFastAggregateVerify(JNIEnv *env, jclass cls,
                                                           jbyteArray jpks, jbyteArray jmsg, jbyteArray jsig)
{
    (void)cls;
    if (jpks == NULL || jmsg == NULL || jsig == NULL) return -1;
    jsize pk_len = (*env)->GetArrayLength(env, jpks);
    jsize msg_len = (*env)->GetArrayLength(env, jmsg);
    jsize sig_len = (*env)->GetArrayLength(env, jsig);
    if (pk_len <= 0 || pk_len % 48 != 0 || sig_len != 96 || msg_len < 0 || pk_len > 48 * 4096) return -1;
    int n = pk_len / 48;

    jbyte *pks = (*env)->GetByteArrayElements(env, jpks, NULL);
    jbyte *msg = (*env)->GetByteArrayElements(env, jmsg, NULL);
    jbyte *sig = (*env)->GetByteArrayElements(env, jsig, NULL);
    jint rc = -4;
    if (pks == NULL || msg == NULL || sig == NULL) goto out;

    blst_p1 acc;
    blst_p1_affine pk_aff, agg_aff;
    blst_p2_affine sig_aff;
    memset(&acc, 0, sizeof(acc)); /* all-zero projective point is the identity in blst */

    for (int i = 0; i < n; i++) {
        if (blst_p1_uncompress(&pk_aff, (const byte *)pks + 48 * i) != BLST_SUCCESS) { rc = -2; goto out; }
        if (blst_p1_affine_is_inf(&pk_aff) || !blst_p1_affine_in_g1(&pk_aff)) { rc = -2; goto out; }
        blst_p1_add_or_double_affine(&acc, &acc, &pk_aff);
    }
    blst_p1_to_affine(&agg_aff, &acc);
    if (blst_p1_affine_is_inf(&agg_aff)) { rc = 0; goto out; }

    if (blst_p2_uncompress(&sig_aff, (const byte *)sig) != BLST_SUCCESS) { rc = -3; goto out; }
    if (!blst_p2_affine_in_g2(&sig_aff)) { rc = -3; goto out; }

    BLST_ERROR e = blst_core_verify_pk_in_g1(&agg_aff, &sig_aff, 1 /* hash, not encode */,
                                             (const byte *)msg, (size_t)msg_len,
                                             (const byte *)DST, sizeof(DST) - 1, NULL, 0);
    rc = (e == BLST_SUCCESS) ? 1 : 0;
out:
    if (pks) (*env)->ReleaseByteArrayElements(env, jpks, pks, JNI_ABORT);
    if (msg) (*env)->ReleaseByteArrayElements(env, jmsg, msg, JNI_ABORT);
    if (sig) (*env)->ReleaseByteArrayElements(env, jsig, sig, JNI_ABORT);
    return rc;
}
