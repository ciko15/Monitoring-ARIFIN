'use strict';

/**
 * switch_audit_engine.js
 * Modul murni (pure functions) untuk kalkulasi metrik audit switch, laju bandwidth (bps),
 * deteksi flapping, delta error, serta evaluasi Health Score (Normal / Peringatan / Kritis).
 */

const auditConfig = require('../config/switch_audit_config');

/**
 * Menyimpan snapshot data polling sebelumnya di memori (Map per host)
 * Key: host (IP atau ID device)
 * Value: { timestamp: number, sysUpTimeTicks: number, interfaces: Map(index => { inOctets, outOctets, inErrors, outErrors, inDiscards, outDiscards }) }
 */
const devicePollingSnapshots = new Map();

/**
 * Menghitung laju bit per detik (bps) dengan penanganan counter wrap (32-bit / 64-bit)
 */
function calculateBps(currentOctets, prevOctets, intervalSec) {
    if (intervalSec <= 0) return 0;
    let diff = currentOctets - prevOctets;

    // Counter wrap handling
    if (diff < 0) {
        if (prevOctets <= 4294967295) {
            // 32-bit wrap
            diff += 4294967296;
        } else {
            // 64-bit wrap atau counter reset
            diff = currentOctets;
        }
    }

    if (diff < 0 || diff > 1e12) return 0; // Filter spike tak wajar
    return Math.round((diff * 8) / intervalSec);
}

/**
 * Memformat satuan bps agar mudah dibaca (bps, Kbps, Mbps, Gbps)
 */
function formatBps(bps) {
    if (bps === null || bps === undefined) return 'menghitung...';
    if (bps < 1000) return `${bps} bps`;
    if (bps < 1000000) return `${(bps / 1000).toFixed(1)} Kbps`;
    if (bps < 1000000000) return `${(bps / 1000000).toFixed(2)} Mbps`;
    return `${(bps / 1000000000).toFixed(2)} Gbps`;
}

/**
 * Evaluasi Audit Kesehatan & Metrik Interface Realtime
 * @param {string} host - IP address switch
 * @param {object} currentData - Data SNMP saat ini (sysUpTimeTicks, interfaces, cpu, ram, temp, hardwareHealth)
 * @returns {object} Hasil audit terstruktur
 */
function computeSwitchAudit(host, currentData) {
    const now = Date.now();
    const prevSnapshot = devicePollingSnapshots.get(host);
    const intervalSec = prevSnapshot ? Math.max(1, (now - prevSnapshot.timestamp) / 1000) : null;
    const isFirstPoll = !prevSnapshot;

    const currentUpTimeTicks = Number(currentData.sysUpTimeTicks || 0);
    const flappingWindowTicks = auditConfig.thresholds.flapping_window_minutes * 60 * 100; // in hundredths of sec

    const auditedInterfaces = [];
    const findings = []; // Daftar temuan anomali

    let countUp = 0;
    let countDown = 0;
    let countFlapping = 0;
    let countErrorElevated = 0;
    let totalInBps = 0;
    let totalOutBps = 0;

    const nextInterfaceMap = new Map();

    const rawInterfaces = Array.isArray(currentData.interfaces) ? currentData.interfaces : [];

    for (const iface of rawInterfaces) {
        const idx = String(iface.index);
        const prevIface = prevSnapshot?.interfaces?.get(idx);

        const adminStatus = Number(iface.adminStatus) || 1; // 1=up, 2=down, 3=testing
        const operStatus = Number(iface.operStatus) || 2;   // 1=up, 2=down
        const lastChangeTicks = Number(iface.lastChange) || 0;

        const inOct = Number(iface.inOctets) || 0;
        const outOct = Number(iface.outOctets) || 0;
        const inErr = Number(iface.inErrors) || 0;
        const outErr = Number(iface.outErrors) || 0;
        const inDisc = Number(iface.inDiscards) || 0;
        const outDisc = Number(iface.outDiscards) || 0;

        // Simpan state sekarang untuk snapshot selanjutnya
        nextInterfaceMap.set(idx, {
            inOctets: inOct,
            outOctets: outOct,
            inErrors: inErr,
            outErrors: outErr,
            inDiscards: inDisc,
            outDiscards: outDisc,
            operStatus
        });

        // 1. Kalkulasi BPS
        let inBps = null;
        let outBps = null;
        if (!isFirstPoll && prevIface && intervalSec) {
            inBps = calculateBps(inOct, prevIface.inOctets, intervalSec);
            outBps = calculateBps(outOct, prevIface.outOctets, intervalSec);
            totalInBps += inBps;
            totalOutBps += outBps;
        }

        // 2. Kalkulasi Delta Error & Discard
        const deltaInErr = (!isFirstPoll && prevIface) ? Math.max(0, inErr - prevIface.inErrors) : 0;
        const deltaOutErr = (!isFirstPoll && prevIface) ? Math.max(0, outErr - prevIface.outErrors) : 0;
        const deltaInDisc = (!isFirstPoll && prevIface) ? Math.max(0, inDisc - prevIface.inDiscards) : 0;
        const deltaOutDisc = (!isFirstPoll && prevIface) ? Math.max(0, outDisc - prevIface.outDiscards) : 0;
        const totalDeltaErr = deltaInErr + deltaOutErr;

        // 3. Deteksi Flapping & Status Port
        let isFlapping = false;
        if (currentUpTimeTicks > 0 && lastChangeTicks > 0) {
            const timeSinceChange = currentUpTimeTicks - lastChangeTicks;
            if (timeSinceChange >= 0 && timeSinceChange < flappingWindowTicks) {
                // Berubah dalam N menit terakhir
                isFlapping = true;
            }
        }

        // 4. Klasifikasi Visual Port & Temuan
        let portState = 'up'; // 'up', 'admin_down', 'down_fault', 'problem'
        const ifName = iface.name || `Port ${idx}`;

        if (adminStatus !== 1) {
            // Sengaja dimatikan oleh admin (shutdown)
            portState = 'admin_down';
            countDown++;
        } else if (operStatus === 1) {
            // Link Aktif
            if (totalDeltaErr >= auditConfig.thresholds.interface_errors.warning_delta || isFlapping) {
                portState = 'problem';
                if (totalDeltaErr >= auditConfig.thresholds.interface_errors.warning_delta) countErrorElevated++;
                if (isFlapping) countFlapping++;
            } else {
                portState = 'up';
            }
            countUp++;
        } else {
            // Admin UP tapi Oper DOWN (Kabel lepas / SFP down / fault)
            portState = 'down_fault';
            countDown++;
            findings.push({
                severity: 'warning',
                component: ifName,
                issue: 'Admin UP tetapi Operasional DOWN (Kabel tidak terhubung / link terputus)',
                detail: `Port ${ifName} diatur aktif oleh admin, namun tidak ada carrier sinyal aktif.`
            });
        }

        if (totalDeltaErr >= auditConfig.thresholds.interface_errors.critical_delta) {
            findings.push({
                severity: 'critical',
                component: ifName,
                issue: `Lonjakan frame error parah (+${totalDeltaErr} error/interval)`,
                detail: `Kemungkinan kerusakan kabel, interferensi RF, atau SFP kotor pada ${ifName}.`
            });
        } else if (totalDeltaErr >= auditConfig.thresholds.interface_errors.warning_delta) {
            findings.push({
                severity: 'warning',
                component: ifName,
                issue: `Kenaikan paket error terdeteksi (+${totalDeltaErr} error/interval)`,
                detail: `Periksa duplex mismatch atau kualitas kabel pada ${ifName}.`
            });
        }

        if (isFlapping && operStatus === 1) {
            findings.push({
                severity: 'warning',
                component: ifName,
                issue: 'Port Flapping baru saja terjadi',
                detail: `Link pada ${ifName} mengalami perubahan status dalam < ${auditConfig.thresholds.flapping_window_minutes} menit terakhir.`
            });
        }

        auditedInterfaces.push({
            index: idx,
            name: ifName,
            adminStatus,
            operStatus,
            portState,
            speedMbps: iface.speedMbps || 0,
            inOctets: inOct,
            outOctets: outOct,
            inBps,
            outBps,
            inBpsFormatted: formatBps(inBps),
            outBpsFormatted: formatBps(outBps),
            inErrors: inErr,
            outErrors: outErr,
            inDiscards: inDisc,
            outDiscards: outDisc,
            deltaErrors: totalDeltaErr,
            isFlapping,
            lastChangeTicks
        });
    }

    // Perbarui snapshot polling di memori
    devicePollingSnapshots.set(host, {
        timestamp: now,
        sysUpTimeTicks: currentUpTimeTicks,
        interfaces: nextInterfaceMap
    });

    // ── Evaluasi CPU, RAM, Suhu, Hardware Health ─────────────────────────────
    const cpuUsage = Number.isFinite(Number(currentData.cpuUsage)) ? Number(currentData.cpuUsage) : null;
    const ramUsage = Number.isFinite(Number(currentData.ramUsagePct)) ? Number(currentData.ramUsagePct) : null;
    const tempC = Number.isFinite(Number(currentData.temperatureC)) ? Number(currentData.temperatureC) : null;

    let hasCritical = false;
    let hasWarning = false;

    // Evaluasi Ping / Konektivitas
    if (currentData.connectivity === 'Disconnected') {
        hasCritical = true;
        findings.unshift({
            severity: 'critical',
            component: 'System',
            issue: 'Perangkat tidak merespons (Offline / Disconnected)',
            detail: 'Tidak ada respons SNMP dari switch.'
        });
    }

    // Evaluasi Suhu
    if (tempC !== null) {
        if (tempC >= auditConfig.thresholds.temperature.critical) {
            hasCritical = true;
            findings.push({
                severity: 'critical',
                component: 'Chassis Temp',
                issue: `Suhu Kritis (${tempC.toFixed(1)} °C)`,
                detail: `Suhu melebihi ambang batas kritis ${auditConfig.thresholds.temperature.critical} °C!`
            });
        } else if (tempC >= auditConfig.thresholds.temperature.warning) {
            hasWarning = true;
            findings.push({
                severity: 'warning',
                component: 'Chassis Temp',
                issue: `Suhu Peringatan (${tempC.toFixed(1)} °C)`,
                detail: `Suhu mendekati batas normal operasional (${auditConfig.thresholds.temperature.warning} °C).`
            });
        }
    }

    // Evaluasi CPU
    if (cpuUsage !== null) {
        if (cpuUsage >= auditConfig.thresholds.cpu.critical) {
            hasCritical = true;
            findings.push({
                severity: 'critical',
                component: 'Processor',
                issue: `Beban CPU Kritis (${cpuUsage}%)`,
                detail: 'Utilisasi prosesor sangat tinggi, waspada packet drop pada control plane.'
            });
        } else if (cpuUsage >= auditConfig.thresholds.cpu.warning) {
            hasWarning = true;
            findings.push({
                severity: 'warning',
                component: 'Processor',
                issue: `Beban CPU Tinggi (${cpuUsage}%)`,
                detail: 'Beban CPU melebihi ambang batas peringatan.'
            });
        }
    }

    // Evaluasi RAM
    if (ramUsage !== null) {
        if (ramUsage >= auditConfig.thresholds.memory.critical) {
            hasCritical = true;
            findings.push({
                severity: 'critical',
                component: 'RAM Memory',
                issue: `Penggunaan Memori Kritis (${ramUsage.toFixed(1)}%)`,
                detail: 'Kapasitas RAM hampir habis.'
            });
        } else if (ramUsage >= auditConfig.thresholds.memory.warning) {
            hasWarning = true;
            findings.push({
                severity: 'warning',
                component: 'RAM Memory',
                issue: `Penggunaan Memori Tinggi (${ramUsage.toFixed(1)}%)`,
                detail: 'Kapasitas RAM melebihi ambang batas peringatan.'
            });
        }
    }

    // Evaluasi PSU & Fan
    if (currentData.hardwareHealth) {
        const { psuFault, fanFault, stackFault, psuList, fanList } = currentData.hardwareHealth;
        if (psuFault) {
            hasCritical = true;
            findings.push({
                severity: 'critical',
                component: 'Power Supply',
                issue: 'Kerusakan / Kehilangan Catu Daya (PSU Fault)',
                detail: 'Salah satu modul Power Supply tidak beroperasi normal.'
            });
        }
        if (fanFault) {
            hasCritical = true;
            findings.push({
                severity: 'critical',
                component: 'Kipas (Fan)',
                issue: 'Kerusakan Kipas Pendingin (Fan Fault)',
                detail: 'Satu atau lebih modul kipas chassis switch mengalami kegagalan putaran.'
            });
        }
        if (stackFault) {
            hasWarning = true;
            findings.push({
                severity: 'warning',
                component: 'Stacking',
                issue: 'Anomali Stack Role / Topology',
                detail: 'Terdapat anomali pada status stack switch.'
            });
        }
    }

    if (countErrorElevated > 0 || countFlapping > 0) {
        hasWarning = true;
    }

    // Tentukan Health Score Akhir
    let healthScore = 'Normal';
    if (hasCritical) {
        healthScore = 'Kritis';
    } else if (hasWarning) {
        healthScore = 'Peringatan';
    }

    // Urutkan temuan: Critical terlebih dahulu, baru Warning
    findings.sort((a, b) => {
        if (a.severity === 'critical' && b.severity !== 'critical') return -1;
        if (a.severity !== 'critical' && b.severity === 'critical') return 1;
        return 0;
    });

    return {
        health_score: healthScore,
        total_interfaces: auditedInterfaces.length,
        active_interfaces: countUp,
        down_interfaces: countDown,
        flapping_interfaces: countFlapping,
        error_interfaces: countErrorElevated,
        total_in_bps: totalInBps,
        total_out_bps: totalOutBps,
        total_in_bps_formatted: formatBps(totalInBps),
        total_out_bps_formatted: formatBps(totalOutBps),
        cpu_usage: cpuUsage !== null ? `${cpuUsage}%` : '—',
        ram_usage: ramUsage !== null ? `${ramUsage.toFixed(1)}%` : '—',
        temperature_c: tempC !== null ? `${tempC.toFixed(1)} °C` : '—',
        interfaces: auditedInterfaces,
        findings,
        hardware_health: currentData.hardwareHealth || null,
        evaluated_at: new Date().toISOString()
    };
}

module.exports = {
    computeSwitchAudit,
    formatBps,
    calculateBps,
    devicePollingSnapshots
};
