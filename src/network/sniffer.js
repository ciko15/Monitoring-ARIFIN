// Network Packet Sniffer
// Captures and processes real network packets

const { spawn, exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);
const networkMonitor = require('./monitor');

class PacketSniffer {
  constructor() {
    this.isActive = false;
    this.packets = [];
    this.captureInterval = null;
    this.captureMode = 'unknown';
    this.tcpdumpProcess = null;
    this.tcpdumpAvailable = null;
    this.tsharkProcess = null;
    this.tsharkAvailable = null;
    this.packetCounter = 0;
    this.currentInterface = null;
    this.lastError = null;
  }

  async isTcpdumpAvailable() {
    if (this.tcpdumpAvailable !== null) return this.tcpdumpAvailable;
    try {
      const { stdout } = await execPromise('command -v tcpdump');
      this.tcpdumpAvailable = !!stdout.trim();
    } catch (error) {
      this.tcpdumpAvailable = false;
    }
    return this.tcpdumpAvailable;
  }

  async isTsharkAvailable() {
    if (this.tsharkAvailable !== null) return this.tsharkAvailable;
    try {
      const { stdout } = await execPromise('command -v tshark');
      this.tsharkAvailable = !!stdout.trim();
    } catch (error) {
      this.tsharkAvailable = false;
    }
    return this.tsharkAvailable;
  }

  async start(interfaceName = null) {
    if (this.isActive) return;

    this.isActive = true;
    this.packets = [];
    this.packetCounter = 0;
    
    // Choose a better default than 'any' for macOS
    if ((!interfaceName || interfaceName === 'any' || interfaceName === '') && process.platform === 'darwin') {
      this.currentInterface = 'en0'; // Primary choice for Mac
    } else {
      this.currentInterface = interfaceName || 'en0'; // Fallback to en0 if nothing provided
    }
    
    console.log(`[Packet Sniffer] Using interface: ${this.currentInterface}`);
    this.lastError = null;

    // Prioritize real tools (tshark/tcpdump) if available
    const tsharkAvailable = await this.isTsharkAvailable();
    const tcpdumpAvailable = await this.isTcpdumpAvailable();

    const isMac = process.platform === 'darwin';
    
    // On Mac, tcpdump is much more reliable for real-time streaming than tshark json formats
    if (isMac && tcpdumpAvailable) {
      console.log(`[Packet Sniffer] Starting real capture using Tcpdump on ${this.currentInterface} (Reliable Mac Mode)`);
      this.captureMode = 'tcpdump';
      this.startTcpdumpCapture(this.currentInterface);
    } else if (tsharkAvailable) {
      console.log(`[Packet Sniffer] Starting real capture using Tshark on ${this.currentInterface}`);
      this.captureMode = 'tshark';
      this.startTsharkCapture(this.currentInterface);
    } else if (tcpdumpAvailable) {
      console.log(`[Packet Sniffer] Starting real capture using Tcpdump on ${this.currentInterface}`);
      this.captureMode = 'tcpdump';
      this.startTcpdumpCapture(this.currentInterface);
    } else {
      const msg = `No capture tools found (tshark/tcpdump). Please install Wireshark or tcpdump.`;
      console.error(`[Packet Sniffer] ${msg}`);
      this.lastError = msg;
      this.captureMode = 'none';
      this.isActive = false;
    }
  }

  startTcpdumpCapture(interfaceName) {
    try {
      // -x for hex, -s 96 for a small slice of data (enough for headers + some payload)
      // -l for line-buffered, -n for no DNS lookups, -U for unbuffered
      const args = ['-U', '-l', '-n', '-i', interfaceName, '-x', '-s', '256'];
      const tcpdumpPath = process.platform === 'darwin' ? '/usr/sbin/tcpdump' : 'tcpdump';
      console.log(`[Packet Sniffer] Spawning: ${tcpdumpPath} ${args.join(' ')}`);
      this.tcpdumpProcess = spawn(tcpdumpPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });

      let buffer = '';
      this.tcpdumpProcess.stdout.setEncoding('utf8');

      this.tcpdumpProcess.stdout.on('data', chunk => {
        buffer += chunk;
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
          if (!line.trim()) continue;
          
          if (/^\d{2}:\d{2}:\d{2}\.\d+/.test(line)) {
            // New packet header
            if (this.pendingPacket) {
                this.finalizePacket(this.pendingPacket);
            }
            this.pendingPacket = this.parseTcpdumpLine(line, interfaceName);
          } else if (this.pendingPacket && /^\s*(0x)?[0-9a-fA-F]{4}:/.test(line)) {
            // Hex data line (usually starts with tab or spaces)
            const cleanedLine = line.trim();
            const hexMatch = cleanedLine.match(/^(?:0x)?[0-9a-fA-F]{4}:\s+(.*)$/);
            if (hexMatch) {
                // Remove spaces and any trailing ASCII (in case -X was used instead of -x)
                // We take only the hex part - usually grouped in 4-character blocks
                const hexPart = hexMatch[1].split('  ')[0]; // Split from ASCII part if present
                const hexData = hexPart.replace(/\s+/g, '');
                this.pendingPacket.rawData += hexData;
            }
          }
        }
      });

      this.tcpdumpProcess.stderr.setEncoding('utf8');
      this.tcpdumpProcess.stderr.on('data', data => {
        const msg = data.toString().trim();
        console.log('[Packet Sniffer] tcpdump stderr:', msg);
        
        // Distinguish between info/preamble and actual errors
        const isPreamble = msg.includes('verbose output suppressed') || 
                          msg.includes('listening on') || 
                          msg.includes('packets captured') ||
                          msg.includes('packets received by filter');
        
        if (isPreamble) {
            // Log as info, don't set as the "lastError" used for UI warnings
            return;
        }

        if (!this.lastError) {
          this.lastError = msg;
        } else if (!this.lastError.includes(msg)) {
          this.lastError += '\n' + msg;
        }
      });

      this.tcpdumpProcess.on('close', code => {
        console.log('[Packet Sniffer] tcpdump exited with code', code);
        this.tcpdumpProcess = null;
        this.isActive = false;
      });

      this.tcpdumpProcess.on('error', error => {
        console.error('[Packet Sniffer] tcpdump error:', error.message);
        this.lastError = `Process error: ${error.message}`;
        this.tcpdumpProcess = null;
        this.isActive = false;
      });
    } catch (error) {
      console.error('[Packet Sniffer] Failed to start tcpdump:', error);
      this.lastError = `Catch error: ${error.message}`;
      this.isActive = false;
    }
  }

  finalizePacket(packet) {
      if (packet) {
          this.packets.push(packet);
          if (this.packets.length > 2500) {
              this.packets.shift();
          }
      }
      this.pendingPacket = null;
  }

  parseTcpdumpLine(line, interfaceName) {
    try {
      const now = Date.now() / 1000;
      const packet = {
        number: ++this.packetCounter,
        time: now,
        interface: interfaceName || 'any',
        source: 'unknown',
        destination: 'unknown',
        protocol: 'UNKNOWN',
        length: 0,
        info: line.trim(),
        direction: 'in',
        rawData: ''
      };

      // Helper function to format IP and Port
      function formatIpPort(address) {
          if (!address) return address;
          const parts = address.split('.');
          if (parts.length > 4 && !address.includes(':')) {
              // Extract the port (last segment)
              const port = parts.pop();
              const ip = parts.join('.');
              return `${ip}:${port}`;
          }
          return address;
      }

      // More flexible regex to handle various tcpdump outputs (IP or hostname)
      const match = line.match(/^(\d{2}:\d{2}:\d{2}\.\d+)\s+(\S+)\s+(.+?)\s+>\s+(.+?):\s*(.*)$/);
      if (match) {
        packet.protocol = match[2];
        packet.source = formatIpPort(match[3]);
        packet.destination = formatIpPort(match[4]);
        packet.info = match[5];
      } else {
          // Fallback regex for simpler formats (like ARP)
          const simpleMatch = line.match(/^(\d{2}:\d{2}:\d{2}\.\d+)\s+(.*)$/);
          if (simpleMatch) {
              const info = simpleMatch[2];
              packet.info = info;
              
              // Guess protocol from info string
              if (info.includes('ARP')) packet.protocol = 'ARP';
              else if (info.includes('ICMP')) packet.protocol = 'ICMP';
              else if (info.includes('IGMP')) packet.protocol = 'IGMP';
              
              // Try to extract source/destination for ARP
              if (info.includes('ARP')) {
                  const arpMatch = info.match(/(Request who-has|Reply)\s+([0-9.]+)/);
                  if (arpMatch) {
                      packet.source = arpMatch[2];
                      packet.destination = info.includes('tell') ? info.split('tell')[1].trim().split(',')[0] : 'broadcast';
                  }
              }
          }
      }

      const lengthMatch = line.match(/length\s+(\d+)/);
      if (lengthMatch) {
        packet.length = parseInt(lengthMatch[1], 10);
      }

      if (packet.protocol) {
        packet.protocol = packet.protocol.toUpperCase();
      }

      return packet;
    } catch (error) {
      console.error('[Packet Sniffer] Parse line error:', error);
      return null;
    }
  }

  stopTcpdump() {
    if (this.tcpdumpProcess) {
      this.tcpdumpProcess.kill('SIGINT');
      this.tcpdumpProcess = null;
    }
  }

  startTsharkCapture(interfaceName) {
    try {
      // Reverting to Tab-separated fields for Tshark as it's more lightweight if working
      const args = ['-l', '-n', '-i', interfaceName, '-T', 'fields', 
                    '-e', 'frame.number', '-e', 'frame.time_relative', 
                    '-e', '_ws.col.Protocol', '-e', 'ip.src', '-e', 'ip.dst', 
                    '-e', 'frame.len', '-e', 'frame.info'];
      console.log(`[Packet Sniffer] Spawning Tshark: tshark ${args.join(' ')}`);
      this.tsharkProcess = spawn('tshark', args, { stdio: ['ignore', 'pipe', 'pipe'] });

      let buffer = '';
      this.tsharkProcess.stdout.setEncoding('utf8');

      this.tsharkProcess.stdout.on('data', chunk => {
        buffer += chunk;
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
          if (!line.trim()) continue;
          const packet = this.parseTsharkLine(line, interfaceName);
          if (packet) {
            this.packets.push(packet);
            if (this.packets.length > 1000) this.packets.shift();
          }
        }
      });

      this.tsharkProcess.stderr.setEncoding('utf8');
      this.tsharkProcess.stderr.on('data', data => {
        const errorMsg = data.toString().trim();
        console.warn('[Packet Sniffer] tshark stderr:', errorMsg);
        
        // Filter out informational messages that aren't real errors
        const isInfo = errorMsg.includes('Capturing on') || 
                      errorMsg.match(/^\d+ packets captured$/i) ||
                      errorMsg.includes('Packets captured:');
        
        if (!isInfo) {
          if (!this.lastError) {
            this.lastError = errorMsg;
          } else if (!this.lastError.includes(errorMsg)) {
            this.lastError += '\n' + errorMsg;
          }
        }
      });

      this.tsharkProcess.on('close', code => {
        console.log('[Packet Sniffer] tshark exited with code', code);
        this.tsharkProcess = null;
        this.isActive = false;
      });

      this.tsharkProcess.on('error', error => {
        console.error('[Packet Sniffer] tshark error:', error.message);
        this.tsharkProcess = null;
        this.isActive = false;
      });
    } catch (error) {
      console.error('[Packet Sniffer] Failed to start tshark:', error);
      this.isActive = false;
    }
  }

  stopTshark() {
    if (this.tsharkProcess) {
      this.tsharkProcess.kill('SIGINT');
      this.tsharkProcess = null;
    }
  }

  parseTsharkLine(line, interfaceName) {
    const fields = line.split('\t');
    if (fields.length < 5) return null;

    const packet = {
      number: parseInt(fields[0], 10) || ++this.packetCounter,
      time: parseFloat(fields[1]) || Date.now() / 1000,
      interface: interfaceName || 'any',
      protocol: (fields[2] || 'UNKNOWN').toUpperCase(),
      source: fields[3] || 'unknown',
      destination: fields[4] || 'unknown',
      length: parseInt(fields[5], 10) || 0,
      info: fields[6] || line,
      direction: 'in'
    };

    return packet;
  }

  stop() {
    if (!this.isActive) return;

    // Finalize any pending packet before stopping
    if (this.pendingPacket) {
        this.finalizePacket(this.pendingPacket);
    }
    
    this.isActive = false;

    this.stopTcpdump();
    this.stopTshark();

    networkMonitor.stopCapturing();
    console.log('[Packet Sniffer] Stopped - total packets:', this.packets.length);
  }

  getPackets(filter = {}) {
    let result = [...this.packets];

    if (filter.protocol) {
      result = result.filter(p => p.protocol === filter.protocol);
    }

    if (filter.source) {
      result = result.filter(p => p.source.includes(filter.source));
    }

    if (filter.destination) {
      result = result.filter(p => p.destination.includes(filter.destination));
    }

    if (filter.interface) {
      result = result.filter(p => p.interface === filter.interface);
    }

    return result.slice(-2000);
  }

  getStatistics() {
    const stats = {
      totalPackets: this.packets.length,
      isCapturing: this.isActive,
      protocolDistribution: {},
      interfaceDistribution: {},
      bytesTransferred: 0
    };

    for (const packet of this.packets) {
      stats.protocolDistribution[packet.protocol] = (stats.protocolDistribution[packet.protocol] || 0) + 1;
      stats.interfaceDistribution[packet.interface] = (stats.interfaceDistribution[packet.interface] || 0) + 1;
      stats.bytesTransferred += packet.length;
    }

    stats.captureMode = this.captureMode;
    stats.lastError = this.lastError;
    return stats;
  }

  clear() {
    this.packets = [];
    console.log('[Packet Sniffer] Packets cleared');
  }

  export(format = 'json') {
    if (format === 'json') {
      return {
        timestamp: new Date().toISOString(),
        totalPackets: this.packets.length,
        isCapturing: this.isActive,
        packets: this.packets
      };
    }

    let csv = 'No.,Time,Interface,Source,Destination,Protocol,Length,Direction,Info\n';
    for (const packet of this.packets) {
      csv += `${packet.number},${packet.time},${packet.interface},${packet.source},${packet.destination},${packet.protocol},${packet.length},${packet.direction},${packet.info}\n`;
    }
    return csv;
  }

  getPacketDetails(packetNumber) {
    const packet = this.packets.find(p => p.number === packetNumber);
    if (!packet) return null;

    return {
      ...packet,
      details: {
        frame: {
          number: packet.number,
          time: new Date(packet.time * 1000).toISOString(),
          length: packet.length,
          interface: packet.interface
        },
        network: {
          sourceIP: packet.source,
          destinationIP: packet.destination,
          protocol: packet.protocol
        },
        traffic: {
          direction: packet.direction,
          rate: packet.rate?.toFixed(2) + ' KB/s',
          info: packet.info
        }
      }
    };
  }
}

module.exports = new PacketSniffer();
