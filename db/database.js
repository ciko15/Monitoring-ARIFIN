const fs = require('fs');
const path = require('path');

// --- JSON CONFIG PATHS ---
const AIRPORT_CONFIG_PATH = path.join(__dirname, 'airport_config.json');
const BRANCH_PROFILE_PATH = path.join(__dirname, 'branch_profile.json');
const EQUIPMENT_CONFIG_PATH = path.join(__dirname, 'equipment_config.json');
const USERS_CONFIG_PATH = path.join(__dirname, 'users_config.json');
const PARSING_CONFIG_PATH = path.join(__dirname, 'equipment_parsing_config.json');
const SUP_CATEGORY_PATH = path.join(__dirname, 'sup_category.json');
const AUTH_CONFIG_PATH = path.join(__dirname, 'equipment_otentication_config.json');
const LIMITATION_CONFIG_PATH = path.join(__dirname, 'limitation_config.json');
const TEMPLATE_CONFIG_PATH = path.join(__dirname, 'templates_config.json');
const LOGS_DATA_PATH = path.join(__dirname, 'equipment_logs.json');
const writeLocks = new Map();
let logsPersistTimer = null;
let logsPersistPromise = null;
let logsFileMtimeMs = 0;
let logsDiskSyncAt = 0;
const LOGS_SYNC_INTERVAL_MS = 2000;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// --- PARSER PARAMETER TEMPLATES ---
// Used to show placeholders (-) when data is missing

// MARC RSE radio config (sesuai MARC_RADIO_DEFAULTS di vhf_marc_rse.js)
const MARC_RADIO_DEFAULTS = {
  2: { name: 'VHF ADC SEC RX', radio_type: 'T6R', is_rx: true },
  3: { name: 'VHF ADC SEC RX_2', radio_type: 'T6R', is_rx: true },
  4: { name: 'VHF ER TX 1', radio_type: 'T6T100', is_rx: false },
  5: { name: 'VHF ER TX 2', radio_type: 'T6T', is_rx: false },
  6: { name: 'VHF APP TMA TX', radio_type: 'T6T100', is_rx: false },
  7: { name: 'VHF APP TMA TX_2', radio_type: 'T6T100', is_rx: false },
  8: { name: 'VHF ADC TX', radio_type: 'T6T', is_rx: false },
  9: { name: 'VHF ADC TX_2', radio_type: 'T6T', is_rx: false },
};

const PARSER_TEMPLATES = {
  'vhf_t6tv': ['overall_status', 'ac_power', 'dc_power', 'dc_supply_v', 'ambient_temp', 'internal_temp', 'elapsed_time', 'status_messages', 'channel', 'rf_power_watts', 'modulation_depth', 'ptt_state', 'alc_enabled', 'audio_line_in', 'tx_timeout', 'tone_keying_freq', 'tx_power_state', 'fwd_power', 'refl_power', 'tx_level', 'mod_level', 'rx_level', 'squelch_level', 'sinad', 'audio_level', 'rx_freq', 'squelch_state', 'snmp_name', 'model', 'serial_number', 'firmware', 'equipment', 'boot_installed'],
  'vhf_t6tv_snmp': [
    // System Info
    'model', 'equipment', 'serial_number', 'firmware', 'software_version', 'boot_installed',
    'snmp_name', 'snmp_location',
    // RF Metrics
    'tx_frequency_mhz', 'tx_faults', 'tx_power_level', 'mod_error',
    'tx_enabled', 'tx_active', 'pa_status', 'antenna_status',
    'vswr_alarm', 'duty_cycle_alarm', 'elapsed_time',
    // AM Voice TX (confirmed)
    'rf_power_watts', 'modulation_depth', 'ptt_ref_voltage', 'tone_keying_freq',
    // Overall
    'overall_status',
  ],
  'dme_maru_310_320': ['txp_active', 'ident', 'txp1_m1_sys_delay', 'txp1_m1_reply_eff', 'txp1_m1_pair_rate', 'txp1_m1_fwd_power', 'txp1_m1_dur_a', 'txp1_m1_spacing', 'txp1_active', 'txp2_m1_sys_delay', 'txp2_m1_reply_eff', 'txp2_m1_pair_rate', 'txp2_m1_fwd_power', 'txp2_active'],
  'dvor_maru_220': ['mon1_carrier_power', 'mon1_rf_input', 'mon1_azimuth', 'mon1_fm_index', 'mon1_am_30hz', 'mon1_am_9960hz', 'mon1_am_1020hz', 'mon1_carrier_freq', 'mon1_ident', 'mon2_carrier_power', 'mon2_rf_input', 'mon2_azimuth', 'tx1_carrier_power', 'tx1_cpa_temp', 'tx1_az_offset', 'tx2_carrier_power', 'tx2_cpa_temp', 'lcu_dc_5v', 'lcu_dc_7v', 'lcu_dc_15v', 'lcu_dc_28v', 'lcu_ac_28v', 'tx_active'],
  'custom_1775446808830': ['m1_sys_delay', 'm1_reply_eff', 'm1_fwd_power', 'm1_5v_ps', 'm1_15v_ps', 'm1_48v_ps', 'ident'],
  'custom_1775512889323': ['latitude', 'longitude', 'altitude', 'groundSpeed', 'trackAngle'],
  'thales_llz_421': ['CRS_DDM', 'CRS_SDM', 'NF_DDM', 'NF_SDM', 'WIDTH_DDM', 'WIDTH_SDM', 'CRS_RF', 'NF_RF'],
  'ils_llz_thales421': ['tx_main', 'tx_stby', 'M1_CRS_RF', 'M1_CRS_DDM', 'M1_CRS_SDM', 'M1_IDENT_AM', 'M1_WIDTH_RF', 'M1_WIDTH_DDM', 'M1_WIDTH_SDM', 'M1_CLR_RF', 'M1_CLR_DDM', 'M1_CLR_SDM', 'M1_NF_RF', 'M1_NF_DDM', 'M1_NF_SDM', 'M1_FREQ_DEV', 'M2_CRS_RF', 'M2_CRS_DDM', 'M2_CRS_SDM', 'M2_IDENT_AM', 'M2_WIDTH_RF', 'M2_WIDTH_DDM', 'M2_WIDTH_SDM', 'M2_CLR_RF', 'M2_CLR_DDM', 'M2_CLR_SDM', 'M2_NF_RF', 'M2_NF_DDM', 'M2_NF_SDM', 'M2_FREQ_DEV'],
  'ils_gp_thales421': ['tx_main', 'tx_stby', 'GP_ANGLE', 'RF_POWER', 'DDM_COURSE', 'CARRIER_PWR', 'CSB_POWER', 'DDM_CLR', 'SBO_POWER', 'CLR_POWER', 'CLR_DDM', 'CLR_SDM', 'RF_OUT', 'DDM_MON', 'MON_POWER'],
  'pm5560_modbus': ['VL1N', 'VL2N', 'VL3N', 'VL12', 'VL23', 'VL31', 'IL1', 'IL2', 'IL3', 'KW', 'KVAR', 'KVA', 'PF', 'HZ', 'KWH'],
  'pm5350_modbus': ['connectivity', 'V_RN', 'V_SN', 'V_TN', 'V_RS', 'V_ST', 'V_TR', 'I_R', 'I_S', 'I_T', 'FREQ', 'KW', 'KVA', 'PF'],
  'diris_a20': ['const_id', 'VLL_RS', 'VLL_ST', 'VLL_TR', 'VLN_R', 'VLN_S', 'VLN_T', 'Freq', 'ArusR', 'ArusS', 'ArusT', 'reg11', 'reg12', 'reg13', 'reg14', 'PF'],
  'vhf_marc_rse': ['frequency_mhz', 'mode', 'status', 'supply_voltage', 'pa_temp_c', 'fwd_power_w', 'refl_power_w', 'modulation_pct', 'sensitivity_dbm', 'squelch_dbm', 'rx_supply_voltage'],
  'temp_humidity_modbus': ['temperature_c', 'humidity_pct', 'location'],
  'asterix_radar': ['connectivity', 'radar_name', 'sac', 'sic', 'radar_id', 'last_cat034', 'msg_type', 'time_of_day', 'sector_number', 'antenna_rotation', 'system_config'],
  'asterix_adsb': ['connectivity', 'station', 'sac', 'sic', 'radar_id', 'multicast_ip', 'last_cat021'],
  'snmp_system': [
    'connectivity',
    'sys_name',
    'resolved_ip',
    'hardware',
    'operating_system',
    'sys_object_id',
    'sys_contact',
    'sys_location',
    'processor_count',
    'cpu_usage',
    'ram_usage_pct',
    'physical_memory_usage_pct',
    'virtual_memory_usage_pct',
    'swap_usage_pct',
    'ram_available_mb',
    'ram_available_pct',
    'disk_usage_pct',
    'temperature_c',
    'temperature_sensor_name'
  ],
  'snmp_network_basic': [
    'connectivity',
    'sys_name',
    'resolved_ip',
    'hardware',
    'operating_system',
    'sys_object_id',
    'sys_contact',
    'sys_uptime',
    'sys_location',
    'interface_count',
    'active_interface_count',
    'down_interface_count',
    'active_interfaces_summary',
    'down_interfaces_summary',
    'processor_count',
    'top_interface_name',
    'top_interface_status',
    'temperature_c',
    'temperature_sensor_name'
  ],
  'default': ['Status']
};

// --- GENERIC JSON HELPERS ---
async function readJson(filePath, defaultValue = []) {
  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const file = globalThis.Bun ? globalThis.Bun.file(filePath) : null;
      if (file) {
        if (!(await file.exists())) {
          if (defaultValue !== null) await writeJson(filePath, defaultValue);
          return defaultValue;
        }
        const text = await file.text();
        return JSON.parse(text);
      }
      // Fallback to Node fs for environments without Bun (though this is a Bun app)
      if (!fs.existsSync(filePath)) {
        if (defaultValue !== null) await writeJson(filePath, defaultValue);
        return defaultValue;
      }
      const data = await fs.promises.readFile(filePath, 'utf8');
      return JSON.parse(data);
    } catch (err) {
      const isTruncatedJson = err instanceof SyntaxError && (/Unexpected end of JSON input/.test(err.message) || /JSON Parse error/.test(err.message));
      if (isTruncatedJson && attempt < maxAttempts) {
        await sleep(25 * attempt);
        continue;
      }

      console.error(`Error reading JSON from ${filePath}:`, err);
      return defaultValue;
    }
  }

  return defaultValue;
}

let onConfigUpdated = null;
function setConfigUpdateHook(hook) {
  onConfigUpdated = hook;
}

async function writeJson(filePath, data) {
  const previousWrite = writeLocks.get(filePath) || Promise.resolve();
  const currentWrite = previousWrite.then(async () => {
    try {
      const content = JSON.stringify(data, null, 2);
      const uniqueSuffix = `${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
      const tempPath = `${filePath}.${uniqueSuffix}.tmp`;

      await fs.promises.writeFile(tempPath, content, 'utf8');

      let renameSuccess = false;
      let retries = 3;
      while (!renameSuccess && retries > 0) {
        try {
          await fs.promises.rename(tempPath, filePath);
          renameSuccess = true;
        } catch (renameErr) {
          if (renameErr && (renameErr.code === 'EPERM' || renameErr.code === 'EBUSY')) {
            retries--;
            if (retries === 0) {
              // Final fallback
              await fs.promises.copyFile(tempPath, filePath);
              await fs.promises.unlink(tempPath).catch(() => { });
              renameSuccess = true;
            } else {
              await new Promise(r => setTimeout(r, 100)); // wait 100ms before retry
            }
          } else {
            throw renameErr;
          }
        }
      }
      if (renameSuccess && onConfigUpdated) {
        setTimeout(() => onConfigUpdated(filePath, data), 0);
      }
      return true;
    } catch (err) {
      console.error(`Error writing JSON to ${filePath}:`, err);
      return false;
    }
  });
  const trackedWrite = currentWrite.catch(() => false);
  writeLocks.set(filePath, trackedWrite);

  try {
    return await currentWrite;
  } finally {
    if (writeLocks.get(filePath) === trackedWrite) {
      writeLocks.delete(filePath);
    }
  }
}

// --- AIRPORT CONFIG HELPERS (ARRAY MODE) ---
async function readAirportConfig() {
  const data = await readJson(AIRPORT_CONFIG_PATH, null);
  if (Array.isArray(data)) return data;

  // Backward compatibility: If it's a single object, convert to array
  if (data && typeof data === 'object') {
    return [data];
  }

  // Default fallback if empty
  return [{
    id: 1,
    name: 'Bandara Sentani',
    city: 'Jayapura',
    lat: -2.5768,
    lng: 140.5163,
    ipBranch: '172.19.16.1',
    status: 'Normal',
    totalEquipment: 3
  }];
}

async function writeAirportConfig(data) {
  return await writeJson(AIRPORT_CONFIG_PATH, data);
}

async function readBranchProfile() {
  const airports = await readAirportConfig();
  const fallbackAirport = airports.length > 0 ? airports[0] : {};
  const fallback = {
    siteId: fallbackAirport.siteId || fallbackAirport.code || 'WAJJ',
    airportCode: fallbackAirport.code || fallbackAirport.siteId || 'WAJJ',
    airportName: fallbackAirport.name || 'Bandara Sentani',
    city: fallbackAirport.city || 'Jayapura',
    lat: fallbackAirport.lat,
    lng: fallbackAirport.lng,
    ipBranch: fallbackAirport.ipBranch,
    rabbitmq: {
      protocol: 'amqp',
      host: '172.20.17.104',
      port: 5672,
      username: 'smart-toc-hq',
      password: 'smarthq123!',
      vhost: 'dev-smart'
    },
    services: {
      producer: 'MONITORING_ARIFIN_BRANCH',
      target: 'EMS'
    }
  };

  const data = await readJson(BRANCH_PROFILE_PATH, null);
  return {
    ...fallback,
    ...(data || {}),
    rabbitmq: {
      ...fallback.rabbitmq,
      ...((data && data.rabbitmq) || {})
    },
    services: {
      ...fallback.services,
      ...((data && data.services) || {})
    }
  };
}

/**
 * Mencari file log terbaru dengan memindai folder tanggal secara mundur
 */
async function getLatestTimestampFromHistory(equipmentName) {
  try {
    const baseDir = path.resolve(__dirname, '../data');
    if (!fs.existsSync(baseDir)) return null;

    // Sanitize name sama dengan fileLogger.js
    const safeName = equipmentName.toLowerCase().replace(/[^a-z0-9\s_-]/gi, '_').replace(/\s+/g, '_').substring(0, 50);
    const fileName = `${safeName}.log`;

    // Ambil semua folder bulan (YYYY-MM), urutkan terbaru di atas
    const months = (await fs.promises.readdir(baseDir))
      .filter(f => /^\d{4}-\d{2}$/.test(f))
      .sort((a, b) => b.localeCompare(a));

    for (const month of months) {
      const monthPath = path.join(baseDir, month);
      // Ambil semua folder hari (DD), urutkan terbaru di atas
      const days = (await fs.promises.readdir(monthPath))
        .filter(f => /^\d{2}$/.test(f))
        .sort((a, b) => b.localeCompare(a));

      for (const day of days) {
        const filePath = path.join(monthPath, day, fileName);
        try {
          // Cukup gunakan modified time (mtime) dari file log tanpa perlu membaca seluruh isi file
          const stats = await fs.promises.stat(filePath);
          return stats.mtime.toISOString();
        } catch (e) {
          // File tidak ditemukan, lanjut pencarian
        }
      }
    }
  } catch (err) {
    console.error('[DB] Error scanning history:', err);
  }
  return null;
}

// --- IN-MEMORY DATA (ENRICHED WITH PERSISTENCE) ---
let equipmentLogsDB = [];
const latestEquipmentDataBySource = new Map();
const lastPersistedAtBySource = new Map();
const LOG_PERSIST_INTERVAL_MS = 60 * 1000;

const IPC_STATE_PATH = path.join(process.cwd(), 'data', 'ipc_state.json');
let lastIpcSyncTime = 0;

function rebuildLatestEquipmentData() {
  latestEquipmentDataBySource.clear();
  for (const log of equipmentLogsDB) {
    upsertLatestEquipmentData(log);
  }
  // Paksa IPC sync untuk membaca ulang file state karena memory baru saja di-wipe
  lastIpcSyncTime = 0;
}

// Load logs from file on startup
(async () => {
  try {
    if (fs.existsSync(LOGS_DATA_PATH)) {
      const data = fs.readFileSync(LOGS_DATA_PATH, 'utf8');
      equipmentLogsDB = JSON.parse(data);
      const stats = fs.statSync(LOGS_DATA_PATH);
      logsFileMtimeMs = stats.mtimeMs || 0;
      logsDiskSyncAt = Date.now();
      rebuildLatestEquipmentData();
      console.log(`[DB] Persistent logs loaded: ${equipmentLogsDB.length} records`);
    }
  } catch (err) {
    console.error('[DB] Failed to load persistent logs:', err);
  }
})();

async function syncEquipmentLogsFromDisk(force = false) {
  try {
    const now = Date.now();
    if (!force && now - logsDiskSyncAt < LOGS_SYNC_INTERVAL_MS) {
      return;
    }

    logsDiskSyncAt = now;
    const stats = await fs.promises.stat(LOGS_DATA_PATH).catch(() => null);
    if (!stats) return;

    const mtimeMs = stats.mtimeMs || 0;
    if (!force && mtimeMs <= logsFileMtimeMs) {
      return;
    }

    let data = null;
    let retries = 3;
    while (!data && retries > 0) {
      try {
        data = await fs.promises.readFile(LOGS_DATA_PATH, 'utf8');
      } catch (err) {
        if (err.code === 'EBUSY' || err.code === 'EPERM') {
          retries--;
          if (retries === 0) throw err;
          await new Promise(r => setTimeout(r, 100));
        } else {
          throw err;
        }
      }
    }

    try {
      equipmentLogsDB = JSON.parse(data);
      rebuildLatestEquipmentData();
    } catch (parseErr) {
      console.error(`[DB] JSON Parse error in equipment_logs.json: ${parseErr.message}`);
      // Jika file corrupt (misal terputus tengah jalan), reset array kosong
      equipmentLogsDB = [];
    }
    logsFileMtimeMs = mtimeMs;
  } catch (err) {
    console.error('[DB] Failed syncing logs from disk:', err);
  }
}

function scheduleEquipmentLogsPersist() {
  if (logsPersistTimer) return;

  logsPersistTimer = setTimeout(async () => {
    logsPersistTimer = null;

    try {
      if (logsPersistPromise) {
        await logsPersistPromise;
      }

      logsPersistPromise = writeJson(LOGS_DATA_PATH, equipmentLogsDB)
        .then(async () => {
          const stats = await fs.promises.stat(LOGS_DATA_PATH).catch(() => null);
          if (stats) {
            logsFileMtimeMs = stats.mtimeMs || logsFileMtimeMs;
          }
          logsDiskSyncAt = Date.now();
        })
        .finally(() => {
          logsPersistPromise = null;
        });

      await logsPersistPromise;
    } catch (err) {
      console.error('[DB] Failed persisting equipment logs:', err);
    }
  }, 500);
}

function buildEquipmentSourceKey(equipmentId, sourceName) {
  return `${equipmentId}_${sourceName || 'default'}`;
}



function syncIpcStateForWeb() {
  if (process.env.SERVICE_ROLE === 'web' || !process.env.SERVICE_ROLE) {
    try {
      if (fs.existsSync(IPC_STATE_PATH)) {
        const stats = fs.statSync(IPC_STATE_PATH);
        // Only read if file has been modified to save CPU
        if (stats.mtimeMs > lastIpcSyncTime) {
          const content = fs.readFileSync(IPC_STATE_PATH, 'utf8');
          const stateObj = JSON.parse(content);

          // JANGAN .clear() karena akan menghapus data dari syncEquipmentLogsFromDisk!
          // latestEquipmentDataBySource.clear();

          for (const key of Object.keys(stateObj)) {
            latestEquipmentDataBySource.set(key, stateObj[key]);
          }

          lastIpcSyncTime = stats.mtimeMs;
        }
      }
    } catch (e) {
      // console.error('[DB] Error reading/parsing IPC_STATE_PATH:', e.message);
    }
  }
}

function upsertLatestEquipmentData(log) {
  const key = buildEquipmentSourceKey(log.equipmentId, log.source);
  latestEquipmentDataBySource.set(key, log);

  // Update lightweight IPC file so Web process can read it
  if (process.env.SERVICE_ROLE === 'collector' || !process.env.SERVICE_ROLE) {
    try {
      const stateObj = Object.fromEntries(latestEquipmentDataBySource);
      const fs = require('fs');
      const path = require('path');
      const dataDir = path.dirname(IPC_STATE_PATH);
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
      }
      fs.writeFileSync(IPC_STATE_PATH, JSON.stringify(stateObj));
    } catch (e) {
      console.error('[DB] Error writing IPC_STATE_PATH:', e.message);
    }
  }
}


function getLatestLogsBySource(equipmentId) {
  syncIpcStateForWeb(); // Sync memory before serving UI

  const result = [];
  for (const [key, log] of latestEquipmentDataBySource.entries()) {
    if (String(log.equipmentId) === String(equipmentId)) {
      result.push(log);
    }
  }
  return result;
}
let surveillanceStationsDB = [];
let radarTargetsDB = [];
let adsbAircraftDB = [];
let surveillanceLogsDB = [];

// --- HELPER WRAPPER (DEPRECATED) ---
async function query(sql, params = []) {
  console.log('[JSON DB] MySQL query call ignored:', sql);
  return [];
}

// --- AIRPORTS ---
async function getAllAirports() {
  return await readAirportConfig();
}

async function getAirportsPaginated(options = {}) {
  const airports = await readAirportConfig();
  return {
    data: airports,
    meta: {
      total: airports.length,
      page: 1,
      limit: 50,
      totalPages: 1
    }
  };
}

async function getAirportById(id) {
  const airports = await readAirportConfig();
  return airports.find(a => a.id == id) || null;
}

async function createAirport(data) {
  const airports = await readAirportConfig();
  const newId = airports.length > 0 ? Math.max(...airports.map(a => a.id)) + 1 : 1;
  const newAirport = { id: newId, ...data };
  airports.push(newAirport);
  await writeAirportConfig(airports);
  return newAirport;
}

async function updateAirport(id, data) {
  const airports = await readAirportConfig();
  const index = airports.findIndex(a => a.id == id);
  if (index !== -1) {
    airports[index] = { ...airports[index], ...data };
    await writeAirportConfig(airports);
    return airports[index];
  }
  return null;
}

async function deleteAirport(id) {
  let airports = await readAirportConfig();
  const initialLength = airports.length;
  airports = airports.filter(a => a.id != id);
  if (airports.length !== initialLength) {
    await writeAirportConfig(airports);
    return true;
  }
  return false;
}

// --- EQUIPMENT ---
async function getAllEquipment(filters = {}) {
  if (filters.includeData) {
    await syncEquipmentLogsFromDisk();
  }

  const equipmentList = await readJson(EQUIPMENT_CONFIG_PATH);
  let filtered = [...equipmentList];

  if (filters.category) {
    filtered = filtered.filter(e => e.category === filters.category);
  }

  if (filters.airportId) {
    filtered = filtered.filter(e => e.airportId == filters.airportId);
  }

  if (filters.isActive !== undefined && filters.isActive !== 'all') {
    const activeFilter = (filters.isActive === true || filters.isActive === 'true');
    filtered = filtered.filter(e => (e.isActive === true || e.isActive === 'true') === activeFilter);
  }

  const page = filters.page || 1;
  const limit = filters.limit || 1000;
  const offset = (page - 1) * limit;

  const resultData = filtered.slice(offset, offset + limit);

  // Enrich with latest data if requested
  if (filters.includeData) {
    const allSources = await readJson(AUTH_CONFIG_PATH);
    const fileLogger = require('../src/utils/fileLogger'); // Import fileLogger helper

    for (const item of resultData) {
      // 1. Dapatkan log terakhir dari memori (untuk kecepatan)
      const latestLogs = getLatestLogsBySource(item.id);

      // 2. Jika log memori kosong, scan folder /data/ secara mundur
      let latestTimeFromFile = null;
      if (latestLogs.length === 0) {
        latestTimeFromFile = await getLatestTimestampFromHistory(item.name);
      }

      // Initialize with ALL configured sources for this equipment
      const mergedData = {};
      const configSources = allSources.filter(s => String(s.equipt_id) === String(item.id));

      for (const src of configSources) {
        if (src.parsing_id === 'vhf_marc_rse') {
          // MARC RSE: 1 source = 1 radio — placeholder berdasarkan port pertama di marc_ports
          const marcPorts = Array.isArray(src.marc_ports) ? src.marc_ports : [];
          const port = marcPorts[0];
          const radioInfo = port ? MARC_RADIO_DEFAULTS[parseInt(port)] : null;
          const rxTemplate = ['frequency_mhz', 'sensitivity_dbm', 'squelch_dbm', 'rx_supply_voltage'];
          const txTemplate = ['frequency_mhz', 'mode', 'status', 'supply_voltage', 'pa_temp_c', 'fwd_power_w', 'refl_power_w', 'modulation_pct'];
          const isRx = radioInfo ? radioInfo.is_rx : false;
          const template = isRx ? rxTemplate : txTemplate;
          const placeholderData = {};
          template.forEach(key => { placeholderData[key] = '-'; });
          // Key = src.name (nama source = nama radio)
          mergedData[src.name] = {
            ...placeholderData,
            radio_type: radioInfo ? radioInfo.radio_type : '—',
            is_rx: isRx,
            _status: 'Disconnect',
            _logged_at: null,
            _parsing_id: 'vhf_marc_rse'
          };
        } else {
          const template = PARSER_TEMPLATES[src.parsing_id] || PARSER_TEMPLATES['default'];
          const placeholderData = {};
          template.forEach(key => {
            placeholderData[key] = '-';
          });
          mergedData[src.name] = {
            ...placeholderData,
            _status: 'Disconnect', // Default until data arrives
            _logged_at: null,
            _parsing_id: src.parsing_id || null
          };
        }
      }

      let latestTime = null;
      if (latestLogs.length > 0) {
        const now = Date.now();
        for (const log of latestLogs) {
          const sourceName = log.source || 'default';
          const logTime = new Date(log.logged_at).getTime();
          const isTimedOut = (now - logTime) > (4 * 60 * 1000); // 4 minutes (consistent with watchdog)

          if (isTimedOut) {
            // Timeout: mark the source disconnected but retain last known values.
            mergedData[sourceName] = {
              ...mergedData[sourceName],
              ...(log.data || {}),
              _status: 'Disconnect',
              _stale: true,
              _logged_at: log.logged_at
            };
          } else {
            // Valid fresh data
            mergedData[sourceName] = {
              ...mergedData[sourceName],
              ...(log.data || {}),
              _status: log.status || 'Normal',
              _stale: false,
              _logged_at: log.logged_at
            };
          }

          if (!latestTime || new Date(log.logged_at) > new Date(latestTime)) {
            latestTime = log.logged_at;
          }
        }
      }

      // Only keep sources that are explicitly configured
      const finalMergedData = {};
      const configSourceNames = configSources.map(s => s.name);

      for (const src of configSources) {
        // Ambil data yang sudah ada (mungkin isi placeholder '-')
        const sourceLog = mergedData[src.name] || {};

        // JIKA waktu log kosong, paksa gunakan waktu dari scan history /data/
        if (!sourceLog._logged_at) {
          sourceLog._logged_at = latestTimeFromFile;
        }

        finalMergedData[src.name] = {
          ...sourceLog,
          _status: sourceLog._status || 'Disconnect'
        };
      }

      item.lastData = finalMergedData;
      // Gunakan waktu dari file jika lebih baru atau jika data log memori kosong
      item.lastUpdate = latestTime || latestTimeFromFile;
      item.UTC_Time = item.lastUpdate ? new Date(item.lastUpdate).toISOString() : null;

      // Real-time Status Aggregation (Refined logic for issue requirements)
      const sourceStatuses = Object.values(finalMergedData).map((src) => String(src._status).toLowerCase());
      if (sourceStatuses.length > 0) {
        if (sourceStatuses.some(s => s === 'alert' || s === 'alarm' || s === 'fail' || s === 'critical')) {
          item.status = 'Alert';
        } else if (sourceStatuses.some(s => s === 'warning')) {
          item.status = 'Warning';
        } else if (sourceStatuses.every(s => s === 'disconnect' || s === 'offline')) {
          item.status = 'Disconnect';
        } else if (sourceStatuses.some(s => s === 'disconnect' || s === 'offline')) {
          item.status = 'Warning';
        } else {
          item.status = 'Normal';
        }
      }
    }
  }

  return {
    data: resultData,
    total: filtered.length,
    pagination: { page, limit, total: filtered.length, totalPages: Math.ceil(filtered.length / limit) }
  };
}

/**
 * Helper to get the latest log for each source of an equipment
 */
function getLatestLogsBySource(equipmentId) {
  const result = [];
  for (const [key, log] of latestEquipmentDataBySource.entries()) {
    if (String(log.equipmentId) === String(equipmentId)) {
      result.push(log);
    }
  }
  return result;
}

async function getEquipmentStatsSummary() {
  const result = await getAllEquipment({
    isActive: true,
    includeData: true,
    page: 1,
    limit: 10000
  });
  const equipmentList = result.data || [];

  const stats = {
    total: equipmentList.length,
    statuses: [
      { status: 'Normal', count: equipmentList.filter(e => e.status === 'Normal').length },
      { status: 'Warning', count: equipmentList.filter(e => e.status === 'Warning').length },
      { status: 'Alert', count: equipmentList.filter(e => e.status === 'Alert').length },
      { status: 'Disconnect', count: equipmentList.filter(e => e.status === 'Disconnect').length }
    ],
    categories: [
      { category: 'Communication', count: equipmentList.filter(e => e.category === 'Communication').length },
      { category: 'Navigation', count: equipmentList.filter(e => e.category === 'Navigation').length },
      { category: 'Surveillance', count: equipmentList.filter(e => e.category === 'Surveillance').length },
      { category: 'Data Processing', count: equipmentList.filter(e => e.category === 'Data Processing').length },
      { category: 'Support', count: equipmentList.filter(e => e.category === 'Support').length }
    ]
  };
  return stats;
}

async function getEquipmentById(id) {
  await syncEquipmentLogsFromDisk();

  const list = await readJson(EQUIPMENT_CONFIG_PATH);
  const item = list.find(e => String(e.id) === String(id));
  if (!item) return null;

  const allSources = await readJson(AUTH_CONFIG_PATH);
  const configSources = allSources.filter(s => String(s.equipt_id) === String(id));

  const latestLogs = getLatestLogsBySource(id);
  const mergedData = {};

  // Fill with configured sources first
  for (const src of configSources) {
    const template = PARSER_TEMPLATES[src.parsing_id] || PARSER_TEMPLATES['default'];
    const placeholder = {};
    template.forEach(k => { placeholder[k] = '-'; });
    mergedData[src.name] = { ...placeholder, _status: 'Disconnect', _logged_at: null, _parsing_id: src.parsing_id };
  }

  // Overlay with real logs
  const now = Date.now();
  for (const log of latestLogs) {
    const sourceName = log.source || 'default';
    if (mergedData[sourceName]) {
      const logTime = new Date(log.logged_at).getTime();
      const isTimedOut = (now - logTime) > (4 * 60 * 1000); // 4 minutes

      if (isTimedOut) {
        mergedData[sourceName] = {
          ...mergedData[sourceName],
          _status: 'Disconnect',
          _stale: true,
          _logged_at: log.logged_at,
          _parsing_id: log.parsing_id || mergedData[sourceName]._parsing_id
        };
      } else {
        mergedData[sourceName] = {
          ...mergedData[sourceName],
          ...log.data,
          _status: log.status,
          _stale: false,
          _logged_at: log.logged_at,
          _parsing_id: log.parsing_id || mergedData[sourceName]._parsing_id
        };
      }
    }
  }

  // Only keep sources that are explicitly configured
  const finalMergedData = {};
  for (const src of configSources) {
    finalMergedData[src.name] = mergedData[src.name];
  }

  item.lastData = finalMergedData;
  return item;
}

async function createEquipment(data) {
  let equipmentList = await readJson(EQUIPMENT_CONFIG_PATH);
  const newEquip = {
    ...data,
    id: data.id || Date.now(),
    status: data.status || 'Normal',
    merk: data.merk || '-',
    type: data.type || '-',
    lat: parseFloat(data.lat) || 0,
    lng: parseFloat(data.lng) || 0,
    isActive: data.isActive !== undefined ? (data.isActive === true || data.isActive === 'true') : true
  };
  equipmentList.push(newEquip);
  await writeJson(EQUIPMENT_CONFIG_PATH, equipmentList);
  return newEquip;
}

async function updateEquipment(id, data) {
  let equipmentList = await readJson(EQUIPMENT_CONFIG_PATH);
  const index = equipmentList.findIndex(e => e.id == id);
  if (index !== -1) {
    const updated = {
      ...equipmentList[index],
      ...data,
      lat: data.lat !== undefined ? parseFloat(data.lat) : equipmentList[index].lat,
      lng: data.lng !== undefined ? parseFloat(data.lng) : equipmentList[index].lng,
      isActive: data.isActive !== undefined ? (data.isActive === true || data.isActive === 'true') : equipmentList[index].isActive
    };
    equipmentList[index] = updated;
    await writeJson(EQUIPMENT_CONFIG_PATH, equipmentList);
    return updated;
  }
  return null;
}

async function updateEquipmentStatus(id, status) {
  let equipmentList = await readJson(EQUIPMENT_CONFIG_PATH);
  const index = equipmentList.findIndex(e => e.id == id);
  if (index !== -1) {
    equipmentList[index].status = status;
    await writeJson(EQUIPMENT_CONFIG_PATH, equipmentList);
  }
}

async function deleteEquipment(id) {
  let equipmentList = await readJson(EQUIPMENT_CONFIG_PATH);
  const newList = equipmentList.filter(e => e.id != id);
  await writeJson(EQUIPMENT_CONFIG_PATH, newList);
}

// --- EQUIPMENT PARSING CONFIGS (PREVIOUSLY SNMP TEMPLATES) ---
async function getAllParsingConfigs() {
  const configs = await readJson(PARSING_CONFIG_PATH);
  return configs;
}

async function getParsingConfigById(id) {
  const configs = await readJson(PARSING_CONFIG_PATH);
  return configs.find(c => c.id == id || c.name == id) || null;
}

async function createParsingConfig(data) {
  let configs = await readJson(PARSING_CONFIG_PATH);
  const newCfg = {
    id: data.id || `custom_${Date.now()}`,
    name: data.name,
    category: data.category || '',
    files: data.files || '',
    createdAt: new Date().toISOString()
  };
  configs.push(newCfg);
  await writeJson(PARSING_CONFIG_PATH, configs);
  return newCfg;
}

async function updateParsingConfig(id, data) {
  let configs = await readJson(PARSING_CONFIG_PATH);
  const index = configs.findIndex(c => c.id == id);
  if (index !== -1) {
    configs[index] = { ...configs[index], ...data, updatedAt: new Date().toISOString() };
    await writeJson(PARSING_CONFIG_PATH, configs);
    return configs[index];
  }
  return null;
}

async function deleteParsingConfig(id) {
  let configs = await readJson(PARSING_CONFIG_PATH);
  const newList = configs.filter(c => c.id != id);
  await writeJson(PARSING_CONFIG_PATH, newList);
  return true;
}

// --- SNMP TEMPLATES (FOR CONFIGURATION MENU) ---
async function getAllSnmpTemplates() {
  return await readJson(TEMPLATE_CONFIG_PATH);
}

async function getSnmpTemplateById(id) {
  const templates = await readJson(TEMPLATE_CONFIG_PATH);
  return templates.find(t => t.id == id) || null;
}

async function createSnmpTemplate(data) {
  let templates = await readJson(TEMPLATE_CONFIG_PATH);
  const newTgl = {
    ...data,
    id: data.id || `custom_${Date.now()}`,
    createdAt: new Date().toISOString()
  };
  templates.push(newTgl);
  await writeJson(TEMPLATE_CONFIG_PATH, templates);
  return newTgl;
}

async function updateSnmpTemplate(id, data) {
  let templates = await readJson(TEMPLATE_CONFIG_PATH);
  const index = templates.findIndex(t => t.id == id);
  if (index !== -1) {
    templates[index] = { ...templates[index], ...data, updatedAt: new Date().toISOString() };
    await writeJson(TEMPLATE_CONFIG_PATH, templates);
    return templates[index];
  }
  return null;
}

async function deleteSnmpTemplate(id) {
  let templates = await readJson(TEMPLATE_CONFIG_PATH);
  const newList = templates.filter(t => t.id != id);
  await writeJson(TEMPLATE_CONFIG_PATH, newList);
  return true;
}

// --- SUP CATEGORIES ---
async function getAllSupCategories() {
  return await readJson(SUP_CATEGORY_PATH);
}

async function getSupCategoriesByCategory(category) {
  const data = await readJson(SUP_CATEGORY_PATH);
  if (!category) return data;
  return data.find(c => c.category === category) || { category, sub_categories: [] };
}

async function createSupCategory(data) {
  let list = await readJson(SUP_CATEGORY_PATH);
  const newItem = {
    id: Date.now(),
    category: data.category,
    sub_categories: data.sub_categories || []
  };
  list.push(newItem);
  await writeJson(SUP_CATEGORY_PATH, list);
  return newItem;
}

async function deleteSupCategory(id) {
  let data = await readJson(SUP_CATEGORY_PATH);
  // Support deletion by id or category name
  const newList = data.filter(c => c.id != id && c.category !== id);
  await writeJson(SUP_CATEGORY_PATH, newList);
  return true;
}

async function updateSupCategory(category, subCategories) {
  let data = await readJson(SUP_CATEGORY_PATH);
  const index = data.findIndex(c => c.category === category);
  if (index !== -1) {
    data[index].sub_categories = subCategories;
  } else {
    data.push({ category, sub_categories: subCategories });
  }
  await writeJson(SUP_CATEGORY_PATH, data);
  return true;
}

// --- EQUIPMENT OTENTICATION (IP COMPONENTS) ---
async function getAllOtentication() {
  return await readJson(AUTH_CONFIG_PATH);
}

async function getOtenticationByEquipment(equipmentId) {
  const data = await readJson(AUTH_CONFIG_PATH);
  return data.filter(a => a.equipt_id == equipmentId);
}

async function syncEquipmentDataSourceRelation(equipmentId, sourceData) {
  const equipmentList = await readJson(EQUIPMENT_CONFIG_PATH);
  const equipmentIndex = equipmentList.findIndex(e => String(e.id) === String(equipmentId));

  if (equipmentIndex === -1) {
    return null;
  }

  const equipment = equipmentList[equipmentIndex];
  const currentSources = Array.isArray(equipment.dataSources) ? equipment.dataSources : [];
  const nextSource = {
    id: sourceData.id,
    name: sourceData.name || 'Source',
    ip: sourceData.ip_address || null,
    port: sourceData.tcp_port || sourceData.udp_port || sourceData.snmp_port || null,
    parser: sourceData.parsing_id || null,
    enabled: true
  };

  const mergedSources = currentSources.filter(src => String(src.id) !== String(sourceData.id));
  mergedSources.push(nextSource);

  equipmentList[equipmentIndex] = {
    ...equipment,
    dataSources: mergedSources,
    category: equipment.category || 'Support',
    sup_category: equipment.sup_category || null
  };

  await writeJson(EQUIPMENT_CONFIG_PATH, equipmentList);
  return equipmentList[equipmentIndex];
}

async function createOtentication(data) {
  let authList = await readJson(AUTH_CONFIG_PATH);
  const { id: passedId, ...sourceData } = data || {};
  const newItem = {
    id: passedId || (Date.now() + Math.floor(Math.random() * 1000)),
    name: sourceData.name || 'Source',
    equipt_id: sourceData.equipt_id || null,
    ip_address: sourceData.ip_address ?? sourceData.ip ?? null,
    tcp_port: sourceData.tcp_port || null,
    udp_port: sourceData.udp_port || null,
    parsing_id: sourceData.parsing_id || null,
    sup_category: sourceData.sup_category || null,
    latitude: sourceData.latitude !== undefined ? parseFloat(sourceData.latitude) : null,
    longitude: sourceData.longitude !== undefined ? parseFloat(sourceData.longitude) : null,
    ...sourceData,
  };
  authList.push(newItem);
  await writeJson(AUTH_CONFIG_PATH, authList);
  await syncEquipmentDataSourceRelation(newItem.equipt_id, newItem);
  return newItem;
}

async function updateOtentication(id, data) {
  let list = await readJson(AUTH_CONFIG_PATH);
  const index = list.findIndex(a => String(a.id) === String(id));
  if (index !== -1) {
    const merged = {
      ...list[index],
      ...data,
      id: list[index].id,
      equipt_id: data.equipt_id !== undefined ? data.equipt_id : list[index].equipt_id,
      ip_address: data.ip_address !== undefined ? data.ip_address : list[index].ip_address,
      tcp_port: data.tcp_port !== undefined ? data.tcp_port : list[index].tcp_port,
      udp_port: data.udp_port !== undefined ? data.udp_port : list[index].udp_port,
      parsing_id: data.parsing_id !== undefined ? data.parsing_id : list[index].parsing_id,
      sup_category: data.sup_category !== undefined ? data.sup_category : list[index].sup_category,
      latitude: data.latitude !== undefined ? parseFloat(data.latitude) : list[index].latitude,
      longitude: data.longitude !== undefined ? parseFloat(data.longitude) : list[index].longitude,
    };
    list[index] = merged;
    await writeJson(AUTH_CONFIG_PATH, list);
    if (list[index].equipt_id) {
      await syncEquipmentDataSourceRelation(list[index].equipt_id, list[index]);
    }
    return list[index];
  }
  return null;
}

async function deleteOtentication(id) {
  let list = await readJson(AUTH_CONFIG_PATH);
  const newList = list.filter(a => a.id != id);
  await writeJson(AUTH_CONFIG_PATH, newList);
}

async function deleteOtenticationByEquipment(equipmentId) {
  let authList = await readJson(AUTH_CONFIG_PATH);
  const newList = authList.filter(a => a.equipt_id != equipmentId);
  await writeJson(AUTH_CONFIG_PATH, newList);
}

// --- LIMITATION CONFIGS ---
async function getAllLimitations() {
  return await readJson(LIMITATION_CONFIG_PATH);
}

async function getLimitationsByEquipment(equipmentId) {
  const equipment = await getEquipmentById(equipmentId);
  if (!equipment) return [];

  const data = await readJson(LIMITATION_CONFIG_PATH, []);
  const targetSup = String(equipment.sup_category || '').toLowerCase();
  return data.filter(l => {
    const limitSup = String(l.sup_category || '').toLowerCase();
    return (!targetSup || limitSup === targetSup || limitSup === 'generic' || limitSup === 'all' || limitSup === '*');
  });
}

async function createLimitation(data) {
  console.log('[DB] createLimitation received data:', JSON.stringify(data, null, 2));
  let list = await readJson(LIMITATION_CONFIG_PATH);
  const item = {
    id: Date.now(),
    name: data.name,
    category: data.category,
    sup_category: data.sup_category,
    value: data.value,
    value_type: data.value_type || 'numeric', // numeric, string, percent
    // New descriptive limit fields
    min_warning_limit: data.min_warning_limit,
    min_alarm_limit: data.min_alarm_limit,
    max_warning_limit: data.max_warning_limit,
    max_alarm_limit: data.max_alarm_limit,
    // Keep legacy for backward compatibility
    wlv: data.min_warning_limit || data.wlv,
    alv: data.min_alarm_limit || data.alv,
    whv: data.max_warning_limit || data.whv,
    ahv: data.max_alarm_limit || data.ahv,
    expected_value: data.expected_value || null
  };
  list.push(item);
  await writeJson(LIMITATION_CONFIG_PATH, list);
  return item;
}

async function updateLimitation(id, data) {
  console.log(`[DB] updateLimitation received id: ${id}, data:`, JSON.stringify(data, null, 2));
  let list = await readJson(LIMITATION_CONFIG_PATH);
  const index = list.findIndex(l => l.id == id || l.equipt_id == id);

  if (index !== -1) {
    // Clean up technical fields from frontend
    const { configType, configId, configMode, ...cleanData } = data;

    // Sync legacy fields if new ones are provided
    if (cleanData.min_warning_limit) cleanData.wlv = cleanData.min_warning_limit;
    if (cleanData.min_alarm_limit) cleanData.alv = cleanData.min_alarm_limit;
    if (cleanData.max_warning_limit) cleanData.whv = cleanData.max_warning_limit;
    if (cleanData.max_alarm_limit) cleanData.ahv = cleanData.max_alarm_limit;

    list[index] = { ...list[index], ...cleanData };
    await writeJson(LIMITATION_CONFIG_PATH, list);
    return list[index];
  }
  return null;
}

async function deleteLimitation(id) {
  let list = await readJson(LIMITATION_CONFIG_PATH);
  const newList = list.filter(l => l.id != id);
  await writeJson(LIMITATION_CONFIG_PATH, newList);
}

// --- USERS ---
async function getAllUsers() {
  return await readJson(USERS_CONFIG_PATH);
}

async function getUserById(id) {
  const users = await readJson(USERS_CONFIG_PATH);
  return users.find(u => u.id == id) || null;
}

async function getUserByUsername(username) {
  const users = await readJson(USERS_CONFIG_PATH);
  return users.find(u => u.username === username) || null;
}

async function createUser(data) {
  let users = await readJson(USERS_CONFIG_PATH);

  // Hash password before saving
  const hashedPassword = await (globalThis.Bun ? globalThis.Bun.password.hash(data.password) : data.password);

  const newUser = {
    ...data,
    password: hashedPassword,
    id: Date.now()
  };

  users.push(newUser);
  await writeJson(USERS_CONFIG_PATH, users);
  return newUser;
}

async function updateUser(id, data) {
  let users = await readJson(USERS_CONFIG_PATH);
  const index = users.findIndex(u => u.id == id);
  if (index !== -1) {
    const updatedData = { ...data };

    // Hash password if it's being updated
    if (data.password) {
      updatedData.password = await (globalThis.Bun ? globalThis.Bun.password.hash(data.password) : data.password);
    }

    users[index] = { ...users[index], ...updatedData, id: Number(id) };
    await writeJson(USERS_CONFIG_PATH, users);
    return users[index];
  }
  return null;
}

async function verifyUser(username, password) {
  const user = await getUserByUsername(username);
  if (!user) return null;

  if (globalThis.Bun) {
    try {
      const isMatch = await globalThis.Bun.password.verify(password, user.password);
      if (isMatch) return user;
    } catch (e) {
      // If verify throws, it might be plain text
    }

    // Fallback check for plain text (for existing users)
    if (user.password === password) {
      console.log(`[AUTH] Auto-hashing password for user: ${username}`);
      await updateUser(user.id, { password }); // This will trigger hashing in updateUser
      return user;
    }
    return null;
  }

  return user.password === password ? user : null;
}

async function deleteUser(id) {
  let users = await readJson(USERS_CONFIG_PATH);
  const originalLength = users.length;
  users = users.filter(u => u.id != id);
  if (users.length < originalLength) {
    await writeJson(USERS_CONFIG_PATH, users);
    return true;
  }
  return false;
}

// --- CATEGORIES ---
async function getAllCategories() {
  return ['Communication', 'Navigation', 'Surveillance', 'Data Processing', 'Support'];
}

// --- EQUIPMENT LOGS ---
async function createEquipmentLog(data) {
  const log = { ...data, id: Date.now(), logged_at: data.logged_at || new Date().toISOString() };

  if (data.source === 'TX 1 APP' || data.equipment_name === 'VHF Primary APP') {
    console.log('[DB-DEBUG] createEquipmentLog called for TX 1 APP! Data:', JSON.stringify(log));
  }

  // [STATELESS FORWARDER MODE]
  // We NO LONGER store logs in `equipmentLogsDB` array.
  // We NO LONGER persist history to `equipment_logs.json`.
  // We ONLY keep 1 latest snapshot in memory for the live dashboard.
  upsertLatestEquipmentData(log);

  return log;
}

async function getEquipmentLogs(filters = {}) {
  await syncEquipmentLogsFromDisk();
  let filtered = [...equipmentLogsDB];
  if (filters.equipmentId) filtered = filtered.filter(l => l.equipmentId == filters.equipmentId);
  if (filters.source) filtered = filtered.filter(l => (l.source || 'default') === filters.source);
  if (filters.from) filtered = filtered.filter(l => new Date(l.logged_at) >= new Date(filters.from));
  if (filters.to) filtered = filtered.filter(l => new Date(l.logged_at) <= new Date(filters.to));

  filtered.sort((a, b) => new Date(b.logged_at) - new Date(a.logged_at));

  const page = filters.page || 1;
  const limit = filters.limit || 100;
  const offset = (page - 1) * limit;

  return {
    data: filtered.slice(offset, offset + limit),
    pagination: { page, limit }
  };
}

async function getLatestEquipmentLog(equipmentId) {
  await syncEquipmentLogsFromDisk();
  const filtered = equipmentLogsDB.filter(l => l.equipmentId == equipmentId);
  return filtered[filtered.length - 1] || null;
}

// --- THRESHOLD SETTINGS ---
async function getThresholdsByEquipment(equipmentId) {
  return thresholdSettingsDB.filter(t => t.equipmentId == equipmentId || t.equipment_id == equipmentId);
}

async function createThreshold(data) {
  const normalizedEquipmentId = data.equipmentId || data.equipment_id || null;
  const t = {
    ...data,
    id: Date.now(),
    equipmentId: normalizedEquipmentId,
    equipment_id: normalizedEquipmentId
  };
  thresholdSettingsDB.push(t);
  return t;
}

async function updateThreshold(id, data) {
  const index = thresholdSettingsDB.findIndex(t => t.id == id);
  if (index !== -1) {
    thresholdSettingsDB[index] = { ...thresholdSettingsDB[index], ...data };
    return thresholdSettingsDB[index];
  }
  return null;
}

async function deleteThreshold(id) {
  thresholdSettingsDB = thresholdSettingsDB.filter(t => t.id != id);
}

async function syncOtenticationSupCategory() {
  try {
    const equipments = await readJson(EQUIPMENT_CONFIG_PATH);
    const otentications = await readJson(AUTH_CONFIG_PATH);

    const equipMap = new Map();
    equipments.forEach(e => {
      if (e.sup_category) {
        equipMap.set(String(e.id), e.sup_category);
      }
    });

    let changed = false;
    const updated = otentications.map(o => {
      const parentSup = equipMap.get(String(o.equipt_id));
      // Only sync if source doesn't have one OR if it's different from parent
      if (parentSup && o.sup_category !== parentSup) {
        changed = true;
        return { ...o, sup_category: parentSup };
      }
      return o;
    });

    if (changed) {
      await writeJson(AUTH_CONFIG_PATH, updated);
      console.log(`[DB-SYNC] Automatically synced sup_category to ${updated.length} data sources`);
    }
    return true;
  } catch (err) {
    console.error('[DB-SYNC] Error during sync:', err);
    return false;
  }
}

async function syncAllOtenticationLocations() {
  console.log('[DB] Starting location synchronization for Data Sources...');
  const equipmentList = await readJson(EQUIPMENT_CONFIG_PATH);
  let authList = await readJson(AUTH_CONFIG_PATH);
  let updateCount = 0;

  authList = authList.map(auth => {
    const parentEquip = equipmentList.find(e => String(e.id) === String(auth.equipt_id));
    if (parentEquip) {
      // Only update if current auth lat/lng is missing
      if (auth.latitude === undefined || auth.latitude === null || auth.longitude === undefined || auth.longitude === null) {
        auth.latitude = parentEquip.lat || parentEquip.latitude || null;
        auth.longitude = parentEquip.lng || parentEquip.longitude || null;
        updateCount++;
      }
    }
    return auth;
  });

  if (updateCount > 0) {
    await writeJson(AUTH_CONFIG_PATH, authList);
    console.log(`[DB] Successfully synced ${updateCount} Data Source locations.`);
  } else {
    console.log('[DB] No Data Source locations needed synchronization.');
  }
}

// Initial sync call
setTimeout(syncAllOtenticationLocations, 1000);

module.exports = {
  // Config helpers
  readAirportConfig,
  readBranchProfile,
  writeAirportConfig,
  readJson,
  writeJson,
  setConfigUpdateHook,

  // Analytics/History scan
  getLatestTimestampFromHistory,
  query,

  // Airports
  getAllAirports,
  getAirportsPaginated,
  getAirportById,
  createAirport,
  updateAirport,
  deleteAirport,

  // Equipment
  getAllEquipment,
  getEquipmentById,
  getEquipmentStatsSummary,
  createEquipment,
  updateEquipment,
  updateEquipmentStatus,
  deleteEquipment,

  // Parsing Config
  getAllParsingConfigs,
  getParsingConfigById,
  createParsingConfig,
  updateParsingConfig,
  deleteParsingConfig,

  // SNMP Templates
  getAllSnmpTemplates,
  getSnmpTemplateById,
  createSnmpTemplate,
  updateSnmpTemplate,
  deleteSnmpTemplate,

  // Sup Category
  getAllSupCategories,
  getSupCategoriesByCategory,
  createSupCategory,
  updateSupCategory,
  deleteSupCategory,

  // Otentication
  getAllOtentication,
  getOtenticationByEquipment,
  createOtentication,
  updateOtentication,
  syncEquipmentDataSourceRelation,
  deleteOtentication,
  deleteOtenticationByEquipment,
  syncAllOtenticationLocations,

  // Limitations
  getAllLimitations,
  getLimitationsByEquipment,
  createLimitation,
  updateLimitation,
  deleteLimitation,

  // Threshold Settings
  getThresholdsByEquipment,
  createThreshold,
  updateThreshold,
  deleteThreshold,
  syncOtenticationSupCategory,

  // Users
  getAllUsers,
  getUserById,
  getUserByUsername,
  createUser,
  updateUser,
  deleteUser,
  verifyUser,

  // Categories
  getAllCategories,

  // Logs
  createEquipmentLog,
  getLatestLogsBySource,
  getEquipmentLogs,
  getLatestEquipmentLog,

  // Surveillance
  surveillanceStationsDB,
  radarTargetsDB,
  adsbAircraftDB,
  surveillanceLogsDB
};
