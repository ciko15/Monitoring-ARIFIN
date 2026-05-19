/**
 * Branch/Airport Monitoring Module
 * TOC - Remote Status Facilities
 * 
 * Features:
 * - Search & Branch List Integration: Shows all branches automatically
 * - Selecting on the right side a branch shows equipment
 * - Filtering by category works dynamically
 * - Clickable equipment cards with detail panel
 */
var liveDataTimer = window.liveDataTimer;

const cabangModule = (function () {
  // State
  let airportsData = [];
  let equipmentData = [];
  let currentAirportFilter = '';
  let currentCategoryFilter = '';
  let currentStatusFilter = '';
  let searchQuery = '';
  let autoRefreshInterval = null;
  let isLoadingEquipment = false;
  let lastRenderSignature = '';
  let lastEquipmentFetchAt = 0;
  const MIN_FETCH_INTERVAL_MS = 7000;

  // DOM Elements
  const cabangGrid = document.getElementById('cabangGrid');
  const searchCabang = document.getElementById('searchCabang');
  const filterAirport = document.getElementById('filterCabangAirport');
  const filterCategory = document.getElementById('filterCabangCategory');
  const filterStatus = document.getElementById('filterCabangStatus');
  const refreshBtn = document.getElementById('refreshCabangBtn');

  // Initialize
  function init() {
    bindEvents();
    loadAirports();
    // Load all equipment initially
    loadEquipment();
    startAutoRefresh();
  }

  function bindEvents() {
    if (searchCabang) {
      searchCabang.addEventListener('input', (e) => {
        searchQuery = e.target.value.toLowerCase();
        renderCabangGrid();
      });
    }

    if (filterAirport) {
      filterAirport.addEventListener('change', (e) => {
        currentAirportFilter = e.target.value;
        renderCabangGrid();
      });
    }

    if (filterCategory) {
      filterCategory.addEventListener('change', (e) => {
        currentCategoryFilter = e.target.value;
        renderCabangGrid();
      });
    }

    if (filterStatus) {
      filterStatus.addEventListener('change', (e) => {
        currentStatusFilter = e.target.value;
        renderCabangGrid();
      });
    }

    if (refreshBtn) {
      refreshBtn.addEventListener('click', () => {
        loadEquipment(true);
      });
    }
  }

  // Auto-refresh every 20 seconds
  function startAutoRefresh() {
    if (autoRefreshInterval) clearInterval(autoRefreshInterval);
    autoRefreshInterval = setInterval(() => {
      // Only refresh if the section is visible
      const section = document.getElementById('cabangSection');
      if (section && !section.classList.contains('hidden') && document.visibilityState !== 'hidden') {
        loadEquipment(true); // silent refresh
      }
    }, 20000);
  }

  async function loadAirports() {
    try {
      const cachedAirports = localStorage.getItem('cabang_airports_cache');
      if (cachedAirports) {
        airportsData = JSON.parse(cachedAirports);
        renderAirportDropdown();
      }

      const response = await fetch('/api/airports');
      airportsData = await response.json();
      localStorage.setItem('cabang_airports_cache', JSON.stringify(airportsData));
      renderAirportDropdown();
    } catch (error) {
      console.error('[Cabang] Error loading airports:', error);
    }
  }

  function renderAirportDropdown() {
    if (filterAirport) {
      filterAirport.innerHTML = '<option value="">All Airports</option>';
      airportsData.forEach(airport => {
        const option = document.createElement('option');
        option.value = airport.id;
        option.textContent = airport.name;
        filterAirport.appendChild(option);
      });
    }
  }

  async function loadEquipment(silent = false) {
    const now = Date.now();
    if (now - lastEquipmentFetchAt < MIN_FETCH_INTERVAL_MS) {
      return;
    }

    if (isLoadingEquipment) return;
    isLoadingEquipment = true;

    // 1. Try to load from local cache first for instant UI response
    const cachedData = localStorage.getItem('cabang_equipment_cache');
    if (cachedData && !equipmentData.length) {
      try {
        equipmentData = JSON.parse(cachedData);
        window.equipmentDataCache = equipmentData;
        renderCabangGrid();
        // If we have cache, the first fetch should be silent
        silent = true;
      } catch (e) {
        console.warn('[Cabang] Failed to parse equipment cache:', e);
      }
    }

    // If data is already visible, never replace whole grid with loading spinner.
    if (equipmentData.length > 0) {
      silent = true;
    }

    if (!silent && cabangGrid) {
      cabangGrid.innerHTML = '<div class="empty-state"><i class="fas fa-spinner fa-spin"></i> Refreshing data...</div>';
    }

    try {
      const token = localStorage.getItem('authToken');
      
      const headers = { 'Content-Type': 'application/json' };
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }

      // Fetch all equipment with includeData=true
      const response = await fetch('/api/equipment?limit=1000&isActive=true&includeData=true', {
        headers: headers
      });

      if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);

      const result = await response.json();
      equipmentData = result.data || result;
      window.equipmentDataCache = equipmentData; // expose for enhancements.js

      // Save to cache for next visit
      localStorage.setItem('cabang_equipment_cache', JSON.stringify(equipmentData));
      lastEquipmentFetchAt = Date.now();

      renderCabangGrid();
    } catch (error) {
      console.error('[Cabang] Error loading equipment:', error);
      // Only show error state if we don't have any data yet
      if (cabangGrid && equipmentData.length === 0) {
        cabangGrid.innerHTML = `<div class="empty-state" style="color: var(--accent-danger);"><i class="fas fa-exclamation-triangle"></i> Error loading data</div>`;
      }
    } finally {
      isLoadingEquipment = false;
    }
  }

  function buildRenderSignature(items) {
    return JSON.stringify(items.map(item => ({
      id: item.id,
      status: item.status,
      lastUpdate: item.lastUpdate,
      lastDataKeys: item.lastData ? Object.keys(item.lastData) : [],
      lastDataTimes: item.lastData
        ? Object.values(item.lastData).map(src => src && src._logged_at ? src._logged_at : null)
        : []
    })));
  }

  function renderCabangGrid() {
    if (!cabangGrid) return;

    let filtered = equipmentData;

    // Apply Airport Filter - Robust check for both airportId and branchId
    if (currentAirportFilter) {
      const filterId = String(currentAirportFilter);
      filtered = filtered.filter(e =>
        String(e.airportId) === filterId ||
        String(e.branchId) === filterId ||
        (e.airport_id && String(e.airport_id) === filterId) ||
        (e.branch_id && String(e.branch_id) === filterId)
      );
    }

    // Apply Category Filter
    if (currentCategoryFilter) {
      const cat = String(currentCategoryFilter).trim().toLowerCase();
      filtered = filtered.filter(e => String(e.category || '').trim().toLowerCase() === cat);
    }


    // Apply Status Filter
    if (currentStatusFilter) {
      filtered = filtered.filter(e => {
        const normalized = window.normalizeStatus ? window.normalizeStatus(e.status) : e.status;
        return normalized === currentStatusFilter;
      });
    }

    // Apply Search
    if (searchQuery) {
      filtered = filtered.filter(e =>
        e.name.toLowerCase().includes(searchQuery) ||
        (e.airportName && e.airportName.toLowerCase().includes(searchQuery)) ||
        (e.code && e.code.toLowerCase().includes(searchQuery))
      );
    }

    const renderSignature = buildRenderSignature(filtered);

    if (filtered.length === 0) {
      lastRenderSignature = 'empty';
      cabangGrid.innerHTML = '<div class="empty-state">No equipment found matching the filters.</div>';
      return;
    }

    if (renderSignature === lastRenderSignature) {
      return;
    }
    lastRenderSignature = renderSignature;

    cabangGrid.innerHTML = filtered.map(item => {
      const status = (item.status || 'Offline').toLowerCase();
      const statusClass = ['normal', 'alarm', 'warning'].includes(status) ? status : 'offline';

      // Action Data
      let dataHtml = '';

      // Unified Data Source Table (Requested by USER)
      if (item.lastData) {
        // Ambil semua source dan urutkan berdasarkan waktu update terbaru (_logged_at)
        const sources = Object.keys(item.lastData).sort((a, b) => {
          const timeA = item.lastData[a]._logged_at ? new Date(item.lastData[a]._logged_at).getTime() : 0;
          const timeB = item.lastData[b]._logged_at ? new Date(item.lastData[b]._logged_at).getTime() : 0;
          return timeB - timeA; // Terbaru di atas
        });

        if (sources.length > 0) {
          const cardsHtml = sources.map(sourceName => {
            const sourceData = item.lastData[sourceName];
            const srcStatus = sourceData._status || 'Normal';
            const logDate = sourceData._logged_at ? new Date(sourceData._logged_at) : null;
            const isToday = logDate && logDate.toDateString() === new Date().toDateString();
            const srcTime = logDate 
              ? logDate.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) + (isToday ? '' : ` (${logDate.toLocaleDateString('id-ID', {day:'numeric', month:'short'})})`)
              : '-';
            // Map status to color
            let dotColor = '#10b981'; // normal
            let statusClass = srcStatus.toLowerCase();
            if (statusClass === 'alarm' || statusClass === 'fail' || statusClass === 'critical') {
              dotColor = '#ef4444';
              statusClass = 'alarm';
            } else if (statusClass === 'warning') {
              dotColor = '#f59e0b';
              statusClass = 'warning';
            } else if (statusClass === 'disconnect' || statusClass === 'offline') {
              dotColor = '#94a3b8';
              statusClass = 'offline';
            } else {
              statusClass = 'normal';
            }

            return `
              <div class="source-card ${statusClass}">
                <div class="source-card-header">
                  <div class="source-info">
                    <span class="status-dot ${statusClass}" style="background-color: ${dotColor}"></span>
                    <span class="source-name">${sourceName}</span>
                  </div>
                  <span class="status-pill ${statusClass}">${srcStatus}</span>
                </div>
                <div class="source-card-footer">
                  <span class="update-label"><i class="far fa-clock"></i></span>
                  <span class="update-time">${srcTime}</span>
                </div>
              </div>
            `;
          }).join('');

          dataHtml = `
            <div class="source-cards-container">
              <div class="source-cards-title"><i class="fas fa-layer-group"></i> DATA SOURCES</div>
              ${cardsHtml}
            </div>
          `;
        } else {
          dataHtml = `
            <div class="empty-data waiting">
              <i class="fas fa-satellite-dish fa-spin"></i>
              <span>Waiting for data collection...</span>
            </div>`;
        }
      } else {
        dataHtml = `
          <div class="empty-data waiting">
            <i class="fas fa-satellite-dish fa-spin"></i>
            <span>Waiting for data collection...</span>
          </div>`;
      }

      const lastUpdate = item.lastUpdate ? new Date(item.lastUpdate).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : 'Never';
      const location = item.airportName || item.branchName || 'Unknown Location';
      const showLocation = location !== 'Unknown Location';

      return `
        <div class="cabang-card ${statusClass}" data-id="${item.id}">
          <div class="card-top">
            <div class="card-info">
              <h3>${item.name}</h3>
              <span class="code">${item.code || ''}</span>
            </div>
            <div class="status-badge ${statusClass}">${status}</div>
          </div>
          
          ${showLocation ? `
          <div class="card-location">
            <i class="fas fa-map-marker-alt"></i>
            <span>${location}</span>
          </div>` : ''}
          
          ${dataHtml}
          
          <div class="card-footer">
            <span class="category-tag">${item.category}</span>
            <span class="last-update">Updated: ${lastUpdate}</span>
          </div>
        </div>
      `;
    }).join('');

    if (window.openSourcePanel && document.getElementById('equipmentDetailPanel')?.classList.contains('open')) {
      const selectedCard = cabangGrid.querySelector(`.cabang-card[data-id="${window.selectedEquipmentId || ''}"]`);
      if (selectedCard) selectedCard.classList.add('card-selected');
    }
  }

  // Public API to support Map Dashboard interaction
  function selectAirport(airportId) {
    if (filterAirport) {
      filterAirport.value = airportId;
      currentAirportFilter = airportId;
      renderCabangGrid();
    }
  }

  function setFilter(category) {
    if (filterCategory) {
      filterCategory.value = category;
      currentCategoryFilter = category;
      renderCabangGrid();
    }
  }

  return {
    init: init,
    loadAirports: loadAirports,
    loadEquipment: loadEquipment,
    selectAirport: selectAirport,
    setFilters: function (category, status) {
      if (category !== undefined) {
        currentCategoryFilter = category;
        if (filterCategory) filterCategory.value = category;
      }
      if (status !== undefined) {
        // Use global normalization if available, otherwise fallback to local normalization
        const normalizedStatus = typeof window.normalizeStatus === 'function'
          ? window.normalizeStatus(status)
          : status;

        currentStatusFilter = normalizedStatus;
        if (filterStatus) filterStatus.value = normalizedStatus;
      }
      // Reset search if we are coming from dashboard for a specific view
      if (category !== undefined || (status !== undefined && status !== '')) {
        searchQuery = '';
        if (searchCabang) searchCabang.value = '';
        currentAirportFilter = '';
        if (filterAirport) filterAirport.value = '';
      }
      renderCabangGrid();
    },

    refresh: () => loadEquipment()
  };
})();

// Global reference for external access
window.cabangModule = cabangModule;

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  cabangModule.init();
});
