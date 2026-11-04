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
    let _mapTheme = 'light'; // Default 'light' (peta terang) sesuai permintaan
    let _lastRadarCoords = { lat: -4.5284, lon: 136.8860 }; // Default Timika (atau dinamik dari sumber data)

    // Formula Geodetik Standar WGS84 (Great Circle / Rhumb Line)
    function calculatePolarToLatLon(radarLat, radarLon, rangeNm, azimuthDeg) {
        if (!radarLat || !radarLon) return { lat: 0, lon: 0 };
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
    function detectDuplicateTargets(targets = []) {
        const doubleMap = new Map(); // id -> boolean
        const count = targets.length;

        for (let i = 0; i < count; i++) {
            const a = targets[i];
            const aId = String(a.id || '');
            const aSq = String(a.squawk || '').trim();
            const aR = Number(a.range_nm) || 0;
            const aAz = Number(a.azimuth_deg) || 0;

            for (let j = i + 1; j < count; j++) {
                const b = targets[j];
                const bId = String(b.id || '');
                const bSq = String(b.squawk || '').trim();
                const bR = Number(b.range_nm) || 0;
                const bAz = Number(b.azimuth_deg) || 0;

                let isDup = false;

                // Kriteria 1: Squawk khusus identik
                if (aSq && bSq && aSq !== '—' && aSq !== '1200' && aSq !== '7000' && aSq === bSq) {
                    isDup = true;
                }

                // Kriteria 2: Proksimitas Polar
                const dR = Math.abs(aR - bR);
                let dAz = Math.abs(aAz - bAz);
                if (dAz > 180) dAz = 360 - dAz;

                if (dR <= 1.2 && dAz <= 1.2 && aR > 0 && bR > 0) {
                    isDup = true;
                }

                if (isDup) {
                    doubleMap.set(aId, true);
                    doubleMap.set(bId, true);
                }
            }
        }
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
                            <span id="radarDoubleSummaryBadge" style="display:none; font-size:10px; background:rgba(239,68,68,0.2); color:#ff5555; border:1px solid #ef4444; border-radius:4px; padding:2px 7px; font-weight:700;">
                                <i class="fas fa-exclamation-triangle"></i> <span id="radarDoubleCountText">0 Double</span>
                            </span>
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
                    <!-- Toggle Peta -->
                    <button class="radar-tab-btn" id="radarToggleMapBtn" onclick="window.toggleRadarMap()" style="border-color: #00ffcc; color: #00ffcc;">
                        <i class="fas fa-map"></i> Peta: <span id="radarMapStateText">AKTIF</span>
                    </button>
                    <!-- Mode Terang / Gelap Peta -->
                    <button class="radar-tab-btn" id="radarMapThemeBtn" onclick="window.toggleRadarMapTheme()" style="border-color: #38bdf8; color: #38bdf8;" title="Ganti mode peta Terang / Gelap">
                        <i class="fas fa-sun"></i> Mode: <span id="radarMapThemeText">TERANG</span>
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
                    </div>

                    <!-- Sub-panel Target List -->
                    <div class="radar-targets-panel">
                        <div style="display: flex; justify-content: space-between; align-items: center;">
                            <span style="font-size: 10px; font-weight: 700; color: #64748b; letter-spacing: 0.5px; text-transform: uppercase;">
                                <i class="fas fa-plane" style="color: #00ffcc;"></i> DAFTAR PESAWAT AKTIF (ASTERIX CAT 048) — <span id="radarDoubleNotice" style="color: #ff5555; display: none;">TARGET BERTUMPUK / MERAH = GANDA (DUPLICATE)</span>
                            </span>
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
            <div id="radarRefModal" style="display: none; position: absolute; top: 0; left: 0; width: 100%; height: 100%; background: rgba(2, 6, 14, 0.85); z-index: 10000; align-items: center; justify-content: center; backdrop-filter: blur(4px);">
                <div style="background: #091322; border: 1px solid #00d4ff; border-radius: 8px; width: 380px; max-width: 90%; padding: 20px; box-shadow: 0 10px 30px rgba(0, 212, 255, 0.3);">
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
        `;
        document.body.appendChild(sidebar);

        // Attach mouse events to canvas
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
            canvas.addEventListener('click', () => {
                if (_radarHoveredTarget) {
                    _radarSelectedTargetId = _radarHoveredTarget.id;
                    updateRadarPpiTargetsUI();
                } else {
                    _radarSelectedTargetId = null;
                    updateRadarPpiTargetsUI();
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
            return 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png';
        }
        // Mode Terang (CartoDB Positron - Peta Terang Elegan, Kontur, Pulau, Kota Jelas)
        return 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png';
    }

    function initOrUpdateRadarMap(lat, lon, rangeNm) {
        if (typeof L === 'undefined') return;
        const container = document.getElementById('radarMapUnderlay');
        if (!container) return;

        if (!lat || !lon || isNaN(lat) || isNaN(lon) || (lat === 0 && lon === 0)) {
            // Default ke koordinat Timika (-4.5284, 136.8860) jika data belum terisi
            lat = -4.5284;
            lon = 136.8860;
        }
        _lastRadarCoords = { lat: parseFloat(lat), lon: parseFloat(lon) };

        // Konversi range (NM) ke perkiraan Leaflet Zoom level
        // 40 NM ~ zoom 9; 80 NM ~ zoom 8; 120 NM ~ zoom 7; 200 NM ~ zoom 6
        let zoom = 7;
        if (rangeNm <= 45) zoom = 9;
        else if (rangeNm <= 85) zoom = 8;
        else if (rangeNm <= 140) zoom = 7;
        else zoom = 6;

        if (!_radarMap) {
            _radarMap = L.map('radarMapUnderlay', {
                center: [_lastRadarCoords.lat, _lastRadarCoords.lon],
                zoom: zoom,
                zoomControl: false,
                attributionControl: false,
                dragging: false,
                scrollWheelZoom: false,
                doubleClickZoom: false,
                boxZoom: false,
                keyboard: false
            });

            _radarTileLayer = L.tileLayer(getTileLayerUrl(_mapTheme), {
                subdomains: 'abcd',
                maxZoom: 19
            }).addTo(_radarMap);
        } else {
            _radarMap.setView([_lastRadarCoords.lat, _lastRadarCoords.lon], zoom, { animate: false });
            _radarMap.invalidateSize();
        }

        container.style.opacity = _isMapEnabled ? '0.88' : '0.0';
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
                subdomains: 'abcd',
                maxZoom: 19
            }).addTo(_radarMap);
        }
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

    window.setRadarPpiRange = function (rangeNm) {
        _radarRangeNm = rangeNm;
        document.querySelectorAll('.radar-range-btn').forEach(btn => {
            if (btn.textContent.includes(`${rangeNm} NM`)) {
                btn.classList.add('active');
            } else {
                btn.classList.remove('active');
            }
        });
        const data = getActiveRadarSourceData() || {};
        initOrUpdateRadarMap(data.lat, data.lon, _radarRangeNm);
    };

    function updateRadarPpiScopeData() {
        const { src, data } = findRadarSourceAndData(_activeRadarSourceId);
        if (!data) return;

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
        const targets = Array.isArray(data.targets_detail) ? data.targets_detail : [];
        const doubleMap = detectDuplicateTargets(targets);

        const badge = document.getElementById('radarTargetCountBadge');
        if (badge) {
            badge.innerHTML = `<strong style="color: #00ffcc;">${targets.length}</strong> Pesawat Terdeteksi`;
        }

        // Counter Double Targets
        let doubleCount = 0;
        for (const isDup of doubleMap.values()) {
            if (isDup) doubleCount++;
        }
        const doubleBadge = document.getElementById('radarDoubleSummaryBadge');
        const doubleText = document.getElementById('radarDoubleCountText');
        const doubleNotice = document.getElementById('radarDoubleNotice');
        if (doubleBadge && doubleText) {
            if (doubleCount > 0) {
                doubleBadge.style.display = 'inline-flex';
                doubleText.textContent = `${doubleCount} Target Dobel Terdeteksi`;
                if (doubleNotice) doubleNotice.style.display = 'inline';
            } else {
                doubleBadge.style.display = 'none';
                if (doubleNotice) doubleNotice.style.display = 'none';
            }
        }

        const lastCatEl = document.getElementById('radarLastCat048Text');
        if (lastCatEl) {
            lastCatEl.textContent = `Update: ${data.last_cat048 ? new Date(data.last_cat048).toLocaleTimeString('id-ID') : 'Real-time'}`;
        }

        const strip = document.getElementById('radarTargetsStrip');
        if (!strip) return;

        if (targets.length === 0) {
            strip.innerHTML = `<span style="color: #475569; font-size: 11px; padding: 10px;">Menunggu deteksi target CAT 048 dari transmisi radar...</span>`;
            return;
        }

        strip.innerHTML = targets.map(t => {
            const isSel = String(t.id) === String(_radarSelectedTargetId);
            const isDouble = doubleMap.get(String(t.id)) === true;
            let cLat = t.lat;
            let cLon = t.lon;
            if (!cLat || !cLon || isNaN(cLat) || isNaN(cLon) || (cLat === 0 && cLon === 0)) {
                const geo = calculatePolarToLatLon(_lastRadarCoords.lat, _lastRadarCoords.lon, t.range_nm || 0, t.azimuth_deg || 0);
                cLat = geo.lat;
                cLon = geo.lon;
            }
            return `
                <div class="radar-target-card ${isSel ? 'highlight' : ''} ${isDouble ? 'is-double' : ''}" onclick="window.selectRadarTarget('${t.id}')">
                    <div class="tgt-id">
                        <span><i class="fas fa-plane" style="font-size: 9px;"></i> ${t.callsign || t.id}</span>
                        ${isDouble ? '<span style="font-size: 8px; background: #ef4444; color: #fff; padding: 1px 4px; border-radius: 3px;">DOUBLE</span>' : ''}
                    </div>
                    <div class="tgt-info">FL${t.fl || Math.round((t.alt || 0) / 100)} | ${t.range_nm || 0} NM (${t.azimuth_deg || 0}°)</div>
                    <div class="tgt-info" style="color: #38bdf8;">📍 ${cLat.toFixed(3)}, ${cLon.toFixed(3)}</div>
                </div>
            `;
        }).join('');
    }

    window.selectRadarTarget = function (tgtId) {
        _radarSelectedTargetId = tgtId;
        updateRadarPpiTargetsUI();
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

        const cx = w / 2;
        const cy = h / 2;
        const maxRadius = Math.min(w, h) * 0.44;

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
        const targets = (srcData && Array.isArray(srcData.targets_detail)) ? srcData.targets_detail : [];
        const doubleMap = detectDuplicateTargets(targets);

        let currentHovered = null;

        targets.forEach(tgt => {
            const range = Number(tgt.range_nm) || 0;
            const azim = Number(tgt.azimuth_deg) || 0;
            if (range <= 0 || range > _radarRangeNm * 1.05) return;

            const distPx = (range / _radarRangeNm) * maxRadius;
            const targetRad = (azim - 90) * (Math.PI / 180);
            const tx = cx + distPx * Math.cos(targetRad);
            const ty = cy + distPx * Math.sin(targetRad);

            // Deteksi Hover
            const dx = _radarMousePos.x - tx;
            const dy = _radarMousePos.y - ty;
            const isHovered = Math.sqrt(dx * dx + dy * dy) <= 22;
            const isSelected = String(tgt.id) === String(_radarSelectedTargetId);
            const isDouble = doubleMap.get(String(tgt.id)) === true;

            // Hitung koordinat geografis presisi (WGS84) jika belum ada dari sensor
            let tgtLat = tgt.lat;
            let tgtLon = tgt.lon;
            if (!tgtLat || !tgtLon || isNaN(tgtLat) || isNaN(tgtLon) || (tgtLat === 0 && tgtLon === 0)) {
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

            ctx.save();
            ctx.translate(tx, ty);

            // Heading speed vector line
            const headingDeg = Number(tgt.heading) || azim;
            const headingRad = (headingDeg - 90) * (Math.PI / 180);
            ctx.beginPath();
            ctx.moveTo(0, 0);
            ctx.lineTo(16 * Math.cos(headingRad), 16 * Math.sin(headingRad));
            ctx.strokeStyle = isDouble ? '#ff4444' : (isSelected ? '#ffcc00' : 'rgba(0, 255, 204, 0.6)');
            ctx.lineWidth = 1.5;
            ctx.stroke();

            // Rotasi ikon pesawat
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
                ctx.shadowColor = '#00ff88';
                ctx.shadowBlur = 8;
            } else {
                ctx.fillStyle = '#00d4ff';
                ctx.shadowBlur = 0;
            }
            ctx.fill();
            ctx.strokeStyle = '#05101a';
            ctx.lineWidth = 1;
            ctx.stroke();
            ctx.restore();

            // Lingkaran Target Reticle jika Hovered atau Selected
            if (isHovered || isSelected) {
                ctx.beginPath();
                ctx.arc(tx, ty, 14, 0, Math.PI * 2);
                ctx.strokeStyle = isDouble ? '#ff3344' : (isSelected ? '#ffcc00' : '#00ffff');
                ctx.lineWidth = 1.5;
                ctx.setLineDash([4, 4]);
                ctx.stroke();
                ctx.setLineDash([]);
            }

            // Data Tag Pesawat (ID di atas, Alt di bawah)
            ctx.font = '10px monospace';
            ctx.fillStyle = isDouble ? '#ff5555' : (isSelected ? '#ffcc00' : (_mapTheme === 'light' ? '#0f172a' : '#00ffcc'));
            ctx.textAlign = 'left';
            const tagLabel = isDouble ? `⚠ ${tgt.callsign || tgt.id} [DBL]` : (tgt.callsign || tgt.id);
            ctx.fillText(tagLabel, tx + 12, ty - 2);

            ctx.font = '9px monospace';
            ctx.fillStyle = isDouble ? '#fca5a5' : (_mapTheme === 'light' ? '#334155' : '#94a3b8');
            const altLabel = tgt.fl ? `FL${tgt.fl}` : (tgt.alt ? `${tgt.alt}ft` : 'FL—');
            ctx.fillText(`${altLabel} · SQ${tgt.squawk || '—'}`, tx + 12, ty + 10);
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
                        hudStatus.textContent = 'Normal Single Plot';
                        hudStatus.style.color = '#00ff88';
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

    // Auto-init styles on load
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', addAuditRadarStyles);
    } else {
        addAuditRadarStyles();
    }

})();
