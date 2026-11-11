'use strict';

/**
 * server_audit_config.js
 * Konfigurasi OID SNMP dan ambang batas (Thresholds) untuk Audit Aplikasi PC & Server.
 * Semua OID diletakkan di file ini agar mudah diverifikasi dan diuji dengan snmpwalk.
 */

module.exports = {
    // ── OID Definisi ─────────────────────────────────────────────────────────
    oids: {
        // System MIB
        sysDescr: [1, 3, 6, 1, 2, 1, 1, 1, 0],
        sysObjectID: [1, 3, 6, 1, 2, 1, 1, 2, 0],
        sysUpTime: [1, 3, 6, 1, 2, 1, 1, 3, 0],
        sysContact: [1, 3, 6, 1, 2, 1, 1, 4, 0],
        sysName: [1, 3, 6, 1, 2, 1, 1, 5, 0],
        sysLocation: [1, 3, 6, 1, 2, 1, 1, 6, 0],

        // HOST-RESOURCES-MIB: System
        hrSystemUptime: [1, 3, 6, 1, 2, 1, 25, 1, 1, 0],

        // HOST-RESOURCES-MIB: Process Table (hrSWRunEntry, 1.3.6.1.2.1.25.4.2.1)
        hrSWRunIndex: [1, 3, 6, 1, 2, 1, 25, 4, 2, 1, 1],       // .1 PID
        hrSWRunName: [1, 3, 6, 1, 2, 1, 25, 4, 2, 1, 2],        // .2 Nama Proses
        hrSWRunPath: [1, 3, 6, 1, 2, 1, 25, 4, 2, 1, 4],        // .4 Path Executable
        hrSWRunParameters: [1, 3, 6, 1, 2, 1, 25, 4, 2, 1, 5],  // .5 Parameter argumen
        hrSWRunType: [1, 3, 6, 1, 2, 1, 25, 4, 2, 1, 6],        // .6 Tipe: 1=unknown, 2=operatingSystem, 3=deviceDriver, 4=application
        hrSWRunStatus: [1, 3, 6, 1, 2, 1, 25, 4, 2, 1, 7],      // .7 Status: 1=running, 2=runnable, 3=notRunnable, 4=invalid

        // HOST-RESOURCES-MIB: Process Performance Table (hrSWRunPerfEntry, 1.3.6.1.2.1.25.5.1.1)
        hrSWRunPerfCPU: [1, 3, 6, 1, 2, 1, 25, 5, 1, 1, 1],     // .1 CPU centisecond
        hrSWRunPerfMem: [1, 3, 6, 1, 2, 1, 25, 5, 1, 1, 2],     // .2 Memory (KBytes)

        // Windows LanMgr-MIB: Service Table (svSvcEntry, 1.3.6.1.4.1.77.1.2.3.1)
        svSvcName: [1, 3, 6, 1, 4, 1, 77, 1, 2, 3, 1, 1],       // .1 Nama Service
        svSvcInstalledState: [1, 3, 6, 1, 4, 1, 77, 1, 2, 3, 1, 2], // .2 1=uninstalled, 2=install-pending, 3=uninstall-pending, 4=installed
        svSvcOperatingState: [1, 3, 6, 1, 4, 1, 77, 1, 2, 3, 1, 3], // .3 1=active, 2=continue-pending, 3=pause-pending, 4=paused
        svSvcCanBeUninstalled: [1, 3, 6, 1, 4, 1, 77, 1, 2, 3, 1, 4],

        // Linux UCD-SNMP-MIB: Process Monitoring Table (prEntry, 1.3.6.1.4.1.2021.2.1)
        prNames: [1, 3, 6, 1, 4, 1, 2021, 2, 1, 2],
        prMin: [1, 3, 6, 1, 4, 1, 2021, 2, 1, 3],
        prMax: [1, 3, 6, 1, 4, 1, 2021, 2, 1, 4],
        prCount: [1, 3, 6, 1, 4, 1, 2021, 2, 1, 5],
        prErrorFlag: [1, 3, 6, 1, 4, 1, 2021, 2, 1, 100],
        prErrMessage: [1, 3, 6, 1, 4, 1, 2021, 2, 1, 101],

        // HOST-RESOURCES-MIB: Installed Software (hrSWInstalledEntry, 1.3.6.1.2.1.25.6.3.1)
        hrSWInstalledName: [1, 3, 6, 1, 2, 1, 25, 6, 3, 1, 2],
        hrSWInstalledDate: [1, 3, 6, 1, 2, 1, 25, 6, 3, 1, 5]
    },

    // ── Ambang Batas Evaluasi Kesehatan PC / Server ──────────────────────────
    // Dapat disesuaikan dengan kapasitas server operasional bandara
    thresholds: {
        cpu_warning_pct: 80.0,
        cpu_critical_pct: 95.0,
        cpu_spike_streak_count: 3, // Peringatan jika CPU 100% selama N polling berturut-turut

        memory_warning_pct: 85.0,
        memory_critical_pct: 95.0,
        memory_leak_growth_streak: 4, // Peringatan jika memori naik berturut-turut N polling

        disk_warning_pct: 85.0,
        disk_critical_pct: 95.0,

        tcp_check_timeout_ms: 1500,  // Timeout TCP handshake untuk port check
        http_check_timeout_ms: 2500, // Timeout HTTP GET health check

        max_process_walk_count: 500  // Batas maksimum proses yang diambil per polling
    },

    // ── Daftar Proses Sistem Umum (Diabaikan dari daftar "Tak Terdaftar") ──────
    // Mencegah noise audit proses bawaan OS Windows / Linux
    systemProcessIgnoreList: [
        'system', 'system idle process', 'registry', 'smss.exe', 'csrss.exe',
        'wininit.exe', 'services.exe', 'lsass.exe', 'svchost.exe', 'fontdrvhost.exe',
        'winlogon.exe', 'dwm.exe', 'sihost.exe', 'taskhostw.exe', 'explorer.exe',
        'shellexperiencehost.exe', 'startmenuexperiencehost.exe', 'searchapp.exe',
        'searchindexer.exe', 'spoolsv.exe', 'conhost.exe', 'dllhost.exe', 'wmiapsrv.exe',
        'wmiprvse.exe', 'snmp.exe', 'snmpd', 'systemd', 'kthreadd', 'ksoftirqd',
        'rcu_sched', 'migration', 'cpuhp', 'kdevtmpfs', 'netns', 'kauditd',
        'systemd-journald', 'systemd-udevd', 'systemd-logind', 'systemd-resolved',
        'dbus-daemon', 'cron', 'crond', 'sshd', 'rsyslogd', 'bash', 'sh', 'zsh', 'init'
    ]
};
