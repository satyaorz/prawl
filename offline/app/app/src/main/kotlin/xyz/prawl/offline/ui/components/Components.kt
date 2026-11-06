package xyz.prawl.offline.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import xyz.prawl.core.protocol.VerifyLine
import xyz.prawl.offline.ui.theme.Status
import xyz.prawl.offline.ui.theme.Tw

/** Page: zinc-950, centred column with max width ~xl and 16 dp padding, scrollable. */
@Composable
fun Page(title: String?, onBack: (() -> Unit)?, actions: @Composable () -> Unit = {}, content: @Composable ColumnScope.() -> Unit) {
    Box(Modifier.fillMaxSize().background(Tw.zinc950).statusBarsPadding().navigationBarsPadding().imePadding(), contentAlignment = Alignment.TopCenter) {
        Column(
            Modifier.widthIn(max = Tw.pageMaxWidth).fillMaxWidth().verticalScroll(rememberScrollState()).padding(Tw.pad),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            if (title != null || onBack != null) {
                Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
                    if (onBack != null) {
                        Text("←", style = TextStyle(fontSize = 20.sp, color = Tw.zinc400),
                            modifier = Modifier.clip(RoundedCornerShape(Tw.buttonRadius)).clickable(onClick = onBack).padding(horizontal = 8.dp, vertical = 2.dp))
                        Spacer(Modifier.width(4.dp))
                    }
                    if (title != null) Text(title, style = TextStyle(fontSize = 18.sp, fontWeight = FontWeight.SemiBold, color = Tw.zinc100), modifier = Modifier.weight(1f))
                    actions()
                }
            }
            content()
            Spacer(Modifier.height(24.dp))
        }
    }
}

/** Card: rounded-2xl, border zinc-800, bg zinc-900/60, p-4. */
@Composable
fun PCard(title: String? = null, subtitle: String? = null, modifier: Modifier = Modifier, border: Color = Tw.zinc800, content: @Composable ColumnScope.() -> Unit) {
    Column(
        modifier.fillMaxWidth().clip(RoundedCornerShape(Tw.cardRadius)).background(Tw.card)
            .border(1.dp, border, RoundedCornerShape(Tw.cardRadius)).padding(Tw.pad),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        if (title != null) Text(title, style = Tw.heading)
        if (subtitle != null) Text(subtitle, style = Tw.secondary)
        content()
    }
}

@Composable
fun PrimaryButton(text: String, onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true) {
    Box(
        modifier.clip(RoundedCornerShape(Tw.buttonRadius))
            .background(if (enabled) Tw.emerald400 else Tw.emerald400.copy(alpha = 0.35f))
            .clickable(enabled = enabled, onClick = onClick).padding(horizontal = 16.dp, vertical = 10.dp),
        contentAlignment = Alignment.Center,
    ) { Text(text, style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.Medium, color = Tw.zinc950)) }
}

@Composable
fun SecondaryButton(text: String, onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true, color: Color = Tw.zinc100) {
    Box(
        modifier.clip(RoundedCornerShape(Tw.buttonRadius)).border(1.dp, Tw.zinc700, RoundedCornerShape(Tw.buttonRadius))
            .clickable(enabled = enabled, onClick = onClick).padding(horizontal = 16.dp, vertical = 10.dp),
        contentAlignment = Alignment.Center,
    ) { Text(text, style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.Medium, color = if (enabled) color else Tw.zinc500)) }
}

@Composable
fun Mono(text: String, modifier: Modifier = Modifier, style: TextStyle = Tw.mono, maxLines: Int = Int.MAX_VALUE) =
    Text(text, style = style, modifier = modifier, maxLines = maxLines, overflow = TextOverflow.Ellipsis)

@Composable
fun Secondary(text: String, modifier: Modifier = Modifier, color: Color = Tw.zinc500) = Text(text, style = Tw.secondary.copy(color = color), modifier = modifier)

@Composable
fun Dot(status: Status, size: Int = 8) = Box(Modifier.size(size.dp).clip(CircleShape).background(status.color))

/** A status line: coloured dot + text (emerald ok, amber pending, red error). */
@Composable
fun StatusLine(status: Status, text: String, busy: Boolean = false) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        if (busy) CircularProgressIndicator(Modifier.size(14.dp), color = status.color, strokeWidth = 2.dp) else Dot(status)
        Text(text, style = Tw.body.copy(color = status.color))
    }
}

@Composable
fun KeyValue(key: String, value: String, mono: Boolean = false, valueColor: Color = Tw.zinc100) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.Top) {
        Text(key, style = Tw.secondary, modifier = Modifier.padding(end = 12.dp))
        Text(value, style = (if (mono) Tw.mono else Tw.body).copy(color = valueColor, fontSize = 13.sp))
    }
}

/** One verification line, human readable: ✓/✗, title, detail. */
@Composable
fun CheckRow(line: VerifyLine) {
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.Top) {
        Text(if (line.ok) "✓" else "✗", style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.Bold, color = if (line.ok) Tw.emerald400 else Tw.red400))
        Column(Modifier.weight(1f)) {
            Text(line.title, style = Tw.body.copy(color = Tw.zinc100, fontSize = 13.sp))
            if (line.detail.isNotBlank()) Text(line.detail, style = Tw.secondary)
        }
    }
}

@Composable
fun CheckList(lines: List<VerifyLine>) = Column(verticalArrangement = Arrangement.spacedBy(6.dp)) { lines.forEach { CheckRow(it) } }

@Composable
fun Field(value: String, onChange: (String) -> Unit, label: String, mono: Boolean = false, number: Boolean = false,
          error: String? = null, modifier: Modifier = Modifier, singleLine: Boolean = true) {
    // Addresses and hex are 42+ characters: wrap them (never clip) so the user can always read the whole value, last characters included.
    val wrap = mono && !number && singleLine
    Column {
        OutlinedTextField(
            value = value,
            onValueChange = { onChange(if (wrap) it.filter { c -> c != '\n' && c != '\r' } else it) },
            label = { Text(label, style = Tw.secondary) },
            singleLine = singleLine && !wrap, maxLines = if (!singleLine) Int.MAX_VALUE else if (wrap) 3 else 1, isError = error != null,
            textStyle = if (mono) Tw.mono else Tw.body.copy(color = Tw.zinc100),
            keyboardOptions = if (number) KeyboardOptions(keyboardType = KeyboardType.Decimal) else KeyboardOptions.Default,
            shape = RoundedCornerShape(Tw.buttonRadius),
            colors = OutlinedTextFieldDefaults.colors(
                focusedBorderColor = Tw.emerald400, unfocusedBorderColor = Tw.zinc700, cursorColor = Tw.emerald400,
                errorBorderColor = Tw.red400, focusedContainerColor = Tw.zinc950, unfocusedContainerColor = Tw.zinc950,
            ),
            modifier = modifier.fillMaxWidth(),
        )
        if (error != null) Secondary(error, color = Tw.red400, modifier = Modifier.padding(top = 2.dp))
    }
}

/** Two or more choices as pill buttons. */
@Composable
fun Segmented(options: List<Pair<String, String>>, selected: String, onSelect: (String) -> Unit) {
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        options.forEach { (k, label) ->
            val on = k == selected
            Box(
                Modifier.clip(RoundedCornerShape(Tw.buttonRadius))
                    .background(if (on) Tw.zinc800 else Color.Transparent)
                    .border(1.dp, if (on) Tw.emerald400 else Tw.zinc700, RoundedCornerShape(Tw.buttonRadius))
                    .clickable { onSelect(k) }.padding(horizontal = 12.dp, vertical = 6.dp),
            ) { Text(label, style = Tw.body.copy(fontSize = 13.sp, color = if (on) Tw.zinc100 else Tw.zinc400)) }
        }
    }
}

@Composable
fun Chip(text: String, status: Status) {
    Box(Modifier.clip(RoundedCornerShape(6.dp)).background(status.color.copy(alpha = 0.12f)).padding(horizontal = 6.dp, vertical = 2.dp)) {
        Text(text, style = TextStyle(fontSize = 11.sp, color = status.color, fontWeight = FontWeight.Medium))
    }
}

@Composable
fun ConfirmDialog(
    title: String, text: String, confirm: String, onConfirm: () -> Unit, onDismiss: () -> Unit,
    /** A FULL address or key, shown whole in monospace (never abbreviated: audit F-03). */
    mono: String? = null,
    /** An amber warning shown above the text. */
    warning: String? = null,
    /**
     * When given, Cancel and an outside tap call THIS, and Approve calls only [onConfirm]. Without it (the other screens) Approve calls
     * [onDismiss] (to hide the dialog) and then [onConfirm]; a caller whose dismiss means "no" must use [onCancel], or Approve would say no first.
     */
    onCancel: (() -> Unit)? = null,
) {
    val cancel = onCancel ?: onDismiss
    AlertDialog(
        onDismissRequest = cancel, containerColor = Tw.zinc900,
        title = { Text(title, style = Tw.heading.copy(fontSize = 16.sp)) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.verticalScroll(rememberScrollState())) {
                if (warning != null) Text(warning, style = Tw.body.copy(color = Tw.amber400))
                Text(text, style = Tw.body)
                if (mono != null) Text(mono, style = Tw.mono.copy(fontSize = 12.sp))
            }
        },
        confirmButton = { TextButton(onClick = { if (onCancel == null) onDismiss(); onConfirm() }) { Text(confirm, color = Tw.emerald400) } },
        dismissButton = { TextButton(onClick = cancel) { Text("Cancel", color = Tw.zinc400) } },
    )
}

@Composable
fun ErrorCard(text: String) = PCard(border = Tw.red400.copy(alpha = 0.5f)) { StatusLine(Status.ERROR, text) }

/** Monospace multi-line amount in ETH. */
@Composable
fun Amount(eth: String, unit: String = "ETH", style: TextStyle = Tw.bigMono) {
    Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(eth, style = style)
        Text(unit, style = Tw.secondary.copy(fontSize = 13.sp, fontFamily = FontFamily.Monospace), modifier = Modifier.padding(bottom = 4.dp))
    }
}
