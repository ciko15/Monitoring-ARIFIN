'use strict';

/**
 * server_audit_engine.js
 * Modul fungsi murni untuk audit aplikasi/proses/service PC & Server.
 * Menyediakan:
 * 1. Pencocokan proses & service dengan Watchlist (regex/wildcard, prefix, path, case-insensitive).
 * 2. Logika status: BERJALAN, MATI, PERLU DICEK (notRunnable, count mismatch, leak, cpu spike, port/http fail).
 * 3. Identifikasi Proses Tak Terdaftar (Application type non-system).
 * 4. Pengecekan jaringan backend (TCP port, HTTP health check) khusus untuk target watchlist.
 * 5. Evaluasi Health Score PC (Kritis, Peringatan, Normal).
 * 6. Trend CPU & Memori in-memory per aplikasi.
 */

const net = require('net');
const http = require('http');
const https = require('https');
const auditConfig = require('../config/server_audit_config');

// In-memory snapshot map untuk deteksi perubahan & tren (Map per device host/IP)
// Key: host
// Value: { timestamp: number, apps: Map(appName => { status, pid, cpuTrend: [], memTrend: [], lastChangedAt }) }
const serverAuditSnapshots = new Map();

/**
 * Tes konektivitas port TCP dengan timeout pendek (Backend-only)
 */
function checkTcpPort(host, port, timeoutMs = 1500) {
    return new Promise((resolve) => {
        if (!host || !port) return resolve({ ok: false, error: 'Host or port missing' });
        const socket = new net.Socket();
        let isDone = false;

        socket.setTimeout(timeoutMs);

        socket.on('connect', () => {
            if (!isDone) {
                isDone = true;
                socket.destroy();
                resolve({ ok: true });
            }
        });

        socket.on('timeout', () => {
            if (!isDone) {
                isDone = true;
                socket.destroy();
                resolve({ ok: false, error: `Timeout > ${timeoutMs}ms` });
            }
        });

        socket.on('error', (err) => {
            if (!isDone) {
                isDone = true;
                socket.destroy();
                resolve({ ok: false, error: err.message });
            }
        });

        try {
            socket.connect(port, host);
        } catch (e) {
            resolve({ ok: false, error: e.message });
        }
    });
}

/**
 * Tes HTTP GET health check dengan timeout pendek
 */
function checkHttpUrl(targetUrl, timeoutMs = 2500) {
    return new Promise((resolve) => {
        if (!targetUrl) return resolve({ ok: false, error: 'URL missing' });
        try {
            const urlObj = new URL(targetUrl);
            const client = urlObj.protocol === 'https:' ? https : http;

            const req = client.get(targetUrl, { timeout: timeoutMs }, (res) => {
                const is2xx = res.statusCode >= 200 && res.statusCode < 400;
                res.resume(); // Buang body data
                resolve({ ok: is2xx, statusCode: res.statusCode });
            });

            req.on('timeout', () => {
                req.destroy();
                resolve({ ok: false, error: `Timeout > ${timeoutMs}ms` });
            });

            req.on('error', (err) => {
                resolve({ ok: false, error: err.message });
            });
        } catch (e) {
            resolve({ ok: false, error: e.message });
        }
    });
}

/**
 * Cocokkan nama dengan pola wildcard sederhana (misal: "ILSMonitor*" atau exact match)
 */
function matchPattern(value, pattern) {
    if (!value || !pattern) return false;
    const val = String(value).toLowerCase().trim();
    const pat = String(pattern).toLowerCase().trim();

    if (val === pat) return true;
    if (val.startsWith(pat) || pat.startsWith(val)) return true;

    // Wildcard support (*)
    if (pat.includes('*')) {
        const regexStr = '^' + pat.split('*').map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$';
        return new RegExp(regexStr).test(val);
    }
    return false;
}

/**
 * Jalankan kalkulasi audit aplikasi secara murni
 * @param {string} host - IP Host/Target
 * @param {object} params - { processes, services, ucdProcs, watchlist, systemMetrics }
 * @returns {Promise<object>}
 */
async function computeServerAudit(host, { processes = [], services = [], ucdProcs = [], watchlist = [], systemMetrics = {} } = {}) {
    const now = Date.now();
    const prevDeviceSnapshot = serverAuditSnapshots.get(host) || { timestamp: now, apps: new Map() };
    const newAppsSnapshot = new Map();

    const findings = [];
    const auditedWatchlist = [];
    const matchedPids = new Set();
    const matchedServiceNames = new Set();

    let criticalFailedCount = 0;
    let warningFailedCount = 0;
    let runningAppCount = 0;
    let deadAppCount = 0;
    let needsCheckCount = 0;

    // 1. EVALUASI SETIAP ITEM WATCHLIST
    for (const item of watchlist) {
        const matchCfg = item.match || {};
        const expectedCount = item.expectedCount !== undefined ? item.expectedCount : 1;
        const severity = (item.severity || 'warning').toLowerCase();
        const appName = item.name || 'Aplikasi';

        let instances = [];
        let status = 'MATI'; // Default jika tidak ditemukan
        let statusReason = '';
        let matchedService = null;

        if (matchCfg.type === 'service') {
            // Pencocokan Service Windows
            const foundSvc = services.find(s => matchPattern(s.name, matchCfg.name));
            if (foundSvc) {
                matchedServiceNames.add(foundSvc.name.toLowerCase());
                matchedService = foundSvc;
                const opState = String(foundSvc.operatingState || '').toLowerCase();
                const isRunning = opState === 'active' || opState === '1';

                instances.push({
                    name: foundSvc.name,
                    pid: '—',
                    status: isRunning ? 'active' : opState,
                    cpu: '—',
                    memoryKb: 0
                });

                if (isRunning) {
                    status = 'BERJALAN';
                } else {
                    status = 'PERLU DICEK';
                    statusReason = `Service berstatus: ${foundSvc.operatingState}`;
                }
            } else {
                status = 'MATI';
                statusReason = 'Service tidak ditemukan dalam tabel svSvcTable';
            }
        } else {
            // Pencocokan Proses (hrSWRunTable)
            for (const p of processes) {
                const nameMatch = matchPattern(p.name, matchCfg.name);
                let pathMatch = true;
                if (matchCfg.pathContains && p.path) {
                    pathMatch = String(p.path).toLowerCase().includes(String(matchCfg.pathContains).toLowerCase());
                }

                if (nameMatch && pathMatch) {
                    instances.push(p);
                    matchedPids.add(p.pid);
                }
            }

            if (instances.length === 0) {
                status = 'MATI';
                statusReason = `Proses tidak ditemukan (${matchCfg.name})`;
            } else {
                const runningInstances = instances.filter(i => i.status === 'running' || i.status === 'runnable' || i.statusCode === 1 || i.statusCode === 2);
                const notRunnable = instances.find(i => i.status === 'notRunnable' || i.statusCode === 3);

                if (notRunnable) {
                    status = 'PERLU DICEK';
                    statusReason = `Proses PID ${notRunnable.pid} berstatus Not Runnable`;
                } else if (instances.length !== expectedCount) {
                    status = 'PERLU DICEK';
                    statusReason = `Jumlah instance (${instances.length}) tidak sesuai target (${expectedCount})`;
                } else {
                    status = 'BERJALAN';
                }
            }
        }

        // Pengecekan Tambahan (TCP Port / HTTP Health Check) jika dikonfigurasi & proses ada
        let optionalCheckResult = null;
        if (item.optionalChecks && (status === 'BERJALAN' || status === 'PERLU DICEK')) {
            const checks = item.optionalChecks;
            let portResult = null;
            let httpResult = null;

            if (checks.tcpPort) {
                portResult = await checkTcpPort(host, checks.tcpPort, auditConfig.thresholds.tcp_check_timeout_ms);
                if (!portResult.ok) {
                    status = 'PERLU DICEK';
                    statusReason = statusReason ? `${statusReason} | Port ${checks.tcpPort} gagal: ${portResult.error}` : `Port TCP ${checks.tcpPort} tertutup/timeout`;
                }
            }

            if (checks.httpUrl) {
                httpResult = await checkHttpUrl(checks.httpUrl, auditConfig.thresholds.http_check_timeout_ms);
                if (!httpResult.ok) {
                    status = 'PERLU DICEK';
                    statusReason = statusReason ? `${statusReason} | HTTP Check gagal` : `Endpoint HTTP gagal (${httpResult.error || httpResult.statusCode})`;
                }
            }

            optionalCheckResult = { port: portResult, http: httpResult };
        }

        // Hitung Tren CPU / Memori & Perubahan
        const prevAppHistory = prevDeviceSnapshot.apps.get(appName) || {
            status: null,
            pid: null,
            cpuTrend: [],
            memTrend: [],
            lastChangedAt: now
        };

        const totalCpu = instances.reduce((acc, i) => acc + (Number(i.cpu) || 0), 0);
        const totalMemKb = instances.reduce((acc, i) => acc + (Number(i.memoryKb) || 0), 0);
        const primaryPid = instances.length > 0 ? instances[0].pid : '—';

        const updatedCpuTrend = [...prevAppHistory.cpuTrend.slice(-9), totalCpu];
        const updatedMemTrend = [...prevAppHistory.memTrend.slice(-9), totalMemKb];

        let hasChangedRecently = false;
        let lastChangedAt = prevAppHistory.lastChangedAt || now;

        if (prevAppHistory.status && (prevAppHistory.status !== status || (primaryPid !== '—' && prevAppHistory.pid !== primaryPid))) {
            hasChangedRecently = true;
            lastChangedAt = now;
        }

        const elapsedSec = Math.round((now - lastChangedAt) / 1000);
        let changeLabel = 'Stabil';
        if (hasChangedRecently && elapsedSec < 120) {
            changeLabel = `Berubah (${elapsedSec}d lalu)`;
        } else if (prevAppHistory.status === null) {
            changeLabel = 'Aktif Normal';
        } else {
            changeLabel = 'Stabil';
        }

        newAppsSnapshot.set(appName, {
            status,
            pid: primaryPid,
            cpuTrend: updatedCpuTrend,
            memTrend: updatedMemTrend,
            lastChangedAt
        });

        // Rekap Status
        if (status === 'BERJALAN') {
            runningAppCount++;
        } else if (status === 'MATI') {
            deadAppCount++;
            if (severity === 'critical') criticalFailedCount++;
            else warningFailedCount++;

            findings.push({
                severity: severity === 'critical' ? 'critical' : 'warning',
                component: appName,
                issue: `Aplikasi ${appName} berstatus MATI!`,
                recommendation: `Periksa service atau jalankan kembali executable ${matchCfg.name}`
            });
        } else if (status === 'PERLU DICEK') {
            needsCheckCount++;
            if (severity === 'critical') criticalFailedCount++;
            else warningFailedCount++;

            findings.push({
                severity: 'warning',
                component: appName,
                issue: `Aplikasi ${appName}: ${statusReason || 'Perlu diperiksa'}`,
                recommendation: `Verifikasi PID ${primaryPid} atau parameter jaringan`
            });
        }

        auditedWatchlist.push({
            name: appName,
            match: matchCfg,
            type: matchCfg.type || 'process',
            severity,
            status,
            statusReason,
            expectedCount,
            runningCount: instances.length,
            instanceCount: instances.length,
            instances,
            pid: primaryPid,
            pids: instances.map(i => i.pid),
            cpu: totalCpu,
            memory: totalMemKb,
            totalCpu,
            totalMemKb,
            totalMemMb: totalMemKb > 0 ? (totalMemKb / 1024).toFixed(1) : '0',
            checks: item.optionalChecks ? {
                tcpPort: item.optionalChecks.tcpPort,
                tcpOk: optionalCheckResult && optionalCheckResult.port ? optionalCheckResult.port.ok : false,
                httpUrl: item.optionalChecks.httpUrl,
                httpOk: optionalCheckResult && optionalCheckResult.http ? optionalCheckResult.http.ok : false,
            } : null,
            optionalChecks: item.optionalChecks,
            optionalCheckResult,
            cpuTrend: updatedCpuTrend,
            memTrend: updatedMemTrend,
            hasChangedRecently,
            recentChangeText: changeLabel,
            lastChangedAgo: Math.round((now - lastChangedAt) / 1000)
        });
    }

    // Urutkan Watchlist: MATI terlebih dahulu, lalu PERLU DICEK, lalu BERJALAN
    const sortPriority = { MATI: 1, 'PERLU DICEK': 2, BERJALAN: 3 };
    auditedWatchlist.sort((a, b) => (sortPriority[a.status] || 99) - (sortPriority[b.status] || 99));

    // 2. DETEKSI PROSES TAK TERDAFTAR (Application processes that are NOT in watchlist & NOT system)
    const unlistedProcesses = [];
    const ignoreSet = new Set(auditConfig.systemProcessIgnoreList.map(s => s.toLowerCase()));

    for (const p of processes) {
        if (matchedPids.has(p.pid)) continue;
        const nameLower = String(p.name || '').toLowerCase();
        const isSystem = ignoreSet.has(nameLower) || p.type === 'operatingSystem' || p.type === 'deviceDriver' || p.typeCode === 2 || p.typeCode === 3;

        if (!isSystem && (p.type === 'application' || p.typeCode === 4 || !p.type)) {
            unlistedProcesses.push(p);
            // Tambahkan temuan jika proses tak terdaftar memakan CPU/Memori tinggi
            if (Number(p.cpu) >= 50) {
                findings.push({
                    severity: 'warning',
                    component: `Proses Tak Terdaftar: ${p.name}`,
                    issue: `Proses ${p.name} (PID ${p.pid}) menggunakan CPU sebesar ${p.cpu}%`,
                    recommendation: 'Periksa apakah proses tersebut valid atau terindikasi anomali sistem'
                });
            }
        }
    }

    // 3. ANOMALI RESOURCE SERVER (CPU, RAM, DISK)
    const cpuVal = parseFloat(systemMetrics.cpu_usage);
    const ramVal = parseFloat(systemMetrics.ram_usage_pct);
    const diskVal = parseFloat(systemMetrics.disk_usage_pct);

    if (!isNaN(cpuVal) && cpuVal >= auditConfig.thresholds.cpu_critical_pct) {
        criticalFailedCount++;
        findings.push({
            severity: 'critical',
            component: 'CPU Load',
            issue: `Beban CPU mencapai ${cpuVal}% (Kritis)`,
            recommendation: 'Periksa daftar proses yang membebani CPU'
        });
    } else if (!isNaN(cpuVal) && cpuVal >= auditConfig.thresholds.cpu_warning_pct) {
        warningFailedCount++;
        findings.push({
            severity: 'warning',
            component: 'CPU Load',
            issue: `Beban CPU mencapai ${cpuVal}% (Tinggi)`,
            recommendation: 'Monitor perkembangan utilisasi CPU server'
        });
    }

    if (!isNaN(ramVal) && ramVal >= auditConfig.thresholds.memory_critical_pct) {
        criticalFailedCount++;
        findings.push({
            severity: 'critical',
            component: 'RAM Usage',
            issue: `Penggunaan RAM mencapai ${ramVal}% (Kritis)`,
            recommendation: 'Segera bebaskan memori atau restart service yang memakan RAM tinggi'
        });
    } else if (!isNaN(ramVal) && ramVal >= auditConfig.thresholds.memory_warning_pct) {
        warningFailedCount++;
        findings.push({
            severity: 'warning',
            component: 'RAM Usage',
            issue: `Penggunaan RAM mencapai ${ramVal}% (Tinggi)`,
            recommendation: 'Periksa potensi memory leak pada aplikasi'
        });
    }

    if (!isNaN(diskVal) && diskVal >= auditConfig.thresholds.disk_critical_pct) {
        criticalFailedCount++;
        findings.push({
            severity: 'critical',
            component: 'Disk Storage',
            issue: `Penggunaan Disk mencapai ${diskVal}% (Hampir Penuh)`,
            recommendation: 'Bersihkan file log atau tambah alokasi storage'
        });
    }

    // Evaluasi Linux UCD Process Error
    for (const pr of ucdProcs) {
        if (pr.errorFlag && Number(pr.errorFlag) > 0) {
            findings.push({
                severity: 'warning',
                component: `UCD Process: ${pr.name}`,
                issue: pr.errorMessage || `Instance count (${pr.count}) di luar batas (${pr.min}-${pr.max})`,
                recommendation: 'Verifikasi konfigurasi snmpd.conf pada server Linux'
            });
        }
    }

    // 4. HITUNG HEALTH SCORE PC
    let healthScore = 'Normal';
    let healthNumber = 100;
    if (criticalFailedCount > 0) {
        healthScore = 'Kritis';
        healthNumber = Math.max(30, 70 - criticalFailedCount * 15);
    } else if (warningFailedCount > 0 || needsCheckCount > 0) {
        healthScore = 'Peringatan';
        healthNumber = Math.max(60, 90 - (warningFailedCount + needsCheckCount) * 8);
    }

    // Simpan snapshot ke memori
    serverAuditSnapshots.set(host, { timestamp: now, apps: newAppsSnapshot });

    return {
        health_score: {
            level: healthScore,
            score: healthNumber
        },
        summary: {
            total_watchlist: watchlist.length,
            running_apps: runningAppCount,
            dead_apps: deadAppCount,
            needs_check: needsCheckCount,
            unlisted_processes: unlistedProcesses.length,
            total_processes: processes.length,
            total_services: services.length,
            cpu_usage: systemMetrics.cpu_usage || '—',
            ram_usage_pct: systemMetrics.ram_usage_pct || '—',
            disk_usage_pct: systemMetrics.disk_usage_pct || '—',
            uptime: systemMetrics.sys_uptime || '—'
        },
        watchlist: auditedWatchlist,
        processes,
        services,
        unlisted_processes: unlistedProcesses,
        findings,
        evaluated_at: new Date().toISOString()
    };
}

module.exports = {
    computeServerAudit,
    checkTcpPort,
    checkHttpUrl,
    matchPattern
};
