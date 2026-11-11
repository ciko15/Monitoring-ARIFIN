/**
 * public/audit/server_audit.js
 * Modul Audit Aplikasi PC & Server Realtime (Fullscreen Modal / Dedicated View)
 * Tema gelap terpadu (monitoring-arifin, localhost:3100), kompatibel dengan snmp_system.
 * Bekerja murni dengan data realtime (in-memory & SNMP HOST-RESOURCES-MIB).
 */

(function () {
    'use strict';

    // State Audit Server
    let _activeServerSourceId = null;
    let _activeServerTimer = null;
    let _lastAuditData = null;
    let _lastLiveData = null;
    let _activeTab = 'processes'; // 'processes' | 'watchlist' | 'services' | 'findings'
    let _procSearchQuery = '';
    let _procTypeFilter = 'all'; // 'all' | 'application' | 'system' | 'unlisted'
    let _procSortColumn = 'name';
    let _procSortDir = 'asc';
    let _procPage = 1;
    let _procPageSize = 10;

    /**
     * Tambahkan style khusus untuk Server Audit Modal Layar Penuh
     */
    function addServerAuditStyles() {
        if (document.getElementById('serverAuditStyles')) return;
        const style = document.createElement('style');
        style.id = 'serverAuditStyles';
        style.textContent = `
            #serverAuditOverlay {
                display: none;
                position: fixed !important;
                inset: 0 !important;
                background: rgba(3, 7, 18, 0.85) !important;
                backdrop-filter: blur(8px) !important;
                -webkit-backdrop-filter: blur(8px) !important;
                z-index: 99990 !important;
                transition: opacity 0.15s ease-out !important;
            }
            .pagination-container button {
                padding: 6px 12px;
                background: var(--bg-card, #162032);
                border: 1px solid var(--border-color, #334155);
                color: var(--text-secondary, #94a3b8);
                border-radius: 6px;
                cursor: pointer;
                font-size: 0.82rem;
                transition: all 0.15s ease;
            }
            .pagination-container button:hover:not(:disabled) {
                background: var(--accent-primary, #00d4ff);
                color: #000;
                border-color: var(--accent-primary, #00d4ff);
            }
            .pagination-container button.active {
                background: #2563eb;
                color: #fff;
                border-color: #2563eb;
                font-weight: 700;
            }
            .pagination-container button:disabled {
                opacity: 0.4;
                cursor: not-allowed;
            }
            #serverAuditModal {
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
            #serverAuditModal.open {
                transform: translateY(0) !important;
            }
            .server-audit-header {
                display: flex;
                align-items: center;
                justify-content: space-between;
                padding: 14px 24px;
                background: #080e1a;
                border-bottom: 1px solid rgba(16, 185, 129, 0.2);
            }
            .server-stat-card {
                background: rgba(15, 23, 42, 0.75);
                border: 1px solid rgba(255, 255, 255, 0.08);
                border-radius: 8px;
                padding: 12px 16px;
                display: flex;
                flex-direction: column;
                justify-content: space-between;
                min-width: 130px;
                transition: all 0.2s;
            }
            .server-stat-card:hover {
                border-color: rgba(16, 185, 129, 0.35);
                transform: translateY(-1px);
            }
            .server-tab-btn {
                background: transparent;
                border: 1px solid transparent;
                color: #94a3b8;
                font-size: 13px;
                font-weight: 600;
                padding: 8px 16px;
                border-radius: 6px;
                cursor: pointer;
                transition: all 0.2s;
                display: inline-flex;
                align-items: center;
                gap: 8px;
            }
            .server-tab-btn:hover {
                color: #f8fafc;
                background: rgba(255, 255, 255, 0.05);
            }
            .server-tab-btn.active {
                background: rgba(16, 185, 129, 0.18);
                color: #34d399;
                border-color: #10b981;
            }
            .server-audit-content {
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
                background: rgba(16, 185, 129, 0.3);
                border-radius: 4px;
            }
            .custom-audit-scrollbar::-webkit-scrollbar-thumb:hover {
                background: rgba(16, 185, 129, 0.6);
            }
            .badge-status {
                display: inline-flex;
                align-items: center;
                gap: 6px;
                padding: 3px 10px;
                border-radius: 4px;
                font-size: 11.5px;
                font-weight: 700;
                letter-spacing: 0.3px;
            }
            .badge-status.berjalan {
                background: rgba(16, 185, 129, 0.18);
                color: #34d399;
                border: 1px solid #10b981;
            }
            .badge-status.mati {
                background: rgba(239, 68, 68, 0.22);
                color: #f87171;
                border: 1px solid #ef4444;
            }
            .badge-status.perlu_dicek {
                background: rgba(245, 158, 11, 0.2);
                color: #fbbf24;
                border: 1px solid #f59e0b;
            }
            .badge-status.dikecualikan {
                background: rgba(148, 163, 184, 0.15);
                color: #94a3b8;
                border: 1px solid #64748b;
            }
            .sparkline-canvas {
                display: block;
                vertical-align: middle;
            }
        `;
        document.head.appendChild(style);
    }

    /**
     * Pastikan elemen modal server audit terpasang di DOM
     */
    function ensureServerAuditDOMElements() {
        addServerAuditStyles();
        if (document.getElementById('serverAuditModal')) return;

        const overlay = document.createElement('div');
        overlay.id = 'serverAuditOverlay';
        overlay.onclick = () => window.closeServerAuditModal();
        document.body.appendChild(overlay);

        const modal = document.createElement('div');
        modal.id = 'serverAuditModal';
        modal.innerHTML = `
            <!-- Header Bar -->
            <div class="server-audit-header">
                <div style="display: flex; align-items: center; gap: 12px;">
                    <i class="fas fa-server" style="color: #34d399; font-size: 22px;"></i>
                    <div>
                        <div style="display: flex; align-items: center; gap: 10px;">
                            <span id="serverAuditTitle" style="font-size: 17px; font-weight: 800; color: #f8fafc; letter-spacing: 0.5px;">AUDIT APLIKASI & LAYANAN PC / SERVER</span>
                            <span style="font-size: 11px; font-weight: 700; padding: 2px 8px; border-radius: 4px; background: rgba(16, 185, 129, 0.15); color: #34d399; border: 1px solid rgba(16, 185, 129, 0.35);">
                                SNMP HOST-RESOURCES
                            </span>
                        </div>
                        <div id="serverAuditSubTitle" style="font-size: 11.5px; color: #64748b; font-family: monospace; margin-top: 2px;">
                            IP: — | OS: — | Uptime: —
                        </div>
                    </div>
                </div>

                <!-- Right controls -->
                <div style="display: flex; align-items: center; gap: 10px;">
                    <span id="serverAuditHealthBadge" style="font-size: 12px; font-weight: 800; padding: 4px 12px; border-radius: 20px; background: rgba(0, 212, 255, 0.15); color: #00d4ff; border: 1px solid rgba(0, 212, 255, 0.4); display: inline-flex; align-items: center; gap: 6px;">
                        <i class="fas fa-shield-halved"></i> NORMAL
                    </span>
                    <span id="serverAuditLastSync" style="font-size: 11px; color: #94a3b8; font-family: monospace;">
                        <i class="fas fa-rotate"></i> Realtime
                    </span>
                    <button onclick="window.refreshServerAuditNow()" title="Segarkan Data Realtime Sekarang" style="background: rgba(0, 212, 255, 0.12); color: #00d4ff; border: 1px solid rgba(0, 212, 255, 0.35); border-radius: 6px; padding: 6px 12px; font-size: 12px; font-weight: 600; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; transition: all 0.2s;" onmouseover="this.style.background='rgba(0,212,255,0.25)'" onmouseout="this.style.background='rgba(0,212,255,0.12)'">
                        <i class="fas fa-sync-alt"></i> Refresh
                    </button>
                    <button onclick="window.manageServerWatchlistModal()" style="background: rgba(0, 212, 255, 0.12); color: #00d4ff; border: 1px solid rgba(0, 212, 255, 0.35); border-radius: 6px; padding: 6px 12px; font-size: 12px; font-weight: 600; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; transition: all 0.2s;" onmouseover="this.style.background='rgba(0,212,255,0.25)'" onmouseout="this.style.background='rgba(0,212,255,0.12)'">
                        <i class="fas fa-sliders"></i> Kelola Watchlist
                    </button>
                    <button onclick="window.exportServerAuditCSV()" style="background: rgba(0, 212, 255, 0.12); color: #00d4ff; border: 1px solid rgba(0, 212, 255, 0.35); border-radius: 6px; padding: 6px 12px; font-size: 12px; font-weight: 600; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; transition: all 0.2s;" onmouseover="this.style.background='rgba(0,212,255,0.25)'" onmouseout="this.style.background='rgba(0,212,255,0.12)'">
                        <i class="fas fa-file-csv"></i> Ekspor CSV
                    </button>
                    <button onclick="window.closeServerAuditModal()" style="background: rgba(239, 68, 68, 0.15); color: #f87171; border: 1px solid rgba(239, 68, 68, 0.35); border-radius: 6px; padding: 6px 12px; font-size: 12px; font-weight: 700; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; transition: all 0.2s;" onmouseover="this.style.background='rgba(239,68,68,0.3)'; this.style.color='#fff';" onmouseout="this.style.background='rgba(239,68,68,0.15)'; this.style.color='#f87171';">
                        <i class="fas fa-times"></i> Tutup
                    </button>
                </div>
            </div>

            <!-- Ringkasan Kartu Metrik (Row Card) -->
            <div id="serverAuditMetricsRow" style="display: flex; gap: 12px; padding: 14px 24px; background: #060b16; border-bottom: 1px solid rgba(255, 255, 255, 0.06); overflow-x: auto;">
                <!-- Dinamis di-render oleh renderServerAuditMetrics() -->
            </div>

            <!-- Tab Navigation Bar -->
            <div style="display: flex; gap: 10px; padding: 10px 24px; background: #080e1a; border-bottom: 1px solid rgba(255, 255, 255, 0.06);">
                <button id="tabBtnProcesses" class="server-tab-btn active" onclick="window.serverAuditChangeTab('processes')">
                    <i class="fas fa-microchip"></i> Semua Proses Berjalan <span id="tabCountProcesses" style="background: rgba(255, 255, 255, 0.1); padding: 1px 6px; border-radius: 10px; font-size: 10.5px;">0</span>
                </button>
                <button id="tabBtnWatchlist" class="server-tab-btn" onclick="window.serverAuditChangeTab('watchlist')">
                    <i class="fas fa-clipboard-check"></i> Aplikasi Wajib Aktif (Watchlist) <span id="tabCountWatchlist" style="background: rgba(255, 255, 255, 0.1); padding: 1px 6px; border-radius: 10px; font-size: 10.5px;">0</span>
                </button>
                <button id="tabBtnServices" class="server-tab-btn" onclick="window.serverAuditChangeTab('services')">
                    <i class="fab fa-windows"></i> Layanan Windows <span id="tabCountServices" style="background: rgba(255, 255, 255, 0.1); padding: 1px 6px; border-radius: 10px; font-size: 10.5px;">0</span>
                </button>
                <button id="tabBtnFindings" class="server-tab-btn" onclick="window.serverAuditChangeTab('findings')">
                    <i class="fas fa-triangle-exclamation"></i> Temuan Audit Otomatis <span id="tabCountFindings" style="background: rgba(239, 68, 68, 0.2); color: #f87171; padding: 1px 6px; border-radius: 10px; font-size: 10.5px;">0</span>
                </button>
            </div>

            <!-- Main Content Area -->
            <div id="serverAuditContent" class="server-audit-content custom-audit-scrollbar">
                <div style="display: flex; align-items: center; justify-content: center; height: 300px; color: #64748b;">
                    <i class="fas fa-circle-notch fa-spin fa-2x" style="margin-right: 12px; color: #34d399;"></i> Memuat data audit PC / Server realtime...
                </div>
            </div>
        `;
        document.body.appendChild(modal);
    }

    /**
     * Gambar mini sparkline canvas untuk visualisasi tren memori/CPU
     */
    function renderSparklineCanvas(dataPoints, color = '#34d399', width = 60, height = 18) {
        if (!Array.isArray(dataPoints) || dataPoints.length < 2) {
            return `<span style="color:#64748b; font-size:11px;">—</span>`;
        }
        const points = dataPoints.map(p => Number(p) || 0);
        const min = Math.min(...points);
        const max = Math.max(...points);
        const range = max - min === 0 ? 1 : max - min;

        // Render via inline SVG agar tajam dan tidak butuh canvas element async
        const stepX = width / (points.length - 1);
        const coords = points.map((val, idx) => {
            const x = idx * stepX;
            const y = height - ((val - min) / range) * (height - 4) - 2;
            return `${x.toFixed(1)},${y.toFixed(1)}`;
        }).join(' ');

        return `
            <svg width="${width}" height="${height}" style="display:inline-block; vertical-align:middle; overflow:visible;">
                <polyline fill="none" stroke="${color}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" points="${coords}" />
            </svg>
        `;
    }

    /**
     * Render Baris Kartu Metrik Ringkas (Mendukung in-place update tanpa flicker)
     */
    function renderServerAuditMetrics(audit, liveData) {
        const container = document.getElementById('serverAuditMetricsRow');
        if (!container) return;

        const summary = audit ? audit.summary : {};
        const health = audit && audit.health_score ? audit.health_score : { level: 'Normal', score: 100 };

        let healthColor = '#34d399';
        let healthBg = 'rgba(16, 185, 129, 0.15)';
        let healthIcon = 'fa-circle-check';
        if (health.level === 'Kritis') {
            healthColor = '#f87171';
            healthBg = 'rgba(239, 68, 68, 0.2)';
            healthIcon = 'fa-triangle-exclamation';
        } else if (health.level === 'Peringatan') {
            healthColor = '#fbbf24';
            healthBg = 'rgba(245, 158, 11, 0.2)';
            healthIcon = 'fa-circle-exclamation';
        }

        const healthBadge = document.getElementById('serverAuditHealthBadge');
        if (healthBadge) {
            healthBadge.innerHTML = `<i class="fas ${healthIcon}"></i> ${health.level.toUpperCase()} (${health.score || 100}%)`;
            healthBadge.style.color = healthColor;
            healthBadge.style.background = healthBg;
            healthBadge.style.borderColor = healthColor;
        }

        // Cek jika elemen-elemen metrik sudah ada untuk in-place update
        const elRunningApps = document.getElementById('samRunningApps');
        if (elRunningApps) {
            elRunningApps.innerHTML = `${summary.running_apps ?? 0} <span style="font-size: 12px; color: #64748b; font-weight: 500;">/ ${summary.total_watchlist ?? 0}</span>`;
            
            const elDeadApps = document.getElementById('samDeadApps');
            const cardDead = document.getElementById('samCardDead');
            if (elDeadApps) {
                elDeadApps.textContent = summary.dead_apps ?? 0;
                elDeadApps.style.color = (summary.dead_apps || 0) > 0 ? '#f87171' : '#f8fafc';
            }
            if (cardDead) {
                cardDead.style.borderColor = (summary.dead_apps || 0) > 0 ? 'rgba(239, 68, 68, 0.4)' : '';
            }

            const elNeedsCheck = document.getElementById('samNeedsCheck');
            const cardNeedsCheck = document.getElementById('samCardNeedsCheck');
            if (elNeedsCheck) {
                elNeedsCheck.textContent = summary.needs_check ?? 0;
                elNeedsCheck.style.color = (summary.needs_check || 0) > 0 ? '#fbbf24' : '#f8fafc';
            }
            if (cardNeedsCheck) {
                cardNeedsCheck.style.borderColor = (summary.needs_check || 0) > 0 ? 'rgba(245, 158, 11, 0.4)' : '';
            }

            const elUnlisted = document.getElementById('samUnlisted');
            if (elUnlisted) elUnlisted.textContent = summary.unlisted_processes ?? 0;

            const elCpu = document.getElementById('samCpu');
            if (elCpu) elCpu.textContent = summary.cpu_usage !== undefined && summary.cpu_usage !== '—' ? summary.cpu_usage + '%' : '—';

            const elRam = document.getElementById('samRam');
            if (elRam) elRam.textContent = summary.ram_usage_pct !== undefined && summary.ram_usage_pct !== '—' ? summary.ram_usage_pct + '%' : '—';

            const elDisk = document.getElementById('samDisk');
            if (elDisk) elDisk.textContent = summary.disk_usage_pct !== undefined && summary.disk_usage_pct !== '—' ? summary.disk_usage_pct + '%' : '—';

            const elUptime = document.getElementById('samUptime');
            if (elUptime) elUptime.textContent = summary.uptime || '—';
            return;
        }

        container.innerHTML = `
            <div class="server-stat-card">
                <span style="font-size: 11px; color: #94a3b8; text-transform: uppercase;">Aplikasi Wajib</span>
                <div id="samRunningApps" style="font-size: 20px; font-weight: 800; color: #f8fafc; margin-top: 4px;">
                    ${summary.running_apps ?? 0} <span style="font-size: 12px; color: #64748b; font-weight: 500;">/ ${summary.total_watchlist ?? 0}</span>
                </div>
                <span style="font-size: 10.5px; color: #34d399; margin-top: 4px;"><i class="fas fa-check"></i> Aktif Berjalan</span>
            </div>

            <div id="samCardDead" class="server-stat-card" style="${(summary.dead_apps || 0) > 0 ? 'border-color: rgba(239, 68, 68, 0.4);' : ''}">
                <span style="font-size: 11px; color: #94a3b8; text-transform: uppercase;">Aplikasi Mati</span>
                <div id="samDeadApps" style="font-size: 20px; font-weight: 800; color: ${(summary.dead_apps || 0) > 0 ? '#f87171' : '#f8fafc'}; margin-top: 4px;">
                    ${summary.dead_apps ?? 0}
                </div>
                <span style="font-size: 10.5px; color: ${(summary.dead_apps || 0) > 0 ? '#f87171' : '#64748b'}; margin-top: 4px;">
                    <i class="fas fa-times-circle"></i> Butuh Perhatian
                </span>
            </div>

            <div id="samCardNeedsCheck" class="server-stat-card" style="${(summary.needs_check || 0) > 0 ? 'border-color: rgba(245, 158, 11, 0.4);' : ''}">
                <span style="font-size: 11px; color: #94a3b8; text-transform: uppercase;">Perlu Dicek</span>
                <div id="samNeedsCheck" style="font-size: 20px; font-weight: 800; color: ${(summary.needs_check || 0) > 0 ? '#fbbf24' : '#f8fafc'}; margin-top: 4px;">
                    ${summary.needs_check ?? 0}
                </div>
                <span style="font-size: 10.5px; color: ${(summary.needs_check || 0) > 0 ? '#fbbf24' : '#64748b'}; margin-top: 4px;">
                    <i class="fas fa-triangle-exclamation"></i> Anomali / Port Gagal
                </span>
            </div>

            <div class="server-stat-card">
                <span style="font-size: 11px; color: #94a3b8; text-transform: uppercase;">Tak Terdaftar</span>
                <div id="samUnlisted" style="font-size: 20px; font-weight: 800; color: #cbd5e1; margin-top: 4px;">
                    ${summary.unlisted_processes ?? 0}
                </div>
                <span style="font-size: 10.5px; color: #64748b; margin-top: 4px;"><i class="fas fa-eye"></i> Proses Aplikasi Luar</span>
            </div>

            <div class="server-stat-card">
                <span style="font-size: 11px; color: #94a3b8; text-transform: uppercase;">CPU Total</span>
                <div id="samCpu" style="font-size: 20px; font-weight: 800; color: #38bdf8; margin-top: 4px;">
                    ${summary.cpu_usage !== undefined && summary.cpu_usage !== '—' ? summary.cpu_usage + '%' : '—'}
                </div>
                <span style="font-size: 10.5px; color: #64748b; margin-top: 4px;"><i class="fas fa-microchip"></i> hrProcessorLoad</span>
            </div>

            <div class="server-stat-card">
                <span style="font-size: 11px; color: #94a3b8; text-transform: uppercase;">Memori (RAM)</span>
                <div id="samRam" style="font-size: 20px; font-weight: 800; color: #a78bfa; margin-top: 4px;">
                    ${summary.ram_usage_pct !== undefined && summary.ram_usage_pct !== '—' ? summary.ram_usage_pct + '%' : '—'}
                </div>
                <span style="font-size: 10.5px; color: #64748b; margin-top: 4px;"><i class="fas fa-memory"></i> hrStorageRam</span>
            </div>

            <div class="server-stat-card">
                <span style="font-size: 11px; color: #94a3b8; text-transform: uppercase;">Disk Utama</span>
                <div id="samDisk" style="font-size: 20px; font-weight: 800; color: #fb923c; margin-top: 4px;">
                    ${summary.disk_usage_pct !== undefined && summary.disk_usage_pct !== '—' ? summary.disk_usage_pct + '%' : '—'}
                </div>
                <span style="font-size: 10.5px; color: #64748b; margin-top: 4px;"><i class="fas fa-hard-drive"></i> Fixed Disk</span>
            </div>

            <div class="server-stat-card">
                <span style="font-size: 11px; color: #94a3b8; text-transform: uppercase;">Uptime Server</span>
                <div id="samUptime" style="font-size: 17px; font-weight: 700; color: #f8fafc; margin-top: 4px; white-space: nowrap;">
                    ${summary.uptime || '—'}
                </div>
                <span style="font-size: 10.5px; color: #64748b; margin-top: 4px;"><i class="fas fa-clock"></i> sysUpTime</span>
            </div>
        `;
    }

    /**
     * Render Tabel Aplikasi Wajib Aktif (Watchlist)
     */
    function renderWatchlistTab(audit) {
        const watchlist = (audit && audit.watchlist) ? audit.watchlist : [];
        if (watchlist.length === 0) {
            const procCount = (audit && audit.processes) ? audit.processes.length : 0;
            return `
                <div style="text-align: center; padding: 50px 20px; color: #64748b; background: rgba(15, 23, 42, 0.4); border: 1px dashed rgba(255, 255, 255, 0.1); border-radius: 10px; max-width: 720px; margin: 20px auto;">
                    <i class="fas fa-clipboard-list fa-3x" style="opacity: 0.4; margin-bottom: 12px; color: #10b981;"></i>
                    <p style="font-size: 15px; margin: 0; color: #f8fafc; font-weight: 700;">Belum ada aplikasi yang didaftarkan ke Watchlist perangkat ini</p>
                    <p style="font-size: 12.5px; margin-top: 8px; color: #94a3b8; line-height: 1.5;">
                        Server telah mendeteksi <b>${procCount} proses berjalan</b> secara realtime lewat SNMP.<br>
                        Anda dapat langsung melihat semua proses atau menggunakan tombol di bawah untuk mendaftarkan proses wajib.
                    </p>
                    <div style="display: flex; justify-content: center; gap: 12px; margin-top: 18px;">
                        <button onclick="window.serverAuditChangeTab('processes')" style="background: rgba(16, 185, 129, 0.15); color: #34d399; border: 1px solid #10b981; border-radius: 6px; padding: 8px 16px; font-size: 12.5px; font-weight: 700; cursor: pointer; display: inline-flex; align-items: center; gap: 8px;">
                            <i class="fas fa-microchip"></i> Buka Tab Semua Proses Berjalan (${procCount})
                        </button>
                        <button onclick="window.manageServerWatchlistModal()" style="background: rgba(59, 130, 246, 0.15); color: #60a5fa; border: 1px solid #3b82f6; border-radius: 6px; padding: 8px 16px; font-size: 12.5px; font-weight: 600; cursor: pointer; display: inline-flex; align-items: center; gap: 8px;">
                            <i class="fas fa-sliders"></i> Kelola Watchlist
                        </button>
                    </div>
                </div>
            `;
        }

        const rowsHtml = watchlist.map(item => {
            let statusBadge = '';
            let rowStyle = '';
            const status = item.status || 'MATI';

            if (status === 'BERJALAN') {
                statusBadge = `<span class="badge-status berjalan"><i class="fas fa-check-circle"></i> BERJALAN</span>`;
            } else if (status === 'MATI') {
                statusBadge = `<span class="badge-status mati"><i class="fas fa-times-circle"></i> MATI</span>`;
                rowStyle = 'background: rgba(239, 68, 68, 0.08);';
            } else if (status === 'PERLU DICEK') {
                statusBadge = `<span class="badge-status perlu_dicek"><i class="fas fa-triangle-exclamation"></i> PERLU DICEK</span>`;
                rowStyle = 'background: rgba(245, 158, 11, 0.06);';
            } else {
                statusBadge = `<span class="badge-status dikecualikan"><i class="fas fa-wrench"></i> DIKECUALIKAN</span>`;
            }

            // Hasil cek TCP / HTTP
            let checkResultHtml = '<span style="color:#64748b; font-size:11px;">—</span>';
            if (item.checks) {
                const parts = [];
                if (item.checks.tcpPort !== undefined) {
                    const tcpOk = item.checks.tcpOk;
                    parts.push(`
                        <span style="font-size:11px; padding: 2px 6px; border-radius: 4px; background: ${tcpOk ? 'rgba(16,185,129,0.15)' : 'rgba(239,68,68,0.2)'}; color: ${tcpOk ? '#34d399' : '#f87171'}; border: 1px solid ${tcpOk ? '#10b981' : '#ef4444'};">
                            TCP ${item.checks.tcpPort}: ${tcpOk ? 'OK' : 'FAIL'}
                        </span>
                    `);
                }
                if (item.checks.httpUrl !== undefined) {
                    const httpOk = item.checks.httpOk;
                    parts.push(`
                        <span style="font-size:11px; padding: 2px 6px; border-radius: 4px; background: ${httpOk ? 'rgba(16,185,129,0.15)' : 'rgba(239,68,68,0.2)'}; color: ${httpOk ? '#34d399' : '#f87171'}; border: 1px solid ${httpOk ? '#10b981' : '#ef4444'};">
                            HTTP: ${httpOk ? 'OK' : 'FAIL'}
                        </span>
                    `);
                }
                if (parts.length > 0) checkResultHtml = parts.join(' ');
            }

            // Sparkline CPU & RAM
            const cpuSpark = renderSparklineCanvas(item.cpuTrend, '#38bdf8', 55, 16);
            const memSpark = renderSparklineCanvas(item.memTrend, '#a78bfa', 55, 16);

            return `
                <tr style="border-bottom: 1px solid rgba(255, 255, 255, 0.05); ${rowStyle}">
                    <td style="padding: 10px 14px; font-weight: 700; color: #f8fafc;">
                        ${item.name}
                        ${item.severity === 'critical' ? '<span style="color:#ef4444; margin-left:4px;" title="Severity Kritis">*</span>' : ''}
                        <div style="font-size: 11px; color: #64748b; font-family: monospace; font-weight: 400; margin-top: 2px;">
                            ${item.match ? `${item.match.name || ''} ${item.match.pathContains ? '• ' + item.match.pathContains : ''}` : ''}
                        </div>
                    </td>
                    <td style="padding: 10px 14px; color: #cbd5e1; font-size: 12px; text-transform: capitalize;">
                        <i class="${item.match && item.match.type === 'service' ? 'fab fa-windows' : 'fas fa-gear'}" style="margin-right: 6px; color: #94a3b8;"></i>
                        ${item.match ? item.match.type : 'process'}
                    </td>
                    <td style="padding: 10px 14px;">${statusBadge}</td>
                    <td style="padding: 10px 14px; font-family: monospace; font-size: 12px; color: #cbd5e1;">
                        ${item.runningCount || 0} / ${item.expectedCount || 1}
                    </td>
                    <td style="padding: 10px 14px; font-family: monospace; font-size: 11.5px; color: #94a3b8;">
                        ${item.pids && item.pids.length > 0 ? item.pids.join(', ') : '—'}
                    </td>
                    <td style="padding: 10px 14px; font-size: 12px; color: #38bdf8; font-family: monospace;">
                        ${item.cpu !== undefined ? item.cpu + ' cs' : '—'} ${cpuSpark}
                    </td>
                    <td style="padding: 10px 14px; font-size: 12px; color: #a78bfa; font-family: monospace;">
                        ${item.memory !== undefined && item.memory > 0 ? (item.memory >= 1024 ? (item.memory / 1024).toFixed(1) + ' MB' : item.memory + ' KB') : '—'} ${memSpark}
                    </td>
                    <td style="padding: 10px 14px; font-size: 11.5px; color: #94a3b8;">
                        ${item.recentChangeText || 'Stabil'}
                    </td>
                    <td style="padding: 10px 14px;">${checkResultHtml}</td>
                </tr>
            `;
        }).join('');

        return `
            <div style="background: rgba(15, 23, 42, 0.6); border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 8px; overflow: hidden;">
                <table style="width: 100%; border-collapse: collapse; text-align: left; font-size: 12.5px;">
                    <thead>
                        <tr style="background: rgba(255, 255, 255, 0.03); border-bottom: 1px solid rgba(255, 255, 255, 0.08); color: #94a3b8; font-size: 11.5px; text-transform: uppercase;">
                            <th style="padding: 10px 14px;">Nama Aplikasi</th>
                            <th style="padding: 10px 14px;">Tipe</th>
                            <th style="padding: 10px 14px;">Status</th>
                            <th style="padding: 10px 14px;">Instance</th>
                            <th style="padding: 10px 14px;">PID</th>
                            <th style="padding: 10px 14px;">CPU & Tren</th>
                            <th style="padding: 10px 14px;">Memori & Tren</th>
                            <th style="padding: 10px 14px;">Perubahan Terakhir</th>
                            <th style="padding: 10px 14px;">Cek Port / HTTP</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${rowsHtml}
                    </tbody>
                </table>
            </div>
        `;
    }

    /**
     * Render Tabel Semua Proses Berjalan dengan Pencarian, Filter & Paginasi
     */
    function renderProcessesTab(audit) {
        const isSyncing = !audit || !audit.processes || audit.processes.length === 0;
        const processes = (audit && audit.processes) ? audit.processes : [];
        const unlistedPids = new Set((audit && audit.unlisted_processes) ? audit.unlisted_processes.map(p => p.pid) : []);
        const watchlistNames = new Set((audit && audit.watchlist) ? audit.watchlist.map(w => {
            const m = (w.match && w.match.name) ? w.match.name : w.name;
            return String(m || '').toLowerCase();
        }) : []);

        // Filter proses
        let filtered = processes.filter(p => {
            // Pencarian
            if (_procSearchQuery) {
                const q = _procSearchQuery.toLowerCase();
                const matchName = (p.name || '').toLowerCase().includes(q);
                const matchPath = (p.path || '').toLowerCase().includes(q);
                const matchPid = String(p.pid).includes(q);
                if (!matchName && !matchPath && !matchPid) return false;
            }

            // Tipe filter
            if (_procTypeFilter === 'application') {
                return p.type === 'application';
            } else if (_procTypeFilter === 'system') {
                return p.type === 'operatingSystem' || p.type === 'deviceDriver';
            } else if (_procTypeFilter === 'unlisted') {
                return unlistedPids.has(p.pid);
            }
            return true;
        });

        // Urutkan kolom
        filtered.sort((a, b) => {
            let valA = a[_procSortColumn];
            let valB = b[_procSortColumn];
            if (typeof valA === 'string') valA = valA.toLowerCase();
            if (typeof valB === 'string') valB = valB.toLowerCase();
            if (valA < valB) return _procSortDir === 'asc' ? -1 : 1;
            if (valA > valB) return _procSortDir === 'asc' ? 1 : -1;
            return 0;
        });

        // Paginasi
        const totalItems = filtered.length;
        const totalPages = Math.max(1, Math.ceil(totalItems / _procPageSize));
        if (_procPage > totalPages) _procPage = totalPages;
        if (_procPage < 1) _procPage = 1;
        const startIndex = (_procPage - 1) * _procPageSize;
        const pageItems = filtered.slice(startIndex, startIndex + _procPageSize);

        const rowsHtml = pageItems.map(p => {
            const isUnlisted = unlistedPids.has(p.pid);
            const statusColor = p.status === 'running' || p.status === 'runnable' ? '#34d399' : '#f87171';
            const memText = p.memory >= 1024 ? (p.memory / 1024).toFixed(1) + ' MB' : p.memory + ' KB';

            const isWatchlisted = watchlistNames.has(String(p.name || '').toLowerCase());

            return `
                <tr style="border-bottom: 1px solid rgba(255, 255, 255, 0.04); ${isUnlisted ? 'background: rgba(245, 158, 11, 0.04);' : ''}">
                    <td style="padding: 8px 14px; font-weight: 700; color: #f8fafc;">
                        ${p.name || '—'}
                        ${isWatchlisted ? '<span style="font-size:10px; padding:1px 6px; border-radius:3px; background:rgba(16,185,129,0.2); color:#34d399; margin-left:6px; border:1px solid rgba(16,185,129,0.4);"><i class="fas fa-check"></i> Watchlist</span>' : (isUnlisted ? '<span style="font-size:10px; padding:1px 6px; border-radius:3px; background:rgba(245,158,11,0.2); color:#fbbf24; margin-left:6px; border:1px solid rgba(245,158,11,0.4);">Tak Terdaftar</span>' : '')}
                    </td>
                    <td style="padding: 8px 14px; font-family: monospace; color: #94a3b8; font-size: 11.5px;">${p.pid}</td>
                    <td style="padding: 8px 14px; color: #cbd5e1; font-size: 11.5px; font-family: monospace; max-width: 240px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${p.path || '—'}">
                        ${p.path || '—'}
                    </td>
                    <td style="padding: 8px 14px; color: #64748b; font-size: 11px; font-family: monospace; max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${p.parameters || '—'}">
                        ${p.parameters || '—'}
                    </td>
                    <td style="padding: 8px 14px; font-size: 11.5px; color: #94a3b8;">${p.type || 'unknown'}</td>
                    <td style="padding: 8px 14px;">
                        <span style="display:inline-flex; align-items:center; gap:5px; font-size:11px; font-weight:700; color:${statusColor};">
                            <span style="width:6px; height:6px; border-radius:50%; background:${statusColor};"></span>
                            ${p.status || 'unknown'}
                        </span>
                    </td>
                    <td style="padding: 8px 14px; font-family: monospace; font-size: 11.5px; color: #38bdf8;">${p.cpu || 0} cs</td>
                    <td style="padding: 8px 14px; font-family: monospace; font-size: 11.5px; color: #a78bfa;">${memText}</td>
                    <td style="padding: 8px 14px; text-align: center;">
                        ${isWatchlisted
                            ? `<button onclick="window.serverAuditRemoveFromWatchlist('${encodeURIComponent(p.name)}')" title="Hapus dari Watchlist" style="background: rgba(239, 68, 68, 0.12); color: #f87171; border: 1px solid rgba(239, 68, 68, 0.3); border-radius: 4px; padding: 4px 8px; font-size: 11px; cursor: pointer; white-space: nowrap;">
                                 <i class="fas fa-trash-alt"></i> Hapus
                               </button>`
                            : `<button onclick="window.serverAuditAddToWatchlist('${encodeURIComponent(p.name)}')" title="Jadikan Aplikasi Wajib Pantau" style="background: rgba(16, 185, 129, 0.15); color: #34d399; border: 1px solid #10b981; border-radius: 4px; padding: 4px 8px; font-size: 11px; font-weight: 600; cursor: pointer; white-space: nowrap;">
                                 <i class="fas fa-plus"></i> Watchlist
                               </button>`
                        }
                    </td>
                </tr>
            `;
        }).join('');

        // Generate standard pagination HTML
        const startItem = totalItems === 0 ? 0 : startIndex + 1;
        const endItem = Math.min(startIndex + _procPageSize, totalItems);

        // Generate page numbers
        const pageNumbers = [];
        const maxVisiblePages = 5;
        let startP = Math.max(1, _procPage - Math.floor(maxVisiblePages / 2));
        let endP = Math.min(totalPages, startP + maxVisiblePages - 1);
        if (endP - startP + 1 < maxVisiblePages) {
            startP = Math.max(1, endP - maxVisiblePages + 1);
        }
        for (let i = startP; i <= endP; i++) {
            pageNumbers.push(i);
        }

        const paginationButtonsHtml = `
            <div style="display: flex; gap: 4px; align-items: center;">
                <button onclick="window.serverAuditSetPage(1)" ${_procPage === 1 ? 'disabled' : ''} title="Halaman Pertama">
                    <i class="fas fa-angle-double-left"></i>
                </button>
                <button onclick="window.serverAuditPrevPage()" ${_procPage === 1 ? 'disabled' : ''} title="Halaman Sebelumnya">
                    <i class="fas fa-angle-left"></i>
                </button>
                ${startP > 1 ? `<span style="color: #64748b; padding: 0 4px;">...</span>` : ''}
                ${pageNumbers.map(num => `
                    <button onclick="window.serverAuditSetPage(${num})" class="${num === _procPage ? 'active' : ''}">
                        ${num}
                    </button>
                `).join('')}
                ${endP < totalPages ? `<span style="color: #64748b; padding: 0 4px;">...</span>` : ''}
                <button onclick="window.serverAuditNextPage()" ${_procPage === totalPages ? 'disabled' : ''} title="Halaman Selanjutnya">
                    <i class="fas fa-angle-right"></i>
                </button>
                <button onclick="window.serverAuditSetPage(${totalPages})" ${_procPage === totalPages ? 'disabled' : ''} title="Halaman Terakhir">
                    <i class="fas fa-angle-double-right"></i>
                </button>
            </div>
        `;

        return `
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px; gap: 12px; flex-wrap: wrap;">
                <!-- Search box -->
                <div style="position: relative; flex: 1; min-width: 260px; max-width: 360px;">
                    <i class="fas fa-search" style="position: absolute; left: 12px; top: 11px; color: #64748b; font-size: 13px;"></i>
                    <input type="text" id="procSearchInput" value="${_procSearchQuery}" oninput="window.serverAuditSearchProcs(this.value)"
                        placeholder="Cari proses, PID, executable..."
                        style="width: 100%; background: #080e1a; border: 1px solid rgba(255,255,255,0.12); border-radius: 6px; padding: 8px 12px 8px 34px; font-size: 12.5px; color: #f8fafc; outline: none; box-sizing: border-box;">
                </div>

                <!-- Dropdown filter & Page size selector (Menyamakan tampilan filter aplikasi lain) -->
                <div style="display: flex; align-items: center; gap: 10px; flex-wrap: wrap;">
                    <div style="display: flex; align-items: center; gap: 6px;">
                        <span style="font-size: 12px; color: #94a3b8; font-weight: 600;"><i class="fas fa-filter"></i> Filter:</span>
                        <select class="filter-select" onchange="window.serverAuditFilterType(this.value)" style="background: #080e1a; border: 1px solid rgba(255,255,255,0.15); border-radius: 6px; padding: 6px 10px; color: #f8fafc; font-size: 12px; cursor: pointer; outline: none;">
                            <option value="all" ${_procTypeFilter === 'all' ? 'selected' : ''}>Semua Proses (${processes.length})</option>
                            <option value="application" ${_procTypeFilter === 'application' ? 'selected' : ''}>Aplikasi Utama</option>
                            <option value="system" ${_procTypeFilter === 'system' ? 'selected' : ''}>Layanan Sistem OS</option>
                            <option value="unlisted" ${_procTypeFilter === 'unlisted' ? 'selected' : ''}>Tak Terdaftar di Watchlist (${unlistedPids.size})</option>
                        </select>
                    </div>

                    <div style="display: flex; align-items: center; gap: 6px;">
                        <span style="font-size: 12px; color: #94a3b8; font-weight: 600;">Tampilkan:</span>
                        <select class="filter-select" onchange="window.serverAuditChangePageSize(this.value)" style="background: #080e1a; border: 1px solid rgba(255,255,255,0.15); border-radius: 6px; padding: 6px 10px; color: #f8fafc; font-size: 12px; cursor: pointer; outline: none;">
                            <option value="10" ${_procPageSize === 10 ? 'selected' : ''}>10 / hal</option>
                            <option value="25" ${_procPageSize === 25 ? 'selected' : ''}>25 / hal</option>
                            <option value="50" ${_procPageSize === 50 ? 'selected' : ''}>50 / hal</option>
                            <option value="100" ${_procPageSize === 100 ? 'selected' : ''}>100 / hal</option>
                        </select>
                    </div>
                </div>
            </div>

            <div id="procTableContainer" style="background: rgba(15, 23, 42, 0.6); border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 8px; overflow: hidden;">
                <table style="width: 100%; border-collapse: collapse; text-align: left; font-size: 12.5px;">
                    <thead>
                        <tr style="background: rgba(255, 255, 255, 0.03); border-bottom: 1px solid rgba(255, 255, 255, 0.08); color: #94a3b8; font-size: 11.5px; text-transform: uppercase;">
                            <th style="padding: 10px 14px; cursor: pointer;" onclick="window.serverAuditSort('name')">Nama Proses <i class="fas fa-sort"></i></th>
                            <th style="padding: 10px 14px; cursor: pointer;" onclick="window.serverAuditSort('pid')">PID <i class="fas fa-sort"></i></th>
                            <th style="padding: 10px 14px;">Path Executable</th>
                            <th style="padding: 10px 14px;">Parameter</th>
                            <th style="padding: 10px 14px;">Tipe</th>
                            <th style="padding: 10px 14px;">Status</th>
                            <th style="padding: 10px 14px; cursor: pointer;" onclick="window.serverAuditSort('cpu')">CPU <i class="fas fa-sort"></i></th>
                            <th style="padding: 10px 14px; cursor: pointer;" onclick="window.serverAuditSort('memory')">Memori <i class="fas fa-sort"></i></th>
                            <th style="padding: 10px 14px; text-align: center;">Aksi Watchlist</th>
                        </tr>
                    </thead>
                    <tbody id="procTableBody">
                        ${rowsHtml.length > 0 ? rowsHtml : (
                            isSyncing
                                ? `<tr><td colspan="9" style="padding: 40px 20px; text-align: center; color: #38bdf8;">
                                     <i class="fas fa-arrows-rotate fa-spin fa-2x" style="margin-bottom: 10px; display: block;"></i>
                                     <div style="font-weight: 700; font-size: 13.5px; color: #f0f9ff;">Sedang Mengambil Daftar Proses SNMP...</div>
                                     <div style="font-size: 11.5px; color: #94a3b8; margin-top: 4px;">Sedang membaca hrSWRunTable dari PC Server. Harap tunggu beberapa detik.</div>
                                   </td></tr>`
                                : `<tr><td colspan="9" style="padding: 30px; text-align: center; color: #64748b;"><i class="fas fa-inbox" style="margin-right: 6px;"></i> Tidak ada proses yang sesuai dengan kriteria filter atau kata kunci.</td></tr>`
                        )}
                    </tbody>
                </table>
            </div>

            <!-- Standard Pagination Container (Menyamakan tampilan pagination aplikasi) -->
            <div class="pagination-container" style="display: flex; justify-content: space-between; align-items: center; margin-top: 14px; padding: 10px 4px; flex-wrap: wrap; gap: 10px;">
                <div style="font-size: 12px; color: #94a3b8;">
                    Menampilkan <b>${startItem}</b>–<b>${endItem}</b> dari <b>${totalItems}</b> proses
                </div>
                ${paginationButtonsHtml}
            </div>
        `;
    }

    /**
     * Render Bagian Layanan Windows (svSvcTable)
     */
    function renderServicesTab(audit) {
        const services = (audit && audit.services) ? audit.services : [];
        if (services.length === 0) {
            return `
                <div style="text-align: center; padding: 60px 20px; color: #64748b;">
                    <i class="fab fa-windows fa-3x" style="opacity: 0.4; margin-bottom: 12px; color: #38bdf8;"></i>
                    <p style="font-size: 14px; margin: 0; color: #94a3b8;">Tidak ada data Layanan Windows yang dilaporkan oleh perangkat.</p>
                    <p style="font-size: 12px; margin-top: 6px;">Perangkat mungkin berbasis Linux atau SNMP LanMgr-MIB (svSvcTable) tidak aktif.</p>
                </div>
            `;
        }

        const rowsHtml = services.map(svc => {
            const isActive = svc.state === 'active';
            const stateColor = isActive ? '#34d399' : (svc.state === 'paused' ? '#fbbf24' : '#94a3b8');

            return `
                <tr style="border-bottom: 1px solid rgba(255, 255, 255, 0.04);">
                    <td style="padding: 8px 14px; font-weight: 700; color: #f8fafc;">
                        <i class="fab fa-windows" style="margin-right: 8px; color: #38bdf8; opacity: 0.8;"></i>
                        ${svc.name}
                    </td>
                    <td style="padding: 8px 14px;">
                        <span style="display:inline-flex; align-items:center; gap:6px; font-size:11.5px; font-weight:700; color:${stateColor}; text-transform:uppercase;">
                            <span style="width:6px; height:6px; border-radius:50%; background:${stateColor};"></span>
                            ${svc.state}
                        </span>
                    </td>
                </tr>
            `;
        }).join('');

        return `
            <div style="background: rgba(15, 23, 42, 0.6); border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 8px; overflow: hidden; max-width: 800px;">
                <table style="width: 100%; border-collapse: collapse; text-align: left; font-size: 12.5px;">
                    <thead>
                        <tr style="background: rgba(255, 255, 255, 0.03); border-bottom: 1px solid rgba(255, 255, 255, 0.08); color: #94a3b8; font-size: 11px; text-transform: uppercase;">
                            <th style="padding: 10px 14px;">Nama Layanan Windows (svSvcName)</th>
                            <th style="padding: 10px 14px;">Status Operasional (svSvcOperatingState)</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${rowsHtml}
                    </tbody>
                </table>
            </div>
        `;
    }

    /**
     * Render Temuan Audit Otomatis (Anomali & Rekomendasi)
     */
    function renderFindingsTab(audit) {
        const findings = (audit && audit.findings) ? audit.findings : [];
        if (findings.length === 0) {
            return `
                <div style="text-align: center; padding: 60px 20px; color: #64748b;">
                    <i class="fas fa-circle-check fa-3x" style="opacity: 0.6; margin-bottom: 12px; color: #34d399;"></i>
                    <p style="font-size: 14px; margin: 0; color: #34d399; font-weight: 700;">Audit Sempurna: Tidak Ditemukan Anomali</p>
                    <p style="font-size: 12px; margin-top: 6px; color: #94a3b8;">Semua aplikasi watchlist berjalan normal, port merespons, dan penggunaan resource dalam batas aman.</p>
                </div>
            `;
        }

        const cardsHtml = findings.map((f, idx) => {
            let borderColor = '#f87171';
            let bgGradient = 'rgba(239, 68, 68, 0.08)';
            let iconClass = 'fa-triangle-exclamation';
            let iconColor = '#f87171';

            if (f.severity === 'warning') {
                borderColor = '#fbbf24';
                bgGradient = 'rgba(245, 158, 11, 0.08)';
                iconClass = 'fa-circle-exclamation';
                iconColor = '#fbbf24';
            } else if (f.severity === 'info') {
                borderColor = '#38bdf8';
                bgGradient = 'rgba(56, 189, 248, 0.08)';
                iconClass = 'fa-circle-info';
                iconColor = '#38bdf8';
            }

            return `
                <div style="background: ${bgGradient}; border: 1px solid ${borderColor}; border-radius: 8px; padding: 14px 18px; margin-bottom: 12px; display: flex; gap: 14px; align-items: flex-start;">
                    <div style="font-size: 20px; color: ${iconColor}; margin-top: 2px;">
                        <i class="fas ${iconClass}"></i>
                    </div>
                    <div style="flex: 1;">
                        <div style="display: flex; justify-content: space-between; align-items: center;">
                            <span style="font-weight: 700; color: #f8fafc; font-size: 13.5px;">${f.component || 'Komponen'}</span>
                            <span style="font-size: 10.5px; font-weight: 800; text-transform: uppercase; padding: 2px 8px; border-radius: 4px; background: rgba(0,0,0,0.3); color: ${iconColor}; border: 1px solid ${borderColor};">
                                ${f.severity}
                            </span>
                        </div>
                        <div style="font-size: 12.5px; color: #cbd5e1; margin-top: 4px; font-weight: 500;">
                            ${f.issue}
                        </div>
                        ${f.recommendation ? `
                            <div style="font-size: 11.5px; color: #94a3b8; margin-top: 6px; display: flex; align-items: center; gap: 6px;">
                                <i class="fas fa-lightbulb" style="color: #fbbf24;"></i> Rekomendasi: ${f.recommendation}
                            </div>
                        ` : ''}
                    </div>
                </div>
            `;
        }).join('');

        return `
            <div style="max-width: 900px;">
                <div style="margin-bottom: 14px; font-size: 12.5px; color: #94a3b8;">
                    Daftar temuan anomali diurutkan otomatis dari yang paling berisiko terhadap ketersediaan sistem:
                </div>
                ${cardsHtml}
            </div>
        `;
    }

    /**
     * Render Keseluruhan Tampilan Konten Audit (Smooth in-place & scroll retention)
     */
    function renderServerAuditContent() {
        const content = document.getElementById('serverAuditContent');
        if (!content) return;

        const audit = _lastAuditData;
        const live = _lastLiveData;

        // Update hitungan di tab button
        const countW = document.getElementById('tabCountWatchlist');
        const countP = document.getElementById('tabCountProcesses');
        const countS = document.getElementById('tabCountServices');
        const countF = document.getElementById('tabCountFindings');

        if (countW && audit && audit.watchlist) countW.textContent = audit.watchlist.length;
        if (countP && audit && audit.processes) countP.textContent = audit.processes.length;
        if (countS && audit && audit.services) countS.textContent = audit.services.length;
        if (countF && audit && audit.findings) countF.textContent = audit.findings.length;

        // Catat posisi scroll sebelum render
        const prevScrollTop = content.scrollTop;
        const prevScrollLeft = content.scrollLeft;

        // Periksa apakah pengguna sedang mengetik di input search proses
        const searchInput = document.getElementById('procSearchInput');
        const isSearchFocused = searchInput && document.activeElement === searchInput;
        const cursorStart = searchInput ? searchInput.selectionStart : 0;
        const cursorEnd = searchInput ? searchInput.selectionEnd : 0;

        // Sub-container scroll positions
        const procTableContainer = document.getElementById('procTableContainer');
        const procScrollTop = procTableContainer ? procTableContainer.scrollTop : 0;

        const isSyncing = !audit || !audit.processes || audit.processes.length === 0;

        const syncNoticeHtml = isSyncing ? `
            <div style="background: rgba(14, 165, 233, 0.12); border: 1px solid rgba(14, 165, 233, 0.35); border-radius: 8px; padding: 12px 16px; margin-bottom: 16px; display: flex; align-items: center; justify-content: space-between; gap: 14px;">
                <div style="display: flex; align-items: center; gap: 12px;">
                    <i class="fas fa-arrows-rotate fa-spin" style="color: #38bdf8; font-size: 18px;"></i>
                    <div>
                        <div style="font-size: 13px; font-weight: 700; color: #f0f9ff;">
                            Sedang Melakukan Sinkronisasi Data Realtime...
                        </div>
                        <div style="font-size: 11.5px; color: #94a3b8; margin-top: 2px;">
                            Sistem sedang membaca daftar PID, penggunaan CPU/RAM, dan status aplikasi dari perangkat target lewat SNMP. Mohon tunggu beberapa detik.
                        </div>
                    </div>
                </div>
                <span style="font-size: 11px; font-weight: 700; background: rgba(56, 189, 248, 0.2); color: #38bdf8; border: 1px solid rgba(56, 189, 248, 0.4); padding: 4px 10px; border-radius: 6px; white-space: nowrap;">
                    <i class="fas fa-satellite-dish"></i> Syncing SNMP
                </span>
            </div>
        ` : '';

        // Render tab yang sedang aktif
        let tabHtml = '';
        if (_activeTab === 'watchlist') {
            tabHtml = renderWatchlistTab(audit);
        } else if (_activeTab === 'processes') {
            tabHtml = renderProcessesTab(audit);
        } else if (_activeTab === 'services') {
            tabHtml = renderServicesTab(audit);
        } else if (_activeTab === 'findings') {
            tabHtml = renderFindingsTab(audit);
        }

        content.innerHTML = syncNoticeHtml + tabHtml;

        // Kembalikan posisi scroll kontainer utama
        content.scrollTop = prevScrollTop;
        content.scrollLeft = prevScrollLeft;

        // Kembalikan scroll pada sub-container jika ada
        const newProcContainer = document.getElementById('procTableContainer');
        if (newProcContainer && procScrollTop > 0) {
            newProcContainer.scrollTop = procScrollTop;
        }

        // Kembalikan fokus dan kursor pengetikan jika sebelumnya aktif
        if (isSearchFocused) {
            const newSearchInput = document.getElementById('procSearchInput');
            if (newSearchInput) {
                newSearchInput.focus();
                try {
                    newSearchInput.setSelectionRange(cursorStart, cursorEnd);
                } catch (e) {}
            }
        }
    }

    /**
     * Ganti Tab Aktif
     */
    window.serverAuditChangeTab = function (tab) {
        _activeTab = tab;
        ['watchlist', 'processes', 'services', 'findings'].forEach(t => {
            const btn = document.getElementById(`tabBtn${t.charAt(0).toUpperCase() + t.slice(1)}`);
            if (btn) {
                if (t === tab) btn.classList.add('active');
                else btn.classList.remove('active');
            }
        });
        renderServerAuditContent();
    };

    /**
     * Handler pencarian & filter tabel proses
     */
    window.serverAuditSearchProcs = function (q) {
        _procSearchQuery = q;
        _procPage = 1;
        renderServerAuditContent();
    };

    window.serverAuditFilterType = function (type) {
        _procTypeFilter = type;
        _procPage = 1;
        renderServerAuditContent();
    };

    window.serverAuditSort = function (column) {
        if (_procSortColumn === column) {
            _procSortDir = _procSortDir === 'asc' ? 'desc' : 'asc';
        } else {
            _procSortColumn = column;
            _procSortDir = 'asc';
        }
        renderServerAuditContent();
    };

    window.serverAuditPrevPage = function () {
        if (_procPage > 1) {
            _procPage--;
            renderServerAuditContent();
        }
    };

    window.serverAuditNextPage = function () {
        _procPage++;
        renderServerAuditContent();
    };

    window.serverAuditSetPage = function (pageNum) {
        const p = parseInt(pageNum, 10);
        if (!isNaN(p) && p >= 1) {
            _procPage = p;
            renderServerAuditContent();
        }
    };

    window.serverAuditChangePageSize = function (size) {
        const s = parseInt(size, 10);
        if (!isNaN(s) && s > 0) {
            _procPageSize = s;
            _procPage = 1;
            renderServerAuditContent();
        }
    };

    /**
     * Cari objek source & live data untuk Server PC
     */
    function findServerSourceAndData(sourceId) {
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

        // 2. Cek dari window._sourcesCache
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
                            parsing_id: matchSrc.parser || matchSrc.parsing_id || 'snmp_system'
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
     * Buka Layar Penuh Audit Aplikasi PC / Server
     */
    window.openServerAuditScope = function (sourceId) {
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

        ensureServerAuditDOMElements();

        if (!sourceId && window._activeSourceDetail) {
            sourceId = window._activeSourceDetail.id;
        }
        _activeServerSourceId = sourceId;

        const overlay = document.getElementById('serverAuditOverlay');
        const modal = document.getElementById('serverAuditModal');

        if (overlay) overlay.style.display = 'block';
        if (modal) {
            modal.style.display = 'flex';
            setTimeout(() => modal.classList.add('open'), 10);
        }

        // Ambil data pertama kali & jalankan auto-refresh berkala
        _activeTab = 'processes';
        window.serverAuditChangeTab('processes');
        refreshServerAuditRealtime();

        if (_activeServerTimer) clearInterval(_activeServerTimer);
        _activeServerTimer = setInterval(() => {
            if (!_activeServerSourceId || !modal.classList.contains('open')) {
                window.closeServerAuditModal();
                return;
            }

            const { src } = findServerSourceAndData(_activeServerSourceId);
            if (src && src.equipt_id) {
                fetch(`/api/equipment/${src.equipt_id}`, {
                    headers: window.getAuthHeaders ? window.getAuthHeaders() : {}
                })
                    .then(r => r.ok ? r.json() : null)
                    .then(eqData => {
                        if (eqData && typeof window.updateEquipmentCacheEntry === 'function') {
                            window.updateEquipmentCacheEntry(eqData);
                        }
                        refreshServerAuditRealtime();
                    })
                    .catch(() => {
                        refreshServerAuditRealtime();
                    });
            } else {
                refreshServerAuditRealtime();
            }
        }, 2000);
    };

    window.refreshServerAuditNow = function () {
        const { src } = findServerSourceAndData(_activeServerSourceId);
        if (src && src.equipt_id) {
            fetch(`/api/equipment/${src.equipt_id}`, {
                headers: window.getAuthHeaders ? window.getAuthHeaders() : {}
            })
                .then(r => r.ok ? r.json() : null)
                .then(eqData => {
                    if (eqData && typeof window.updateEquipmentCacheEntry === 'function') {
                        window.updateEquipmentCacheEntry(eqData);
                    }
                    refreshServerAuditRealtime();
                })
                .catch(() => refreshServerAuditRealtime());
        } else {
            refreshServerAuditRealtime();
        }
    };

    /**
     * Tutup Layar Penuh Audit
     */
    window.closeServerAuditModal = function () {
        const overlay = document.getElementById('serverAuditOverlay');
        const modal = document.getElementById('serverAuditModal');

        if (modal) modal.classList.remove('open');
        setTimeout(() => {
            if (overlay) overlay.style.display = 'none';
            if (modal) modal.style.display = 'none';
        }, 200);

        if (_activeServerTimer) {
            clearInterval(_activeServerTimer);
            _activeServerTimer = null;
        }
        _activeServerSourceId = null;
    };

    /**
     * Polling refresh data audit realtime dari cache aplikasi
     */
    function refreshServerAuditRealtime() {
        if (!_activeServerSourceId) return;

        const { src, data } = findServerSourceAndData(_activeServerSourceId);
        if (!src && !data) return;

        if (data) {
            _lastLiveData = data;
            if (data.audit_server) {
                _lastAuditData = data.audit_server;
            }
        }

        // Update header sub-title
        const subTitle = document.getElementById('serverAuditSubTitle');
        if (subTitle) {
            const ip = (data && (data.resolved_ip || data.ip)) || (src && src.ip_address) || '—';
            const os = (data && (data.operating_system || (data.SISTEM && data.SISTEM.operating_system))) || '—';
            const uptime = (data && (data.sys_uptime || (data.SISTEM && data.SISTEM.sys_uptime))) || '—';
            subTitle.textContent = `IP: ${ip} | OS: ${os} | Uptime: ${uptime}`;
        }

        const titleEl = document.getElementById('serverAuditTitle');
        if (titleEl && src && src.name) {
            titleEl.textContent = `AUDIT APLIKASI: ${src.name}`;
        }

        const lastSync = document.getElementById('serverAuditLastSync');
        if (lastSync) {
            const isSyncing = !_lastAuditData || !_lastAuditData.processes || _lastAuditData.processes.length === 0;
            if (isSyncing) {
                lastSync.innerHTML = `<span style="color: #38bdf8; font-weight: 700;"><i class="fas fa-arrows-rotate fa-spin"></i> Sinkronisasi SNMP...</span>`;
            } else {
                const now = new Date();
                lastSync.innerHTML = `<i class="fas fa-check" style="color:#34d399;"></i> Diperbarui ${now.toLocaleTimeString()}`;
            }
        }

        renderServerAuditMetrics(_lastAuditData, _lastLiveData);
        renderServerAuditContent();
    }

    /**
     * Ekspor Hasil Audit ke format CSV
     */
    window.exportServerAuditCSV = function () {
        if (!_lastAuditData) {
            alert('Belum ada data audit untuk diekspor.');
            return;
        }

        const audit = _lastAuditData;
        const live = _lastLiveData || {};
        const ip = live.resolved_ip || 'server';
        const dateStr = new Date().toISOString().replace(/[:.]/g, '-');

        let csv = `AUDIT APLIKASI SERVER / PC\n`;
        csv += `Perangkat,${live.sys_name || '—'} (${ip})\n`;
        csv += `Waktu Evaluasi,${audit.evaluated_at || new Date().toISOString()}\n`;
        csv += `Health Score,${audit.health_score ? audit.health_score.level : 'Normal'}\n\n`;

        // Section 1: Watchlist
        csv += `--- APLIKASI WAJIB AKTIF (WATCHLIST) ---\n`;
        csv += `Nama Aplikasi,Tipe,Status,Instance,PID,CPU,Memori,Cek Tambahan\n`;
        if (audit.watchlist && audit.watchlist.length > 0) {
            audit.watchlist.forEach(w => {
                const pids = (w.pids || []).join(';');
                csv += `"${w.name}","${w.match ? w.match.type : 'process'}","${w.status}","${w.runningCount || 0}/${w.expectedCount || 1}","${pids}","${w.cpu || 0}","${w.memory || 0}","${w.recentChangeText || ''}"\n`;
            });
        } else {
            csv += `(Tidak ada entri watchlist)\n`;
        }

        csv += `\n--- SEMUA PROSES BERJALAN ---\n`;
        csv += `PID,Nama Proses,Path,Tipe,Status,CPU (cs),Memori (KB)\n`;
        if (audit.processes && audit.processes.length > 0) {
            audit.processes.forEach(p => {
                csv += `"${p.pid}","${p.name || ''}","${p.path || ''}","${p.type || ''}","${p.status || ''}","${p.cpu || 0}","${p.memory || 0}"\n`;
            });
        }

        csv += `\n--- TEMUAN AUDIT OTOMATIS ---\n`;
        csv += `Severity,Komponen,Masalah,Rekomendasi\n`;
        if (audit.findings && audit.findings.length > 0) {
            audit.findings.forEach(f => {
                csv += `"${f.severity}","${f.component}","${f.issue}","${f.recommendation || ''}"\n`;
            });
        }

        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `audit_server_${ip}_${dateStr}.csv`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    };

    /**
     * Tambah Proses ke Watchlist Host Secara Cepat (One-Click)
     */
    window.serverAuditAddToWatchlist = async function (procNameRaw) {
        const procName = decodeURIComponent(procNameRaw || '').trim();
        if (!procName) return;

        const live = _lastLiveData || {};
        const host = live.resolved_ip || live.ip || '';
        if (!host) {
            alert('Alamat host server belum terdeteksi.');
            return;
        }

        try {
            let existingApps = [];
            const getRes = await fetch(`/api/server-audit/watchlist?host=${encodeURIComponent(host)}`);
            if (getRes.ok) {
                const json = await getRes.json();
                existingApps = Array.isArray(json.apps) ? json.apps : [];
            }

            const procNameLower = procName.toLowerCase();
            const exists = existingApps.some(app => {
                const target = (app.match && app.match.name) ? app.match.name : app.name;
                return String(target || '').toLowerCase() === procNameLower;
            });

            if (exists) {
                alert(`Aplikasi "${procName}" sudah terdaftar di Watchlist ${host}.`);
                return;
            }

            const newEntry = {
                name: procName.charAt(0).toUpperCase() + procName.slice(1),
                match: {
                    type: 'process',
                    name: procName
                },
                expectedCount: 1,
                severity: 'critical'
            };

            const updatedApps = [...existingApps, newEntry];
            const postRes = await fetch('/api/server-audit/watchlist', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ host, apps: updatedApps })
            });

            if (postRes.ok) {
                refreshServerAuditRealtime();
            } else {
                const errData = await postRes.json();
                alert(`Gagal menambahkan ke watchlist: ${errData.error || 'Server error'}`);
            }
        } catch (err) {
            alert(`Terjadi kesalahan: ${err.message}`);
        }
    };

    /**
     * Hapus Proses dari Watchlist Host Secara Cepat
     */
    window.serverAuditRemoveFromWatchlist = async function (procNameRaw) {
        const procName = decodeURIComponent(procNameRaw || '').trim();
        if (!procName) return;

        const live = _lastLiveData || {};
        const host = live.resolved_ip || live.ip || '';
        if (!host) {
            alert('Alamat host server belum terdeteksi.');
            return;
        }

        if (!confirm(`Hapus "${procName}" dari daftar Watchlist perangkat ${host}?`)) {
            return;
        }

        try {
            let existingApps = [];
            const getRes = await fetch(`/api/server-audit/watchlist?host=${encodeURIComponent(host)}`);
            if (getRes.ok) {
                const json = await getRes.json();
                existingApps = Array.isArray(json.apps) ? json.apps : [];
            }

            const procNameLower = procName.toLowerCase();
            const updatedApps = existingApps.filter(app => {
                const target = (app.match && app.match.name) ? app.match.name : app.name;
                return String(target || '').toLowerCase() !== procNameLower;
            });

            const postRes = await fetch('/api/server-audit/watchlist', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ host, apps: updatedApps })
            });

            if (postRes.ok) {
                refreshServerAuditRealtime();
            } else {
                const errData = await postRes.json();
                alert(`Gagal menghapus dari watchlist: ${errData.error || 'Server error'}`);
            }
        } catch (err) {
            alert(`Terjadi kesalahan: ${err.message}`);
        }
    };

    /**
     * Modal Visual Kelola Watchlist (UI Interaktif Daftar, Tambah & Hapus)
     */
    window.manageServerWatchlistModal = async function () {
        const live = _lastLiveData || {};
        const host = live.resolved_ip || live.ip || '';
        if (!host) {
            alert('Alamat host server belum terdeteksi.');
            return;
        }

        let existingApps = [];
        try {
            const res = await fetch(`/api/server-audit/watchlist?host=${encodeURIComponent(host)}`);
            if (res.ok) {
                const json = await res.json();
                existingApps = Array.isArray(json.apps) ? json.apps : [];
            }
        } catch (e) {}

        const existingModal = document.getElementById('manageWatchlistModalOverlay');
        if (existingModal) existingModal.remove();

        const overlay = document.createElement('div');
        overlay.id = 'manageWatchlistModalOverlay';
        overlay.style.cssText = `
            position: fixed; inset: 0; z-index: 100010;
            background: rgba(0, 0, 0, 0.75); backdrop-filter: blur(4px);
            display: flex; align-items: center; justify-content: center;
        `;

        const renderItems = () => {
            if (existingApps.length === 0) {
                return `
                    <div style="text-align: center; padding: 25px 15px; color: #64748b; font-size: 13px;">
                        <i class="fas fa-inbox fa-2x" style="opacity: 0.5; margin-bottom: 8px;"></i>
                        <p style="margin: 0;">Belum ada aplikasi dalam watchlist untuk <b>${host}</b>.</p>
                        <p style="margin: 4px 0 0 0; font-size: 11.5px; color: #94a3b8;">Gunakan form di bawah atau tombol <b>[+ Watchlist]</b> di tab Semua Proses.</p>
                    </div>
                `;
            }

            return existingApps.map((app, idx) => {
                const appName = (app.match && app.match.name) ? app.match.name : app.name;
                const type = (app.match && app.match.type) ? app.match.type : 'process';
                const sev = app.severity || 'critical';
                const sevColor = sev === 'critical' ? '#f87171' : (sev === 'warning' ? '#fbbf24' : '#60a5fa');
                return `
                    <div style="display: flex; align-items: center; justify-content: space-between; padding: 9px 12px; background: rgba(255, 255, 255, 0.03); border: 1px solid rgba(255, 255, 255, 0.06); border-radius: 6px; margin-bottom: 6px;">
                        <div>
                            <div style="font-weight: 700; color: #f8fafc; font-size: 13px;">
                                ${app.name || appName}
                                <span style="font-size: 10px; font-weight: 600; padding: 1px 6px; border-radius: 3px; background: rgba(255, 255, 255, 0.08); color: ${sevColor}; margin-left: 6px; border: 1px solid ${sevColor}44;">
                                    ${sev.toUpperCase()}
                                </span>
                            </div>
                            <div style="font-size: 11px; color: #94a3b8; font-family: monospace; margin-top: 2px;">
                                ${type} : <span style="color: #38bdf8;">${appName}</span>
                                ${app.expectedCount ? ` • Min: ${app.expectedCount}` : ''}
                            </div>
                        </div>
                        <button onclick="window._watchlistModalDeleteItem(${idx})" style="background: rgba(239, 68, 68, 0.15); color: #f87171; border: 1px solid rgba(239, 68, 68, 0.3); border-radius: 4px; padding: 4px 8px; font-size: 11px; cursor: pointer;">
                            <i class="fas fa-trash-alt"></i> Hapus
                        </button>
                    </div>
                `;
            }).join('');
        };

        overlay.innerHTML = `
            <div style="background: #0f172a; border: 1px solid rgba(255, 255, 255, 0.12); border-radius: 10px; width: 560px; max-width: 95vw; max-height: 85vh; display: flex; flex-direction: column; box-shadow: 0 20px 40px rgba(0,0,0,0.6); overflow: hidden;">
                <!-- Header -->
                <div style="display: flex; align-items: center; justify-content: space-between; padding: 14px 18px; border-bottom: 1px solid rgba(255, 255, 255, 0.08); background: #0b1120;">
                    <div>
                        <div style="font-weight: 800; color: #f8fafc; font-size: 15px; display: flex; align-items: center; gap: 8px;">
                            <i class="fas fa-sliders" style="color: #10b981;"></i> Kelola Watchlist Aplikasi Wajib
                        </div>
                        <div style="font-size: 11.5px; color: #94a3b8; font-family: monospace; margin-top: 2px;">Target Host: ${host}</div>
                    </div>
                    <button onclick="document.getElementById('manageWatchlistModalOverlay').remove()" style="background: transparent; border: none; color: #94a3b8; font-size: 16px; cursor: pointer; padding: 4px 8px;">
                        <i class="fas fa-times"></i>
                    </button>
                </div>

                <!-- Body (Daftar) -->
                <div id="watchlistModalListContainer" style="padding: 14px 18px; overflow-y: auto; flex: 1; max-height: 320px;">
                    ${renderItems()}
                </div>

                <!-- Form Tambah Baru -->
                <div style="padding: 12px 18px; background: rgba(0, 0, 0, 0.25); border-top: 1px solid rgba(255, 255, 255, 0.08);">
                    <div style="font-size: 11.5px; font-weight: 700; color: #cbd5e1; margin-bottom: 6px;">Tambah Aplikasi Baru:</div>
                    <div style="display: flex; gap: 8px;">
                        <input id="inputNewWatchlistName" type="text" placeholder="Nama proses (contoh: mysqld, nginx.exe)" style="flex: 1; background: #0b1120; border: 1px solid rgba(255, 255, 255, 0.15); border-radius: 5px; padding: 6px 10px; color: #f8fafc; font-size: 12px; font-family: monospace;" />
                        <button onclick="window._watchlistModalAddNewItem()" style="background: rgba(16, 185, 129, 0.2); color: #34d399; border: 1px solid #10b981; border-radius: 5px; padding: 6px 14px; font-size: 12px; font-weight: 700; cursor: pointer; white-space: nowrap;">
                            <i class="fas fa-plus"></i> Tambah
                        </button>
                    </div>
                </div>

                <!-- Footer -->
                <div style="display: flex; justify-content: flex-end; gap: 10px; padding: 12px 18px; border-top: 1px solid rgba(255, 255, 255, 0.08); background: #0b1120;">
                    <button onclick="document.getElementById('manageWatchlistModalOverlay').remove()" style="background: rgba(255, 255, 255, 0.08); color: #cbd5e1; border: 1px solid rgba(255, 255, 255, 0.15); border-radius: 6px; padding: 6px 14px; font-size: 12px; cursor: pointer;">
                        Batal
                    </button>
                    <button onclick="window._watchlistModalSave()" style="background: #10b981; color: #022c22; border: none; border-radius: 6px; padding: 6px 16px; font-size: 12px; font-weight: 800; cursor: pointer; display: inline-flex; align-items: center; gap: 6px;">
                        <i class="fas fa-check"></i> Simpan Perubahan
                    </button>
                </div>
            </div>
        `;

        window._watchlistModalDeleteItem = function (index) {
            existingApps.splice(index, 1);
            const listEl = document.getElementById('watchlistModalListContainer');
            if (listEl) listEl.innerHTML = renderItems();
        };

        window._watchlistModalAddNewItem = function () {
            const input = document.getElementById('inputNewWatchlistName');
            const val = (input ? input.value : '').trim();
            if (!val) return;
            const exists = existingApps.some(a => {
                const t = (a.match && a.match.name) ? a.match.name : a.name;
                return String(t || '').toLowerCase() === val.toLowerCase();
            });
            if (exists) {
                alert(`Aplikasi "${val}" sudah ada dalam daftar.`);
                return;
            }
            existingApps.push({
                name: val.charAt(0).toUpperCase() + val.slice(1),
                match: { type: 'process', name: val },
                expectedCount: 1,
                severity: 'critical'
            });
            input.value = '';
            const listEl = document.getElementById('watchlistModalListContainer');
            if (listEl) listEl.innerHTML = renderItems();
        };

        window._watchlistModalSave = async function () {
            try {
                const postRes = await fetch('/api/server-audit/watchlist', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ host, apps: existingApps })
                });

                if (postRes.ok) {
                    overlay.remove();
                    refreshServerAuditRealtime();
                } else {
                    const errData = await postRes.json();
                    alert(`Gagal menyimpan: ${errData.error || 'Server error'}`);
                }
            } catch (err) {
                alert(`Gagal menyimpan: ${err.message}`);
            }
        };

        document.body.appendChild(overlay);
    };

    // Inisialisasi style saat dokumen siap
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', addServerAuditStyles);
    } else {
        addServerAuditStyles();
    }
})();
