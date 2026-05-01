// Network Tools - Real Network Analytics + Connected Devices Scanner
// Uses backend API to capture packets + scan ARP table / ping sweep for connected IPs

let capturedPacketsSize = 2500;
window.capturedPackets = [];
window.filteredPackets = [];
window.isCapturing = false;
window.packetCounter = 0;
window.captureUpdateInterval = null;
window.captureModeInterval = null;
window.interfacePollingInterval = null;
window.availableInterfaces = [];
window.lastCaptureError = null;
window.connectedDevices = [];
window.isScanningDevices = false;
window.yourLocalIP = null;

// Initialize Network Tools
function initNetworkTools() {
  try {
    console.log('[Network Tools] Initializing...');
    
    // Reset state
    window.isCapturing = false;
    window.capturedPackets = [];
    window.filteredPackets = [];
    window.packetCounter = 0;
    window.lastCaptureError = null;
    window.connectedDevices = [];
    window.isScanningDevices = false;
    
    // Update UI
    updateCaptureStatus();
    updatePacketCount();
    
    // Load network interfaces and start polling
    loadNetworkInterfaces();
    startInterfacePolling();
    loadLocalInfo();
    
    // Initialize device scanner section
    const deviceScanSection = document.getElementById('deviceScanSection');
    if (deviceScanSection) {
      deviceScanSection.style.display = 'block';
    }
    
    addLogEntry('System', 'Network Tools initialized - Ready to capture real network traffic', 'info');
    
    // Set up event delegation for packet list clicks
    const tbody = document.getElementById('packetListBody');
    if (tbody) {
        tbody.addEventListener('click', (e) => {
            const row = e.target.closest('.packet-row');
            if (row && row.dataset.number) {
                // Clear previous selection
                document.querySelectorAll('.packet-row').forEach(r => r.classList.remove('selected-packet'));
                // Highlight current row
                row.classList.add('selected-packet');
                // Display details
                displayPacketDetails(row.dataset.number);
            }
        });
    }
  } catch (error) {
    console.error('[Network Tools] Initialization error:', error);
    addLogEntry('Error', `Initialization failed: ${error.message}`, 'error');
  }
}

// Load and display network interfaces
async function loadNetworkInterfaces() {
  try {
    const headers = getAuthHeaders();
    if (!headers.Authorization) {
        console.warn('[Network Tools] No Authorization header found. API call may fail.');
    }
    const response = await fetch('/api/network/ifstats', { headers });
    
    if (response.status === 401) {
        throw new Error('Unauthorized - Please log in again');
    }
    const result = await response.json();

    if (result.success && result.data) {
      const interfaces = result.data;
      console.log(`[Network Tools] Received ${interfaces.length} interfaces:`, interfaces);
      availableInterfaces = interfaces;

      const interfaceSelect = document.getElementById('interfaceSelect');
      if (interfaceSelect) {
        // Build new options list
        const optionsToAdd = interfaces.map(iface => {
          const ifaceName = iface.name || iface.iface || iface.interface || iface.ifaceName;
          if (!ifaceName) return null;
          
          const rx = iface.rxRate ? (iface.rxRate > 1024 ? (iface.rxRate/1024).toFixed(1) + ' MB/s' : iface.rxRate.toFixed(1) + ' KB/s') : '0 KB/s';
          const tx = iface.txRate ? (iface.txRate > 1024 ? (iface.txRate/1024).toFixed(1) + ' MB/s' : iface.txRate.toFixed(1) + ' KB/s') : '0 KB/s';
          const trafficInfo = (iface.rxRate > 0 || iface.txRate > 0) ? ` - Traffic: [RX: ${rx}, TX: ${tx}]` : '';
          
          let icon = '🔌';
          const name = ifaceName.toLowerCase();
          if (name.includes('wlan') || name.includes('wifi') || name.startsWith('wl') || name.startsWith('en1')) {
              icon = '📡';
          }

          return {
              value: ifaceName,
              text: `${icon} ${ifaceName} (${iface.operstate || iface.type || 'unknown'})${trafficInfo}`
          };
        }).filter(Boolean);

        const currentSelection = interfaceSelect.value;
        const allInterfacesOption = interfaceSelect.options[0];
        
        // Clear and rebuild to ensure accuracy
        interfaceSelect.innerHTML = '';
        interfaceSelect.appendChild(allInterfacesOption);
        
        optionsToAdd.forEach(opt => {
            const el = document.createElement('option');
            el.value = opt.value;
            el.textContent = opt.text;
            interfaceSelect.appendChild(el);
        });

        // Restore selection
        if (currentSelection) {
            interfaceSelect.value = currentSelection;
        }

        // Auto-select logic (only if no current choice)
        if (!interfaceSelect.value) {
          const active = interfaces
            .filter(i => {
                const n = (i.name || '').toLowerCase();
                return n && !n.startsWith('lo') && !n.startsWith('awdl');
            })
            .sort((a, b) => (b.rxRate + b.txRate) - (a.rxRate + a.txRate))[0];
          
          if (active && (active.rxRate > 0 || active.txRate > 0)) {
            interfaceSelect.value = active.name;
          } else {
            const preferred = interfaces.find(i => {
              const name = (i.name || '').toLowerCase();
              return name && !name.startsWith('lo') && !name.startsWith('awdl');
            }) || interfaces[0];
            
            if (preferred) {
              interfaceSelect.value = preferred.name || '';
            }
          }
        }
      }
    }
  } catch (error) {
    console.error('[Network Tools] Error loading interfaces:', error);
    if (error.message.includes('Unauthorized')) {
        addLogEntry('System', 'Authentication expired. Please log in to see network interfaces.', 'warning');
    }
  }
}

function startInterfacePolling() {
    if (interfacePollingInterval) return;
    interfacePollingInterval = setInterval(() => {
        const interfaceSelect = document.getElementById('interfaceSelect');
        const isInteracting = interfaceSelect === document.activeElement;
        
        if (!isCapturing && !isInteracting && (document.getElementById('network-toolsSection')?.classList.contains('active') || true)) {
            loadNetworkInterfaces();
        }
    }, 5000);
}

function stopInterfacePolling() {
    if (interfacePollingInterval) {
        clearInterval(interfacePollingInterval);
        interfacePollingInterval = null;
    }
}

// Start capturing packets
async function startCapture() {
  try {
    if (isCapturing) return;
    
    isCapturing = true;
    capturedPackets = [];
    filteredPackets = [];
    packetCounter = 0;
    lastCaptureError = null;
    
    addLogEntry('System', 'Starting real network packet capture...', 'info');
    stopInterfacePolling();
    
    // Determine selected interface
    const interfaceSelect = document.getElementById('interfaceSelect');
    let selectedInterface = interfaceSelect?.value || '';

    // Start packet capture on backend
    const response = await fetch('/api/network/sniffer/start', {
      method: 'POST',
      headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ interface: selectedInterface })
    });
    
    if (!response.ok) {
      throw new Error('Failed to start packet capture');
    }
    
    updateCaptureStatus();
    
    // Update packet list every 1 second
    captureUpdateInterval = setInterval(updateCaptureData, 1000);
    // Poll stats/errors every 2 seconds
    captureModeInterval = setInterval(updateCaptureStatus, 2000);
    
  } catch (error) {
    console.error('[Network Tools] Start capture error:', error);
    addLogEntry('Error', `Start capture failed: ${error.message}`, 'error');
    isCapturing = false;
    updateCaptureStatus();
  }
}

// Update captured data from backend
async function updateCaptureData() {
  try {
    if (!window.isCapturing) return;
    
    const response = await fetch('/api/network/sniffer/packets', { headers: getAuthHeaders() });
    const result = await response.json();
    
    if (result.success && result.data) {
      const newPackets = result.data;
      const prevCount = window.capturedPackets.length;
      
      window.capturedPackets = newPackets;
      
      if (window.capturedPackets.length > prevCount) {
        // Apply filters and update display
        applyFilters();
      } else if (window.capturedPackets.length === 0) {
        // Still empty, update display and check for errors immediately
        updateCaptureStatus();
        displayPackets();
      }
    }
  } catch (error) {
    console.error('[Network Tools] Update error:', error);
  }
}

// Stop capturing packets
async function stopCapture() {
  try {
    isCapturing = false;
    
    if (captureUpdateInterval) clearInterval(captureUpdateInterval);
    if (captureModeInterval) clearInterval(captureModeInterval);
    
    captureUpdateInterval = null;
    captureModeInterval = null;
    
    addLogEntry('System', 'Packet capture stopped', 'info');
    updateCaptureStatus();
    startInterfacePolling();
    
    // Stop capture on backend
    await fetch('/api/network/sniffer/stop', { 
      method: 'POST',
      headers: getAuthHeaders()
    });
  } catch (error) {
    console.error('[Network Tools] Stop capture error:', error);
  }
}

// Apply filters to packet list
function applyFilters() {
  try {
    const packetFilter = (document.getElementById('packetFilter')?.value || '').trim().toLowerCase();
    const protocolFilter = (document.getElementById('protocolFilter')?.value || '').trim();
    const interfaceFilter = (document.getElementById('interfaceSelect')?.value || '').trim();

    window.filteredPackets = window.capturedPackets.filter(packet => {
      const proto = (packet.protocol || '').toString();
      const iface = (packet.interface || '').toString();
      const src = (packet.source || '').toString().toLowerCase();
      const dst = (packet.destination || '').toString().toLowerCase();
      const info = (packet.info || '').toString().toLowerCase();

      const matchesProtocol = !protocolFilter || proto === protocolFilter;
      const matchesInterface = !interfaceFilter || iface === interfaceFilter;
      const matchesFilter = !packetFilter || 
        src.includes(packetFilter) ||
        dst.includes(packetFilter) ||
        info.includes(packetFilter) ||
        proto.toLowerCase().includes(packetFilter) ||
        iface.toLowerCase().includes(packetFilter);

      return matchesProtocol && matchesInterface && matchesFilter;
    });

    displayPackets();
    updatePacketCount();
  } catch (error) {
    console.error('[Network Tools] Filter error:', error);
  }
}

function filterPackets() {
  applyFilters();
}

// Display packets in table
function displayPackets() {
  try {
    const tbody = document.getElementById('packetListBody');
    if (!tbody) return;
    
    // Handle empty states with specific messaging
    if (window.capturedPackets.length === 0) {
      let message = "No packets captured yet. Start capture to begin analyzing network traffic.";
      if (window.isCapturing) {
        message = '<div class="spinner-inline"></div> Waiting for network traffic...';
      }
      if (window.lastCaptureError) {
        message = `<span class="error-text"><i class="fas fa-exclamation-triangle"></i> Capture Error: ${window.lastCaptureError}</span>`;
      }
      tbody.innerHTML = `<tr><td colspan="8" class="empty-state">${message}</td></tr>`;
      return;
    }
    
    if (window.filteredPackets.length === 0) {
      tbody.innerHTML = '<tr><td colspan="8" class="empty-state"><i class="fas fa-filter"></i> No packets match your filter criteria.</td></tr>';
      return;
    }
    
    tbody.innerHTML = window.filteredPackets.map(packet => `
      <tr data-number="${packet.number}" style="cursor: pointer;" class="packet-row">
        <td>${packet.number}</td>
        <td>${(Number(packet.time) || 0).toFixed(3)}s</td>
        <td>${packet.interface || '-'}</td>
        <td class="addr-cell">${packet.source}</td>
        <td class="addr-cell">${packet.destination}</td>
        <td><span class="protocol-badge protocol-${packet.protocol.toLowerCase()}">${packet.protocol}</span></td>
        <td>${packet.length}</td>
        <td class="info-cell" title="${packet.info}">${packet.info}</td>
      </tr>
    `).join('');
  } catch (error) {
    console.error('[Network Tools] Display packets error:', error);
  }
}

// Display details for a specific packet
function displayPacketDetails(packetNumber) {
  try {
    // Convert to string for robust matching (backend might send number, HTML dataset is always string)
    const targetNumber = String(packetNumber);
    const packet = window.capturedPackets.find(p => String(p.number) === targetNumber);
    
    console.log(`[Network Tools] Displaying details for packet #${targetNumber}. Found:`, !!packet);

    if (!packet) {
        console.warn(`[Network Tools] Packet #${targetNumber} not found in buffer (current buffer size: ${window.capturedPackets.length})`);
        
        const detailsContent = document.getElementById('packetDetailsContent');
        if (detailsContent) {
            detailsContent.innerHTML = `<div class="empty-state">
              <i class="fas fa-exclamation-triangle" style="font-size: 24px; color: #f39c12; margin-bottom: 10px; display: block;"></i>
              Packet #${targetNumber} sudah terhapus dari memori server karena trafik data sangat padat.<br><br>
              <strong>Solusi:</strong> Tekan tombol <span class="badge" style="background:#e74c3c;">Stop Capture</span> di atas terlebih dahulu, baru kemudian klik detail paket yang Anda inginkan.
            </div>`;
        }
        
        const hexContent = document.getElementById('hexViewerContent');
        if (hexContent) {
            hexContent.innerHTML = `<div class="empty-state">Select a packet to view hex data</div>`;
        }
        
        
        return;
    }
    
    const detailsContent = document.getElementById('packetDetailsContent');
    if (!detailsContent) return;
    
    detailsContent.innerHTML = `
      <div class="packet-details">
        <div class="detail-section">
          <h4>Frame Information</h4>
          <div class="detail-item"><span class="label">Number:</span><span class="value">${packet.number}</span></div>
          <div class="detail-item"><span class="label">Time:</span><span class="value">${(Number(packet.time) || 0).toFixed(6)}s</span></div>
          <div class="detail-item"><span class="label">Length:</span><span class="value">${packet.length} bytes</span></div>
          <div class="detail-item"><span class="label">Interface:</span><span class="value">${packet.interface || 'unknown'}</span></div>
        </div>
        <div class="detail-section">
          <h4>Network Layer</h4>
          <div class="detail-item"><span class="label">Source:</span><span class="value">${packet.source}</span></div>
          <div class="detail-item"><span class="label">Destination:</span><span class="value">${packet.destination}</span></div>
          <div class="detail-item"><span class="label">Protocol:</span><span class="value">${packet.protocol}</span></div>
        </div>
        <div class="detail-section">
          <h4>Packet Info</h4>
          <div class="detail-item"><span class="value">${packet.info}</span></div>
        </div>
      </div>
    `;
    
    displayHexViewer(packet);
    autoFillTcpAnalyzer(packet);
  } catch (error) {
    console.error('[Network Tools] Display details error:', error);
  }
}

function displayHexViewer(packet) {
  try {
    const hexContent = document.getElementById('hexViewerContent');
    if (!hexContent) return;
    
    let rawData = packet.rawData || "";
    let isMock = false;
    if (!rawData) {
        // Generate mock hex for visualization if raw data is missing
        isMock = true;
        for (let i = 0; i < Math.min(packet.length, 64); i++) {
            rawData += Math.floor(Math.random() * 256).toString(16).padStart(2, '0');
        }
    }
    
    const bytes = rawData.match(/.{1,2}/g) || [];
    let hexHtml = `<div class="hex-dump ${isMock ? 'mock-data' : 'real-data'}">`;
    if (isMock) {
        hexHtml += `<div style="color: var(--text-muted); font-size: 0.8em; margin-bottom: 5px;"><i class="fas fa-info-circle"></i> Showing mock data (real payload not captured)</div>`;
    }
    
    for (let i = 0; i < bytes.length; i += 16) {
        const rowBytes = bytes.slice(i, i + 16);
        const offset = i.toString(16).padStart(4, '0').toUpperCase();
        const hex = rowBytes.map(b => b.toUpperCase()).join(' ');
        const ascii = rowBytes.map(b => {
            const code = parseInt(b, 16);
            return (code >= 32 && code <= 126) ? String.fromCharCode(code) : '.';
        }).join('');
        
        hexHtml += `<div class="hex-row"><span class="offset">${offset}</span> <span class="hex">${hex.padEnd(47)}</span> <span class="ascii">${ascii}</span></div>`;
    }
    
    hexHtml += '</div>';
    hexContent.innerHTML = hexHtml;
  } catch (error) {
    console.error('[Network Tools] Hex viewer error:', error);
  }
}

// Extract fields from packet to auto-fill TCP Analyzer
function autoFillTcpAnalyzer(packet) {
    try {
        const dest = packet.destination || '';
        if (!dest) return;
        
        let ip = dest;
        let port = '';
        
        // Handle format like "192.168.1.1.80" where last element is port
        const parts = dest.split('.');
        if (parts.length > 4) {
            port = parts.pop();
            ip = parts.join('.');
        } else if (parts.length === 4) {
            const proto = (packet.protocol || '').toUpperCase();
            if (proto === 'HTTP') port = '80';
            else if (proto === 'HTTPS') port = '443';
            else if (proto === 'SNMP') port = '161';
            else if (proto === 'DNS') port = '53';
        }

        const deviceIpInput = document.getElementById('tcpDeviceIp');
        const portInput = document.getElementById('tcpPort');
        
        if (deviceIpInput) deviceIpInput.value = ip;
        if (portInput && port) portInput.value = port;
        
        // Auto trigger connection test if both are filled
        if (ip && port && document.getElementById('btnTestTcpConnection')) {
            document.getElementById('tcpDeviceIp').scrollIntoView({ behavior: 'smooth', block: 'center' });
            testTcpConnection();
        }
    } catch (error) {
        console.error('[Network Tools] Error auto-analyzing packet:', error);
    }
}

// === CONNECTED DEVICES SCANNER (NEW) ===
// Scan for connected devices using ARP + ping sweep
let connectedDevices = [];
let isScanningDevices = false;

async function scanConnectedDevices() {
  try {
    if (window.isScanningDevices) return;
    window.isScanningDevices = true;

    const scanBtn = document.getElementById('scanDevicesBtn');
    const arpSection = document.getElementById('arpDevicesSection');
    
    if (scanBtn) {
      scanBtn.disabled = true;
      scanBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Scanning...';
    }

    addLogEntry('Scanner', 'Scanning local network for connected devices...', 'info');

    // Get ARP table (cached devices)
    const arpResponse = await fetch('/api/network/arp-table', { headers: getAuthHeaders() });
    const arpResult = await arpResponse.json();
    
    // Scan active devices (ping sweep)
    const discoverResponse = await fetch('/api/network/discover-devices', { headers: getAuthHeaders() });
    const discoverResult = await discoverResponse.json();

    if (arpResult.success) {
      window.connectedDevices = arpResult.data || [];
    }
    
    if (discoverResult.success) {
      // Merge ARP + discovered (active) devices
      const activeDevices = discoverResult.data.devices || [];
      window.connectedDevices = window.connectedDevices.concat(activeDevices.filter(d => 
        !window.connectedDevices.some(c => c.ip === d.ip)
      ));
    }

    displayConnectedDevicesTable();
    updateDeviceCount();

    addLogEntry('Scanner', `Found ${window.connectedDevices.length} connected devices`, 'success');

  } catch (error) {
    console.error('[Network Tools] Device scan error:', error);
    addLogEntry('Error', `Scan failed: ${error.message}`, 'error');
  } finally {
    window.isScanningDevices = false;
    const scanBtn = document.getElementById('scanDevicesBtn');
    if (scanBtn) {
      scanBtn.disabled = false;
      scanBtn.innerHTML = '<i class="fas fa-search"></i> Scan Devices';
    }
  }
}

function displayConnectedDevicesTable() {
  const arpContent = document.getElementById('arpDevicesContent');
  if (!arpContent) return;

  if (window.connectedDevices.length === 0) {
    arpContent.innerHTML = '<div class="empty-state">No connected devices found. Click "Scan Network" to discover all connected IPs/MACs</div>';
    return;
  }

  let html = '<table class="monitor-table"><thead><tr>' +
    '<th>IP Address</th><th>MAC Address</th><th>Hostname</th><th>Status</th>' +
    '</tr></thead><tbody>';

  window.connectedDevices.forEach(device => {
    const isYou = device.ip === (window.yourLocalIP || ''); // Set from local-info if available
    const rowClass = isYou ? 'your-device' : '';
    
    html += `<tr class="${rowClass}">
      <td style="font-family: monospace; font-weight: ${isYou ? 'bold' : 'normal'};">
        ${device.ip}${isYou ? ' (You)' : ''}
      </td>
      <td style="font-family: monospace; font-size: 0.85em;">${device.mac || '-'}</td>
      <td>${device.hostname || '-'}</td>
      <td><span class="status-up">✅ Active</span></td>
    </tr>`;
  });

  html += '</tbody></table>';
  arpContent.innerHTML = html;
}

function updateDeviceCount() {
  const countEl = document.getElementById('connectedDevicesCount');
  if (countEl) {
    countEl.textContent = window.connectedDevices.length;
  }
}

// Load local network info (for "your device" highlighting)
async function loadLocalInfo() {
  try {
    console.log('[Network Tools] Fetching local info...');
    const response = await fetch('/api/network/local-info', { headers: getAuthHeaders() });
    const result = await response.json();
    if (result.success && result.data) {
      window.yourLocalIP = result.data.yourIP;
      console.log('[Network Tools] Local IP identified:', window.yourLocalIP);
    } else {
      console.warn('[Network Tools] Local info API returned success:false or no data');
    }
  } catch (error) {
    console.warn('[Network Tools] Local info unavailable:', error.message);
  }
}

window.loadLocalInfo = loadLocalInfo;
window.scanConnectedDevices = scanConnectedDevices;
    
    // Export and Actions
async function clearCapture() {
  try {
    const confirmed = confirm('Clear all captured packets?');
    if (!confirmed) return;

    capturedPackets = [];
    filteredPackets = [];
    packetCounter = 0;
    
    displayPackets();
    updatePacketCount();
    
    await fetch('/api/network/sniffer/clear', { method: 'POST', headers: getAuthHeaders() });
    addLogEntry('System', 'All packets cleared', 'info');
  } catch (error) {
    console.error('[Network Tools] Clear capture error:', error);
  }
}


async function exportPackets() {
  try {
    if (capturedPackets.length === 0) return;
    const format = document.getElementById('exportFormat')?.value || 'json';
    window.open(`/api/sniffer/export?format=${format}&token=${localStorage.getItem('authToken')}`, '_blank');
  } catch (error) {
    console.error('[Network Tools] Export error:', error);
  }
}

// Export connected devices list
async function exportDevices() {
  if (connectedDevices.length === 0) return;
  const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify({
    timestamp: new Date().toISOString(),
    totalDevices: connectedDevices.length,
    devices: connectedDevices
  }, null, 2));
  const downloadAnchor = document.createElement('a');
  downloadAnchor.setAttribute("href", dataStr);
  downloadAnchor.setAttribute("download", `connected-devices-${Date.now()}.json`);
  downloadAnchor.click();
}

// UI Helpers
async function updateCaptureStatus() {
  try {
    const statusEl = document.getElementById('captureStatus');
    const startBtn = document.getElementById('startCaptureBtn');
    const stopBtn = document.getElementById('stopCaptureBtn');
    const modeEl = document.getElementById('captureMode');
    
    const stats = await fetchCaptureStats();
    if (stats) {
        isCapturing = stats.isCapturing;
        if (stats.lastError) {
            if (lastCaptureError !== stats.lastError) {
                lastCaptureError = stats.lastError;
                addLogEntry('Capture', `Error: ${lastCaptureError}`, 'error');
                // Force refresh packet list to show error
                displayPackets();
            }
        } else {
            lastCaptureError = null;
        }
        if (modeEl) {
            const modeText = stats.captureMode === 'none' ? '<span class="text-danger">None (Capture tools missing)</span>' : stats.captureMode;
            modeEl.innerHTML = `Mode: ${modeText}`;
        }
    }

    if (isCapturing) {
      if (statusEl) statusEl.innerHTML = '<span class="status-badge status-capturing"><i class="fas fa-circle"></i> Capturing...</span>';
      if (startBtn) startBtn.disabled = true;
      if (stopBtn) stopBtn.disabled = false;
    } else {
      if (statusEl) statusEl.innerHTML = '<span class="status-badge status-stopped"><i class="fas fa-circle"></i> Stopped</span>';
      if (startBtn) startBtn.disabled = false;
      if (stopBtn) stopBtn.disabled = true;
    }
  } catch (error) {
    console.error('[Network Tools] Status update error:', error);
  }
}

async function fetchCaptureStats() {
  try {
    const response = await fetch('/api/network/sniffer/stats', { headers: getAuthHeaders() });
    if (!response.ok) return null;
    const result = await response.json();
    return result.success ? result.data : null;
  } catch (error) {
    return null;
  }
}

function updatePacketCount() {
  const countEl = document.getElementById('packetCount');
  if (countEl) countEl.textContent = filteredPackets.length;
}

function addLogEntry(source, message, type = 'info') {
  const logEl = document.getElementById('networkToolsLog');
  if (!logEl) return;
  const entry = document.createElement('div');
  entry.className = `log-entry ${type}`;
  entry.textContent = `[${new Date().toLocaleTimeString()}] [${source}] ${message}`;
  logEl.appendChild(entry);
  logEl.scrollTop = logEl.scrollHeight;
}

function clearLog() {
    const logEl = document.getElementById('networkToolsLog');
    if (logEl) logEl.innerHTML = '<div class="log-entry info">[System] Log cleared</div>';
}

// === TCP/IP ANALYZER (NEW) ===
async function testTcpConnection() {
  const btn = document.getElementById('btnTestTcpConnection');
  const resultsPanel = document.getElementById('tcpResultsPanel');
  
  const gatewayIp = document.getElementById('tcpGatewayIp')?.value;
  const deviceIp = document.getElementById('tcpDeviceIp')?.value;
  const port = document.getElementById('tcpPort')?.value;
  const syncMarker = document.getElementById('tcpSyncMarker')?.value;

  if (!deviceIp || !port) {
    alert('Device IP and Port are required!');
    return;
  }

  if (btn) {
      btn.disabled = true;
      btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Testing Connection...';
  }
  if (resultsPanel) resultsPanel.style.display = 'block';
  
  document.getElementById('tcpGateStatus').innerHTML = '<i class="fas fa-spinner fa-spin"></i> Testing...';
  document.getElementById('tcpConnStatus').innerHTML = '<i class="fas fa-spinner fa-spin"></i> Connecting...';
  document.getElementById('tcpMarkerStatus').innerHTML = '-';
  document.getElementById('tcpRawHex').innerHTML = '<i class="fas fa-spinner fa-spin"></i> Waiting for data (Timeout max ~5s)...';

  addLogEntry('TCP Analyzer', `Testing connection to ${deviceIp}:${port}...`, 'info');

  try {
    const response = await fetch('/api/network/tcp-test', {
      method: 'POST',
      headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ gatewayIp, deviceIp, port, syncMarker })
    });
    
    const result = await response.json();
    
    if (result.success && result.data) {
      const data = result.data;
      
      // Update UI
      const gateStatusEl = document.getElementById('tcpGateStatus');
      if (gatewayIp) {
         if (data.gatewayPing) {
           gateStatusEl.innerHTML = '<span class="status-up">✅ Reachable</span>';
         } else {
           gateStatusEl.innerHTML = '<span class="status-down">❌ Unreachable</span>';
         }
      } else {
         gateStatusEl.innerHTML = '<i>Skipped</i>';
      }

      const connStatusEl = document.getElementById('tcpConnStatus');
      if (data.connected) {
         connStatusEl.innerHTML = '<span class="status-up">✅ Connected</span>';
      } else {
         connStatusEl.innerHTML = `<span class="status-down">❌ ${data.status}</span>`;
      }

      const markerStatusEl = document.getElementById('tcpMarkerStatus');
      if (data.syncMarkerValid === true) {
         markerStatusEl.innerHTML = '<span class="status-up" style="color: #2ecc71; font-weight: bold;">✅ Valid</span>';
      } else if (data.syncMarkerValid === false) {
         markerStatusEl.innerHTML = '<span class="status-down" style="color: #e74c3c; font-weight: bold;">❌ Invalid</span>';
      } else {
         markerStatusEl.innerHTML = '<i>Not Validated</i>';
      }

      document.getElementById('tcpRawHex').innerHTML = data.rawHex || '<i style="color: #888;">No string/hex payload received or connection failed.</i>';
      
      addLogEntry('TCP Analyzer', data.message || 'Test complete', data.connected ? 'success' : 'error');
    } else {
      throw new Error(result.error || result.message || 'Failed to analyze TCP connection');
    }
  } catch (err) {
    document.getElementById('tcpConnStatus').innerHTML = `<span class="status-down">❌ Error</span>`;
    document.getElementById('tcpGateStatus').innerHTML = '-';
    document.getElementById('tcpMarkerStatus').innerHTML = '-';
    document.getElementById('tcpRawHex').innerHTML = err.message;
    addLogEntry('TCP Analyzer Error', err.message, 'error');
  } finally {
    if (btn) {
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-bolt"></i> Test Connection & Analyze';
    }
  }
}

async function scanTcpPorts() {
  const deviceIp = document.getElementById('tcpDeviceIp')?.value;
  const startPort = document.getElementById('tcpPortStart')?.value;
  const endPort = document.getElementById('tcpPortEnd')?.value;

  if (!deviceIp || !startPort || !endPort) {
    alert('Device IP, Start Port, and End Port are required for scanning!');
    return;
  }

  const resultPanel = document.getElementById('tcpPortScanResult');
  const resultVal = document.getElementById('tcpOpenPortsVal');
  
  if (resultPanel) resultPanel.style.display = 'block';
  if (resultVal) resultVal.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Scanning...';
  
  // Show main panel if not visible
  const resultsPanel = document.getElementById('tcpResultsPanel');
  if (resultsPanel) resultsPanel.style.display = 'block';

  addLogEntry('Port Scanner', `Scanning ${deviceIp} ports ${startPort}-${endPort}...`, 'info');

  try {
    const response = await fetch('/api/network/tcp-scan', {
      method: 'POST',
      headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceIp, startPort, endPort })
    });
    
    const result = await response.json();
    
    if (result.success && result.data) {
      const openPorts = result.data.openPorts || [];
      if (openPorts.length > 0) {
        if (resultVal) resultVal.innerHTML = `<span style="color: #2ecc71; font-weight: bold;">${openPorts.join(', ')}</span>`;
        // Auto select the first open port
        document.getElementById('tcpPort').value = openPorts[0];
        addLogEntry('Port Scanner', `Found open ports: ${openPorts.join(', ')}`, 'success');
      } else {
        if (resultVal) resultVal.innerHTML = '<span style="color: #e74c3c;">No open ports found</span>';
        addLogEntry('Port Scanner', 'No open ports found', 'warning');
      }
    } else {
      throw new Error(result.error || result.message || 'Failed to scan ports');
    }
  } catch (err) {
    if (resultVal) resultVal.innerHTML = `<span style="color: #e74c3c;">Error: ${err.message}</span>`;
  }
}

// Global Exports
window.initNetworkTools = initNetworkTools;
window.startCapture = startCapture;
window.stopCapture = stopCapture;
window.clearCapture = clearCapture;
window.exportPackets = exportPackets;
window.filterPackets = filterPackets;
window.displayPacketDetails = displayPacketDetails;
window.clearLog = clearLog;
window.scanConnectedDevices = scanConnectedDevices;
