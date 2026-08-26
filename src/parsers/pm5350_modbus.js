'use strict';

const ModbusRTU = require("modbus-serial");

/**
 * PM5350 Modbus Parser
 * Schneider Electric PowerLogic PM5350
 * 
 * Melakukan polling data secara aktif menggunakan protokol RTU-over-TCP.
 */

async function pollPM5350(host, port = 26, slaveId = 5, timeoutMs = 4000) {
    const client = new ModbusRTU();

    try {
        client.setTimeout(timeoutMs);
        await client.connectTelnet(host, { port: port });
        client.setID(slaveId);

        // Fungsi khusus membaca Float32 dari 2 Register
        async function readFloat32(addr) {
            const res = await client.readHoldingRegisters(addr - 1, 2);
            const buffer = Buffer.alloc(4);
            buffer.writeUInt16BE(res.buffer.readUInt16BE(0), 0);
            buffer.writeUInt16BE(res.buffer.readUInt16BE(2), 2);
            return buffer.readFloatBE(0);
        }

        // Membaca semua parameter secara sekuensial
        const I_R = await readFloat32(3000);
        const I_S = await readFloat32(3002);
        const I_T = await readFloat32(3004);

        const V_RN = await readFloat32(3028);
        const V_SN = await readFloat32(3030);
        const V_TN = await readFloat32(3032);

        const V_RS = await readFloat32(3020);
        const V_ST = await readFloat32(3022);
        const V_TR = await readFloat32(3024);

        const FREQ = await readFloat32(3110);
        const KW = await readFloat32(3060);
        const KVAR = await readFloat32(3068); // 3068 adalah Total Reactive Power
        const KVA = await readFloat32(3076);  // 3076 adalah Total Apparent Power
        let PF = await readFloat32(3192);

        // Hitung manual PF dari KW / KVAR (Rumus 3-Phase Pythagoras: S = √(P² + Q²))
        if (KW != null && KVAR != null) {
            const P = KW;
            const Q = KVAR;
            const absP = Math.abs(P);
            const calcApparentPower = Math.sqrt(Math.pow(P, 2) + Math.pow(Q, 2));
            if (calcApparentPower > 0.001) {
                PF = absP / calcApparentPower;
            }
        } else if (KVA && Math.abs(KVA) > 0.001 && KW != null) {
            PF = Math.abs(KW) / KVA;
        }

        if (PF > 1) PF = 1;
        if (PF < 0) PF = 0;

        client.close();

        const alarms = [];
        const warnings = [];
        const triggeredParams = [];

        // Evaluasi sederhana
        if (V_RN < 200 || V_RN > 240) {
            alarms.push(`Tegangan R-N Tidak Normal (${V_RN.toFixed(1)}V)`);
            triggeredParams.push('V_RN');
        }
        if (FREQ < 49 || FREQ > 51) {
            warnings.push(`Frekuensi Tidak Stabil (${FREQ.toFixed(2)}Hz)`);
            triggeredParams.push('FREQ');
        }

        let status = alarms.length > 0 ? 'Alarm' : (warnings.length > 0 ? 'Warning' : 'Normal');

        return {
            success: true,
            status,
            data: {
                connectivity: 'Connected',
                I_R: I_R.toFixed(2),
                I_S: I_S.toFixed(2),
                I_T: I_T.toFixed(2),
                V_RN: V_RN.toFixed(2),
                V_SN: V_SN.toFixed(2),
                V_TN: V_TN.toFixed(2),
                V_RS: V_RS.toFixed(2),
                V_ST: V_ST.toFixed(2),
                V_TR: V_TR.toFixed(2),
                FREQ: FREQ.toFixed(2),
                KW: KW.toFixed(3),
                KVAR: KVAR.toFixed(3),
                KVA: KVA.toFixed(3),
                PF: PF.toFixed(3)
            },
            alarms,
            warnings,
            triggeredParams,
            timestamp: new Date().toISOString(),
        };

    } catch (err) {
        try { client.close(); } catch (e) { }
        return {
            success: false,
            status: 'Disconnect',
            error: err.message,
            data: {
                connectivity: 'Disconnected',
                I_R: '—', I_S: '—', I_T: '—',
                V_RN: '—', V_SN: '—', V_TN: '—',
                V_RS: '—', V_ST: '—', V_TR: '—',
                FREQ: '—', KW: '—', KVA: '—', PF: '—'
            },
            alarms: [],
            warnings: [],
            triggeredParams: [],
            timestamp: new Date().toISOString(),
        };
    }
}

module.exports = { pollPM5350 };
