#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const http = require('http');
const net = require('net');
const VhfT6tvParser = require('../src/parsers/vhf_t6tv');

const DEFAULT_PANES = ['BIT_STS', 'SYS_SET', 'RADIO_C', 'BIT_ESC', 'AMV_TXS', 'AMV_RXS', 'S_N_M_P'];

function usage() {
  console.log(`Usage:
  node tools/check-pae-t6tv.js [options]

Options:
  --host <ip>          PAE/Park Air T6 IP address. Default: 192.168.210.130
  --port <number>      HTTP/WebSocket port. Default: 80
  --username <text>    Web username. Default: admin
  --password <text>    Web password. Default: admin
  --path <text>        WebSocket path. Default: /ws
  --seconds <number>   How long to listen. Default: 20
  --json               Print full parsed JSON on every update.
  --raw                Print raw WebSocket frame snippets.
  --help               Show this help.

Example:
  node tools/check-pae-t6tv.js --host 192.168.210.130 --port 80 --username admin --password admin
`);
}

function parseArgs(argv) {
  const opts = {
    host: '192.168.210.130',
    port: 80,
    username: 'admin',
    password: 'admin',
    path: '/ws',
    seconds: 20,
    json: false,
    raw: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];

    if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--host') opts.host = String(next() || opts.host);
    else if (arg === '--port') opts.port = parseInt(next(), 10) || opts.port;
    else if (arg === '--username') opts.username = String(next() || opts.username);
    else if (arg === '--password') opts.password = String(next() || opts.password);
    else if (arg === '--path') opts.path = String(next() || opts.path);
    else if (arg === '--seconds') opts.seconds = parseInt(next(), 10) || opts.seconds;
    else if (arg === '--json') opts.json = true;
    else if (arg === '--raw') opts.raw = true;
  }

  return opts;
}

function md5(text) {
  return crypto.createHash('md5').update(text).digest('hex');
}

function parseDigestHeader(wwwAuthenticate) {
  const header = String(wwwAuthenticate || '');
  if (!/^Digest\s/i.test(header)) return null;

  const params = {};
  const re = /(\w+)=(?:"([^"]*)"|([^,\s]+))/g;
  let match;
  while ((match = re.exec(header)) !== null) {
    params[match[1]] = match[2] !== undefined ? match[2] : match[3];
  }

  if (!params.realm || !params.nonce) return null;
  return params;
}

function getDigestParams(host, port) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host, port, path: '/', method: 'GET', timeout: 5000 }, (res) => {
      const params = parseDigestHeader(res.headers['www-authenticate']);
      res.resume();
      if (!params) {
        reject(new Error(`No Digest challenge returned. HTTP status=${res.statusCode || 'unknown'}`));
      } else {
        resolve(params);
      }
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Timeout fetching Digest challenge'));
    });
    req.end();
  });
}

function buildDigestHeader(opts, digestParams) {
  const realm = digestParams.realm;
  const nonce = digestParams.nonce;
  const uri = opts.path || '/ws';
  const qop = digestParams.qop || 'auth';
  const nc = '00000001';
  const cnonce = crypto.randomBytes(8).toString('hex');
  const ha1 = md5(`${opts.username}:${realm}:${opts.password}`);
  const ha2 = md5(`GET:${uri}`);
  const response = md5(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`);

  return `Digest username="${opts.username}", realm="${realm}", nonce="${nonce}", uri="${uri}", qop=${qop}, nc=${nc}, cnonce="${cnonce}", response="${response}"`;
}

function encodeWsFrame(text, opcode = 0x1) {
  const payload = Buffer.from(text, 'utf8');
  const mask = crypto.randomBytes(4);
  let header;

  if (payload.length < 126) {
    header = Buffer.from([0x80 | opcode, 0x80 | payload.length]);
  } else if (payload.length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    throw new Error('Payload too large for this test script');
  }

  const masked = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i++) {
    masked[i] = payload[i] ^ mask[i % 4];
  }

  return Buffer.concat([header, mask, masked]);
}

function decodeAvailableFrames(buffer) {
  const frames = [];
  let offset = 0;

  while (offset + 2 <= buffer.length) {
    const first = buffer[offset];
    const second = buffer[offset + 1];
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let headerLength = 2;

    if (length === 126) {
      if (offset + 4 > buffer.length) break;
      length = buffer.readUInt16BE(offset + 2);
      headerLength = 4;
    } else if (length === 127) {
      if (offset + 10 > buffer.length) break;
      const high = buffer.readUInt32BE(offset + 2);
      const low = buffer.readUInt32BE(offset + 6);
      if (high !== 0) throw new Error('Frame too large for this test script');
      length = low;
      headerLength = 10;
    }

    const maskLength = masked ? 4 : 0;
    const frameLength = headerLength + maskLength + length;
    if (offset + frameLength > buffer.length) break;

    let payload = buffer.slice(offset + headerLength + maskLength, offset + frameLength);
    if (masked) {
      const mask = buffer.slice(offset + headerLength, offset + headerLength + 4);
      const unmasked = Buffer.alloc(payload.length);
      for (let i = 0; i < payload.length; i++) {
        unmasked[i] = payload[i] ^ mask[i % 4];
      }
      payload = unmasked;
    }

    frames.push({ opcode, payload });
    offset += frameLength;
  }

  return { frames, rest: buffer.slice(offset) };
}

function paneFromMessage(text) {
  const match = String(text || '').match(/^#\+RSP\+#\s*(?:TABLE|UPDTE)\s+([A-Z_]+)/);
  return match ? match[1] : 'unknown';
}

function printParsed(result, opts) {
  if (!result || !result.success) return;

  if (opts.json) {
    console.log('[PARSED]', JSON.stringify(result, null, 2));
    return;
  }

  const data = result.data || {};
  const summary = {
    status: result.status,
    overall_status: data.overall_status,
    channel: data.channel,
    fwd_power: data.fwd_power,
    refl_power: data.refl_power,
    mod_level: data.mod_level,
    rx_level: data.rx_level,
    squelch_level: data.squelch_level,
    ambient_temp: data.ambient_temp,
    internal_temp: data.internal_temp,
    model: data.model,
    serial_number: data.serial_number,
  };
  console.log('[PARSED]', JSON.stringify(summary));
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    usage();
    return;
  }

  console.log(`PAE T6 WebSocket check: ${opts.host}:${opts.port}${opts.path}`);
  const digestParams = await getDigestParams(opts.host, opts.port);
  console.log(`Digest challenge: realm="${digestParams.realm}" qop="${digestParams.qop || 'auth'}" nonce="${digestParams.nonce}"`);

  const key = crypto.randomBytes(16).toString('base64');
  const authorization = buildDigestHeader(opts, digestParams);
  const socket = net.createConnection({ host: opts.host, port: opts.port });
  const parser = new VhfT6tvParser({});
  let handshakeBuffer = Buffer.alloc(0);
  let frameBuffer = Buffer.alloc(0);
  let handshaken = false;
  let messageCount = 0;
  let lastParsed = null;

  socket.setTimeout((opts.seconds + 5) * 1000);

  socket.on('connect', () => {
    const request = [
      `GET ${opts.path} HTTP/1.1`,
      `Host: ${opts.host}`,
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Key: ${key}`,
      'Sec-WebSocket-Version: 13',
      `Origin: http://${opts.host}`,
      `Authorization: ${authorization}`,
      '\r\n',
    ].join('\r\n');
    socket.write(request);
  });

  socket.on('data', (chunk) => {
    if (!handshaken) {
      handshakeBuffer = Buffer.concat([handshakeBuffer, chunk]);
      const headerEnd = handshakeBuffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;

      const headerText = handshakeBuffer.slice(0, headerEnd).toString('latin1');
      const statusLine = headerText.split('\r\n')[0] || '';
      console.log(`WebSocket handshake: ${statusLine}`);

      if (!/^HTTP\/1\.[01]\s+101\s/i.test(statusLine)) {
        console.log(headerText);
        socket.end();
        return;
      }

      handshaken = true;
      frameBuffer = handshakeBuffer.slice(headerEnd + 4);

      DEFAULT_PANES.forEach((pane, index) => {
        setTimeout(() => {
          const command = `#+GET+# TABLE ${pane}`;
          console.log(`[SEND] ${command}`);
          socket.write(encodeWsFrame(command));
        }, index * 300);
      });
    } else {
      frameBuffer = Buffer.concat([frameBuffer, chunk]);
    }

    const decoded = decodeAvailableFrames(frameBuffer);
    frameBuffer = decoded.rest;
    for (const frame of decoded.frames) {
      if (frame.opcode === 0x8) {
        console.log('[WS] close frame received');
        socket.end();
        return;
      }
      if (frame.opcode === 0x9) {
        socket.write(encodeWsFrame(frame.payload, 0xA));
        continue;
      }
      if (frame.opcode !== 0x1) continue;

      const text = frame.payload.toString('utf8');
      messageCount++;
      const pane = paneFromMessage(text);
      console.log(`[RECV] pane=${pane} bytes=${frame.payload.length}`);
      if (opts.raw) {
        console.log(text.slice(0, 1200));
      }
      const parsed = parser.parse(text);
      if (parsed && parsed.success) {
        lastParsed = parsed;
        printParsed(parsed, opts);
      }
    }
  });

  socket.on('error', (err) => {
    console.error(`Socket error: ${err.message}`);
  });

  socket.on('timeout', () => {
    console.error('Socket timeout');
    socket.destroy();
  });

  await new Promise((resolve) => setTimeout(resolve, opts.seconds * 1000));
  socket.end();
  console.log(`Done. WebSocket messages received: ${messageCount}`);
  if (lastParsed && !opts.json) {
    console.log('Last parsed data keys:', Object.keys(lastParsed.data || {}).join(', '));
  }
}

main().catch((err) => {
  console.error(`ERROR: ${err.message || err}`);
  process.exit(1);
});
