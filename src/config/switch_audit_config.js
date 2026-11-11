'use strict';

/**
 * switch_audit_config.js
 * Konfigurasi threshold dan OID untuk fitur Audit Switch Realtime
 * 
 * Nilai ambang batas (thresholds) di bawah ini dapat disesuaikan 
 * dengan spesifikasi teknis vendor switch (misal: Alcatel-Lucent OmniSwitch, Cisco, dll).
 */

module.exports = {
    // ── Ambang Batas Evaluasi Kesehatan (Health Score Rules) ─────────────────
    thresholds: {
        // Suhu perangkat (°C)
        // Disesuaikan dengan batas datasheet Alcatel OS6450 / OS6860 / Catalyst
        temperature: {
            warning: 50.0,  // Suhu >= 50°C memicu status Peringatan
            critical: 65.0, // Suhu >= 65°C memicu status Kritis
        },

        // Utilisasi CPU (%)
        cpu: {
            warning: 80.0,  // CPU load > 80%
            critical: 95.0, // CPU load > 95%
        },

        // Utilisasi Memori RAM (%)
        memory: {
            warning: 85.0,  // RAM used > 85%
            critical: 95.0, // RAM used > 95%
        },

        // Port Flapping: Ambang waktu (menit) sejak ifLastChange terakhir
        // Jika status port down atau berubah dalam rentang waktu ini, ditandai flapping
        flapping_window_minutes: 15,

        // Kenaikan Discard / Error per interval
        interface_errors: {
            warning_delta: 5,   // Kenaikan error > 5 paket per interval
            critical_delta: 50, // Kenaikan error > 50 paket per interval
        }
    },

    // ── Daftar OID Tambahan (Vendor Specific & Hardware Health) ─────────────
    // OID ini mudah ditambah/diverifikasi via snmpwalk
    oids: {
        // HOST-RESOURCES-MIB (CPU & Storage)
        hrProcessorLoad: [1, 3, 6, 1, 2, 1, 25, 3, 3, 1, 2],
        hrStorageDescr:   [1, 3, 6, 1, 2, 1, 25, 2, 3, 1, 3],
        hrStorageType:    [1, 3, 6, 1, 2, 1, 25, 2, 3, 1, 2],
        hrStorageAllocUnits: [1, 3, 6, 1, 2, 1, 25, 2, 3, 1, 4],
        hrStorageSize:    [1, 3, 6, 1, 2, 1, 25, 2, 3, 1, 5],
        hrStorageUsed:    [1, 3, 6, 1, 2, 1, 25, 2, 3, 1, 6],

        // IF-MIB (Tambahan Operasional & Error)
        ifAdminStatus: [1, 3, 6, 1, 2, 1, 2, 2, 1, 7],
        ifOperStatus:  [1, 3, 6, 1, 2, 1, 2, 2, 1, 8],
        ifLastChange:  [1, 3, 6, 1, 2, 1, 2, 2, 1, 9],
        ifInDiscards:  [1, 3, 6, 1, 2, 1, 2, 2, 1, 13],
        ifInErrors:    [1, 3, 6, 1, 2, 1, 2, 2, 1, 14],
        ifOutDiscards: [1, 3, 6, 1, 2, 1, 2, 2, 1, 19],
        ifOutErrors:   [1, 3, 6, 1, 2, 1, 2, 2, 1, 20],
        ifHighSpeed:   [1, 3, 6, 1, 2, 1, 31, 1, 1, 1, 15],

        // Alcatel-Lucent Enterprise (1.3.6.1.4.1.6486) Hardware Health MIB
        // Chassis Power Supply Status (chasEntPhysOperStatus / chasPSOperStatus)
        // Nilai umum: 1=up/oper, 2=down/fault, 3=testing, 4=unknown
        alcatelPowerSupplyStatus: [1, 3, 6, 1, 4, 1, 6486, 800, 1, 1, 1, 2, 1, 1, 2],
        // Chassis Fan Status
        alcatelFanStatus:         [1, 3, 6, 1, 4, 1, 6486, 800, 1, 1, 1, 4, 1, 1, 2],
        // Stacking element status (chasChassisRole / chasStackStatus)
        alcatelStackStatus:       [1, 3, 6, 1, 4, 1, 6486, 800, 1, 1, 1, 1, 1, 1, 1],

        // Standar ENTITY-SENSOR-MIB (RFC 3433)
        entPhysicalName:   [1, 3, 6, 1, 2, 1, 47, 1, 1, 1, 1, 7],
        entPhySensorType:  [1, 3, 6, 1, 2, 1, 99, 1, 1, 1, 1],
        entPhySensorScale: [1, 3, 6, 1, 2, 1, 99, 1, 1, 1, 2],
        entPhySensorValue: [1, 3, 6, 1, 2, 1, 99, 1, 1, 1, 4],
        entPhySensorOper:  [1, 3, 6, 1, 2, 1, 99, 1, 1, 1, 5]
    }
};
