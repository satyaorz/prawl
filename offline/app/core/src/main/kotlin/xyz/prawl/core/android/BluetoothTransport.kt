package xyz.prawl.core.android

import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothServerSocket
import android.bluetooth.BluetoothSocket
import android.bluetooth.le.AdvertiseCallback
import android.bluetooth.le.AdvertiseData
import android.bluetooth.le.AdvertiseSettings
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.ParcelUuid
import xyz.prawl.core.transport.FramedLink
import java.io.Closeable
import java.io.IOException
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/**
 * Bluetooth links between two phones without knowing the other phone's MAC address.
 *
 * Android 12+ returns 02:00:00:00:00:00 from `BluetoothAdapter.getAddress()` to ordinary apps, so the payee
 * cannot put its address in the QR. Instead the QR carries a fresh random session UUID and:
 *
 *  - **BLE + L2CAP CoC (default).** The payee opens an insecure LE L2CAP server channel (dynamic PSM, in the QR)
 *    and advertises the session UUID (connectable, no device name, no TX power). The payer scans with a filter
 *    on that UUID, gets the BluetoothDevice (a rotating private LE address) and opens the L2CAP channel.
 *    No pairing, no discoverability, no MAC.
 *  - **Classic RFCOMM (fallback).** The payee listens on insecure RFCOMM with the session UUID as its SDP
 *    service and becomes discoverable (system dialog); the QR carries the phone's Bluetooth name. The payer runs
 *    classic discovery, takes devices with that name, and connects RFCOMM to the session UUID (SDP lookup).
 *  - **RFCOMM to a known MAC** (debug harness only, `bt3_pay addr`): what the Java harness did, kept for interop.
 *
 * Every frame of an app-to-app session is then encrypted and authenticated with the QR's session secret
 * ([xyz.prawl.core.transport.SecureLink]); the harness interop path stays plaintext like the harness.
 * Callers must hold BLUETOOTH_CONNECT / BLUETOOTH_SCAN / BLUETOOTH_ADVERTISE as needed.
 */
@SuppressLint("MissingPermission")
class BluetoothTransport(private val context: Context) {
    val adapter: BluetoothAdapter? = context.getSystemService(BluetoothManager::class.java)?.adapter

    val enabled: Boolean get() = adapter?.isEnabled == true

    fun localName(): String? = runCatching { adapter?.name }.getOrNull()

    private fun need(): BluetoothAdapter {
        val a = adapter ?: throw IOException("this phone has no Bluetooth")
        if (!a.isEnabled) throw IOException("Bluetooth is off")
        return a
    }

    /** A socket wrapped in the harness framing. */
    fun link(s: BluetoothSocket) = FramedLink(s.inputStream, s.outputStream, s)

    // ================================================================ payee

    interface Listener : Closeable {
        /** Blocks until a payer connects (or [timeoutMs] passes / [close] is called). */
        fun accept(timeoutMs: Int): BluetoothSocket
    }

    /** BLE-advertised L2CAP server. [psm] goes into the QR. */
    inner class L2capListener(val serviceUuid: UUID) : Listener {
        private val server: BluetoothServerSocket = need().listenUsingInsecureL2capChannel()
        val psm: Int = server.psm
        private val advertiseError = AtomicReference<String?>(null)
        private val advCallback = object : AdvertiseCallback() {
            override fun onStartFailure(errorCode: Int) { advertiseError.set("BLE advertising failed ($errorCode)") }
        }

        init {
            val adv = need().bluetoothLeAdvertiser ?: run { server.close(); throw IOException("this phone cannot advertise over BLE") }
            val settings = AdvertiseSettings.Builder()
                .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_LOW_LATENCY)
                .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_MEDIUM)
                .setConnectable(true)
                .setTimeout(0)
                .build()
            val data = AdvertiseData.Builder()
                .addServiceUuid(ParcelUuid(serviceUuid))
                .setIncludeDeviceName(false)
                .setIncludeTxPowerLevel(false)
                .build()
            adv.startAdvertising(settings, data, advCallback)
        }

        val advertisingError: String? get() = advertiseError.get()

        override fun accept(timeoutMs: Int): BluetoothSocket = server.accept(timeoutMs)

        override fun close() {
            runCatching { adapter?.bluetoothLeAdvertiser?.stopAdvertising(advCallback) }
            runCatching { server.close() }
        }
    }

    /** Insecure RFCOMM server registered under [serviceUuid] (fallback, and the harness's fixed UUID). */
    inner class RfcommListener(val serviceUuid: UUID, serviceName: String) : Listener {
        private val server: BluetoothServerSocket = need().listenUsingInsecureRfcommWithServiceRecord(serviceName, serviceUuid)
        override fun accept(timeoutMs: Int): BluetoothSocket = server.accept(timeoutMs)
        override fun close() { runCatching { server.close() } }
    }

    fun discoverableIntent(seconds: Int = 120): Intent =
        Intent(BluetoothAdapter.ACTION_REQUEST_DISCOVERABLE).putExtra(BluetoothAdapter.EXTRA_DISCOVERABLE_DURATION, seconds)

    // ================================================================ payer

    /** Finds the payee advertising [serviceUuid] over BLE, then opens L2CAP channel [psm]. Retries the connect. */
    fun connectL2cap(serviceUuid: UUID, psm: Int, scanTimeoutMs: Long = 15_000, log: (String) -> Unit = {}): BluetoothSocket {
        val a = need()
        val scanner = a.bluetoothLeScanner ?: throw IOException("BLE scanning unavailable")
        val found = AtomicReference<BluetoothDevice?>()
        val err = AtomicReference<String?>()
        val latch = CountDownLatch(1)
        val cb = object : ScanCallback() {
            override fun onScanResult(callbackType: Int, result: ScanResult) {
                if (found.compareAndSet(null, result.device)) latch.countDown()
            }
            override fun onScanFailed(errorCode: Int) { err.set("BLE scan failed ($errorCode)"); latch.countDown() }
        }
        val filter = ScanFilter.Builder().setServiceUuid(ParcelUuid(serviceUuid)).build()
        val settings = ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build()
        val t0 = System.nanoTime()
        scanner.startScan(listOf(filter), settings, cb)
        try { latch.await(scanTimeoutMs, TimeUnit.MILLISECONDS) } finally { runCatching { scanner.stopScan(cb) } }
        err.get()?.let { throw IOException(it) }
        val dev = found.get() ?: throw IOException("payee not found nearby (no BLE advertisement for this code)")
        log("BLE found payee in ${(System.nanoTime() - t0) / 1_000_000} ms")
        var last: Exception? = null
        repeat(3) { attempt ->
            val s = dev.createInsecureL2capChannel(psm)
            try { s.connect(); log("L2CAP connected (attempt ${attempt + 1})"); return s } catch (e: IOException) {
                last = e; runCatching { s.close() }; Thread.sleep(300L * (attempt + 1))
            }
        }
        throw IOException("could not open the Bluetooth channel: ${last?.message}")
    }

    /** RFCOMM to a known address (the harness's `bt3_pay addr`). */
    fun connectRfcommByAddress(addr: String, uuid: UUID): BluetoothSocket {
        val s = need().getRemoteDevice(addr).createInsecureRfcommSocketToServiceRecord(uuid)
        try { s.connect() } catch (e: IOException) { runCatching { s.close() }; throw e }
        return s
    }

    /** Classic discovery for a device named [name], then RFCOMM to [uuid]. The payee must be discoverable. */
    fun connectRfcommByDiscovery(name: String, uuid: UUID, timeoutMs: Long = 25_000, log: (String) -> Unit = {}): BluetoothSocket {
        val a = need()
        val candidates = LinkedHashSet<BluetoothDevice>()
        val latch = CountDownLatch(1)
        val rx = object : BroadcastReceiver() {
            override fun onReceive(c: Context, i: Intent) {
                when (i.action) {
                    BluetoothDevice.ACTION_FOUND -> {
                        val d = i.getParcelableExtra(BluetoothDevice.EXTRA_DEVICE, BluetoothDevice::class.java) ?: return
                        val n = i.getStringExtra(BluetoothDevice.EXTRA_NAME) ?: runCatching { d.name }.getOrNull()
                        if (n == name && candidates.add(d)) latch.countDown()
                    }
                    BluetoothAdapter.ACTION_DISCOVERY_FINISHED -> latch.countDown()
                }
            }
        }
        context.registerReceiver(rx, IntentFilter(BluetoothDevice.ACTION_FOUND).apply { addAction(BluetoothAdapter.ACTION_DISCOVERY_FINISHED) },
            Context.RECEIVER_NOT_EXPORTED)
        try {
            a.cancelDiscovery()
            if (!a.startDiscovery()) throw IOException("could not start Bluetooth discovery")
            latch.await(timeoutMs, TimeUnit.MILLISECONDS)
        } finally {
            runCatching { a.cancelDiscovery() }
            runCatching { context.unregisterReceiver(rx) }
        }
        if (candidates.isEmpty()) throw IOException("no discoverable phone named '$name' nearby")
        var last: Exception? = null
        for (d in candidates) {
            val s = d.createInsecureRfcommSocketToServiceRecord(uuid)
            try { s.connect(); log("RFCOMM connected to '$name'"); return s } catch (e: IOException) { last = e; runCatching { s.close() } }
        }
        throw IOException("could not connect to '$name': ${last?.message}")
    }

    companion object {
        /** Fixed service UUID of the Java harness (Wallet2Activity.BT_UUID), used only in harness interop mode. */
        val HARNESS_UUID: UUID = UUID.fromString("5f1c0b6e-6a35-4bd0-9c39-7072617776c2")
    }
}
