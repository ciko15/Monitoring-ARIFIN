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
    constructor(sourceId, host, port, username, password, wsPath, pollInterval, onData, onError) {
        this.sourceId     = sourceId;
        this.host         = host;
        this.port         = port || 80;
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

        // [FIX] Cache digest params — { realm, nonce }
        // null  = belum pernah fetch, perlu HTTP GET
        // false = fetch sudah dicoba tapi gagal (radio tidak respond), skip auth
        this._digestCache = null;
    }

    start() {
        this._running = true;
        this._connect();
    }

    stop() {
        this._running = false;
        if (this._pollTimer) clearInterval(this._pollTimer);
        if (this._ws) {
            try { this._ws.terminate(); } catch(e) {}
        }
    }

    // [FIX] Panggil ini hanya saat: pertama kali konek, atau dapat 401
    async _fetchDigestParams() {
        console.log(`[T6TV] Fetching digest params from ${this.host}...`);
        const params = await getDigestParams(this.host, this.port);
        if (params) {
            this._digestCache = params;
            console.log(`[T6TV] Digest params cached — realm="${params.realm}"`);
        } else {
            // Radio tidak kirim WWW-Authenticate, tandai false agar tidak retry terus
            this._digestCache = false;
            console.warn(`[T6TV] No WWW-Authenticate from ${this.host}, akan konek tanpa auth header`);
        }
    }

    async _connect() {
        if (!this._running) return;

        try {
            // [FIX] Hanya fetch digest params kalau cache masih kosong (null)
            // Kalau sudah ada (realm+nonce) atau sudah dicoba gagal (false), skip HTTP GET
            if (this._digestCache === null) {
                await this._fetchDigestParams();
            }

            const headers = {
                'Origin': `http://${this.host}`,
                'Host'  : this.host,
            };

            if (this._digestCache) {
                headers['Authorization'] = buildDigestHeader(
                    this.username, this.password,
                    this._digestCache.realm,
                    this._digestCache.nonce,
                    this.wsPath
                );
            }

            // Dynamic import of 'ws' — Bun has it built-in
            const WebSocket = globalThis.WebSocket || require('ws');
            const url = `ws://${this.host}:${this.port}${this.wsPath}`;
            this._ws = new WebSocket(url, { headers });

            this._ws.onopen = () => {
                this._connected = true;
                console.log(`[T6TV] Connected to ${this.host} (source: ${this.sourceId})`);
                // Request all panes on connect — stagger 300ms agar tidak flood device
                ALL_PANES.forEach((pane, i) => {
                    setTimeout(() => {
                        console.log(`[T6TV] Requesting pane: ${pane} from ${this.host}`);
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
                console.error(`[T6TV] WS error for ${this.host}:`, msg);

                // [FIX] Kalau 401 — nonce sudah expired, clear cache agar fetch ulang
                if (msg.includes('401') || msg.includes('Unauthorized')) {
                    console.warn(`[T6TV] 401 detected for ${this.host} — clearing digest cache, will re-fetch on next connect`);
                    this._digestCache = null;
                }

                if (this.onError) this.onError(err);
            };

            this._ws.onclose = () => {
                this._connected = false;
                if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }
                console.log(`[T6TV] Disconnected from ${this.host}, reconnecting in ${RECONNECT_DELAY / 1000}s...`);
                // [FIX] Reconnect TIDAK fetch ulang digest — pakai cache yang ada
                if (this._running) {
                    setTimeout(() => this._connect(), RECONNECT_DELAY);
                }
            };

        } catch(e) {
            console.error(`[T6TV] Connect error for ${this.host}:`, e.message);
            if (this.onError) this.onError(e);
            if (this._running) setTimeout(() => this._connect(), RECONNECT_DELAY);
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
                console.log(`[T6TV] >> SEND to ${this.host}: ${message}`);
                this._ws.send(message);
            } else {
                console.warn(`[T6TV] >> SKIP (not connected) ${this.host}: ${message}`);
            }
        } catch(e) {
            console.warn(`[T6TV] Send error for ${this.host}:`, e.message);
        }
    }
}

module.exports = T6tvConnector;
