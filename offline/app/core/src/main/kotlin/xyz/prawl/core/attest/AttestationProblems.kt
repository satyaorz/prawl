package xyz.prawl.core.attest

/**
 * Plain-language reasons for a failed attestation check, for the person holding the phone. The check names in
 * [AttestationResult.fails] stay as they are (logs and tests use them); this only maps them to what a person can act on.
 * Several failed checks with the same cause give one sentence.
 */
object AttestationProblems {
    /** Who the sentence is about: the other phone (a payee or payer), or this phone (its own receive key). */
    enum class Whose(val subject: String, val possessive: String) { OTHER("That phone", "That phone's"), THIS("This phone", "This phone's") }

    fun explain(fails: List<String>, whose: Whose = Whose.OTHER): List<String> {
        val s = whose.subject
        val p = whose.possessive
        val out = LinkedHashSet<String>()
        for (f in fails) out.add(
            when {
                f.startsWith("usageCountLimit") ->
                    "$p secure hardware cannot limit a key to a single signature, so it cannot hold offline cash safely " +
                        "(it needs Android 12 or later with KeyMint support for one-time keys). Use another phone."
                f.startsWith("key created by app") || f == "app signing cert matches" ->
                    "$s runs a different build of Prowl (signed with a different key). Offline cash only moves between phones running " +
                        "the same Prowl build: install the same APK on both, and use the Prowl app, not an older test app."
                f == "bootloader locked" || f == "verified boot" ->
                    "$s has an unlocked bootloader or a modified system, so its secure hardware cannot be trusted."
                f.startsWith("security patch") ->
                    "$p security update is too old (Prowl needs the ${patchText(f)} patch or newer). Update the phone in Settings."
                f.startsWith("attestation from TEE") || f.startsWith("keymint level") || f.startsWith("RKP chain") ->
                    "$s has no secure hardware Prowl trusts for offline cash (it needs StrongBox, or a TEE with Google-provisioned keys)."
                f.startsWith("RKP cert") && f.endsWith("inside validity") ->
                    "$p attestation certificate has expired or is not valid yet. Check the date and time on both phones, and let that " +
                        "phone go online once so it gets new certificates."
                f.startsWith("root is a pinned") || f.contains("signed by cert") || f.contains("issuer is cert") || f.contains("is a CA") ->
                    "$p key could not be traced back to Google's attestation root, so it is not a genuine hardware key."
                f.startsWith("serial ") && f.endsWith("not revoked") ->
                    "$p attestation certificate has been revoked by Google, so its keys cannot be trusted."
                else -> "Check failed: $f"
            },
        )
        return out.toList()
    }

    private fun patchText(f: String): String =
        Regex("(\\d{4})(\\d{2})").find(f)?.let { "${it.groupValues[1]}-${it.groupValues[2]}" } ?: "current"
}
