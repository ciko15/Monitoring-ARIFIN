const ModbusRTU = require("modbus-serial");

// Mutex lock global per IP:Port agar 2 request tidak tabrakan
const modbusLocks = new Map();

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function acquireLock(lockKey, timeoutMs = 10000) {
    const start = Date.now();
    while (modbusLocks.get(lockKey)) {
        if (Date.now() - start > timeoutMs) {
            throw new Error(`Timeout waiting for Modbus lock on ${lockKey}`);
        }
        await sleep(50);
    }
    modbusLocks.set(lockKey, true);
}

function releaseLock(lockKey) {
    modbusLocks.delete(lockKey);
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

    await acquireLock(lockKey, timeoutMs * 2);

    const client = new ModbusRTU();
    
    // Cegah unhandled rejection jika library mengeluarkan error dari background socket
    client.on('error', (err) => {
        // Log diabaikan atau disingkat karena akan tertangkap di promise execution
    });

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
            // Pembersihan menyeluruh (hapus socket, event listener, timer)
            client.removeAllListeners('error');
            client.removeAllListeners('timeout');
            if (client.isOpen) {
                client.close();
            }
        } catch (e) {
            // Ignore close errors
        }
        releaseLock(lockKey);
    }
}

module.exports = {
    executeModbus,
    withTimeout
};
