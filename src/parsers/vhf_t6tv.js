const BaseParser = require('./base');

/**
 * VHF T6TV Parser — Park Air T6 WebSocket
 * Ported from ws_client.py + html_parser.py
 *
 * Protocol : WebSocket ws://{host}/ws
 * Auth     : HTTP Digest MD5
 * Commands : #+GET+# TABLE {pane} / #+GET+# UPDTE {pane}
 * Response : #+RSP+# TABLE {pane_id} {html}
 * Panes    : BIT_STS, SYS_SET, RADIO_C, BIT_ESC, AMV_TXS, AMV_RXS, S_N_M_P
 */

const CMD_RSP   = '#+RSP+#';
const CMD_TABLE = 'TABLE';

// ── HTML Parser (minimal, no external deps) ──────────────────────────────────

function stripTags(html) {
    return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function decodeEntities(str) {
    return str
        .replace(/&deg;/gi, '°')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n))
        .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

// Mirrors Python _extract_value() from html_parser.py exactly
function extractValue(cellHtml) {
    // 1. text/number input → value attribute
    const inputM = cellHtml.match(/<input[^>]+type=["'](?:text|number)["'][^>]*value=["']([^"']*)["']/i)
                || cellHtml.match(/<input[^>]+value=["']([^"']*)["'][^>]+type=["'](?:text|number)["']/i)
                || cellHtml.match(/<input[^>]*value=["']([^"']*)["']/i);
    if (inputM) return inputM[1].trim();

    // 2. select → selected option text
    const selectM = cellHtml.match(/<option[^>]*selected[^>]*>([^<]+)<\/option>/i);
    if (selectM) return selectM[1].trim();

    // 3. radio buttons → label of checked one
    if (/<input[^>]+type=["']radio["']/i.test(cellHtml)) {
        const checkedM = cellHtml.match(/<input[^>]+type=["']radio["'][^>]*checked[^>]*>[\s]*([^<]+)/i)
                      || cellHtml.match(/<input[^>]*checked[^>]*type=["']radio["'][^>]*>[\s]*([^<]+)/i);
        if (checkedM) return checkedM[1].trim();
        return '—';
    }

    // 4. fallback: strip all tags, collapse whitespace
    return stripTags(cellHtml).trim() || '—';
}

function parseTables(html) {
    const tables = [];
    const tableRe = /<table[^>]*>([\s\S]*?)<\/table>/gi;
    let tm;
    while ((tm = tableRe.exec(html)) !== null) {
        const rows = [];
        const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
        let rm;
        while ((rm = rowRe.exec(tm[1])) !== null) {
            const cols = [];
            const colRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
            let cm;
            while ((cm = colRe.exec(rm[1])) !== null) {
                cols.push(extractValue(cm[1]));
            }
            if (cols.length >= 2) rows.push(cols);
        }
        if (rows.length > 0) tables.push(rows);
    }
    return tables;
}

function parseBitStatus(html) {
    const result = {
        overall_status: '—',
        status_messages: [],
        ac: '—', dc: '—', dc_supply_v: '—',
        ambient_temp: '—', internal_temp: '—', elapsed_time: '—'
    };
    if (!html) return result;


    // Table 1: Overall Service Status
    // <thead><th>Overall Service Status</th>...</thead>
    // <tbody><tr><td> Full Service </td>...
    const statusM = html.match(/Overall Service Status[\s\S]*?<tbody>([\s\S]*?)<\/tbody>/i);
    if (statusM) {
        const tdM = statusM[1].match(/<td[^>]*>([\s\S]*?)<\/td>/i);
        if (tdM) result.overall_status = stripTags(tdM[1]).trim() || '—';
    }

    // Table 2: Status Messages
    // <h3>Status Messages:</h3><table ...><td>No Messages</td>
    const msgM = html.match(/Status Messages[^<]*<\/h[0-9]>([\s\S]*?)<\/table>/i);
    if (msgM) {
        const msgs = [];
        const tdRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
        let m;
        while ((m = tdRe.exec(msgM[1])) !== null) {
            const txt = stripTags(m[1]).trim();
            if (txt && txt !== 'No Messages' && !txt.includes('Reset')) msgs.push(txt);
        }
        result.status_messages = msgs;
    }

    // Monitoring table: scan semua tabel di BIT_STS HTML
    // Format: <td>Status Parameter Name</td><td>Monitoring Value</td>
    //    atau: <td>AC</td><td>Connected</td>
    const allTables = html.match(/<table[\s\S]*?<\/table>/gi) || [];
    for (const tbl of allTables) {
        const kv = {};
        const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
        let rm;
        while ((rm = rowRe.exec(tbl)) !== null) {
            const tds = [...rm[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)];
            if (tds.length >= 2) {
                const k = decodeEntities(stripTags(tds[0][1]).trim());
                const v = decodeEntities(stripTags(tds[1][1]).trim());
                if (k && k !== 'Status Parameter Name' && k !== 'Monitoring Value') kv[k] = v;
            }
        }
        // Tabel monitoring dikenali dari adanya key AC, Ambient, atau Elapsed Time
        const hasMonitoring = kv['AC'] !== undefined
                           || kv['Ambient Temperature (\u00b0C)'] !== undefined
                           || kv['Elapsed Time Indication'] !== undefined;
        if (hasMonitoring) {
            result.ac            = kv['AC'] || '—';
            result.dc            = kv['DC'] || '—';
            result.dc_supply_v   = kv['DC Supply (V)'] || '—';
            result.ambient_temp  = kv['Ambient Temperature (\u00b0C)'] || kv['Ambient Temperature (°C)'] || '—';
            result.internal_temp = kv['Internal Temperature (\u00b0C)'] || kv['Internal Temperature (°C)'] || '—';
            result.elapsed_time  = kv['Elapsed Time Indication'] || '—';
            break;
        }
    }
    return result;
}

function parseSysInfo(html) {
    // Mirrors parse_sys_info() in html_parser.py — uses extractValue for input fields
    const result = { model: '—', equipment: '—', serial_number: '—', boot_installed: '—', firmware: '—' };
    if (!html) return result;
    const m = parseGenericKV(html);
    result.model          = m['Model']          || '—';
    result.equipment      = m['Equipment']      || '—';
    result.serial_number  = m['Serial Number']  || '—';
    result.boot_installed = m['Boot Installed'] || '—';
    // Firmware can be 'Firmware Installed' or 'Firmware' etc.
    const fwKey = Object.keys(m).find(k => k.includes('Firmware'));
    result.firmware = m['Firmware Installed'] || m['Firmware'] || (Object.keys(m).find(k => k.includes('Firmware')) ? m[Object.keys(m).find(k => k.includes('Firmware'))] : '—');
    return result;
}

function parseGenericTable(html) {
    const rows = [];
    if (!html) return rows;
    const tables = parseTables(html);
    tables.forEach(t => t.forEach(r => {
        if (r[0] && r[0] !== 'Setting Name' && r[0] !== 'Parameter') {
            rows.push([r[0], r[1] || '—']);
        }
    }));
    return rows;
}

function parseSnmpInfo(html) {
    // Mirrors parse_snmp_info() — input type=text fields need extractValue
    const result = { name: '', location: '', description: '' };
    if (!html) return result;
    const m = parseGenericKV(html);
    result.name        = m['Name']        || '';
    result.location    = m['Location']    || '';
    result.description = m['Description'] || '';
    return result;
}
// Generic key-value collector — mirrors parse_generic_table() in html_parser.py
function parseGenericKV(html) {
    if (!html) return {};
    const m = {};
    const tables = parseTables(html);
    tables.forEach(t => t.forEach(r => {
        const key = r[0] ? r[0].trim() : null;
        if (key && key !== 'Setting Name' && key !== 'Parameter') {
            m[key] = (r[1] || '—').trim();
        }
    }));
    return m;
}




function parseAmvRxs(html) {
    // Gunakan generic table approach (sama seperti aplikasi Python yang sudah berhasil)
    // Tidak hardcode field name — tampilkan semua row apa adanya dari device
    return parseGenericTable(html);
}

function parseAmvTxs(html) {
    // Gunakan generic table approach untuk TX juga
    return parseGenericTable(html);
}


function parseBitEsc(html) {
    // BIT_ESC: Setting Name | Value (radio Normal/Escalated) | Update button
    // Kolom ke-2 (index 1) adalah nilai status, bukan kolom terakhir (yang berisi "Update")
    // extractValue sudah handle radio button — tapi kalau tidak ada 'checked', fallback ambil teks radio
    if (!html) return [];
    const rows = [];
    // Parse langsung dari HTML — setiap row: <td>Setting Name</td><td>radio buttons</td><td>Update btn</td>
    const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let rm;
    while ((rm = rowRe.exec(html)) !== null) {
        const tds = [...rm[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)];
        if (tds.length < 2) continue;
        const param = stripTags(tds[0][1]).trim();
        if (!param || param === 'Setting Name' || param === 'Parameter') continue;

        const valCell = tds[1][1]; // kolom ke-2 adalah value

        // Radio button: cari label dari option yang checked
        // Format: <input type="radio" checked> Normal <input type="radio"> Escalated
        let val = '—';
        const radioChecked = valCell.match(/<input[^>]+type=['"']radio['"'][^>]*checked[^>]*>\s*([^<]+)/i)
                          || valCell.match(/<input[^>]*checked[^>]*type=['"']radio['"'][^>]*>\s*([^<]+)/i);
        if (radioChecked) {
            val = radioChecked[1].trim();
        } else {
            // Tidak ada checked — ambil semua text dari radio labels
            const allRadioLabels = valCell.match(/(?:<input[^>]+type=['"']radio['"'][^>]*>)\s*([^<]+)/gi);
            if (allRadioLabels && allRadioLabels.length > 0) {
                // Default: ambil label pertama (biasanya "Normal")
                const firstLabel = allRadioLabels[0].replace(/<[^>]*>/g, '').trim();
                val = firstLabel || 'Normal';
            } else {
                val = stripTags(valCell).replace(/Update/gi, '').trim() || '—';
            }
        }
        rows.push([param, val]);
    }
    return rows;
}



// ── Decode WebSocket message ──────────────────────────────────────────────────

function decodeMessage(data) {
    const results = [];
    const parts = data.split(CMD_RSP);
    for (const part of parts) {
        const full = CMD_RSP + part;
        if (!full.startsWith(CMD_RSP)) continue;
        const typeStr = full.slice(8, 13);
        // Accept both TABLE (initial fetch) and UPDTE (poll cycle) responses
        if (typeStr === CMD_TABLE || typeStr === 'UPDTE') {
            const pane_id = full.slice(14, 21).trim();
            const html    = full.length > 22 ? full.slice(22) : '';
            results.push({ pane_id, html });
        }
    }
    return results;
}

// ── Parser class ──────────────────────────────────────────────────────────────

class VhfT6tvParser extends BaseParser {
    constructor(opts = {}) {
        super(opts);
        this._state = {
            connected: false,
            bit_status: null,
            sys_info: null,
            radio_rows: [],    // RADIO_C  — generic rows [[key,val], ...]
            snmp_name: '',
            snmp_location: '',
            amv_txs_rows: [],  // AMV_TXS  — generic rows (sama seperti Python app)
            amv_rxs_rows: [],  // AMV_RXS  — generic rows (sama seperti Python app)
            bit_esc_rows: [],  // BIT_ESC  — generic rows
        };
    }

    /**
     * parse() is called by NetworkListener with raw WebSocket message text.
     * For T6TV, rawData is a string (WebSocket text frame).
     */
    parse(rawData) {
        try {
            const data = Buffer.isBuffer(rawData) ? rawData.toString('utf8') : String(rawData);

            const messages = decodeMessage(data);
            if (messages.length === 0) {
                return { success: false, error: 'No valid T6TV message', status: 'Waiting' };
            }

            for (const { pane_id, html } of messages) {
                if (pane_id === 'BIT_STS') {
                    this._state.bit_status = parseBitStatus(html);
                } else if (pane_id === 'SYS_SET') {
                    this._state.sys_info = parseSysInfo(html);
                } else if (pane_id === 'RADIO_C') {
                    this._state.radio_rows = parseGenericTable(html);
                } else if (pane_id === 'S_N_M_P') {
                    const snmp = parseSnmpInfo(html);
                    if (snmp.name) this._state.snmp_name = snmp.name;
                    if (snmp.location) this._state.snmp_location = snmp.location;
                } else if (pane_id === 'AMV_TXS') {
                    this._state.amv_txs_rows = parseAmvTxs(html);
                } else if (pane_id === 'AMV_RXS') {
                    this._state.amv_rxs_rows = parseAmvRxs(html);
                } else if (pane_id === 'BIT_ESC') {
                    this._state.bit_esc_rows = parseBitEsc(html);
                } else {
                    console.log(`[T6TV DEBUG] UNHANDLED PANE: ${pane_id} snippet: ${html.slice(0,300)}`);
                }
            }

            const bs  = this._state.bit_status;

            // Cek apakah ada data dari pane manapun
            const hasAnyData = bs || this._state.amv_rxs_rows.length > 0 ||
                               this._state.bit_esc_rows.length > 0 || this._state.sys_info;
            if (!hasAnyData) {
                return { success: false, error: 'Waiting for data', status: 'Waiting' };
            }

            // Status dari BIT_STS
            let isFullService = true;
            let isReduced     = false;
            if (bs) {
                isFullService = bs.overall_status.includes('Full Service');
                isReduced     = bs.overall_status.includes('Reduced');
            }
            const status = isFullService ? 'Normal' : isReduced ? 'Warning' : 'Alarm';

            // Channel dari RADIO_C
            const channelRow = this._state.radio_rows.find(r => r[0] === 'Channel');
            const channel = channelRow ? channelRow[1] : '—';

            // Helper: cari nilai dari rows berdasarkan keyword (case-insensitive)
            const findVal = (rows, ...keywords) => {
                for (const [k, v] of rows) {
                    const kl = k.toLowerCase();
                    if (keywords.some(kw => kl.includes(kw.toLowerCase()))) return v;
                }
                return '—';
            };

            const txRows  = this._state.amv_txs_rows;
            const rxRows  = this._state.amv_rxs_rows;
            const escRows = this._state.bit_esc_rows;

            // Ambil nilai dari rows — prioritas BIT_ESC untuk live measurement
            const flat = {
                // ── SERVICE STATUS ─────────────────────────────────────────
                overall_status:  bs ? bs.overall_status : '—',
                ac_power:        bs ? bs.ac             : '—',
                dc_power:        bs ? bs.dc             : '—',
                dc_supply_v:     bs ? bs.dc_supply_v    : '—',
                ambient_temp:    bs ? bs.ambient_temp   : '—',
                internal_temp:   bs ? bs.internal_temp  : '—',
                elapsed_time:    bs ? bs.elapsed_time   : '—',
                status_messages: bs ? (bs.status_messages || []).join(' | ') : '—',

                // ── RADIO CONFIG ───────────────────────────────────────────
                channel,

                // ── TX MEASUREMENTS (BIT_ESC → AMV_TXS fallback) ──────────
                fwd_power:  findVal(escRows, 'forward power') !== '—' ? findVal(escRows, 'forward power') : findVal(txRows, 'forward power'),
                refl_power: findVal(escRows, 'reflected power') !== '—' ? findVal(escRows, 'reflected power') : findVal(txRows, 'reflected power'),
                tx_level:   findVal(escRows, 'tx level', 'transmit level') !== '—' ? findVal(escRows, 'tx level', 'transmit level') : findVal(txRows, 'audio line in', 'tx level'),
                mod_level:  findVal(escRows, 'modulation') !== '—' ? findVal(escRows, 'modulation') : findVal(txRows, 'modulation depth'),

                // ── TX SETTINGS (AMV_TXS) ──────────────────────────────────
                rf_power_watts:   findVal(txRows, 'rf power'),
                modulation_depth: findVal(txRows, 'modulation depth'),
                ptt_state:        findVal(txRows, 'ptt'),
                alc_enabled:      findVal(txRows, 'alc'),
                audio_line_in:    findVal(txRows, 'audio line in'),
                tx_timeout:       findVal(txRows, 'transmit timeout', 'tx timeout'),
                tone_keying_freq: findVal(txRows, 'tone keying'),

                // ── RX MEASUREMENTS (BIT_ESC → AMV_RXS fallback) ──────────
                rx_level:     findVal(escRows, 'rx level', 'receive level', 'signal level') !== '—' ? findVal(escRows, 'rx level', 'receive level', 'signal level') : findVal(rxRows, 'rx level', 'receive level', 'signal level'),
                squelch_level:findVal(escRows, 'squelch level', 'squelch threshold') !== '—' ? findVal(escRows, 'squelch level', 'squelch threshold') : findVal(rxRows, 'squelch level', 'squelch threshold'),
                sinad:        findVal(escRows, 'sinad') !== '—' ? findVal(escRows, 'sinad') : findVal(rxRows, 'sinad'),
                audio_level:  findVal(escRows, 'audio level', 'af level') !== '—' ? findVal(escRows, 'audio level', 'af level') : findVal(rxRows, 'audio level', 'af level'),
                rx_freq:      findVal(rxRows, 'rx frequency', 'frequency'),
                squelch_state:findVal(rxRows, 'squelch'),

                // ── SYSTEM INFO ────────────────────────────────────────────
                snmp_name:      this._state.snmp_name,
                model:          this._state.sys_info ? this._state.sys_info.model          : '—',
                serial_number:  this._state.sys_info ? this._state.sys_info.serial_number  : '—',
                firmware:       this._state.sys_info ? this._state.sys_info.firmware       : '—',
                equipment:      this._state.sys_info ? this._state.sys_info.equipment      : '—',
                boot_installed: this._state.sys_info ? this._state.sys_info.boot_installed : '—',

                // ── RAW ROWS (untuk frontend tabel generik) ────────────────
                _amv_txs_rows: txRows,
                _amv_rxs_rows: rxRows,
                _bit_esc_rows: escRows,
                _radio_rows:   this._state.radio_rows,
            };

            const alarms = status !== 'Normal' ? [bs ? bs.overall_status : 'Abnormal Status'] : [];

            return {
                success: true,
                data: flat,
                status,
                alarms,
                warnings: [],
                triggeredParams: alarms,
                timestamp: new Date().toISOString()
            };

        } catch (error) {
            console.error(`[VHF T6TV] Parse error: ${error.message}`);
            return { success: false, error: error.message, status: 'Error', timestamp: new Date().toISOString() };
        }
    }
}

module.exports = VhfT6tvParser;
