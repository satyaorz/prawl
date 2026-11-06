package xyz.prawl.offline.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/** Tailwind tokens of the Prowl web wallet (dark only). */
object Tw {
    val zinc950 = Color(0xFF09090B)
    val zinc900 = Color(0xFF18181B)
    val zinc800 = Color(0xFF27272A)
    val zinc700 = Color(0xFF3F3F46)
    val zinc500 = Color(0xFF71717A)
    val zinc400 = Color(0xFFA1A1AA)
    val zinc300 = Color(0xFFD4D4D8)
    val zinc100 = Color(0xFFF4F4F5)
    val emerald400 = Color(0xFF34D399)
    val amber400 = Color(0xFFFBBF24)
    val red400 = Color(0xFFF87171)

    /** Card background: zinc-900 at 60 %. */
    val card = zinc900.copy(alpha = 0.6f)

    val pageMaxWidth = 576.dp      // max-w-xl
    val pad = 16.dp                // p-4
    val cardRadius = 16.dp         // rounded-2xl
    val buttonRadius = 8.dp        // rounded-lg

    val heading = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.Medium, color = zinc100)
    val body = TextStyle(fontSize = 14.sp, color = zinc300)
    val secondary = TextStyle(fontSize = 12.sp, color = zinc500)
    val mono = TextStyle(fontFamily = FontFamily.Monospace, fontSize = 13.sp, color = zinc100)
    val bigMono = TextStyle(fontFamily = FontFamily.Monospace, fontSize = 32.sp, fontWeight = FontWeight.Medium, color = zinc100)
}

enum class Status(val color: Color) { OK(Tw.emerald400), PENDING(Tw.amber400), ERROR(Tw.red400), NEUTRAL(Tw.zinc500) }

@Composable
fun PrawlTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = darkColorScheme(
            primary = Tw.emerald400, onPrimary = Tw.zinc950,
            background = Tw.zinc950, onBackground = Tw.zinc100,
            surface = Tw.zinc900, onSurface = Tw.zinc100, surfaceVariant = Tw.zinc800, onSurfaceVariant = Tw.zinc400,
            outline = Tw.zinc700, error = Tw.red400,
        ),
        content = content,
    )
}
