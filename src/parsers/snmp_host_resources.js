/**
 * SNMP Host Resources Parser
 * Parser untuk membaca dan menerjemahkan data SNMP (RAM, Storage, CPU)
 */

function parse(rawData) {
    try {
        let payload;
        
        // 1. Validasi Input (Pastikan data valid)
        if (Buffer.isBuffer(rawData)) {
            payload = JSON.parse(rawData.toString('utf8'));
        } else if (typeof rawData === 'string') {
            payload = JSON.parse(rawData);
        } else if (typeof rawData === 'object') {
            payload = rawData;
        } else {
            return { error: 'Invalid data format' };
        }

        // Ambil nilai dari payload
        const ramTotal = parseFloat(payload.ram_total) || 16;
        const ramUsed = parseFloat(payload.ram_used) || 0;
        const diskUsagePercent = parseFloat(payload.disk_usage) || 0;
        const cpuUsagePercent = parseFloat(payload.cpu_usage) || 0;

        // Hitung persentase RAM
        const ramUsagePercent = (ramTotal > 0) ? (ramUsed / ramTotal) * 100 : 0;

        // Tentukan Status Alat Keseluruhan
        let status = 'Normal';
        
        if (ramUsagePercent > 95 || diskUsagePercent > 95 || cpuUsagePercent > 95) {
            status = 'Alarm';
        } else if (ramUsagePercent > 80 || diskUsagePercent > 85 || cpuUsagePercent > 85) {
            status = 'Warning';
        }

        return {
            success: true,
            status: status,
            data: {
                RAM_Total: { value: ramTotal.toFixed(1), unit: 'GB', label: 'Total RAM' },
                RAM_Used: { value: ramUsed.toFixed(1), unit: 'GB', label: 'Used RAM' },
                RAM_Usage: { value: ramUsagePercent.toFixed(1), unit: '%', label: 'RAM Usage' },
                Disk_Usage: { value: diskUsagePercent.toFixed(1), unit: '%', label: 'Disk Usage' },
                CPU_Usage: { value: cpuUsagePercent.toFixed(1), unit: '%', label: 'CPU Usage' }
            }
        };

    } catch (error) {
        console.error('[SNMP Parser] Error parsing data:', error.message);
        return { success: false, error: error.message };
    }
}

module.exports = { parse };
