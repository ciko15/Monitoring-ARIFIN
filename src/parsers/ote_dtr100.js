'use strict';

const net = require('net');
const BaseParser = require('./base');

// Known poll frames derived from PCAP
const KNOWN_POLLS = {
    4:  Buffer.from('02020a3019061e0100010000043f4a', 'hex'),
    7:  Buffer.from('02020a3019061e0100010000075c7a', 'hex'),
    29: Buffer.from('02020a3019061e01000100001d27c9', 'hex'),
    45: Buffer.from('02020a3019061e01000100002d74ff', 'hex'),
    48: Buffer.from('02020a3019061e010001000030e83c', 'hex'),
    56: Buffer.from('02020a3019061e010001000038e0bd', 'hex'),
    104: Buffer.from('02020a3019061e01000100006815e7', 'hex')
};
const POLL_IDS = Object.keys(KNOWN_POLLS).map(Number);

class OteDtr100Parser extends BaseParser {
    constructor(config) {
        super(config);
        this.ip = config.ip;
        this.port = config.port || 950;
        this.socket = null;
        
        this.buffer = Buffer.alloc(0);
        
        this.lastReceiveTime = 0;
        this.activeMode = false;
        this.activeModeCheckInterval = null;
        this.pollTimer = null;
        this.currentPollIndex = 0;
        
        // Timeout to assume passive mode failed (e.g., LMT disconnected)
        this.PASSIVE_TIMEOUT_MS = 5000;
        this.POLL_INTERVAL_MS = 1000;
    }

    start() {
        this.connect();
        
        // Monitor if we need to switch to Active mode
        this.activeModeCheckInterval = setInterval(() => {
            const now = Date.now();
            if (!this.activeMode && (now - this.lastReceiveTime > this.PASSIVE_TIMEOUT_MS)) {
                this.logger.info(`[OTE DTR100] No passive data for ${this.PASSIVE_TIMEOUT_MS}ms. Switching to ACTIVE mode.`);
                this.activeMode = true;
                this.startPolling();
            }
        }, 2000);
    }

    stop() {
        if (this.activeModeCheckInterval) clearInterval(this.activeModeCheckInterval);
        if (this.pollTimer) clearInterval(this.pollTimer);
        if (this.socket) {
            this.socket.destroy();
            this.socket = null;
        }
        this.logger.info(`[OTE DTR100] Stopped.`);
    }

    connect() {
        if (this.socket) this.socket.destroy();
        this.socket = new net.Socket();
        this.socket.setTimeout(10000);
        
        this.socket.on('connect', () => {
            this.logger.info(`[OTE DTR100] Connected to ${this.ip}:${this.port}`);
            this.lastReceiveTime = Date.now();
        });

        this.socket.on('data', (data) => {
            this.lastReceiveTime = Date.now();
            this.buffer = Buffer.concat([this.buffer, data]);
            this.processBuffer();
        });

        this.socket.on('timeout', () => {
            this.logger.warn(`[OTE DTR100] Socket timeout.`);
            this.socket.destroy();
        });

        this.socket.on('error', (err) => {
            this.logger.error(`[OTE DTR100] Socket error: ${err.message}`);
        });

        this.socket.on('close', () => {
            this.logger.info(`[OTE DTR100] Connection closed. Reconnecting in 5s...`);
            setTimeout(() => this.connect(), 5000);
        });

        this.socket.connect(this.port, this.ip);
    }

    startPolling() {
        if (this.pollTimer) clearInterval(this.pollTimer);
        this.pollTimer = setInterval(() => {
            if (!this.activeMode || !this.socket || this.socket.readyState !== 'open') return;
            
            const id = POLL_IDS[this.currentPollIndex];
            const frame = KNOWN_POLLS[id];
            
            if (frame) {
                this.socket.write(frame);
            }
            
            this.currentPollIndex = (this.currentPollIndex + 1) % POLL_IDS.length;
        }, this.POLL_INTERVAL_MS);
    }

    processBuffer() {
        while (this.buffer.length > 0) {
            const stxIdx = this.buffer.indexOf(0x02);
            if (stxIdx === -1) {
                this.buffer = Buffer.alloc(0);
                return;
            }
            
            if (stxIdx > 0) {
                this.buffer = this.buffer.slice(stxIdx);
            }

            if (this.buffer.length < 3) return;

            const lenByte = this.buffer[2];
            const totalFrameSize = 1 + 1 + 1 + lenByte + 2;

            if (this.buffer.length < totalFrameSize) return;

            const frame = this.buffer.slice(0, totalFrameSize);
            this.buffer = this.buffer.slice(totalFrameSize);
            this.parseFrame(frame);
        }
    }

    parseFrame(frame) {
        const len = frame[2];
        const payload = frame.slice(3, 3 + len);
        
        if (payload.length >= 7 && payload[0] === 0x19) {
            const dataLen = payload[6];
            if (payload.length >= 7 + 3 + (dataLen - 3)) {
                const id = payload[9]; 
                
                if (payload[7] === 0x00 && payload[8] === 0x00) {
                    const dataBytes = payload.slice(10, 10 + (dataLen - 3));
                    this.mapParameter(id, dataBytes);
                }
            }
        }
    }

    mapParameter(id, dataBytes) {
        let value = 0;
        for (let i = 0; i < dataBytes.length; i++) {
            value |= (dataBytes[i] << (i * 8));
        }

        const data = {};
        switch (id) {
            case 4:
                data.modulation_pct = value;
                break;
            case 7:
                data.fwd_power_w = value; // Needs validation with LMT
                break;
            case 29:
                data.frequency_mhz = value / 1000.0;
                break;
            case 45:
                data.squelch_dbm = value;
                break;
            case 48:
                data.sensitivity_dbm = value;
                break;
            case 104:
                data.rssi_dbm = value;
                break;
            default:
                data[`raw_id_${id}`] = value;
                break;
        }

        data._status = 'Normal';
        this.emit('data', data);
    }
}

module.exports = OteDtr100Parser;
