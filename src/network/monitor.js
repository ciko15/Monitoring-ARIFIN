// Network Monitoring Module
// Uses systeminformation to get real network statistics

const si = require('systeminformation');
const os = require('os');
const fs = require('fs');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

class NetworkMonitor {
  constructor() {
    this.previousNetStats = null;
    this.previousTime = Date.now();
    this.capturedPackets = [];
    this.isCapturing = false;
  }

  /**
   * Get all network interfaces
   */
  async getNetworkInterfaces() {
    try {
      const interfaces = await si.networkInterfaces();
      return interfaces.map(iface => {
        let type = iface.type || 'wired';
        const name = (iface.iface || iface.ifaceName || '').toLowerCase();
        
        // Enhance type detection for macOS and generic linux
        if (name.startsWith('wl') || name.startsWith('wlan') || name.startsWith('en1') || name.startsWith('en2')) {
            type = 'wireless';
        } else if (name.startsWith('eth') || name.startsWith('en0')) {
            type = 'wired';
        }

        return {
          name: iface.ifaceName || iface.iface,
          type: type,
          ip4: iface.ip4,
          ip4subnet: iface.ip4subnet,
          ip6: iface.ip6,
          mac: iface.mac,
          speed: iface.speed,
          duplex: iface.duplex,
          operstate: iface.operstate,
          mtu: iface.mtu
        };
      });
    } catch (error) {
      console.error('[Network Monitor] Error getting interfaces:', error);
      return [];
    }
  }

  /**
   * Get interfaces with real-time stats
   */
  async getInterfacesWithStats() {
    try {
      console.log('[Network Monitor] Getting interfaces with stats...');
      const interfaces = await this.getNetworkInterfaces();
      const stats = await this.getNetworkStats();
      console.log(`[Network Monitor] Found ${interfaces.length} interfaces and ${stats.length} stats entries`);
      
      const result = interfaces.map(iface => {
        // Try to find matching stats using multiple name variants
        const stat = stats.find(s => s.iface === iface.name || s.name === iface.name);
        return {
          ...iface,
          rxRate: stat ? (stat.rxRate || 0) : 0,
          txRate: stat ? (stat.txRate || 0) : 0,
          rxBytes: stat ? (stat.rx_bytes || stat.rxBytes || 0) : 0,
          txBytes: stat ? (stat.tx_bytes || stat.txBytes || 0) : 0
        };
      });
      console.log(`[Network Monitor] Successfully mapped stats for ${result.filter(r => r.rxBytes > 0 || r.rxRate > 0).length} active interfaces`);
      return result;
    } catch (error) {
      console.error('[Network Monitor] Error getting interfaces with stats:', error);
      return [];
    }
  }

  /**
   * Get network statistics
   */
  async getNetworkStats() {
    try {
      const stats = await si.networkStats();
      const currentTime = Date.now();
      const timeDiff = (currentTime - this.previousTime) / 1000; // in seconds

      let networkData = stats.map(stat => {
        let rxRate = 0;
        let txRate = 0;

        // Calculate rates if we have previous data
        if (this.previousNetStats) {
          const prevStat = this.previousNetStats.find(s => s.iface === stat.iface);
          if (prevStat && timeDiff > 0) {
            rxRate = (stat.rx_bytes - prevStat.rx_bytes) / timeDiff / 1024; // KB/s
            txRate = (stat.tx_bytes - prevStat.tx_bytes) / timeDiff / 1024; // KB/s
          }
        }

        return {
          iface: stat.iface, // Consistent internal name
          name: stat.iface,
          interface: stat.iface,
          rxBytes: stat.rx_bytes,
          txBytes: stat.tx_bytes,
          rxPackets: stat.rx_dropped + stat.rx_errors,
          txPackets: stat.tx_dropped + stat.tx_errors,
          rxRate: Math.max(0, rxRate),
          txRate: Math.max(0, txRate),
          rxErrors: stat.rx_errors,
          txErrors: stat.tx_errors,
          rxDropped: stat.rx_dropped,
          txDropped: stat.tx_dropped
        };
      });

      this.previousNetStats = stats;
      this.previousTime = currentTime;

      return networkData;
    } catch (error) {
      console.error('[Network Monitor] Error getting stats:', error);
      return [];
    }
  }

  /**
   * Ping a host
   */
  async pingHost(host, count = 4) {
    try {
      const timeout = process.platform === 'win32' ? '-w 2000' : '-W 2000';
      const countFlag = process.platform === 'win32' ? `-n ${count}` : `-c ${count}`;
      const cmd = `ping ${timeout} ${countFlag} ${host}`;

      const { stdout, stderr } = await execPromise(cmd, { timeout: 15000 });

      // Parse ping output
      const stats = this.parsePingOutput(stdout);

      return {
        host,
        reachable: stats.packets_transmitted > 0 && stats.packets_received > 0,
        packetsTransmitted: stats.packets_transmitted,
        packetsReceived: stats.packets_received,
        packetLoss: stats.packet_loss,
        min: stats.min,
        max: stats.max,
        avg: stats.avg,
        stddev: stats.stddev,
        raw: stdout
      };
    } catch (error) {
      console.error(`[Network Monitor] Ping error for ${host}:`, error.message);
      return {
        host,
        reachable: false,
        error: error.message,
        packetsTransmitted: 0,
        packetsReceived: 0,
        packetLoss: 100
      };
    }
  }

  /**
   * Parse ping command output (macOS/Linux/Windows compatible)
   */
  parsePingOutput(output) {
    const result = {
      packets_transmitted: 0,
      packets_received: 0,
      packet_loss: 100,
      min: null,
      max: null,
      avg: null,
      stddev: null
    };

    try {
      // Try to extract statistics line
      let statsLine = '';
      const lines = output.split('\n');

      // macOS/Linux format
      if (output.includes('packets transmitted')) {
        const match = output.match(/(\d+)\s+packets? transmitted,\s+(\d+)\s+(?:packets? )?received,[\s\S]*?(\d+(?:\.\d+)?%).*\n/);
        if (match) {
          result.packets_transmitted = parseInt(match[1]);
          result.packets_received = parseInt(match[2]);
          result.packet_loss = parseFloat(match[3]);
        }

        // Extract timing stats (min/avg/max/stddev)
        const timeMatch = output.match(/min\/avg\/max(?:\/stddev)?\s*=\s*([\d.]+)\s*\/([\d.]+)\s*\/([\d.]+)(?:\/([\d.]+))?/);
        if (timeMatch) {
          result.min = parseFloat(timeMatch[1]);
          result.avg = parseFloat(timeMatch[2]);
          result.max = parseFloat(timeMatch[3]);
          result.stddev = timeMatch[4] ? parseFloat(timeMatch[4]) : null;
        }
      }
      // Windows format
      else if (output.includes('Packets: Sent')) {
        const match = output.match(/Packets: Sent = (\d+), Received = (\d+), Lost = (\d+)/);
        if (match) {
          result.packets_transmitted = parseInt(match[1]);
          result.packets_received = parseInt(match[2]);
          result.packet_loss = (parseInt(match[3]) / parseInt(match[1])) * 100;
        }

        // Extract timing stats for Windows
        const timeMatch = output.match(/Minimum = ([\d]+)ms, Maximum = ([\d]+)ms, Average = ([\d]+)ms/);
        if (timeMatch) {
          result.min = parseInt(timeMatch[1]);
          result.max = parseInt(timeMatch[2]);
          result.avg = parseInt(timeMatch[3]);
        }
      }
    } catch (error) {
      console.error('[Network Monitor] Parse error:', error);
    }

    return result;
  }

  /**
   * Start capturing network packets (simulated from interface stats)
   */
  async startCapturing(interfaceName = null) {
    this.isCapturing = true;
    this.capturedPackets = [];
    console.log('[Network Monitor] Packet capture started');
  }

  /**
   * Stop capturing packets
   */
  stopCapturing() {
    this.isCapturing = false;
    console.log('[Network Monitor] Packet capture stopped - captured', this.capturedPackets.length, 'packets');
  }

  /**
   * Get captured packets
   */
  getCapturedPackets() {
    return this.capturedPackets;
  }

  /**
   * Add a captured packet to the list
   */
  addCapturedPacket(packet) {
    this.capturedPackets.push(packet);
    // Keep only last 1000 packets
    if (this.capturedPackets.length > 1000) {
      this.capturedPackets.shift();
    }
  }

  /**
   * Simulate network packet from interface traffic
   * Uses real network stats to generate realistic packets
   */
  async generatePacketsFromStats() {
    if (!this.isCapturing) return;

    try {
      const stats = await this.getNetworkStats();

      for (const stat of stats) {
        if (stat.rxRate > 0 || stat.txRate > 0) {
          // Generate packets based on activity
          const packetCount = Math.floor((stat.rxRate + stat.txRate) / 100) + Math.random() * 3;

          for (let i = 0; i < packetCount; i++) {
            const packet = {
              number: this.capturedPackets.length + 1,
              time: Date.now() / 1000,
              interface: stat.interface,
              source: this.generateRandomIP(),
              destination: this.generateRandomIP(),
              protocol: this.getRandomProtocol(),
              length: Math.floor(Math.random() * 1500) + 50,
              info: this.generatePacketInfo(stat),
              direction: Math.random() > 0.5 ? 'in' : 'out',
              rate: Math.random() > 0.5 ? stat.rxRate : stat.txRate
            };

            this.capturedPackets.push(packet);

            // Keep only last 1000 packets
            if (this.capturedPackets.length > 1000) {
              this.capturedPackets.shift();
            }
          }
        }
      }
    } catch (error) {
      console.error('[Network Monitor] Error generating packets:', error);
    }
  }

  /**
   * Generate random IP address
   */
  generateRandomIP() {
    return `${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 256)}`;
  }

  /**
   * Get random protocol
   */
  getRandomProtocol() {
    const protocols = ['TCP', 'UDP', 'ICMP', 'HTTP', 'HTTPS', 'DNS', 'SNMP', 'SSH', 'FTP'];
    return protocols[Math.floor(Math.random() * protocols.length)];
  }

  /**
   * Generate realistic packet info
   */
  generatePacketInfo(stat) {
    const infos = [
      `Data on ${stat.interface}`,
      `${stat.rxRate.toFixed(1)} KB/s RX`,
      `${stat.txRate.toFixed(1)} KB/s TX`,
      `Packets: ${stat.rxPackets}/${stat.txPackets}`,
      'Standard network packet',
      'ACK packet',
      'SYN packet'
    ];
    return infos[Math.floor(Math.random() * infos.length)];
  }

  /**
   * Get system network info
   */
  async getSystemNetworkInfo() {
    try {
      const interfaces = os.networkInterfaces();
      const networkInfo = {
        hostname: os.hostname(),
        platform: os.platform(),
        arch: os.arch(),
        interfaces: []
      };

      for (const [name, addrs] of Object.entries(interfaces)) {
        const iface = {
          name,
          addresses: []
        };

        for (const addr of addrs) {
          iface.addresses.push({
            family: addr.family,
            address: addr.address,
            netmask: addr.netmask,
            mac: addr.mac,
            internal: addr.internal
          });
        }

        networkInfo.interfaces.push(iface);
      }

      return networkInfo;
    } catch (error) {
      console.error('[Network Monitor] Error getting system info:', error);
      return {};
    }
  }

  /**
   * Test network connectivity
   */
  async testConnectivity(hosts = ['8.8.8.8', '1.1.1.1', 'google.com']) {
    const results = [];

    for (const host of hosts) {
      const result = await this.pingHost(host, 2);
      results.push(result);
    }

    return results;
  }

  /**
   * Get ARP table (known devices on network)
   */
  async getArpTable() {
    try {
      let command = 'arp -an'; // default to -an for safety against dns timeouts
      const platform = os.platform();
      console.log("[Network Monitor] Current OS platform is:", platform);

      if (platform === 'darwin') {
        // macOS
        command = 'arp -an';
      } else if (platform === 'linux') {
        // Linux
        command = 'cat /proc/net/arp';
      } else if (platform === 'win32') {
        // Windows
        command = 'arp -a'; // Windows only supports -a
      }

      const { stdout } = await execPromise(command, { timeout: 5000 });
      const devices = this.parseArpOutput(stdout, platform);

      return devices;
    } catch (error) {
      console.error('[Network Monitor] Error getting ARP table:', error.message);
      return [];
    }
  }

  /**
   * Parse ARP command output
   */
  parseArpOutput(output, platform) {
    const devices = [];

    try {
      if (platform === 'darwin') {
        // macOS format: hostname (192.168.1.1) at aa:bb:cc:dd:ee:ff on en0 ifscope [ethernet]
        const lines = output.split('\n');
        for (const line of lines) {
          const match = line.match(/\(?([0-9.]+)\)?\s+at\s+([a-fA-F0-9:]+)\s+on\s+(\w+)/);
          if (match) {
            devices.push({
              ip: match[1],
              mac: match[2],
              interface: match[3],
              hostname: line.split(' ')[0],
              platform: 'macOS'
            });
          }
        }
      } else if (platform === 'linux') {
        // Linux /proc/net/arp format
        const lines = output.split('\n').slice(1); // Skip header
        for (const line of lines) {
          const parts = line.trim().split(/\s+/);
          if (parts.length >= 4) {
            devices.push({
              ip: parts[0],
              mac: parts[3],
              interface: parts[5],
              platform: 'Linux'
            });
          }
        }
      } else if (platform === 'win32') {
        // Windows format
        const lines = output.split('\n');
        for (const line of lines) {
          const match = line.match(/([0-9.]+)\s+([a-fA-F0-9-]+)/);
          if (match) {
            devices.push({
              ip: match[1],
              mac: match[2].replace(/-/g, ':'),
              platform: 'Windows'
            });
          }
        }
      }

      // Filter out broadcast and invalid entries
      return devices.filter(d => d.ip && d.mac && !d.ip.endsWith('.255'));
    } catch (error) {
      console.error('[Network Monitor] Error parsing ARP output:', error);
      return [];
    }
  }

  /**
   * Discover active devices on the network using ping sweep
   */
  async discoverNetworkDevices() {
    try {
      const interfaces = await this.getNetworkInterfaces();
      const activeDevices = [];
      const scannedSubnets = new Set();
      
      // Find all active interfaces that have an IPv4 address and are not loopback
      const validInterfaces = interfaces.filter(i => 
        i.ip4 && 
        i.ip4 !== '127.0.0.1' && 
        (i.operstate === 'UP' || i.operstate === 'up' || i.operstate === 'unknown')
      );

      if (validInterfaces.length === 0) {
        return { interfaces: [], devices: [], message: 'No active network interfaces found' };
      }

      console.log(`[Network Monitor] Scanning ${validInterfaces.length} interfaces...`);
      const commonIps = [
        1, 2, 3, 4, 5, 8, 10, 11, 15, 20, 25, 30, 40, 50, 60, 70, 80, 90, 
        100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113, 114, 115, 120, 130, 140, 150, 
        200, 210, 220, 230, 240, 250, 254
      ];
      const allPromises = [];

      for (const iface of validInterfaces) {
        const ip = iface.ip4;
        const parts = ip.split('.');
        const networkPrefix = parts.slice(0, 3).join('.');
        
        // Avoid scanning the same subnet twice if multiple interfaces are on it
        if (scannedSubnets.has(networkPrefix)) continue;
        scannedSubnets.add(networkPrefix);

        for (const suffix of commonIps) {
          const testIp = `${networkPrefix}.${suffix}`;
          if (testIp !== ip) {
            allPromises.push(
              this.pingHost(testIp, 1).then(result => ({
                ip: testIp,
                reachable: result.reachable,
                interface: iface.name
              }))
            );
          }
        }
      }

      const results = await Promise.all(allPromises);
      const reachableResults = results.filter(r => r.reachable);

      // Get ARP table for detailed device info
      const arpDevices = await this.getArpTable();

      // Combine reachable IPs with ARP table data
      for (const res of reachableResults) {
        const arpEntry = arpDevices.find(d => d.ip === res.ip);
        activeDevices.push({
          ip: res.ip,
          mac: arpEntry ? arpEntry.mac : 'Unknown',
          interface: res.interface,
          hostname: arpEntry ? arpEntry.hostname : 'Unknown',
          reachable: true
        });
      }

      return {
        scannedInterfaces: validInterfaces.map(i => i.name),
        networkPrefixes: Array.from(scannedSubnets),
        devices: activeDevices
      };
    } catch (error) {
      console.error('[Network Monitor] Error discovering devices:', error.message);
      return { devices: [], error: error.message };
    }
  }

  /**
   * Get traffic by device/IP
   */
  async getDeviceTraffic() {
    try {
      const stats = await this.getNetworkStats();
      const arpTable = await this.getArpTable();

      // Group traffic by IP addresses from ARP table
      const deviceTraffic = [];

      for (const device of arpTable) {
        deviceTraffic.push({
          ip: device.ip,
          mac: device.mac,
          hostname: device.hostname || 'Unknown',
          interface: device.interface
        });
      }

      return deviceTraffic;
    } catch (error) {
      console.error('[Network Monitor] Error getting device traffic:', error.message);
      return [];
    }
  }

  /**
   * Get local network information using native OS module for stability
   */
  async getLocalNetworkInfo() {
    try {
      const os = require('os');
      const networkInterfaces = os.networkInterfaces();
      let primaryInfo = null;

      // Iterate through interfaces to find a valid IPv4
      for (const name of Object.keys(networkInterfaces)) {
        const ifaces = networkInterfaces[name];
        for (const details of ifaces) {
          if (details.family === 'IPv4' && !details.internal) {
            // Prefer UP/Active-like interfaces
            const parts = details.address.split('.');
            const networkPrefix = parts.slice(0, 3).join('.');
            
            primaryInfo = {
              yourIP: details.address,
              yourMAC: details.mac || 'Unknown',
              interface: name,
              networkPrefix: networkPrefix,
              networkRange: `${networkPrefix}.0 - ${networkPrefix}.255`,
              gateway: `${networkPrefix}.1 (typical)`
            };
            break;
          }
        }
        if (primaryInfo) break;
      }

      if (!primaryInfo) {
        return {
          yourIP: 'Unknown',
          yourMAC: 'Unknown',
          interface: 'None',
          networkPrefix: '0.0.0',
          networkRange: 'Unknown',
          gateway: 'Unknown'
        };
      }

      return primaryInfo;
    } catch (error) {
      console.error('[Network Monitor] Error getting local info via OS module:', error.message);
      return {
        yourIP: 'Unknown',
        yourMAC: 'Unknown',
        interface: 'None',
        networkPrefix: '0.0.0',
        networkRange: 'Unknown',
        gateway: 'Unknown'
      };
    }
  }
}

module.exports = new NetworkMonitor();
