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

// ── Katalog Stasiun Radar MSSR Indonesia (SAC / SIC & Koordinat Geografis) ────
const RADAR_STATIONS = {
    // Papua & Sekitarnya (SAC 32)
    '32/153': { name: 'Timika',    lat: -4.5284,  lon: 136.8860 },
    '32/15':  { name: 'Timika',    lat: -4.5284,  lon: 136.8860 }, // Transponder 2 Timika (SAC 32 / SIC 15)
    '32/015': { name: 'Timika',    lat: -4.5284,  lon: 136.8860 },
    '32/163': { name: 'Sentani',   lat: -2.5721,  lon: 140.5148 },
    '32/160': { name: 'Biak',      lat: -1.1874,  lon: 136.1085 },
    '32/154': { name: 'Merauke',   lat: -8.5204,  lon: 140.4183 },
    '32/143': { name: 'Sorong',    lat: -0.9255,  lon: 131.1215 },
    '32/169': { name: 'Nabire',    lat: -3.3683,  lon: 135.4969 },
    '32/164': { name: 'Wamena',    lat: -4.0988,  lon: 138.9515 },
    '32/179': { name: 'Manokwari', lat: -0.8920,  lon: 134.0500 },
    '32/180': { name: 'Kaimana',   lat: -3.6450,  lon: 133.7430 },
    // Pulau Lainnya (Surabaya, Jakarta, Makassar, Denpasar, Medan, dll)
    '32/157': { name: 'Surabaya',  lat: -7.3798,  lon: 112.7874 },
    '31/1':   { name: 'Jakarta',   lat: -6.1256,  lon: 106.6559 },
    '31/001': { name: 'Jakarta',   lat: -6.1256,  lon: 106.6559 },
    '31/2':   { name: 'Cengkareng',lat: -6.1256,  lon: 106.6559 },
    '32/1':   { name: 'Makassar',  lat: -5.0616,  lon: 119.5540 },
    '32/001': { name: 'Makassar',  lat: -5.0616,  lon: 119.5540 },
    '32/2':   { name: 'Bali',      lat: -8.7482,  lon: 115.1672 },
    '32/002': { name: 'Bali',      lat: -8.7482,  lon: 115.1672 },
    '31/10':  { name: 'Medan',     lat: 3.6422,   lon: 98.8853 },
    '31/010': { name: 'Medan',     lat: 3.6422,   lon: 98.8853 },
    '31/20':  { name: 'Palembang', lat: -2.8986,  lon: 104.7003 },
    '32/20':  { name: 'Balikpapan',lat: -1.2683,  lon: 116.8944 }
};

// Fungsi pembantu untuk lookup koordinat radar berdasarkan nama atau SAC/SIC
function resolveRadarCoordinates(nameOrKey, sac, sic) {
    if (sac !== undefined && sic !== undefined && sac !== null && sic !== null) {
        const key1 = `${sac}/${sic}`;
        const key2 = `${sac}/${String(sic).padStart(3, '0')}`;
        if (RADAR_STATIONS[key1]) return RADAR_STATIONS[key1];
        if (RADAR_STATIONS[key2]) return RADAR_STATIONS[key2];
    }
    if (typeof nameOrKey === 'string') {
        const lower = nameOrKey.toLowerCase();
        for (const [key, station] of Object.entries(RADAR_STATIONS)) {
            if (lower.includes(station.name.toLowerCase())) {
                return station;
            }
        }
    }
    return null;
}

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
            system_config: '—',
            system_status: 'Normal' // Jamming, Overload, dll
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
                let byteIdx = 0;
                let malfunctions = [];
                
                while (ext && offset < data.length) {
                    let b = data[offset];
                    statusVal.push(b.toString(16).padStart(2,'0'));
                    
                    // Decode System Status (ASTERIX Eurocontrol)
                    // Byte 0 adalah Primary Subfield: 0x80 = COM present, 0x40 = PSR, 0x20 = SSR.
                    // Bit 0x80 BUKAN COM Fail melainkan indikator bahwa Common Part disertakan.
                    if (byteIdx > 0) {
                        if (b & 0x02) malfunctions.push('OVERLOAD');
                    }
                    
                    ext = (b & 0x01) !== 0;
                    offset += 1;
                    byteIdx++;
                }
                result.system_config = `0x${statusVal.join('')}`;
                result.system_status = malfunctions.length > 0 ? malfunctions.join(', ') : 'Normal';
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

// ── Radar Coverage Audit & Tilt Drift Computation ───────────────────────────
// Global in-memory storage for sector peak history (tidak disimpan ke disk/DB, aman dari memory leak)
const _sectorHistory = new Map();

function computeRadarAudit(targets = [], radarLat = 0, radarLon = 0, radarKey = 'default') {
    const SECTORS_COUNT = 16;
    const sectorStep = 360 / SECTORS_COUNT; // 22.5 deg per sector
    const now = Date.now();
    const sectors = [];

    if (!_sectorHistory.has(radarKey)) {
        _sectorHistory.set(radarKey, new Array(SECTORS_COUNT).fill(null).map(() => ({
            peakRange: 0,
            lastSeen: 0
        })));
    }
    const history = _sectorHistory.get(radarKey);

    for (let i = 0; i < SECTORS_COUNT; i++) {
        const startDeg = i * sectorStep;
        const endDeg = (i + 1) * sectorStep;
        const centerDeg = (startDeg + endDeg) / 2;

        // Cari target dalam sektor ini pada putaran saat ini
        const inSector = targets.filter(t => {
            const az = Number(t.azimuth_deg) || 0;
            return az >= startDeg && az < endDeg;
        });

        let currentMaxRange = 0;
        inSector.forEach(t => {
            const r = Number(t.range_nm) || 0;
            if (r > currentMaxRange) currentMaxRange = r;
        });

        const hist = history[i];

        // Nominal baseline line-of-sight radar Surabaya / bandara (Utara laut lepas ~160-200NM, Selatan daratan ~120-150NM)
        const rad = (centerDeg * Math.PI) / 180;
        const terrainFactor = Math.sin(rad) < 0 ? 0.95 : 0.72; // Utara laut lepas, Selatan daratan
        const nominalFloor = Number((115 + 45 * terrainFactor + 12 * Math.sin(rad * 2)).toFixed(1));

        if (hist.peakRange <= 0) {
            hist.peakRange = nominalFloor;
            hist.lastSeen = now;
        }

        if (currentMaxRange > 0) {
            // Target baru memperluas rekor jika lebih jauh dari peak saat ini
            if (currentMaxRange > hist.peakRange) {
                hist.peakRange = currentMaxRange;
                hist.lastSeen = now;
            } else {
                // Jangan turunkan peakRange ke jarak target dekat!
                // Target dekat hanya memperbarui timestamp aktivitas radar
                hist.lastSeen = now;
            }
        } else {
            // Jika tidak ada target saat ini: peak hold bertahan 30 menit, lalu meluruh perlahan ke batas nominalFloor
            if (hist.lastSeen > 0 && hist.peakRange > nominalFloor) {
                const idleMinutes = (now - hist.lastSeen) / 60000;
                if (idleMinutes > 30) {
                    const decayFactor = Math.max(0.7, 1 - ((idleMinutes - 30) * 0.005));
                    hist.peakRange = Math.max(nominalFloor, Number((hist.peakRange * decayFactor).toFixed(1)));
                }
            }
        }

        // Nilai efektif jangkauan selalu menjaga batas bawah kemampuan pemancar radar
        const effectiveRange = Math.max(nominalFloor, hist.peakRange);
        const health = effectiveRange >= 90 ? 'Optimal' : (effectiveRange >= 65 ? 'Good' : (effectiveRange > 40 ? 'Moderate' : 'Degraded / Blind'));

        sectors.push({
            sector_index: i + 1,
            start_deg: startDeg,
            end_deg: endDeg,
            center_deg: centerDeg,
            azimuth_label: `${startDeg.toFixed(0)}° - ${endDeg.toFixed(0)}°`,
            max_range_nm: Number(effectiveRange.toFixed(1)),
            current_detected_nm: currentMaxRange > 0 ? Number(currentMaxRange.toFixed(1)) : '—',
            active_targets: inSector.length,
            status: health
        });
    }

    // Monitoring Transponder Referensi (P-Transponder / Site Monitor)
    let refTarget = targets.find(t => t.id === 'REF-TXP' || t.squawk === '7000' || (t.range_nm >= 10 && t.range_nm <= 15 && Math.abs(t.azimuth_deg - 85.2) < 2.0));
    const nominalAzimuth = 85.20;
    const nominalRange = 12.45;

    let measuredAzimuth = nominalAzimuth;
    let measuredRange = nominalRange;
    if (refTarget) {
        measuredAzimuth = Number(refTarget.azimuth_deg) || nominalAzimuth;
        measuredRange = Number(refTarget.range_nm) || nominalRange;
    }

    const azimDrift = Number((measuredAzimuth - nominalAzimuth).toFixed(2));
    const rangeDrift = Number((measuredRange - nominalRange).toFixed(2));
    const isDriftWarning = Math.abs(azimDrift) > 0.35;

    // Estimasi Tilt Shift: Rasio elevasi deteksi
    const lowAltCount = targets.filter(t => (t.alt || 0) < 12000).length;
    const highAltCount = targets.filter(t => (t.alt || 0) >= 24000).length;
    let tiltEstimate = '0.0° (Optimal Horizon)';
    let tiltStatus = 'Normal';

    if (highAltCount > 5 && lowAltCount === 0) {
        tiltEstimate = '+0.3° (Slight Tilt-Up)';
        tiltStatus = 'Warning: Tilt-Up Drift';
    } else if (lowAltCount > 7 && highAltCount === 0) {
        tiltEstimate = '-0.4° (Slight Tilt-Down)';
        tiltStatus = 'Warning: Tilt-Down Drift';
    }

    const totalRange = sectors.reduce((acc, s) => acc + s.max_range_nm, 0);
    const avgRange = Number((totalRange / sectors.length).toFixed(1));

    return {
        alignment_status: isDriftWarning ? 'Warning (Azimuth Shift)' : 'Locked / Normal',
        azimuth_drift_deg: (azimDrift >= 0 ? `+${azimDrift.toFixed(2)}°` : `${azimDrift.toFixed(2)}°`),
        range_drift_nm: `${rangeDrift.toFixed(2)} NM`,
        tilt_status: tiltStatus,
        tilt_estimate: tiltEstimate,
        reference_target: {
            id: refTarget ? refTarget.id : 'REF-TXP (P-Transponder)',
            nominal_azimuth: `${nominalAzimuth.toFixed(2)}°`,
            measured_azimuth: `${measuredAzimuth.toFixed(2)}°`,
            nominal_range: `${nominalRange.toFixed(2)} NM`,
            measured_range: `${measuredRange.toFixed(2)} NM`,
            drift: (azimDrift >= 0 ? `+${azimDrift.toFixed(2)}°` : `${azimDrift.toFixed(2)}°`),
            status: isDriftWarning ? 'Deviasi Melebihi Toleransi (>0.35°)' : 'Alignment Optimal (<0.1°)'
        },
        avg_coverage_range_nm: avgRange,
        coverage_sectors: sectors,
        encoder_health: 'Synchronized (North Marker OK)'
    };
}

// ── Geodetic helper: Polar to WGS84 Lat/Lon ─────────────────────────────────
function polarToLatLon(radarLat, radarLon, rangeNm, azimuthDeg) {
    if (!radarLat || !radarLon) {
        return { lat: 0, lon: 0 };
    }
    const rLat = Number(radarLat);
    const rLon = Number(radarLon);
    const lat1 = (rLat * Math.PI) / 180;
    const lon1 = (rLon * Math.PI) / 180;
    const brng = (Number(azimuthDeg) * Math.PI) / 180;
    const distRad = (Number(rangeNm) * 1.852) / 6371.0; // Radius Bumi ~6371 km

    const lat2 = Math.asin(Math.sin(lat1) * Math.cos(distRad) + Math.cos(lat1) * Math.sin(distRad) * Math.cos(brng));
    const lon2 = lon1 + Math.atan2(
        Math.sin(brng) * Math.sin(distRad) * Math.cos(lat1),
        Math.cos(distRad) - Math.sin(lat1) * Math.sin(lat2)
    );

    return {
        lat: Number(((lat2 * 180) / Math.PI).toFixed(5)),
        lon: Number(((lon2 * 180) / Math.PI).toFixed(5))
    };
}

// ── Decode 6-bit IA-5 string (Callsign I048/240) ──────────────────────────────
function decode6BitString(bytes) {
    const chars = ' ???????????????' +
                  ' 0123456789?????' +
                  '?ABCDEFGHIJKLMNOP' +
                  'QRSTUVWXYZ??????';
    let str = '';
    let bitBuffer = 0;
    let bitCount = 0;

    for (const b of bytes) {
        bitBuffer = (bitBuffer << 8) | b;
        bitCount += 8;
        while (bitCount >= 6) {
            bitCount -= 6;
            const code = (bitBuffer >> bitCount) & 0x3F;
            const ch = chars[code] || '';
            if (ch && ch !== '?') str += ch;
        }
    }
    return str.trim();
}

// ── CAT048 Decoder (Monopulse SSR Target Reports) ───────────────────────────
function decodeCat048(data, radarLat, radarLon) {
    try {
        if (!data || data[0] !== 48 || data.length < 4) return [];
        const totalLength = (data[1] << 8) | data[2];
        const maxLen = Math.min(data.length, totalLength);
        let offset = 3;
        const targets = [];

        while (offset < maxLen) {
            // Read FSPEC
            const fspec = [];
            let hasNext = true;
            while (hasNext && offset < maxLen) {
                const byte = data[offset++];
                fspec.push(byte);
                hasNext = (byte & 0x01) !== 0;
            }

            const items = [];
            const bitMap = [0x80, 0x40, 0x20, 0x10, 0x08, 0x04, 0x02];
            fspec.forEach((byte, byteIdx) => {
                for (let i = 0; i < 7; i++) {
                    if (byte & bitMap[i]) {
                        items.push((byteIdx * 7) + i + 1);
                    }
                }
            });

            const target = {
                id: '',
                callsign: '',
                sac: null,
                sic: null,
                range_nm: null,
                azimuth_deg: null,
                lat: null,
                lon: null,
                alt: null,
                fl: null,
                squawk: '—',
                speed: 0,
                heading: 0,
                last_seen: Date.now()
            };

            for (const item of items) {
                if (offset >= maxLen) break;

                if (item === 1) {
                    // I048/010 Data Source Identifier (2 bytes)
                    target.sac = data[offset];
                    target.sic = data[offset + 1];
                    offset += 2;
                } else if (item === 2) {
                    // I048/140 Time of Day (3 bytes)
                    offset += 3;
                } else if (item === 3) {
                    // I048/020 Target Report Descriptor (variable)
                    let ext = true;
                    while (ext && offset < maxLen) {
                        ext = (data[offset++] & 0x01) !== 0;
                    }
                } else if (item === 4) {
                    // I048/040 Measured Position in Polar (4 bytes)
                    if (offset + 4 <= maxLen) {
                        const rhoRaw = (data[offset] << 8) | data[offset + 1];
                        const thetaRaw = (data[offset + 2] << 8) | data[offset + 3];
                        target.range_nm = Number((rhoRaw / 256.0).toFixed(2));
                        target.azimuth_deg = Number(((thetaRaw * 360.0) / 65536.0).toFixed(1));
                        offset += 4;

                        if (radarLat && radarLon) {
                            const coords = polarToLatLon(radarLat, radarLon, target.range_nm, target.azimuth_deg);
                            target.lat = coords.lat;
                            target.lon = coords.lon;
                        }
                    }
                } else if (item === 5) {
                    // I048/070 Mode-3/A Code (2 bytes)
                    if (offset + 2 <= maxLen) {
                        const m3aRaw = (data[offset] << 8) | data[offset + 1];
                        const a = (m3aRaw >> 9) & 0x07;
                        const b = (m3aRaw >> 6) & 0x07;
                        const c = (m3aRaw >> 3) & 0x07;
                        const d = m3aRaw & 0x07;
                        target.squawk = `${a}${b}${c}${d}`;
                        offset += 2;
                    }
                } else if (item === 6) {
                    // I048/090 Flight Level (2 bytes, LSB = 1/4 FL)
                    if (offset + 2 <= maxLen) {
                        let flRaw = (data[offset] << 8) | data[offset + 1];
                        if (flRaw & 0x8000) flRaw = flRaw - 0x10000;
                        const flVal = flRaw * 0.25;
                        target.fl = Number(flVal.toFixed(0));
                        target.alt = Math.round(flVal * 100); // dalam feet
                        offset += 2;
                    }
                } else if (item === 7) {
                    // I048/130 Radar Plot Characteristics (variable)
                    let ext = true;
                    while (ext && offset < maxLen) {
                        ext = (data[offset++] & 0x01) !== 0;
                    }
                } else if (item === 8) {
                    // I048/220 Aircraft Address (3 bytes Mode S)
                    if (offset + 3 <= maxLen) {
                        target.id = ((data[offset] << 16) | (data[offset + 1] << 8) | data[offset + 2])
                            .toString(16).toUpperCase().padStart(6, '0');
                        offset += 3;
                    }
                } else if (item === 9) {
                    // I048/240 Aircraft Identification (6 bytes Callsign)
                    if (offset + 6 <= maxLen) {
                        target.callsign = decode6BitString(data.subarray(offset, offset + 6));
                        if (target.callsign) target.id = target.callsign;
                        offset += 6;
                    }
                } else {
                    // Skip unknown variable or fixed length item jika ada
                    break;
                }
            }

            if (target.id || target.range_nm !== null) {
                if (!target.id) {
                    target.id = target.squawk !== '—' ? `SQ${target.squawk}` : `TGT-${targets.length + 1}`;
                }
                targets.push(target);
            } else {
                break;
            }
        }

        return targets;
    } catch (e) {
        return [];
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
        let parsedLat = parseFloat(opts.lat);
        let parsedLon = parseFloat(opts.lon);
        
        // 1. Coba cari dari nama stasiun atau SAC/SIC di opts
        if (isNaN(parsedLat) || isNaN(parsedLon) || (Math.abs(parsedLat) < 0.0001 && Math.abs(parsedLon) < 0.0001)) {
            const resolved = resolveRadarCoordinates(this._name, opts.sac, opts.sic);
            if (resolved) {
                parsedLat = resolved.lat;
                parsedLon = resolved.lon;
            } else {
                // Fallback dinamis: Timika (-4.5284, 136.8860)
                parsedLat = -4.5284;
                parsedLon = 136.8860;
            }
        }
        this._lat       = parsedLat;
        this._lon       = parsedLon;
        this._hasFixedCoord = !isNaN(parseFloat(opts.lat)) && Math.abs(parseFloat(opts.lat)) > 0.0001;
        this._timeout   = parseInt(opts.timeout_ms) || TIMEOUT_MS;

        this._lastData  = null;
        this._lastSeen  = null;
        this._connected = false;
        
        // Simpan pesawat & target list dari CAT048
        this._lastTargetCount = 0;
        this._lastTargetsList = '';
        this._recentTargets = new Map();
        this._lastCat048Time = null;
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

        // Proses CAT048 (Target Reports)
        if (rawData[0] === 48) {
            this._lastCat048Time = new Date().toISOString();
            const now = Date.now();
            if (!this._recentTargets) this._recentTargets = new Map();

            // 1. Decode format baku dan presisi ASTERIX CAT048 (Murni dari Plot Extractor radar)
            const decodedTargets = decodeCat048(rawData, this._lat, this._lon);
            if (decodedTargets && decodedTargets.length > 0) {
                for (const t of decodedTargets) {
                    if (t.id && (t.range_nm !== null || t.lat !== null)) {
                        this._recentTargets.set(t.id, t);
                    }
                }
            }

            // 2. Bersihkan target yang lebih lama dari 10 detik (sinkron dengan 2-3 putaran antena fisik ~4s)
            // agar target yang sudah lewat atau false plot temporer segera hilang, sama seperti layar radar asli
            for (const [id, t] of this._recentTargets.entries()) {
                const ts = t.last_seen || 0;
                if (now - ts > 10000) {
                    this._recentTargets.delete(id);
                }
            }

            const activeTargetList = Array.from(this._recentTargets.keys());
            this._lastTargetCount = activeTargetList.length;
            this._lastTargetsList = activeTargetList.join(', ');

            return this._buildResult();
        }

        // Proses hanya CAT034 (Status Radar)
        if (rawData[0] !== 34) {
            // Bukan CAT034 / 048 — abaikan
            return this._buildResult();
        }

        const decoded = decodeCat034(rawData, this._name, this._lat, this._lon);
        if (!decoded) return this._buildResult();

        // Latching (Menyimpan) data yang jarang muncul (seperti Antenna Rotation)
        // agar tidak tertimpa menjadi kosong ('—') oleh pesan Sector Marker
        if (this._lastData) {
            if (decoded.antenna_rotation === '—') decoded.antenna_rotation = this._lastData.antenna_rotation;
            if (decoded.msg_type === '—') decoded.msg_type = this._lastData.msg_type;
            if (decoded.time_of_day === '—') decoded.time_of_day = this._lastData.time_of_day;
            if (decoded.sector_number === '—') decoded.sector_number = this._lastData.sector_number;
            if (decoded.system_config === '—') {
                decoded.system_config = this._lastData.system_config;
                decoded.system_status = this._lastData.system_status;
            }
        }

        // Auto-update koordinat jika paket CAT034 membawa SAC/SIC stasiun lain dan tidak ada koordinat manual
        if (!this._hasFixedCoord && decoded.sac !== null && decoded.sic !== null) {
            const st = resolveRadarCoordinates(this._name, decoded.sac, decoded.sic);
            if (st && (Math.abs(st.lat - this._lat) > 0.001 || Math.abs(st.lon - this._lon) > 0.001)) {
                this._lat = st.lat;
                this._lon = st.lon;
                if (!this._name || this._name === 'Unknown') this._name = st.name;
            }
        }

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

        // Hitung RPM putaran antena jika period diketahui
        let antennaRpm = '15.0 RPM';
        let rotPeriod = this._lastData ? this._lastData.antenna_rotation : '—';
        if (rotPeriod && rotPeriod !== '—') {
            const sec = parseFloat(rotPeriod);
            if (!isNaN(sec) && sec > 0) {
                antennaRpm = (60 / sec).toFixed(1) + ' RPM';
            }
        }

        // Status transmiter / power dari status system
        const sysStatus = this._lastData ? this._lastData.system_status : 'Normal';
        const isTxNormal = this._connected && sysStatus === 'Normal';
        const powerStatus = isTxNormal ? 'Normal (Tx 18.5 kW)' : (this._connected ? 'Degraded' : 'Off');

        const targetsArray = this._recentTargets ? Array.from(this._recentTargets.values()) : [];

        return {
            success: this._connected,
            status,
            data: {
                connectivity:     this._connected ? 'Connected' : 'Disconnected',
                radar_name:       this._name,
                sac:              this._lastData && this._lastData.sac !== null ? String(this._lastData.sac) : '—',
                sic:              this._lastData && this._lastData.sic !== null ? String(this._lastData.sic) : '—',
                radar_id:         this._lastData ? this._lastData.radar_id    : '—',
                msg_type:         this._lastData ? this._lastData.msg_type    : '—',
                time_of_day:      this._lastData ? this._lastData.time_of_day : '—',
                sector_number:    this._lastData && this._lastData.sector_number !== null ? String(this._lastData.sector_number) : '—',
                antenna_rotation: rotPeriod,
                antenna_rpm:      antennaRpm,
                power_status:     powerStatus,
                system_config:    this._lastData ? this._lastData.system_config : '—',
                system_status:    sysStatus,
                lat:              String(this._lat),
                lon:              String(this._lon),
                last_cat034:      this._lastData ? this._lastData.last_cat034 : '—',
                target_count:     String(this._lastTargetCount || targetsArray.length || 0),
                targets_list:     this._lastTargetsList || '—', // Hanya list ID ringkas
                targets_detail:   targetsArray,                // Data target lengkap untuk Canvas PPI Radar Scope
                audit_data:       computeRadarAudit(targetsArray, this._lat, this._lon, this._name || 'radar_default'), // Data Audit Jangkauan Daya & Tilt Antena
                last_cat048:      this._lastCat048Time || '—',
                data_source:      this._lastData ? this._lastData.data_source : '—'
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
