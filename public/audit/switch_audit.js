/**
 * public/audit/switch_audit.js
 * Modul Audit Switch Real-time Layar Penuh (Fullscreen Modal / Dedicated View)
 * Kompatibel dengan tema gelap, localhost:3100, dan parser snmp_network_basic.
 * Bekerja murni dengan data realtime (tanpa database).
 */

(function () {
    'use strict';

    // State Audit Switch
    let _activeSwitchSourceId = null;
    let _activeSwitchTimer = null;
    let _activePortFilter = 'all';       // 'all' | 'up' | 'down' | 'issues'
    let _selectedPortName = null;
    let _lastAuditData = null;
    let _lastLiveData = null;
    let _activeTab = 'overview';        // 'overview' | 'ports' | 'findings'

    /**
     * Tambahkan style khusus untuk Switch Audit Modal Layar Penuh
     */
    function addSwitchAuditStyles() {
        if (document.getElementById('switchAuditStyles')) return;
        const style = document.createElement('style');
        style.id = 'switchAuditStyles';
        style.textContent = `
            #switchAuditOverlay {
                display: none;
                position: fixed !important;
                inset: 0 !important;
                background: rgba(3, 7, 18, 0.85) !important;
                backdrop-filter: blur(8px) !important;
                -webkit-backdrop-filter: blur(8px) !important;
                z-index: 99990 !important;
                transition: opacity 0.15s ease-out !important;
            }
            #switchAuditModal {
                display: flex !important;
                flex-direction: column !important;
                position: fixed !important;
                top: 0 !important;
                left: 0 !important;
                right: 0 !important;
                bottom: 0 !important;
                width: 100vw !important;
                height: 100vh !important;
                background: #030712 !important;
                box-shadow: 0 0 60px rgba(0, 0, 0, 0.95) !important;
                z-index: 99999 !important;
                transform: translateY(-100%) !important;
                transition: transform 0.18s cubic-bezier(0, 0, 0.2, 1) !important;
                color: #e2e8f0 !important;
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", sans-serif !important;
                overflow: hidden !important;
                margin: 0 !important;
                border: none !important;
            }
            #switchAuditModal.open {
                transform: translateY(0) !important;
            }
            .switch-audit-header {
                display: flex;
                align-items: center;
                justify-content: space-between;
                padding: 14px 24px;
                background: rgba(8, 16, 32, 0.98);
                border-bottom: 1px solid rgba(0, 212, 255, 0.25);
                gap: 16px;
                flex-shrink: 0;
            }
            .switch-audit-toolbar {
                display: flex;
                align-items: center;
                justify-content: space-between;
                padding: 8px 24px;
                background: #080f1d;
                border-bottom: 1px solid #1e293b;
                flex-shrink: 0;
                flex-wrap: wrap;
                gap: 10px;
            }
            .switch-tab-btn {
                background: transparent;
                color: #94a3b8;
                border: 1px solid #1e293b;
                border-radius: 6px;
                padding: 6px 14px;
                font-size: 12px;
                font-weight: 700;
                cursor: pointer;
                display: inline-flex;
                align-items: center;
                gap: 6px;
                transition: all 0.2s ease;
            }
            .switch-tab-btn:hover {
                background: rgba(255, 255, 255, 0.05);
                color: #ffffff;
            }
            .switch-tab-btn.active {
                background: rgba(0, 212, 255, 0.18);
                color: #00d4ff;
                border-color: #00d4ff;
            }
            .switch-audit-content {
                flex: 1;
                overflow-y: auto;
                padding: 20px 24px;
                background: #040914;
            }
            .custom-audit-scrollbar::-webkit-scrollbar {
                width: 6px;
            }
            .custom-audit-scrollbar::-webkit-scrollbar-track {
                background: rgba(15, 23, 42, 0.6);
                border-radius: 4px;
            }
            .custom-audit-scrollbar::-webkit-scrollbar-thumb {
                background: rgba(0, 212, 255, 0.3);
                border-radius: 4px;
            }
            .custom-audit-scrollbar::-webkit-scrollbar-thumb:hover {
                background: rgba(0, 212, 255, 0.6);
            }
        `;
        document.head.appendChild(style);
    }

    /**
     * Pastikan elemen modal switch audit terpasang di DOM
     */
    function ensureSwitchAuditDOMElements() {
        addSwitchAuditStyles();
        if (document.getElementById('switchAuditModal')) return;

        const overlay = document.createElement('div');
        overlay.id = 'switchAuditOverlay';
        overlay.onclick = () => window.closeSwitchAuditModal();
        document.body.appendChild(overlay);

        const modal = document.createElement('div');
        modal.id = 'switchAuditModal';
        modal.innerHTML = `
            <!-- Header Bar -->
            <div class="switch-audit-header">
                <div style="display: flex; align-items: center; gap: 12px;">
                    <i class="fas fa-network-wired" style="color: #00d4ff; font-size: 22px;"></i>
                    <div>
                        <div style="display: flex; align-items: center; gap: 10px;">
                            <span id="switchAuditTitle" style="font-size: 17px; font-weight: 800; color: #f8fafc; letter-spacing: 0.5px;">SWITCH NETWORK AUDIT & DIAGNOSTICS</span>
                            <span style="font-size: 11px; font-weight: 700; padding: 2px 8px; border-radius: 4px; background: rgba(0, 212, 255, 0.15); color: #00d4ff; border: 1px solid rgba(0, 212, 255, 0.35);">
                                SNMP REALTIME
                            </span>
                        </div>
                        <div id="switchAuditSubTitle" style="font-size: 11.5px; color: #64748b; font-family: monospace; margin-top: 2px;">
                            IP: — | Vendor: — | Model: —
                        </div>
                    </div>
                </div>

                <div style="display: flex; align-items: center; gap: 12px;">
                    <div id="switchAuditLivePill" style="display: flex; align-items: center; gap: 6px; font-size: 11px; color: #10b981; background: rgba(16, 185, 129, 0.15); border: 1px solid rgba(16, 185, 129, 0.35); padding: 4px 10px; border-radius: 6px;">
                        <span style="width: 8px; height: 8px; border-radius: 50%; background: #10b981; display: inline-block;"></span>
                        <span>Live In-Memory Polling</span>
                    </div>

                    <button onclick="window.switchAuditExportCsv()" style="background: rgba(0, 212, 255, 0.15); color: #00d4ff; border: 1px solid rgba(0, 212, 255, 0.4); padding: 6px 14px; border-radius: 6px; font-size: 12px; font-weight: 700; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; transition: all 0.2s;" onmouseover="this.style.background='rgba(0, 212, 255, 0.3)'" onmouseout="this.style.background='rgba(0, 212, 255, 0.15)'">
                        <i class="fas fa-file-csv"></i> Ekspor CSV
                    </button>

                    <button onclick="window.closeSwitchAuditModal()" style="background: rgba(239, 68, 68, 0.15); color: #f87171; border: 1px solid rgba(239, 68, 68, 0.35); border-radius: 6px; padding: 6px 12px; font-size: 12px; font-weight: 700; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; transition: all 0.2s;" onmouseover="this.style.background='rgba(239,68,68,0.3)'; this.style.color='#fff';" onmouseout="this.style.background='rgba(239,68,68,0.15)'; this.style.color='#f87171';">
                        <i class="fas fa-times"></i> Tutup
                    </button>
                </div>
            </div>

            <!-- Toolbar & Filter Port -->
            <div class="switch-audit-toolbar">
                <div style="display: flex; align-items: center; gap: 8px;">
                    <button class="switch-tab-btn active" id="switchTabBtnOverview" onclick="window.switchAuditSetTab('overview')">
                        <i class="fas fa-chart-pie"></i> Ringkasan & Kesehatan
                    </button>
                    <button class="switch-tab-btn" id="switchTabBtnPorts" onclick="window.switchAuditSetTab('ports')">
                        <i class="fas fa-ethernet"></i> Panel Port Fisik (Chassis)
                    </button>
                    <button class="switch-tab-btn" id="switchTabBtnFindings" onclick="window.switchAuditSetTab('findings')">
                        <i class="fas fa-clipboard-list"></i> Anomali & Rekomendasi (<span id="switchFindingsCountBadge">0</span>)
                    </button>
                </div>

                <div style="display: flex; align-items: center; gap: 8px;">
                    <span style="font-size: 12px; color: #94a3b8; font-weight: 600;"><i class="fas fa-filter"></i> Filter Port:</span>
                    <select id="switchPortFilterSelect" class="filter-select" onchange="window.switchAuditSetFilter(this.value)" style="background: #080e1a; border: 1px solid rgba(0, 212, 255, 0.25); border-radius: 6px; padding: 5px 10px; color: #00d4ff; font-size: 12px; font-weight: 600; cursor: pointer; outline: none;">
                        <option value="all">Semua Port</option>
                        <option value="up">Port Aktif (Up)</option>
                        <option value="down">Port Down</option>
                        <option value="issues">Bermasalah / Flapping</option>
                    </select>
                </div>
            </div>

            <!-- Content Area -->
            <div class="switch-audit-content" id="switchAuditBody">
                <div style="text-align: center; padding: 40px; color: #64748b;">
                    <i class="fas fa-spinner fa-spin fa-2x"></i>
                    <p style="margin-top: 10px;">Memuat data audit switch realtime...</p>
                </div>
            </div>
        `;
        document.body.appendChild(modal);
    }

    /**
     * Format nilai byte rate menjadi bps / Kbps / Mbps / Gbps
     */
    function formatBitRate(bps) {
        if (bps === null || bps === undefined || bps === 'menghitung...' || isNaN(bps)) {
            return bps === 'menghitung...' ? 'Menghitung...' : '—';
        }
        const num = parseFloat(bps);
        if (num <= 0) return '0 bps';
        if (num >= 1e9) return (num / 1e9).toFixed(2) + ' Gbps';
        if (num >= 1e6) return (num / 1e6).toFixed(2) + ' Mbps';
        if (num >= 1e3) return (num / 1e3).toFixed(2) + ' Kbps';
        return Math.round(num) + ' bps';
    }

    function formatNumber(num) {
        if (num === null || num === undefined || isNaN(num)) return '0';
        return Number(num).toLocaleString('id-ID');
    }

    // Cache persisten port antarmuka switch agar tidak pernah hilang/blank saat disconnect sementara
    const _cachedPortsBySource = new Map();
    // Cache riwayat octet client-side untuk perhitungan laju aliran (bps) secara realtime
    const _clientPortTrafficHistory = new Map();

    /**
     * Normalisasi array port/interface dari berbagai struktur
     */
    function getPortsList(auditData, liveData) {
        const audit = auditData || _lastAuditData;
        const live = liveData || _lastLiveData;
        let raw = audit?.interfaces || audit?.ports || [];

        // Fallback jika auditData interfaces belum terisi tapi ada active/down interfaces di audit atau live
        if (raw.length === 0) {
            const dataSource = (audit?.active_interfaces || audit?.down_interfaces) ? audit : live;
            if (dataSource) {
                const active = Array.isArray(dataSource.active_interfaces) ? dataSource.active_interfaces.map(i => ({ ...i, oper_status: 'up', admin_status: 'up' })) : [];
                const down = Array.isArray(dataSource.down_interfaces) ? dataSource.down_interfaces.map(i => ({ ...i, oper_status: 'down', admin_status: 'down' })) : [];
                raw = [...active, ...down];
            }
        }

        // Cache jika ditemukan port
        const cacheKey = _activeSwitchSourceId || 'default';
        if (raw.length > 0) {
            _cachedPortsBySource.set(cacheKey, raw);
        } else if (_cachedPortsBySource.has(cacheKey)) {
            // Gunakan port dari cache persisten jika paket SNMP saat ini timeout/kosong
            raw = _cachedPortsBySource.get(cacheKey) || [];
        }

        const now = Date.now();
        if (!_clientPortTrafficHistory.has(cacheKey)) {
            _clientPortTrafficHistory.set(cacheKey, new Map());
        }
        const portHistory = _clientPortTrafficHistory.get(cacheKey);

        return raw.map(p => {
            if (!p) return null;
            let portName = String(p.name || (p.index ? `Port ${p.index}` : 'Unknown')).trim();
            const originalIndex = p.index ? String(p.index) : (portName.match(/(\d+)$/) ? portName.match(/(\d+)$/)[1] : '');

            // Normalisasi nama port Alcatel: jika if1001..if1048 atau 1001..1048, konversi ke 1/X
            const alcatelIndexMatch = portName.match(/^(?:if)?10(\d{2})$/i);
            if (alcatelIndexMatch) {
                const portNum = parseInt(alcatelIndexMatch[1], 10);
                if (portNum >= 1 && portNum <= 60) {
                    portName = `1/${portNum}`;
                }
            }

            const inOct = Number(p.in_octets ?? p.inOctets) || 0;
            const outOct = Number(p.out_octets ?? p.outOctets) || 0;

            let inBps = p.in_bps ?? p.inBps;
            let outBps = p.out_bps ?? p.outBps;

            // Hitung delta bps di client jika backend belum mengisi atau masih 'menghitung...' / null
            if (inBps === null || inBps === undefined || inBps === 'menghitung...' || isNaN(inBps)) {
                if (portHistory.has(portName)) {
                    const prev = portHistory.get(portName);
                    const dt = (now - prev.time) / 1000;
                    if (dt >= 1) {
                        let dIn = inOct - prev.inOct;
                        let dOut = outOct - prev.outOct;
                        if (dIn >= 0 && dIn < 1e11) inBps = Math.round((dIn * 8) / dt);
                        if (dOut >= 0 && dOut < 1e11) outBps = Math.round((dOut * 8) / dt);
                    }
                }
            }

            // Simpan snapshot untuk putaran berikutnya jika octets berubah atau baru pertama kali
            if (!portHistory.has(portName) || portHistory.get(portName).inOct !== inOct || portHistory.get(portName).outOct !== outOct) {
                portHistory.set(portName, { inOct, outOct, time: now });
            }

            // Evaluasi oper_status: jika ada traffic aktif (bps > 0 atau total octets > 0), port adalah 'up'
            let operStatus = p.oper_status || (p.operStatus === 1 ? 'up' : (p.status === 'up' ? 'up' : 'down'));
            if (operStatus !== 'up' && ((inBps && inBps > 0) || (outBps && outBps > 0) || (inOct > 0 || outOct > 0))) {
                operStatus = 'up';
            }

            return {
                name: portName,
                index: originalIndex,
                raw_id: p.rawName || (originalIndex ? `if${originalIndex}` : portName),
                admin_status: p.admin_status || (p.adminStatus === 1 ? 'up' : 'down'),
                oper_status: operStatus,
                in_bps: inBps,
                out_bps: outBps,
                speed: p.speed || p.speedMbps,
                in_octets: inOct,
                out_octets: outOct,
                in_errors: p.in_errors ?? p.inErrors,
                out_errors: p.out_errors ?? p.outErrors,
                in_discards: p.in_discards ?? p.inDiscards,
                out_discards: p.out_discards ?? p.outDiscards,
                in_errors_delta: p.in_errors_delta ?? p.deltaErrors ?? 0,
                out_errors_delta: p.out_errors_delta ?? 0,
                is_flapping: !!p.is_flapping || !!p.isFlapping,
                last_change: p.last_change || (p.lastChangeTicks ? `${p.lastChangeTicks} ticks` : '—'),
                description: p.description || p.rawName || p.name
            };
        }).filter(Boolean);
    }

    /**
     * Evaluasi status visual port dengan perlindungan nilai null/undefined
     */
    function evaluatePortVisualStatus(port) {
        if (!port) {
            return { type: 'admin-down', color: '#64748b', bg: 'rgba(100, 116, 139, 0.12)', border: '#475569', icon: 'fa-stop', label: 'Unknown' };
        }
        const isUp = port.oper_status === 'up' || port.oper_status === 1;
        const isAdminUp = port.admin_status === 'up' || port.admin_status === 1;
        const hasDeltaErr = (port.in_errors_delta || 0) > 0 || (port.out_errors_delta || 0) > 0;
        const hasDeltaDisc = (port.in_discards_delta || 0) > 0 || (port.out_discards_delta || 0) > 0;
        const isFlapping = !!port.is_flapping;

        if (isFlapping || hasDeltaErr || hasDeltaDisc) {
            return {
                type: 'issues',
                color: '#eab308',
                bg: 'rgba(234, 179, 8, 0.18)',
                border: '#ca8a04',
                icon: 'fa-triangle-exclamation',
                label: isFlapping ? 'Flapping' : 'Error/Discard'
            };
        }

        if (isUp) {
            return {
                type: 'up',
                color: '#10b981',
                bg: 'rgba(16, 185, 129, 0.16)',
                border: '#059669',
                icon: 'fa-arrow-up',
                label: 'Up'
            };
        }

        if (!isAdminUp) {
            return {
                type: 'admin-down',
                color: '#64748b',
                bg: 'rgba(100, 116, 139, 0.12)',
                border: '#475569',
                icon: 'fa-stop',
                label: 'Admin Down'
            };
        }

        return {
            type: 'down',
            color: '#ef4444',
            bg: 'rgba(239, 68, 68, 0.18)',
            border: '#dc2626',
            icon: 'fa-arrow-down',
            label: 'Down (Admin Up)'
        };
    }

    /**
     * Pisahkan port menjadi port fisik terurut dan port virtual/mgmt
     */
    function categorizePorts(ports) {
        const physical = [];
        const special = [];

        if (!Array.isArray(ports)) return { physical, special };

        ports.forEach(p => {
            if (!p) return;
            const name = String(p.name || '').trim();
            const desc = String(p.description || '').trim();

            // Port khusus: Loopback, VLAN, Management, CPU, Dummy, Null
            const isSpecialName = name.match(/^(?:lo|loopback|vlan|mgmt|management|null|dummy|cpu)/i) ||
                (p.type && String(p.type).match(/softwareLoopback|propVirtual/i)) ||
                desc.match(/loopback|vlan|management/i);

            // Port stacking Alcatel / Cisco misal 1/StackA, 1/StackB
            const isStackSpecial = name.match(/stack/i) && !name.match(/\/\d+$/);

            if (isSpecialName || isStackSpecial) {
                special.push(p);
            } else {
                physical.push(p);
            }
        });

        // Jika semua port masuk ke special tapi tidak ada physical, perlakukan semua sebagai physical agar faceplate tetap tampil
        if (physical.length === 0 && special.length > 0) {
            physical.push(...special);
            special.length = 0;
        }

        physical.sort((a, b) => {
            return String(a.name).localeCompare(String(b.name), undefined, { numeric: true, sensitivity: 'base' });
        });

        special.sort((a, b) => {
            return String(a.name).localeCompare(String(b.name), undefined, { numeric: true, sensitivity: 'base' });
        });

        return { physical, special };
    }

    /**
     * Render kartu ringkasan eksekutif
     */
    function renderSummaryCards(auditData, liveData) {
        const rawHs = auditData?.health_score;
        let hsLevel = typeof rawHs === 'string' ? rawHs : (rawHs?.level || 'Normal');
        let hsScore = typeof rawHs === 'object' && rawHs?.score !== undefined ? rawHs.score : (hsLevel === 'Kritis' ? 45 : (hsLevel === 'Peringatan' ? 75 : 100));

        const portList = getPortsList(auditData, liveData);
        const totalPorts = auditData?.total_interfaces ?? portList.length;
        const upPorts = auditData?.active_interfaces ?? portList.filter(p => p.oper_status === 'up').length;
        const downPorts = auditData?.down_interfaces ?? (totalPorts - upPorts);

        let badgeBg = 'rgba(16, 185, 129, 0.18)';
        let badgeColor = '#10b981';
        let badgeBorder = 'rgba(16, 185, 129, 0.4)';
        let badgeIcon = 'fa-circle-check';

        if (hsLevel === 'Kritis') {
            badgeBg = 'rgba(239, 68, 68, 0.2)';
            badgeColor = '#ef4444';
            badgeBorder = 'rgba(239, 68, 68, 0.45)';
            badgeIcon = 'fa-triangle-exclamation';
        } else if (hsLevel === 'Peringatan') {
            badgeBg = 'rgba(234, 179, 8, 0.2)';
            badgeColor = '#eab308';
            badgeBorder = 'rgba(234, 179, 8, 0.45)';
            badgeIcon = 'fa-circle-exclamation';
        }

        const cpuVal = auditData?.cpu_usage || (auditData?.system_info?.cpu_load_pct ? `${auditData.system_info.cpu_load_pct}%` : (liveData?.cpu_usage ? `${liveData.cpu_usage}%` : '—'));
        const ramVal = auditData?.ram_usage || (auditData?.system_info?.ram_usage_pct ? `${auditData.system_info.ram_usage_pct}%` : (liveData?.ram_usage_pct ? `${liveData.ram_usage_pct}%` : '—'));
        const tempVal = auditData?.temperature_c || (auditData?.system_info?.temperature_c ? `${auditData.system_info.temperature_c}°C` : (liveData?.temperature_c ? `${liveData.temperature_c}°C` : '—'));
        const uptimeVal = auditData?.system_info?.uptime_str || liveData?.sys_uptime || '—';

        return `
            <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; margin-bottom: 20px;">
                <!-- Health Score -->
                <div style="background: #091322; border: 1px solid ${badgeBorder}; border-radius: 10px; padding: 14px 16px; display: flex; flex-direction: column; justify-content: space-between;">
                    <div style="font-size: 11px; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.5px; font-weight: 700;">Status Kesehatan</div>
                    <div style="display: flex; align-items: baseline; gap: 8px; margin-top: 6px;">
                        <span style="font-size: 24px; font-weight: 800; color: ${badgeColor};">${hsScore}</span>
                        <span style="font-size: 11.5px; font-weight: 700; color: ${badgeColor}; padding: 2px 8px; border-radius: 4px; background: ${badgeBg};">
                            <i class="fas ${badgeIcon}"></i> ${hsLevel}
                        </span>
                    </div>
                </div>

                <!-- Interface Aktif / Total -->
                <div style="background: #091322; border: 1px solid #1e293b; border-radius: 10px; padding: 14px 16px;">
                    <div style="font-size: 11px; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.5px; font-weight: 700;">Interface Aktif</div>
                    <div style="font-size: 22px; font-weight: 700; color: #f8fafc; margin-top: 6px;">
                        <span style="color: #10b981;">${upPorts}</span>
                        <span style="font-size: 14px; color: #64748b; font-weight: 500;">/ ${totalPorts}</span>
                    </div>
                </div>

                <!-- Interface Down -->
                <div style="background: #091322; border: 1px solid #1e293b; border-radius: 10px; padding: 14px 16px;">
                    <div style="font-size: 11px; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.5px; font-weight: 700;">Interface Down</div>
                    <div style="font-size: 22px; font-weight: 700; color: ${Number(downPorts) > 0 ? '#ef4444' : '#94a3b8'}; margin-top: 6px;">
                        ${downPorts}
                    </div>
                </div>

                <!-- Suhu Switch -->
                <div style="background: #091322; border: 1px solid #1e293b; border-radius: 10px; padding: 14px 16px;">
                    <div style="font-size: 11px; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.5px; font-weight: 700;">Suhu Internal</div>
                    <div style="font-size: 20px; font-weight: 700; color: #38bdf8; margin-top: 6px;">
                        <i class="fas fa-temperature-half" style="font-size: 16px; margin-right: 4px;"></i> ${tempVal}
                    </div>
                </div>

                <!-- CPU Load -->
                <div style="background: #091322; border: 1px solid #1e293b; border-radius: 10px; padding: 14px 16px;">
                    <div style="font-size: 11px; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.5px; font-weight: 700;">Beban CPU</div>
                    <div style="font-size: 20px; font-weight: 700; color: #a78bfa; margin-top: 6px;">
                        <i class="fas fa-microchip" style="font-size: 16px; margin-right: 4px;"></i> ${cpuVal}
                    </div>
                </div>

                <!-- RAM Usage -->
                <div style="background: #091322; border: 1px solid #1e293b; border-radius: 10px; padding: 14px 16px;">
                    <div style="font-size: 11px; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.5px; font-weight: 700;">Penggunaan RAM</div>
                    <div style="font-size: 20px; font-weight: 700; color: #06b6d4; margin-top: 6px;">
                        <i class="fas fa-memory" style="font-size: 16px; margin-right: 4px;"></i> ${ramVal}
                    </div>
                </div>

                <!-- Uptime -->
                <div style="background: #091322; border: 1px solid #1e293b; border-radius: 10px; padding: 14px 16px; grid-column: span 2;">
                    <div style="font-size: 11px; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.5px; font-weight: 700;">Waktu Aktif (SysUpTime)</div>
                    <div style="font-size: 14px; font-weight: 600; color: #e2e8f0; margin-top: 8px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${uptimeVal}">
                        <i class="fas fa-clock" style="color: #64748b; margin-right: 6px;"></i> ${uptimeVal}
                    </div>
                </div>
            </div>
        `;
    }

    /**
     * Render grid switch physical ports (Ganjil di atas, Genap di bawah)
     */
    function renderPortGrid(ports, selectedPortName) {
        if (!Array.isArray(ports) || ports.length === 0) {
            return `
                <div style="padding: 30px; text-align: center; color: #64748b; background: #091322; border-radius: 10px; border: 1px dashed #1e293b;">
                    <i class="fas fa-network-wired" style="font-size: 28px; margin-bottom: 10px; display: block; color: #475569;"></i>
                    Tidak ada port fisik yang ditemukan atau perangkat belum merespons IF-MIB.
                </div>
            `;
        }

        const { physical, special } = categorizePorts(ports);

        function matchesFilter(p) {
            if (_activePortFilter === 'all') return true;
            const st = evaluatePortVisualStatus(p);
            if (_activePortFilter === 'up') return st.type === 'up';
            if (_activePortFilter === 'down') return st.type === 'down' || st.type === 'admin-down';
            if (_activePortFilter === 'issues') return st.type === 'issues';
            return true;
        }

        const rowOdd = [];
        const rowEven = [];

        physical.forEach((p, idx) => {
            const numMatch = String(p.name).match(/(\d+)$/);
            const portNum = numMatch ? parseInt(numMatch[1], 10) : (idx + 1);

            if (portNum % 2 !== 0) {
                rowOdd.push({ port: p, num: portNum });
            } else {
                rowEven.push({ port: p, num: portNum });
            }
        });

        // Jika pembagian ganjil/genap timpang (misal penamaan port bukan angka murni), bagi 50/50
        if (rowOdd.length === 0 && rowEven.length > 0) {
            const half = Math.ceil(rowEven.length / 2);
            rowOdd.push(...rowEven.splice(0, half));
        } else if (rowEven.length === 0 && rowOdd.length > 1) {
            const half = Math.floor(rowOdd.length / 2);
            rowEven.push(...rowOdd.splice(half));
        }

        function renderPortCell(itemOrPort, isSpecial = false) {
            const p = itemOrPort.port ? itemOrPort.port : itemOrPort;
            if (!p) return '';
            const st = evaluatePortVisualStatus(p);
            const isMatch = matchesFilter(p);
            const isSelected = selectedPortName === p.name;

            const opacity = isMatch ? '1' : '0.25';
            const selBorder = isSelected ? '2px solid #00d4ff' : `1px solid ${st.border}`;
            const selShadow = isSelected ? '0 0 12px rgba(0, 212, 255, 0.6)' : 'none';

            if (isSpecial) {
                // Tampilan rapi untuk port khusus (Management / Stacking / Virtual): Box ikon di atas, teks nama port di bawah
                const tooltipText = p.raw_id && p.raw_id !== p.name ? `Port ${p.name} (ID: ${p.raw_id})` : `Port ${p.name}`;
                return `
                    <div class="switch-port-cell-special"
                         data-port-name="${p.name}"
                         title="${tooltipText}"
                         onclick="window.switchAuditSelectPort('${encodeURIComponent(p.name)}')"
                         style="display: flex; flex-direction: column; align-items: center; gap: 6px; cursor: pointer; user-select: none; opacity: ${opacity}; transition: transform 0.15s ease;"
                         onmouseover="this.style.transform='translateY(-2px)'"
                         onmouseout="this.style.transform='none'">
                        <!-- Kotak Port Ikon -->
                        <div style="width: 50px; height: 42px; background: ${st.bg}; border: ${selBorder}; box-shadow: ${selShadow};
                                    border-radius: 6px; display: flex; flex-direction: column; align-items: center; justify-content: center;">
                            <i class="fas ${st.icon}" style="font-size: 13px; color: ${st.color};"></i>
                            ${p.is_flapping ? '<span style="width: 5px; height: 5px; border-radius: 50%; background: #eab308; margin-top: 3px; display: inline-block;"></span>' : ''}
                        </div>
                        <!-- Teks Nama Port di Bawah Kotak -->
                        <span style="font-size: 10.5px; font-weight: 600; color: #cbd5e1; font-family: monospace; max-width: 90px; text-align: center; word-break: break-word; line-height: 1.2;">
                            ${p.name}
                        </span>
                    </div>
                `;
            }

            const cleanName = String(p.name).replace(/^(?:port|ethernet|fastethernet|gigabitethernet)/i, '').trim();
            const tooltipText = p.raw_id && p.raw_id !== p.name ? `Port ${p.name} (ID: ${p.raw_id})` : `Port ${p.name}`;

            return `
                <div class="switch-port-cell"
                     data-port-name="${p.name}"
                     title="${tooltipText}"
                     onclick="window.switchAuditSelectPort('${encodeURIComponent(p.name)}')"
                     style="width: 52px; height: 46px; background: ${st.bg}; border: ${selBorder}; box-shadow: ${selShadow};
                            border-radius: 6px; display: flex; flex-direction: column; align-items: center; justify-content: center;
                            cursor: pointer; position: relative; transition: all 0.15s ease; opacity: ${opacity}; flex-shrink: 0; user-select: none;">
                    <span style="font-size: 11px; font-weight: 700; color: #f1f5f9; font-family: monospace; line-height: 1;">
                        ${cleanName}
                    </span>
                    <div style="margin-top: 4px; display: flex; align-items: center; gap: 4px;">
                        <i class="fas ${st.icon}" style="font-size: 9.5px; color: ${st.color};"></i>
                        ${p.is_flapping ? '<span style="width: 5px; height: 5px; border-radius: 50%; background: #eab308; display: inline-block;"></span>' : ''}
                    </div>
                </div>
            `;
        }

        return `
            <div style="background: #091322; border: 1px solid #1e293b; border-radius: 10px; padding: 18px; margin-bottom: 20px;">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px; flex-wrap: wrap; gap: 8px;">
                    <div style="display: flex; align-items: center; gap: 8px;">
                        <i class="fas fa-layer-group" style="color: #00d4ff; font-size: 16px;"></i>
                        <span style="font-size: 14px; font-weight: 700; color: #f1f5f9;">Panel Port Fisik Switch (Chassis Faceplate)</span>
                        <span style="font-size: 11px; color: #64748b;">— Baris Atas: Ganjil | Baris Bawah: Genap</span>
                    </div>
                </div>

                <!-- Chassis Rack Faceplate -->
                <div id="switchAuditChassisScroll" style="background: #040812; border: 2px solid #1e293b; border-radius: 8px; padding: 16px; overflow-x: auto; box-shadow: inset 0 2px 10px rgba(0,0,0,0.7);">
                    <div style="display: flex; flex-direction: column; gap: 10px; min-width: max-content;">
                        <!-- Row 1: Ganjil -->
                        <div style="display: flex; gap: 8px;">
                            ${rowOdd.map(item => renderPortCell(item, false)).join('')}
                        </div>
                        <!-- Row 2: Genap -->
                        <div style="display: flex; gap: 8px;">
                            ${rowEven.map(item => renderPortCell(item, false)).join('')}
                        </div>
                    </div>
                </div>

                <!-- Port Legenda -->
                <div style="display: flex; gap: 16px; margin-top: 14px; font-size: 11.5px; color: #94a3b8; flex-wrap: wrap; align-items: center;">
                    <span style="font-weight: 700; color: #64748b;">Legenda Status:</span>
                    <span style="display: inline-flex; align-items: center; gap: 5px;">
                        <span style="width: 10px; height: 10px; background: rgba(16, 185, 129, 0.3); border: 1px solid #10b981; border-radius: 2px;"></span>
                        <i class="fas fa-arrow-up" style="color: #10b981; font-size: 10px;"></i> Link Up
                    </span>
                    <span style="display: inline-flex; align-items: center; gap: 5px;">
                        <span style="width: 10px; height: 10px; background: rgba(239, 68, 68, 0.3); border: 1px solid #ef4444; border-radius: 2px;"></span>
                        <i class="fas fa-arrow-down" style="color: #ef4444; font-size: 10px;"></i> Down (Admin Up)
                    </span>
                    <span style="display: inline-flex; align-items: center; gap: 5px;">
                        <span style="width: 10px; height: 10px; background: rgba(100, 116, 139, 0.2); border: 1px solid #64748b; border-radius: 2px;"></span>
                        <i class="fas fa-stop" style="color: #64748b; font-size: 10px;"></i> Admin Down
                    </span>
                    <span style="display: inline-flex; align-items: center; gap: 5px;">
                        <span style="width: 10px; height: 10px; background: rgba(234, 179, 8, 0.3); border: 1px solid #eab308; border-radius: 2px;"></span>
                        <i class="fas fa-triangle-exclamation" style="color: #eab308; font-size: 10px;"></i> Error / Flapping
                    </span>
                </div>

                <!-- Special Ports (Management / Stacking / Virtual) -->
                ${special.length > 0 ? `
                    <div style="margin-top: 18px; padding-top: 14px; border-top: 1px solid #1e293b;">
                        <div style="font-size: 11.5px; font-weight: 700; color: #94a3b8; margin-bottom: 12px; text-transform: uppercase; letter-spacing: 0.5px;">
                            <i class="fas fa-sliders-h" style="color: #00d4ff; margin-right: 5px;"></i> Port Management / Stacking / Virtual
                        </div>
                        <div style="display: flex; gap: 16px; flex-wrap: wrap; align-items: flex-start;">
                            ${special.map(item => renderPortCell(item, true)).join('')}
                        </div>
                    </div>
                ` : ''}
            </div>
        `;
    }

    /**
     * Render detail port terpilih
     */
    function renderPortDetailPanel(port) {
        if (!port) {
            return `
                <div style="background: #091322; border: 1px solid #1e293b; border-radius: 10px; padding: 16px; margin-bottom: 20px; text-align: center; color: #64748b;">
                    <i class="fas fa-hand-pointer" style="margin-right: 6px;"></i> Klik salah satu port pada panel switch di atas untuk melihat parameter lengkap, traffic rate, dan error delta.
                </div>
            `;
        }

        const st = evaluatePortVisualStatus(port);
        const inBpsStr = formatBitRate(port.in_bps);
        const outBpsStr = formatBitRate(port.out_bps);
        const speedStr = port.speed ? (port.speed >= 1000 ? `${port.speed / 1000} Gbps` : `${port.speed} Mbps`) : '—';

        return `
            <div id="switchAuditPortDetailContainer" style="background: #091322; border: 1px solid #1e293b; border-radius: 10px; padding: 18px; margin-bottom: 20px;">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px; border-bottom: 1px solid #1e293b; padding-bottom: 10px;">
                    <div style="display: flex; align-items: center; gap: 10px; flex-wrap: wrap;">
                        <span style="font-size: 16px; font-weight: 800; color: #00d4ff; font-family: monospace;">Port: ${port.name}</span>
                        ${port.raw_id && port.raw_id !== port.name ? `
                            <span style="font-size: 11px; font-weight: 700; padding: 2px 8px; border-radius: 4px; background: rgba(56, 189, 248, 0.12); color: #38bdf8; border: 1px solid rgba(56, 189, 248, 0.3); font-family: monospace;" title="ID Interface SNMP">
                                ID: ${port.raw_id}${port.index ? ` (Index: ${port.index})` : ''}
                            </span>
                        ` : (port.index ? `
                            <span style="font-size: 11px; font-weight: 700; padding: 2px 8px; border-radius: 4px; background: rgba(56, 189, 248, 0.12); color: #38bdf8; border: 1px solid rgba(56, 189, 248, 0.3); font-family: monospace;" title="ID Interface SNMP">
                                Index: ${port.index}
                            </span>
                        ` : '')}
                        <span style="font-size: 11.5px; font-weight: 700; padding: 3px 10px; border-radius: 4px; background: ${st.bg}; color: ${st.color}; border: 1px solid ${st.border};">
                            <i class="fas ${st.icon}"></i> ${st.label}
                        </span>
                        ${port.is_flapping ? '<span style="font-size: 11.5px; font-weight: 700; padding: 3px 10px; border-radius: 4px; background: rgba(234, 179, 8, 0.2); color: #eab308; border: 1px solid #ca8a04;"><i class="fas fa-bolt"></i> Port Flapping</span>' : ''}
                    </div>
                    <button onclick="window.switchAuditSelectPort(null)" style="background: none; border: none; color: #64748b; cursor: pointer; font-size: 14px;" title="Tutup Detail Port">
                        <i class="fas fa-times"></i>
                    </button>
                </div>

                <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px;">
                    <div style="background: #040812; padding: 12px; border-radius: 8px; border: 1px solid #1e293b;">
                        <div style="font-size: 11px; color: #94a3b8; font-weight: 700;">Laju Inbound (RX)</div>
                        <div style="font-size: 17px; font-weight: 800; color: #10b981; margin-top: 4px;">${inBpsStr}</div>
                        <div style="font-size: 10.5px; color: #64748b; margin-top: 4px;">Total Octets: ${formatNumber(port.in_octets)}</div>
                    </div>

                    <div style="background: #040812; padding: 12px; border-radius: 8px; border: 1px solid #1e293b;">
                        <div style="font-size: 11px; color: #94a3b8; font-weight: 700;">Laju Outbound (TX)</div>
                        <div style="font-size: 17px; font-weight: 800; color: #38bdf8; margin-top: 4px;">${outBpsStr}</div>
                        <div style="font-size: 10.5px; color: #64748b; margin-top: 4px;">Total Octets: ${formatNumber(port.out_octets)}</div>
                    </div>

                    <div style="background: #040812; padding: 12px; border-radius: 8px; border: 1px solid #1e293b;">
                        <div style="font-size: 11px; color: #94a3b8; font-weight: 700;">Kecepatan & Mode Operasi</div>
                        <div style="font-size: 15px; font-weight: 700; color: #e2e8f0; margin-top: 4px;">${speedStr}</div>
                        <div style="font-size: 10.5px; color: #64748b; margin-top: 4px;">Admin: <strong style="color: ${port.admin_status === 'up' ? '#10b981' : '#ef4444'}">${port.admin_status || '—'}</strong> | Oper: <strong style="color: ${port.oper_status === 'up' ? '#10b981' : '#ef4444'}">${port.oper_status || '—'}</strong></div>
                    </div>

                    <div style="background: #040812; padding: 12px; border-radius: 8px; border: 1px solid #1e293b;">
                        <div style="font-size: 11px; color: #94a3b8; font-weight: 700;">Kenaikan Error (Delta)</div>
                        <div style="font-size: 15px; font-weight: 800; color: ${(port.in_errors_delta || 0) > 0 ? '#ef4444' : '#e2e8f0'}; margin-top: 4px;">
                            In: +${port.in_errors_delta || 0} | Out: +${port.out_errors_delta || 0}
                        </div>
                        <div style="font-size: 10.5px; color: #64748b; margin-top: 4px;">
                            Total Discards: In (${formatNumber(port.in_discards)}) / Out (${formatNumber(port.out_discards)})
                        </div>
                    </div>
                </div>

                <div style="margin-top: 10px; font-size: 11px; color: #64748b; display: flex; justify-content: space-between;">
                    <span>Deskripsi IF: <span style="color: #cbd5e1;">${port.description || port.name}</span></span>
                    <span>Waktu Perubahan Terakhir: <span style="color: #cbd5e1;">${port.last_change || '—'}</span></span>
                </div>
            </div>
        `;
    }

    /**
     * Render daftar temuan audit otomatis
     */
    function renderAuditFindings(findings) {
        if (!Array.isArray(findings) || findings.length === 0) {
            return `
                <div style="background: #091322; border: 1px solid #1e293b; border-radius: 12px; padding: 20px; margin-bottom: 24px;">
                    <div style="font-size: 14px; font-weight: 700; color: #f1f5f9; margin-bottom: 12px; display: flex; align-items: center; gap: 8px;">
                        <i class="fas fa-clipboard-check" style="color: #10b981;"></i> Hasil Temuan Audit Real-time
                    </div>
                    <div style="background: rgba(16, 185, 129, 0.08); border: 1px solid rgba(16, 185, 129, 0.25); border-radius: 8px; padding: 14px 16px; color: #10b981; font-size: 13px; display: flex; align-items: center; gap: 12px;">
                        <i class="fas fa-circle-check" style="font-size: 20px;"></i>
                        <span>Semua indikator switch dalam batas normal. Tidak ada anomali atau port flapping yang terdeteksi.</span>
                    </div>
                </div>
            `;
        }

        const severityMap = {
            critical: { color: '#ef4444', bg: 'rgba(239, 68, 68, 0.08)', border: 'rgba(239, 68, 68, 0.3)', icon: 'fa-triangle-exclamation', badge: 'KRITIS' },
            warning: { color: '#eab308', bg: 'rgba(234, 179, 8, 0.08)', border: 'rgba(234, 179, 8, 0.3)', icon: 'fa-circle-exclamation', badge: 'PERINGATAN' },
            info: { color: '#38bdf8', bg: 'rgba(56, 189, 248, 0.08)', border: 'rgba(56, 189, 248, 0.3)', icon: 'fa-circle-info', badge: 'INFO' }
        };

        return `
            <div style="background: #091322; border: 1px solid #1e293b; border-radius: 12px; padding: 20px; margin-bottom: 24px;">
                <div style="font-size: 14px; font-weight: 700; color: #f1f5f9; margin-bottom: 14px; display: flex; align-items: center; justify-content: space-between;">
                    <div style="display: flex; align-items: center; gap: 8px;">
                        <i class="fas fa-clipboard-list" style="color: #00d4ff;"></i> Temuan Anomali & Rekomendasi Tindakan
                    </div>
                    <div style="display: flex; align-items: center; gap: 8px;">
                        <span style="font-size: 11px; color: #64748b;">(Maks 10 terlihat, scroll untuk lainnya)</span>
                        <span style="font-size: 11px; font-weight: 700; color: #00d4ff; background: rgba(0, 212, 255, 0.1); border: 1px solid rgba(0, 212, 255, 0.3); padding: 3px 10px; border-radius: 12px;">
                            ${findings.length} Temuan
                        </span>
                    </div>
                </div>

                <!-- Container Scrollable: Tinggi pas untuk 10 baris item -->
                <div id="switchAuditFindingsScrollContainer" style="max-height: 480px; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; padding-right: 6px;" class="custom-audit-scrollbar">
                    ${findings.map((f, idx) => {
            const sevKey = String(f.severity || 'info').toLowerCase();
            const sev = severityMap[sevKey] || severityMap.info;
            const msg = f.message || f.issue || 'Anomali terdeteksi';
            const rec = f.recommendation || f.detail || '';
            const target = f.target || f.component || '';

            return `
                            <div style="background: ${sev.bg}; border: 1px solid ${sev.border}; border-radius: 8px; padding: 10px 14px; display: flex; align-items: flex-start; gap: 12px; transition: background 0.15s ease;"
                                 onmouseover="this.style.background='rgba(255,255,255,0.03)'"
                                 onmouseout="this.style.background='${sev.bg}'">
                                <span style="font-size: 11px; font-family: monospace; color: #64748b; font-weight: 700; min-width: 20px;">#${idx + 1}</span>
                                <i class="fas ${sev.icon}" style="color: ${sev.color}; margin-top: 2px; font-size: 14px; flex-shrink: 0;"></i>
                                <div style="flex: 1; min-width: 0;">
                                    <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 2px;">
                                        <span style="font-size: 9.5px; font-weight: 800; color: ${sev.color}; border: 1px solid ${sev.color}; padding: 1px 6px; border-radius: 3px; letter-spacing: 0.3px;">
                                            ${sev.badge}
                                        </span>
                                        ${target ? `<span style="font-size: 11.5px; font-weight: 700; color: #00d4ff; font-family: monospace;">[${target}]</span>` : ''}
                                        <span style="font-size: 12.5px; font-weight: 600; color: #f1f5f9;">${msg}</span>
                                    </div>
                                    ${rec ? `
                                        <div style="font-size: 11.5px; color: #94a3b8; margin-top: 3px; line-height: 1.4;">
                                            <i class="fas fa-lightbulb" style="color: #eab308; font-size: 10.5px; margin-right: 4px;"></i> <strong style="color: #cbd5e1;">Rekomendasi:</strong> ${rec}
                                        </div>
                                    ` : ''}
                                </div>
                            </div>
                        `;
        }).join('')}
                </div>
            </div>
        `;
    }

    /**
     * Render komponen Hardware Alcatel
     */
    function renderAlcatelHardware(hw) {
        if (!hw) return '';
        const psu = hw.psu || hw.psuList || [];
        const fans = hw.fans || hw.fanList || [];
        const stack = hw.stack || [];

        if (psu.length === 0 && fans.length === 0 && stack.length === 0) return '';

        return `
            <div style="background: #091322; border: 1px solid #1e293b; border-radius: 10px; padding: 18px; margin-bottom: 20px;">
                <div style="font-size: 14px; font-weight: 700; color: #f1f5f9; margin-bottom: 12px; display: flex; align-items: center; gap: 8px;">
                    <i class="fas fa-cubes" style="color: #00d4ff;"></i> Modul Hardware & Redundansi (Chassis/Stack)
                </div>

                <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px;">
                    ${psu.length > 0 ? `
                        <div style="background: #040812; padding: 12px; border-radius: 8px; border: 1px solid #1e293b;">
                            <div style="font-size: 11.5px; font-weight: 700; color: #94a3b8; margin-bottom: 8px;"><i class="fas fa-bolt" style="color: #eab308;"></i> Catu Daya (PSU)</div>
                            ${psu.map((p, idx) => {
                                const st = String(p.status || '').toLowerCase();
                                const isOk = st.includes('ok') || st.includes('up');
                                const isNotPresent = st.includes('notpresent') || st.includes('not present') || st.includes('absent');
                                const color = isOk ? '#10b981' : (isNotPresent ? '#64748b' : '#ef4444');
                                const label = isOk ? 'OK' : (isNotPresent ? 'Not Present' : (p.status || 'Fault'));
                                const psuNum = (p.index && p.index > 0) ? p.index : (idx + 1);
                                return `
                                <div style="display: flex; justify-content: space-between; font-size: 11.5px; padding: 3px 0;">
                                    <span style="color: #cbd5e1;">PSU #${psuNum}:</span>
                                    <span style="font-weight: 700; color: ${color};">${label}</span>
                                </div>
                                `;
                            }).join('')}
                        </div>
                    ` : ''}

                    ${fans.length > 0 ? `
                        <div style="background: #040812; padding: 12px; border-radius: 8px; border: 1px solid #1e293b;">
                            <div style="font-size: 11.5px; font-weight: 700; color: #94a3b8; margin-bottom: 8px;"><i class="fas fa-fan fa-spin" style="color: #38bdf8; animation-duration: 4s;"></i> Kipas Pendingin (Fan)</div>
                            ${fans.map((f, idx) => {
                                const st = String(f.status || '').toLowerCase();
                                const isOk = st.includes('ok') || st.includes('up');
                                const isNotPresent = st.includes('notpresent') || st.includes('not present') || st.includes('absent');
                                const color = isOk ? '#10b981' : (isNotPresent ? '#64748b' : '#ef4444');
                                const label = isOk ? 'OK' : (isNotPresent ? 'Not Present' : (f.status || 'Fault'));
                                const fanNum = (f.index && f.index > 0) ? f.index : (idx + 1);
                                return `
                                <div style="display: flex; justify-content: space-between; font-size: 11.5px; padding: 3px 0;">
                                    <span style="color: #cbd5e1;">Fan #${fanNum}:</span>
                                    <span style="font-weight: 700; color: ${color};">${label}</span>
                                </div>
                                `;
                            }).join('')}
                        </div>
                    ` : ''}

                    ${stack.length > 0 ? `
                        <div style="background: #040812; padding: 12px; border-radius: 8px; border: 1px solid #1e293b;">
                            <div style="font-size: 11.5px; font-weight: 700; color: #94a3b8; margin-bottom: 8px;"><i class="fas fa-layer-group" style="color: #a78bfa;"></i> Status Stack Switch</div>
                            ${stack.map(s => `
                                <div style="display: flex; justify-content: space-between; font-size: 11.5px; padding: 3px 0;">
                                    <span style="color: #cbd5e1;">Unit #${s.slot || 1} (${s.role || 'Member'}):</span>
                                    <span style="font-weight: 700; color: ${String(s.state).toLowerCase().includes('master') || String(s.state).toLowerCase().includes('running') ? '#10b981' : '#cbd5e1'}">${s.state}</span>
                                </div>
                            `).join('')}
                        </div>
                    ` : ''}
                </div>
            </div>
        `;
    }

    /**
     * Render seluruh isi halaman audit switch
     */
    function renderSwitchAuditContent(auditData, liveData) {
        const portList = getPortsList(auditData, liveData);
        let selectedPort = null;
        if (portList.length > 0) {
            if (_selectedPortName) {
                selectedPort = portList.find(p => p.name === _selectedPortName);
            }
            if (!selectedPort) {
                selectedPort = portList.find(p => p.is_flapping || (p.in_errors_delta || 0) > 0) || portList[0];
                if (selectedPort) _selectedPortName = selectedPort.name;
            }
        }

        const findings = auditData.findings || [];
        const badge = document.getElementById('switchFindingsCountBadge');
        if (badge) badge.textContent = findings.length;

        if (_activeTab === 'ports') {
            return `
                <div id="switchAuditGridBlock">
                    ${renderPortGrid(portList, _selectedPortName)}
                </div>
                <div id="switchAuditDetailBlock">
                    ${renderPortDetailPanel(selectedPort)}
                </div>
            `;
        }

        if (_activeTab === 'findings') {
            return `
                <div id="switchAuditFindingsBlock">
                    ${renderAuditFindings(findings)}
                </div>
            `;
        }

        // Default 'overview'
        return `
            <div id="switchAuditSummaryBlock">
                ${renderSummaryCards(auditData, liveData)}
            </div>
            <div id="switchAuditGridBlock">
                ${renderPortGrid(portList, _selectedPortName)}
            </div>
            <div id="switchAuditDetailBlock">
                ${renderPortDetailPanel(selectedPort)}
            </div>
            <div id="switchAuditFindingsBlock">
                ${renderAuditFindings(findings)}
            </div>
            <div id="switchAuditHwBlock">
                ${renderAlcatelHardware(auditData.hardware_status || auditData.hardware_health)}
            </div>
        `;
    }

    /**
     * Ekspor CSV
     */
    function exportSwitchAuditToCsv(auditData, switchName) {
        if (!auditData) {
            alert('Tidak ada data audit untuk diekspor.');
            return;
        }

        const name = (switchName || 'switch').replace(/[^a-zA-Z0-9_-]/g, '_');
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = `audit_switch_${name}_${timestamp}.csv`;

        let csvContent = `AUDIT REPORT SWITCH REALTIME\n`;
        csvContent += `Nama Perangkat,${switchName || 'Switch'}\n`;
        csvContent += `Tanggal Cetak,${new Date().toLocaleString('id-ID')}\n`;
        csvContent += `Health Score,${auditData.health_score?.score || 100} / 100 (${auditData.health_score?.level || 'Normal'})\n`;
        csvContent += `Suhu Switch,${auditData.temperature_c || '—'} C\n`;
        csvContent += `CPU Load,${auditData.cpu_usage || '—'}\n`;
        csvContent += `RAM Usage,${auditData.ram_usage || '—'}\n\n`;

        csvContent += `DAFTAR TEMUAN AUDIT\n`;
        csvContent += `Tingkat Keparahan,Target Port/Sistem,Deskripsi Temuan,Rekomendasi Tindakan\n`;
        const findings = auditData.findings || [];
        if (findings.length > 0) {
            findings.forEach(f => {
                const sev = f.severity || 'INFO';
                const target = (f.target || f.component || '').replace(/"/g, '""');
                const msg = (f.message || f.issue || '').replace(/"/g, '""');
                const rec = (f.recommendation || f.detail || '').replace(/"/g, '""');
                csvContent += `"${sev}","${target}","${msg}","${rec}"\n`;
            });
        } else {
            csvContent += `"NORMAL","SISTEM","Semua indikator switch dalam batas operasional normal","-"\n`;
        }
        csvContent += `\n`;

        csvContent += `DETAIL STATUS PORT FISIK & TRAFFIC RATE\n`;
        csvContent += `Port Name,Admin Status,Oper Status,Speed (Mbps),Traffic In (bps),Traffic Out (bps),Delta In Errors,Delta Out Errors,Delta In Discards,Delta Out Discards,Total In Errors,Total Out Errors,Flapping Status\n`;

        const ports = getPortsList(auditData);
        ports.forEach(p => {
            const inBps = (p.in_bps === 'menghitung...' || p.in_bps === null) ? '0' : Math.round(p.in_bps);
            const outBps = (p.out_bps === 'menghitung...' || p.out_bps === null) ? '0' : Math.round(p.out_bps);
            const isFlap = p.is_flapping ? 'YA' : 'TIDAK';

            csvContent += `"${p.name}","${p.admin_status || 'down'}","${p.oper_status || 'down'}",${p.speed || 0},${inBps},${outBps},${p.in_errors_delta || 0},${p.out_errors_delta || 0},${p.in_discards_delta || 0},${p.out_discards_delta || 0},${p.in_errors || 0},${p.out_errors || 0},"${isFlap}"\n`;
        });

        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        const link = document.createElement('a');
        const url = URL.createObjectURL(blob);
        link.setAttribute('href', url);
        link.setAttribute('download', filename);
        link.style.visibility = 'hidden';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    }

    /**
     * Cari objek source & live data
     */
    /**
     * Cari objek source & live data
     */
    function findSwitchSourceAndData(sourceId) {
        let src = null;
        let data = null;

        // 1. Cek dari window._activeSourceDetail jika sourceId cocok atau tidak diberikan
        if (window._activeSourceDetail && (!sourceId || String(window._activeSourceDetail.id) === String(sourceId) || String(window._activeSourceDetail.name) === String(sourceId))) {
            src = window._activeSourceDetail;
            if (typeof window.getSourceDetailPayload === 'function') {
                const payload = window.getSourceDetailPayload(src);
                data = payload?.latestData || src.lastData || src.currentData || src.data;
            } else {
                data = src.lastData || src.currentData || src.data;
            }
        }

        // 2. Cek dari _sourcesCache
        if ((!src || !data) && window._sourcesCache) {
            for (const eqId of Object.keys(window._sourcesCache)) {
                const list = window._sourcesCache[eqId] || [];
                const found = list.find(s => String(s.id) === String(sourceId) || String(s.ip_address) === String(sourceId) || String(s.name) === String(sourceId));
                if (found) {
                    if (!src) src = found;
                    if (typeof window.getSourceDetailPayload === 'function') {
                        const payload = window.getSourceDetailPayload(found);
                        data = payload?.latestData || found.lastData || found.currentData || found.data;
                    } else {
                        data = found.lastData || found.currentData || found.data;
                    }
                    if (data) break;
                }
            }
        }

        // 3. Cek dari window.equipmentDataCache
        if ((!src || !data) && window.equipmentDataCache) {
            const allEq = Array.isArray(window.equipmentDataCache) ? window.equipmentDataCache : [];
            for (const eq of allEq) {
                if (!eq) continue;
                const matchSrc = Array.isArray(eq.dataSources)
                    ? eq.dataSources.find(s => String(s.id) === String(sourceId) || String(s.ip) === String(sourceId) || String(s.name) === String(sourceId))
                    : (Array.isArray(eq.sources) ? eq.sources.find(s => String(s.id) === String(sourceId) || String(s.ip_address) === String(sourceId)) : null);

                if (matchSrc) {
                    if (!src) {
                        src = {
                            id: matchSrc.id,
                            name: matchSrc.name,
                            ip_address: matchSrc.ip || matchSrc.ip_address,
                            equipt_id: eq.id,
                            parsing_id: matchSrc.parser || matchSrc.parsing_id || 'snmp_network_basic'
                        };
                    }
                    if (!data && typeof window.resolveSourceData === 'function') {
                        data = window.resolveSourceData(eq, src);
                    }
                    if (data) break;
                }
            }
        }

        return { src, data };
    }

    /**
     * Update data halaman switch audit
     */
    function updateSwitchAuditData() {
        if (!_activeSwitchSourceId) return;
        const { src, data } = findSwitchSourceAndData(_activeSwitchSourceId);
        if (!src) return;

        // Ambil data audit, atau bentuk struktur audit dari live telemetri yang tersedia
        let auditData = data?.audit_switch;

        if (!auditData && data && (data.active_interfaces || data.down_interfaces || data.interface_count)) {
            const activeList = Array.isArray(data.active_interfaces) ? data.active_interfaces : [];
            const downList = Array.isArray(data.down_interfaces) ? data.down_interfaces : [];
            const total = activeList.length + downList.length || parseInt(data.interface_count, 10) || 0;

            const synthPorts = [
                ...activeList.map(i => ({ name: i.name || `Port ${i.index}`, admin_status: 'up', oper_status: 'up', in_octets: Number(i.in_octets) || 0, out_octets: Number(i.out_octets) || 0, in_bps: 'menghitung...', out_bps: 'menghitung...' })),
                ...downList.map(i => ({ name: i.name || `Port ${i.index}`, admin_status: 'down', oper_status: 'down', in_octets: 0, out_octets: 0, in_bps: 0, out_bps: 0 }))
            ];

            auditData = {
                health_score: data.health_score || (data._status === 'Alarm' ? 'Kritis' : (data._status === 'Warning' ? 'Peringatan' : 'Normal')),
                total_interfaces: total,
                active_interfaces: activeList.length,
                down_interfaces: downList.length,
                cpu_usage: data.cpu_usage ? `${data.cpu_usage}%` : '—',
                ram_usage: data.ram_usage_pct ? `${data.ram_usage_pct}%` : '—',
                temperature_c: data.temperature_c ? `${data.temperature_c} °C` : '—',
                interfaces: synthPorts,
                findings: [
                    ...(data.temperature_c && Number(data.temperature_c) >= 50 ? [{ severity: 'warning', component: 'Suhu', issue: `Suhu terdeteksi ${data.temperature_c} °C`, recommendation: 'Periksa sirkulasi udara rak switch' }] : []),
                    ...(downList.length > 0 ? [{ severity: 'info', component: 'Port Down', issue: `${downList.length} port berstatus Down`, recommendation: 'Verifikasi kabel LAN atau perangkat yang terhubung' }] : [])
                ]
            };
        }

        // PERTAHANKAN CACHE: Jika data baru kosong/disconnect sesaat, jangan hapus auditData lama!
        const cacheKey = _activeSwitchSourceId || 'default';
        if (auditData && Array.isArray(auditData.interfaces) && auditData.interfaces.length > 0) {
            _lastAuditData = auditData;
            _cachedPortsBySource.set(cacheKey, auditData.interfaces);
        } else if (_lastAuditData) {
            // Gunakan audit data yang sudah ada sebelumnya
            auditData = _lastAuditData;
        } else if (_cachedPortsBySource.has(cacheKey)) {
            // Pulihkan interfaces dari cache
            const cachedPorts = _cachedPortsBySource.get(cacheKey) || [];
            if (!auditData) {
                auditData = {
                    health_score: 'Normal',
                    total_interfaces: cachedPorts.length,
                    active_interfaces: cachedPorts.filter(p => p.oper_status === 'up' || p.status === 'up').length,
                    down_interfaces: cachedPorts.filter(p => p.oper_status !== 'up' && p.status !== 'up').length,
                    interfaces: cachedPorts,
                    findings: []
                };
            } else {
                auditData.interfaces = cachedPorts;
            }
            _lastAuditData = auditData;
        }

        if (data) {
            _lastLiveData = data;
        } else if (_lastLiveData) {
            data = _lastLiveData;
        }

        // Update Header Titles
        const titleEl = document.getElementById('switchAuditTitle');
        const subTitleEl = document.getElementById('switchAuditSubTitle');
        if (titleEl) titleEl.textContent = `AUDIT SWITCH: ${src.name || 'Switch'}`;
        if (subTitleEl) {
            subTitleEl.textContent = `IP: ${src.ip_address || data?.resolved_ip || '—'} | Perangkat: ${data?.hardware || 'Switch'} | OS: ${data?.operating_system || 'Switch OS'}`;
        }

        const body = document.getElementById('switchAuditBody');
        if (!body) return;

        if (!auditData) {
            body.innerHTML = `
                <div style="text-align: center; padding: 50px; color: #94a3b8;">
                    <i class="fas fa-spinner fa-spin fa-2x" style="color: #00d4ff; margin-bottom: 12px; display: block;"></i>
                    <p style="font-size: 15px; font-weight: 700; color: #f8fafc;">Menghubungkan & Memuat Data Audit Switch...</p>
                    <p style="font-size: 12px; color: #64748b; margin-top: 4px;">Sedang mengambil telemetri SNMP dari IP <strong>${src.ip_address || 'perangkat'}</strong>. Mohon tunggu beberapa detik...</p>
                </div>
            `;
            return;
        }

        // Jangan refresh DOM jika user sedang aktif menyeleksi/memblok teks di dalam modal audit
        const sel = window.getSelection ? window.getSelection() : null;
        if (sel && !sel.isCollapsed && sel.toString().trim().length > 0) {
            const anchorNode = sel.anchorNode;
            if (anchorNode && body.contains(anchorNode)) {
                return; // Tunda render ulang saat pengguna sedang memblok kalimat
            }
        }

        // Render konten aktif tanpa mereset scroll container utama dan sub-container
        const scrollTop = body.scrollTop;
        const findingsEl = document.getElementById('switchAuditFindingsScrollContainer');
        const findingsScrollTop = findingsEl ? findingsEl.scrollTop : 0;
        const chassisEl = document.getElementById('switchAuditChassisScroll');
        const chassisScrollLeft = chassisEl ? chassisEl.scrollLeft : 0;

        body.innerHTML = renderSwitchAuditContent(auditData, data);
        body.scrollTop = scrollTop;

        const newFindingsEl = document.getElementById('switchAuditFindingsScrollContainer');
        if (newFindingsEl) newFindingsEl.scrollTop = findingsScrollTop;

        const newChassisEl = document.getElementById('switchAuditChassisScroll');
        if (newChassisEl) newChassisEl.scrollLeft = chassisScrollLeft;
    }

    // ── PUBLIC WINDOW CONTROLLER ──────────────────────────────────────────

    /**
     * Buka Halaman Baru Audit Switch Layar Penuh (Seperti halnya Radar PPI Scope)
     */
    window.openSwitchAuditScope = function (sourceId) {
        if (typeof window.closeAllEnhancementModals === 'function') {
            window.closeAllEnhancementModals();
        } else {
            const m = document.getElementById('dataSourceDetailModal');
            if (m) m.style.display = 'none';
            const p = document.getElementById('equipmentDetailPanel');
            const o = document.getElementById('detailPanelOverlay');
            if (p) p.classList.remove('open');
            if (o) o.classList.remove('open');
        }

        ensureSwitchAuditDOMElements();

        if (!sourceId && window._activeSourceDetail) {
            sourceId = window._activeSourceDetail.id;
        }
        _activeSwitchSourceId = sourceId;

        const overlay = document.getElementById('switchAuditOverlay');
        const modal = document.getElementById('switchAuditModal');
        if (overlay) overlay.style.display = 'block';
        if (modal) modal.classList.add('open');

        updateSwitchAuditData();

        // Start live polling refresh
        if (!_activeSwitchTimer) {
            _activeSwitchTimer = setInterval(() => {
                if (!_activeSwitchSourceId || !modal.classList.contains('open')) {
                    window.closeSwitchAuditModal();
                    return;
                }
                const { src } = findSwitchSourceAndData(_activeSwitchSourceId);
                if (src && src.equipt_id) {
                    fetch(`/api/equipment/${src.equipt_id}`, {
                        headers: window.getAuthHeaders ? window.getAuthHeaders() : {}
                    })
                        .then(r => r.ok ? r.json() : null)
                        .then(eqData => {
                            if (eqData && typeof window.updateEquipmentCacheEntry === 'function') {
                                window.updateEquipmentCacheEntry(eqData);
                            }
                            updateSwitchAuditData();
                        })
                        .catch(() => { });
                } else {
                    updateSwitchAuditData();
                }
            }, 1500);
        }
    };

    /**
     * Tutup Halaman Audit Switch
     */
    window.closeSwitchAuditModal = function () {
        const overlay = document.getElementById('switchAuditOverlay');
        const modal = document.getElementById('switchAuditModal');
        if (overlay) overlay.style.display = 'none';
        if (modal) modal.classList.remove('open');

        if (_activeSwitchTimer) {
            clearInterval(_activeSwitchTimer);
            _activeSwitchTimer = null;
        }
        _activeSwitchSourceId = null;
    };

    window.switchAuditSetTab = function (tab) {
        _activeTab = tab;
        document.querySelectorAll('.switch-tab-btn').forEach(b => b.classList.remove('active'));
        if (tab === 'overview') document.getElementById('switchTabBtnOverview')?.classList.add('active');
        if (tab === 'ports') document.getElementById('switchTabBtnPorts')?.classList.add('active');
        if (tab === 'findings') document.getElementById('switchTabBtnFindings')?.classList.add('active');

        if (_lastAuditData) {
            const body = document.getElementById('switchAuditBody');
            if (body) body.innerHTML = renderSwitchAuditContent(_lastAuditData, _lastLiveData);
        }
    };

    window.switchAuditSetFilter = function (filter) {
        _activePortFilter = filter;
        const sel = document.getElementById('switchPortFilterSelect');
        if (sel && sel.value !== filter) {
            sel.value = filter;
        }

        if (_lastAuditData || _lastLiveData) {
            const portList = getPortsList(_lastAuditData, _lastLiveData);
            const gridBlock = document.getElementById('switchAuditGridBlock');
            if (gridBlock) {
                gridBlock.innerHTML = renderPortGrid(portList, _selectedPortName);
            }
        }
    };

    window.switchAuditSelectPort = function (portNameEncoded) {
        _selectedPortName = portNameEncoded ? decodeURIComponent(portNameEncoded) : null;
        if (_lastAuditData || _lastLiveData) {
            const portList = getPortsList(_lastAuditData, _lastLiveData);
            const gridBlock = document.getElementById('switchAuditGridBlock');
            if (gridBlock) {
                gridBlock.innerHTML = renderPortGrid(portList, _selectedPortName);
            }
            const detailBlock = document.getElementById('switchAuditDetailBlock');
            if (detailBlock) {
                const port = portList.find(p => p.name === _selectedPortName);
                detailBlock.innerHTML = renderPortDetailPanel(port);
            }
        }
    };

    window.switchAuditExportCsv = function () {
        const titleEl = document.getElementById('switchAuditTitle');
        const switchName = titleEl ? titleEl.textContent.replace('AUDIT SWITCH: ', '') : 'Switch';
        exportSwitchAuditToCsv(_lastAuditData || { interfaces: getPortsList(null, _lastLiveData) }, switchName);
    };

})();
