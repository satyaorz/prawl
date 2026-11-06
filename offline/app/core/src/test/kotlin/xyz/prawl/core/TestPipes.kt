package xyz.prawl.core

import xyz.prawl.core.transport.FramedLink
import java.io.Closeable
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

/**
 * One direction of an in-memory byte pipe whose blocked read IS interrupted by [closeRead] (unlike java.io.PipedInputStream, whose
 * reader close does not wake a blocked read), like closing a Bluetooth socket. [closeWrite] queues EOF for the reader.
 */
class TestPipe {
    private val q = LinkedBlockingQueue<Int>()
    @Volatile private var readClosed = false
    val input: InputStream = object : InputStream() {
        override fun read(): Int {
            while (true) {
                val v = q.poll(20, TimeUnit.MILLISECONDS)
                if (v != null) { if (v == -1) q.add(-1); return v }
                if (readClosed) throw IOException("closed")
            }
        }
    }
    val output: OutputStream = object : OutputStream() { override fun write(b: Int) { q.add(b and 0xff) } }
    fun write(bytes: ByteArray) = bytes.forEach { q.add(it.toInt() and 0xff) }
    fun closeRead() { readClosed = true }
    fun closeWrite() { q.add(-1) }
}

/** Two framed endpoints joined by two pipes: closing an end wakes its own reads and gives the peer EOF. */
class TestLinkPair {
    private val ab = TestPipe(); private val ba = TestPipe()
    val a = FramedLink(ba.input, ab.output, Closeable { ba.closeRead(); ab.closeWrite() })
    val b = FramedLink(ab.input, ba.output, Closeable { ab.closeRead(); ba.closeWrite() })
    /** Raw access for hostile-peer tests: what `b` would write toward `a`. */
    fun injectToA(bytes: ByteArray) = ba.write(bytes)
}
