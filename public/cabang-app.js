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
  let sourceConfigs = [];
  const MIN_FETCH_INTERVAL_MS = 7000;
  const CACHE_VERSION = 'source-aware-2026-06-30';

  // DOM Elements
  const cabangGrid = document.getElementById('cabangGrid');
  const searchCabang = document.getElementById('searchCabang');
  const filterAirport = document.getElementById('filterCabangAirport');
  const filterCategory = document.getElementById('filterCabangCategory');
  const filterStatus = document.getElementById('filterCabangStatus');
  const refreshBtn = document.getElementById('refreshCabangBtn');

  // Initialize
  function init() {
    refreshCacheVersion();
    loadCachedSourceConfigs();
    bindEvents();
    loadAirports();
    // Load all equipment initially
    loadEquipment();
    startAutoRefresh();
  }

  function refreshCacheVersion() {
    const currentVersion = localStorage.getItem('cabang_cache_version');
    if (currentVersion === CACHE_VERSION) return;

    localStorage.removeItem('cabang_equipment_cache');
    localStorage.setItem('cabang_cache_version', CACHE_VERSION);
  }

  function normalizeList(payload) {
    if (Array.isArray(payload)) return payload;
    if (Array.isArray(payload?.data)) return payload.data;
    return [];
  }

  function loadCachedSourceConfigs() {
    try {
      sourceConfigs = normalizeList(JSON.parse(localStorage.getItem('cabang_source_config_cache') || '[]'));
    } catch (e) {
      console.warn('[Cabang] Failed to parse source config cache:', e);
      sourceConfigs = [];
    }
  }

  async function loadSourceConfigs() {
    try {
      const response = await fetch('/api/config/authentications');
      if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);

      sourceConfigs = normalizeList(await response.json());
      localStorage.setItem('cabang_source_config_cache', JSON.stringify(sourceConfigs));
    } catch (error) {
      console.warn('[Cabang] Failed loading source configs:', error);
    }
  }

  function buildPlaceholderSource(src) {
    return {
      _status: 'Disconnect',
      _logged_at: null,
      _parsing_id: src.parsing_id || null,
      _ip: src.ip_address || null
    };
  }

  function hydrateEquipmentSources(items) {
    if (!Array.isArray(items) || sourceConfigs.length === 0) return items;

    return items.map(item => {
      const matchingSources = sourceConfigs.filter(src =>
        String(src.equipt_id ?? src.equipmentId ?? '') === String(item.id)
      );

      if (matchingSources.length === 0) return item;

      const existingLastData = item.lastData && typeof item.lastData === 'object' ? item.lastData : {};
      const hydratedLastData = { ...existingLastData };

      matchingSources.forEach(src => {
        if (!src.name || hydratedLastData[src.name]) return;
        hydratedLastData[src.name] = buildPlaceholderSource(src);
      });

      return {
        ...item,
        lastData: hydratedLastData
      };
    });
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
        equipmentData = hydrateEquipmentSources(JSON.parse(cachedData));
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
      equipmentData = normalizeList(result);

      if (equipmentData.some(item => !item.lastData || Object.keys(item.lastData).length === 0)) {
        await loadSourceConfigs();
        equipmentData = hydrateEquipmentSources(equipmentData);
      }

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
      lastDataStatuses: item.lastData
        ? Object.values(item.lastData).map(src => src && src._status ? src._status : null)
        : [],
      lastDataTimes: item.lastData
        ? Object.values(item.lastData).map(src => src && src._logged_at ? src._logged_at : null)
        : []
    })));
  }

  function renderCabangGrid() {
    if (!cabangGrid) return;

    function normalizeSourceStatus(rawStatus) {
      const s = String(rawStatus || '').toLowerCase();
      if (s === 'alarm' || s === 'alert' || s === 'fail' || s === 'critical') return 'alarm';
      if (s === 'warning') return 'warning';
      if (s === 'disconnect' || s === 'offline') return 'offline';
      return 'normal';
    }

    function deriveEquipmentStatus(item) {
      if (item && item.lastData && Object.keys(item.lastData).length > 0) {
        const sourceStatuses = Object.values(item.lastData).map(src => normalizeSourceStatus(src?._status));
        
        if (sourceStatuses.every(st => st === 'alarm')) return 'alarm';
        if (sourceStatuses.every(st => st === 'offline')) return 'offline';
        if (sourceStatuses.includes('alarm') || sourceStatuses.includes('warning') || sourceStatuses.includes('offline')) return 'warning';
        return 'normal';
      }

      const fallback = String(item?.status || 'offline').toLowerCase();
      return ['normal', 'alarm', 'alert', 'warning', 'offline', 'disconnect'].includes(fallback)
        ? (fallback === 'disconnect' ? 'offline' : (fallback === 'alert' ? 'alarm' : fallback))
        : 'offline';
    }

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
      let filterVal = String(currentStatusFilter).toLowerCase();
      if (filterVal === 'alert') filterVal = 'alarm';
      if (filterVal === 'disconnect') filterVal = 'offline';
      
      filtered = filtered.filter(e => {
        const normalized = window.normalizeStatus
          ? String(window.normalizeStatus(deriveEquipmentStatus(e))).toLowerCase()
          : String(deriveEquipmentStatus(e)).toLowerCase();
        return normalized === filterVal;
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
      const status = deriveEquipmentStatus(item);
      const statusClass = ['normal', 'alarm', 'warning'].includes(status) ? status : 'offline';

      // Action Data
      let dataHtml = '';

      // Unified Data Source Table (Requested by USER)
      if (item.lastData) {
        // Ambil semua source dan urutkan berdasarkan waktu update terbaru (_logged_at)
        const sources = Object.keys(item.lastData).sort((a, b) => {
          const timeA = item.lastData[a]?._logged_at ? new Date(item.lastData[a]._logged_at).getTime() : 0;
          const timeB = item.lastData[b]?._logged_at ? new Date(item.lastData[b]._logged_at).getTime() : 0;
          return timeB - timeA; // Terbaru di atas
        });

        if (sources.length > 0) {
          const cardsHtml = sources.map(sourceName => {
            const sourceData = item.lastData[sourceName] || {};
            const srcStatus = sourceData._status || 'Normal';
            const logDate = sourceData._logged_at ? new Date(sourceData._logged_at) : null;
            const isToday = logDate && logDate.toDateString() === new Date().toDateString();
            const srcTime = logDate 
              ? logDate.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) + (isToday ? '' : ` (${logDate.toLocaleDateString('id-ID', {day:'numeric', month:'short'})})`)
              : '-';
            // Map status to color
            let dotColor = '#10b981'; // normal
            let statusClass = normalizeSourceStatus(srcStatus);
            if (statusClass === 'alarm') {
              dotColor = '#ef4444';
            } else if (statusClass === 'warning') {
              dotColor = '#f59e0b';
            } else if (statusClass === 'offline') {
              dotColor = '#94a3b8';
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
