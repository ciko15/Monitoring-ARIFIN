/**
 * Connection Manager
 * Handles TCP/UDP connections to equipment (DME, DVOR, etc.)
 */

const net = require('net');
const dgram = require('dgram');
const { spawn } = require('child_process');

class ConnectionManager {
    constructor() {
        this.connections = new Map(); // equipment_id -> connection
        this.listeners = new Map();   // equipment_id -> data listener
    }

    /**
     * Connect to equipment via TCP
     * @param {number} equipmentId - Equipment ID
     * @param {string} host - Equipment IP
     * @param {number} port - Equipment port
     * @param {Function} onData - Callback for received data
     * @param {Function} onError - Callback for errors
     * @returns {Promise<boolean>} Connection success
     */
    async connectTCP(equipmentId, host, port, onData, onError) {
        return new Promise((resolve, reject) => {
            // Close existing connection if any
            this.disconnect(equipmentId);

            const socket = new net.Socket();
            socket.setTimeout(10000); // 10 second timeout

            socket.connect(port, host, () => {
                console.log(`[Connection] TCP connected to ${host}:${port} (equipment: ${equipmentId})`);
                this.connections.set(equipmentId, { socket, type: 'tcp', host, port });
                resolve(true);
            });

            // Universal TCP stream buffer
            // Supports both:
            //   DVOR Maru 220: SOH+STX+TAG+data+ETX (wait for all 5 sections)
            //   DME Maru 310/320: SOH+ASCII_HEX+STX+ASCII_HEX+ETX (emit per complete frame)
            let tcpBuffer = Buffer.alloc(0);
            const DVOR_TAGS = ['N1', 'N2', 'G1', 'G2', 'LC'];

            socket.on('data', (chunk) => {
                tcpBuffer = Buffer.concat([tcpBuffer, chunk]);

                const ETX = 0x03;
                const SOH = 0x01;
                const STX = 0x02;


                // Detect protocol type from buffer content
                // DVOR: SOH immediately followed by STX then 2-char ASCII tag (N1,N2,G1,G2,LC)
                // DME:  SOH followed by ASCII hex digits then STX
                const bufStr = tcpBuffer.toString('binary');
                const isDVOR = DVOR_TAGS.some(tag => bufStr.includes('\x01\x02' + tag));

                if (isDVOR) {
                    // DVOR mode: wait for all 5 sections
                    const hasAll = DVOR_TAGS.every(tag => bufStr.includes('\x01\x02' + tag));
                    if (hasAll) {
                        let lastEtx = -1;
                        for (let j = tcpBuffer.length - 1; j >= 0; j--) {
                            if (tcpBuffer[j] === ETX) { lastEtx = j; break; }
                        }
                        if (lastEtx >= 0) {
                            const complete = tcpBuffer.slice(0, lastEtx + 1);
                            tcpBuffer = tcpBuffer.slice(lastEtx + 1);
                            if (onData) onData(complete);
                        }
                    }
                } else {
                    // DME Maru 310/320 mode
                    // Frame format: SOH + ASCII_HEX(header) + STX + ASCII_HEX(payload) + ETX
                    let startPos = tcpBuffer.indexOf(SOH);
                    let lastProcessedEnd = -1;

                    while (startPos >= 0) {
                        const stxPos = tcpBuffer.indexOf(STX, startPos + 1);
                        if (stxPos < 0) break;
                        const etxPos = tcpBuffer.indexOf(ETX, stxPos + 1);
                        if (etxPos < 0) break; // incomplete, wait for more data

                        if (etxPos - startPos > 100) {
                            const frame = tcpBuffer.slice(startPos, etxPos + 1);
                            if (onData) onData(frame);
                        }
                        lastProcessedEnd = etxPos + 1;
                        startPos = tcpBuffer.indexOf(SOH, etxPos + 1);
                    }

                    // Trim buffer: buang semua yang sudah diproses
                    if (lastProcessedEnd > 0) {
                        // Ada frame yang sudah diproses — buang sampai sini
                        // Cari SOH berikutnya sebagai awal frame yang belum lengkap
                        const nextSoh = startPos >= 0 ? startPos : tcpBuffer.lastIndexOf(SOH, tcpBuffer.length - 1);
                        tcpBuffer = nextSoh > lastProcessedEnd ? tcpBuffer.slice(nextSoh)
                                  : nextSoh === lastProcessedEnd ? tcpBuffer.slice(nextSoh)
                                  : tcpBuffer.slice(lastProcessedEnd);
                    } else if (startPos < 0) {
                        // Tidak ada SOH sama sekali — reset
                        tcpBuffer = Buffer.alloc(0);
                    } else if (startPos > 0) {
                        // Ada SOH tapi frame belum lengkap — simpan dari SOH
                        tcpBuffer = tcpBuffer.slice(startPos);
                    }
                    // startPos === 0 dan belum ada frame lengkap: biarkan buffer utuh, tunggu data berikutnya
                }

                // Safety: prevent buffer overflow
                if (tcpBuffer.length > 131072) {
                    console.warn('[Connection] TCP buffer overflow, resetting');
                    tcpBuffer = Buffer.alloc(0);
                }
            });

            socket.on('error', (error) => {
                console.error(`[Connection] TCP error for equipment ${equipmentId}:`, error.message);
                if (onError) onError(error);
            });

            socket.on('timeout', () => {
                console.error(`[Connection] TCP timeout for equipment ${equipmentId}`);
                socket.destroy();
                if (onError) onError(new Error('Connection timeout'));
            });

            socket.on('close', () => {
                console.log(`[Connection] TCP disconnected for equipment ${equipmentId}`);
                this.connections.delete(equipmentId);
            });
        });
    }

    /**
     * Start passive sniffer using TShark
     * @param {number} equipmentId - Equipment ID
     * @param {string} host - Equipment IP to sniff
     * @param {number} port - Equipment port to sniff
     * @param {string} interfaceName - Network interface name (e.g., 'Ethernet 8')
     * @param {Function} onData - Callback for received data buffer
     * @param {Function} onError - Callback for errors
     * @returns {Promise<boolean>} Sniffer started successfully
     */
    async connectSniffer(equipmentId, host, port, interfaceName, onData, onError) {
        return new Promise((resolve, reject) => {
            this.disconnect(equipmentId);

            console.log(`[Connection] Starting Sniffer on ${interfaceName} for ${host}:${port} (equipment: ${equipmentId})`);
            
            // Spawn TShark
            const tsharkArgs = [
                '-i', interfaceName,
                '-f', `tcp src port ${port} and src host ${host}`,
                '-T', 'fields',
                '-e', 'tcp.payload',
                '-l' // line buffered
            ];

            // Use 'tshark' from PATH or fallback to hardcoded if needed. By default, rely on PATH.
            const sniffer = spawn('tshark', tsharkArgs, { windowsHide: true });
            this.connections.set(equipmentId, { 
                socket: sniffer, 
                type: 'sniffer', 
                host, 
                port,
                destroy: () => sniffer.kill() // Add destroy method for consistency
            });
            
            resolve(true);

            sniffer.stdout.on('data', (data) => {
                const output = data.toString().trim();
                if (!output) return;

                const lines = output.split('\n');
                
                for (let line of lines) {
                    line = line.trim();
                    if (!line) continue;
                    
                    const payloads = line.split(',');
                    for (let hexStr of payloads) {
                        hexStr = hexStr.replace(/:/g, ''); 
                        
                        if (hexStr.length > 0 && hexStr.length % 2 === 0) {
                            const buf = Buffer.from(hexStr, 'hex');
                            if (onData) onData(buf);
                        }
                    }
                }
            });

            sniffer.stderr.on('data', (data) => {
                const msg = data.toString();
                if (!msg.includes('Capturing on')) {
                    console.error(`[Sniffer Error/Info]: ${msg.trim()}`);
                }
            });

            sniffer.on('close', (code) => {
                console.log(`[Connection] Sniffer disconnected for equipment ${equipmentId} with code ${code}`);
                this.connections.delete(equipmentId);
            });

            sniffer.on('error', (error) => {
                console.error(`[Connection] Sniffer spawn error for equipment ${equipmentId}:`, error.message);
                if (onError) onError(error);
            });
        });
    }

    /**
     * Connect to equipment via UDP
     * @param {number} equipmentId - Equipment ID
     * @param {string} host - Equipment IP (or multicast IP)
     * @param {number} port - Equipment port
     * @param {Function} onData - Callback for received data
     * @param {Function} onError - Callback for errors
     * @returns {boolean} Success
     */
    connectUDP(equipmentId, host, port, onData, onError) {
        // Close existing connection if any
        this.disconnect(equipmentId);

        try {
            const socket = dgram.createSocket('udp4');
            
            socket.on('message', (msg, rinfo) => {
                if (onData) onData(msg, rinfo);
            });

            socket.on('error', (error) => {
                console.error(`[Connection] UDP error for equipment ${equipmentId}:`, error.message);
                if (onError) onError(error);
            });

            socket.bind(port, () => {
                // If multicast IP, join multicast group
                if (host.startsWith('239.') || host.startsWith('225.')) {
                    try {
                        socket.addMembership(host);
                        console.log(`[Connection] Joined multicast group ${host}`);
                    } catch (e) {
                        console.warn(`[Connection] Could not join multicast: ${e.message}`);
                    }
                }
                console.log(`[Connection] UDP bound to ${port} (equipment: ${equipmentId})`);
            });

            this.connections.set(equipmentId, { socket, type: 'udp', host, port });
            return true;
        } catch (error) {
            console.error(`[Connection] UDP setup failed for equipment ${equipmentId}:`, error.message);
            return false;
        }
    }

    /**
     * Send data to equipment via TCP
     * @param {number} equipmentId - Equipment ID
     * @param {Buffer|string} data - Data to send
     * @returns {Promise<boolean>} Send success
     */
    async send(equipmentId, data) {
        const conn = this.connections.get(equipmentId);
        if (!conn) {
            console.warn(`[Connection] No connection for equipment ${equipmentId}`);
            return false;
        }

        return new Promise((resolve) => {
            if (conn.type === 'tcp') {
                conn.socket.write(data, () => {
                    resolve(true);
                });
            } else {
                // UDP - need to know target
                console.warn(`[Connection] UDP send not implemented - use sendTo`);
                resolve(false);
            }
        });
    }

    /**
     * Send data to equipment via UDP
     * @param {number} equipmentId - Equipment ID
     * @param {Buffer|string} data - Data to send
     * @returns {boolean} Send success
     */
    sendTo(equipmentId, data) {
        const conn = this.connections.get(equipmentId);
        if (!conn || conn.type !== 'udp') {
            console.warn(`[Connection] No UDP connection for equipment ${equipmentId}`);
            return false;
        }

        try {
            const message = Buffer.isBuffer(data) ? data : Buffer.from(data);
            conn.socket.send(message, 0, message.length, conn.port, conn.host);
            return true;
        } catch (error) {
            console.error(`[Connection] UDP send failed:`, error.message);
            return false;
        }
    }

    /**
     * Disconnect equipment
     * @param {number} equipmentId - Equipment ID
     */
    disconnect(equipmentId) {
        const conn = this.connections.get(equipmentId);
        if (conn) {
            if (conn.type === 'udp') {
                try {
                    conn.socket.close();
                } catch(e) {}
            } else if (conn.type === 'sniffer') {
                try {
                    conn.destroy();
                } catch(e) {}
            } else {
                try {
                    conn.socket.destroy();
                } catch(e) {}
            }
            this.connections.delete(equipmentId);
            this.listeners.delete(equipmentId);
            console.log(`[Connection] Disconnected equipment ${equipmentId} (${conn.type})`);
        }
    }

    /**
     * Disconnect all equipment
     */
    disconnectAll() {
        for (const equipmentId of this.connections.keys()) {
            this.disconnect(equipmentId);
        }
    }

    /**
     * Check if equipment is connected
     * @param {number} equipmentId - Equipment ID
     * @returns {boolean} Connection status
     */
    isConnected(equipmentId) {
        return this.connections.has(equipmentId);
    }

    /**
     * Get connection status
     * @param {number} equipmentId - Equipment ID
     * @returns {Object|null} Connection info
     */
    getStatus(equipmentId) {
        const conn = this.connections.get(equipmentId);
        if (!conn) return null;
        
        return {
            connected: true,
            type: conn.type,
            host: conn.host,
            port: conn.port
        };
    }

    /**
     * Test TCP connection
     * @param {string} host - Host IP
     * @param {number} port - Port
     * @param {number} timeout - Timeout in ms
     * @returns {Promise<Object>} Test result
     */
    async testConnection(host, port, timeout = 5000) {
        return new Promise((resolve) => {
            const socket = new net.Socket();
            const startTime = Date.now();
            
            socket.setTimeout(timeout);
            
            socket.connect(port, host, () => {
                const responseTime = Date.now() - startTime;
                socket.destroy();
                resolve({
                    success: true,
                    responseTime,
                    message: 'Connection successful'
                });
            });
            
            socket.on('error', (error) => {
                const responseTime = Date.now() - startTime;
                resolve({
                    success: false,
                    responseTime,
                    message: error.message,
                    error: error.code
                });
            });
            
            socket.on('timeout', () => {
                socket.destroy();
                resolve({
                    success: false,
                    responseTime: timeout,
                    message: 'Connection timeout',
                    error: 'ETIMEDOUT'
                });
            });
        });
    }
}

// Singleton instance
const connectionManager = new ConnectionManager();

module.exports = connectionManager;
