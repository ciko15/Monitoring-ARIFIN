/**
 * VHF T6TV WebSocket Connector
 * Park Air T6 — Digest Auth WebSocket client
 * Ported from ws_client.py
 *
 * Manages one WebSocket connection per radio source.
 * Called by NetworkListener when parsing_id = 'vhf_t6tv'
 *
 * [FIX] Digest params (realm/nonce) sekarang di-cache per instance.
 * HTTP GET ke radio hanya dilakukan sekali saat pertama konek, atau
 * ketika WebSocket mendapat response 401 (nonce expired).
 * Ini mencegah HTTP request berulang ke radio setiap reconnect yang
 * sebelumnya menyebabkan session browser/aplikasi lain terputus.
 */

const http   = require('http');
const crypto = require('crypto');

const CMD_GET    = '#+GET+#+';
const CMD_RSP    = '#+RSP+#';
const CMD_TABLE  = 'TABLE';
const CMD_UPDATE = 'UPDTE';

const ALL_PANES = ['BIT_STS', 'SYS_SET', 'RADIO_C', 'BIT_ESC', 'AMV_TXS', 'AMV_RXS', 'S_N_M_P'];

const POLL_INTERVAL  = 30000;  // ms between poll cycles
const RECONNECT_DELAY = 5000;

function md5(text) {
    return crypto.createHash('md5').update(text).digest('hex');
}

function getDigestParams(host, port) {
    return new Promise((resolve) => {
        const req = http.request({ host, port: port || 80, path: '/', method: 'GET', timeout: 5000 }, (res) => {
            const wwwAuth = res.headers['www-authenticate'] || '';
            const realmM  = wwwAuth.match(/realm="([^"]+)"/);
            const nonceM  = wwwAuth.match(/nonce="([^"]+)"/);
            if (realmM && nonceM) {
                resolve({ realm: realmM[1], nonce: nonceM[1] });
            } else {
                resolve(null);
            }
        });
        req.on('error', () => resolve(null));
        req.on('timeout', () => { req.destroy(); resolve(null); });
        req.end();
    });
}

function normalizePorts(primaryPort, fallbackPorts = []) {
    const ports = [primaryPort || 80, ...fallbackPorts]
        .map(p => parseInt(p))
        .filter(p => Number.isInteger(p) && p > 0 && p <= 65535);
    return [...new Set(ports.length > 0 ? ports : [80])];
}

function buildDigestHeader(username, password, realm, nonce, uri = '/ws') {
    const ha1      = md5(`${username}:${realm}:${password}`);
    const ha2      = md5(`GET:${uri}`);
    const nc       = '00000001';
    const cnonce   = crypto.randomBytes(8).toString('hex');
    const response = md5(`${ha1}:${nonce}:${nc}:${cnonce}:auth:${ha2}`);
    return `Digest username="${username}", realm="${realm}", nonce="${nonce}", ` +
           `uri="${uri}", qop=auth, nc=${nc}, cnonce="${cnonce}", response="${response}"`;
}

class T6tvConnector {
    constructor(sourceId, host, port, username, password, wsPath, pollInterval, onData, onError, options = {}) {
        this.sourceId     = sourceId;
        this.host         = host;
        this.ports        = normalizePorts(port, options.fallbackPorts || []);
        this.port         = this.ports[0];
        this.username     = username;
        this.password     = password;
        this.wsPath       = wsPath || '/ws';
        this.pollInterval = pollInterval || POLL_INTERVAL;
        this.onData       = onData;
        this.onError      = onError;

        this._ws          = null;
        this._running     = false;
        this._connected   = false;
        this._pollTimer   = null;
        this._pollCount   = 0;
        this._portIndex   = 0;
        this._reconnectTimer = null;

        // Cache Digest params per port. A failed fetch on legacy port 8010 must
        // not prevent direct-radio auth on fallback port 80.
        // Map value:
        //   { realm, nonce } = challenge berhasil
        //   false            = port tidak mengirim WWW-Authenticate
        this._digestCacheByPort = new Map();
    }

    start() {
        this._running = true;
        this._connect();
    }

    stop() {
        this._running = false;
        if (this._reconnectTimer) {
            clearTimeout(this._reconnectTimer);
            this._reconnectTimer = null;
        }
        if (this._pollTimer) clearInterval(this._pollTimer);
        if (this._ws) {
            try { this._ws.terminate(); } catch(e) {}
        }
    }

    // [FIX] Panggil ini hanya saat: pertama kali konek, atau dapat 401
    async _fetchDigestParams(port) {
        console.log(`[T6TV] Fetching digest params from ${this.host}:${port}...`);
        const params = await getDigestParams(this.host, port);
        if (params) {
            this._digestCacheByPort.set(port, params);
            console.log(`[T6TV] Digest params cached for ${this.host}:${port} — realm="${params.realm}"`);
        } else {
            // Radio tidak kirim WWW-Authenticate, tandai false agar tidak retry terus
            this._digestCacheByPort.set(port, false);
            console.warn(`[T6TV] No WWW-Authenticate from ${this.host}:${port}, akan konek tanpa auth header`);
        }
    }

    _nextPort() {
        if (this.ports.length <= 1) return this.port;
        this._portIndex = (this._portIndex + 1) % this.ports.length;
        this.port = this.ports[this._portIndex];
        return this.port;
    }

    _scheduleReconnect(opened, reason) {
        if (!this._running || this._reconnectTimer) return;

        if (this._pollTimer) {
            clearInterval(this._pollTimer);
            this._pollTimer = null;
        }

        // Jika koneksi gagal sebelum sempat open, coba port kandidat berikutnya.
        // Ini membuat source lama yang masih memakai 8010 otomatis jatuh ke 80.
        if (!opened && this.ports.length > 1) {
            const previousPort = this.port;
            const nextPort = this._nextPort();
            console.warn(`[T6TV] ${this.host}:${previousPort} unavailable (${reason || 'closed'}), trying ${this.host}:${nextPort} next`);
        }

        this._reconnectTimer = setTimeout(() => {
            this._reconnectTimer = null;
            this._connect();
        }, RECONNECT_DELAY);
    }

    async _connect() {
        if (!this._running) return;

        try {
            const port = this.port || this.ports[this._portIndex] || 80;

            // [FIX] Hanya fetch digest params kalau cache masih kosong (null)
            // Kalau sudah ada (realm+nonce) atau sudah dicoba gagal (false), skip HTTP GET
            if (!this._digestCacheByPort.has(port)) {
                await this._fetchDigestParams(port);
            }
            const digestCache = this._digestCacheByPort.get(port);

            const headers = {
                'Origin': `http://${this.host}`,
                'Host'  : port === 80 ? this.host : `${this.host}:${port}`,
            };

            if (digestCache) {
                headers['Authorization'] = buildDigestHeader(
                    this.username, this.password,
                    digestCache.realm,
                    digestCache.nonce,
                    this.wsPath
                );
            }

            // Dynamic import of 'ws' — Bun has it built-in
            const WebSocket = globalThis.WebSocket || require('ws');
            const url = `ws://${this.host}:${port}${this.wsPath}`;
            this._ws = new WebSocket(url, { headers });
            let opened = false;
            let lastError = null;

            this._ws.onopen = () => {
                opened = true;
                this._connected = true;
                this.port = port;
                this._portIndex = this.ports.indexOf(port);
                console.log(`[T6TV] Connected to ${this.host}:${port} (source: ${this.sourceId})`);
                // Request all panes on connect — stagger 300ms agar tidak flood device
                ALL_PANES.forEach((pane, i) => {
                    setTimeout(() => {
                        console.log(`[T6TV] Requesting pane: ${pane} from ${this.host}:${port}`);
                        this._send(`#+GET+# ${CMD_TABLE} ${pane}`);
                    }, i * 300);
                });
                // Start poll loop setelah semua initial request terkirim
                const startDelay = ALL_PANES.length * 300 + 500;
                setTimeout(() => {
                    this._pollTimer = setInterval(() => this._pollCycle(), this.pollInterval);
                }, startDelay);
            };

            this._ws.onmessage = (event) => {
                if (this.onData) this.onData(event.data);
            };

            this._ws.onerror = (err) => {
                const msg = err.message || String(err);
                lastError = msg;
                console.error(`[T6TV] WS error for ${this.host}:${port}:`, msg);

                // [FIX] Kalau 401 — nonce sudah expired, clear cache agar fetch ulang
                if (msg.includes('401') || msg.includes('Unauthorized')) {
                    console.warn(`[T6TV] 401 detected for ${this.host}:${port} — clearing digest cache, will re-fetch on next connect`);
                    this._digestCacheByPort.delete(port);
                }

                if (this.onError) this.onError(err);
            };

            this._ws.onclose = () => {
                this._connected = false;
                console.log(`[T6TV] Disconnected from ${this.host}:${port}, reconnecting in ${RECONNECT_DELAY / 1000}s...`);
                this._scheduleReconnect(opened, lastError);
            };

        } catch(e) {
            console.error(`[T6TV] Connect error for ${this.host}:${this.port}:`, e.message);
            if (this.onError) this.onError(e);
            this._scheduleReconnect(false, e.message);
        }
    }

    _pollCycle() {
        if (!this._connected) return;
        this._pollCount++;

        // BIT_STS: device push otomatis, tapi poll UPDTE untuk safety
        this._send(`#+GET+# ${CMD_UPDATE} BIT_STS`);

        // Setting panes: rotasi 2 per cycle agar tidak flood device
        const settingPanes = ['SYS_SET', 'RADIO_C', 'S_N_M_P', 'AMV_TXS', 'AMV_RXS', 'BIT_ESC'];
        const idx  = (this._pollCount - 1) % settingPanes.length;
        const paneA = settingPanes[idx];
        const paneB = settingPanes[(idx + 1) % settingPanes.length];
        this._send(`#+GET+# ${CMD_TABLE} ${paneA}`);
        this._send(`#+GET+# ${CMD_TABLE} ${paneB}`);

        console.log(`[T6TV] Poll #${this._pollCount}: BIT_STS(UPDTE) + TABLE ${paneA} + TABLE ${paneB}`);
    }

    _send(message) {
        if (!message.includes('#+GET+#')) return;
        try {
            if (this._ws && this._connected && this._ws.readyState === 1) {
                console.log(`[T6TV] >> SEND to ${this.host}:${this.port}: ${message}`);
                this._ws.send(message);
            } else {
                console.warn(`[T6TV] >> SKIP (not connected) ${this.host}:${this.port}: ${message}`);
            }
        } catch(e) {
            console.warn(`[T6TV] Send error for ${this.host}:${this.port}:`, e.message);
        }
    }
}

module.exports = T6tvConnector;
