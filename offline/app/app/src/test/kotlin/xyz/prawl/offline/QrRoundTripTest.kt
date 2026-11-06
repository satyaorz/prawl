package xyz.prawl.offline

import com.google.zxing.BarcodeFormat
import com.google.zxing.BinaryBitmap
import com.google.zxing.DecodeHintType
import com.google.zxing.EncodeHintType
import com.google.zxing.MultiFormatReader
import com.google.zxing.RGBLuminanceSource
import com.google.zxing.common.HybridBinarizer
import com.google.zxing.qrcode.QRCodeWriter
import com.google.zxing.qrcode.decoder.ErrorCorrectionLevel
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import xyz.prawl.core.handoff.Handoff
import xyz.prawl.core.transport.PayQr
import xyz.prawl.core.util.Js
import xyz.prawl.core.util.str
import java.io.File
import java.util.UUID

/** The real handoff links (load, depth-2 redeem) and a receive code fit one QR and decode back exactly (ZXing, pure JVM). */
class QrRoundTripTest {
    private val raw = File(System.getProperty("prawl.raw") ?: "../../..")

    private fun roundTrip(text: String): Int {
        val ecc = if (text.length > 600) ErrorCorrectionLevel.L else ErrorCorrectionLevel.M   // same rule as QrCodes.bitmap
        val m = QRCodeWriter().encode(text, BarcodeFormat.QR_CODE, 0, 0,
            mapOf(EncodeHintType.ERROR_CORRECTION to ecc, EncodeHintType.MARGIN to 4, EncodeHintType.CHARACTER_SET to "UTF-8"))
        val scale = 4
        val w = m.width * scale; val h = m.height * scale
        val px = IntArray(w * h) { i -> if (m[(i % w) / scale, (i / w) / scale]) 0xFF000000.toInt() else 0xFFFFFFFF.toInt() }
        val got = MultiFormatReader().decode(BinaryBitmap(HybridBinarizer(RGBLuminanceSource(w, h, px))),
            mapOf(DecodeHintType.POSSIBLE_FORMATS to listOf(BarcodeFormat.QR_CODE), DecodeHintType.PURE_BARCODE to true)).text
        assertEquals(text, got)
        return (m.width - 8 - 17) / 4   // QR version
    }

    @Test fun handoffLinksFitOneQr() {
        for (f in listOf("load_ho_deposited.json", "redeem_ho_0.003_unsubmitted.json", "redeem_already_paid.json")) {
            val v = Js.parse(File(raw, "v3/handoff_vectors/$f").readText())
            val version = roundTrip(v.str("https"))
            assertTrue("$f needs QR version $version", version <= 40)
            println("$f: ${v.str("https").length} chars -> QR version $version")
            assertEquals(v.str("d"), Handoff.parseLink(v.str("https")).let { Handoff.encode(it.payload) })
        }
    }

    @Test fun receiveCodeIsSmall() {
        val qr = PayQr("r1a2b3c4", "3f5b04552a479ae65e7624c0975ccc538e69af169a49a424e02d0e20d5b2edef", ByteArray(16) { 7 }, PayQr.L2CAP, UUID.randomUUID(), psm = 133)
        val link = qr.link()
        val version = roundTrip(link)
        println("receive code: ${link.length} chars -> QR version $version")
        assertTrue(version <= 15)
        assertEquals(qr, PayQr.parse(link))
    }
}
