'use strict';

const ModbusRTU = require("modbus-serial");

/**
 * Moxa ioLogik 4000 Modbus/TCP Parser
 * 
 * Melakukan polling secara aktif untuk membaca 32 Digital Inputs.
 * Sesuai request:
 * - 1 = Normal
 * - 0 = Alarm
 */

async function pollIoLogik(host, port = 502, slaveId = 1, devicesConfig = null, timeoutMs = 4000) {
    const client = new ModbusRTU();

    try {
        client.setTimeout(timeoutMs);
        await client.connectTCP(host, { port: port });
        client.setID(slaveId);

        // Membaca input secara dinamis (mencoba hingga 48 bit) agar tidak timeout jika alat hanya punya 32 DI
        let diData = [];
        for (let i = 8; i <= 48; i += 8) {
            try {
                const res = await client.readDiscreteInputs(0, i);
                diData = res.data;
            } catch (e) {
                break; // Stop jika mentok
            }
        }
        client.close();

        if (diData.length === 0) {
            throw new Error('Failed to read any Discrete Inputs from device (Timeout or Refused)');
        }

        const data = { devices: {} };
        const alarms = [];
        const warnings = [];
        const triggeredParams = [];

        const bitArray = diData.map(v => v ? 1 : 0);

        if (devicesConfig && Object.keys(devicesConfig).length > 0) {
            // Dynamic Parsing
            for (const [deviceName, mapping] of Object.entries(devicesConfig)) {
                const out = {};

                const checkBit = (pinIndex) => {
                    if (pinIndex === undefined || pinIndex === null) return null;
                    return bitArray[pinIndex] === 1; // 1 = Aktif/Nyala
                };

                // Dynamic Logic
                for (const [key, pinConfig] of Object.entries(mapping)) {
                    if (pinConfig === null || pinConfig === undefined) continue;
                    
                    let pinIndex;
                    let logic = 'NO';
                    let type = 'normal';
                    
                    if (typeof pinConfig === 'object') {
                        pinIndex = pinConfig.pin;
                        logic = pinConfig.logic || 'NO';
                        type = pinConfig.type || 'normal';
                    } else {
                        pinIndex = pinConfig;
                    }

                    if (pinIndex !== null && pinIndex !== undefined) {
                        const bitVal = bitArray[pinIndex];
                        let isActive = false;
                        if (logic === 'NC') {
                            isActive = (bitVal === 0);
                        } else {
                            isActive = (bitVal === 1);
                        }
                        
                        out[key] = isActive ? 'Aktif' : 'Tidak Aktif';
                        
                        if (type === 'alarm' && isActive) {
                            alarms.push(key);
                        } else if (type === 'warning' && isActive) {
                            warnings.push(key);
                        }
                    }
                }

                data.devices[deviceName] = out;
            }
        } else {
            // Fallback (Hardcoded DME, DVOR 1, DVOR 2) jika config tidak dideklarasi
            function parse14Bits(bits) {
                const out = {};
                if (bits[0] === 1) out['TX'] = 'TX 1';
                else if (bits[1] === 1) out['TX'] = 'TX 2';
                else out['TX'] = '-';

                if (bits[3] === 1) out['STATUS'] = 'Normal';
                else if (bits[2] === 1) out['STATUS'] = 'Transfer';
                else if (bits[4] === 1) out['STATUS'] = 'Shutdown';
                else if (bits[5] === 1) out['STATUS'] = 'Maintenance';
                else out['STATUS'] = '-';

                if (bits[6] === 1) out['DESCRIPTION'] = 'Local Control';
                else if (bits[7] === 1) out['DESCRIPTION'] = 'Primary Alarm';
                else if (bits[8] === 1) out['DESCRIPTION'] = 'Secondary Alarm';
                else if (bits[9] === 1) out['DESCRIPTION'] = 'Monitor Alarm';
                else out['DESCRIPTION'] = '-';

                out['Battery Charge 1'] = bits[10] === 1 ? 'Normal' : 'Alarm';
                out['Battery Charge 2'] = bits[11] === 1 ? 'Normal' : 'Alarm';
                out['Mains OK'] = bits[12] === 1 ? 'Normal' : 'Alarm';
                out['Normal AC Power'] = bits[13] === 1 ? 'Normal' : 'Alarm';
                return out;
            }

            const dmeBits = [];
            for (let i = 0; i < 14; i++) dmeBits.push(bitArray[i]);
            data.devices['DME'] = parse14Bits(dmeBits);

            const dvor1Bits = [];
            for (let i = 0; i < 14; i++) dvor1Bits.push(bitArray[i + 16]);
            data.devices['DVOR 1'] = parse14Bits(dvor1Bits);

            const dvor2Bits = [];
            for (let i = 0; i < 14; i++) dvor2Bits.push(bitArray[i + 32]);
            data.devices['DVOR 2'] = parse14Bits(dvor2Bits);

            // Cek Alarms fallback
            for (const [deviceName, out] of Object.entries(data.devices)) {
                if (out['STATUS'] !== 'Normal' && out['STATUS'] !== '-') alarms.push(`${deviceName} Status: ${out['STATUS']}`);
                if (out['DESCRIPTION'] !== '-') alarms.push(`${deviceName} Info: ${out['DESCRIPTION']}`);
                if (out['Battery Charge 1'] === 'Alarm') alarms.push(`${deviceName} Battery Charge 1 Alarm`);
                if (out['Battery Charge 2'] === 'Alarm') alarms.push(`${deviceName} Battery Charge 2 Alarm`);
                if (out['Mains OK'] === 'Alarm') alarms.push(`${deviceName} Mains OK Alarm`);
                if (out['Normal AC Power'] === 'Alarm') alarms.push(`${deviceName} Normal AC Power Alarm`);
            }
        }

        return {
            success: true,
            data: data,
            status: alarms.length > 0 ? 'Alarm' : (warnings.length > 0 ? 'Warning' : 'Normal'),
            alarms: alarms,
            warnings: warnings,
            triggeredParams: triggeredParams,
            timestamp: new Date().toISOString()
        };

    } catch (err) {
        // Sediakan struktur data dengan '-' agar UI tetap utuh meski disconnect
        const fallbackData = { devices: {} };
        if (devicesConfig && Object.keys(devicesConfig).length > 0) {
            for (const [deviceName, mapping] of Object.entries(devicesConfig)) {
                const out = {};
                for (const [key, pin] of Object.entries(mapping)) {
                    if (pin !== null && pin !== undefined) out[key] = '-';
                }
                fallbackData.devices[deviceName] = out;
            }
        } else {
            fallbackData.devices['DME'] = { 'TX': '-', 'STATUS': '-', 'DESCRIPTION': '-', 'Battery Charge 1': '-', 'Battery Charge 2': '-', 'Mains OK': '-', 'Normal AC Power': '-' };
            fallbackData.devices['DVOR 1'] = { 'TX': '-', 'STATUS': '-', 'DESCRIPTION': '-' };
            fallbackData.devices['DVOR 2'] = { 'TX': '-', 'STATUS': '-', 'DESCRIPTION': '-' };
        }

        return {
            success: false,
            data: fallbackData,
            error: err.message,
            status: 'Disconnect',
            timestamp: new Date().toISOString()
        };
    }
}

module.exports = {
    pollIoLogik
};
