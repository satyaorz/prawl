package xyz.prawl.offline.ui.components

import android.graphics.Bitmap
import android.util.Size
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.core.resolutionselector.ResolutionSelector
import androidx.camera.core.resolutionselector.ResolutionStrategy
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.FilterQuality
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import com.google.zxing.BarcodeFormat
import com.google.zxing.BinaryBitmap
import com.google.zxing.DecodeHintType
import com.google.zxing.EncodeHintType
import com.google.zxing.MultiFormatReader
import com.google.zxing.PlanarYUVLuminanceSource
import com.google.zxing.common.HybridBinarizer
import com.google.zxing.qrcode.QRCodeWriter
import com.google.zxing.qrcode.decoder.ErrorCorrectionLevel
import xyz.prawl.offline.ui.theme.Tw
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/** QR encoding with ZXing (pure Java, no Google Play services): privacy-first, works offline. */
object QrCodes {
    /** Module matrix as a 1-px-per-module bitmap (scaled up without smoothing when drawn). */
    fun bitmap(content: String): Bitmap {
        // Low error correction for the big redeem payloads (≈1.8 KB); medium for short codes.
        val ecc = if (content.length > 600) ErrorCorrectionLevel.L else ErrorCorrectionLevel.M
        val m = QRCodeWriter().encode(content, BarcodeFormat.QR_CODE, 0, 0,
            mapOf(EncodeHintType.ERROR_CORRECTION to ecc, EncodeHintType.MARGIN to 4, EncodeHintType.CHARACTER_SET to "UTF-8"))
        val w = m.width; val h = m.height
        val px = IntArray(w * h) { i -> if (m[i % w, i / w]) 0xFF000000.toInt() else 0xFFFFFFFF.toInt() }
        return Bitmap.createBitmap(px, w, h, Bitmap.Config.ARGB_8888)
    }

    fun decodeLuminance(data: ByteArray, width: Int, height: Int, rowStride: Int): String? {
        val src = PlanarYUVLuminanceSource(data, rowStride, height, 0, 0, width, height, false)
        val reader = MultiFormatReader().apply { setHints(mapOf(DecodeHintType.POSSIBLE_FORMATS to listOf(BarcodeFormat.QR_CODE), DecodeHintType.TRY_HARDER to true)) }
        return try { reader.decodeWithState(BinaryBitmap(HybridBinarizer(src))).text } catch (e: Exception) { null } finally { reader.reset() }
    }
}

/** Shows [content] as a QR code on a white tile (dark-on-light scans best). */
@Composable
fun QrImage(content: String, modifier: Modifier = Modifier) {
    val bmp = remember(content) { runCatching { QrCodes.bitmap(content) }.getOrNull() }
    Box(modifier.fillMaxWidth().aspectRatio(1f).clip(RoundedCornerShape(Tw.cardRadius)).background(Color.White).padding(8.dp)) {
        if (bmp != null) Image(bmp.asImageBitmap(), contentDescription = "QR code", filterQuality = FilterQuality.None,
            modifier = Modifier.fillMaxWidth().aspectRatio(1f))
        else Secondary("Too large for one QR code: use Copy / Save file", color = Tw.red400)
    }
}

/**
 * Camera QR scanner: CameraX preview + ImageAnalysis, decoded on-device with ZXing. Calls [onResult] once.
 * Requires the CAMERA permission (wrap in [PermissionGate]).
 */
@Composable
fun QrScanner(onResult: (String) -> Unit, modifier: Modifier = Modifier) {
    val ctx = LocalContext.current
    val owner = LocalLifecycleOwner.current
    val done = remember { AtomicBoolean(false) }
    val exec = remember { Executors.newSingleThreadExecutor() }
    val previewView = remember { PreviewView(ctx).apply { scaleType = PreviewView.ScaleType.FILL_CENTER } }
    DisposableEffect(Unit) {
        val future = ProcessCameraProvider.getInstance(ctx)
        future.addListener({
            val provider = future.get()
            val preview = Preview.Builder().build().also { it.surfaceProvider = previewView.surfaceProvider }
            val analysis = ImageAnalysis.Builder()
                .setResolutionSelector(ResolutionSelector.Builder().setResolutionStrategy(
                    ResolutionStrategy(Size(1280, 720), ResolutionStrategy.FALLBACK_RULE_CLOSEST_HIGHER_THEN_LOWER)).build())
                .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST).build()
            analysis.setAnalyzer(exec) { img: ImageProxy ->
                try {
                    if (!done.get()) {
                        val plane = img.planes[0]
                        val buf = plane.buffer
                        val bytes = ByteArray(buf.remaining()).also { buf.get(it) }
                        val text = QrCodes.decodeLuminance(bytes, img.width, img.height, plane.rowStride)
                        if (text != null && done.compareAndSet(false, true)) ContextCompat.getMainExecutor(ctx).execute { onResult(text) }
                    }
                } finally { img.close() }
            }
            runCatching {
                provider.unbindAll()
                provider.bindToLifecycle(owner, CameraSelector.DEFAULT_BACK_CAMERA, preview, analysis)
            }
        }, ContextCompat.getMainExecutor(ctx))
        onDispose {
            runCatching { ProcessCameraProvider.getInstance(ctx).get().unbindAll() }
            exec.shutdown()
        }
    }
    Box(modifier.fillMaxWidth().aspectRatio(1f).clip(RoundedCornerShape(Tw.cardRadius)).border(1.dp, Tw.zinc800, RoundedCornerShape(Tw.cardRadius))) {
        AndroidView({ previewView }, Modifier.fillMaxWidth().aspectRatio(1f))
    }
}
