const snmp = require('net-snmp');
const EventEmitter = require('events');

/**
 * VHF T6TV Collector — Park Air T6 via SNMP (v2c)
 * Pengganti WebSocket-based parser (vhf_t6tv.js) yang lama.
 *
 * Perbedaan mendasar dari versi WebSocket:
 *   - WebSocket = push-based (server kirim update tiap ada perubahan)
 *   - SNMP      = pull-based (kita polling tiap interval tetap)
 *
 * Field yang TIDAK tersedia di SNMP (by design, diterima hilang):
 *   - Radio Settings (Offset, Operating Preset, Inhibit, RF Power Delay, dll)
 *   - Ambient Temperature (°C) / Internal Temperature (°C)
 *   - AC/DC Power "Connected"/"Not Connected" wording spesifik
 *   - Status Messages (free text alert)
 *
 * OID Reference: lihat OID_MAP di bawah untuk source tiap field.
 */

// ── OID MAP ──────────────────────────────────────────────────────────────────

const OID = {
    // Standard MIB-2
    sysName: '1.3.6.1.2.1.1.5.0',
    sysLocation: '1.3.6.1.2.1.1.6.0',
    sysUpTime: '1.3.6.1.2.1.1.3.0',

    // System Info (vendor Park Air)
    equipment: '1.3.6.1.4.1.4969.4.4.1.7.0',   // PCB part number
    serialNumber: '1.3.6.1.4.1.4969.4.4.1.8.0',
    bootInstalled: '1.3.6.1.4.1.4969.4.4.1.9.1.3.1',
    softwareInstalled: '1.3.6.1.4.1.4969.4.4.1.9.1.3.2',
    firmware: '1.3.6.1.4.1.4969.4.4.1.9.1.3.4',
    model: '1.3.6.1.4.1.2363.6.2.1.1.1.13.1', // "T6-TV" (via radio interop MIB)

    // RF Metrics
    txFaults: '1.3.6.1.4.1.4969.4.4.3.1.0',
    txFreqRaw: '1.3.6.1.4.1.4969.4.4.3.3.0',   // ÷1000 = MHz
    txPowerLevel: '1.3.6.1.4.1.4969.4.4.3.5.0',
    modError: '1.3.6.1.4.1.4969.4.4.3.8.0',
    txEnabled: '1.3.6.1.4.1.4969.4.4.3.14.0',
    paStatus: '1.3.6.1.4.1.4969.4.4.3.17.0',
    antennaStatus: '1.3.6.1.4.1.4969.4.4.3.19.0',
    vswrAlarm: '1.3.6.1.4.1.4969.4.4.3.20.0',
    txActive: '1.3.6.1.4.1.4969.4.4.3.21.0',
    dutyCycleAlarm: '1.3.6.1.4.1.4969.4.4.3.22.0',

    // Elapsed time (device uptime, format string "53820h19m")
    elapsedTime: '1.3.6.1.4.1.4969.4.4.6.6.6.0',
};

// BIT Escalate: label (branch .2.x) + status (branch .3.x), index 1-8
const BIT_ESC_COUNT = 8;
function bitEscLabelOid(i) { return `1.3.6.1.4.1.4969.4.4.5.1.1.2.${i}`; }
function bitEscStatusOid(i) { return `1.3.6.1.4.1.4969.4.4.5.1.1.3.${i}`; }

// AM Voice TX — 4 field CONFIRMED (numerik, sudah dicocokkan dengan web app)
const AMV_TX_CONFIRMED = {
    rf_power_watts: '1.3.6.1.4.1.4969.4.4.7.2.1.0',   // = 50 (confirmed)
    modulation_depth: '1.3.6.1.4.1.4969.4.4.7.2.2.0',   // = 85 (confirmed)
    ptt_ref_voltage: '1.3.6.1.4.1.4969.4.4.7.2.3.0',   // = 14 (confirmed)
    tone_keying_freq: '1.3.6.1.4.1.4969.4.4.7.2.13.0',  // = 2040 (confirmed)
};

// AM Voice TX — sisanya (belum 100% terverifikasi label vs urutan aslinya)
// Diambil mentah sebagai array, JANGAN dilabeli otomatis sampai diverifikasi manual.
const AMV_TX_RAW_INDICES = [4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 15, 16, 17, 18, 20, 21, 22, 23, 24, 25, 26, 27];
function amvTxOid(i) { return `1.3.6.1.4.1.4969.4.4.7.2.${i}.0`; }

// ── Helper: parse varbind value jadi string bersih ────────────────────────────

function vbValue(varbind) {
    if (snmp.isVarbindError(varbind)) return null;
    const v = varbind.value;
    if (Buffer.isBuffer(v)) return v.toString('utf8').trim();
    return v;
}

// ── Collector class ────────────────────────────────────────────────────────────

class VhfT6tvSnmpCollector extends EventEmitter {
    /**
     * @param {Object} opts
     * @param {string} opts.host       - IP target (misal '192.168.210.131')
     * @param {string} [opts.community='public']
     * @param {number} [opts.interval=30000] - polling interval ms
     * @param {number} [opts.timeout=5000]
     * @param {number} [opts.retries=1]
     */
    constructor(opts = {}) {
        super();
        this.host = opts.host;
        this.community = opts.community || 'public';
        this.interval = opts.interval || 30000;
        this.timeout = opts.timeout || 5000;
        this.retries = opts.retries || 1;

        this._session = null;
        this._timer = null;
        this._connected = false;
    }

    start() {
        if (!this.host) throw new Error('VhfT6tvSnmpCollector: host wajib diisi');

        this._session = snmp.createSession(this.host, this.community, {
            port: 161,
            retries: this.retries,
            timeout: this.timeout,
            version: snmp.Version2c
        });

        this._session.on('error', (err) => {
            this._connected = false;
            this.emit('error', err);
        });

        // Poll pertama langsung, lalu jadwalkan interval
        this._poll();
        this._timer = setInterval(() => this._poll(), this.interval);
    }

    stop() {
        if (this._timer) clearInterval(this._timer);
        if (this._session) this._session.close();
        this._timer = null;
        this._session = null;
        this._connected = false;
    }

    // Build daftar semua OID yang perlu di-query dalam satu batch
    _buildOidList() {
        const oids = [...Object.values(OID)];

        for (let i = 1; i <= BIT_ESC_COUNT; i++) {
            oids.push(bitEscLabelOid(i), bitEscStatusOid(i));
        }

        oids.push(...Object.values(AMV_TX_CONFIRMED));
        AMV_TX_RAW_INDICES.forEach(i => oids.push(amvTxOid(i)));

        return oids;
    }

    async _poll() {
        if (!this._session) return;

        const oidList = this._buildOidList();
        const chunkSize = 10;
        let allVarbinds = [];
        let hasError = false;
        let lastError = null;

        for (let i = 0; i < oidList.length; i += chunkSize) {
            const chunk = oidList.slice(i, i + chunkSize);
            try {
                const varbinds = await new Promise((resolve, reject) => {
                    this._session.get(chunk, (error, vbs) => {
                        if (error) reject(error);
                        else resolve(vbs);
                    });
                });
                allVarbinds = allVarbinds.concat(varbinds);
            } catch (err) {
                hasError = true;
                lastError = err;
                break;
            }
        }

        if (hasError) {
            this._connected = false;
            const result = {
                success: false,
                error: lastError.message || String(lastError),
                status: 'Disconnect',
                timestamp: new Date().toISOString()
            };
            this.emit('data', result);
            return;
        }

        this._connected = true;

        // Map balik varbinds ke object { oid: value }
        const byOid = {};
        allVarbinds.forEach(vb => { byOid[vb.oid] = vbValue(vb); });

        const result = this._buildFlatResult(byOid);
        this.emit('data', result);
    }

    _buildFlatResult(byOid) {
        // ── BIT ESCALATE ──
        const bitEscRows = [];
        for (let i = 1; i <= BIT_ESC_COUNT; i++) {
            const label = byOid[bitEscLabelOid(i)];
            const statusRaw = byOid[bitEscStatusOid(i)];
            if (label !== undefined && label !== null) {
                const status = (statusRaw === 0 || statusRaw === '0') ? 'Normal' : 'Escalated';
                bitEscRows.push([label, status]);
            }
        }

        // ── AM Voice TX (confirmed) ──
        const amvTxConfirmed = {};
        for (const [key, oid] of Object.entries(AMV_TX_CONFIRMED)) {
            amvTxConfirmed[key] = byOid[oid];
        }

        // ── AM Voice TX (raw, belum terverifikasi label) ──
        const amvTxRaw = AMV_TX_RAW_INDICES.map(i => ({
            index: i,
            value: byOid[amvTxOid(i)]
        }));

        // ── Frekuensi ──
        const txFreqRaw = byOid[OID.txFreqRaw];
        const txFrequencyMhz = (txFreqRaw !== undefined && txFreqRaw !== null)
            ? (Number(txFreqRaw) / 1000).toFixed(3)
            : '—';

        // ── Overall status (dihitung, bukan field asli device) ──
        const txFaults = Number(byOid[OID.txFaults]) || 0;
        const anyEscalated = bitEscRows.some(([, status]) => status === 'Escalated');
        let status = 'Normal';
        if (txFaults !== 0 || anyEscalated) status = 'Alarm';

        const alarms = status !== 'Normal'
            ? bitEscRows.filter(([, s]) => s === 'Escalated').map(([k]) => k)
            : [];

        // Gabungkan TX Confirmed dan Raw menjadi format array 2D yang disukai frontend
        const amvTxsRows = [
            ['RF Power (W)', amvTxConfirmed.rf_power_watts || '—'],
            ['Modulation Depth', amvTxConfirmed.modulation_depth || '—'],
            ['PTT Ref Voltage', amvTxConfirmed.ptt_ref_voltage || '—'],
            ['Tone Keying Freq', amvTxConfirmed.tone_keying_freq || '—'],
            ...amvTxRaw.map(x => [`Raw Field ${x.index}`, x.value !== undefined ? String(x.value) : '—'])
        ];

        const flat = {
            // ── SYSTEM INFO ──
            model: byOid[OID.model] || '—',
            equipment: byOid[OID.equipment] || '—',
            serial_number: byOid[OID.serialNumber] || '—',
            boot_installed: byOid[OID.bootInstalled] || '—',
            software_version: byOid[OID.softwareInstalled] || '—',
            firmware: byOid[OID.firmware] || '—',
            snmp_name: byOid[OID.sysName] || '—',
            snmp_location: byOid[OID.sysLocation] || '—',

            // ── SERVICE STATUS (Sesuai format lama Frontend) ──
            overall_status:  status,
            ac_power:        '—',
            dc_power:        '—',
            dc_supply_v:     '—',
            ambient_temp:    '—',
            internal_temp:   '—',
            elapsed_time:    byOid[OID.elapsedTime] || '—',
            status_messages: '—',

            // ── RADIO CONFIG ──
            channel: '—',

            // ── TX MEASUREMENTS ──
            fwd_power:  byOid[OID.txPowerLevel] !== undefined ? String(byOid[OID.txPowerLevel]) : '—',
            refl_power: '—',
            tx_level:   '—',
            mod_level:  byOid[OID.modError] !== undefined ? String(byOid[OID.modError]) : '—',

            // ── TX SETTINGS ──
            rf_power_watts:   amvTxConfirmed.rf_power_watts !== undefined ? String(amvTxConfirmed.rf_power_watts) : '—',
            modulation_depth: amvTxConfirmed.modulation_depth !== undefined ? String(amvTxConfirmed.modulation_depth) : '—',
            ptt_state:        '—',
            alc_enabled:      '—',
            audio_line_in:    '—',
            tx_timeout:       '—',
            tone_keying_freq: amvTxConfirmed.tone_keying_freq !== undefined ? String(amvTxConfirmed.tone_keying_freq) : '—',

            // ── RX MEASUREMENTS ──
            rx_level:     '—',
            squelch_level:'—',
            sinad:        '—',
            audio_level:  '—',
            rx_freq:      '—',
            squelch_state:'—',

            // ── RAW ROWS (Wajib ada untuk sidebar enhancements.js) ──
            _amv_txs_rows: amvTxsRows,
            _amv_rxs_rows: [],
            _bit_esc_rows: bitEscRows,
            _radio_rows:   [],
            
            // ── EXTRA (Khusus SNMP) ──
            tx_frequency_mhz: txFrequencyMhz,
            tx_faults: byOid[OID.txFaults],
            tx_enabled: byOid[OID.txEnabled] === 1,
            tx_active: byOid[OID.txActive] === 1,
            pa_status: byOid[OID.paStatus] === 1 ? 'OK' : 'Fault',
            antenna_status: byOid[OID.antennaStatus] === 0 ? 'OK' : 'Alert',
            vswr_alarm: byOid[OID.vswrAlarm] === 0 ? 'Normal' : 'Alert',
            duty_cycle_alarm: byOid[OID.dutyCycleAlarm] === 0 ? 'Normal' : 'Alert'
        };

        return {
            success: true,
            data: flat,
            status,
            alarms,
            warnings: [],
            triggeredParams: alarms,
            timestamp: new Date().toISOString()
        };
    }
}

module.exports = VhfT6tvSnmpCollector;
