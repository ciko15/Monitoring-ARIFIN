// SNMP Tools and Threshold Settings JavaScript Functions

var liveDataTimer = window.liveDataTimer;
const API_URL = '/api';

// ============================================
// SNMP TOOLS FUNCTIONS
// ============================================

async function testSnmpConnection() {
  const ip = document.getElementById('snmpToolIP').value.trim();
  const port = document.getElementById('snmpToolPort').value.trim() || '161';
  const community = document.getElementById('snmpToolCommunity').value.trim() || 'public';
  const oid = document.getElementById('snmpToolOID').value.trim() || '1.3.6.1.2.1.1.1.0';
  
  const resultDiv = document.getElementById('snmpToolResult');
  
  if (!ip) {
    resultDiv.innerHTML = '<div class="empty-state" style="color: #ef4444;">Please enter an IP address</div>';
    return;
  }
  
  resultDiv.innerHTML = '<div class="loading-state"><i class="fas fa-spinner fa-spin"></i> Testing SNMP connection...</div>';
  
  try {
    const response = await fetch(`${API_URL}/snmp/test`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({
        ip: ip,
        port: parseInt(port),
        community: community,
        oid: oid
      })
    });
    
    const data = await response.json();
    
    if (response.ok) {
      let html = '<div style="background: rgba(16, 185, 129, 0.1); border: 1px solid #10b981; border-radius: 8px; padding: 15px; margin-top: 15px;">';
      html += '<h4 style="color: #10b981; margin-bottom: 10px;"><i class="fas fa-check-circle"></i> Connection Successful</h4>';
      html += '<p><strong>Device:</strong> ' + ip + ':' + port + '</p>';
      html += '<p><strong>OID:</strong> <code>' + oid + '</code></p>';
      html += '<p><strong>Value:</strong> ' + (data.value || data.result || 'No data') + '</p>';
      html += '</div>';
      resultDiv.innerHTML = html;
    } else {
      resultDiv.innerHTML = '<div style="background: rgba(239, 68, 68, 0.1); border: 1px solid #ef4444; border-radius: 8px; padding: 15px; margin-top: 15px;">' +
        '<h4 style="color: #ef4444; margin-bottom: 10px;"><i class="fas fa-times-circle"></i> Connection Failed</h4>' +
        '<p>' + (data.message || data.error || 'Unknown error') + '</p>' +
        '<p style="font-size: 0.85rem; color: #6b7280; margin-top: 10px;">Check: IP address, port, and community string</p>' +
        '</div>';
    }
  } catch (error) {
    resultDiv.innerHTML = '<div style="background: rgba(239, 68, 68, 0.1); border: 1px solid #ef4444; border-radius: 8px; padding: 15px; margin-top: 15px;">' +
      '<h4 style="color: #ef4444; margin-bottom: 10px;"><i class="fas fa-exclamation-triangle"></i> Error</h4>' +
      '<p>' + error.message + '</p>' +
      '</div>';
  }
}

async function walkSnmpTree() {
  const ip = document.getElementById('snmpToolIP').value.trim();
  const port = document.getElementById('snmpToolPort').value.trim() || '161';
  const community = document.getElementById('snmpToolCommunity').value.trim() || 'public';
  const oid = document.getElementById('snmpToolOID').value.trim() || '1.3.6.1';
  
  const resultDiv = document.getElementById('snmpToolResult');
  
  if (!ip) {
    resultDiv.innerHTML = '<div class="empty-state" style="color: #ef4444;">Please enter an IP address</div>';
    return;
  }
  
  resultDiv.innerHTML = '<div class="loading-state"><i class="fas fa-spinner fa-spin"></i> Walking SNMP tree...</div>';
  
  try {
    const response = await fetch(`${API_URL}/snmp/walk`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({
        ip: ip,
        port: parseInt(port),
        community: community,
        oid: oid
      })
    });
    
    const data = await response.json();
    
    if (response.ok && data.results) {
      let html = '<div style="margin-top: 15px;">';
      html += '<h4 style="margin-bottom: 10px;"><i class="fas fa-sitemap"></i> OID Tree Results (' + data.results.length + ' items)</h4>';
      html += '<div style="max-height: 400px; overflow-y: auto; background: var(--bg-secondary); border-radius: 8px; padding: 10px;">';
      html += '<table style="width: 100%; font-size: 0.85rem;">';
      html += '<thead><tr><th>OID</th><th>Value</th></tr></thead>';
      html += '<tbody>';
      
      data.results.forEach(item => {
        html += '<tr>';
        html += '<td><code>' + item.oid + '</code></td>';
        html += '<td>' + (item.value || '-') + '</td>';
        html += '</tr>';
      });
      
      html += '</tbody></table>';
      html += '</div></div>';
      resultDiv.innerHTML = html;
    } else {
      resultDiv.innerHTML = '<div style="background: rgba(239, 68, 68, 0.1); border: 1px solid #ef4444; border-radius: 8px; padding: 15px; margin-top: 15px;">' +
        '<h4 style="color: #ef4444; margin-bottom: 10px;"><i class="fas fa-times-circle"></i> Walk Failed</h4>' +
        '<p>' + (data.message || data.error || 'Unknown error') + '</p>' +
        '</div>';
    }
  } catch (error) {
    resultDiv.innerHTML = '<div style="background: rgba(239, 68, 68, 0.1); border: 1px solid #ef4444; border-radius: 8px; padding: 15px; margin-top: 15px;">' +
      '<h4 style="color: #ef4444; margin-bottom: 10px;"><i class="fas fa-exclamation-triangle"></i> Error</h4>' +
      '<p>' + error.message + '</p>' +
      '</div>';
  }
}

async function getSnmpBulk() {
  const ip = document.getElementById('snmpToolIP').value.trim();
  const port = document.getElementById('snmpToolPort').value.trim() || '161';
  const community = document.getElementById('snmpToolCommunity').value.trim() || 'public';
  
  const resultDiv = document.getElementById('snmpToolResult');
  
  if (!ip) {
    resultDiv.innerHTML = '<div class="empty-state" style="color: #ef4444;">Please enter an IP address</div>';
    return;
  }
  
  resultDiv.innerHTML = '<div class="loading-state"><i class="fas fa-spinner fa-spin"></i> Getting SNMP bulk data...</div>';
  
  try {
    const response = await fetch(`${API_URL}/snmp/bulk`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({
        ip: ip,
        port: parseInt(port),
        community: community
      })
    });
    
    const data = await response.json();
    
    if (response.ok && data) {
      let html = '<div style="margin-top: 15px;">';
      html += '<h4 style="margin-bottom: 10px;"><i class="fas fa-list"></i> SNMP Bulk Data</h4>';
      html += '<div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 10px;">';
      
      for (const [key, value] of Object.entries(data)) {
        if (key !== 'error' && key !== 'cached') {
          html += '<div style="background: var(--bg-secondary); padding: 12px; border-radius: 6px;">';
          html += '<div style="color: var(--text-muted); font-size: 0.75rem; margin-bottom: 4px;">' + key.replace(/_/g, ' ').toUpperCase() + '</div>';
          html += '<div style="color: var(--text-primary); font-weight: 500;">' + (value.value || value) + '</div>';
          html += '</div>';
        }
      }
      
      html += '</div></div>';
      resultDiv.innerHTML = html;
    } else {
      resultDiv.innerHTML = '<div style="background: rgba(239, 68, 68, 0.1); border: 1px solid #ef4444; border-radius: 8px; padding: 15px; margin-top: 15px;">' +
        '<h4 style="color: #ef4444; margin-bottom: 10px;"><i class="fas fa-times-circle"></i> Bulk Get Failed</h4>' +
        '<p>' + (data.message || data.error || 'Unknown error') + '</p>' +
        '</div>';
    }
  } catch (error) {
    resultDiv.innerHTML = '<div style="background: rgba(239, 68, 68, 0.1); border: 1px solid #ef4444; border-radius: 8px; padding: 15px; margin-top: 15px;">' +
      '<h4 style="color: #ef4444; margin-bottom: 10px;"><i class="fas fa-exclamation-triangle"></i> Error</h4>' +
      '<p>' + error.message + '</p>' +
      '</div>';
  }
}

// ============================================
// THRESHOLD SETTINGS FUNCTIONS
// ============================================

let thresholdsData = [];

async function loadThresholdSettings() {
  const select = document.getElementById('thresholdEquipmentSelect');
  if (!select) return;

  // 🔐 cek login dulu
  const authToken = localStorage.getItem('authToken');
  if (!authToken) {
    console.log('Belum login, skip loadThresholdSettings');
    
    select.innerHTML = '<option value="">Silakan login terlebih dahulu</option>';
    return;
  }

  try {
    const response = await fetch(`${API_URL}/equipment`, {
      headers: getAuthHeaders()
    });

    // 🔥 handle 401
    if (response.status === 401) {
      console.warn('Unauthorized - redirect ke login');
      select.innerHTML = '<option value="">Session habis, silakan login</option>';
      return;
    }

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const result = await response.json();
    const equipment = result.data || result;

    // 🔥 validasi array (INI PENTING)
    if (!Array.isArray(equipment)) {
      console.error('Data equipment bukan array:', equipment);
      select.innerHTML = '<option value="">Data tidak valid</option>';
      return;
    }

    // ✅ lanjut normal
    const options = equipment
      .filter(e => e.snmp_config && e.snmp_config.enabled)
      .map(e => `<option value="${e.id}">${e.name} (${e.code})</option>`)
      .join('');

    select.innerHTML = '<option value="">Select Equipment</option>' + options;

    // Event listener
    select.addEventListener('change', async () => {
      const equipmentId = select.value;

      if (!equipmentId) return;

      await loadThresholdsForEquipment(equipmentId);
    });

  } catch (error) {
    console.error('Error loading equipment for thresholds:', error);

    select.innerHTML = '<option value="">Gagal load data</option>';
  }
}

async function loadThresholdsForEquipment(equipmentId) {
  const tableBody = document.getElementById('thresholdTableBody');
  if (!tableBody) return;
  
  tableBody.innerHTML = '<tr><td colspan="8" class="empty-state"><i class="fas fa-spinner fa-spin"></i> Loading thresholds...</td></tr>';
  
  try {
    const response = await fetch(`${API_URL}/equipment/${equipmentId}/thresholds`, {
      headers: getAuthHeaders()
    });
    
    if (response.ok) {
      thresholdsData = await response.json();
      renderThresholdTable(thresholdsData);
    } else {
      // If no thresholds exist, show empty state
      thresholdsData = [];
      renderThresholdTable([]);
    }
  } catch (error) {
    console.error('Error loading thresholds:', error);
    thresholdsData = [];
    renderThresholdTable([]);
  }
}

function renderThresholdTable(thresholds) {
  const tableBody = document.getElementById('thresholdTableBody');
  if (!tableBody) return;
  
  if (!thresholds || thresholds.length === 0) {
    tableBody.innerHTML = '<tr><td colspan="8" class="empty-state">No thresholds configured. Click "Add Threshold" to create one.</td></tr>';
    return;
  }
  
  tableBody.innerHTML = thresholds.map(t => `
    <tr>
      <td>${t.equipment_name || '-'}</td>
      <td>${t.parameter_name}</td>
      <td>${t.warning_low !== null ? t.warning_low : '-'}</td>
      <td>${t.warning_high !== null ? t.warning_high : '-'}</td>
      <td>${t.critical_low !== null ? t.critical_low : '-'}</td>
      <td>${t.critical_high !== null ? t.critical_high : '-'}</td>
      <td><span class="status-badge ${t.is_active ? 'Normal' : 'Disconnect'}">${t.is_active ? 'Active' : 'Inactive'}</span></td>
      <td>
        <div class="action-buttons">
          <button class="btn-edit" onclick="editThreshold(${t.id})" title="Edit"><i class="fas fa-edit"></i></button>
          <button class="btn-delete" onclick="deleteThreshold(${t.id})" title="Delete"><i class="fas fa-trash"></i></button>
        </div>
      </td>
    </tr>
  `).join('');
}

async function saveThreshold(thresholdData) {
  try {
    const method = thresholdData.id ? 'PUT' : 'POST';
    const url = thresholdData.id 
      ? `${API_URL}/equipment/${thresholdData.equipment_id}/thresholds/${thresholdData.id}`
      : `${API_URL}/equipment/${thresholdData.equipment_id}/thresholds`;
    
    const response = await fetch(url, {
      method: method,
      headers: getAuthHeaders(),
      body: JSON.stringify(thresholdData)
    });
    
    if (response.ok) {
      const select = document.getElementById('thresholdEquipmentSelect');
      if (select && select.value) {
        await loadThresholdsForEquipment(select.value);
      }
      return true;
    } else {
      const data = await response.json();
      showToast(data.message || 'Error saving threshold', 'error');
      return false;
    }
  } catch (error) {
    console.error('Error saving threshold:', error);
    showToast('Error saving threshold: ' + error.message, 'error');
    return false;
  }
}

async function deleteThreshold(thresholdId) {
  const confirmed = await showConfirm(
    'Hapus Threshold?', 
    'Are you sure you want to delete this threshold?',
    { type: 'danger', confirmText: 'Hapus' }
  );
  if (!confirmed) return;
  
  const select = document.getElementById('thresholdEquipmentSelect');
  const equipmentId = select ? select.value : null;
  
  if (!equipmentId) {
    showToast('Please select an equipment first', 'warning');
    return;
  }
  
  try {
    const response = await fetch(`${API_URL}/equipment/${equipmentId}/thresholds/${thresholdId}`, {
      method: 'DELETE',
      headers: getAuthHeaders()
    });
    
    if (response.ok) {
      await loadThresholdsForEquipment(equipmentId);
    } else {
      showToast('Error deleting threshold', 'error');
    }
  } catch (error) {
    console.error('Error deleting threshold:', error);
    showToast('Error deleting threshold: ' + error.message, 'error');
  }
}

function editThreshold(thresholdId) {
  const threshold = thresholdsData.find(t => t.id === thresholdId);
  if (!threshold) return;
  
  // Show edit modal or form
  const newParameterName = prompt('Parameter Name:', threshold.parameter_name);
  if (!newParameterName) return;
  
  const newWarningLow = prompt('Warning Low:', threshold.warning_low || '');
  const newWarningHigh = prompt('Warning High:', threshold.warning_high || '');
  const newCriticalLow = prompt('Critical Low:', threshold.critical_low || '');
  const newCriticalHigh = prompt('Critical High:', threshold.critical_high || '');
  
  const updatedData = {
    id: threshold.id,
    equipment_id: threshold.equipment_id,
    parameter_name: newParameterName,
    oid_key: threshold.oid_key,
    warning_low: newWarningLow ? parseFloat(newWarningLow) : null,
    warning_high: newWarningHigh ? parseFloat(newWarningHigh) : null,
    critical_low: newCriticalLow ? parseFloat(newCriticalLow) : null,
    critical_high: newCriticalHigh ? parseFloat(newCriticalHigh) : null,
    is_active: threshold.is_active
  };
  
  saveThreshold(updatedData);
}

// Initialize threshold settings when section is loaded
function initThresholdSettings() {
  console.log('[DEBUG] Initializing threshold settings...');
  loadThresholdSettings();
  
  const addBtn = document.getElementById('addThresholdBtn');
  if (addBtn) {
    addBtn.addEventListener('click', () => {
      const select = document.getElementById('thresholdEquipmentSelect');
      if (!select || !select.value) {
        showToast('Please select an equipment first', 'warning');
        return;
      }
      
      // Show add threshold form
      const parameterName = prompt('Parameter Name (e.g., temperature, humidity):');
      if (!parameterName) return;
      
      const oidKey = prompt('OID Key (must match SNMP template mapping key):');
      if (!oidKey) return;
      
      const warningLow = prompt('Warning Low (optional):');
      const warningHigh = prompt('Warning High (optional):');
      const criticalLow = prompt('Critical Low (optional):');
      const criticalHigh = prompt('Critical High (optional):');
      
      const thresholdData = {
        equipment_id: parseInt(select.value),
        parameter_name: parameterName,
        oid_key: oidKey,
        warning_low: warningLow ? parseFloat(warningLow) : null,
        warning_high: warningHigh ? parseFloat(warningHigh) : null,
        critical_low: criticalLow ? parseFloat(criticalLow) : null,
        critical_high: criticalHigh ? parseFloat(criticalHigh) : null,
        is_active: true
      };
      
      saveThreshold(thresholdData);
    });
  }
}

// Make functions available globally
window.testSnmpConnection = testSnmpConnection;
window.walkSnmpTree = walkSnmpTree;
window.getSnmpBulk = getSnmpBulk;
window.loadThresholdSettings = loadThresholdSettings;
window.loadThresholdsForEquipment = loadThresholdsForEquipment;
window.saveThreshold = saveThreshold;
window.deleteThreshold = deleteThreshold;
window.editThreshold = editThreshold;
window.initThresholdSettings = initThresholdSettings;

// ============================================
// ALTERNATIVE FUNCTION NAMES (for HTML onclick handlers)
// ============================================

// Wrapper functions for HTML onclick handlers with "2" suffix
function testSnmpConnection2() {
  console.log('[DEBUG] Test Connection clicked');
  return testSnmpConnection();
}

function walkSnmpTree2() {
  console.log('[DEBUG] Walk OID Tree clicked');
  return walkSnmpTree();
}

function getSnmpBulk2() {
  console.log('[DEBUG] Bulk Get clicked');
  return getSnmpBulk();
}

// Alternative names for some HTML sections
function testSnmpConnection2Alt() {
  console.log('[DEBUG] Test Connection (Alt) clicked');
  return testSnmpConnection();
}

function walkSnmpTree2Alt() {
  console.log('[DEBUG] Walk OID Tree (Alt) clicked');
  return walkSnmpTree();
}

// Make alternative functions available globally
window.testSnmpConnection2 = testSnmpConnection2;
window.walkSnmpTree2 = walkSnmpTree2;
window.getSnmpBulk2 = getSnmpBulk2;
window.testSnmpConnection2Alt = testSnmpConnection2Alt;
window.walkSnmpTree2Alt = walkSnmpTree2Alt;

// ============================================
// INITIALIZATION
// ============================================

// Auto-initialize when DOM is ready
document.addEventListener('DOMContentLoaded', function() {
  console.log('[DEBUG] SNMP Tools initialized');
  
  // Initialize threshold settings if the section exists
  if (document.getElementById('configSnmpToolsContent')) {
    initThresholdSettings();
  }
});

// ============================================
// PING TOOL FUNCTIONS
// ============================================

let pingIntervalId = null;
let pingResults = [];

async function startPing() {
  const ip = document.getElementById('pingToolIP')?.value?.trim();
  const interval = document.getElementById('pingToolInterval')?.value?.trim();
  const resultDiv = document.getElementById('pingToolResult');
  
  if (!ip) {
    showToast('Masukkan alamat IP terlebih dahulu', 'warning');
    return;
  }
  
  if (!interval || interval < 1 || interval > 60) {
    showToast('Interval harus antara 1-60 detik', 'warning');
    return;
  }
  
  // Show loading
  if (resultDiv) {
    resultDiv.innerHTML = '<div class="loading-state"><i class="fas fa-spinner fa-spin"></i> Memulai ping...</div>';
  }
  
  try {
    const response = await fetch('/api/ping/start', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ ip, interval: parseInt(interval) })
    });
    
    const data = await response.json();
    
    if (response.ok) {
      // Start polling for results
      pingIntervalId = setInterval(loadPingResults, 2000);
      showToast(data.message, 'success');
      
      if (resultDiv) {
        resultDiv.innerHTML = `<div style="background: rgba(16, 185, 129, 0.1); border: 1px solid #10b981; border-radius: 8px; padding: 15px;">
          <h4 style="color: #10b981; margin-bottom: 10px;"><i class="fas fa-check-circle"></i> Ping Dimulai</h4>
          <p><strong>IP:</strong> ${ip}</p>
          <p><strong>Interval:</strong> ${interval} detik</p>
          <p><strong>Status:</strong> ${data.status || 'online'}</p>
          <p><strong>Response Time:</strong> ${data.responseTime || '-'} ms</p>
        </div>`;
      }
    } else {
      showToast(data.error || 'Gagal memulai ping', 'error');
      if (resultDiv) {
        resultDiv.innerHTML = `<div style="background: rgba(239, 68, 68, 0.1); border: 1px solid #ef4444; border-radius: 8px; padding: 15px;">
          <h4 style="color: #ef4444; margin-bottom: 10px;"><i class="fas fa-times-circle"></i> Error</h4>
          <p>${data.error || 'Gagal memulai ping'}</p>
        </div>`;
      }
    }
  } catch (error) {
    console.error('[Ping] Error:', error);
    showToast('Error: ' + error.message, 'error');
  }
}

async function stopPing() {
  try {
    const response = await fetch('/api/ping/stop', {
      method: 'POST'
    });
    
    const data = await response.json();
    
    if (pingIntervalId) {
      clearInterval(pingIntervalId);
      pingIntervalId = null;
    }
    
    showToast(data.message, 'info');
    
    // Clear results display
    const resultDiv = document.getElementById('pingToolResult');
    if (resultDiv) {
      resultDiv.innerHTML = '<div class="empty-state">Ping dihentikan</div>';
    }
  } catch (error) {
    console.error('[Ping] Stop error:', error);
    showToast('Error: ' + error.message, 'error');
  }
}

async function loadPingResults() {
  try {
    const response = await fetch('/api/ping/results');
    const data = await response.json();
    
    const resultDiv = document.getElementById('pingToolResult');
    if (!resultDiv) return;
    
    if (!data.active) {
      resultDiv.innerHTML = '<div class="empty-state">Ping tidak aktif</div>';
      return;
    }
    
    const results = data.results || [];
    
    // Build results HTML
    let html = '<div style="margin-top: 15px;">';
    html += `<h4 style="margin-bottom: 10px;"><i class="fas fa-network-wired"></i> Hasil Ping ke ${data.ip}</h4>`;
    html += `<p style="color: var(--text-muted); margin-bottom: 10px;">Total hasil: ${results.length}</p>`;
    
    // Summary stats
    const online = results.filter(r => r.alive).length;
    const offline = results.filter(r => !r.alive).length;
    
    html += '<div style="display: flex; gap: 15px; margin-bottom: 15px;">';
    html += `<div style="background: rgba(16, 185, 129, 0.1); padding: 10px 15px; border-radius: 6px; flex: 1; text-align: center;">
      <div style="font-size: 1.5rem; font-weight: bold; color: #10b981;">${online}</div>
      <div style="font-size: 0.8rem; color: var(--text-muted);">Online</div>
    </div>`;
    html += `<div style="background: rgba(239, 68, 68, 0.1); padding: 10px 15px; border-radius: 6px; flex: 1; text-align: center;">
      <div style="font-size: 1.5rem; font-weight: bold; color: #ef4444;">${offline}</div>
      <div style="font-size: 0.8rem; color: var(--text-muted);">Offline</div>
    </div>`;
    html += '</div>';
    
    // Results table (last 10)
    if (results.length > 0) {
      html += '<div style="max-height: 300px; overflow-y: auto; background: var(--bg-secondary); border-radius: 8px;">';
      html += '<table style="width: 100%; font-size: 0.85rem;">';
      html += '<thead><tr><th>Waktu</th><th>Status</th><th>Response Time</th></tr></thead>';
      html += '<tbody>';
      
      const recentResults = results.slice(-10).reverse();
      recentResults.forEach(r => {
        const time = new Date(r.time).toLocaleTimeString();
        const statusClass = r.alive ? 'status-normal' : 'status-disconnect';
        const statusText = r.alive ? 'Online' : 'Offline';
        const responseTime = r.responseTime || '-';
        
        html += `<tr>
          <td>${time}</td>
          <td><span class="status-badge ${statusClass}">${statusText}</span></td>
          <td>${responseTime} ms</td>
        </tr>`;
      });
      
      html += '</tbody></table>';
      html += '</div>';
    } else {
      html += '<p style="text-align: center; padding: 20px; color: var(--text-muted);">Belum ada hasil</p>';
    }
    
    html += '</div>';
    resultDiv.innerHTML = html;
  } catch (error) {
    console.error('[Ping] Load results error:', error);
  }
}

// Make ping functions available globally
window.startPing = startPing;
window.stopPing = stopPing;
window.loadPingResults = loadPingResults;
