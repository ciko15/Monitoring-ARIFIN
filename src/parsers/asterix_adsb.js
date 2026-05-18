/**
 * asterix_adsb.js — Parser ASTERIX CAT021 untuk ADS-B
 * AirNav Indonesia — Papua
 *
 * Protocol : UDP Multicast 239.71.40.2:50000 (satu multicast untuk semua station)
 * Data     : ASTERIX CAT021 (ADS-B target reports)
 * Identifikasi station : berdasarkan SAC/SIC di payload
 * Timeout  : 5 detik tanpa data dari SAC/SIC ini = Disconnected
 *
 * Satu source = satu ADS-B station (diidentifikasi by SAC/SIC)
 * Semua source berbagi satu UDP socket (shared by connection manager via port 50000)
 */

'use strict';

const BaseParser = require('./base');

const TIMEOUT_MS = 5000;

// ── SAC/SIC map sesuai backup_radar_receiver.py ───────────────────────────────
const ADSB_SAC_SIC = {
    'Sentani':   { sac: 32, sic: 163 },
    'Biak':      { sac: 32, sic: 160 },
    'Merauke':   { sac: 32, sic: 154 },
    'Sorong':    { sac: 32, sic: 143 },
    'Timika':    { sac: 32, sic: 153 },
    'Nabire':    { sac: 32, sic: 169 },
    'Senggeh':   { sac: 32, sic: 167 },
    'Elelim':    { sac: 32, sic: 168 },
    'Dekai':     { sac: 32, sic: 166 },
    'Oksibil':   { sac: 32, sic: 165 },
    'Wamena':    { sac: 32, sic: 164 },
    'Kaimana':   { sac: 32, sic: 180 },
    'Manokwari': { sac: 32, sic: 179 },
};

// Reverse lookup SIC → station name
const SIC_TO_STATION = {};
for (const [name, ids] of Object.entries(ADSB_SAC_SIC)) {
    SIC_TO_STATION[ids.sic] = name;
}

// ── CAT021 Decoder ────────────────────────────────────────────────────────────
function decodeCat021(data) {
    try {
        if (!data || data[0] !== 21) return null;
        if (data.length < 8) return null;

        const sac = data[6];
        const sic = data[7];

        return { sac, sic };
    } catch (e) {
        return null;
    }
}

// ── Parser class ──────────────────────────────────────────────────────────────
class AsterixAdsbParser extends BaseParser {
    /**
     * opts:
     *   name      : nama station (e.g. "Sentani")
     *   lat / lon : koordinat station
     *   sac       : SAC identifier (default dari ADSB_SAC_SIC map)
     *   sic       : SIC identifier (default dari ADSB_SAC_SIC map)
     *   multicast_ip   : multicast group IP
     *   multicast_port : multicast port
     *   timeout_ms: timeout (default 5000)
     */
    constructor(opts = {}) {
        super(opts);
        this._name    = opts.name    || opts.location || 'Unknown';
        this._lat     = parseFloat(opts.lat) || 0;
        this._lon     = parseFloat(opts.lon) || 0;
        this._timeout = parseInt(opts.timeout_ms) || TIMEOUT_MS;

        // SAC/SIC dari config atau dari map
        const defaults = ADSB_SAC_SIC[this._name] || { sac: 0, sic: 0 };
        this._sac  = parseInt(opts.sac)  || defaults.sac;
        this._sic  = parseInt(opts.sic)  || defaults.sic;
        this._mcastIp   = opts.multicast_ip   || '239.71.40.2';
        this._mcastPort = parseInt(opts.multicast_port) || 50000;

        this._lastData  = null;
        this._lastSeen  = null;
        this._connected = false;
    }

    /**
     * Dipanggil oleh network_listener setiap kali ada UDP packet masuk.
     * rawData = Buffer — bisa dari station manapun.
     * Parser hanya proses packet yang SAC/SIC-nya cocok.
     */
    parse(rawData) {
        if (!rawData || rawData.length === 0) return null;

        // Decode minimal untuk cek SAC/SIC
        const decoded = decodeCat021(rawData);
        if (!decoded) return null;

        // Filter: hanya proses kalau SAC/SIC cocok dengan station ini
        if (decoded.sac !== this._sac || decoded.sic !== this._sic) {
            return null; // bukan untuk station ini — abaikan
        }

        this._lastSeen  = Date.now();
        this._connected = true;
        this._lastData  = {
            station:         this._name,
            sac:             this._sac,
            sic:             this._sic,
            radar_id:        `${String(this._sac).padStart(3,'0')}/${String(this._sic).padStart(3,'0')}`,
            multicast_ip:    this._mcastIp,
            multicast_port:  String(this._mcastPort),
            lat:             this._lat,
            lon:             this._lon,
            last_cat021:     new Date().toISOString(),
            data_source:     'asterix_cat021',
        };

        return this._buildResult();
    }

    _buildResult() {
        // Cek stale
        if (this._lastSeen && (Date.now() - this._lastSeen) > this._timeout) {
            this._connected = false;
        }

        const status = this._connected ? 'Normal' : 'Disconnect';

        return {
            success: this._connected,
            status,
            data: {
                connectivity:    this._connected ? 'Connected' : 'Disconnected',
                station:         this._name,
                sac:             String(this._sac),
                sic:             String(this._sic),
                radar_id:        `${String(this._sac).padStart(3,'0')}/${String(this._sic).padStart(3,'0')}`,
                multicast_ip:    this._mcastIp,
                multicast_port:  String(this._mcastPort),
                lat:             this._lastData ? String(this._lastData.lat) : String(this._lat),
                lon:             this._lastData ? String(this._lastData.lon) : String(this._lon),
                last_cat021:     this._lastData ? this._lastData.last_cat021 : '—',
                data_source:     'asterix_cat021',
            },
            alarms:          [],
            warnings:        [],
            triggeredParams: [],
            timestamp:       new Date().toISOString(),
        };
    }

    checkTimeout() {
        if (this._lastSeen && (Date.now() - this._lastSeen) > this._timeout) {
            if (this._connected) {
                this._connected = false;
                return this._buildResult();
            }
        }
        return null;
    }

    reset() {
        this._lastData  = null;
        this._lastSeen  = null;
        this._connected = false;
    }
}

module.exports = AsterixAdsbParser;
module.exports.SIC_TO_STATION = SIC_TO_STATION;
module.exports.ADSB_SAC_SIC   = ADSB_SAC_SIC;
