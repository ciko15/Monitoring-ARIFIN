/**
 * temp_humidity_modbus.js — Parser suhu & kelembaban via Modbus TCP FC03
 * AirNav Indonesia — WAJJ Sentani
 *
 * Protocol : Modbus TCP, port 502
 * Function : FC03 Read Holding Registers
 * Registers: addr 0 = suhu × 10,  addr 1 = humidity × 10
 * Unit ID  : 1
 *
 * Pattern  : getPollRequest() + parse(chunk) + reset()
 *            (sama seperti PM5560, dikelola oleh network_listener)
 *
 * Threshold: WARNING >= 30.0°C, ALARM >= 35.0°C
 */

'use strict';

const BaseParser = require('./base');

// ── Constants ─────────────────────────────────────────────────────────────────
const WARN_TEMP  = 30.0;
const ALARM_TEMP = 35.0;
const UNIT_ID    = 1;

// ── Modbus TCP FC03 builder ───────────────────────────────────────────────────
let _tid = 0;
function buildFC03(unitId) {
    _tid = (_tid + 1) & 0xFFFF;
    const buf = Buffer.alloc(12);
    buf.writeUInt16BE(_tid,   0);   // Transaction ID
    buf.writeUInt16BE(0,      2);   // Protocol ID
    buf.writeUInt16BE(6,      4);   // Length
    buf.writeUInt8(unitId,    6);   // Unit ID
    buf.writeUInt8(0x03,      7);   // FC03
    buf.writeUInt16BE(0x0000, 8);   // Start address
    buf.writeUInt16BE(0x0002, 10);  // Quantity = 2 registers
    return buf;
}

// ── Modbus TCP FC03 response parser ──────────────────────────────────────────
function parseFC03(data) {
    if (!data || data.length < 9) return null;
    if (data[7] !== 0x03) return null;
    const bc = data[8];
    if (data.length < 9 + bc) return null;
    return {
        temp_raw: data.readUInt16BE(9),
        humi_raw: data.readUInt16BE(11),
    };
}

function statusFromTemp(t) {
    if (t >= ALARM_TEMP) return 'Alarm';
    if (t >= WARN_TEMP)  return 'Warning';
    return 'Normal';
}

// ── Parser class ──────────────────────────────────────────────────────────────
class TempHumidityModbusParser extends BaseParser {
    /**
     * opts:
     *   location   : nama lokasi (e.g. "Gedung RX")
     *   unit_id    : Modbus unit ID (default 1)
     */
    constructor(opts = {}) {
        super(opts);
        this._location = opts.location || '—';
        this._unitId   = parseInt(opts.unit_id) || UNIT_ID;
        this._rxBuf    = Buffer.alloc(0);
    }

    // Poll interval (ms) — dibaca oleh network_listener
    static get POLL_INTERVAL() { return 10_000; } // 10 detik

    /**
     * Dipanggil oleh network_listener setelah connect.
     * Return { bytes: Buffer } — FC03 request siap dikirim ke socket.
     */
    getPollRequest() {
        return { bytes: buildFC03(this._unitId) };
    }

    /**
     * Dipanggil oleh network_listener setiap kali ada data masuk dari socket.
     * Buffer data bisa datang parsial — di-buffer sampai frame lengkap.
     * Return result object atau null jika belum lengkap.
     */
    parse(chunk) {
        if (!chunk || chunk.length === 0) return null;

        // Akumulasi data
        this._rxBuf = Buffer.concat([this._rxBuf, chunk]);

        // Cek apakah sudah ada frame lengkap
        // Modbus TCP response: 6 byte MBAP header + PDU
        // Length field di offset 4-5 = jumlah byte setelah header (min 3: unitId + fc + byteCount)
        if (this._rxBuf.length < 6) return null;

        const msgLen = this._rxBuf.readUInt16BE(4); // bytes after MBAP
        const totalLen = 6 + msgLen;

        if (this._rxBuf.length < totalLen) return null;

        // Ambil frame lengkap, sisakan sisa
        const frame = this._rxBuf.slice(0, totalLen);
        this._rxBuf = this._rxBuf.slice(totalLen);

        const parsed = parseFC03(frame);
        if (!parsed) {
            console.warn('[TempHumi] Invalid FC03 response');
            return null;
        }

        const tempC  = parsed.temp_raw / 10.0;
        const humiP  = parsed.humi_raw / 10.0;
        const status = statusFromTemp(tempC);

        return {
            success: true,
            status,
            data: {
                temperature_c: tempC.toFixed(1),
                humidity_pct:  humiP.toFixed(1),
                location:      this._location,
                status_text:   status,
            },
            alarms:          status === 'Alarm'   ? [`Suhu ${tempC.toFixed(1)}°C >= ${ALARM_TEMP}°C`] : [],
            warnings:        status === 'Warning' ? [`Suhu ${tempC.toFixed(1)}°C >= ${WARN_TEMP}°C`]  : [],
            triggeredParams: [],
            timestamp: new Date().toISOString(),
        };
    }

    /**
     * Dipanggil oleh network_listener saat socket close/reconnect.
     * Reset buffer.
     */
    reset() {
        this._rxBuf = Buffer.alloc(0);
    }
}

module.exports = TempHumidityModbusParser;
