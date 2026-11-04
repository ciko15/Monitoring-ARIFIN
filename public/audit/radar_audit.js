/**
 * public/audit/radar_audit.js
 * Modul Audit & Fullscreen PPI Radar Scope Terpadu dengan Leaflet Map & Deteksi Double Target.
 * Kompatibel dengan arsitektur Monitoring-ARIFIN (ASTERIX CAT048 / CAT034 / ADS-B).
 */

(function () {
    'use strict';

    let _activeRadarSourceId = null;
    let _radarAnimId = null;
    let _radarSweepAngleDeg = 0;
    let _radarRangeNm = 120;
    let _radarMousePos = { x: -999, y: -999 };
    let _radarHoveredTarget = null;
    let _radarSelectedTargetId = null;
    let _radarRefreshTimer = null;
    let _currentRadarTab = 'ppi';

    // Map background controller
    let _radarMap = null;
    let _radarTileLayer = null;
    let _isMapEnabled = true; // Default aktif dengan latar belakang peta
    let _mapTheme = 'light'; // Default 'light' (peta terang)
    let _lastRadarCoords = { lat: -4.5284, lon: 136.8860 }; // Default Timika (akan di-update dinamis langsung dari ASTERIX CAT034)
    let _branchProfileCoords = null; // Koordinat branch profile aktif dari server
    let _isIslsFilterEnabled = false; // Fitur ISLS / Anti-Multipath Filter (Default: NONAKTIF)
    let _radarTargetTrafficFilter = 'all'; // 'all', 'inbound' (incoming), 'outbound' (outgoing)
    let _targetHistoryMap = new Map(); // Histori posisi [lat, lon, range, azim, time] untuk kalkulasi heading & track

    // Electronic Bearing and Range Line (EBRL / Ruler Distance Measurement Tool)
    let _isRulerMode = false;
    let _rulerPointA = null; // { x, y, lat, lon, label }
    let _rulerPointB = null; // { x, y, lat, lon, label }

    // ── Katalog Stasiun Radar MSSR Indonesia (SAC / SIC) ───────────────────────────
    const RADAR_STATIONS_MAP = {
        '50/8':   { name: 'Surabaya',  lat: -7.3798, lon: 112.7874 },
        '50/008': { name: 'Surabaya',  lat: -7.3798, lon: 112.7874 },
        '32/157': { name: 'Surabaya',  lat: -7.3798, lon: 112.7874 },
        '32/153': { name: 'Timika',    lat: -4.5284, lon: 136.8860 },
        '32/15':  { name: 'Timika',    lat: -4.5284, lon: 136.8860 },
        '32/015': { name: 'Timika',    lat: -4.5284, lon: 136.8860 },
        '32/163': { name: 'Sentani',   lat: -2.5721, lon: 140.5148 },
        '32/160': { name: 'Biak',      lat: -1.1874, lon: 136.1085 },
        '32/154': { name: 'Merauke',   lat: -8.5204, lon: 140.4183 },
        '32/143': { name: 'Sorong',    lat: -0.9255, lon: 131.1215 },
        '32/169': { name: 'Nabire',    lat: -3.3683, lon: 135.4969 },
        '32/164': { name: 'Wamena',    lat: -4.0988, lon: 138.9515 },
        '32/179': { name: 'Manokwari', lat: -0.8920, lon: 134.0500 },
        '32/180': { name: 'Kaimana',   lat: -3.6450, lon: 133.7430 },
        '32/157': { name: 'Surabaya',  lat: -7.3798, lon: 112.7874 },
        '31/1':   { name: 'Jakarta',   lat: -6.1256, lon: 106.6559 },
        '31/001': { name: 'Jakarta',   lat: -6.1256, lon: 106.6559 },
        '31/2':   { name: 'Cengkareng',lat: -6.1256, lon: 106.6559 },
        '32/1':   { name: 'Makassar',  lat: -5.0616, lon: 119.5540 },
        '32/001': { name: 'Makassar',  lat: -5.0616, lon: 119.5540 },
        '32/2':   { name: 'Bali',      lat: -8.7482, lon: 115.1672 },
        '32/002': { name: 'Bali',      lat: -8.7482, lon: 115.1672 },
        '31/10':  { name: 'Medan',     lat: 3.6422,  lon: 98.8853 },
        '31/010': { name: 'Medan',     lat: 3.6422,  lon: 98.8853 },
        '31/20':  { name: 'Palembang', lat: -2.8986, lon: 104.7003 },
        '32/20':  { name: 'Balikpapan',lat: -1.2683, lon: 116.8944 }
    };

    // Ambil profil bandara cabang secara asinkron agar otomatis menyesuaikan dengan lokasi aktif
    function fetchBranchProfileCoords() {
        if (_branchProfileCoords) return Promise.resolve(_branchProfileCoords);
        return fetch('/api/config/branch-profile', { headers: window.getAuthHeaders ? window.getAuthHeaders() : {} })
            .then(res => res.ok ? res.json() : null)
            .then(profile => {
                if (profile && profile.lat && profile.lng) {
                    _branchProfileCoords = {
                        lat: parseFloat(profile.lat),
                        lon: parseFloat(profile.lng),
                        name: profile.airportName || profile.siteId || 'Station'
                    };
                    if (_lastRadarCoords && Math.abs(_lastRadarCoords.lat - (-4.5284)) < 0.001) {
                        _lastRadarCoords = { lat: _branchProfileCoords.lat, lon: _branchProfileCoords.lon };
                    }
                    return _branchProfileCoords;
                }
                return null;
            }).catch(() => null);
    }
    fetchBranchProfileCoords();

    // Resolusi otomatis koordinat stasiun radar (Rantai Prioritas):
    // 1. data.lat & data.lon dari konfigurasi Data Source (input user di form config)
    // 2. Profil koordinat bandara aktif (_branchProfileCoords / branch_profile.json)
    // 3. Lookup tabel SAC / SIC (I034/010)
    // 4. Default fallback aman (Surabaya)
    function resolveRadarStationCoords(data) {
        // 1. Koordinat spesifik dari konfigurasi Data Source (jika diinput user di UI & valid)
        if (data) {
            let lat = parseFloat(data.lat);
            let lon = parseFloat(data.lon !== undefined && data.lon !== null ? data.lon : data.lng);
            if (!isNaN(lat) && !isNaN(lon) && (Math.abs(lat) > 0.0001 || Math.abs(lon) > 0.0001)) {
                if (lat >= -12.0 && lat <= 7.0 && lon >= 94.0 && lon <= 142.0) {
                    return { lat, lon, name: data.radar_name || 'Radar Station (Source Config)' };
                }
            }
        }

        // 2. Profil koordinat bandara aktif dari branch_profile.json (jika data source tidak mengisi lat/lon)
        if (_branchProfileCoords && !isNaN(_branchProfileCoords.lat)) {
            const bLat = parseFloat(_branchProfileCoords.lat);
            const bLon = parseFloat(_branchProfileCoords.lon);
            if (bLat >= -12.0 && bLat <= 7.0 && bLon >= 94.0 && bLon <= 142.0) {
                return _branchProfileCoords;
            }
        }

        // 3. Prioritas berikutnya: Lookup SAC / SIC dari header paket CAT 034 (I034/010)
        if (data) {
            if (data.sac !== undefined && data.sic !== undefined && data.sac !== null && data.sic !== null) {
                const k1 = `${data.sac}/${data.sic}`;
                const k2 = `${data.sac}/${String(data.sic).padStart(3, '0')}`;
                if (RADAR_STATIONS_MAP[k1]) return RADAR_STATIONS_MAP[k1];
                if (RADAR_STATIONS_MAP[k2]) return RADAR_STATIONS_MAP[k2];
            }

            // Lookup Nama Stasiun jika membawa nama lokasi
            const rName = String(data.radar_name || '').toLowerCase();
            if (rName && rName !== 'unknown' && rName !== 'mssr') {
                for (const st of Object.values(RADAR_STATIONS_MAP)) {
                    if (rName.includes(st.name.toLowerCase())) {
                        return st;
                    }
                }
            }
        }

        // 4. Default aman stasiun radar di Indonesia jika semua kosong
        return { lat: -7.3798, lon: 112.7874, name: 'Surabaya' };
    }

    // Hitung Heading / Arah Moncong Pesawat yang Akurat (0 - 360°)
    function getTargetHeading(tgt, radarLat, radarLon) {
        const tgtId = String(tgt.id || '');
        const currentR = Number(tgt.range_nm) || 0;
        const currentAz = Number(tgt.azimuth_deg) || 0;

        // 1. Jika sensor mengirimkan heading/track eksplisit valid (> 0 dan != 0)
        if (tgt.heading !== undefined && tgt.heading !== null && tgt.heading !== '' && !isNaN(Number(tgt.heading)) && Number(tgt.heading) > 0) {
            return Number(tgt.heading);
        }

        // 2. Kalkulasi heading dari pergerakan historis (track vector antara sapuan antena radar)
        const now = Date.now();
        if (_targetHistoryMap.has(tgtId)) {
            const hist = _targetHistoryMap.get(tgtId);
            const dt = (now - hist.time) / 1000;
            // Jika update sebelumnya dalam 0.3 - 40 detik terakhir
            if (dt >= 0.3 && dt <= 40) {
                // Selisih koordinat lat/lon atau polar
                const dLat = Math.abs(tgt.lat - hist.lat);
                const dLon = Math.abs(tgt.lon - hist.lon);
                if (dLat > 0.0005 || dLon > 0.0005) {
                    const lat1 = (hist.lat * Math.PI) / 180;
                    const lat2 = (tgt.lat * Math.PI) / 180;
                    const deltaLon = ((tgt.lon - hist.lon) * Math.PI) / 180;
                    const y = Math.sin(deltaLon) * Math.cos(lat2);
                    const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(deltaLon);
                    let computedHdg = (Math.atan2(y, x) * 180) / Math.PI;
                    computedHdg = (computedHdg + 360) % 360;

                    tgt.heading = Math.round(computedHdg);
                    return tgt.heading;
                } else if (Math.abs(currentR - hist.range) >= 0.04) {
                    // Jika menjauh dari radar (delta range positif) -> heading menjauh (radial outbound)
                    // Jika mendekat ke radar (delta range negatif) -> heading mendekat (radial inbound)
                    const dR = currentR - hist.range;
                    const computedHdg = dR > 0 ? currentAz : (currentAz + 180) % 360;
                    tgt.heading = Math.round(computedHdg);
                    return tgt.heading;
                }
            }
        }

        // 3. Fallback jika data baru / belum ada delta pergerakan:
        // Gunakan hash deterministik untuk membagi 50:50 incoming & outgoing
        let hash = 0;
        for (let i = 0; i < tgtId.length; i++) {
            hash = ((hash << 5) - hash) + tgtId.charCodeAt(i);
            hash |= 0;
        }
        const isDefaultInbound = Math.abs(hash) % 2 === 0;
        // Inbound: moncong mengarah ke pusat radar (currentAz + 180)
        // Outbound: moncong mengarah menjauhi pusat radar (currentAz)
        const fallbackHdg = isDefaultInbound ? (currentAz + 180) % 360 : currentAz;
        tgt.heading = Math.round(fallbackHdg);
        return tgt.heading;
    }

    // Deteksi Arah Lalu Lintas Pesawat: Incoming (Mendekati radar) vs Outgoing (Menjauhi radar)
    function getTargetTrafficDirection(tgt, radarLat, radarLon) {
        const azim = Number(tgt.azimuth_deg) || 0;
        const currentR = Number(tgt.range_nm) || 0;
        const tgtId = String(tgt.id || '');

        // 1. Cek perubahan jarak (delta range) historis: Jika range mengecil -> INBOUND, jika membesar -> OUTBOUND
        if (_targetHistoryMap.has(tgtId)) {
            const hist = _targetHistoryMap.get(tgtId);
            const dR = currentR - hist.range;
            if (Math.abs(dR) >= 0.04) {
                return dR < 0 ? 'inbound' : 'outbound';
            }
        }

        // 2. Evaluasi berdasarkan heading
        let hdg = getTargetHeading(tgt, radarLat, radarLon);
        const radialInbound = (azim + 180) % 360;
        let diff = Math.abs(hdg - radialInbound);
        if (diff > 180) diff = 360 - diff;

        return diff <= 90 ? 'inbound' : 'outbound';
    }

    // Formula Geodetik Standar WGS84 (Great Circle / Rhumb Line)
    function calculatePolarToLatLon(radarLat, radarLon, rangeNm, azimuthDeg) {
        let rLat = parseFloat(radarLat);
        let rLon = parseFloat(radarLon);
        if (isNaN(rLat) || isNaN(rLon) || (Math.abs(rLat) < 0.0001 && Math.abs(rLon) < 0.0001)) {
            const st = resolveRadarStationCoords();
            rLat = st.lat;
            rLon = st.lon;
        }
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

    // Hitung jarak Geodetik Great-Circle (Haversine) dan Arah Azimuth (Bearing) antara 2 titik WGS84
    function calculateGeoDistanceAndBearing(lat1, lon1, lat2, lon2) {
        const R_km = 6371.0;
        const phi1 = (lat1 * Math.PI) / 180;
        const phi2 = (lat2 * Math.PI) / 180;
        const deltaPhi = ((lat2 - lat1) * Math.PI) / 180;
        const deltaLam = ((lon2 - lon1) * Math.PI) / 180;

        // Haversine formula
        const a = Math.sin(deltaPhi / 2) * Math.sin(deltaPhi / 2) +
                  Math.cos(phi1) * Math.cos(phi2) *
                  Math.sin(deltaLam / 2) * Math.sin(deltaLam / 2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        const distKm = R_km * c;
        const distNm = distKm / 1.852;

        // Bearing / Azimuth (0 - 360°)
        const y = Math.sin(deltaLam) * Math.cos(phi2);
        const x = Math.cos(phi1) * Math.sin(phi2) -
                  Math.sin(phi1) * Math.cos(phi2) * Math.cos(deltaLam);
        let brng = (Math.atan2(y, x) * 180) / Math.PI;
        brng = (brng + 360) % 360;

        return {
            distNm: Number(distNm.toFixed(2)),
            distKm: Number(distKm.toFixed(2)),
            bearing: Number(brng.toFixed(1))
        };
    }

    function addAuditRadarStyles() {
        if (document.getElementById('auditRadarStyles')) return;
        const style = document.createElement('style');
        style.id = 'auditRadarStyles';
        style.textContent = `
            /* ── AUDIT RADAR PPI SCOPE (FULLSCREEN 100vw x 100vh) ─────────────── */
            #radarPpiOverlay {
                display: none;
                position: fixed !important;
                inset: 0 !important;
                top: 0 !important;
                left: 0 !important;
                width: 100vw !important;
                height: 100vh !important;
                background: rgba(2, 6, 14, 0.88) !important;
                backdrop-filter: blur(8px) !important;
                -webkit-backdrop-filter: blur(8px) !important;
                z-index: 99990 !important;
                transition: opacity 0.3s ease !important;
            }
            #radarPpiSidebar {
                display: flex !important;
                flex-direction: column !important;
                position: fixed !important;
                top: 0 !important;
                left: 0 !important;
                right: 0 !important;
                bottom: 0 !important;
                width: 100vw !important;
                height: 100vh !important;
                max-width: 100vw !important;
                min-width: 100vw !important;
                max-height: 100vh !important;
                min-height: 100vh !important;
                background: #030712 !important;
                box-shadow: 0 0 60px rgba(0, 0, 0, 0.95) !important;
                z-index: 99999 !important;
                transform: translateY(-100%) !important;
                transition: transform 0.35s cubic-bezier(0.16, 1, 0.3, 1) !important;
                color: #e2e8f0 !important;
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", sans-serif !important;
                overflow: hidden !important;
                margin: 0 !important;
                border: none !important;
                border-radius: 0 !important;
            }
            #radarPpiSidebar.open {
                transform: translateY(0) !important;
            }
            .radar-scope-header {
                display: flex;
                align-items: center;
                justify-content: space-between;
                padding: 12px 24px;
                background: rgba(8, 16, 32, 0.95);
                border-bottom: 1px solid rgba(0, 212, 255, 0.25);
                gap: 16px;
                flex-shrink: 0;
            }
            .radar-scope-title-wrap {
                display: flex;
                align-items: center;
                gap: 14px;
                min-width: 0;
            }
            .radar-scope-radar-icon {
                font-size: 24px;
                color: #00ffcc;
                text-shadow: 0 0 14px #00ffcc88;
            }
            .radar-scope-title {
                font-size: 16px;
                font-weight: 800;
                color: #e8f4ff;
                letter-spacing: 0.5px;
                display: flex;
                align-items: center;
                gap: 10px;
            }
            .radar-live-badge {
                font-size: 10px;
                background: rgba(0, 255, 136, 0.15);
                color: #00ff88;
                border: 1px solid #00ff88;
                border-radius: 4px;
                padding: 2px 7px;
                font-weight: 700;
                letter-spacing: 0.5px;
                display: inline-flex;
                align-items: center;
                gap: 4px;
            }
            .radar-live-badge::before {
                content: '';
                width: 6px;
                height: 6px;
                background: #00ff88;
                border-radius: 50%;
                display: inline-block;
                animation: pulse-subtle 1.2s infinite ease-in-out;
            }
            .radar-metric-chip {
                background: rgba(15, 28, 52, 0.85);
                border: 1px solid rgba(0, 212, 255, 0.25);
                padding: 4px 12px;
                border-radius: 6px;
                display: flex;
                align-items: center;
                gap: 7px;
                font-size: 11px;
                color: #94a3b8;
            }
            .radar-metric-val {
                color: #00d4ff;
                font-weight: 700;
                font-family: monospace;
            }
            .radar-controls-toolbar {
                display: flex;
                align-items: center;
                justify-content: space-between;
                padding: 8px 24px;
                background: rgba(8, 16, 32, 0.95);
                border-bottom: 1px solid rgba(0, 212, 255, 0.2);
                flex-shrink: 0;
            }
            .radar-tab-btn {
                background: rgba(15, 30, 58, 0.6);
                border: 1px solid rgba(0, 212, 255, 0.3);
                color: #94a3b8;
                padding: 6px 14px;
                border-radius: 6px;
                font-size: 12px;
                font-weight: 600;
                cursor: pointer;
                transition: all 0.2s;
                display: inline-flex;
                align-items: center;
                gap: 6px;
            }
            .radar-tab-btn:hover, .radar-tab-btn.active {
                background: rgba(0, 212, 255, 0.2);
                border-color: #00ffff;
                color: #00ffff;
                box-shadow: 0 0 10px rgba(0, 212, 255, 0.3);
            }
            .radar-range-btn {
                background: rgba(15, 28, 52, 0.8);
                border: 1px solid rgba(0, 212, 255, 0.3);
                color: #cbd5e1;
                padding: 4px 10px;
                border-radius: 4px;
                font-size: 11px;
                font-family: monospace;
                font-weight: 600;
                cursor: pointer;
                transition: all 0.2s;
            }
            .radar-range-btn:hover, .radar-range-btn.active {
                background: #00d4ff;
                color: #02060e;
                font-weight: 800;
                border-color: #00ffff;
                box-shadow: 0 0 8px rgba(0, 212, 255, 0.5);
            }
            .radar-scope-body {
                flex: 1;
                display: flex;
                flex-direction: column;
                position: relative;
                background: #03060c;
                min-height: 0;
            }
            .radar-canvas-container {
                flex: 1;
                position: relative;
                display: flex;
                align-items: center;
                justify-content: center;
                overflow: hidden;
            }
            /* Map Underlay */
            #radarMapUnderlay {
                position: absolute;
                inset: 0;
                z-index: 1;
                pointer-events: none;
                transition: opacity 0.3s;
            }
            #radarMapUnderlay .leaflet-control-container {
                display: none !important;
            }
            #radarPpiCanvas {
                position: relative;
                z-index: 2;
                display: block;
                cursor: crosshair;
            }
            #radarHoverHud {
                position: absolute;
                display: none;
                pointer-events: none;
                background: rgba(4, 10, 20, 0.95);
                border: 1px solid #00ffff;
                border-radius: 8px;
                padding: 10px 14px;
                color: #e2e8f0;
                font-size: 11px;
                box-shadow: 0 8px 24px rgba(0, 0, 0, 0.8), 0 0 15px rgba(0, 255, 255, 0.35);
                backdrop-filter: blur(8px);
                z-index: 1000;
                min-width: 185px;
            }
            /* Right Detail Sidebar untuk Target Terpilih */
            #radarTargetDetailSidebar {
                position: absolute;
                top: 0;
                right: 0;
                bottom: 0;
                width: 330px;
                max-width: 85vw;
                background: rgba(5, 12, 26, 0.96);
                border-left: 1px solid rgba(0, 212, 255, 0.35);
                box-shadow: -10px 0 35px rgba(0, 0, 0, 0.85);
                backdrop-filter: blur(12px);
                -webkit-backdrop-filter: blur(12px);
                z-index: 1050;
                display: flex;
                flex-direction: column;
                transform: translateX(100%);
                transition: transform 0.28s cubic-bezier(0.16, 1, 0.3, 1);
                color: #e2e8f0;
                pointer-events: auto;
            }
            #radarTargetDetailSidebar.open {
                transform: translateX(0);
            }
            .radar-sidebar-header {
                padding: 14px 16px;
                background: rgba(10, 22, 44, 0.95);
                border-bottom: 1px solid rgba(0, 212, 255, 0.25);
                display: flex;
                justify-content: space-between;
                align-items: center;
            }
            .radar-sidebar-body {
                flex: 1;
                overflow-y: auto;
                padding: 16px;
                display: flex;
                flex-direction: column;
                gap: 14px;
            }
            .radar-detail-group {
                background: rgba(12, 24, 48, 0.7);
                border: 1px solid rgba(255, 255, 255, 0.08);
                border-radius: 8px;
                padding: 12px;
                display: flex;
                flex-direction: column;
                gap: 8px;
            }
            .radar-detail-row {
                display: flex;
                justify-content: space-between;
                align-items: center;
                font-size: 11px;
                border-bottom: 1px solid rgba(255, 255, 255, 0.04);
                padding-bottom: 6px;
            }
            .radar-detail-row:last-child {
                border-bottom: none;
                padding-bottom: 0;
            }
            .radar-detail-lbl {
                color: #94a3b8;
                font-weight: 600;
            }
            .radar-detail-val {
                color: #e2e8f0;
                font-family: monospace;
                font-weight: 700;
            }
            .radar-targets-panel {
                height: 140px;
                background: #050a14;
                border-top: 1px solid rgba(0, 212, 255, 0.2);
                padding: 8px 16px;
                display: flex;
                flex-direction: column;
                gap: 6px;
                flex-shrink: 0;
                z-index: 5;
            }
            .radar-targets-strip {
                flex: 1;
                display: flex;
                gap: 8px;
                overflow-x: auto;
                align-items: center;
                padding-bottom: 4px;
            }
            .radar-target-card {
                background: rgba(12, 24, 46, 0.9);
                border: 1px solid rgba(0, 212, 255, 0.25);
                border-radius: 6px;
                padding: 6px 12px;
                font-size: 11px;
                display: flex;
                flex-direction: column;
                gap: 2px;
                min-width: 125px;
                cursor: pointer;
                transition: all 0.2s;
                flex-shrink: 0;
            }
            .radar-target-card:hover, .radar-target-card.highlight {
                background: rgba(0, 212, 255, 0.2);
                border-color: #00ffff;
                box-shadow: 0 0 10px rgba(0, 255, 255, 0.3);
            }
            /* Styling khusus target ganda (DOUBLE TARGET ALERT) */
            .radar-target-card.is-double {
                background: rgba(239, 68, 68, 0.15) !important;
                border: 1px solid #ef4444 !important;
                box-shadow: 0 0 10px rgba(239, 68, 68, 0.35) !important;
            }
            .radar-target-card.is-double .tgt-id {
                color: #ff5555 !important;
            }
            .radar-target-card .tgt-id {
                font-weight: 800;
                color: #00ffcc;
                font-size: 12px;
                display: flex;
                justify-content: space-between;
                align-items: center;
            }
            .radar-target-card .tgt-info {
                color: #94a3b8;
                font-size: 10px;
                font-family: monospace;
            }
            .radar-audit-content {
                flex: 1;
                padding: 20px 24px;
                overflow-y: auto;
                display: flex;
                flex-direction: column;
                gap: 16px;
            }
            .radar-audit-card {
                background: rgba(10, 20, 38, 0.9);
                border: 1px solid rgba(0, 212, 255, 0.25);
                border-radius: 8px;
                padding: 16px;
            }
            .radar-audit-table {
                width: 100%;
                border-collapse: collapse;
                font-size: 11px;
                text-align: left;
            }
            .radar-audit-table th {
                background: rgba(15, 30, 58, 0.9);
                color: #00d4ff;
                padding: 8px 12px;
                border-bottom: 1px solid rgba(0, 212, 255, 0.3);
                font-weight: 700;
            }
            .radar-audit-table td {
                padding: 7px 12px;
                border-bottom: 1px solid rgba(255, 255, 255, 0.05);
                color: #cbd5e1;
                font-family: monospace;
            }
        `;
        document.head.appendChild(style);
    }

    // ── IDENTIFIKASI DOUBLE TARGET ──────────────────────────────────────────────
    /**
     * Memeriksa daftar target dan menandai mana saja yang terduplikasi.
     * Kriteria duplikat:
     * 1. Squawk sama persis (dan bukan '—' / bukan '1200' / bukan '7000') ATAU
     * 2. Jarak berdekatan (selisih range <= 1.2 NM & selisih azimuth <= 1.2°)
     */
    let _lastDuplicateAuditReport = []; // Menyimpan laporan audit lengkap target dobel

    function detectDuplicateTargets(targets = []) {
        const doubleMap = new Map(); // id -> boolean
        const count = targets.length;
        const report = [];

        for (let i = 0; i < count; i++) {
            const a = targets[i];
            const aId = String(a.id || '');
            const aSq = String(a.squawk || '').trim();
            const aR = Number(a.range_nm) || 0;
            const aAz = Number(a.azimuth_deg) || 0;
            const aFl = a.fl || (a.alt ? Math.round(a.alt / 100) : 0);

            for (let j = i + 1; j < count; j++) {
                const b = targets[j];
                const bId = String(b.id || '');
                const bSq = String(b.squawk || '').trim();
                const bR = Number(b.range_nm) || 0;
                const bAz = Number(b.azimuth_deg) || 0;
                const bFl = b.fl || (b.alt ? Math.round(b.alt / 100) : 0);

                let isDup = false;
                let reason = '';
                let category = '';
                let probableCause = '';
                let recommendation = '';

                const dR = Math.abs(aR - bR);
                let dAz = Math.abs(aAz - bAz);
                if (dAz > 180) dAz = 360 - dAz;
                const dFl = Math.abs(aFl - bFl);

                // Kriteria Standar Radar Display untuk Target Dobel / Split:
                // 1. Squawk Khusus Identik (bukan VFR 1200 / 7000 / kosong) DAN jarak berdekatan (< 1.2 NM & < 1.2°)
                const sameSquawk = aSq && bSq && aSq !== '—' && aSq !== '1200' && aSq !== '7000' && aSq === bSq;
                
                // 2. Proksimitas Polar Sangat Ketat (Satu beam width radar ~1.5°, selisih range sangat kecil < 0.8 NM)
                const isPhysicalSplit = sameSquawk && dR <= 0.8 && dAz <= 1.2 && aR > 0 && bR > 0;
                const isPhysicalMultipath = sameSquawk && dR > 0.8 && dR <= 4.0 && dAz <= 3.0 && aR > 0 && bR > 0;

                if (isPhysicalSplit) {
                    isDup = true;
                    category = 'PLOT SPLIT (AZIMUTH / RANGE)';
                    reason = `Squawk sama persis (SQ ${aSq}), selisih jarak sangat tipis ${dR.toFixed(2)} NM dan sudut ${dAz.toFixed(2)}°`;
                    probableCause = 'Plot Extractor / RDP gagal menggabungkan (coalescing) reply pulse, atau kurva Monopulse Off-Boresight Azimuth (OBA) mengalami fase drift.';
                    recommendation = 'Periksa parameter Runlength / Azimuth Coalescing Window di RDP, dan lakukan kalibrasi kurva OBA Monopulse Receiver (Sigma & Delta channel).';
                } else if (isPhysicalMultipath) {
                    isDup = true;
                    category = 'MULTIPATH REFLECTION (GHOST TARGET)';
                    reason = `Squawk sama persis (SQ ${aSq}) dengan selisih jarak ${dR.toFixed(1)} NM (Azim Δ${dAz.toFixed(1)}°)`;
                    probableCause = 'Pantulan sinyal 1030/1090 MHz dari lereng pegunungan/struktur darat di sekitar radar, memunculkan echo sekunder.';
                    recommendation = 'Aktifkan Reflection Screening Map pada RDP di azimuth lereng gunung, atau verifikasi pulsa P2 ISLS.';
                }

                if (isDup) {
                    doubleMap.set(aId, true);
                    doubleMap.set(bId, true);
                    report.push({
                        targetA: a,
                        targetB: b,
                        category,
                        reason,
                        probableCause,
                        recommendation,
                        deltaRange: dR.toFixed(2),
                        deltaAzim: dAz.toFixed(2),
                        deltaFl: dFl
                    });
                }
            }
        }
        _lastDuplicateAuditReport = report;
        return doubleMap;
    }

    // ── DOM INJECTION & SETUP ──────────────────────────────────────────────────
    function ensureRadarPpiDOMElements() {
        addAuditRadarStyles();
        if (document.getElementById('radarPpiSidebar')) return;

        // Overlay
        const overlay = document.createElement('div');
        overlay.id = 'radarPpiOverlay';
        overlay.onclick = () => window.closeRadarPpiScope();
        document.body.appendChild(overlay);

        // Fullscreen Modal
        const sidebar = document.createElement('div');
        sidebar.id = 'radarPpiSidebar';
        sidebar.innerHTML = `
            <!-- Header Bar -->
            <div class="radar-scope-header">
                <div class="radar-scope-title-wrap">
                    <i class="fas fa-crosshairs radar-scope-radar-icon"></i>
                    <div>
                        <div class="radar-scope-title">
                            <span id="radarStationTitle">RADAR MSSR PPI SCOPE</span>
                            <span class="radar-live-badge">CAT 048 / 034</span>
                            <button id="radarDoubleSummaryBadge" onclick="window.openRadarDuplicateAuditModal()" title="Klik untuk melihat Diagnosa Anomali & Rekomendasi Solusi Target Dobel" style="display:none; cursor:pointer; font-size:10px; background:rgba(239,68,68,0.2); color:#ff5555; border:1px solid #ef4444; border-radius:4px; padding:2px 8px; font-weight:700; align-items:center; gap:5px; transition: all 0.2s;" onmouseover="this.style.background='rgba(239,68,68,0.4)';" onmouseout="this.style.background='rgba(239,68,68,0.2)';">
                                <i class="fas fa-exclamation-triangle"></i> <span id="radarDoubleCountText">0 Target Dobel</span> <span style="font-size:9px; background:#ef4444; color:#fff; border-radius:3px; padding:0 4px; margin-left:3px;">Audit & Solusi 🔍</span>
                            </button>
                        </div>
                        <div id="radarStationSub" style="font-size: 11px; color: #64748b; font-family: monospace; margin-top: 2px;">
                            SAC: — | SIC: — | ID: —
                        </div>
                    </div>
                </div>

                <div style="display: flex; align-items: center; gap: 10px;">
                    <!-- Antenna Rotation Widget -->
                    <div class="radar-metric-chip" title="Antenna Rotation Period & RPM">
                        <i class="fas fa-rotate fa-spin" style="color: #00ff88; animation-duration: 4s;"></i>
                        <span>ROT:</span>
                        <span class="radar-metric-val" id="radarMetricRot">3.96s</span>
                        <span style="font-size: 10px; color: #64748b;" id="radarMetricRpm">(15.2 RPM)</span>
                    </div>

                    <!-- Power Indicator Widget -->
                    <div class="radar-metric-chip" title="Transmitter Output Power">
                        <i class="fas fa-bolt" style="color: #ffcc00;"></i>
                        <span>TX PWR:</span>
                        <span class="radar-metric-val" id="radarMetricPower" style="color: #00ff88;">Normal (18.5 kW)</span>
                    </div>

                    <!-- Close Button -->
                    <button onclick="window.closeRadarPpiScope()" style="background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.2); color: #cbd5e1; font-size: 18px; cursor: pointer; padding: 4px 12px; border-radius: 6px; transition: all 0.2s;" onmouseover="this.style.background='rgba(239,68,68,0.3)'; this.style.color='#fff';" onmouseout="this.style.background='rgba(255,255,255,0.08)'; this.style.color='#cbd5e1';">✕</button>
                </div>
            </div>

            <!-- Toolbar Controls & Tab Switcher -->
            <div class="radar-controls-toolbar">
                <div style="display: flex; align-items: center; gap: 8px;">
                    <button class="radar-tab-btn active" id="radarTabBtnPpi" onclick="window.switchRadarTab('ppi')">
                        <i class="fas fa-crosshairs"></i> Radar PPI Scope
                    </button>
                    <button class="radar-tab-btn" id="radarTabBtnAudit" onclick="window.switchRadarTab('audit')">
                        <i class="fas fa-chart-pie"></i> Audit Jangkauan & Tilt Antena
                    </button>
                    <button class="radar-tab-btn" id="radarToggleIslsBtn" onclick="window.toggleRadarIslsFilter()" title="Simulasi Interrogation Side-Lobe Suppression (ISLS) & Anti-Multipath Filter" style="border-color: rgba(148, 163, 184, 0.4); color: #94a3b8;">
                        <i class="fas fa-shield-alt"></i> Filter ISLS: <span id="radarIslsStateText" style="font-weight: 700; color: #cbd5e1;">NONAKTIF</span>
                    </button>
                    <button class="radar-tab-btn" id="radarRulerBtn" onclick="window.toggleRadarRuler()" title="Alat Pengukur Jarak & Arah Antara 2 Titik / Pesawat (Shortcut: M atau D)" style="border-color: rgba(56, 189, 248, 0.4); color: #38bdf8;">
                        <i class="fas fa-ruler-combined"></i> Ukur Jarak: <span id="radarRulerStateText" style="font-weight: 700; color: #cbd5e1;">OFF</span>
                    </button>
                </div>
                <div id="radarPpiControlsRight" style="display: flex; align-items: center; gap: 12px;">
                    <div style="display: flex; align-items: center; gap: 4px;">
                        <span style="color: #64748b; font-size: 11px; font-weight: 600;">RANGE:</span>
                        <button class="radar-range-btn" onclick="window.setRadarPpiRange(40)">40 NM</button>
                        <button class="radar-range-btn" onclick="window.setRadarPpiRange(80)">80 NM</button>
                        <button class="radar-range-btn active" id="btnRange120" onclick="window.setRadarPpiRange(120)">120 NM</button>
                        <button class="radar-range-btn" onclick="window.setRadarPpiRange(200)">200 NM</button>
                    </div>
                    <span id="radarTargetCountBadge" style="font-size: 11px; color: #94a3b8;"><strong style="color: #00ffcc;">0</strong> Pesawat Terdeteksi</span>
                </div>
                <div id="radarAuditControlsRight" style="display: none; align-items: center; gap: 8px;">
                    <button class="radar-tab-btn" onclick="window.openRefTxpConfigModal()" style="padding: 4px 10px; font-size: 11px; background: rgba(255, 170, 0, 0.15); border-color: #ffaa00; color: #ffcc00;">
                        <i class="fas fa-sliders-h"></i> Kalibrasi Transponder Ref
                    </button>
                    <span class="radar-live-badge" style="background: rgba(0, 212, 255, 0.15); color: #00d4ff; border-color: #00d4ff;">DIAGNOSTIK RF & ALIGNMENT</span>
                </div>
            </div>

            <!-- Body View Area -->
            <div class="radar-scope-body">
                <!-- VIEW 1: RADAR PPI CANVAS SCOPE -->
                <div id="radarPpiView" style="flex: 1; display: flex; flex-direction: column; min-height: 0;">
                    <div class="radar-canvas-container" id="radarCanvasContainer">
                        <!-- Underlay Peta Leaflet -->
                        <div id="radarMapUnderlay"></div>

                        <!-- Canvas PPI Scope Overlay -->
                        <canvas id="radarPpiCanvas"></canvas>

                        <!-- Hover Tooltip HUD -->
                        <div id="radarHoverHud">
                            <div style="font-weight: 800; font-size: 13px; color: #00ffff; border-bottom: 1px solid rgba(0,255,255,0.25); padding-bottom: 4px; margin-bottom: 6px; display: flex; justify-content: space-between; align-items: center;">
                                <span id="hudCallsign">GA312</span>
                                <span id="hudSquawk" style="color: #ffcc00; font-size: 10px; font-weight: normal;">SQ 1200</span>
                            </div>
                            <div style="display: grid; grid-template-columns: auto auto; gap: 4px 14px; font-family: monospace; font-size: 11px;">
                                <span style="color: #64748b;">STATUS:</span> <span id="hudStatus" style="color: #00ff88; font-weight: bold;">Normal Plot</span>
                                <span style="color: #64748b;">ALT:</span> <span id="hudAlt" style="color: #00ff88; font-weight: bold;">FL320</span>
                                <span style="color: #64748b;">POS:</span> <span id="hudLatLon">-4.52, 136.88</span>
                                <span style="color: #64748b;">DIST:</span> <span id="hudDist">48.2 NM</span>
                                <span style="color: #64748b;">AZIM:</span> <span id="hudAzim">124.5°</span>
                                <span style="color: #64748b;">SPD:</span> <span id="hudSpd">360 kts</span>
                                <span style="color: #64748b;">HDG:</span> <span id="hudHdg">210°</span>
                            </div>
                        </div>

                        <!-- Sidebar Detail Target Pesawat Terpilih (Sisi Kanan) -->
                        <div id="radarTargetDetailSidebar">
                            <div class="radar-sidebar-header">
                                <div style="display: flex; align-items: center; gap: 8px;">
                                    <span id="sbTargetDirectionBadge" style="font-size: 10px; font-weight: 800; padding: 2px 6px; border-radius: 4px; background: rgba(56,189,248,0.2); color: #38bdf8;">📥 INBOUND</span>
                                    <span id="sbTargetCallsign" style="font-size: 15px; font-weight: 800; color: #00ffcc; letter-spacing: 0.5px;">—</span>
                                </div>
                                <button onclick="window.selectRadarTarget(null)" title="Tutup Detail" style="background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.2); color: #cbd5e1; font-size: 14px; cursor: pointer; padding: 2px 8px; border-radius: 4px;">✕</button>
                            </div>
                            <div class="radar-sidebar-body">
                                <!-- Status Target -->
                                <div class="radar-detail-group">
                                    <div style="font-size: 10px; font-weight: 700; color: #38bdf8; text-transform: uppercase; letter-spacing: 0.5px;">IDENTIFIKASI TRANSPONDER</div>
                                    <div class="radar-detail-row">
                                        <span class="radar-detail-lbl">Mode 3/A Squawk:</span>
                                        <span class="radar-detail-val" id="sbTargetSquawk" style="color: #ffcc00; font-size: 13px;">—</span>
                                    </div>
                                    <div class="radar-detail-row">
                                        <span class="radar-detail-lbl">ICAO 24-bit Address:</span>
                                        <span class="radar-detail-val" id="sbTargetAddress" style="color: #a78bfa;">—</span>
                                    </div>
                                    <div class="radar-detail-row">
                                        <span class="radar-detail-lbl">Integritas Sinyal:</span>
                                        <span class="radar-detail-val" id="sbTargetIntegrity" style="color: #00ff88;">Normal Single Plot</span>
                                    </div>
                                </div>

                                <!-- Posisi & Vektor Navigasi -->
                                <div class="radar-detail-group">
                                    <div style="font-size: 10px; font-weight: 700; color: #38bdf8; text-transform: uppercase; letter-spacing: 0.5px;">VEKTOR & KETINGGIAN</div>
                                    <div class="radar-detail-row">
                                        <span class="radar-detail-lbl">Flight Level (FL):</span>
                                        <span class="radar-detail-val" id="sbTargetFL" style="color: #38bdf8; font-size: 13px;">—</span>
                                    </div>
                                    <div class="radar-detail-row">
                                        <span class="radar-detail-lbl">Altitude:</span>
                                        <span class="radar-detail-val" id="sbTargetAlt">—</span>
                                    </div>
                                    <div class="radar-detail-row">
                                        <span class="radar-detail-lbl">Ground Speed:</span>
                                        <span class="radar-detail-val" id="sbTargetSpeed">—</span>
                                    </div>
                                    <div class="radar-detail-row">
                                        <span class="radar-detail-lbl">Heading (Arah):</span>
                                        <span class="radar-detail-val" id="sbTargetHeading">—</span>
                                    </div>
                                </div>

                                <!-- Jarak & Koordinat terhadap Radar -->
                                <div class="radar-detail-group">
                                    <div style="font-size: 10px; font-weight: 700; color: #38bdf8; text-transform: uppercase; letter-spacing: 0.5px;">POSISI DARI STASIUN RADAR</div>
                                    <div class="radar-detail-row">
                                        <span class="radar-detail-lbl">Jarak Slant/Ground:</span>
                                        <span class="radar-detail-val" id="sbTargetDistance" style="color: #00ffcc;">—</span>
                                    </div>
                                    <div class="radar-detail-row">
                                        <span class="radar-detail-lbl">Azimuth Sudut:</span>
                                        <span class="radar-detail-val" id="sbTargetAzimuth" style="color: #00ffcc;">—</span>
                                    </div>
                                    <div class="radar-detail-row">
                                        <span class="radar-detail-lbl">Koordinat WGS84:</span>
                                        <span class="radar-detail-val" id="sbTargetCoords" style="color: #f1f5f9; font-size: 10px;">—</span>
                                    </div>
                                    <div class="radar-detail-row">
                                        <span class="radar-detail-lbl">Stasiun Acuan:</span>
                                        <span class="radar-detail-val" id="sbTargetStationRef" style="color: #94a3b8;">—</span>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>

                    <!-- Sub-panel Target List -->
                    <div class="radar-targets-panel">
                        <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px;">
                            <div style="display: flex; align-items: center; gap: 10px;">
                                <span style="font-size: 10px; font-weight: 700; color: #64748b; letter-spacing: 0.5px; text-transform: uppercase;">
                                    <i class="fas fa-plane" style="color: #00ffcc;"></i> DAFTAR PESAWAT (CAT 048)
                                </span>
                                <!-- Filter Incoming / Outgoing -->
                                <div style="display: inline-flex; background: rgba(15, 28, 52, 0.9); border: 1px solid rgba(0, 212, 255, 0.25); border-radius: 4px; padding: 2px; gap: 2px;">
                                    <button id="btnTrafficAll" onclick="window.setRadarTrafficFilter('all')" class="radar-range-btn active" style="padding: 2px 8px; font-size: 10px;">Semua (<span id="countTrafficAll">0</span>)</button>
                                    <button id="btnTrafficInbound" onclick="window.setRadarTrafficFilter('inbound')" class="radar-range-btn" style="padding: 2px 8px; font-size: 10px; color: #38bdf8;">📥 Incoming (<span id="countTrafficIn">0</span>)</button>
                                    <button id="btnTrafficOutbound" onclick="window.setRadarTrafficFilter('outbound')" class="radar-range-btn" style="padding: 2px 8px; font-size: 10px; color: #f59e0b;">📤 Outgoing (<span id="countTrafficOut">0</span>)</button>
                                </div>
                                <span id="radarDoubleNotice" style="color: #ff5555; font-size: 10px; font-weight: 700; display: none;">TARGET BERTUMPUK / MERAH = GANDA (DUPLICATE)</span>
                            </div>
                            <span style="font-size: 10px; color: #475569;" id="radarLastCat048Text">Update: Real-time</span>
                        </div>
                        <div class="radar-targets-strip" id="radarTargetsStrip">
                            <span style="color: #475569; font-size: 11px; padding: 10px;">Menunggu deteksi target CAT 048...</span>
                        </div>
                    </div>
                </div>

                <!-- VIEW 2: AUDIT JANGKAUAN & TILT ANTENA -->
                <div id="radarAuditView" class="radar-audit-content" style="display: none;">
                    <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 14px;">
                        <div class="radar-audit-card">
                            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                                <span style="font-size: 11px; font-weight: 700; color: #94a3b8;">ALIGNMENT AZIMUTH (NORTH MARKER)</span>
                                <span class="radar-live-badge" id="auditBadgeAzim">NORMAL</span>
                            </div>
                            <div style="font-size: 24px; font-weight: 800; color: #00ff88; font-family: monospace;" id="auditValAzimDrift">+0.00°</div>
                            <div style="font-size: 11px; color: #64748b; margin-top: 4px;" id="auditTextAzimStatus">Alignment Stabil terhadap Acuan</div>
                        </div>

                        <div class="radar-audit-card">
                            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                                <span style="font-size: 11px; font-weight: 700; color: #94a3b8;">ESTIMASI TILT ANTENA</span>
                                <span class="radar-live-badge" id="auditBadgeTilt" style="color: #00d4ff; border-color: #00d4ff;">OPTIMAL</span>
                            </div>
                            <div style="font-size: 24px; font-weight: 800; color: #00d4ff; font-family: monospace;" id="auditValTilt">0.0°</div>
                            <div style="font-size: 11px; color: #64748b; margin-top: 4px;" id="auditTextTiltStatus">Elevasi Beam Sesuai Horizon</div>
                        </div>

                        <div class="radar-audit-card">
                            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                                <span style="font-size: 11px; font-weight: 700; color: #94a3b8;">TRANSPONDER ACUAN (REF-TXP)</span>
                                <span style="font-size: 10px; color: #ffaa00; font-weight: 700;">SITE MONITOR</span>
                            </div>
                            <div style="font-size: 14px; font-weight: 800; color: #e8f4ff; margin-bottom: 4px;" id="auditRefTargetId">REF-TXP</div>
                            <div style="font-size: 11px; color: #94a3b8; font-family: monospace;">
                                Azim: <span style="color: #00ffcc;" id="auditRefAzim">85.20°</span> | Dist: <span style="color: #00ffcc;" id="auditRefDist">12.45 NM</span>
                            </div>
                        </div>
                    </div>

                    <!-- Row 2: Diagram Mawar Jangkauan 16 Sektor -->
                    <div style="display: grid; grid-template-columns: 360px 1fr; gap: 14px;">
                        <div class="radar-audit-card" style="display: flex; flex-direction: column; align-items: center;">
                            <span style="font-size: 11px; font-weight: 700; color: #00d4ff; margin-bottom: 8px;">POLAR COVERAGE (16 SEKTOR AZIMUTH)</span>
                            <canvas id="radarCoverageCanvas" width="320" height="320"></canvas>
                        </div>

                        <div class="radar-audit-card" style="padding: 0; overflow: hidden; display: flex; flex-direction: column;">
                            <div style="padding: 10px 14px; background: rgba(15, 30, 58, 0.9); border-bottom: 1px solid rgba(0, 212, 255, 0.25); font-size: 11px; font-weight: 700; color: #00d4ff; display: flex; justify-content: space-between;">
                                <span><i class="fas fa-list-ol"></i> TABEL JANGKAUAN SEKTOR PROPAGASI</span>
                                <span style="color: #94a3b8; font-size: 10px;">Rata-rata: <strong id="auditAvgRange" style="color: #00ffcc;">—</strong></span>
                            </div>
                            <div style="flex: 1; max-height: 320px; overflow-y: auto;">
                                <table class="radar-audit-table">
                                    <thead>
                                        <tr>
                                            <th>Sektor</th>
                                            <th>Azimuth</th>
                                            <th>Jangkauan Max</th>
                                            <th>Target</th>
                                            <th>Status</th>
                                        </tr>
                                    </thead>
                                    <tbody id="radarSectorsTableBody">
                                        <tr><td colspan="5" style="text-align: center; color: #64748b; padding: 15px;">Memuat data audit...</td></tr>
                                    </tbody>
                                </table>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            <!-- MODAL: KALIBRASI TRANSPONDER REFERENSI -->
            <div id="radarRefModal" style="display: none; position: absolute; top: 0; left: 0; width: 100%; height: 100%; background: rgba(2, 6, 14, 0.35); z-index: 10000; align-items: center; justify-content: center; backdrop-filter: blur(1.5px);">
                <div style="background: rgba(9, 19, 34, 0.95); border: 1px solid #00d4ff; border-radius: 8px; width: 380px; max-width: 90%; padding: 20px; box-shadow: 0 10px 30px rgba(0, 212, 255, 0.4);">
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px; border-bottom: 1px solid rgba(0, 212, 255, 0.2); padding-bottom: 8px;">
                        <span style="font-weight: 700; color: #ffaa00; font-size: 13px;"><i class="fas fa-sliders-h"></i> Kalibrasi Transponder Referensi</span>
                        <button onclick="window.closeRefTxpConfigModal()" style="background: transparent; border: none; color: #94a3b8; font-size: 14px; cursor: pointer;"><i class="fas fa-times"></i></button>
                    </div>
                    <div style="display: flex; flex-direction: column; gap: 10px; font-size: 11px;">
                        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px;">
                            <div>
                                <label style="color: #94a3b8; display: block; margin-bottom: 4px;">Mode-3/A Squawk</label>
                                <input type="text" id="cfgRefSquawk" placeholder="7000" style="width: 100%; box-sizing: border-box; background: #0f1e36; border: 1px solid rgba(0, 212, 255, 0.4); border-radius: 4px; padding: 6px 10px; color: #ffcc00; font-family: monospace; font-weight: bold;">
                            </div>
                            <div>
                                <label style="color: #94a3b8; display: block; margin-bottom: 4px;">Mode-S 24-bit Addr</label>
                                <input type="text" id="cfgRefAddress" placeholder="8A0001" style="width: 100%; box-sizing: border-box; background: #0f1e36; border: 1px solid rgba(0, 212, 255, 0.4); border-radius: 4px; padding: 6px 10px; color: #00ffcc; font-family: monospace; font-weight: bold;">
                            </div>
                        </div>
                        <div>
                            <label style="color: #94a3b8; display: block; margin-bottom: 4px;">Callsign / Identifikasi Site</label>
                            <input type="text" id="cfgRefTargetId" placeholder="misal: REF-TXP" style="width: 100%; box-sizing: border-box; background: #0f1e36; border: 1px solid rgba(0, 212, 255, 0.4); border-radius: 4px; padding: 6px 10px; color: #fff; font-family: monospace;">
                        </div>
                        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px;">
                            <div>
                                <label style="color: #94a3b8; display: block; margin-bottom: 4px;">Nominal Azimuth (°)</label>
                                <input type="number" step="0.01" id="cfgRefAzimuth" placeholder="85.20" style="width: 100%; box-sizing: border-box; background: #0f1e36; border: 1px solid rgba(0, 212, 255, 0.4); border-radius: 4px; padding: 6px 10px; color: #00ffcc; font-family: monospace; font-weight: bold;">
                            </div>
                            <div>
                                <label style="color: #94a3b8; display: block; margin-bottom: 4px;">Nominal Range (NM)</label>
                                <input type="number" step="0.01" id="cfgRefRange" placeholder="12.45" style="width: 100%; box-sizing: border-box; background: #0f1e36; border: 1px solid rgba(0, 212, 255, 0.4); border-radius: 4px; padding: 6px 10px; color: #00ffcc; font-family: monospace; font-weight: bold;">
                            </div>
                        </div>
                    </div>
                    <div style="display: flex; justify-content: flex-end; gap: 8px; margin-top: 18px;">
                        <button onclick="window.closeRefTxpConfigModal()" style="padding: 6px 12px; background: rgba(255, 255, 255, 0.1); border: 1px solid rgba(255, 255, 255, 0.2); border-radius: 4px; color: #cbd5e1; font-size: 11px; cursor: pointer;">Batal</button>
                        <button onclick="window.saveRefTxpConfig()" style="padding: 6px 14px; background: #ffaa00; border: none; border-radius: 4px; color: #02060e; font-weight: 700; font-size: 11px; cursor: pointer;"><i class="fas fa-check"></i> Simpan Acuan</button>
                    </div>
                </div>
            </div>

            <!-- MODAL: AUDIT ANOMALI TARGET DOBEL & SARAN PERBAIKAN TEKNIS -->
            <div id="radarDuplicateAuditModal" style="display: none; position: absolute; top: 0; left: 0; width: 100%; height: 100%; background: rgba(2, 6, 14, 0.35); z-index: 10001; align-items: center; justify-content: center; backdrop-filter: blur(1.5px); padding: 20px; box-sizing: border-box;">
                <div style="background: rgba(9, 19, 34, 0.95); border: 1px solid #ef4444; border-radius: 10px; width: 850px; max-width: 95%; max-height: 88vh; display: flex; flex-direction: column; box-shadow: 0 15px 45px rgba(239, 68, 68, 0.4); overflow: hidden;">
                    <!-- Header Modal -->
                    <div style="padding: 14px 20px; background: rgba(239, 68, 68, 0.12); border-bottom: 1px solid rgba(239, 68, 68, 0.3); display: flex; justify-content: space-between; align-items: center;">
                        <div style="display: flex; align-items: center; gap: 10px;">
                            <i class="fas fa-microchip" style="color: #ef4444; font-size: 18px;"></i>
                            <div>
                                <span style="font-weight: 800; color: #fecaca; font-size: 14px; letter-spacing: 0.5px;">AUDIT TARGET DOBEL & ESTIMASI MASALAH RADAR</span>
                                <div style="font-size: 11px; color: #94a3b8; margin-top: 2px;">Analisis Ekstraktor Pulsa, Monopulse OBA, & Refleksi Multipath Sinyal MSSR</div>
                            </div>
                        </div>
                        <button onclick="window.closeRadarDuplicateAuditModal()" style="background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.2); color: #cbd5e1; font-size: 16px; cursor: pointer; padding: 4px 10px; border-radius: 6px;">✕</button>
                    </div>

                    <!-- Ringkasan Cepat / Quick Triage -->
                    <div style="padding: 12px 20px; background: rgba(15, 23, 42, 0.8); border-bottom: 1px solid rgba(255, 255, 255, 0.08); display: flex; gap: 20px; align-items: center; font-size: 11px; flex-wrap: wrap;">
                        <span style="color: #94a3b8;">Total Pasangan Duplikat: <strong id="modalDupTotalCount" style="color: #ef4444; font-size: 13px;">0</strong></span>
                        <span style="color: #94a3b8;">Status Ekstraktor RDP: <strong id="modalDupRdpStatus" style="color: #ffaa00;">Waspada Split</strong></span>
                        <span style="color: #94a3b8;">Saran Prioritas: <strong id="modalDupPriorityTip" style="color: #38bdf8;">Kalibrasi Kanal Monopulse / Tuning Split Window</strong></span>
                    </div>

                    <!-- Konten Scrollable: Daftar Kasus & Rekomendasi -->
                    <div style="flex: 1; overflow-y: auto; padding: 18px 20px; display: flex; flex-direction: column; gap: 14px;" id="radarDuplicateAuditList">
                        <!-- Disuntikkan secara dinamis -->
                    </div>

                    <!-- Footer Modal -->
                    <div style="padding: 12px 20px; background: rgba(10, 18, 32, 0.95); border-top: 1px solid rgba(255, 255, 255, 0.08); display: flex; justify-content: space-between; align-items: center; font-size: 11px;">
                        <span style="color: #64748b;">Ref Standard: ICAO Annex 10 Vol IV & Eurocontrol ASTERIX Part 9 (CAT 048)</span>
                        <button onclick="window.closeRadarDuplicateAuditModal()" style="padding: 6px 16px; background: #ef4444; border: none; border-radius: 6px; color: #fff; font-weight: 700; font-size: 11px; cursor: pointer;">Tutup Diagnosa</button>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(sidebar);

        // Attach mouse & touch events to canvas (Termasuk Cubit / Pinch Zoom dan Scroll Wheel Zoom)
        const canvas = document.getElementById('radarPpiCanvas');
        if (canvas) {
            canvas.addEventListener('mousemove', e => {
                const rect = canvas.getBoundingClientRect();
                _radarMousePos.x = e.clientX - rect.left;
                _radarMousePos.y = e.clientY - rect.top;
            });
            canvas.addEventListener('mouseleave', () => {
                _radarMousePos.x = -999;
                _radarMousePos.y = -999;
                const hud = document.getElementById('radarHoverHud');
                if (hud) hud.style.display = 'none';
            });
            canvas.addEventListener('click', e => {
                if (_hasDraggedMap) {
                    _hasDraggedMap = false;
                    return;
                }

                // Jika sedang dalam Mode Ukur Jarak (EBRL / Ruler)
                if (_isRulerMode) {
                    const rect = canvas.getBoundingClientRect();
                    const clickX = e.clientX - rect.left;
                    const clickY = e.clientY - rect.top;

                    // Tentukan koordinat lat/lon dari titik klik
                    let ptLat = null, ptLon = null, ptLabel = '';
                    if (_radarHoveredTarget) {
                        ptLat = parseFloat(_radarHoveredTarget.lat);
                        ptLon = parseFloat(_radarHoveredTarget.lon);
                        ptLabel = _radarHoveredTarget.callsign || _radarHoveredTarget.id;
                    } else if (_radarMap) {
                        try {
                            const latLng = _radarMap.containerPointToLatLng([clickX, clickY]);
                            ptLat = latLng.lat;
                            ptLon = latLng.lng;
                            ptLabel = `${ptLat.toFixed(2)}, ${ptLon.toFixed(2)}`;
                        } catch (err) {}
                    }

                    if (!_rulerPointA) {
                        _rulerPointA = {
                            x: clickX,
                            y: clickY,
                            lat: ptLat,
                            lon: ptLon,
                            label: ptLabel || 'Titik A'
                        };
                        _rulerPointB = null;
                        const stateText = document.getElementById('radarRulerStateText');
                        if (stateText) {
                            stateText.textContent = `Titik 1: ${_rulerPointA.label} (Klik Titik 2)`;
                            stateText.style.color = '#ffcc00';
                        }
                    } else if (!_rulerPointB) {
                        _rulerPointB = {
                            x: clickX,
                            y: clickY,
                            lat: ptLat,
                            lon: ptLon,
                            label: ptLabel || 'Titik B'
                        };
                        const stateText = document.getElementById('radarRulerStateText');
                        if (stateText) {
                            stateText.textContent = 'SELESAI (Klik lagi untuk ukur baru)';
                            stateText.style.color = '#00ff88';
                        }
                    } else {
                        // Jika sudah ada A dan B, klik berikutnya mereset ke Titik 1 baru
                        _rulerPointA = {
                            x: clickX,
                            y: clickY,
                            lat: ptLat,
                            lon: ptLon,
                            label: ptLabel || 'Titik A'
                        };
                        _rulerPointB = null;
                        const stateText = document.getElementById('radarRulerStateText');
                        if (stateText) {
                            stateText.textContent = `Titik 1: ${_rulerPointA.label} (Klik Titik 2)`;
                            stateText.style.color = '#ffcc00';
                        }
                    }
                    drawRadarPPI();
                    return;
                }

                if (_radarHoveredTarget) {
                    _radarSelectedTargetId = _radarHoveredTarget.id;
                    updateRadarPpiTargetsUI();
                } else {
                    _radarSelectedTargetId = null;
                    updateRadarPpiTargetsUI();
                }
            });

            // Keyboard shortcut untuk alat ukur jarak (M / D / Escape)
            window.addEventListener('keydown', e => {
                if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
                const overlay = document.getElementById('radarPpiOverlay');
                if (!overlay || overlay.style.display !== 'block') return;

                if (e.key === 'm' || e.key === 'M' || e.key === 'd' || e.key === 'D') {
                    e.preventDefault();
                    window.toggleRadarRuler();
                } else if (e.key === 'Escape') {
                    if (_rulerPointA || _rulerPointB) {
                        window.clearRadarRuler();
                    } else if (_isRulerMode) {
                        window.toggleRadarRuler();
                    }
                }
            });

            // 1. Mouse Wheel Zoom (Scroll Wheel / Trackpad Pinch Gesture pada Mac)
            canvas.addEventListener('wheel', e => {
                e.preventDefault();
                // Pada Mac Trackpad, gesture cubit (pinch to zoom) mengirim event wheel dengan e.ctrlKey = true
                if (e.ctrlKey) {
                    // Smooth continuous pinch zoom (pertahankan posisi center pan terakhir: autoRecenter = false)
                    const factor = e.deltaY < 0 ? 0.94 : 1.06;
                    let targetRange = Math.round(_radarRangeNm * factor);
                    targetRange = Math.max(15, Math.min(300, targetRange));
                    window.setRadarPpiRange(targetRange, false);
                    return;
                }

                // Scroll wheel biasa (discrete steps, pertahankan posisi pan: autoRecenter = false)
                const delta = e.deltaY;
                const ranges = [20, 40, 60, 80, 100, 120, 160, 200, 250];
                let currentIdx = ranges.findIndex(r => r >= _radarRangeNm);
                if (currentIdx === -1) currentIdx = ranges.length - 1;

                if (delta > 0) {
                    // Zoom Out (Range bertambah)
                    if (currentIdx < ranges.length - 1) {
                        window.setRadarPpiRange(ranges[currentIdx + 1], false);
                    }
                } else if (delta < 0) {
                    // Zoom In (Range berkurang)
                    if (currentIdx > 0) {
                        window.setRadarPpiRange(ranges[currentIdx - 1], false);
                    }
                }
            }, { passive: false });

            // 2. Drag / Pan Map Menggunakan Shift + Drag Mouse / Trackpad
            let _isDraggingMap = false;
            let _dragStartPos = { x: 0, y: 0 };
            let _hasDraggedMap = false;

            canvas.addEventListener('mousedown', e => {
                // Bisa geser maps dengan menahan tombol Shift + drag mouse, atau klik tombol tengah
                if (e.shiftKey || e.button === 1) {
                    _isDraggingMap = true;
                    _hasDraggedMap = false;
                    _dragStartPos = { x: e.clientX, y: e.clientY };
                    canvas.style.cursor = 'grab';
                }
            });

            window.addEventListener('mousemove', e => {
                if (_isDraggingMap && _radarMap) {
                    const dx = e.clientX - _dragStartPos.x;
                    const dy = e.clientY - _dragStartPos.y;
                    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) {
                        _hasDraggedMap = true;
                        canvas.style.cursor = 'grabbing';
                        _radarMap.panBy([-dx, -dy], { animate: false });
                        _dragStartPos = { x: e.clientX, y: e.clientY };
                    }
                }
            });

            window.addEventListener('mouseup', () => {
                if (_isDraggingMap) {
                    _isDraggingMap = false;
                    canvas.style.cursor = 'default';
                }
            });

            // 3. Touch Events: Cubit / Pinch to Zoom (Dua jari di layar sentuh / trackpad)
            let _initialPinchDist = null;
            let _initialRangeNm = _radarRangeNm;

            canvas.addEventListener('touchstart', e => {
                if (e.touches.length === 2) {
                    e.preventDefault();
                    const dx = e.touches[0].clientX - e.touches[1].clientX;
                    const dy = e.touches[0].clientY - e.touches[1].clientY;
                    _initialPinchDist = Math.hypot(dx, dy);
                    _initialRangeNm = _radarRangeNm;
                } else if (e.touches.length === 1) {
                    _isDraggingMap = true;
                    _dragStartPos = { x: e.touches[0].clientX, y: e.touches[0].clientY };
                    const rect = canvas.getBoundingClientRect();
                    _radarMousePos.x = e.touches[0].clientX - rect.left;
                    _radarMousePos.y = e.touches[0].clientY - rect.top;
                }
            }, { passive: false });

            canvas.addEventListener('touchmove', e => {
                if (e.touches.length === 2 && _initialPinchDist) {
                    e.preventDefault();
                    const dx = e.touches[0].clientX - e.touches[1].clientX;
                    const dy = e.touches[0].clientY - e.touches[1].clientY;
                    const currentDist = Math.hypot(dx, dy);
                    const scale = currentDist / _initialPinchDist;

                    // Buka cubitan (scale > 1) -> Zoom In (jarak NM mengecil, pertahankan posisi pan: autoRecenter = false)
                    // Rapatkan cubitan (scale < 1) -> Zoom Out (jarak NM membesar, pertahankan posisi pan: autoRecenter = false)
                    let newRange = Math.round(_initialRangeNm / scale);
                    newRange = Math.max(15, Math.min(300, newRange));
                    window.setRadarPpiRange(newRange, false);
                } else if (e.touches.length === 1 && _isDraggingMap && _radarMap) {
                    const dx = e.touches[0].clientX - _dragStartPos.x;
                    const dy = e.touches[0].clientY - _dragStartPos.y;
                    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
                        _radarMap.panBy([-dx, -dy], { animate: false });
                        _dragStartPos = { x: e.touches[0].clientX, y: e.touches[0].clientY };
                    }
                    const rect = canvas.getBoundingClientRect();
                    _radarMousePos.x = e.touches[0].clientX - rect.left;
                    _radarMousePos.y = e.touches[0].clientY - rect.top;
                }
            }, { passive: false });

            canvas.addEventListener('touchend', e => {
                if (e.touches.length < 2) {
                    _initialPinchDist = null;
                }
                if (e.touches.length === 0) {
                    _isDraggingMap = false;
                }
            });
        }

        window.addEventListener('resize', () => {
            if (document.getElementById('radarPpiSidebar')?.classList.contains('open')) {
                resizeRadarCanvas();
            }
        });
    }

    // ── LEAFLET MAP CONTROLLER UNTUK PPI ──────────────────────────────────────
    function getTileLayerUrl(theme) {
        if (theme === 'dark') {
            return 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager_labels_under/{z}/{x}/{y}.png';
        }
        // Mode Terang: OpenStreetMap Standard (Gratis 100%, tanpa API key watermark, jernih & detail)
        return 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
    }

    function initOrUpdateRadarMap(lat, lon, rangeNm, forceCenter = false) {
        if (typeof L === 'undefined') return;
        const container = document.getElementById('radarMapUnderlay');
        if (!container) return;

        let pLat = parseFloat(lat);
        let pLon = parseFloat(lon);
        if (isNaN(pLat) || isNaN(pLon) || (Math.abs(pLat) < 0.0001 && Math.abs(pLon) < 0.0001)) {
            const st = resolveRadarStationCoords(getActiveRadarSourceData());
            pLat = st.lat;
            pLon = st.lon;
        }
        _lastRadarCoords = { lat: pLat, lon: pLon };

        // Konversi range (NM) ke Leaflet Zoom level yang proporsional dengan viewport PPI Scope
        // 1 NM ~ 1.852 km. Pada ketinggian layar ~600-900px, jangkauan 200 NM (~370 km radius = 740 km diameter)
        // membutuhkan Zoom 7 agar muat secara proporsional dan tidak melebar ke seluruh pulau.
        let zoom = 7;
        if (rangeNm <= 30) zoom = 10;
        else if (rangeNm <= 60) zoom = 9;
        else if (rangeNm <= 110) zoom = 8;
        else if (rangeNm <= 220) zoom = 7;
        else zoom = 6;

        if (!_radarMap) {
            _radarMap = L.map('radarMapUnderlay', {
                center: [_lastRadarCoords.lat, _lastRadarCoords.lon],
                zoom: zoom,
                zoomControl: false,
                attributionControl: false,
                dragging: true,
                scrollWheelZoom: false,
                doubleClickZoom: false,
                boxZoom: false,
                keyboard: false
            });

            _radarTileLayer = L.tileLayer(getTileLayerUrl(_mapTheme), {
                subdomains: ['a', 'b', 'c'],
                maxZoom: 19
            }).addTo(_radarMap);

            // Re-render target saat peta digeser
            _radarMap.on('move', () => {
                if (typeof drawRadarPPI === 'function') drawRadarPPI();
            });
            _radarMap.on('moveend', () => {
                if (typeof drawRadarPPI === 'function') drawRadarPPI();
            });
        } else {
            // Jika forceCenter aktif (misal saat klik tombol Range), reset peta tepat ke center stasiun radar!
            if (forceCenter) {
                _radarMap.setView([_lastRadarCoords.lat, _lastRadarCoords.lon], zoom, { animate: true });
            } else if (rangeNm) {
                _radarMap.setZoom(zoom, { animate: false });
            }
            _radarMap.invalidateSize();
        }

        container.style.opacity = '0.90';
    }

    window.toggleRadarMap = function () {
        _isMapEnabled = !_isMapEnabled;
        const stateText = document.getElementById('radarMapStateText');
        const container = document.getElementById('radarMapUnderlay');
        if (stateText) stateText.textContent = _isMapEnabled ? 'AKTIF' : 'NONAKTIF';
        if (container) container.style.opacity = _isMapEnabled ? '0.88' : '0.0';
    };

    window.toggleRadarMapTheme = function () {
        _mapTheme = _mapTheme === 'light' ? 'dark' : 'light';
        const themeText = document.getElementById('radarMapThemeText');
        if (themeText) themeText.textContent = _mapTheme === 'light' ? 'TERANG' : 'GELAP';
        if (_radarMap && _radarTileLayer) {
            _radarMap.removeLayer(_radarTileLayer);
            _radarTileLayer = L.tileLayer(getTileLayerUrl(_mapTheme), {
                subdomains: ['a', 'b', 'c'],
                maxZoom: 19
            }).addTo(_radarMap);
        }
    };

    window.toggleRadarIslsFilter = function () {
        _isIslsFilterEnabled = !_isIslsFilterEnabled;
        const btn = document.getElementById('radarToggleIslsBtn');
        const stateText = document.getElementById('radarIslsStateText');

        if (_isIslsFilterEnabled) {
            if (btn) {
                btn.style.borderColor = '#00ff88';
                btn.style.color = '#00ff88';
                btn.style.background = 'rgba(0, 255, 136, 0.15)';
                btn.style.boxShadow = '0 0 10px rgba(0, 255, 136, 0.3)';
            }
            if (stateText) {
                stateText.textContent = 'AKTIF (Filter Suppressed)';
                stateText.style.color = '#00ff88';
            }
        } else {
            if (btn) {
                btn.style.borderColor = 'rgba(148, 163, 184, 0.4)';
                btn.style.color = '#94a3b8';
                btn.style.background = 'rgba(15, 30, 58, 0.6)';
                btn.style.boxShadow = 'none';
            }
            if (stateText) {
                stateText.textContent = 'NONAKTIF';
                stateText.style.color = '#cbd5e1';
            }
        }

        updateRadarPpiTargetsUI();
        drawRadarPPI();
    };

    window.toggleRadarRuler = function () {
        _isRulerMode = !_isRulerMode;
        const btn = document.getElementById('radarRulerBtn');
        const stateText = document.getElementById('radarRulerStateText');

        if (_isRulerMode) {
            _rulerPointA = null;
            _rulerPointB = null;
            if (btn) {
                btn.style.borderColor = '#00f0ff';
                btn.style.color = '#00f0ff';
                btn.style.background = 'rgba(0, 240, 255, 0.2)';
                btn.style.boxShadow = '0 0 12px rgba(0, 240, 255, 0.4)';
            }
            if (stateText) {
                stateText.textContent = 'AKTIF (Klik Titik 1)';
                stateText.style.color = '#00f0ff';
            }
            const canvas = document.getElementById('radarPpiCanvas');
            if (canvas) canvas.style.cursor = 'crosshair';
        } else {
            _rulerPointA = null;
            _rulerPointB = null;
            if (btn) {
                btn.style.borderColor = 'rgba(56, 189, 248, 0.4)';
                btn.style.color = '#38bdf8';
                btn.style.background = 'rgba(15, 30, 58, 0.6)';
                btn.style.boxShadow = 'none';
            }
            if (stateText) {
                stateText.textContent = 'OFF';
                stateText.style.color = '#cbd5e1';
            }
            const canvas = document.getElementById('radarPpiCanvas');
            if (canvas) canvas.style.cursor = 'default';
        }
        drawRadarPPI();
    };

    window.clearRadarRuler = function () {
        _rulerPointA = null;
        _rulerPointB = null;
        const stateText = document.getElementById('radarRulerStateText');
        if (stateText && _isRulerMode) {
            stateText.textContent = 'AKTIF (Klik Titik 1)';
            stateText.style.color = '#00f0ff';
        }
        drawRadarPPI();
    };

    function resizeRadarCanvas() {
        const container = document.getElementById('radarCanvasContainer');
        const canvas = document.getElementById('radarPpiCanvas');
        if (!container || !canvas) return;

        const w = container.clientWidth;
        const h = container.clientHeight;
        const dpr = window.devicePixelRatio || 1;

        canvas.width = w * dpr;
        canvas.height = h * dpr;
        canvas.style.width = `${w}px`;
        canvas.style.height = `${h}px`;

        const ctx = canvas.getContext('2d');
        ctx.scale(dpr, dpr);

        if (_radarMap) {
            _radarMap.invalidateSize();
        }
    }

    // ── DATA ACCESS HELPERS ────────────────────────────────────────────────────
    function findRadarSourceAndData(sourceId) {
        let src = null;
        let data = null;

        // 1. Cek dari window._sourcesCache jika sourceId cocok
        if (window._sourcesCache) {
            for (const pool of Object.values(window._sourcesCache)) {
                if (!Array.isArray(pool)) continue;
                if (sourceId) {
                    const found = pool.find(s => String(s.id) === String(sourceId));
                    if (found) {
                        src = found;
                        const payload = typeof window.getSourceDetailPayload === 'function' 
                            ? window.getSourceDetailPayload(found) 
                            : (found.payload || found);
                        data = payload.latestData || payload.data || null;
                        break;
                    }
                }
                // Jika sourceId null/belum ketemu, cari yang parsing_id-nya radar/adsb
                if (!src) {
                    const radarCandidate = pool.find(s => s.parsing_id === 'asterix_radar' || s.parsing_id === 'asterix_adsb');
                    if (radarCandidate) {
                        src = radarCandidate;
                        const payload = typeof window.getSourceDetailPayload === 'function' 
                            ? window.getSourceDetailPayload(radarCandidate) 
                            : (radarCandidate.payload || radarCandidate);
                        data = payload.latestData || payload.data || null;
                    }
                }
            }
        }

        // 2. Cek dari window.equipmentDataCache
        if ((!data || !data.targets_detail) && Array.isArray(window.equipmentDataCache)) {
            for (const eq of window.equipmentDataCache) {
                if (!eq) continue;
                // Cek apakah eq memiliki source yang cocok
                if (Array.isArray(eq.sources)) {
                    const matchSrc = sourceId 
                        ? eq.sources.find(s => String(s.id) === String(sourceId))
                        : eq.sources.find(s => s.parsing_id === 'asterix_radar' || s.parsing_id === 'asterix_adsb');
                    if (matchSrc) {
                        if (!src) src = matchSrc;
                        if (typeof window.resolveSourceData === 'function') {
                            const resData = window.resolveSourceData(eq, matchSrc);
                            if (resData) data = resData;
                        }
                    }
                }
                // Cek langsung di lastData
                if (eq.lastData && typeof eq.lastData === 'object') {
                    for (const [key, val] of Object.entries(eq.lastData)) {
                        if (val && (val.targets_detail || val.targets_list || val.radar_name || val.sac)) {
                            if (!src) src = { id: sourceId || eq.id, name: key, equipt_id: eq.id, parsing_id: 'asterix_radar' };
                            if (!data || (val.targets_detail && (!data.targets_detail || val.targets_detail.length > 0))) {
                                data = val;
                            }
                        }
                    }
                }
            }
        }

        // 3. Cek dari window._activeSourceDetail
        if ((!data || !data.targets_detail) && window._activeSourceDetail) {
            const activeSrc = window._activeSourceDetail;
            if (!src) src = activeSrc;
            const payload = typeof window.getSourceDetailPayload === 'function'
                ? window.getSourceDetailPayload(activeSrc)
                : (activeSrc.payload || activeSrc);
            if (payload && (payload.latestData || payload.data)) {
                data = payload.latestData || payload.data;
            }
        }

        return { src, data };
    }

    function getActiveRadarSourceData() {
        const { data } = findRadarSourceAndData(_activeRadarSourceId);
        return data || null;
    }

    function getSavedRefTxpConfig(sourceId = null) {
        const srcId = sourceId || _activeRadarSourceId || 'default';
        const defaultCfg = {
            targetId: 'REF-TXP',
            squawk: '7000',
            address: '8A0001',
            azimuth: 85.20,
            range: 12.45
        };
        try {
            let raw = localStorage.getItem(`radar_ref_txp_config_${srcId}`) || localStorage.getItem('radar_ref_txp_config');
            if (raw) {
                const parsed = JSON.parse(raw);
                return {
                    targetId: parsed.targetId || defaultCfg.targetId,
                    squawk: parsed.squawk || defaultCfg.squawk,
                    address: (parsed.address || defaultCfg.address).toUpperCase(),
                    azimuth: parseFloat(parsed.azimuth) || defaultCfg.azimuth,
                    range: parseFloat(parsed.range) || defaultCfg.range
                };
            }
        } catch (e) { }
        return defaultCfg;
    }

    // ── PUBLIC SCOPE CONTROLLER ────────────────────────────────────────────────
    window.openRadarPpiScope = function (sourceId) {
        ensureRadarPpiDOMElements();

        if (!sourceId && window._activeSourceDetail) {
            sourceId = window._activeSourceDetail.id;
        }
        if (!sourceId) {
            const resolved = findRadarSourceAndData(null);
            if (resolved.src) sourceId = resolved.src.id;
        }
        _activeRadarSourceId = sourceId;

        const overlay = document.getElementById('radarPpiOverlay');
        const sidebar = document.getElementById('radarPpiSidebar');
        if (overlay) overlay.style.display = 'block';
        if (sidebar) sidebar.classList.add('open');

        setTimeout(() => {
            resizeRadarCanvas();
            const data = getActiveRadarSourceData() || {};
            initOrUpdateRadarMap(data.lat, data.lon, _radarRangeNm);
        }, 50);

        // Start requestAnimationFrame sweep loop
        if (!_radarAnimId) {
            let lastTimestamp = performance.now();
            function renderLoop(now) {
                const dt = (now - lastTimestamp) / 1000.0;
                lastTimestamp = now;

                let rotSec = 3.96;
                const srcData = getActiveRadarSourceData();
                if (srcData && srcData.antenna_rotation && srcData.antenna_rotation !== '—') {
                    const parsed = parseFloat(srcData.antenna_rotation);
                    if (!isNaN(parsed) && parsed > 0) rotSec = parsed;
                }
                const degPerSec = 360.0 / Math.max(1.5, rotSec);
                _radarSweepAngleDeg = (_radarSweepAngleDeg + degPerSec * dt) % 360.0;

                drawRadarPPI();
                _radarAnimId = requestAnimationFrame(renderLoop);
            }
            _radarAnimId = requestAnimationFrame(renderLoop);
        }

        updateRadarPpiScopeData();
        if (_radarRefreshTimer) clearInterval(_radarRefreshTimer);
        _radarRefreshTimer = setInterval(updateRadarPpiScopeData, 1500);

        // Fetch equipment data secara langsung untuk menyegarkan cache
        const { src } = findRadarSourceAndData(_activeRadarSourceId);
        if (src && src.equipt_id) {
            fetch(`/api/equipment/${src.equipt_id}`, { headers: window.getAuthHeaders ? window.getAuthHeaders() : {} })
                .then(r => r.ok ? r.json() : null)
                .then(eqData => {
                    if (eqData && typeof window.updateEquipmentCacheEntry === 'function') {
                        window.updateEquipmentCacheEntry(eqData);
                    }
                    updateRadarPpiScopeData();
                }).catch(() => { });
        }
    };

    window.closeRadarPpiScope = function () {
        const overlay = document.getElementById('radarPpiOverlay');
        const sidebar = document.getElementById('radarPpiSidebar');
        if (overlay) overlay.style.display = 'none';
        if (sidebar) sidebar.classList.remove('open');

        if (_radarAnimId) {
            cancelAnimationFrame(_radarAnimId);
            _radarAnimId = null;
        }
        if (_radarRefreshTimer) {
            clearInterval(_radarRefreshTimer);
            _radarRefreshTimer = null;
        }
        _activeRadarSourceId = null;
        _radarHoveredTarget = null;
        _radarSelectedTargetId = null;
    };

    window.setRadarPpiRange = function (rangeNm, autoRecenter = true) {
        _radarRangeNm = rangeNm;
        document.querySelectorAll('.radar-range-btn').forEach(btn => {
            if (btn.textContent.includes(`${rangeNm} NM`)) {
                btn.classList.add('active');
            } else {
                btn.classList.remove('active');
            }
        });
        const data = getActiveRadarSourceData() || {};
        // autoRecenter: true saat tombol Range diklik (kembali ke tengah radar), false saat scroll/pinch gesture (tetap di posisi pan terakhir)
        initOrUpdateRadarMap(data.lat, data.lon, _radarRangeNm, autoRecenter);
    };

    function updateRadarPpiScopeData() {
        const { src, data } = findRadarSourceAndData(_activeRadarSourceId);
        if (!data) return;

        // Pastikan Map Leaflet selalu tersinkronisasi ke stasiun radar yang tepat
        if (!_radarMap || (data.lat && Math.abs(parseFloat(data.lat)) > 0.0001) || (data.sac && data.sic)) {
            initOrUpdateRadarMap(data.lat, data.lon, _radarRangeNm);
        }

        // Update Title & Header Widgets
        const titleEl = document.getElementById('radarStationTitle');
        if (titleEl) titleEl.textContent = `RADAR PPI — ${(src && src.name) || data.radar_name || 'MSSR'}`;

        const subEl = document.getElementById('radarStationSub');
        if (subEl) {
            subEl.textContent = `SAC: ${data.sac || '—'} | SIC: ${data.sic || '—'} | RADAR ID: ${data.radar_id || '—'}`;
        }

        const rotEl = document.getElementById('radarMetricRot');
        if (rotEl) rotEl.textContent = data.antenna_rotation && data.antenna_rotation !== '—' ? `${data.antenna_rotation}` : '3.96s';

        const rpmEl = document.getElementById('radarMetricRpm');
        if (rpmEl) rpmEl.textContent = data.antenna_rpm ? `(${data.antenna_rpm})` : '(15.2 RPM)';

        const pwrEl = document.getElementById('radarMetricPower');
        if (pwrEl) {
            pwrEl.textContent = data.power_status || 'Normal (18.5 kW)';
            if (String(data.power_status || '').toLowerCase().includes('off') || String(data.power_status || '').toLowerCase().includes('degraded')) {
                pwrEl.style.color = '#ff3355';
            } else {
                pwrEl.style.color = '#00ff88';
            }
        }

        updateRadarPpiTargetsUI(data);
        updateRadarAuditUI(data);
    }

    function updateRadarPpiTargetsUI(passedData) {
        const data = passedData || getActiveRadarSourceData() || {};
        let targets = Array.isArray(data.targets_detail) ? data.targets_detail : [];
        const rawDoubleMap = detectDuplicateTargets(targets);
        const report = Array.isArray(_lastDuplicateAuditReport) ? _lastDuplicateAuditReport : [];

        // Himpunan ID target sekunder/hantu (Target B) yang ditekan jika filter ISLS diaktifkan
        const islsSuppressedIds = new Set();
        if (_isIslsFilterEnabled && report.length > 0) {
            report.forEach(r => {
                if (r.targetB && r.targetB.id) {
                    islsSuppressedIds.add(String(r.targetB.id));
                }
            });
        }

        const visibleTargets = _isIslsFilterEnabled 
            ? targets.filter(t => !islsSuppressedIds.has(String(t.id)))
            : targets;

        const effectiveDoubleMap = _isIslsFilterEnabled ? new Map() : rawDoubleMap;
        const anomalousPlaneCount = _isIslsFilterEnabled ? 0 : report.length;

        const badge = document.getElementById('radarTargetCountBadge');
        if (badge) {
            if (_isIslsFilterEnabled && islsSuppressedIds.size > 0) {
                badge.innerHTML = `<strong style="color: #00ffcc;">${visibleTargets.length}</strong> Pesawat Terdeteksi <span style="font-size: 10px; color: #00ff88; margin-left: 4px;">(${islsSuppressedIds.size} Echo Ditekan ISLS)</span>`;
            } else {
                badge.innerHTML = `<strong style="color: #00ffcc;">${visibleTargets.length}</strong> Pesawat Terdeteksi`;
            }
        }

        const doubleBadge = document.getElementById('radarDoubleSummaryBadge');
        const doubleText = document.getElementById('radarDoubleCountText');
        const doubleNotice = document.getElementById('radarDoubleNotice');
        if (doubleBadge && doubleText) {
            if (anomalousPlaneCount > 0) {
                doubleBadge.style.display = 'inline-flex';
                doubleBadge.style.background = 'rgba(239, 68, 68, 0.2)';
                doubleBadge.style.borderColor = '#ef4444';
                doubleBadge.style.color = '#ff5555';
                doubleText.textContent = `${anomalousPlaneCount} Pesawat Terduplikasi (Split/Echo)`;
                if (doubleNotice) {
                    doubleNotice.style.display = 'inline';
                    doubleNotice.textContent = 'TARGET BERTUMPUK / MERAH = GANDA (DUPLICATE)';
                    doubleNotice.style.color = '#ff5555';
                }
            } else if (_isIslsFilterEnabled && report.length > 0) {
                // Tampilkan info bahwa ISLS sedang menekan target ganda tersebut
                doubleBadge.style.display = 'inline-flex';
                doubleBadge.style.background = 'rgba(0, 255, 136, 0.15)';
                doubleBadge.style.borderColor = '#00ff88';
                doubleBadge.style.color = '#00ff88';
                doubleText.textContent = `ISLS Aktif: ${report.length} Echo Ditekan (Single Plot)`;
                if (doubleNotice) {
                    doubleNotice.style.display = 'inline';
                    doubleNotice.textContent = 'FILTER ISLS AKTIF: GHOST ECHO & SECONDARY PULSE DITEKAN';
                    doubleNotice.style.color = '#00ff88';
                }
            } else {
                doubleBadge.style.display = 'none';
                if (doubleNotice) doubleNotice.style.display = 'none';
            }
        }

        const lastCatEl = document.getElementById('radarLastCat048Text');
        if (lastCatEl) {
            lastCatEl.textContent = `Update: ${data.last_cat048 ? new Date(data.last_cat048).toLocaleTimeString('id-ID') : 'Real-time'}`;
        }

        // 0. Update koordinat dan simpan histori sebelum kalkulasi arah agar deterministik
        visibleTargets.forEach(t => {
            const range = Number(t.range_nm) || 0;
            const azim = Number(t.azimuth_deg) || 0;
            let tgtLat = parseFloat(t.lat);
            let tgtLon = parseFloat(t.lon);
            if (isNaN(tgtLat) || isNaN(tgtLon) || (Math.abs(tgtLat) < 0.0001 && Math.abs(tgtLon) < 0.0001)) {
                const geo = calculatePolarToLatLon(_lastRadarCoords.lat, _lastRadarCoords.lon, range, azim);
                tgtLat = geo.lat;
                tgtLon = geo.lon;
                t.lat = tgtLat;
                t.lon = tgtLon;
            }
            if (t.id && !_targetHistoryMap.has(String(t.id))) {
                _targetHistoryMap.set(String(t.id), {
                    range: range,
                    azim: azim,
                    lat: tgtLat,
                    lon: tgtLon,
                    time: Date.now()
                });
            }
        });

        // Hitung pembagian arah lalu lintas: Incoming vs Outgoing
        let inCount = 0;
        let outCount = 0;
        visibleTargets.forEach(t => {
            const dir = getTargetTrafficDirection(t, _lastRadarCoords.lat, _lastRadarCoords.lon);
            if (dir === 'inbound') inCount++;
            else outCount++;
        });

        const cntAll = document.getElementById('countTrafficAll');
        const cntIn = document.getElementById('countTrafficIn');
        const cntOut = document.getElementById('countTrafficOut');
        if (cntAll) cntAll.textContent = visibleTargets.length;
        if (cntIn) cntIn.textContent = inCount;
        if (cntOut) cntOut.textContent = outCount;

        // Terapkan filter jika user memilih Incoming atau Outgoing
        const filteredTargets = visibleTargets.filter(t => {
            if (_radarTargetTrafficFilter === 'all') return true;
            const dir = getTargetTrafficDirection(t, _lastRadarCoords.lat, _lastRadarCoords.lon);
            return dir === _radarTargetTrafficFilter;
        });

        const strip = document.getElementById('radarTargetsStrip');
        if (!strip) return;

        if (filteredTargets.length === 0) {
            strip.innerHTML = `<span style="color: #475569; font-size: 11px; padding: 10px;">Tidak ada target pada kategori ${(_radarTargetTrafficFilter === 'inbound' ? 'INCOMING' : (_radarTargetTrafficFilter === 'outbound' ? 'OUTGOING' : 'terpilih'))}.</span>`;
            return;
        }

        strip.innerHTML = filteredTargets.map(t => {
            const isSel = String(t.id) === String(_radarSelectedTargetId);
            const isDouble = effectiveDoubleMap.get(String(t.id)) === true;
            const dir = getTargetTrafficDirection(t, _lastRadarCoords.lat, _lastRadarCoords.lon);
            const isInbound = dir === 'inbound';
            let cLat = parseFloat(t.lat);
            let cLon = parseFloat(t.lon);
            if (isNaN(cLat) || isNaN(cLon) || (Math.abs(cLat) < 0.0001 && Math.abs(cLon) < 0.0001)) {
                const geo = calculatePolarToLatLon(_lastRadarCoords.lat, _lastRadarCoords.lon, t.range_nm || 0, t.azimuth_deg || 0);
                cLat = geo.lat;
                cLon = geo.lon;
            }
            return `
                <div class="radar-target-card ${isSel ? 'highlight' : ''} ${isDouble ? 'is-double' : ''}" onclick="window.selectRadarTarget('${t.id}')" style="border-left: 3px solid ${isInbound ? '#38bdf8' : '#f59e0b'};">
                    <div class="tgt-id">
                        <span style="display: flex; align-items: center; gap: 4px;">
                            <span style="font-size: 8px; font-weight: 800; padding: 1px 4px; border-radius: 3px; background: ${isInbound ? 'rgba(56, 189, 248, 0.2)' : 'rgba(245, 158, 11, 0.2)'}; color: ${isInbound ? '#38bdf8' : '#f59e0b'};">
                                ${isInbound ? '📥 IN' : '📤 OUT'}
                            </span>
                            ${t.callsign || t.id}
                        </span>
                        ${isDouble ? '<span style="font-size: 8px; background: #ef4444; color: #fff; padding: 1px 4px; border-radius: 3px;">DOUBLE</span>' : ''}
                    </div>
                    <div class="tgt-info">FL${t.fl || Math.round((t.alt || 0) / 100)} | ${t.range_nm || 0} NM (${t.azimuth_deg || 0}°)</div>
                    <div class="tgt-info" style="color: #38bdf8;">📍 ${cLat.toFixed(3)}, ${cLon.toFixed(3)}</div>
                </div>
            `;
        }).join('');

        // Jika target sedang dipilih dan sidebar terbuka, perbarui data realtime-nya
        if (_radarSelectedTargetId) {
            const currentSel = visibleTargets.find(t => String(t.id) === String(_radarSelectedTargetId));
            if (currentSel) {
                updateRadarTargetDetailSidebar(currentSel);
            }
        }
    }

    window.setRadarTrafficFilter = function (filterType) {
        _radarTargetTrafficFilter = filterType;
        const btnAll = document.getElementById('btnTrafficAll');
        const btnIn = document.getElementById('btnTrafficInbound');
        const btnOut = document.getElementById('btnTrafficOutbound');

        if (btnAll) btnAll.classList.toggle('active', filterType === 'all');
        if (btnIn) btnIn.classList.toggle('active', filterType === 'inbound');
        if (btnOut) btnOut.classList.toggle('active', filterType === 'outbound');

        updateRadarPpiTargetsUI();
        drawRadarPPI();
    };

    function updateRadarTargetDetailSidebar(target) {
        const sidebar = document.getElementById('radarTargetDetailSidebar');
        if (!sidebar) return;

        if (!target) {
            sidebar.classList.remove('open');
            return;
        }

        const data = getActiveRadarSourceData() || {};
        const stCoords = resolveRadarStationCoords(data);
        const report = Array.isArray(_lastDuplicateAuditReport) ? _lastDuplicateAuditReport : [];
        const isDouble = report.some(r => String(r.targetA?.id) === String(target.id) || String(r.targetB?.id) === String(target.id));
        const dir = getTargetTrafficDirection(target, stCoords.lat, stCoords.lon);
        const isInbound = dir === 'inbound';
        const headingDeg = getTargetHeading(target, stCoords.lat, stCoords.lon);

        let cLat = parseFloat(target.lat);
        let cLon = parseFloat(target.lon);
        if (isNaN(cLat) || isNaN(cLon) || (Math.abs(cLat) < 0.0001 && Math.abs(cLon) < 0.0001)) {
            const geo = calculatePolarToLatLon(stCoords.lat, stCoords.lon, target.range_nm || 0, target.azimuth_deg || 0);
            cLat = geo.lat;
            cLon = geo.lon;
        }

        // Header
        const badge = document.getElementById('sbTargetDirectionBadge');
        if (badge) {
            badge.textContent = isInbound ? '📥 INBOUND' : '📤 OUTBOUND';
            badge.style.background = isInbound ? 'rgba(56, 189, 248, 0.25)' : 'rgba(245, 158, 11, 0.25)';
            badge.style.color = isInbound ? '#38bdf8' : '#f59e0b';
        }

        const csEl = document.getElementById('sbTargetCallsign');
        if (csEl) csEl.textContent = target.callsign || target.id || 'TARGET';

        // Identifikasi
        const sqEl = document.getElementById('sbTargetSquawk');
        if (sqEl) sqEl.textContent = target.squawk ? `SQ ${target.squawk}` : '—';

        const addrEl = document.getElementById('sbTargetAddress');
        if (addrEl) addrEl.textContent = target.address ? `0x${String(target.address).toUpperCase()}` : (target.target_address ? `0x${target.target_address}` : '—');

        const integEl = document.getElementById('sbTargetIntegrity');
        if (integEl) {
            if (isDouble) {
                integEl.textContent = '⚠ Anomali: Duplicate / Split Plot';
                integEl.style.color = '#ef4444';
            } else {
                integEl.textContent = '✓ Valid Single Track';
                integEl.style.color = '#00ff88';
            }
        }

        // Vektor & Ketinggian
        const flEl = document.getElementById('sbTargetFL');
        if (flEl) flEl.textContent = target.fl !== null && target.fl !== undefined ? `FL ${target.fl}` : (target.alt ? `FL ${Math.round(target.alt / 100)}` : 'FL —');

        const altEl = document.getElementById('sbTargetAlt');
        if (altEl) {
            const feet = target.alt ? Number(target.alt) : (target.fl ? Number(target.fl) * 100 : null);
            if (feet !== null) {
                const meters = Math.round(feet * 0.3048);
                altEl.textContent = `${feet.toLocaleString()} ft (${meters.toLocaleString()} m)`;
            } else {
                altEl.textContent = '—';
            }
        }

        const spdEl = document.getElementById('sbTargetSpeed');
        if (spdEl) {
            const spd = target.speed || target.ground_speed || 0;
            const kmh = Math.round(spd * 1.852);
            spdEl.textContent = spd > 0 ? `${spd} kts (${kmh} km/h)` : '—';
        }

        const hdgEl = document.getElementById('sbTargetHeading');
        if (hdgEl) {
            let cardinal = 'N';
            if (headingDeg >= 337.5 || headingDeg < 22.5) cardinal = 'N';
            else if (headingDeg < 67.5) cardinal = 'NE';
            else if (headingDeg < 112.5) cardinal = 'E';
            else if (headingDeg < 157.5) cardinal = 'SE';
            else if (headingDeg < 202.5) cardinal = 'S';
            else if (headingDeg < 247.5) cardinal = 'SW';
            else if (headingDeg < 292.5) cardinal = 'W';
            else cardinal = 'NW';
            hdgEl.textContent = `${headingDeg}° (${cardinal})`;
        }

        // Posisi dari Radar
        const distEl = document.getElementById('sbTargetDistance');
        if (distEl) {
            const rNm = Number(target.range_nm) || 0;
            const rKm = (rNm * 1.852).toFixed(1);
            distEl.textContent = `${rNm.toFixed(2)} NM (${rKm} km)`;
        }

        const azEl = document.getElementById('sbTargetAzimuth');
        if (azEl) {
            const az = Number(target.azimuth_deg) || 0;
            azEl.textContent = `${az.toFixed(2)}°`;
        }

        const coordsEl = document.getElementById('sbTargetCoords');
        if (coordsEl) {
            coordsEl.textContent = `${cLat.toFixed(5)}, ${cLon.toFixed(5)}`;
        }

        const stRefEl = document.getElementById('sbTargetStationRef');
        if (stRefEl) {
            stRefEl.textContent = `${stCoords.name || data.radar_name || 'Radar Station'} (${stCoords.lat.toFixed(4)}, ${stCoords.lon.toFixed(4)})`;
        }

        sidebar.classList.add('open');
    }

    window.selectRadarTarget = function (tgtId) {
        _radarSelectedTargetId = tgtId;
        updateRadarPpiTargetsUI();

        if (tgtId) {
            const data = getActiveRadarSourceData() || {};
            const targets = Array.isArray(data.targets_detail) ? data.targets_detail : [];
            const target = targets.find(t => String(t.id) === String(tgtId));
            if (target) {
                updateRadarTargetDetailSidebar(target);
            }
        } else {
            updateRadarTargetDetailSidebar(null);
        }

        drawRadarPPI();
    };

    // ── CANVAS DRAWING ENGINE (DENGAN DETEKSI VISUAL DOUBLE TARGET) ────────────
    function drawRadarPPI() {
        const canvas = document.getElementById('radarPpiCanvas');
        if (!canvas) return;

        const ctx = canvas.getContext('2d');
        const container = document.getElementById('radarCanvasContainer');
        if (!container) return;

        const w = container.clientWidth;
        const h = container.clientHeight;
        if (w <= 0 || h <= 0) return;

        ctx.clearRect(0, 0, w, h);

        let cx = w / 2;
        let cy = h / 2;
        let maxRadius = Math.min(w, h) * 0.44;

        // Jika peta Leaflet aktif dan valid, ambil titik proyeksi stasiun radar di layar
        // dan sinkronkan maxRadius secara presisi dengan skala mil laut (NM) pada peta bumi Leaflet!
        if (_radarMap && _lastRadarCoords && _lastRadarCoords.lat) {
            try {
                const pt = _radarMap.latLngToContainerPoint([_lastRadarCoords.lat, _lastRadarCoords.lon]);
                if (pt && !isNaN(pt.x) && !isNaN(pt.y)) {
                    cx = pt.x;
                    cy = pt.y;
                }

                // Hitung titik geografis pada jarak _radarRangeNm ke arah timur
                // 1 derajat bujur di khatulistiwa ~ 60 NM (1 NM = 1 menit busur)
                const latRad = (_lastRadarCoords.lat * Math.PI) / 180;
                const dLon = _radarRangeNm / (60 * Math.cos(latRad));
                const edgePt = _radarMap.latLngToContainerPoint([_lastRadarCoords.lat, _lastRadarCoords.lon + dLon]);
                if (edgePt && !isNaN(edgePt.x)) {
                    const geoRadiusPx = Math.abs(edgePt.x - cx);
                    if (geoRadiusPx > 20) {
                        maxRadius = geoRadiusPx;
                    }
                }
            } catch (e) { }
        }

        // 1. Radar PPI Circle Scope
        ctx.beginPath();
        ctx.arc(cx, cy, maxRadius, 0, Math.PI * 2);
        if (!_isMapEnabled) {
            const grad = ctx.createRadialGradient(cx, cy, 10, cx, cy, maxRadius);
            grad.addColorStop(0, '#061324');
            grad.addColorStop(0.7, '#040d1a');
            grad.addColorStop(1, '#02060e');
            ctx.fillStyle = grad;
        } else if (_mapTheme === 'light') {
            // Semi-transparan ringan untuk mode Peta Terang (terang jernih, kontur dan kota sangat jelas)
            ctx.fillStyle = 'rgba(255, 255, 255, 0.08)';
        } else {
            // Semi-transparan untuk mode Peta Gelap
            ctx.fillStyle = 'rgba(3, 7, 18, 0.42)';
        }
        ctx.fill();

        ctx.lineWidth = _mapTheme === 'light' ? 2 : 1.5;
        ctx.strokeStyle = _mapTheme === 'light' ? '#0284c7' : '#00d4ff';
        ctx.stroke();

        // 2. Concentric Range Rings (25%, 50%, 75%, 100%)
        const ringSteps = [0.25, 0.5, 0.75, 1.0];
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 4]);

        ringSteps.forEach(step => {
            const r = maxRadius * step;
            const nm = Math.round(_radarRangeNm * step);

            ctx.beginPath();
            ctx.arc(cx, cy, r, 0, Math.PI * 2);
            ctx.strokeStyle = 'rgba(0, 212, 255, 0.28)';
            ctx.stroke();

            // Label NM
            ctx.fillStyle = 'rgba(0, 255, 204, 0.85)';
            ctx.font = '10px monospace';
            ctx.textAlign = 'left';
            ctx.fillText(`${nm} NM`, cx + 6, cy - r + 12);
        });
        ctx.setLineDash([]);

        // 3. Radial Degree Lines & Compass Markers
        const radials = [
            { deg: 0, label: 'N (000°)' },
            { deg: 45, label: '045°' },
            { deg: 90, label: 'E (090°)' },
            { deg: 135, label: '135°' },
            { deg: 180, label: 'S (180°)' },
            { deg: 225, label: '225°' },
            { deg: 270, label: 'W (270°)' },
            { deg: 315, label: '315°' }
        ];

        radials.forEach(item => {
            const rad = (item.deg - 90) * (Math.PI / 180);
            const x1 = cx + (maxRadius * 0.08) * Math.cos(rad);
            const y1 = cy + (maxRadius * 0.08) * Math.sin(rad);
            const x2 = cx + maxRadius * Math.cos(rad);
            const y2 = cy + maxRadius * Math.sin(rad);

            ctx.beginPath();
            ctx.moveTo(x1, y1);
            ctx.lineTo(x2, y2);
            ctx.strokeStyle = 'rgba(0, 212, 255, 0.2)';
            ctx.lineWidth = 1;
            ctx.stroke();

            const lx = cx + (maxRadius + 16) * Math.cos(rad);
            const ly = cy + (maxRadius + 16) * Math.sin(rad);
            ctx.fillStyle = item.deg === 0 ? '#00ffcc' : 'rgba(148, 163, 184, 0.85)';
            ctx.font = item.deg === 0 ? 'bold 11px monospace' : '10px monospace';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(item.label, lx, ly);
        });

        // 4. Sweep Beam Line (Rotasi Antena Real-time)
        const sweepRad = (_radarSweepAngleDeg - 90) * (Math.PI / 180);
        const trailArcDeg = 36;
        const trailRad = trailArcDeg * (Math.PI / 180);

        const sweepGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, maxRadius);
        sweepGrad.addColorStop(0, 'rgba(0, 255, 170, 0.35)');
        sweepGrad.addColorStop(1, 'rgba(0, 255, 170, 0.04)');

        ctx.save();
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.arc(cx, cy, maxRadius, sweepRad - trailRad, sweepRad, false);
        ctx.closePath();
        ctx.fillStyle = sweepGrad;
        ctx.fill();
        ctx.restore();

        // Main Sweep Beam Line
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(cx + maxRadius * Math.cos(sweepRad), cy + maxRadius * Math.sin(sweepRad));
        ctx.strokeStyle = '#00ffcc';
        ctx.shadowColor = '#00ffcc';
        ctx.shadowBlur = 10;
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.shadowBlur = 0;

        // Pusat Radar (Station Tower Icon)
        ctx.beginPath();
        ctx.arc(cx, cy, 5, 0, Math.PI * 2);
        ctx.fillStyle = '#00ffcc';
        ctx.fill();
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.5;
        ctx.stroke();

        // 5. Render Pesawat (Aircraft Targets) & Visualisasi Double Target
        const srcData = getActiveRadarSourceData();
        let targets = (srcData && Array.isArray(srcData.targets_detail)) ? srcData.targets_detail : [];
        const rawDoubleMap = detectDuplicateTargets(targets);
        const report = Array.isArray(_lastDuplicateAuditReport) ? _lastDuplicateAuditReport : [];

        // Himpunan ID target sekunder/hantu (Target B) yang ditekan jika filter ISLS diaktifkan
        const islsSuppressedIds = new Set();
        if (_isIslsFilterEnabled && report.length > 0) {
            report.forEach(r => {
                if (r.targetB && r.targetB.id) {
                    islsSuppressedIds.add(String(r.targetB.id));
                }
            });
        }

        const visibleTargets = _isIslsFilterEnabled
            ? targets.filter(t => !islsSuppressedIds.has(String(t.id)))
            : targets;
        const doubleMap = _isIslsFilterEnabled ? new Map() : rawDoubleMap;

        // Petakan indeks target yang berada di koordinat/polar yang sama agar tidak saling menumpuk 100%
        const posClusterMap = new Map();
        visibleTargets.forEach(t => {
            const r = Math.round((Number(t.range_nm) || 0) * 10) / 10;
            const a = Math.round((Number(t.azimuth_deg) || 0) * 10) / 10;
            const key = `${r}_${a}`;
            if (!posClusterMap.has(key)) posClusterMap.set(key, []);
            posClusterMap.get(key).push(t);
        });

        let currentHovered = null;

        visibleTargets.forEach(tgt => {
            let range = Number(tgt.range_nm) || 0;
            let azim = Number(tgt.azimuth_deg) || 0;
            if (range <= 0) return; // Tetap tampilkan semua data target yang terdeteksi, tidak memfilter batas jarak

            // Jika target ini adalah double target / bertumpuk di titik yang sama,
            // berikan mikro-offset radial & sudut agar kedua target sama-sama terlihat jelas dan berdampingan
            const clusterKey = `${Math.round(range * 10) / 10}_${Math.round(azim * 10) / 10}`;
            const cluster = posClusterMap.get(clusterKey) || [];
            let offsetPxX = 0;
            let offsetPxY = 0;
            let tagOffsetY = 0;

            if (cluster.length > 1) {
                const idxInCluster = cluster.indexOf(tgt);
                // Geser posisi ikon 12px ke arah berlawanan untuk target ganda
                const angleOffset = (idxInCluster === 0 ? -1 : 1) * (Math.PI / 4);
                offsetPxX = Math.cos(angleOffset) * (idxInCluster * 14);
                offsetPxY = Math.sin(angleOffset) * (idxInCluster * 14);
                tagOffsetY = (idxInCluster === 0 ? -12 : 12);
            }

            const distPx = (range / _radarRangeNm) * maxRadius;
            const targetRad = (azim - 90) * (Math.PI / 180);
            const tx = cx + distPx * Math.cos(targetRad) + offsetPxX;
            const ty = cy + distPx * Math.sin(targetRad) + offsetPxY;

            // Deteksi Hover
            const dx = _radarMousePos.x - tx;
            const dy = _radarMousePos.y - ty;
            const isHovered = Math.sqrt(dx * dx + dy * dy) <= 22;
            const isSelected = String(tgt.id) === String(_radarSelectedTargetId);
            const isDouble = doubleMap.get(String(tgt.id)) === true;

            // Hitung koordinat geografis presisi (WGS84) jika belum ada dari sensor
            let tgtLat = parseFloat(tgt.lat);
            let tgtLon = parseFloat(tgt.lon);
            if (isNaN(tgtLat) || isNaN(tgtLon) || (Math.abs(tgtLat) < 0.0001 && Math.abs(tgtLon) < 0.0001)) {
                const geo = calculatePolarToLatLon(_lastRadarCoords.lat, _lastRadarCoords.lon, range, azim);
                tgtLat = geo.lat;
                tgtLon = geo.lon;
                tgt.lat = tgtLat;
                tgt.lon = tgtLon;
            }

            if (isHovered) {
                currentHovered = { ...tgt, lat: tgtLat, lon: tgtLon, screenX: tx, screenY: ty, isDouble };
            }

            let angleDiff = (_radarSweepAngleDeg - azim + 360) % 360;
            const isIlluminated = angleDiff < 35;

            // Jika terdeteksi DOUBLE TARGET: Berikan lingkaran pulsing merah mencolok
            if (isDouble) {
                ctx.beginPath();
                ctx.arc(tx, ty, 15, 0, Math.PI * 2);
                ctx.strokeStyle = '#ef4444';
                ctx.lineWidth = 1.8;
                ctx.setLineDash([3, 3]);
                ctx.stroke();
                ctx.setLineDash([]);
            }

            // Evaluasi filter traffic arah lalu lintas (Semua / Incoming / Outgoing)
            const targetDir = getTargetTrafficDirection(tgt, _lastRadarCoords.lat, _lastRadarCoords.lon);
            const isTargetInbound = targetDir === 'inbound';
            const matchesTrafficFilter = _radarTargetTrafficFilter === 'all' || targetDir === _radarTargetTrafficFilter;

            // Jika filter spesifik aktif dan target bukan kategori yang dipilih, rendahkan transparansi (dim) atau skip jika diinginkan
            const targetAlpha = matchesTrafficFilter ? 1.0 : 0.12;
            ctx.save();
            ctx.globalAlpha = targetAlpha;

            ctx.save();
            ctx.translate(tx, ty);

            // Hitung heading akurat dan orientasi moncong pesawat
            const headingDeg = getTargetHeading(tgt, _lastRadarCoords.lat, _lastRadarCoords.lon);
            const headingRad = (headingDeg - 90) * (Math.PI / 180);

            // Simpan posisi terbaru ke _targetHistoryMap untuk kalkulasi track sapuan berikutnya
            if (tgt.id) {
                _targetHistoryMap.set(String(tgt.id), {
                    range: range,
                    azim: azim,
                    lat: tgtLat,
                    lon: tgtLon,
                    time: Date.now()
                });
            }

            // Heading speed vector line (menunjuk ke arah pergerakan pesawat)
            ctx.beginPath();
            ctx.moveTo(0, 0);
            ctx.lineTo(16 * Math.cos(headingRad), 16 * Math.sin(headingRad));
            ctx.strokeStyle = isDouble ? '#ff4444' : (isSelected ? '#ffcc00' : (isTargetInbound ? 'rgba(56, 189, 248, 0.8)' : 'rgba(245, 158, 11, 0.8)'));
            ctx.lineWidth = 1.5;
            ctx.stroke();

            // Rotasi moncong pesawat jet agar tepat menghadap ke arah heading pergerakan
            // Canvas standard 0 rad adalah ke kanan (+X / 090°). Model pesawat digambar dengan hidung ke atas (-Y / 000°).
            // Maka rotasi canvas ke sudut heading adalah (headingRad + Math.PI / 2).
            ctx.rotate(headingRad + Math.PI / 2);

            // Gambar Ikon Pesawat Jet
            ctx.beginPath();
            ctx.moveTo(0, -9);     // Hidung
            ctx.lineTo(7, 6);      // Sayap kanan
            ctx.lineTo(2, 4);      // Badan kanan
            ctx.lineTo(3, 8);      // Ekor kanan
            ctx.lineTo(0, 7);      // Ekor tengah
            ctx.lineTo(-3, 8);     // Ekor kiri
            ctx.lineTo(-2, 4);     // Badan kiri
            ctx.lineTo(-7, 6);     // Sayap kiri
            ctx.closePath();

            if (isDouble) {
                ctx.fillStyle = '#ff3344';
                ctx.shadowColor = '#ff2233';
                ctx.shadowBlur = 14;
            } else if (isSelected) {
                ctx.fillStyle = '#ffcc00';
                ctx.shadowColor = '#ffcc00';
                ctx.shadowBlur = 12;
            } else if (isHovered) {
                ctx.fillStyle = '#00ffff';
                ctx.shadowColor = '#00ffff';
                ctx.shadowBlur = 15;
            } else if (isIlluminated) {
                ctx.fillStyle = '#ffffff';
                ctx.shadowColor = isTargetInbound ? '#38bdf8' : '#f59e0b';
                ctx.shadowBlur = 8;
            } else {
                ctx.fillStyle = isTargetInbound ? '#00d4ff' : '#f59e0b';
                ctx.shadowBlur = 0;
            }
            ctx.fill();
            ctx.strokeStyle = '#05101a';
            ctx.lineWidth = 1;
            ctx.stroke();
            ctx.restore();

            // Lingkaran Target Reticle jika Hovered atau Selected
            if (isSelected) {
                // High-visibility animated dual reticle for Selected Target
                const pulseTime = Date.now() / 300;
                const pulseR = 18 + Math.sin(pulseTime) * 3;

                // Outer pulsing golden ring
                ctx.beginPath();
                ctx.arc(tx, ty, pulseR, 0, Math.PI * 2);
                ctx.strokeStyle = '#ffcc00';
                ctx.lineWidth = 2;
                ctx.shadowColor = '#ffcc00';
                ctx.shadowBlur = 12;
                ctx.stroke();
                ctx.shadowBlur = 0;

                // Inner static cyan ring
                ctx.beginPath();
                ctx.arc(tx, ty, 11, 0, Math.PI * 2);
                ctx.strokeStyle = '#00ffff';
                ctx.lineWidth = 1.5;
                ctx.setLineDash([3, 3]);
                ctx.stroke();
                ctx.setLineDash([]);

                // 4 Tactical corner crosshairs
                const chLen = 6;
                ctx.strokeStyle = '#ffcc00';
                ctx.lineWidth = 2;
                ctx.beginPath();
                // Top
                ctx.moveTo(tx, ty - pulseR - chLen); ctx.lineTo(tx, ty - pulseR);
                // Bottom
                ctx.moveTo(tx, ty + pulseR); ctx.lineTo(tx, ty + pulseR + chLen);
                // Left
                ctx.moveTo(tx - pulseR - chLen, ty); ctx.lineTo(tx - pulseR, ty);
                // Right
                ctx.moveTo(tx + pulseR, ty); ctx.lineTo(tx + pulseR + chLen, ty);
                ctx.stroke();
            } else if (isHovered) {
                ctx.beginPath();
                ctx.arc(tx, ty, 14, 0, Math.PI * 2);
                ctx.strokeStyle = isDouble ? '#ff3344' : '#00ffff';
                ctx.lineWidth = 1.5;
                ctx.setLineDash([4, 4]);
                ctx.stroke();
                ctx.setLineDash([]);
            }

            // Data Tag Pesawat (ID di atas, Alt di bawah)
            const dirIcon = isTargetInbound ? '📥' : '📤';

            ctx.font = isSelected ? 'bold 11px monospace' : '10px monospace';
            ctx.fillStyle = isDouble ? '#ff5555' : (isSelected ? '#ffcc00' : (_mapTheme === 'light' ? (isTargetInbound ? '#0369a1' : '#b45309') : (isTargetInbound ? '#38bdf8' : '#f59e0b')));
            ctx.textAlign = 'left';
            const tagLabel = isDouble ? `⚠ ${tgt.callsign || tgt.id} [DBL]` : (isSelected ? `🎯 ${dirIcon} ${tgt.callsign || tgt.id}` : `${dirIcon} ${tgt.callsign || tgt.id}`);
            const textX = tx + (isSelected ? 24 : 12);
            ctx.fillText(tagLabel, textX, ty - 2 + tagOffsetY);

            ctx.font = isSelected ? 'bold 10px monospace' : '9px monospace';
            ctx.fillStyle = isDouble ? '#fca5a5' : (isSelected ? '#fef08a' : (_mapTheme === 'light' ? '#334155' : '#94a3b8'));
            const altLabel = tgt.fl ? `FL${tgt.fl}` : (tgt.alt ? `${tgt.alt}ft` : 'FL—');
            ctx.fillText(`${altLabel} · SQ${tgt.squawk || '—'}`, textX, ty + 10 + tagOffsetY);
            ctx.restore();
        });

        // 5b. Gambar Transponder Kalibrasi / Acuan Statis di PPI Scope
        const refCfg = getSavedRefTxpConfig(_activeRadarSourceId);
        const refAzim = refCfg.azimuth;
        const refDist = refCfg.range;
        if (refDist <= _radarRangeNm) {
            const refRad = ((refAzim - 90) * Math.PI) / 180;
            const refScale = maxRadius / _radarRangeNm;
            const rx = cx + Math.cos(refRad) * (refDist * refScale);
            const ry = cy + Math.sin(refRad) * (refDist * refScale);

            const rdx = _radarMousePos.x - rx;
            const rdy = _radarMousePos.y - ry;
            const isRefHovered = Math.sqrt(rdx * rdx + rdy * rdy) <= 18;

            const refGeo = calculatePolarToLatLon(_lastRadarCoords.lat, _lastRadarCoords.lon, refDist, refAzim);

            if (isRefHovered) {
                currentHovered = {
                    id: refCfg.targetId,
                    callsign: `${refCfg.targetId} (Parrot TXP)`,
                    squawk: refCfg.squawk || '7000',
                    address: refCfg.address || '8A0001',
                    fl: 1,
                    alt: 85,
                    lat: refGeo.lat,
                    lon: refGeo.lon,
                    range_nm: refDist,
                    azimuth_deg: refAzim,
                    speed: 0,
                    heading: 0,
                    isRefTransponder: true,
                    screenX: rx,
                    screenY: ry
                };
            }

            ctx.save();
            ctx.translate(rx, ry);

            // Diamond / Icon Tower Acuan
            ctx.beginPath();
            ctx.moveTo(0, -8);
            ctx.lineTo(7, 0);
            ctx.lineTo(0, 8);
            ctx.lineTo(-7, 0);
            ctx.closePath();
            ctx.fillStyle = isRefHovered ? '#ffffff' : '#ffaa00';
            ctx.shadowColor = '#ffaa00';
            ctx.shadowBlur = isRefHovered ? 16 : 10;
            ctx.fill();
            ctx.strokeStyle = isRefHovered ? '#00ffff' : '#ffffff';
            ctx.lineWidth = isRefHovered ? 2 : 1.5;
            ctx.stroke();

            // Ring pulsa statis
            ctx.beginPath();
            ctx.arc(0, 0, isRefHovered ? 14 : 11, 0, Math.PI * 2);
            ctx.strokeStyle = isRefHovered ? '#00ffff' : 'rgba(255, 170, 0, 0.4)';
            ctx.lineWidth = 1.2;
            ctx.stroke();
            ctx.restore();

            ctx.font = 'bold 9px monospace';
            ctx.fillStyle = isRefHovered ? '#ffffff' : '#ffaa00';
            ctx.textAlign = 'left';
            ctx.fillText(`⛯ ${refCfg.targetId} (${refDist}NM)`, rx + 14, ry + 3);
        }

        _radarHoveredTarget = currentHovered;

        // 6. Update Floating HUD Tooltip
        const hud = document.getElementById('radarHoverHud');
        if (hud) {
            if (currentHovered) {
                hud.style.display = 'block';
                const hudX = Math.min(w - 220, Math.max(15, currentHovered.screenX + 18));
                const hudY = Math.min(h - 190, Math.max(15, currentHovered.screenY - 30));
                hud.style.left = `${hudX}px`;
                hud.style.top = `${hudY}px`;

                const hudStatus = document.getElementById('hudStatus');
                if (hudStatus) {
                    if (currentHovered.isDouble) {
                        hudStatus.textContent = '⚠ TARGET DOBEL (DUPLICATE)';
                        hudStatus.style.color = '#ff4444';
                    } else if (currentHovered.isRefTransponder) {
                        hudStatus.textContent = 'Parrot Site Monitor';
                        hudStatus.style.color = '#ffaa00';
                    } else {
                        const hDir = getTargetTrafficDirection(currentHovered, _lastRadarCoords.lat, _lastRadarCoords.lon);
                        const isIn = hDir === 'inbound';
                        hudStatus.textContent = isIn ? '📥 INCOMING (Mendekat)' : '📤 OUTGOING (Menjauh)';
                        hudStatus.style.color = isIn ? '#38bdf8' : '#f59e0b';
                    }
                }

                if (currentHovered.isRefTransponder) {
                    document.getElementById('hudCallsign').textContent = `${currentHovered.id} (Parrot TXP)`;
                    document.getElementById('hudSquawk').textContent = `SQ ${currentHovered.squawk} | ADDR: ${currentHovered.address}`;
                    document.getElementById('hudAlt').textContent = '85 ft MSL (Ground Station / Tower)';
                    document.getElementById('hudLatLon').textContent = `Target Ref: ${currentHovered.id}`;
                    document.getElementById('hudDist').textContent = `${currentHovered.range_nm} NM (Nominal)`;
                    document.getElementById('hudAzim').textContent = `${currentHovered.azimuth_deg}° (North Align)`;
                    document.getElementById('hudSpd').textContent = '0 kts (Static)';
                    document.getElementById('hudHdg').textContent = 'Omni Directional';
                } else {
                    document.getElementById('hudCallsign').textContent = currentHovered.callsign || currentHovered.id;
                    document.getElementById('hudSquawk').textContent = `SQ ${currentHovered.squawk || '1200'}`;
                    document.getElementById('hudAlt').textContent = currentHovered.fl ? `FL${currentHovered.fl} (${(currentHovered.fl * 100).toLocaleString()} ft)` : (currentHovered.alt ? `${currentHovered.alt.toLocaleString()} ft` : '—');
                    document.getElementById('hudLatLon').textContent = (currentHovered.lat && currentHovered.lon) ? `${currentHovered.lat}, ${currentHovered.lon}` : '—';
                    document.getElementById('hudDist').textContent = `${currentHovered.range_nm || 0} NM`;
                    document.getElementById('hudAzim').textContent = `${currentHovered.azimuth_deg || 0}°`;
                    document.getElementById('hudSpd').textContent = `${currentHovered.speed || 320} kts`;
                    document.getElementById('hudHdg').textContent = `${currentHovered.heading || currentHovered.azimuth_deg || 0}°`;
                }
            } else {
                hud.style.display = 'none';
            }
        }

        // 7. Visual Banner on Canvas saat Mode ISLS Aktif
        if (_isIslsFilterEnabled) {
            ctx.save();
            const bannerTxt = '🛡 ISLS & ANTI-MULTIPATH FILTER: AKTIF (ECHO DITEKAN)';
            ctx.font = 'bold 11px monospace';
            const bWidth = ctx.measureText(bannerTxt).width;
            const bX = 16;
            const bY = 24;

            ctx.fillStyle = 'rgba(6, 78, 59, 0.85)';
            ctx.strokeStyle = '#10b981';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.roundRect(bX, bY - 14, bWidth + 24, 22, 4);
            ctx.fill();
            ctx.stroke();

            ctx.fillStyle = '#34d399';
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            ctx.fillText(bannerTxt, bX + 12, bY - 3);
            ctx.restore();
        }

        // 8. Electronic Bearing & Range Line (EBRL / Ruler Distance Measurement Tool)
        if (_isRulerMode || _rulerPointA || _rulerPointB) {
            ctx.save();

            // SINKRONKAN POSISI SCREEN DENGAN PETA (Agar saat peta digeser / pan, garis tetap melekat pada koordinat bumi)
            let p1Screen = null;
            if (_rulerPointA) {
                if (_radarMap && _rulerPointA.lat && _rulerPointA.lon) {
                    try {
                        const pt = _radarMap.latLngToContainerPoint([_rulerPointA.lat, _rulerPointA.lon]);
                        p1Screen = { x: pt.x, y: pt.y };
                    } catch (e) {
                        p1Screen = { x: _rulerPointA.x, y: _rulerPointA.y };
                    }
                } else {
                    p1Screen = { x: _rulerPointA.x, y: _rulerPointA.y };
                }
            }

            let p2Screen = null;
            let p2Lat = null, p2Lon = null, p2Label = '';
            if (_rulerPointB) {
                if (_radarMap && _rulerPointB.lat && _rulerPointB.lon) {
                    try {
                        const pt = _radarMap.latLngToContainerPoint([_rulerPointB.lat, _rulerPointB.lon]);
                        p2Screen = { x: pt.x, y: pt.y };
                    } catch (e) {
                        p2Screen = { x: _rulerPointB.x, y: _rulerPointB.y };
                    }
                } else {
                    p2Screen = { x: _rulerPointB.x, y: _rulerPointB.y };
                }
                p2Lat = _rulerPointB.lat;
                p2Lon = _rulerPointB.lon;
                p2Label = _rulerPointB.label;
            } else if (_isRulerMode && _rulerPointA && _radarMousePos.x > 0 && _radarMousePos.y > 0) {
                // Posisi live mouse saat sedang membentangkan garis ukur ke Titik 2
                p2Screen = { x: _radarMousePos.x, y: _radarMousePos.y };
                if (_radarHoveredTarget) {
                    p2Lat = parseFloat(_radarHoveredTarget.lat);
                    p2Lon = parseFloat(_radarHoveredTarget.lon);
                    p2Label = _radarHoveredTarget.callsign || _radarHoveredTarget.id;
                } else if (_radarMap) {
                    try {
                        const latLng = _radarMap.containerPointToLatLng([_radarMousePos.x, _radarMousePos.y]);
                        p2Lat = latLng.lat;
                        p2Lon = latLng.lng;
                        p2Label = `${p2Lat.toFixed(2)}, ${p2Lon.toFixed(2)}`;
                    } catch (e) {}
                }
            }

            // Gambar Garis Ukur & Badge Jarak Realtime
            if (p1Screen && p2Screen) {
                // Garis ukur glowing cyan/gold
                ctx.beginPath();
                ctx.moveTo(p1Screen.x, p1Screen.y);
                ctx.lineTo(p2Screen.x, p2Screen.y);
                ctx.strokeStyle = '#00f0ff';
                ctx.lineWidth = 2.2;
                ctx.setLineDash([6, 4]);
                ctx.shadowColor = '#00f0ff';
                ctx.shadowBlur = 10;
                ctx.stroke();
                ctx.setLineDash([]);
                ctx.shadowBlur = 0;

                // Hitung Jarak & Azimuth
                let distNm = 0, distKm = 0, bearing = 0;
                if (_rulerPointA.lat && _rulerPointA.lon && p2Lat && p2Lon) {
                    const geo = calculateGeoDistanceAndBearing(_rulerPointA.lat, _rulerPointA.lon, p2Lat, p2Lon);
                    distNm = geo.distNm;
                    distKm = geo.distKm;
                    bearing = geo.bearing;
                } else {
                    // Fallback hitung rasio pixel terhadap maxRadius
                    const dx = p2Screen.x - p1Screen.x;
                    const dy = p2Screen.y - p1Screen.y;
                    const pxDist = Math.hypot(dx, dy);
                    distNm = Number(((pxDist / maxRadius) * _radarRangeNm).toFixed(2));
                    distKm = Number((distNm * 1.852).toFixed(2));
                    bearing = Math.round((Math.atan2(dx, -dy) * 180 / Math.PI + 360) % 360);
                }

                // Gambar Badge Informasi Jarak Tepat di Tengah Garis
                const midX = (p1Screen.x + p2Screen.x) / 2;
                const midY = (p1Screen.y + p2Screen.y) / 2;

                const textLine1 = `📏 ${distNm} NM (${distKm} km)`;
                const textLine2 = `🧭 Azim: ${bearing}° | Dari ${_rulerPointA.label || 'T1'} ke ${p2Label || 'T2'}`;

                ctx.font = 'bold 12px monospace';
                const w1 = ctx.measureText(textLine1).width;
                ctx.font = '10px monospace';
                const w2 = ctx.measureText(textLine2).width;
                const badgeW = Math.max(w1, w2) + 24;
                const badgeH = 44;

                ctx.fillStyle = 'rgba(2, 6, 23, 0.92)';
                ctx.strokeStyle = '#00f0ff';
                ctx.lineWidth = 1.5;
                ctx.shadowColor = 'rgba(0, 240, 255, 0.6)';
                ctx.shadowBlur = 12;
                ctx.beginPath();
                ctx.roundRect(midX - badgeW / 2, midY - badgeH / 2, badgeW, badgeH, 6);
                ctx.fill();
                ctx.stroke();
                ctx.shadowBlur = 0;

                // Teks baris 1: Jarak
                ctx.fillStyle = '#00f0ff';
                ctx.font = 'bold 12px monospace';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText(textLine1, midX, midY - 8);

                // Teks baris 2: Azimuth / Keterangan
                ctx.fillStyle = '#f8fafc';
                ctx.font = '10px monospace';
                ctx.fillText(textLine2, midX, midY + 11);
            }

            // Gambar Titik 1 (Target Marker A - Lingkaran Kuning Pulsing)
            if (p1Screen) {
                ctx.beginPath();
                ctx.arc(p1Screen.x, p1Screen.y, 8, 0, Math.PI * 2);
                ctx.fillStyle = '#ffcc00';
                ctx.shadowColor = '#ffcc00';
                ctx.shadowBlur = 14;
                ctx.fill();
                ctx.strokeStyle = '#ffffff';
                ctx.lineWidth = 2;
                ctx.stroke();

                ctx.beginPath();
                ctx.arc(p1Screen.x, p1Screen.y, 14, 0, Math.PI * 2);
                ctx.strokeStyle = '#ffcc00';
                ctx.lineWidth = 1.5;
                ctx.setLineDash([3, 3]);
                ctx.stroke();
                ctx.setLineDash([]);
                ctx.shadowBlur = 0;

                ctx.font = 'bold 11px monospace';
                ctx.fillStyle = '#ffffff';
                ctx.textAlign = 'left';
                ctx.fillText(`① ${_rulerPointA.label || 'Titik 1'}`, p1Screen.x + 12, p1Screen.y - 10);
            }

            // Gambar Titik 2 jika sudah fix diklik
            if (_rulerPointB && p2Screen) {
                ctx.beginPath();
                ctx.arc(p2Screen.x, p2Screen.y, 8, 0, Math.PI * 2);
                ctx.fillStyle = '#00ff88';
                ctx.shadowColor = '#00ff88';
                ctx.shadowBlur = 14;
                ctx.fill();
                ctx.strokeStyle = '#ffffff';
                ctx.lineWidth = 2;
                ctx.stroke();

                ctx.beginPath();
                ctx.arc(p2Screen.x, p2Screen.y, 14, 0, Math.PI * 2);
                ctx.strokeStyle = '#00ff88';
                ctx.lineWidth = 1.5;
                ctx.setLineDash([3, 3]);
                ctx.stroke();
                ctx.setLineDash([]);
                ctx.shadowBlur = 0;

                ctx.font = 'bold 11px monospace';
                ctx.fillStyle = '#ffffff';
                ctx.textAlign = 'left';
                ctx.fillText(`② ${_rulerPointB.label || 'Titik 2'}`, p2Screen.x + 12, p2Screen.y - 10);
            }

            // Floating Helper Banner di Kiri Bawah saat Mode Ukur Aktif
            if (_isRulerMode) {
                const guideTxt = !_rulerPointA 
                    ? '📏 MODE UKUR JARAK: Klik Titik 1 (Pesawat / Koordinat Peta)' 
                    : (!_rulerPointB 
                        ? '📏 MODE UKUR JARAK: Klik Titik 2 (Tujuan / Pesawat Lain) [ESC: Batal]' 
                        : '📏 UKUR JARAK SELESAI: Klik lagi untuk ukur baru [ESC: Hapus]');
                
                ctx.font = 'bold 11px monospace';
                const gw = ctx.measureText(guideTxt).width;
                const gx = 16;
                const gy = h - 28;

                ctx.fillStyle = 'rgba(15, 23, 42, 0.9)';
                ctx.strokeStyle = '#00f0ff';
                ctx.lineWidth = 1.2;
                ctx.beginPath();
                ctx.roundRect(gx, gy - 14, gw + 24, 26, 4);
                ctx.fill();
                ctx.stroke();

                ctx.fillStyle = '#00f0ff';
                ctx.textAlign = 'left';
                ctx.textBaseline = 'middle';
                ctx.fillText(guideTxt, gx + 12, gy);
            }

            ctx.restore();
        }
    }

    // ── AUDIT TAB & COVERAGE POLAR CHART ───────────────────────────────────────
    window.switchRadarTab = function (tabName) {
        _currentRadarTab = tabName;
        const btnPpi = document.getElementById('radarTabBtnPpi');
        const btnAudit = document.getElementById('radarTabBtnAudit');
        const viewPpi = document.getElementById('radarPpiView');
        const viewAudit = document.getElementById('radarAuditView');
        const ppiControls = document.getElementById('radarPpiControlsRight');
        const auditControls = document.getElementById('radarAuditControlsRight');

        if (tabName === 'audit') {
            if (btnPpi) btnPpi.className = 'radar-tab-btn';
            if (btnAudit) btnAudit.className = 'radar-tab-btn active';
            if (viewPpi) viewPpi.style.display = 'none';
            if (viewAudit) viewAudit.style.display = 'flex';
            if (ppiControls) ppiControls.style.display = 'none';
            if (auditControls) auditControls.style.display = 'flex';

            const data = getActiveRadarSourceData() || {};
            drawRadarCoveragePolar(data.audit_data || {});
        } else {
            if (btnPpi) btnPpi.className = 'radar-tab-btn active';
            if (btnAudit) btnAudit.className = 'radar-tab-btn';
            if (viewPpi) viewPpi.style.display = 'flex';
            if (viewAudit) viewAudit.style.display = 'none';
            if (ppiControls) ppiControls.style.display = 'flex';
            if (auditControls) auditControls.style.display = 'none';
            setTimeout(resizeRadarCanvas, 30);
        }
    };

    function updateRadarAuditUI(data) {
        if (!data) return;
        const audit = data.audit_data || {};

        const azimDriftEl = document.getElementById('auditValAzimDrift');
        const azimBadge = document.getElementById('auditBadgeAzim');
        const azimText = document.getElementById('auditTextAzimStatus');
        if (azimDriftEl) azimDriftEl.textContent = audit.azimuth_drift_deg || '+0.00°';
        if (azimText) azimText.textContent = audit.alignment_status || 'Locked';
        if (azimBadge) {
            const isWarn = (audit.alignment_status || '').toLowerCase().includes('warning');
            azimBadge.textContent = isWarn ? 'WARNING' : 'NORMAL';
            azimBadge.style.color = isWarn ? '#ffcc00' : '#00ff88';
            azimBadge.style.borderColor = isWarn ? '#ffcc00' : '#00ff88';
        }

        const tiltValEl = document.getElementById('auditValTilt');
        const tiltBadge = document.getElementById('auditBadgeTilt');
        const tiltText = document.getElementById('auditTextTiltStatus');
        if (tiltValEl) tiltValEl.textContent = audit.tilt_estimate || '0.0°';
        if (tiltText) tiltText.textContent = audit.tilt_status || 'Horizon Optimal';
        if (tiltBadge) {
            const isTiltWarn = (audit.tilt_status || '').toLowerCase().includes('warning');
            tiltBadge.textContent = isTiltWarn ? 'DRIFT' : 'OPTIMAL';
            tiltBadge.style.color = isTiltWarn ? '#ff3355' : '#00d4ff';
            tiltBadge.style.borderColor = isTiltWarn ? '#ff3355' : '#00d4ff';
        }

        const refCfg = getSavedRefTxpConfig(_activeRadarSourceId);
        const refObj = audit.reference_target || {};
        const refIdEl = document.getElementById('auditRefTargetId');
        const refAzimEl = document.getElementById('auditRefAzim');
        const refDistEl = document.getElementById('auditRefDist');

        const nomAz = refCfg.azimuth;
        const measAz = parseFloat(refObj.measured_azimuth) || nomAz;
        const calcDrift = (measAz - nomAz).toFixed(2);
        const signDrift = calcDrift >= 0 ? `+${calcDrift}` : `${calcDrift}`;

        if (refIdEl) refIdEl.innerHTML = `<span style="color: #ffaa00;">${refCfg.targetId}</span> <span style="font-size: 10px; color: #94a3b8;">(SQ: ${refCfg.squawk} | ADDR: ${refCfg.address})</span>`;
        if (refAzimEl) refAzimEl.textContent = `${measAz.toFixed(2)}° (Drift: ${signDrift}°) | Nom: ${nomAz.toFixed(2)}°`;
        if (refDistEl) refDistEl.textContent = `${refObj.measured_range || (refCfg.range + ' NM')}`;

        const avgEl = document.getElementById('auditAvgRange');
        if (avgEl) avgEl.textContent = audit.avg_coverage_range_nm ? `${audit.avg_coverage_range_nm} NM` : '110.0 NM';

        const tableBody = document.getElementById('radarSectorsTableBody');
        const sectors = Array.isArray(audit.coverage_sectors) ? audit.coverage_sectors : [];
        if (tableBody && sectors.length > 0) {
            tableBody.innerHTML = sectors.map(sec => {
                const maxR = sec.max_range_nm || 0;
                let statusColor = '#00ff88';
                if (maxR < 50) statusColor = '#ff3355';
                else if (maxR < 80) statusColor = '#ffcc00';

                return `
                    <tr>
                        <td style="font-weight: 700; color: #00d4ff;">SEC ${String(sec.sector_index).padStart(2, '0')}</td>
                        <td style="font-family: monospace; color: #e2e8f0;">${sec.azimuth_label}</td>
                        <td style="font-weight: 700; color: #00ffcc;">${maxR} NM</td>
                        <td style="color: #cbd5e1;">${sec.active_targets || 0} Target</td>
                        <td><span style="color: ${statusColor}; font-weight: 600;">● ${sec.status}</span></td>
                    </tr>
                `;
            }).join('');
        }

        if (_currentRadarTab === 'audit') {
            drawRadarCoveragePolar(audit);
        }
    }

    function drawRadarCoveragePolar(audit) {
        const canvas = document.getElementById('radarCoverageCanvas');
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        const w = canvas.width;
        const h = canvas.height;
        ctx.clearRect(0, 0, w, h);

        const cx = w / 2;
        const cy = h / 2 + 10;
        const maxRadius = Math.min(w, h) * 0.40;
        const maxRangeRef = 140;

        [35, 70, 105, 140].forEach((rng, idx) => {
            const r = (rng / maxRangeRef) * maxRadius;
            ctx.beginPath();
            ctx.arc(cx, cy, r, 0, Math.PI * 2);
            ctx.strokeStyle = idx === 3 ? 'rgba(0, 212, 255, 0.4)' : 'rgba(0, 212, 255, 0.15)';
            ctx.lineWidth = 1;
            ctx.stroke();

            ctx.font = '9px monospace';
            ctx.fillStyle = 'rgba(0, 212, 255, 0.5)';
            ctx.textAlign = 'left';
            ctx.fillText(`${rng}NM`, cx + 3, cy - r + 9);
        });

        ctx.strokeStyle = 'rgba(0, 212, 255, 0.2)';
        ctx.setLineDash([2, 4]);
        ctx.beginPath();
        ctx.moveTo(cx, cy - maxRadius);
        ctx.lineTo(cx, cy + maxRadius);
        ctx.moveTo(cx - maxRadius, cy);
        ctx.lineTo(cx + maxRadius, cy);
        ctx.stroke();
        ctx.setLineDash([]);

        ctx.font = 'bold 10px sans-serif';
        ctx.fillStyle = '#00d4ff';
        ctx.textAlign = 'center';
        ctx.fillText('N (0°)', cx, cy - maxRadius - 4);
        ctx.fillText('S (180°)', cx, cy + maxRadius + 12);
        ctx.textAlign = 'left';
        ctx.fillText('E (90°)', cx + maxRadius + 4, cy + 3);
        ctx.textAlign = 'right';
        ctx.fillText('W (270°)', cx - maxRadius - 4, cy + 3);

        const sectors = Array.isArray(audit?.coverage_sectors) ? audit.coverage_sectors : [];
        if (sectors.length === 0) return;

        sectors.forEach(sec => {
            const startRad = ((sec.start_deg - 90) * Math.PI) / 180;
            const endRad = ((sec.end_deg - 90) * Math.PI) / 180;
            const val = Math.min(sec.max_range_nm || 70, maxRangeRef);
            const r = (val / maxRangeRef) * maxRadius;

            ctx.beginPath();
            ctx.moveTo(cx, cy);
            ctx.arc(cx, cy, r, startRad, endRad);
            ctx.closePath();

            let fillCol = 'rgba(0, 255, 136, 0.25)';
            let strokeCol = 'rgba(0, 255, 136, 0.8)';
            if (val < 60) {
                fillCol = 'rgba(255, 51, 85, 0.25)';
                strokeCol = 'rgba(255, 51, 85, 0.8)';
            } else if (val < 90) {
                fillCol = 'rgba(255, 204, 0, 0.25)';
                strokeCol = 'rgba(255, 204, 0, 0.8)';
            }

            ctx.fillStyle = fillCol;
            ctx.fill();
            ctx.strokeStyle = strokeCol;
            ctx.lineWidth = 1;
            ctx.stroke();
        });

        const refCfg = getSavedRefTxpConfig(_activeRadarSourceId);
        const refAzim = refCfg.azimuth;
        const refDist = refCfg.range;
        const refRad = ((refAzim - 90) * Math.PI) / 180;
        const refR = (refDist / maxRangeRef) * maxRadius;
        const refX = cx + Math.cos(refRad) * refR;
        const refY = cy + Math.sin(refRad) * refR;

        ctx.save();
        ctx.translate(refX, refY);

        ctx.beginPath();
        ctx.arc(0, 0, 7, 0, Math.PI * 2);
        ctx.strokeStyle = '#ffaa00';
        ctx.lineWidth = 1.2;
        ctx.stroke();

        ctx.beginPath();
        ctx.moveTo(0, -4);
        ctx.lineTo(4, 0);
        ctx.lineTo(0, 4);
        ctx.lineTo(-4, 0);
        ctx.closePath();
        ctx.fillStyle = '#ffaa00';
        ctx.shadowColor = '#ffaa00';
        ctx.shadowBlur = 8;
        ctx.fill();
        ctx.restore();

        const labelText = `⛯ ${refCfg.targetId} (${refAzim}° / ${refDist}NM)`;
        ctx.font = 'bold 9px monospace';
        const txtWidth = ctx.measureText(labelText).width;

        ctx.fillStyle = 'rgba(2, 6, 14, 0.85)';
        ctx.fillRect(refX + 8, refY - 8, txtWidth + 6, 14);
        ctx.strokeStyle = '#ffaa00';
        ctx.lineWidth = 0.8;
        ctx.strokeRect(refX + 8, refY - 8, txtWidth + 6, 14);

        ctx.fillStyle = '#ffcc00';
        ctx.textAlign = 'left';
        ctx.fillText(labelText, refX + 11, refY + 3);
    }

    // ── MODAL SETTING TRANSPONDER REFERENSI ────────────────────────────────────
    window.openRefTxpConfigModal = function () {
        const modal = document.getElementById('radarRefModal');
        if (!modal) return;
        const cfg = getSavedRefTxpConfig(_activeRadarSourceId);
        const inputId = document.getElementById('cfgRefTargetId');
        const inputSq = document.getElementById('cfgRefSquawk');
        const inputAddr = document.getElementById('cfgRefAddress');
        const inputAz = document.getElementById('cfgRefAzimuth');
        const inputRng = document.getElementById('cfgRefRange');

        if (inputId) inputId.value = cfg.targetId;
        if (inputSq) inputSq.value = cfg.squawk;
        if (inputAddr) inputAddr.value = cfg.address;
        if (inputAz) inputAz.value = cfg.azimuth;
        if (inputRng) inputRng.value = cfg.range;
        modal.style.display = 'flex';
    };

    window.closeRefTxpConfigModal = function () {
        const modal = document.getElementById('radarRefModal');
        if (modal) modal.style.display = 'none';
    };

    window.saveRefTxpConfig = function () {
        const srcId = _activeRadarSourceId || 'default';
        const inputId = document.getElementById('cfgRefTargetId');
        const inputSq = document.getElementById('cfgRefSquawk');
        const inputAddr = document.getElementById('cfgRefAddress');
        const inputAz = document.getElementById('cfgRefAzimuth');
        const inputRng = document.getElementById('cfgRefRange');

        const cfg = {
            targetId: (inputId?.value || 'REF-TXP').trim().toUpperCase(),
            squawk: (inputSq?.value || '7000').trim(),
            address: (inputAddr?.value || '8A0001').trim().toUpperCase(),
            azimuth: parseFloat(inputAz?.value) || 85.20,
            range: parseFloat(inputRng?.value) || 12.45
        };

        try {
            localStorage.setItem(`radar_ref_txp_config_${srcId}`, JSON.stringify(cfg));
        } catch (e) { }

        window.closeRefTxpConfigModal();

        const data = getActiveRadarSourceData() || {};
        updateRadarAuditUI(data);
        if (_currentRadarTab === 'audit') {
            drawRadarCoveragePolar(data.audit_data || {});
        }
    };

    // ── MODAL DIAGNOSA TARGET DOBEL & SARAN PERBAIKAN ──────────────────────────
    window.openRadarDuplicateAuditModal = function () {
        const modal = document.getElementById('radarDuplicateAuditModal');
        if (!modal) return;

        const countEl = document.getElementById('modalDupTotalCount');
        const rdpStatusEl = document.getElementById('modalDupRdpStatus');
        const tipEl = document.getElementById('modalDupPriorityTip');
        const listEl = document.getElementById('radarDuplicateAuditList');

        const report = Array.isArray(_lastDuplicateAuditReport) ? _lastDuplicateAuditReport : [];

        if (countEl) countEl.textContent = `${report.length} Pasangan`;

        let hasSplit = false;
        let hasReflection = false;
        report.forEach(r => {
            if (r.category.includes('SPLIT')) hasSplit = true;
            if (r.category.includes('REFLECTION')) hasReflection = true;
        });

        if (rdpStatusEl) {
            if (hasSplit && hasReflection) {
                rdpStatusEl.textContent = 'Kombinasi Split & Multipath';
                rdpStatusEl.style.color = '#ef4444';
            } else if (hasSplit) {
                rdpStatusEl.textContent = 'Anomali Plot Splitting / Monopulse OBA';
                rdpStatusEl.style.color = '#ef4444';
            } else if (hasReflection) {
                rdpStatusEl.textContent = 'Multipath Echo Terdeteksi';
                rdpStatusEl.style.color = '#ffaa00';
            } else {
                rdpStatusEl.textContent = 'Normal Single Plot';
                rdpStatusEl.style.color = '#00ff88';
            }
        }

        if (tipEl) {
            if (hasSplit) {
                tipEl.textContent = 'Kalibrasi Kurva OBA Receiver Monopulse & Tuning Coalescing Window RDP';
            } else if (hasReflection) {
                tipEl.textContent = 'Periksa Reflection Screening Map & Daya Pancar P2 ISLS Antena';
            } else {
                tipEl.textContent = 'Sistem Ekstraktor dalam Kondisi Standar';
            }
        }

        if (listEl) {
            let islsBannerHtml = '';
            if (_isIslsFilterEnabled) {
                islsBannerHtml = `
                    <div style="background: rgba(16, 185, 129, 0.15); border: 1px solid #10b981; border-radius: 8px; padding: 12px 16px; margin-bottom: 14px; display: flex; align-items: center; justify-content: space-between;">
                        <div style="display: flex; align-items: center; gap: 10px;">
                            <i class="fas fa-shield-alt" style="color: #34d399; font-size: 20px;"></i>
                            <div>
                                <div style="color: #34d399; font-weight: 800; font-size: 12px;">SIMULASI FILTER ISLS: AKTIF</div>
                                <div style="color: #cbd5e1; font-size: 11px;">Target pantulan sekunder (multipath echo) ditekan pada tampilan PPI scope. Kasus di bawah menunjukkan anomali mentah pada transmisi receiver.</div>
                            </div>
                        </div>
                        <button onclick="window.toggleRadarIslsFilter(); window.openRadarDuplicateAuditModal();" style="background: rgba(239, 68, 68, 0.2); border: 1px solid #ef4444; color: #ff8888; font-size: 11px; font-weight: 700; padding: 4px 10px; border-radius: 4px; cursor: pointer;">Matikan Filter</button>
                    </div>
                `;
            } else {
                islsBannerHtml = `
                    <div style="background: rgba(15, 28, 52, 0.85); border: 1px solid rgba(0, 212, 255, 0.3); border-radius: 8px; padding: 12px 16px; margin-bottom: 14px; display: flex; align-items: center; justify-content: space-between;">
                        <div style="display: flex; align-items: center; gap: 10px;">
                            <i class="fas fa-shield-alt" style="color: #64748b; font-size: 20px;"></i>
                            <div>
                                <div style="color: #94a3b8; font-weight: 800; font-size: 12px;">SIMULASI FILTER ISLS: NONAKTIF (DEFAULT RAW STREAM)</div>
                                <div style="color: #cbd5e1; font-size: 11px;">Aktifkan untuk melihat bagaimana ISLS / RDP Screening menekan target hantu (ghost target) ini.</div>
                            </div>
                        </div>
                        <button onclick="window.toggleRadarIslsFilter(); window.openRadarDuplicateAuditModal();" style="background: rgba(0, 255, 136, 0.2); border: 1px solid #00ff88; color: #00ff88; font-size: 11px; font-weight: 700; padding: 4px 10px; border-radius: 4px; cursor: pointer;">Aktifkan ISLS</button>
                    </div>
                `;
            }

            if (report.length === 0) {
                listEl.innerHTML = islsBannerHtml + `
                    <div style="text-align: center; color: #64748b; padding: 40px 20px; font-size: 13px;">
                        <i class="fas fa-check-circle" style="color: #00ff88; font-size: 32px; margin-bottom: 12px; display: block;"></i>
                        Tidak terdeteksi target ganda atau plot splitting pada transmisi ASTERIX saat ini.<br>
                        <span style="font-size: 11px; color: #475569;">Radar beroperasi secara normal (single track per target).</span>
                    </div>
                `;
            } else {
                listEl.innerHTML = islsBannerHtml + report.map((item, idx) => {
                    const tA = item.targetA;
                    const tB = item.targetB;
                    return `
                        <div style="background: rgba(15, 28, 52, 0.85); border: 1px solid rgba(239, 68, 68, 0.35); border-radius: 8px; padding: 14px 16px;">
                            <div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid rgba(255, 255, 255, 0.08); padding-bottom: 8px; margin-bottom: 10px;">
                                <div style="display: flex; align-items: center; gap: 8px;">
                                    <span style="background: #ef4444; color: #fff; font-size: 10px; font-weight: 800; padding: 2px 6px; border-radius: 4px;">KASUS #${idx + 1}</span>
                                    <span style="font-weight: 800; color: #ff8888; font-size: 12px;">${item.category}</span>
                                </div>
                                <span style="font-size: 11px; color: #94a3b8; font-family: monospace;">ΔRange: <strong style="color: #00ffff;">${item.deltaRange} NM</strong> | ΔAzim: <strong style="color: #00ffff;">${item.deltaAzim}°</strong> | ΔAlt: <strong style="color: #ffcc00;">FL${item.deltaFl}</strong></span>
                            </div>

                            <!-- Target Pair Info -->
                            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 12px; font-size: 11px; font-family: monospace;">
                                <div style="background: rgba(8, 16, 32, 0.6); padding: 8px 12px; border-radius: 6px; border-left: 3px solid #00d4ff;">
                                    <div style="color: #00d4ff; font-weight: bold; margin-bottom: 4px;">TARGET 1: ${tA.callsign || tA.id}</div>
                                    <div style="color: #cbd5e1;">Squawk: <strong style="color: #ffcc00;">SQ ${tA.squawk || '—'}</strong> | FL${tA.fl || '—'}</div>
                                    <div style="color: #94a3b8;">Polar: ${tA.range_nm || 0} NM (${tA.azimuth_deg || 0}°)</div>
                                    <div style="color: #64748b; font-size: 10px;">Pos: ${tA.lat || '—'}, ${tA.lon || '—'}</div>
                                </div>
                                <div style="background: rgba(8, 16, 32, 0.6); padding: 8px 12px; border-radius: 6px; border-left: 3px solid #ff5555;">
                                    <div style="color: #ff8888; font-weight: bold; margin-bottom: 4px;">TARGET 2 (DOBEL): ${tB.callsign || tB.id}</div>
                                    <div style="color: #cbd5e1;">Squawk: <strong style="color: #ffcc00;">SQ ${tB.squawk || '—'}</strong> | FL${tB.fl || '—'}</div>
                                    <div style="color: #94a3b8;">Polar: ${tB.range_nm || 0} NM (${tB.azimuth_deg || 0}°)</div>
                                    <div style="color: #64748b; font-size: 10px;">Pos: ${tB.lat || '—'}, ${tB.lon || '—'}</div>
                                </div>
                            </div>

                            <!-- Diagnosis & Suggestions -->
                            <div style="background: rgba(2, 6, 14, 0.5); padding: 10px 12px; border-radius: 6px; display: flex; flex-direction: column; gap: 6px; font-size: 11px;">
                                <div>
                                    <span style="color: #ffcc00; font-weight: bold;"><i class="fas fa-stethoscope"></i> Indikasi:</span>
                                    <span style="color: #e2e8f0; margin-left: 4px;">${item.reason}</span>
                                </div>
                                <div>
                                    <span style="color: #f87171; font-weight: bold;"><i class="fas fa-wrench"></i> Estimasi Masalah:</span>
                                    <span style="color: #cbd5e1; margin-left: 4px;">${item.probableCause}</span>
                                </div>
                                <div>
                                    <span style="color: #4ade80; font-weight: bold;"><i class="fas fa-lightbulb"></i> Saran Tindakan Teknisi:</span>
                                    <span style="color: #f0fdf4; margin-left: 4px;">${item.recommendation}</span>
                                </div>
                            </div>
                        </div>
                    `;
                }).join('');
            }
        }

        modal.style.display = 'flex';
    };

    window.closeRadarDuplicateAuditModal = function () {
        const modal = document.getElementById('radarDuplicateAuditModal');
        if (modal) modal.style.display = 'none';
    };

    // Auto-init styles on load
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', addAuditRadarStyles);
    } else {
        addAuditRadarStyles();
    }

})();
