/**
 * asterix_radar.js — Parser ASTERIX CAT034 untuk Radar MSSR
 * AirNav Indonesia — Papua
 *
 * Protocol : UDP Multicast
 * Data     : ASTERIX CAT034 (radar status/north crossing)
 * Timeout  : 5 detik tanpa data = Disconnected
 *
 * Per source: 1 radar site = 1 source = 1 multicast group:port
 */

'use strict';

const BaseParser = require('./base');

const TIMEOUT_MS = 5000; // 5 detik tanpa data = disconnect

// ── CAT034 Decoder ────────────────────────────────────────────────────────────
function decodeCat034(data, radarName, radarLat, radarLon) {
    try {
        if (!data || data[0] !== 34) return null;
        if (data.length < 6) return null;

        const sac = data[4];
        const sic = data[5];

        return {
            radar:        radarName,
            category:     34,
            sac,
            sic,
            radar_id:     `${String(sac).padStart(3,'0')}/${String(sic).padStart(3,'0')}`,
            lat:          radarLat,
            lon:          radarLon,
            last_cat034:  new Date().toISOString(),
            data_source:  'asterix_cat034',
        };
    } catch (e) {
        return null;
    }
}

// ── Parser class ──────────────────────────────────────────────────────────────
class AsterixRadarParser extends BaseParser {
    /**
     * opts:
     *   name          : nama lokasi radar (e.g. "Sentani")
     *   lat / lon     : koordinat radar
     *   timeout_ms    : timeout tanpa data (default 5000)
     */
    constructor(opts = {}) {
        super(opts);
        this._name      = opts.name     || opts.location || 'Unknown';
        this._lat       = parseFloat(opts.lat) || 0;
        this._lon       = parseFloat(opts.lon) || 0;
        this._timeout   = parseInt(opts.timeout_ms) || TIMEOUT_MS;

        this._lastData  = null;
        this._lastSeen  = null;
        this._connected = false;
    }

    /**
     * Dipanggil oleh network_listener setiap kali ada UDP packet masuk.
     * rawData = Buffer dari socket.
     */
    parse(rawData) {
        if (!rawData || rawData.length === 0) return null;

        this._lastSeen = Date.now();

        // Cek timeout
        const isStale = this._lastSeen && (Date.now() - this._lastSeen) > this._timeout;
        this._connected = !isStale;

        // Proses hanya CAT034
        if (rawData[0] !== 34) {
            // Bukan CAT034 — update last seen tapi return last state
            return this._buildResult();
        }

        const decoded = decodeCat034(rawData, this._name, this._lat, this._lon);
        if (!decoded) return this._buildResult();

        this._lastData  = decoded;
        this._connected = true;

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
                connectivity:  this._connected ? 'Connected' : 'Disconnected',
                radar_name:    this._name,
                sac:           this._lastData ? String(this._lastData.sac) : '—',
                sic:           this._lastData ? String(this._lastData.sic) : '—',
                radar_id:      this._lastData ? this._lastData.radar_id    : '—',
                lat:           String(this._lat),
                lon:           String(this._lon),
                last_cat034:   this._lastData ? this._lastData.last_cat034 : '—',
                data_source:   'asterix_cat034',
            },
            alarms:          [],
            warnings:        [],
            triggeredParams: [],
            timestamp:       new Date().toISOString(),
        };
    }

    /**
     * Dipanggil saat tidak ada data dalam interval tertentu (timeout check).
     * Bisa dipanggil dari pollTimer network_listener.
     */
    checkTimeout() {
        if (this._lastSeen && (Date.now() - this._lastSeen) > this._timeout) {
            if (this._connected) {
                this._connected = false;
                return this._buildResult(); // return disconnect result
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

module.exports = AsterixRadarParser;
