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

        let offset = 3; // FSPEC starts at byte 3 (0-indexed)
        const fspec = [];
        let hasNext = true;
        
        while (hasNext && offset < data.length) {
            const byte = data[offset];
            fspec.push(byte);
            offset++;
            hasNext = (byte & 0x01) !== 0; // Check FX bit
        }
        
        const items = [];
        const bitMap = [0x80, 0x40, 0x20, 0x10, 0x08, 0x04, 0x02];
        fspec.forEach((byte, byteIndex) => {
            for (let i = 0; i < 7; i++) {
                if (byte & bitMap[i]) {
                    items.push((byteIndex * 7) + i + 1); // 1-based index (e.g. 1 = I034/010)
                }
            }
        });
        
        const result = {
            radar: radarName,
            category: 34,
            lat: radarLat,
            lon: radarLon,
            last_cat034: new Date().toISOString(),
            data_source: 'asterix_cat034',
            sac: null, sic: null, radar_id: '—',
            msg_type: '—',
            time_of_day: '—',
            sector_number: '—',
            antenna_rotation: '—',
            system_config: '—'
        };

        // Read fields based on FSPEC
        for (const item of items) {
            if (offset >= data.length) break;
            
            if (item === 1) {
                // I034/010 - Data Source Identifier (2 bytes)
                result.sac = data[offset];
                result.sic = data[offset + 1];
                result.radar_id = `${String(result.sac).padStart(3, '0')}/${String(result.sic).padStart(3, '0')}`;
                offset += 2;
            } else if (item === 2) {
                // I034/000 - Message Type (1 byte)
                const types = { 1: 'North Marker', 2: 'Sector Marker', 3: 'Geographical Filtering Message', 4: 'Jamming Strobe Message' };
                const val = data[offset];
                result.msg_type = types[val] || `Unknown (${val})`;
                offset += 1;
            } else if (item === 3) {
                // I034/030 - Time of Day (3 bytes)
                const todRaw = (data[offset] << 16) | (data[offset + 1] << 8) | data[offset + 2];
                result.time_of_day = (todRaw / 128).toFixed(2) + ' s';
                offset += 3;
            } else if (item === 4) {
                // I034/020 - Sector Number (1 byte)
                result.sector_number = data[offset];
                offset += 1;
            } else if (item === 5) {
                // I034/041 - Antenna Rotation Period (2 bytes)
                const rotRaw = (data[offset] << 8) | data[offset + 1];
                result.antenna_rotation = (rotRaw / 128).toFixed(2) + ' s';
                offset += 2;
            } else if (item === 6) {
                // I034/050 - System Configuration and Status (Variable)
                let ext = true;
                let statusVal = [];
                while (ext && offset < data.length) {
                    statusVal.push(data[offset].toString(16).padStart(2,'0'));
                    ext = (data[offset] & 0x01) !== 0;
                    offset += 1;
                }
                result.system_config = `0x${statusVal.join('')}`;
            } else if (item === 7) {
                // I034/060 - System Processing Mode (Variable)
                let ext = true;
                while (ext && offset < data.length) {
                    ext = (data[offset] & 0x01) !== 0;
                    offset += 1;
                }
            } else if (item === 9) {
                // I034/070 - Message Volume (Variable)
                let ext = true;
                while (ext && offset < data.length) {
                    ext = (data[offset] & 0x01) !== 0;
                    offset += 1;
                }
            } else if (item === 10 || item === 11 || item === 12) {
                // Collimation Error, Generic Polar Window, 3D-Radar Altimeter (Variable)
                let ext = true;
                while (ext && offset < data.length) {
                    ext = (data[offset] & 0x01) !== 0;
                    offset += 1;
                }
            }
        }
        
        return result;
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
                sac:           this._lastData && this._lastData.sac !== null ? String(this._lastData.sac) : '—',
                sic:           this._lastData && this._lastData.sic !== null ? String(this._lastData.sic) : '—',
                radar_id:      this._lastData ? this._lastData.radar_id    : '—',
                msg_type:      this._lastData ? this._lastData.msg_type    : '—',
                time_of_day:   this._lastData ? this._lastData.time_of_day : '—',
                sector_number: this._lastData && this._lastData.sector_number !== null ? String(this._lastData.sector_number) : '—',
                antenna_rotation: this._lastData ? this._lastData.antenna_rotation : '—',
                system_config: this._lastData ? this._lastData.system_config : '—',
                lat:           String(this._lat),
                lon:           String(this._lon),
                last_cat034:   this._lastData ? this._lastData.last_cat034 : '—',
                data_source:   this._lastData ? this._lastData.data_source : '—'
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
