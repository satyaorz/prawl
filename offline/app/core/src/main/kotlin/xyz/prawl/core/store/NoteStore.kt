package xyz.prawl.core.store

import kotlinx.serialization.json.JsonObject
import xyz.prawl.core.model.Note
import xyz.prawl.core.util.Js
import java.io.File
import java.io.IOException

/**
 * Wallet storage. File layout is the harness's (`files/wallet`):
 *  - `note_<alias>.json`: one note (spent ones are kept, marked `spent`, so a retry can resend the same bytes);
 *  - `pending_<name>.json`: `{"chain":[ids]}` of a receive key not yet paid (reused on retry).
 */
interface NoteStore {
    fun notes(): List<Note>
    fun note(alias: String): Note?
    fun put(note: Note)
    fun pendingChain(name: String): JsonObject?
    fun putPending(name: String, json: JsonObject)
    fun deletePending(name: String)
    fun pendingNames(): List<String>

    /**
     * Record of a payment accepted on receive key `recv_<name>`: {chain, sigHash, value, noteId, until, at}. Kept for
     * a while so a payer whose verdict was lost can resend and be answered ACCEPTED again (idempotent accept).
     */
    fun accepted(name: String): JsonObject?
    fun putAccepted(name: String, json: JsonObject)
    fun deleteAccepted(name: String)
    fun acceptedNames(): List<String>
}

class FileNoteStore(private val dir: File) : NoteStore {
    init { dir.mkdirs() }

    private fun safe(s: String): String {
        require(s.isNotEmpty() && s.all { it.isLetterOrDigit() || it == '_' || it == '-' || it == '.' } && !s.startsWith(".")) { "bad name: $s" }
        return s
    }

    override fun notes(): List<Note> = (dir.listFiles() ?: emptyArray())
        .filter { it.name.startsWith("note_") && it.name.endsWith(".json") }
        .sortedBy { it.name }
        .mapNotNull { f -> runCatching { Note(Js.parse(f.readText())) }.getOrNull() }

    override fun note(alias: String): Note? = File(dir, "note_${safe(alias)}.json").takeIf { it.exists() }?.let { Note(Js.parse(it.readText())) }

    override fun put(note: Note) = atomicWrite(File(dir, "note_${safe(note.alias)}.json"), note.json.toString())

    override fun pendingChain(name: String): JsonObject? =
        File(dir, "pending_${safe(name)}.json").takeIf { it.exists() }?.let { Js.parse(it.readText()) }

    override fun putPending(name: String, json: JsonObject) = atomicWrite(File(dir, "pending_${safe(name)}.json"), json.toString())

    override fun deletePending(name: String) { File(dir, "pending_${safe(name)}.json").delete() }

    override fun pendingNames(): List<String> = (dir.listFiles() ?: emptyArray())
        .map { it.name }.filter { it.startsWith("pending_") && it.endsWith(".json") }
        .map { it.removePrefix("pending_").removeSuffix(".json") }.sorted()

    override fun accepted(name: String): JsonObject? =
        File(dir, "accepted_${safe(name)}.json").takeIf { it.exists() }?.let { runCatching { Js.parse(it.readText()) }.getOrNull() }

    override fun putAccepted(name: String, json: JsonObject) = atomicWrite(File(dir, "accepted_${safe(name)}.json"), json.toString())

    override fun deleteAccepted(name: String) { File(dir, "accepted_${safe(name)}.json").delete() }

    override fun acceptedNames(): List<String> = (dir.listFiles() ?: emptyArray())
        .map { it.name }.filter { it.startsWith("accepted_") && it.endsWith(".json") }
        .map { it.removePrefix("accepted_").removeSuffix(".json") }.sorted()

    companion object {
        /** Write-then-rename so a crash never leaves a half-written note (the harness wrote in place). */
        fun atomicWrite(f: File, text: String) {
            val tmp = File(f.parentFile, f.name + ".tmp")
            tmp.outputStream().use { o -> o.write(text.toByteArray(Charsets.UTF_8)); o.fd.sync() }
            if (!tmp.renameTo(f)) throw IOException("cannot replace ${f.name}")
        }
    }
}

class MemoryNoteStore : NoteStore {
    private val notes = LinkedHashMap<String, JsonObject>()
    private val pending = LinkedHashMap<String, JsonObject>()
    private val acceptedRecs = LinkedHashMap<String, JsonObject>()
    @Synchronized override fun notes() = notes.values.map { Note(it) }
    @Synchronized override fun note(alias: String) = notes[alias]?.let { Note(it) }
    @Synchronized override fun put(note: Note) { notes[note.alias] = note.json }
    @Synchronized override fun pendingChain(name: String) = pending[name]
    @Synchronized override fun putPending(name: String, json: JsonObject) { pending[name] = json }
    @Synchronized override fun deletePending(name: String) { pending.remove(name) }
    @Synchronized override fun pendingNames() = pending.keys.toList()
    @Synchronized override fun accepted(name: String) = acceptedRecs[name]
    @Synchronized override fun putAccepted(name: String, json: JsonObject) { acceptedRecs[name] = json }
    @Synchronized override fun deleteAccepted(name: String) { acceptedRecs.remove(name) }
    @Synchronized override fun acceptedNames() = acceptedRecs.keys.toList()
}
