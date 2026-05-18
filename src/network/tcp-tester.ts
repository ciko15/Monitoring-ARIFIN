import * as net from 'net';
import ping from 'ping';

export interface TcpTestResult {
    connected: boolean;
    status: 'Connected' | 'Disconnect' | 'Gateway Unreachable';
    gatewayPing: boolean;
    syncMarkerValid: boolean | null;
    rawHex: string | null;
    message: string;
}

export async function testTcpConnection(
    gatewayIp: string,
    deviceIp: string,
    port: number,
    syncMarkerHex: string,
    timeoutMs: number = 5000
): Promise<TcpTestResult> {
    // 1. Ping Gateway (Stage 1 Authentication)
    let gatewayReachable = true;
    if (gatewayIp && gatewayIp.trim() !== '') {
        try {
            const res = await ping.promise.probe(gatewayIp, { timeout: 3 });
            gatewayReachable = res.alive;
        } catch (e) {
            gatewayReachable = false;
        }
    }

    if (!gatewayReachable) {
        return {
            connected: false,
            status: 'Gateway Unreachable',
            gatewayPing: false,
            syncMarkerValid: null,
            rawHex: null,
            message: `Verifikasi tahap 1 gagal: Gateway ${gatewayIp} tidak dapat dijangkau.`
        };
    }

    // 2. Connect to Device and verify Sync Marker (Stage 2)
    return new Promise((resolve) => {
        const socket = new net.Socket();
        socket.setTimeout(timeoutMs);

        let dataReceived = false;
        let isConnected = false;

        const complete = (result: Partial<TcpTestResult>) => {
            if (!socket.destroyed) socket.destroy();
            resolve({
                connected: result.connected ?? false,
                status: result.status || 'Disconnect',
                gatewayPing: gatewayReachable,
                syncMarkerValid: result.syncMarkerValid ?? null,
                rawHex: result.rawHex ?? null,
                message: result.message || ''
            });
        };

        socket.on('connect', () => {
             isConnected = true;
             // If we don't expect data immediately or just testing port
             if (!syncMarkerHex || syncMarkerHex.trim() === '') {
                 // Wait a little bit to see if data arrives anyway, 
                 // but if it doesn't, we still consider connection successful.
                 setTimeout(() => {
                     if (!dataReceived) {
                         complete({ connected: true, status: 'Connected', message: 'Koneksi berhasil (Tanpa validasi Sync Marker). Menunggu data waktu habis.'});
                     }
                 }, timeoutMs);
             }
        });

        socket.on('data', (data) => {
            if (dataReceived) return;
            dataReceived = true;
            
            const rawHex = data.toString('hex').toUpperCase();
            let syncMarkerValid = null;

            if (syncMarkerHex && syncMarkerHex.trim() !== '') {
                // Normalize marker
                const targetMarker = syncMarkerHex.replace(/\s+/g, '').toUpperCase();
                // Extract prefix matching length of target marker or rawData
                // E.g. PKT_C is 50 4B 54 5F 43
                if (targetMarker.length > 0) {
                    syncMarkerValid = rawHex.startsWith(targetMarker);
                }
            }

            // Format hex for display
            let formattedHex = '';
            for (let i = 0; i < rawHex.length; i += 2) {
                formattedHex += rawHex.substring(i, i + 2) + ' ';
            }

            complete({
                connected: true,
                status: 'Connected',
                syncMarkerValid,
                rawHex: formattedHex.trim(),
                message: syncMarkerValid === false 
                    ? `Data diterima namun divalidasi INVALID (Marker tidak cocok).` 
                    : `Data berhasil diterima dan valid.`
            });
        });

        socket.on('timeout', () => {
             if (dataReceived) return; // Already resolved
             complete({
                connected: isConnected,
                status: isConnected ? 'Connected' : 'Disconnect',
                message: isConnected ? 'Terhubung, namun timeout menunggu raw data.' : 'Connection timed out saat mencoba koneksi ke IP.'
             });
        });

        socket.on('error', (err: any) => {
            complete({ 
                connected: false, 
                status: 'Disconnect', 
                message: `Connection Error: ${err.message}` 
            });
        });

        socket.connect(port, deviceIp);
    });
}

export async function scanPorts(ip: string, startPort: number, endPort: number, timeoutMs: number = 2000): Promise<number[]> {
    const portsToScan = [];
    for (let p = startPort; p <= endPort; p++) {
        portsToScan.push(p);
    }
    
    // Batch scanning to prevent EMFILE limits
    const openPorts: number[] = [];
    const batchSize = 50;

    for (let i = 0; i < portsToScan.length; i += batchSize) {
        const batch = portsToScan.slice(i, i + batchSize);
        const promises = batch.map(port => new Promise<number | null>((resolve) => {
            const s = new net.Socket();
            s.setTimeout(timeoutMs);
            s.on('connect', () => { s.destroy(); resolve(port); });
            s.on('timeout', () => { s.destroy(); resolve(null); });
            s.on('error', () => { s.destroy(); resolve(null); });
            s.connect(port, ip);
        }));

        const results = await Promise.all(promises);
        results.forEach(p => { if (p !== null) openPorts.push(p); });
    }

    return openPorts;
}
