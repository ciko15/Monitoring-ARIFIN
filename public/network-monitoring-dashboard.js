// Network Monitoring Dashboard
// Real-time network statistics and connectivity monitoring


var liveDataTimer = window.liveDataTimer;
let networkStats = [];
let interfaceData = [];
let trafficChart = null;
let userLocalIP = null;

// Initialize Network Monitoring Dashboard
function initNetworkMonitor() {
  try {
    console.log('[Network Monitor] Initializing Network Monitoring Dashboard...');
    
    // Show loading message in all sections
    const sections = ['networkInterfacesContent', 'trafficStatsContent', 'connectivityContent', 'systemNetworkInfoContent', 'localNetworkInfoContent', 'connectedDevicesContent', 'discoveredDevicesContent'];
    sections.forEach(id => {
      const elem = document.getElementById(id);
      if (elem) {
        elem.innerHTML = '<div class="empty-state" style="padding: 20px; text-align: center;"><i class="fas fa-spinner fa-spin"></i> Loading...</div>';
      } else {
        console.warn(`[Network Monitor] Element not found: ${id}`);
      }
    });
    
    // Load initial data
    Promise.all([
      loadNetworkInterfaces(),
      loadNetworkStats(),
      loadSystemNetworkInfo(),
      loadLocalNetworkInfo(),
      loadConnectedDevices()
    ]).then(() => {
      console.log('[Network Monitor] All initial data loaded');
    }).catch(e => {
      console.error('[Network Monitor] Error loading data:', e);
    });
    
    // Set up auto-refresh
    setInterval(loadNetworkStats, 5000); // Refresh every 5 seconds
    setInterval(loadConnectedDevices, 10000); // Refresh ARP table every 10 seconds
    
    console.log('[Network Monitor] Network Monitor initialized successfully');
  } catch (error) {
    console.error('[Network Monitor] Initialization error:', error);
    // Try to show error on page
    const sections = ['networkInterfacesContent', 'trafficStatsContent', 'connectivityContent', 'systemNetworkInfoContent', 'localNetworkInfoContent', 'connectedDevicesContent', 'discoveredDevicesContent'];
    sections.forEach(id => {
      const elem = document.getElementById(id);
      if (elem) {
        elem.innerHTML = `<div class="empty-state" style="padding: 20px; text-align: center; color: #ef4444;">❌ Error: ${error.message}</div>`;
      }
    });
  }
}

// Load network interfaces
async function loadNetworkInterfaces() {
  try {
    console.log('[Network Monitor] Loading network interfaces...');
    const response = await fetch('/api/network/interfaces', { headers: getAuthHeaders() });
    const result = await response.json();
    
    if (result.success && result.data) {
      interfaceData = result.data;
      displayNetworkInterfaces(result.data);
      console.log('[Network Monitor] Found', result.data.length, 'network interfaces');
    } else {
      console.warn('[Network Monitor] Failed to load interfaces:', result);
      const content = document.getElementById('networkInterfacesContent');
      if (content) content.innerHTML = `<div class="empty-state" style="padding: 20px; text-align: center; color: #ef4444;">❌ Access Denied: ${result.error || 'Failed to load interfaces'}</div>`;
    }
  } catch (error) {
    console.error('[Network Monitor] Error loading interfaces:', error);
    const content = document.getElementById('networkInterfacesContent');
    if (content) content.innerHTML = '<div class="empty-state" style="padding: 20px; text-align: center; color: #ef4444;">❌ Error: ' + error.message + '</div>';
  }
}

// Display network interfaces
function displayNetworkInterfaces(interfaces) {
  try {
    const content = document.getElementById('networkInterfacesContent');
    if (!content) {
      console.warn('[Network Monitor] networkInterfacesContent element not found');
      return;
    }
    
    if (interfaces.length === 0) {
      content.innerHTML = '<div class="empty-state" style="padding: 20px; text-align: center;">No network interfaces found</div>';
      return;
    }
    
    let html = '<table class="monitor-table" style="width: 100%;"><thead><tr>' +
      '<th>Interface</th><th>Type</th><th>IP Address</th><th>MAC Address</th><th>Status</th><th>Speed</th>' +
      '</tr></thead><tbody>';
    
    for (const iface of interfaces) {
      const statusClass = iface.operstate === 'UP' || iface.operstate === 'up' ? 'status-up' : 'status-down';
      const statusText = iface.operstate === 'UP' || iface.operstate === 'up' ? '🟢 Up' : '🔴 Down';
      
      html += `<tr>
        <td style="font-weight: 600;">${iface.name}</td>
        <td>${iface.type || 'Unknown'}</td>
        <td style="font-family: monospace; font-size: 0.9em;">${iface.ip4 || iface.ip6 || '-'}</td>
        <td style="font-family: monospace; font-size: 0.85em;">${iface.mac || '-'}</td>
        <td><span class="${statusClass}">${statusText}</span></td>
        <td>${iface.speed ? iface.speed + ' Mbps' : 'Unknown'}</td>
      </tr>`;
    }
    
    html += '</tbody></table>';
    content.innerHTML = html;
    console.log('[Network Monitor] Displayed', interfaces.length, 'interfaces');
  } catch (error) {
    console.error('[Network Monitor] Display interfaces error:', error);
  }
}

// Load network statistics
async function loadNetworkStats() {
  try {
    const response = await fetch('/api/network/stats', { headers: getAuthHeaders() });
    const result = await response.json();
    
    if (result.success && result.data) {
      networkStats = result.data;
      displayTrafficStats(result.data);
    } else {
      console.warn('[Network Monitor] Failed to load stats:', result);
    }
  } catch (error) {
    console.error('[Network Monitor] Error loading stats:', error);
  }
}

// Display traffic statistics
function displayTrafficStats(stats) {
  try {
    const content = document.getElementById('trafficStatsContent');
    if (!content) {
      console.warn('[Network Monitor] trafficStatsContent element not found');
      return;
    }
    
    let html = '<table class="monitor-table" style="width: 100%;"><thead><tr>' +
      '<th>Interface</th><th>RX Rate</th><th>TX Rate</th><th>RX Errors</th><th>TX Errors</th><th>RX Dropped</th><th>TX Dropped</th>' +
      '</tr></thead><tbody>';
    
    for (const stat of stats) {
      const rxColor = stat.rxErrors > 0 ? 'color: #ef4444;' : '';
      const txColor = stat.txErrors > 0 ? 'color: #ef4444;' : '';
      
      html += `<tr>
        <td style="font-weight: 500;">${stat.interface}</td>
        <td style="color: #3b82f6;">📥 ${(stat.rxRate ?? 0).toFixed(2)} KB/s</td>
        <td style="color: #10b981;">📤 ${(stat.txRate ?? 0).toFixed(2)} KB/s</td>
        <td style="${rxColor}">${stat.rxErrors}</td>
        <td style="${txColor}">${stat.txErrors}</td>
        <td>${stat.rxDropped}</td>
        <td>${stat.txDropped}</td>
      </tr>`;
    }
    
    html += '</tbody></table>';
    content.innerHTML = html;
  } catch (error) {
    console.error('[Network Monitor] Display stats error:', error);
  }
}

// Refresh network statistics manually
async function refreshNetworkStats() {
  try {
    await loadNetworkStats();
    console.log('[Network Monitor] Network statistics refreshed');
  } catch (error) {
    console.error('[Network Monitor] Refresh error:', error);
  }
}

// Test connectivity to external hosts
async function testConnectivity() {
  try {
    const button = document.querySelector('button[onclick="testConnectivity()"]');
    if (button) {
      button.disabled = true;
      button.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Testing...';
    }
    
    console.log('[Network Monitor] Testing connectivity to known hosts...');
    
    const response = await fetch('/api/network/test-connectivity', {
      method: 'POST',
      headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        hosts: ['8.8.8.8', '1.1.1.1', 'google.com']
      })
    });
    
    const result = await response.json();
    
    if (result.success) {
      displayConnectivityResults(result.data);
      console.log('[Network Monitor] Connectivity test completed');
    } else {
      throw new Error(result.error || 'Unknown error');
    }
    
    if (button) {
      button.disabled = false;
      button.innerHTML = '<i class="fas fa-globe"></i> Test Connectivity';
    }
  } catch (error) {
    console.error('[Network Monitor] Connectivity test error:', error);
    
    const button = document.querySelector('button[onclick="testConnectivity()"]');
    if (button) {
      button.disabled = false;
      button.innerHTML = '<i class="fas fa-globe"></i> Test Connectivity';
    }
    
    // Show error in connectivity content
    const content = document.getElementById('connectivityContent');
    if (content) {
      content.innerHTML = '<div class="empty-state" style="padding: 20px; text-align: center; color: #ef4444;">❌ Error: ' + error.message + '</div>';
    }
  }
}

// Display connectivity test results
function displayConnectivityResults(results) {
  try {
    const content = document.getElementById('connectivityContent');
    if (!content) return;
    
    let html = '<table class="monitor-table" style="width: 100%;"><thead><tr>' +
      '<th>Host</th><th>Status</th><th>Packets TX/RX</th><th>Loss</th><th>Min/Avg/Max RTT</th>' +
      '</tr></thead><tbody>';
    
    for (const result of results) {
      const statusClass = result.reachable ? 'status-up' : 'status-down';
      const statusText = result.reachable ? '🟢 Reachable' : '🔴 Unreachable';
      const loss = result.packetLoss !== undefined ? result.packetLoss : 100;
      const packets = `${result.packetsTransmitted || 0}/${result.packetsReceived || 0}`;
      const rtt = (result.min != null && result.avg != null && result.max != null) 
        ? `${Number(result.min).toFixed(1)}/${Number(result.avg).toFixed(1)}/${Number(result.max).toFixed(1)} ms`
        : 'N/A';
      
      html += `<tr>
        <td style="font-weight: 500; font-family: monospace;">${result.host}</td>
        <td><span class="${statusClass}">${statusText}</span></td>
        <td>${packets}</td>
        <td>${Number(loss).toFixed(1)}%</td>
        <td>${rtt}</td>
      </tr>`;

    }
    
    html += '</tbody></table>';
    content.innerHTML = html;
  } catch (error) {
    console.error('[Network Monitor] Display connectivity error:', error);
  }
}

// Load system network information
async function loadSystemNetworkInfo() {
  try {
    const response = await fetch('/api/network/info', { headers: getAuthHeaders() });
    const result = await response.json();
    
    if (result.success && result.data) {
      displaySystemNetworkInfo(result.data);
    }
  } catch (error) {
    console.error('[Network Monitor] Error loading system info:', error);
  }
}

// Display system network information
function displaySystemNetworkInfo(info) {
  try {
    const content = document.getElementById('systemNetworkInfoContent');
    if (!content) return;
    
    let html = '<div style="display: grid; grid-template-columns: 1fr 1fr; gap: 20px;">';
    
    // System Info
    html += '<div><h4 style="margin-top: 0;">System</h4>';
    html += `<p><strong>Hostname:</strong> <code>${info.hostname}</code></p>`;
    html += `<p><strong>Platform:</strong> ${info.platform}</p>`;
    html += `<p><strong>Architecture:</strong> ${info.arch}</p>`;
    html += '</div>';
    
    // Interfaces
    html += '<div><h4 style="margin-top: 0;">Active Interfaces</h4>';
    if (info.interfaces && info.interfaces.length > 0) {
      html += '<ul style="margin: 0; padding-left: 20px;">';
      for (const iface of info.interfaces.slice(0, 5)) {
        const addrs = iface.addresses && Array.isArray(iface.addresses) ? iface.addresses.map(a => a.address || a).join(', ') : (iface.ip4 || iface.ip6 || 'Unknown IP');
        html += `<li><strong>${iface.name}:</strong> ${addrs}</li>`;
      }
      html += '</ul>';
    }
    html += '</div>';
    
    html += '</div>';
    content.innerHTML = html;
  } catch (error) {
    console.error('[Network Monitor] Display system info error:', error);
  }
}

// Add log entry
function addMonitorLog(source, message, type = 'info') {
  try {
    // Log to console
    console.log(`[${source}] ${message}`);
  } catch (error) {
    console.error('Error adding log entry:', error);
  }
}

// Load local network information
async function loadLocalNetworkInfo() {
  try {
    console.log('[Network Monitor] Loading local network info...');
    const response = await fetch('/api/network/local-info', { headers: getAuthHeaders() });
    const result = await response.json();
    
    console.log('[Network Monitor] Local info response:', result);
    
    if (result.success && result.data) {
      displayLocalNetworkInfo(result.data);
    } else if (result.success && !result.data) {
      console.warn('[Network Monitor] Local network info is null');
      const content = document.getElementById('localNetworkInfoContent');
      if (content) {
        content.innerHTML = '<div class="empty-state" style="padding: 20px; text-align: center; color: #999;">Unable to detect local network information</div>';
      }
    } else {
      // Handle success: false (e.g., 401 Unauthorized)
      console.error('[Network Monitor] Failed to load local info:', result.error || 'Unknown error');
      const content = document.getElementById('localNetworkInfoContent');
      if (content) {
        content.innerHTML = `<div class="empty-state" style="padding: 20px; text-align: center; color: #ef4444;">❌ Access Denied: ${result.error || 'Please login'}</div>`;
      }
    }
  } catch (error) {
    console.error('[Network Monitor] Error loading local network info:', error);
    const content = document.getElementById('localNetworkInfoContent');
    if (content) {
      content.innerHTML = `<div class="empty-state" style="padding: 20px; text-align: center; color: #ef4444;">❌ Error: ${error.message}</div>`;
    }
  }
}

// Display local network information
function displayLocalNetworkInfo(info) {
  try {
    const content = document.getElementById('localNetworkInfoContent');
    if (!content) return;
    
    let html = '<div style="display: grid; grid-template-columns: 1fr 1fr; gap: 15px; font-size: 0.95em;">';
    
    userLocalIP = info.yourIP;
    html += `<div><strong>Your IP:</strong> <code style="background: rgba(0,0,0,0.2); padding: 4px 8px; border-radius: 4px;">${info.yourIP}</code></div>`;
    html += `<div><strong>Your MAC:</strong> <code style="background: rgba(0,0,0,0.2); padding: 4px 8px; border-radius: 4px;">${info.yourMAC}</code></div>`;
    html += `<div><strong>Interface:</strong> ${info.interface}</div>`;
    html += `<div><strong>Network Range:</strong> ${info.networkRange}</div>`;
    html += `<div><strong>Gateway:</strong> ${info.gateway}</div>`;
    
    html += '</div>';
    content.innerHTML = html;
    
    console.log('[Network Monitor] Local network info displayed');
  } catch (error) {
    console.error('[Network Monitor] Error displaying local network info:', error);
  }
}

// Load connected devices from ARP table
async function loadConnectedDevices() {
  try {
    console.log('[Network Monitor] Loading connected devices...');
    const response = await fetch('/api/network/arp-table', { headers: getAuthHeaders() });
    const result = await response.json();
    
    console.log('[Network Monitor] ARP table response:', result);
    
    if (result.success && result.data) {
      displayConnectedDevices(result.data);
    } else if (result.success && !result.data) {
      const content = document.getElementById('connectedDevicesContent');
      if (content) {
        content.innerHTML = '<div class="empty-state" style="padding: 20px; text-align: center; color: #999;">No ARP entries available yet</div>';
      }
    }
  } catch (error) {
    console.error('[Network Monitor] Error loading connected devices:', error);
    const content = document.getElementById('connectedDevicesContent');
    if (content) {
      content.innerHTML = `<div class="empty-state" style="padding: 20px; text-align: center; color: #ef4444;">❌ Error: ${error.message}</div>`;
    }
  }
}

// Display connected devices
function displayConnectedDevices(devices) {
  try {
    const content = document.getElementById('connectedDevicesContent');
    if (!content) return;
    
    if (!devices || devices.length === 0) {
      content.innerHTML = '<div class="empty-state" style="padding: 20px; text-align: center; color: #999;">No ARP entries found. Your device will appear here once it connects.</div>';
      return;
    }
    
    let html = '<table class="monitor-table" style="width: 100%;"><thead><tr>' +
      '<th>IP Address</th><th>MAC Address</th><th>Hostname</th><th>Interface</th>' +
      '</tr></thead><tbody>';
    
    for (const device of devices) {
      // Menangani berbagai format penamaan key/property dari backend sistem operasi (arp-a, raw json, dll)
      const ip = device.ip || device.ip_address || device.ipAddress || device.address || device.IP || 'Unknown';
      const mac = device.mac || device.mac_address || device.macAddress || device.MAC || 'Unknown';
      const hostname = device.hostname || device.name || device.Hostname || '-';
      const iface = device.interface || device.iface || device.ifaceName || device.Interface || '-';
      
      const isYourDevice = ip === userLocalIP ? 'style="background: rgba(34, 197, 94, 0.1); font-weight: 600;"' : '';
      
      html += `<tr ${isYourDevice}>
        <td style="font-family: monospace; font-size: 0.9em;">${ip}${ip === userLocalIP ? ' (Your Device)' : ''}</td>
        <td style="font-family: monospace; font-size: 0.85em;">${mac}</td>
        <td>${hostname}</td>
        <td>${iface}</td>
      </tr>`;
    }
    
    html += '</tbody></table>';
    content.innerHTML = html;
    console.log('[Network Monitor] Connected devices displayed:', devices.length);
  } catch (error) {
    console.error('[Network Monitor] Error displaying connected devices:', error);
  }
}

// Discover active devices on network
async function discoverNetworkDevices() {
  try {
    const button = document.getElementById('discoverDevicesBtn');
    if (button) {
      button.disabled = true;
      button.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Scanning...';
    }
    
    console.log('[Network Monitor] Scanning network for active devices...');
    
    const response = await fetch('/api/network/discover-devices', { headers: getAuthHeaders() });
    const result = await response.json();
    
    if (result.success && result.data) {
      displayDiscoveredDevices(result.data);
      console.log('[Network Monitor] Network scan completed');
    } else {
      console.warn('[Network Monitor] Discovery failed:', result);
    }
    
    if (button) {
      button.disabled = false;
      button.innerHTML = '<i class="fas fa-search"></i> Scan Network';
    }
  } catch (error) {
    console.error('[Network Monitor] Network discovery error:', error);
    
    const button = document.getElementById('discoverDevicesBtn');
    if (button) {
      button.disabled = false;
      button.innerHTML = '<i class="fas fa-search"></i> Scan Network';
    }
    
    const content = document.getElementById('discoveredDevicesContent');
    if (content) {
      content.innerHTML = '<div class="empty-state" style="padding: 20px; text-align: center; color: #ef4444;">❌ Error: ' + error.message + '</div>';
    }
  }
}

// Display discovered devices
function displayDiscoveredDevices(data) {
  try {
    const content = document.getElementById('discoveredDevicesContent');
    if (!content) return;
    
    if (!data.devices || data.devices.length === 0) {
      content.innerHTML = `<div class="empty-state" style="padding: 20px; text-align: center; color: #999;">
        <p>No active devices found on ${data.networkPrefix}.0/24 network.</p>
        <p style="font-size: 0.9em;">Devices might be offline or not responding to ping.</p>
      </div>`;
      return;
    }
    
    let html = `<div style="margin-bottom: 15px; padding: 10px; background: #f0f9ff; border-left: 4px solid #3b82f6; border-radius: 4px;">
      <strong>Network:</strong> ${data.networkPrefix}.0/24 | <strong>Primary Interface:</strong> ${data.primaryInterface}<br>
      <strong>Found:</strong> ${data.devices.length} active device(s)
    </div>`;
    
    html += '<table class="monitor-table" style="width: 100%;"><thead><tr>' +
      '<th>IP Address</th><th>MAC Address</th><th>Hostname</th><th>Status</th>' +
      '</tr></thead><tbody>';
    
    for (const device of data.devices) {
      // Fallback yang sama diterapkan juga untuk Active Devices (Scan Network)
      const ip = device.ip || device.ip_address || device.ipAddress || device.address || device.IP || 'Unknown';
      const mac = device.mac || device.mac_address || device.macAddress || device.MAC || '-';
      const hostname = device.hostname || device.name || device.Hostname || '-';
      
      const isYourDevice = ip === userLocalIP;
      const youLabel = isYourDevice ? ' (Your Device)' : '';
      const rowStyle = isYourDevice ? 'style="background: rgba(34, 197, 94, 0.1); font-weight: 600;"' : '';
      
      html += `<tr ${rowStyle}>
        <td style="font-family: monospace; font-size: 0.9em;">${ip}${youLabel}</td>
        <td style="font-family: monospace; font-size: 0.85em;">${mac}</td>
        <td>${hostname}</td>
        <td><span style="color: #10b981; font-weight: 600;">✅ Reachable</span></td>
      </tr>`;
    }
    
    html += '</tbody></table>';
    content.innerHTML = html;
    console.log('[Network Monitor] Discovered devices displayed:', data.devices.length);
  } catch (error) {
    console.error('[Network Monitor] Error displaying discovered devices:', error);
  }
}

// Initialize on page load if needed
// The actual initialization will be called from app.js when the section is shown

// Export functions for global use
window.initNetworkMonitor = initNetworkMonitor;
window.refreshNetworkStats = refreshNetworkStats;
window.testConnectivity = testConnectivity;
window.loadLocalNetworkInfo = loadLocalNetworkInfo;
window.loadConnectedDevices = loadConnectedDevices;
window.discoverNetworkDevices = discoverNetworkDevices;
