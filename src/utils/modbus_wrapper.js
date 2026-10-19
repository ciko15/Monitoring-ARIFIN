const ModbusRTU = require("modbus-serial");

// Mutex lock global per IP:Port agar 2 request tidak tabrakan
const modbusLocks = new Map();
const lastReleaseTimes = new Map();

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function acquireLock(lockKey, timeoutMs = 25000) {
    const start = Date.now();
    while (modbusLocks.get(lockKey)) {
        if (Date.now() - start > timeoutMs) {
            throw new Error(`Timeout waiting for Modbus lock on ${lockKey}`);
        }
        await sleep(100);
    }
    // Berikan sedikit jeda cooldown (150ms) setelah request sebelumnya selesai 
    // agar socket hardware ioLogik benar-benar tertutup bersih sebelum request baru dibuka
    const lastRelease = lastReleaseTimes.get(lockKey) || 0;
    const elapsedSinceRelease = Date.now() - lastRelease;
    if (elapsedSinceRelease < 150) {
        await sleep(150 - elapsedSinceRelease);
    }

    modbusLocks.set(lockKey, true);
}

function releaseLock(lockKey) {
    modbusLocks.delete(lockKey);
    lastReleaseTimes.set(lockKey, Date.now());
}

/**
 * Wrapper eksekusi fungsi Modbus dengan timeout bawaan
 */
async function withTimeout(promise, timeoutMs, operationName = 'Modbus operation') {
    let timer;
    const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(() => {
            reject(new Error(`${operationName} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
    });

    try {
        return await Promise.race([promise, timeoutPromise]);
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Fungsi utilitas utama untuk membungkus pemanggilan Modbus TCP/Telnet
 * @param {Object} options Konfigurasi koneksi (host, port, type: 'tcp'|'telnet', timeout, dll)
 * @param {Function} executor Fungsi callback yang menerima instance (client) modbus
 */
async function executeModbus(options, executor) {
    const host = options.host;
    const port = options.port || 502;
    const type = options.type || 'tcp'; // tcp atau telnet
    const slaveId = options.slaveId || 1;
    const timeoutMs = options.timeout || 3000;
    const lockKey = `${host}:${port}`;
    const queueTimeout = Math.max(timeoutMs * 5, 25000);

    await acquireLock(lockKey, queueTimeout);

    const client = new ModbusRTU();
    
    // Cegah unhandled error jika library mengeluarkan error dari background socket
    const noopErr = (err) => {};
    client.on('error', noopErr);

    try {
        client.setTimeout(timeoutMs);

        // Connect dengan timeout
        const connectPromise = type === 'telnet' 
            ? client.connectTelnet(host, { port })
            : client.connectTCP(host, { port });
            
        await withTimeout(connectPromise, timeoutMs, `Connect ${type.toUpperCase()} ${lockKey}`);

        client.setID(slaveId);

        // Eksekusi pemanggilan baca/tulis
        const result = await executor(client);
        return result;
    } catch (error) {
        // Lempar kembali error (misal ECONNREFUSED/Timeout) agar ditangkap caller
        throw error;
    } finally {
        try {
            // Hancurkan underlying socket agar tidak ada event timeout/error liar yang terpanggil belakangan
            if (client._port) {
                if (typeof client._port.removeAllListeners === 'function') {
                    client._port.removeAllListeners('error');
                    client._port.on('error', noopErr);
                }
                if (client._port._client) {
                    if (typeof client._port._client.removeAllListeners === 'function') {
                        client._port._client.removeAllListeners('error');
                        client._port._client.on('error', noopErr);
                    }
                    if (typeof client._port._client.destroy === 'function') {
                        client._port._client.destroy();
                    }
                }
                if (typeof client._port.destroy === 'function') {
                    client._port.destroy();
                }
            }
            if (client.isOpen) {
                client.close();
            }
        } catch (e) {
            // Ignore close errors
        }
        // Pastikan error listener noop tetap terpasang
        client.on('error', noopErr);
        releaseLock(lockKey);
    }
}

module.exports = {
    executeModbus,
    withTimeout
};
